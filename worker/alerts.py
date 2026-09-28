from __future__ import annotations

import json
import os
import queue
import smtplib
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from threading import Event, RLock, Thread
from time import sleep, time
from typing import Any
from uuid import uuid4


DEFAULT_CONFIG: dict[str, Any] = {
    "digestIntervalMinutes": 60,
    "authorities": [],
    "policies": [],
    "counters": [],
    "emailService": {
        "host": "",
        "port": 587,
        "username": "",
        "password": "",
        "fromEmail": "",
        "useTls": True,
    },
}


@dataclass(frozen=True)
class SmtpSettings:
    host: str
    port: int
    username: str
    password: str
    from_email: str
    use_tls: bool

    @classmethod
    def from_configuration(cls, config: dict[str, Any]) -> "SmtpSettings | None":
        saved = dict(config.get("emailService") or {})
        host = os.environ.get("OPTIVISION_SMTP_HOST", str(saved.get("host") or "")).strip()
        from_email = os.environ.get("OPTIVISION_SMTP_FROM", str(saved.get("fromEmail") or "")).strip()
        if not host or not from_email:
            return None
        return cls(
            host=host,
            port=int(os.environ.get("OPTIVISION_SMTP_PORT", str(saved.get("port") or 587))),
            username=os.environ.get("OPTIVISION_SMTP_USERNAME", str(saved.get("username") or "")).strip(),
            password=os.environ.get("OPTIVISION_SMTP_PASSWORD", str(saved.get("password") or "")),
            from_email=from_email,
            use_tls=os.environ.get("OPTIVISION_SMTP_TLS", str(saved.get("useTls", True))).lower() not in {"0", "false", "no"},
        )


