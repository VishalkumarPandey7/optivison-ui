import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from alerts import AlertService


def rule_state(rule_id: str, *, matched: bool) -> dict:
    return {"ruleId": rule_id, "name": "Operator Absent", "output": "OPERATOR_ABSENT", "matched": matched, "active": matched}


def signal_state(signal_id: str, *, active: bool) -> dict:
    return {"signalId": signal_id, "active": active}


def configured_service(state_path: Path) -> AlertService:
    service = AlertService(state_path, start_background=False)
    service.update_config({
        "digestIntervalMinutes": 60,
        "authorities": [{"id": "supervisor", "name": "Supervisor", "email": "ops@example.com"}],
        "policies": [
            {"id": "absence-policy", "name": "Long operator absence", "ruleId": "operator-absent", "severity": "warning", "minDurationSeconds": 600, "authorityIds": ["supervisor"], "enabled": True},
            {"id": "critical-policy", "name": "Critical restricted-zone event", "ruleId": "restricted-mobile-use", "severity": "critical", "minDurationSeconds": 3600, "authorityIds": ["supervisor"], "enabled": True},
        ],
        "counters": [{"id": "operator-time", "name": "Operator station time", "signalId": "person-in-operator-zone", "cameraId": "all", "shiftHours": 12}],
    })
    return service


class AlertServiceTests(unittest.TestCase):
    def test_warning_alert_waits_for_user_configured_duration(self) -> None:
        with TemporaryDirectory() as directory:
            service = configured_service(Path(directory) / "alerts.json")
            service.process_frame(camera_id="camera-1", camera_name="Line 1", timestamp=1000, rule_states=[rule_state("operator-absent", matched=True)], signal_states=[])
            service.process_frame(camera_id="camera-1", camera_name="Line 1", timestamp=1599, rule_states=[rule_state("operator-absent", matched=True)], signal_states=[])
            self.assertEqual(service.snapshot()["alerts"], [])

            service.process_frame(camera_id="camera-1", camera_name="Line 1", timestamp=1600, rule_states=[rule_state("operator-absent", matched=True)], signal_states=[])
            alert = service.snapshot()["alerts"][0]
            self.assertEqual(alert["severity"], "warning")
            self.assertEqual(alert["durationSeconds"], 600)
            self.assertEqual(alert["deliveryStatus"], "pending_digest")

            service.process_frame(camera_id="camera-1", camera_name="Line 1", timestamp=1700, rule_states=[rule_state("operator-absent", matched=False)], signal_states=[])
            resolved = service.snapshot()["alerts"][0]
            self.assertEqual(resolved["status"], "resolved")
            self.assertEqual(resolved["durationSeconds"], 700)

    def test_critical_alert_bypasses_policy_wait_and_queues_immediately(self) -> None:
        with TemporaryDirectory() as directory:
            service = configured_service(Path(directory) / "alerts.json")
            service.process_frame(camera_id="camera-2", camera_name="Restricted Area", timestamp=2000, rule_states=[rule_state("restricted-mobile-use", matched=True)], signal_states=[])
            alert = service.snapshot()["alerts"][0]
            self.assertEqual(alert["severity"], "critical")
            self.assertEqual(alert["triggeredAt"], 2000)
            self.assertEqual(alert["deliveryStatus"], "queued")
            self.assertEqual(alert["recipientEmails"], ["ops@example.com"])

    def test_signal_counter_sums_active_and_absent_time_with_sessions(self) -> None:
        with TemporaryDirectory() as directory:
            service = configured_service(Path(directory) / "alerts.json")
            for timestamp, active in [(100, True), (110, True), (120, False), (130, False), (140, True), (150, True)]:
                service.process_frame(camera_id="camera-1", camera_name="Line 1", timestamp=timestamp, rule_states=[], signal_states=[signal_state("person-in-operator-zone", active=active)])

            counter = service.snapshot()["counters"][0]
            self.assertEqual(counter["activeSeconds"], 30)
            self.assertEqual(counter["absentSeconds"], 20)
            self.assertEqual(counter["shiftSeconds"], 12 * 3600)
            self.assertEqual([session["state"] for session in counter["sessions"]], ["active", "absent"])

    def test_alert_configuration_and_log_survive_service_restart(self) -> None:
        with TemporaryDirectory() as directory:
            state_path = Path(directory) / "alerts.json"
            service = configured_service(state_path)
            service.process_frame(camera_id="camera-1", camera_name="Line 1", timestamp=1000, rule_states=[rule_state("restricted-mobile-use", matched=True)], signal_states=[])

            restored = AlertService(state_path, start_background=False).snapshot()
            self.assertEqual(restored["config"]["digestIntervalMinutes"], 60)
            self.assertEqual(restored["config"]["authorities"][0]["email"], "ops@example.com")
            self.assertEqual(restored["alerts"][0]["policyName"], "Critical restricted-zone event")

    def test_email_password_is_not_returned_and_survives_blank_ui_saves(self) -> None:
        with TemporaryDirectory() as directory:
            service = configured_service(Path(directory) / "alerts.json")
            initial = service.snapshot()["config"]
            initial["emailService"] = {
                "host": "smtp.example.com",
                "port": 587,
                "username": "alerts@example.com",
                "password": "app-password",
                "fromEmail": "alerts@example.com",
                "useTls": True,
            }
            saved = service.update_config(initial)
            self.assertEqual(saved["config"]["emailService"]["password"], "")
            self.assertTrue(saved["email"]["passwordConfigured"])

            saved["config"]["digestIntervalMinutes"] = 30
            resaved = service.update_config(saved["config"])
            self.assertTrue(resaved["email"]["passwordConfigured"])
            self.assertEqual(resaved["config"]["digestIntervalMinutes"], 30)


if __name__ == "__main__":
    unittest.main()
