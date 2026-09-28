from __future__ import annotations

import copy
import json
from pathlib import Path
from threading import RLock
from typing import Any


FACTORY_FIELDS = ("name", "site", "department", "productionLine")
DEFAULT_FACTORY = {field: "" for field in FACTORY_FIELDS}
DEFAULT_DEPLOYMENT = {
    "version": "worker-productivity-v1",
    "status": "draft",
    "useCaseId": "worker-productivity",
    "updatedAt": "",
}


class WorkspaceService:
    """Small local persistence boundary for factory and deployment state.

    This keeps the prototype local-first while giving the frontend one durable
    source of truth that can later be replaced by a database-backed repository.
    """

    def __init__(self, state_path: Path) -> None:
        self.state_path = state_path
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._state = self._load()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {"ok": True, **copy.deepcopy(self._state)}

    def update(self, factory: dict[str, Any], deployment: dict[str, Any]) -> dict[str, Any]:
        next_state = {
            "factory": {
                field: clean_text(factory.get(field), 200)
                for field in FACTORY_FIELDS
            },
            "deployment": normalize_deployment(deployment),
        }
        with self._lock:
            self._state = next_state
            self._write()
        return self.snapshot()

    def _load(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"factory": dict(DEFAULT_FACTORY), "deployment": dict(DEFAULT_DEPLOYMENT)}
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            return {
                "factory": {
                    field: clean_text((raw.get("factory") or {}).get(field), 200)
                    for field in FACTORY_FIELDS
                },
                "deployment": normalize_deployment(dict(raw.get("deployment") or {})),
            }
        except (OSError, TypeError, ValueError):
            return {"factory": dict(DEFAULT_FACTORY), "deployment": dict(DEFAULT_DEPLOYMENT)}

    def _write(self) -> None:
        temporary_path = self.state_path.with_suffix(f"{self.state_path.suffix}.tmp")
        temporary_path.write_text(json.dumps(self._state, indent=2), encoding="utf-8")
        temporary_path.replace(self.state_path)


def normalize_deployment(raw: dict[str, Any]) -> dict[str, Any]:
    status = str(raw.get("status") or "draft")
    if status not in {"draft", "published"}:
        status = "draft"
    normalized = {
        "version": clean_text(raw.get("version") or DEFAULT_DEPLOYMENT["version"], 120),
        "status": status,
        "useCaseId": clean_text(raw.get("useCaseId") or DEFAULT_DEPLOYMENT["useCaseId"], 120),
        "updatedAt": clean_text(raw.get("updatedAt") or "", 80),
    }
    published_at = clean_text(raw.get("publishedAt") or "", 80)
    if published_at:
        normalized["publishedAt"] = published_at
    snapshot = raw.get("snapshot")
    if isinstance(snapshot, dict):
        normalized["snapshot"] = copy.deepcopy(snapshot)
    return normalized


def clean_text(value: Any, maximum: int) -> str:
    return str(value or "").strip()[:maximum]