class AlertService:
    """Persistent alert policies, digest delivery, and signal time counters."""

    def __init__(self, state_path: str | Path, *, start_background: bool = True) -> None:
        self.state_path = Path(state_path)
        self._lock = RLock()
        self._stop_event = Event()
        self._mail_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._state = self._read_state()
        self._condition_started: dict[str, float] = {}
        self._last_persisted_at = 0.0
        self._threads: list[Thread] = []
        if start_background:
            self._threads = [
                Thread(target=self._mail_worker, daemon=True, name="optivision-alert-mail"),
                Thread(target=self._digest_worker, daemon=True, name="optivision-alert-digest"),
            ]
            for thread in self._threads:
                thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            counters = [self._counter_snapshot(item) for item in self._state["counterStates"].values()]
            counters.sort(key=lambda item: (item["name"], item["cameraName"]))
            public_config = deepcopy(self._state["config"])
            password_configured = bool(public_config["emailService"].get("password"))
            public_config["emailService"]["password"] = ""
            smtp_settings = SmtpSettings.from_configuration(self._state["config"])
            return {
                "ok": True,
                "config": public_config,
                "alerts": deepcopy(list(reversed(self._state["alerts"][-1000:]))),
                "counters": counters,
                "email": {
                    "configured": smtp_settings is not None,
                    "passwordConfigured": password_configured or bool(os.environ.get("OPTIVISION_SMTP_PASSWORD")),
                    "fromEmail": smtp_settings.from_email if smtp_settings else "",
                    "lastDigestAt": self._state.get("lastDigestAt"),
                },
            }

    def update_config(self, config: dict[str, Any]) -> dict[str, Any]:
        current_email = dict(self._state.get("config", {}).get("emailService") or {})
        requested_email = dict(config.get("emailService") or {})
        requested_password = str(requested_email.get("password") or "")
        normalized = {
            "digestIntervalMinutes": max(1, int(config.get("digestIntervalMinutes", 60))),
            "authorities": self._normalize_authorities(config.get("authorities") or []),
            "policies": self._normalize_policies(config.get("policies") or []),
            "counters": self._normalize_counters(config.get("counters") or []),
            "emailService": {
                "host": str(requested_email.get("host") or "").strip(),
                "port": max(1, int(requested_email.get("port") or 587)),
                "username": str(requested_email.get("username") or "").strip(),
                "password": requested_password or str(current_email.get("password") or ""),
                "fromEmail": str(requested_email.get("fromEmail") or "").strip(),
                "useTls": bool(requested_email.get("useTls", True)),
            },
        }
        with self._lock:
            self._state["config"] = normalized
            configured_counter_ids = {item["id"] for item in normalized["counters"]}
            self._state["counterStates"] = {
                key: value
                for key, value in self._state["counterStates"].items()
                if value.get("counterId") in configured_counter_ids
            }
            self._persist_locked()
        return self.snapshot()

    def clear_alerts(self) -> dict[str, Any]:
        with self._lock:
            self._state["alerts"] = []
            self._state["openAlerts"] = {}
            self._persist_locked()
        return self.snapshot()

    def queue_test_email(self, authority_id: str) -> dict[str, Any]:
        with self._lock:
            authority = next(
                (item for item in self._state["config"]["authorities"] if item["id"] == authority_id),
                None,
            )
            configured = SmtpSettings.from_configuration(self._state["config"]) is not None
        if not authority:
            raise ValueError("Select a valid authority before sending a test email")
        if not configured:
            raise ValueError("Configure the SMTP email service and save it before sending a test email")
        job_id = f"test-{uuid4().hex}"
        job = {
            "jobId": job_id,
            "kind": "test",
            "recipients": [authority["email"]],
            "subject": "Optiwise Vision alert email test",
            "body": (
                f"Hello {authority['name']},\n\n"
                "This confirms that Optiwise Vision can send alert notifications to this address.\n"
            ),
        }
        status, error = self._send_email(job)
        if status != "sent":
            raise RuntimeError(error or f"Test email status: {status}")
        return {"ok": True, "sent": True, "jobId": job_id}

    def process_frame(
        self,
        *,
        camera_id: str,
        camera_name: str,
        timestamp: float,
        rule_states: list[dict[str, Any]],
        signal_states: list[dict[str, Any]],
    ) -> None:
        immediate_jobs: list[dict[str, Any]] = []
        with self._lock:
            rules_by_id = {str(item.get("ruleId")): item for item in rule_states}
            signals_by_id = {str(item.get("signalId")): item for item in signal_states}

            for policy in self._state["config"]["policies"]:
                if not policy.get("enabled", True):
                    continue
                rule = rules_by_id.get(policy["ruleId"])
                if not rule:
                    continue
                state_key = f"{camera_id}:{policy['id']}"
                matched = bool(rule.get("matched", False))
                if matched:
                    self._condition_started.setdefault(state_key, timestamp)
                    started_at = self._condition_started[state_key]
                    wait_seconds = 0 if policy["severity"] == "critical" else policy["minDurationSeconds"]
                    open_alert_id = self._state["openAlerts"].get(state_key)
                    if timestamp - started_at >= wait_seconds and not open_alert_id:
                        alert = self._create_alert(
                            policy=policy,
                            rule=rule,
                            camera_id=camera_id,
                            camera_name=camera_name,
                            started_at=started_at,
                            triggered_at=timestamp,
                        )
                        self._state["alerts"].append(alert)
                        self._state["alerts"] = self._state["alerts"][-1000:]
                        self._state["openAlerts"][state_key] = alert["id"]
                        if policy["severity"] == "critical":
                            job = self._email_job_for_alert(alert, "critical")
                            if job:
                                alert["deliveryStatus"] = "queued"
                                immediate_jobs.append(job)
                else:
                    self._condition_started.pop(state_key, None)
                    open_alert_id = self._state["openAlerts"].pop(state_key, None)
                    if open_alert_id:
                        alert = self._find_alert(open_alert_id)
                        if alert:
                            alert["status"] = "resolved"
                            alert["resolvedAt"] = timestamp
                            alert["durationSeconds"] = round(max(0.0, timestamp - alert["startedAt"]), 2)

            self._update_counters(camera_id, camera_name, timestamp, signals_by_id)
            if timestamp - self._last_persisted_at >= 2:
                self._persist_locked()
                self._last_persisted_at = timestamp

        for job in immediate_jobs:
            self._mail_queue.put(job)

    def _create_alert(
        self,
        *,
        policy: dict[str, Any],
        rule: dict[str, Any],
        camera_id: str,
        camera_name: str,
        started_at: float,
        triggered_at: float,
    ) -> dict[str, Any]:
        authorities = self._authorities_for_ids(policy["authorityIds"])
        return {
            "id": f"alert-{uuid4().hex}",
            "policyId": policy["id"],
            "policyName": policy["name"],
            "ruleId": policy["ruleId"],
            "ruleName": str(rule.get("name") or policy["ruleId"]),
            "output": str(rule.get("output") or policy["name"]),
            "cameraId": camera_id,
            "cameraName": camera_name,
            "severity": policy["severity"],
            "status": "active",
            "startedAt": started_at,
            "triggeredAt": triggered_at,
            "resolvedAt": None,
            "durationSeconds": round(max(0.0, triggered_at - started_at), 2),
            "authorityIds": policy["authorityIds"],
            "recipientEmails": [item["email"] for item in authorities],
            "deliveryStatus": "pending_digest" if policy["severity"] != "critical" else "pending",
            "deliveredAt": None,
            "deliveryError": "",
        }

    def _update_counters(
        self,
        camera_id: str,
        camera_name: str,
        timestamp: float,
        signals_by_id: dict[str, dict[str, Any]],
    ) -> None:
        for counter in self._state["config"]["counters"]:
            configured_camera_id = counter.get("cameraId", "all")
            if configured_camera_id not in {"all", camera_id}:
                continue
            signal = signals_by_id.get(counter["signalId"])
            if signal is None:
                continue
            key = f"{counter['id']}:{camera_id}"
            active = bool(signal.get("active", False))
            counter_state = self._state["counterStates"].get(key)
            if counter_state is None:
                counter_state = {
                    "counterId": counter["id"],
                    "name": counter["name"],
                    "signalId": counter["signalId"],
                    "cameraId": camera_id,
                    "cameraName": camera_name,
                    "shiftHours": counter["shiftHours"],
                    "activeSeconds": 0.0,
                    "absentSeconds": 0.0,
                    "lastTimestamp": timestamp,
                    "currentState": "active" if active else "absent",
                    "currentSessionStartedAt": timestamp,
                    "sessions": [],
                }
                self._state["counterStates"][key] = counter_state
                continue

            delta = max(0.0, min(10.0, timestamp - float(counter_state.get("lastTimestamp", timestamp))))
            previous_state = counter_state.get("currentState", "absent")
            if previous_state == "active":
                counter_state["activeSeconds"] += delta
            else:
                counter_state["absentSeconds"] += delta
            next_state = "active" if active else "absent"
            if next_state != previous_state:
                counter_state["sessions"].append({
                    "state": previous_state,
                    "startedAt": counter_state["currentSessionStartedAt"],
                    "endedAt": timestamp,
                    "durationSeconds": round(max(0.0, timestamp - counter_state["currentSessionStartedAt"]), 2),
                })
                counter_state["sessions"] = counter_state["sessions"][-100:]
                counter_state["currentState"] = next_state
                counter_state["currentSessionStartedAt"] = timestamp
            counter_state["lastTimestamp"] = timestamp
            counter_state["cameraName"] = camera_name
            counter_state["name"] = counter["name"]
            counter_state["shiftHours"] = counter["shiftHours"]

    def _counter_snapshot(self, state: dict[str, Any]) -> dict[str, Any]:
        result = deepcopy(state)
        now_timestamp = float(state.get("lastTimestamp", time()))
        current_duration = max(0.0, now_timestamp - float(state.get("currentSessionStartedAt", now_timestamp)))
        result["currentSessionSeconds"] = round(current_duration, 2)
        result["activeSeconds"] = round(float(result.get("activeSeconds", 0.0)), 2)
        result["absentSeconds"] = round(float(result.get("absentSeconds", 0.0)), 2)
        result["observedSeconds"] = round(result["activeSeconds"] + result["absentSeconds"], 2)
        result["shiftSeconds"] = round(float(result.get("shiftHours", 12)) * 3600, 2)
        return result

    def _digest_worker(self) -> None:
        while not self._stop_event.is_set():
            sleep(5)
            jobs: list[dict[str, Any]] = []
            with self._lock:
                interval_seconds = max(60, int(self._state["config"]["digestIntervalMinutes"]) * 60)
                last_digest_at = float(self._state.get("lastDigestAt") or time())
                if not self._state.get("lastDigestAt"):
                    self._state["lastDigestAt"] = last_digest_at
                    self._persist_locked()
                    continue
                if time() - last_digest_at < interval_seconds:
                    continue
                new_alerts = [
                    item for item in self._state["alerts"]
                    if float(item.get("triggeredAt", 0)) > last_digest_at
                ]
                for authority in self._state["config"]["authorities"]:
                    authority_alerts = [
                        item for item in new_alerts if authority["id"] in item.get("authorityIds", [])
                    ]
                    if authority_alerts:
                        jobs.append(self._email_job_for_digest(authority, authority_alerts))
                self._state["lastDigestAt"] = time()
                self._persist_locked()
            for job in jobs:
                self._mail_queue.put(job)

    def _mail_worker(self) -> None:
        while not self._stop_event.is_set():
            try:
                job = self._mail_queue.get(timeout=1)
            except queue.Empty:
                continue
            status, error = self._send_email(job)
            alert_ids = [str(item) for item in job.get("alertIds", [])]
            if job.get("alertId"):
                alert_ids.append(str(job["alertId"]))
            if alert_ids:
                with self._lock:
                    for alert_id in alert_ids:
                        alert = self._find_alert(alert_id)
                        if alert:
                            alert["deliveryStatus"] = "sent_digest" if status == "sent" and job.get("kind") == "digest" else status
                            alert["deliveryError"] = error
                            alert["deliveredAt"] = time() if status == "sent" else None
                    self._persist_locked()
            self._mail_queue.task_done()

    def _send_email(self, job: dict[str, Any]) -> tuple[str, str]:
        with self._lock:
            settings = SmtpSettings.from_configuration(self._state["config"])
        if settings is None:
            return "not_configured", "SMTP sender is not configured"
        recipients = [str(item).strip() for item in job.get("recipients", []) if str(item).strip()]
        if not recipients:
            return "no_recipients", "No authority email was selected"
        message = EmailMessage()
        message["From"] = settings.from_email
        message["To"] = ", ".join(recipients)
        message["Subject"] = str(job.get("subject") or "Optiwise Vision alert")
        message.set_content(str(job.get("body") or ""))
        try:
            with smtplib.SMTP(settings.host, settings.port, timeout=20) as smtp:
                if settings.use_tls:
                    smtp.starttls()
                if settings.username:
                    smtp.login(settings.username, settings.password)
                smtp.send_message(message)
            return "sent", ""
        except Exception as error:  # pragma: no cover - depends on external SMTP service
            return "failed", str(error)

    def _email_job_for_alert(self, alert: dict[str, Any], kind: str) -> dict[str, Any] | None:
        if not alert["recipientEmails"]:
            alert["deliveryStatus"] = "no_recipients"
            alert["deliveryError"] = "No authority email was selected"
            return None
        return {
            "jobId": f"mail-{uuid4().hex}",
            "kind": kind,
            "alertId": alert["id"],
            "recipients": alert["recipientEmails"],
            "subject": f"CRITICAL · {alert['policyName']} · {alert['cameraName']}",
            "body": self._format_alert(alert),
        }

    def _email_job_for_digest(self, authority: dict[str, Any], alerts: list[dict[str, Any]]) -> dict[str, Any]:
        lines = [
            f"Hello {authority['name']},",
            "",
            f"Optiwise Vision recorded {len(alerts)} alert(s) during this reporting interval.",
            "",
        ]
        for alert in alerts:
            lines.append(
                f"- [{alert['severity'].upper()}] {alert['policyName']} · {alert['cameraName']} · "
                f"{iso_time(alert['triggeredAt'])} · {alert['status']}"
            )
        lines.extend(["", "Open the Alerts Dashboard for the complete log and time counters."])
        return {
            "jobId": f"mail-{uuid4().hex}",
            "kind": "digest",
            "alertIds": [item["id"] for item in alerts if item["severity"] != "critical"],
            "recipients": [authority["email"]],
            "subject": f"Optiwise Vision alert digest · {len(alerts)} alert(s)",
            "body": "\n".join(lines),
        }

    @staticmethod
    def _format_alert(alert: dict[str, Any]) -> str:
        return "\n".join([
            "Optiwise Vision critical alert",
            "",
            f"Alert: {alert['policyName']}",
            f"Rule: {alert['ruleName']}",
            f"Camera: {alert['cameraName']}",
            f"Started: {iso_time(alert['startedAt'])}",
            f"Detected: {iso_time(alert['triggeredAt'])}",
            f"Output: {alert['output']}",
            "",
            "This policy is classified as critical and was delivered immediately.",
        ])

    def _find_alert(self, alert_id: str) -> dict[str, Any] | None:
        return next((item for item in self._state["alerts"] if item["id"] == alert_id), None)

    def _authorities_for_ids(self, authority_ids: list[str]) -> list[dict[str, Any]]:
        selected = set(authority_ids)
        return [item for item in self._state["config"]["authorities"] if item["id"] in selected]

    def _read_state(self) -> dict[str, Any]:
        state = {
            "config": deepcopy(DEFAULT_CONFIG),
            "alerts": [],
            "openAlerts": {},
            "counterStates": {},
            "lastDigestAt": None,
        }
        if not self.state_path.exists():
            return state
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
            state.update({key: saved[key] for key in state if key in saved})
            state["config"] = {
                **deepcopy(DEFAULT_CONFIG),
                **dict(saved.get("config") or {}),
            }
        except (OSError, ValueError, TypeError):
            pass
        return state

    def _persist_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self._state, indent=2)
        temporary_path = self.state_path.with_name(f".{self.state_path.name}.{uuid4().hex}.tmp")
        temporary_path.write_text(payload, encoding="utf-8")
        try:
            for attempt in range(5):
                try:
                    temporary_path.replace(self.state_path)
                    return
                except PermissionError:
                    if attempt == 4:
                        break
                    sleep(0.05 * (attempt + 1))
            # OneDrive can briefly lock atomic rename targets on Windows.
            self.state_path.write_text(payload, encoding="utf-8")
        finally:
            temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _normalize_authorities(items: list[Any]) -> list[dict[str, str]]:
        result = []
        for raw in items:
            email = str(raw.get("email") or "").strip().lower()
            name = str(raw.get("name") or "").strip()
            if not email or "@" not in email:
                continue
            result.append({
                "id": str(raw.get("id") or f"authority-{uuid4().hex}"),
                "name": name or email.split("@", 1)[0],
                "email": email,
            })
        return result

    @staticmethod
    def _normalize_policies(items: list[Any]) -> list[dict[str, Any]]:
        result = []
        for raw in items:
            rule_id = str(raw.get("ruleId") or "").strip()
            if not rule_id:
                continue
            severity = str(raw.get("severity") or "warning").lower()
            if severity not in {"info", "warning", "critical"}:
                severity = "warning"
            result.append({
                "id": str(raw.get("id") or f"policy-{uuid4().hex}"),
                "name": str(raw.get("name") or rule_id).strip(),
                "ruleId": rule_id,
                "severity": severity,
                "minDurationSeconds": max(0, int(raw.get("minDurationSeconds", 0))),
                "authorityIds": [str(item) for item in raw.get("authorityIds", [])],
                "enabled": bool(raw.get("enabled", True)),
            })
        return result

    @staticmethod
    def _normalize_counters(items: list[Any]) -> list[dict[str, Any]]:
        result = []
        for raw in items:
            signal_id = str(raw.get("signalId") or "").strip()
            if not signal_id:
                continue
            result.append({
                "id": str(raw.get("id") or f"counter-{uuid4().hex}"),
                "name": str(raw.get("name") or signal_id).strip(),
                "signalId": signal_id,
                "cameraId": str(raw.get("cameraId") or "all"),
                "shiftHours": max(0.25, float(raw.get("shiftHours", 12))),
            })
        return result


def iso_time(timestamp: float) -> str:
    return datetime.fromtimestamp(float(timestamp), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
