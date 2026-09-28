import base64
import json
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from training import TrainingService


def sample_image_data() -> str:
    buffer = BytesIO()
    Image.new("RGB", (100, 80), color=(240, 120, 30)).save(buffer, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class TrainingServiceTests(unittest.TestCase):
    def test_project_images_annotations_and_yolo_dataset_are_persisted(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            service = TrainingService(root / "training", root / "models")
            project = service.create_project("Packing Quality", ["good_pack", "damaged_pack"])["project"]
            images = [{"fileName": f"pack-{index}.jpg", "data": sample_image_data()} for index in range(4)]
            dashboard = service.upload_images(project["id"], images)
            uploaded = dashboard["projects"][0]["images"]

            for index, image in enumerate(uploaded):
                class_name = "good_pack" if index % 2 == 0 else "damaged_pack"
                service.save_annotations(project["id"], image["id"], [{
                    "id": f"box-{index}",
                    "className": class_name,
                    "x": 25,
                    "y": 25,
                    "width": 50,
                    "height": 50,
                }], reviewed=True)

            prepared = service.prepare_dataset(project["id"], "test-version")
            label_files = list((prepared["datasetDir"] / "labels").glob("**/*.txt"))
            labels = [path.read_text(encoding="utf-8") for path in label_files]

            self.assertEqual(prepared["trainingImages"], 3)
            self.assertEqual(prepared["validationImages"], 1)
            self.assertEqual(len(label_files), 4)
            self.assertTrue(all("0.500000 0.500000 0.500000 0.500000" in label for label in labels))
            yaml = prepared["yamlPath"].read_text(encoding="utf-8")
            self.assertIn('0: "good_pack"', yaml)
            self.assertIn('1: "damaged_pack"', yaml)

            restored = TrainingService(root / "training", root / "models").snapshot()["projects"][0]
            self.assertEqual(restored["name"], "Packing Quality")
            self.assertEqual(sum(len(image["annotations"]) for image in restored["images"]), 4)

    def test_training_requires_reviewed_images_and_every_declared_class(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            service = TrainingService(root / "training", root / "models")
            project = service.create_project("Uniform", ["blue_uniform", "red_uniform"])["project"]
            dashboard = service.upload_images(project["id"], [{"fileName": "one.jpg", "data": sample_image_data()}])
            image = dashboard["projects"][0]["images"][0]
            service.save_annotations(project["id"], image["id"], [{
                "className": "blue_uniform", "x": 10, "y": 10, "width": 30, "height": 40
            }], reviewed=True)

            with self.assertRaisesRegex(ValueError, "Review at least 4 images"):
                service.prepare_dataset(project["id"], "not-ready")

    def test_ready_candidate_is_copied_and_only_activated_manually(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            activated_paths = []
            deleted_model_ids = []

            def activate(path: Path) -> dict:
                activated_paths.append(path)
                return {"id": "custom_packing_v1", "classes": ["pack"], "name": "Packing"}

            def unload(model_ids: list[str]) -> None:
                deleted_model_ids.extend(model_ids)

            service = TrainingService(
                root / "training",
                root / "models",
                on_model_activated=activate,
                on_models_deleted=unload,
            )
            project = service.create_project("Packing", ["pack"])["project"]
            project_dir = root / "training" / project["id"]
            weights = project_dir / "versions" / "v-ready" / "run" / "weights" / "best.pt"
            weights.parent.mkdir(parents=True)
            weights.write_bytes(b"candidate-weights")
            stored = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
            stored["versions"] = [{
                "id": "v-ready",
                "status": "ready",
                "createdAt": 100,
                "weightsPath": str(weights),
                "metrics": {"metrics/mAP50(B)": 0.75},
                "active": False,
                "modelId": None,
                "modelPath": None,
            }]
            (project_dir / "project.json").write_text(json.dumps(stored), encoding="utf-8")

            self.assertEqual(service.snapshot()["projects"][0]["activeModelId"], None)
            activated = service.activate_version(project["id"], "v-ready")

            self.assertEqual(activated["activatedModel"]["id"], "custom_packing_v1")
            self.assertEqual(len(activated_paths), 1)
            self.assertTrue(activated_paths[0].exists())
            self.assertEqual(activated_paths[0].read_bytes(), b"candidate-weights")
            self.assertTrue(activated["projects"][0]["versions"][0]["active"])

            deleted = service.delete_project(project["id"])
            self.assertEqual(deleted["projects"], [])
            self.assertEqual(deleted["deletedModelIds"], ["custom_packing_v1"])
            self.assertEqual(deleted_model_ids, ["custom_packing_v1"])
            self.assertFalse(activated_paths[0].exists())
            self.assertFalse(project_dir.exists())


if __name__ == "__main__":
    unittest.main()
