import tempfile
import unittest
from pathlib import Path

from workspace import WorkspaceService


class WorkspaceServiceTest(unittest.TestCase):
    def test_workspace_state_survives_restart_and_keeps_deployment_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "workspace-state.json"
            service = WorkspaceService(state_path)
            saved = service.update(
                factory={
                    "name": "Pune Assembly",
                    "site": "Building 2",
                    "department": "Production",
                    "productionLine": "Line A",
                    "ignored": "not persisted",
                },
                deployment={
                    "version": "worker-productivity-v2",
                    "status": "published",
                    "useCaseId": "worker-productivity",
                    "updatedAt": "2026-09-12T10:00:00Z",
                    "snapshot": {"selectedModelIds": ["yolo11n"], "rules": []},
                },
            )

            restarted = WorkspaceService(state_path)

            self.assertEqual(saved["factory"]["name"], "Pune Assembly")
            self.assertNotIn("ignored", saved["factory"])
            self.assertEqual(restarted.snapshot()["deployment"]["version"], "worker-productivity-v2")
            self.assertEqual(restarted.snapshot()["deployment"]["snapshot"]["selectedModelIds"], ["yolo11n"])

    def test_invalid_deployment_status_falls_back_to_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            service = WorkspaceService(Path(directory) / "workspace-state.json")
            snapshot = service.update(
                factory={},
                deployment={"status": "released", "version": "  draft-v1  "},
            )

            self.assertEqual(snapshot["deployment"]["status"], "draft")
            self.assertEqual(snapshot["deployment"]["version"], "draft-v1")


if __name__ == "__main__":
    unittest.main()
