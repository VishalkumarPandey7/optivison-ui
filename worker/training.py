from __future__ import annotations

import base64
import json
import os
import re
import shutil
import stat
from io import BytesIO
from pathlib import Path
from random import Random
from threading import RLock, Thread
from time import time
from typing import Any, Callable
from uuid import uuid4

from PIL import Image
from ultralytics import YOLO


class TrainingService:
    """Local, review-first custom YOLO dataset and training manager."""

    def __init__(
        self,
        storage_dir: str | Path,
        model_dir: str | Path,
        on_model_activated: Callable[[Path], dict[str, Any]] | None = None,
        on_models_deleted: Callable[[list[str]], None] | None = None,
    ) -> None:
        self.storage_dir = Path(storage_dir)
        self.model_dir = Path(model_dir)
        self.on_model_activated = on_model_activated
        self.on_models_deleted = on_models_deleted
        self._lock = RLock()
        self._threads: dict[str, Thread] = {}
        self.storage_dir.mkdir(parents=True, exist_ok=True)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            projects = [self._read_project(path.parent) for path in self.storage_dir.glob("*/project.json")]
        projects.sort(key=lambda project: float(project.get("updatedAt", 0)), reverse=True)
        return {"ok": True, "projects": projects}

    def create_project(self, name: str, classes: list[str], description: str = "", base_model: str = "yolo11n.pt") -> dict[str, Any]:
        clean_name = name.strip()
        clean_classes = list(dict.fromkeys(str(item).strip().lower() for item in classes if str(item).strip()))
        if not clean_name:
            raise ValueError("Project name is required")
        if not clean_classes:
            raise ValueError("Add at least one custom class")
        if len(clean_classes) > 50:
            raise ValueError("A training project can contain at most 50 classes")
        if base_model not in {"yolo11n.pt", "yolov8n.pt", "yolo26n.pt"}:
            raise ValueError("Unsupported base model")

        project_id = f"{slugify(clean_name)}-{uuid4().hex[:8]}"
        now = time()
        project = {
            "id": project_id,
            "name": clean_name,
            "description": description.strip(),
            "classes": clean_classes,
            "baseModel": base_model,
            "status": "draft",
            "createdAt": now,
            "updatedAt": now,
            "images": [],
            "versions": [],
            "activeModelId": None,
            "training": None,
        }
        with self._lock:
            project_dir = self._project_dir(project_id)
            (project_dir / "images").mkdir(parents=True, exist_ok=False)
            self._write_project(project_dir, project)
        return {"ok": True, "project": project}

    def upload_images(self, project_id: str, images: list[dict[str, Any]]) -> dict[str, Any]:
        if not images:
            raise ValueError("Choose at least one image")
        if len(images) > 100:
            raise ValueError("Upload at most 100 images at a time")
        with self._lock:
            project_dir = self._project_dir(project_id, must_exist=True)
            project = self._read_project(project_dir)
            known_names = {str(item["fileName"]).lower() for item in project["images"]}
            for item in images:
                file_name = Path(str(item.get("fileName") or "image")).name
                if file_name.lower() in known_names:
                    stem, suffix = Path(file_name).stem, Path(file_name).suffix
                    file_name = f"{stem}-{uuid4().hex[:6]}{suffix}"
                image_bytes = decode_data_url(str(item.get("data") or ""))
                with Image.open(BytesIO(image_bytes)) as image:
                    image.verify()
                with Image.open(BytesIO(image_bytes)) as image:
                    width, height = image.size
                    image_format = (image.format or "JPEG").upper()
                if image_format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError(f"{file_name}: only JPEG, PNG, and WebP images are supported")
                suffix = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[image_format]
                image_id = uuid4().hex
                stored_name = f"{image_id}{suffix}"
                (project_dir / "images" / stored_name).write_bytes(image_bytes)
                project["images"].append({
                    "id": image_id,
                    "fileName": file_name,
                    "storedName": stored_name,
                    "width": width,
                    "height": height,
                    "reviewed": False,
                    "annotations": [],
                })
                known_names.add(file_name.lower())
            project["updatedAt"] = time()
            self._write_project(project_dir, project)
        return self.snapshot()

    def save_annotations(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
        reviewed: bool,
    ) -> dict[str, Any]:
        with self._lock:
            project_dir = self._project_dir(project_id, must_exist=True)
            project = self._read_project(project_dir)
            image = next((item for item in project["images"] if item["id"] == image_id), None)
            if image is None:
                raise ValueError("Training image was not found")
            normalized = []
            for annotation in annotations:
                class_name = str(annotation.get("className") or "").strip().lower()
                if class_name not in project["classes"]:
                    raise ValueError(f"Unknown project class: {class_name}")
                x = float(annotation.get("x", 0))
                y = float(annotation.get("y", 0))
                width = float(annotation.get("width", 0))
                height = float(annotation.get("height", 0))
                if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > 100.001 or y + height > 100.001:
                    raise ValueError("Bounding boxes must stay inside the image")
                normalized.append({
                    "id": str(annotation.get("id") or uuid4().hex),
                    "className": class_name,
                    "x": round(x, 4),
                    "y": round(y, 4),
                    "width": round(width, 4),
                    "height": round(height, 4),
                })
            image["annotations"] = normalized
            image["reviewed"] = bool(reviewed)
            project["updatedAt"] = time()
            self._write_project(project_dir, project)
        return self.snapshot()

    def image_file(self, project_id: str, image_id: str) -> tuple[Path, str]:
        with self._lock:
            project_dir = self._project_dir(project_id, must_exist=True)
            project = self._read_project(project_dir)
            image = next((item for item in project["images"] if item["id"] == image_id), None)
            if image is None:
                raise ValueError("Training image was not found")
            path = project_dir / "images" / image["storedName"]
        content_type = {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")
        return path, content_type

    def prepare_dataset(self, project_id: str, version_id: str) -> dict[str, Any]:
        """Create the Ultralytics folder/YAML dataset and return its metadata."""
        with self._lock:
            project_dir = self._project_dir(project_id, must_exist=True)
            project = self._read_project(project_dir)
            reviewed = [image for image in project["images"] if image.get("reviewed")]
            if len(reviewed) < 4:
                raise ValueError("Review at least 4 images before this trial training run")
            used_classes = {
                annotation["className"]
                for image in reviewed
                for annotation in image.get("annotations", [])
            }
            missing_classes = [class_name for class_name in project["classes"] if class_name not in used_classes]
            if missing_classes:
                raise ValueError(f"Every class needs at least one box. Missing: {', '.join(missing_classes)}")

            shuffled = list(reviewed)
            Random(42).shuffle(shuffled)
            validation_count = max(1, round(len(shuffled) * 0.2))
            validation = shuffled[:validation_count]
            training = shuffled[validation_count:]
            version_dir = project_dir / "versions" / version_id
            dataset_dir = version_dir / "dataset"
            for split in ("train", "val"):
                (dataset_dir / "images" / split).mkdir(parents=True, exist_ok=True)
                (dataset_dir / "labels" / split).mkdir(parents=True, exist_ok=True)
            class_ids = {class_name: index for index, class_name in enumerate(project["classes"])}
            for split, items in (("train", training), ("val", validation)):
                for image in items:
                    source = project_dir / "images" / image["storedName"]
                    target_name = f"{image['id']}{source.suffix.lower()}"
                    shutil.copy2(source, dataset_dir / "images" / split / target_name)
                    labels = []
                    for annotation in image.get("annotations", []):
                        center_x = (float(annotation["x"]) + float(annotation["width"]) / 2) / 100
                        center_y = (float(annotation["y"]) + float(annotation["height"]) / 2) / 100
                        width = float(annotation["width"]) / 100
                        height = float(annotation["height"]) / 100
                        labels.append(
                            f"{class_ids[annotation['className']]} {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f}"
                        )
                    (dataset_dir / "labels" / split / f"{image['id']}.txt").write_text(
                        "\n".join(labels), encoding="utf-8"
                    )
            names_yaml = "\n".join(f"  {index}: {json.dumps(name)}" for index, name in enumerate(project["classes"]))
            yaml_path = dataset_dir / "dataset.yaml"
            yaml_path.write_text(
                f"path: {dataset_dir.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n{names_yaml}\n",
                encoding="utf-8",
            )
            return {
                "project": project,
                "projectDir": project_dir,
                "versionDir": version_dir,
                "datasetDir": dataset_dir,
                "yamlPath": yaml_path,
                "trainingImages": len(training),
                "validationImages": len(validation),
            }

    def start_training(self, project_id: str, epochs: int = 30, image_size: int = 640) -> dict[str, Any]:
        epochs = max(1, min(500, int(epochs)))
        image_size = int(image_size)
        if image_size not in {320, 416, 512, 640, 800, 960}:
            raise ValueError("Unsupported training image size")
        version_id = f"v-{uuid4().hex[:8]}"
        # Validate and build synchronously so UI errors are immediate.
        prepared = self.prepare_dataset(project_id, version_id)
        with self._lock:
            project = self._read_project(prepared["projectDir"])
            if project.get("training") and project["training"].get("status") in {"queued", "training"}:
                raise ValueError("This project already has a training run in progress")
            now = time()
            project["status"] = "training"
            project["training"] = {
                "status": "queued",
                "versionId": version_id,
                "epoch": 0,
                "totalEpochs": epochs,
                "progress": 0,
                "startedAt": now,
                "finishedAt": None,
                "error": "",
                "imageSize": image_size,
                "trainingImages": prepared["trainingImages"],
                "validationImages": prepared["validationImages"],
            }
            project["updatedAt"] = now
            self._write_project(prepared["projectDir"], project)
            thread = Thread(
                target=self._train,
                args=(project_id, version_id, epochs, image_size),
                daemon=True,
                name=f"optivision-training-{project_id}",
            )
            self._threads[project_id] = thread
            thread.start()
        return self.snapshot()

    def activate_version(self, project_id: str, version_id: str) -> dict[str, Any]:
        with self._lock:
            project_dir = self._project_dir(project_id, must_exist=True)
            project = self._read_project(project_dir)
            version = next((item for item in project["versions"] if item["id"] == version_id), None)
            if version is None or version.get("status") != "ready":
                raise ValueError("Only a completed candidate can be activated")
            source = Path(version["weightsPath"])
            if not source.exists():
                raise ValueError("Candidate weights are missing")
            self.model_dir.mkdir(parents=True, exist_ok=True)
            destination = self.model_dir / f"custom_{slugify(project['name'])}_{version_id}.pt"
            shutil.copy2(source, destination)
            activation = self.on_model_activated(destination) if self.on_model_activated else {
                "id": destination.stem.lower().replace("-", "_"),
                "classes": project["classes"],
            }
            for item in project["versions"]:
                item["active"] = item["id"] == version_id
            version["modelId"] = activation["id"]
            version["modelPath"] = str(destination.resolve())
            project["activeModelId"] = activation["id"]
            project["updatedAt"] = time()
            self._write_project(project_dir, project)
        return {**self.snapshot(), "activatedModel": activation}

    def delete_project(self, project_id: str) -> dict[str, Any]:
        """Delete one project's dataset, runs, and activated weight copies."""
        with self._lock:
            project_dir = self._project_dir(project_id, must_exist=True)
            project = self._read_project(project_dir)
            if project.get("training") and project["training"].get("status") in {"queued", "training"}:
                raise ValueError("Stop or wait for the active training run before deleting this project")
            model_ids = [
                str(version["modelId"])
                for version in project.get("versions", [])
                if version.get("modelId")
            ]
            if self.on_models_deleted and model_ids:
                self.on_models_deleted(model_ids)
            model_root = self.model_dir.resolve()
            for version in project.get("versions", []):
                model_path_value = version.get("modelPath")
                if not model_path_value:
                    continue
                model_path = Path(str(model_path_value)).resolve()
                if model_path.parent == model_root and model_path.name.startswith("custom_"):
                    model_path.unlink(missing_ok=True)
            remove_tree(project_dir)
        return {**self.snapshot(), "deletedProjectId": project_id, "deletedModelIds": model_ids}

    def _train(self, project_id: str, version_id: str, epochs: int, image_size: int) -> None:
        project_dir = self._project_dir(project_id, must_exist=True)
        version_dir = project_dir / "versions" / version_id
        try:
            self._update_training(project_dir, status="training")
            project = self._read_project(project_dir)
            local_base = self.model_dir / project["baseModel"]
            model = YOLO(str(local_base if local_base.exists() else project["baseModel"]))

            def on_epoch_end(trainer: Any) -> None:
                epoch = min(epochs, int(getattr(trainer, "epoch", 0)) + 1)
                self._update_training(project_dir, epoch=epoch, progress=round(epoch / epochs * 100, 1))

            model.add_callback("on_train_epoch_end", on_epoch_end)
            result = model.train(
                data=str(version_dir / "dataset" / "dataset.yaml"),
                epochs=epochs,
                imgsz=image_size,
                project=str(version_dir),
                name="run",
                exist_ok=True,
                workers=0,
                patience=max(5, min(20, epochs // 3)),
                verbose=False,
            )
            best_weights = version_dir / "run" / "weights" / "best.pt"
            if not best_weights.exists():
                raise RuntimeError("Training ended without best.pt weights")
            metrics = clean_metrics(getattr(result, "results_dict", {}))
            with self._lock:
                project = self._read_project(project_dir)
                project["versions"].append({
                    "id": version_id,
                    "status": "ready",
                    "createdAt": time(),
                    "weightsPath": str(best_weights.resolve()),
                    "metrics": metrics,
                    "active": False,
                    "modelId": None,
                    "modelPath": None,
                })
                project["status"] = "trained"
                project["training"].update({
                    "status": "completed",
                    "epoch": epochs,
                    "progress": 100,
                    "finishedAt": time(),
                    "error": "",
                })
                project["updatedAt"] = time()
                self._write_project(project_dir, project)
        except Exception as error:
            with self._lock:
                project = self._read_project(project_dir)
                project["status"] = "failed"
                if project.get("training"):
                    project["training"].update({"status": "failed", "finishedAt": time(), "error": str(error)})
                project["updatedAt"] = time()
                self._write_project(project_dir, project)
        finally:
            with self._lock:
                self._threads.pop(project_id, None)

    def _update_training(self, project_dir: Path, **updates: Any) -> None:
        with self._lock:
            project = self._read_project(project_dir)
            if project.get("training"):
                project["training"].update(updates)
                project["updatedAt"] = time()
                self._write_project(project_dir, project)

    def _project_dir(self, project_id: str, must_exist: bool = False) -> Path:
        clean_id = str(project_id).strip()
        if not clean_id or not re.fullmatch(r"[a-z0-9_-]+", clean_id):
            raise ValueError("Invalid training project")
        project_dir = self.storage_dir / clean_id
        if must_exist and not (project_dir / "project.json").exists():
            raise ValueError("Training project was not found")
        return project_dir

    @staticmethod
    def _read_project(project_dir: Path) -> dict[str, Any]:
        return json.loads((project_dir / "project.json").read_text(encoding="utf-8"))

    @staticmethod
    def _write_project(project_dir: Path, project: dict[str, Any]) -> None:
        project_dir.mkdir(parents=True, exist_ok=True)
        temporary = project_dir / "project.json.tmp"
        temporary.write_text(json.dumps(project, indent=2), encoding="utf-8")
        temporary.replace(project_dir / "project.json")


def decode_data_url(payload: str) -> bytes:
    encoded = payload.split(",", 1)[1] if "," in payload else payload
    try:
        return base64.b64decode(encoded, validate=True)
    except Exception as error:
        raise ValueError("Invalid image data") from error


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug[:48] or "custom-model"


def clean_metrics(metrics: Any) -> dict[str, float]:
    if not isinstance(metrics, dict):
        return {}
    clean: dict[str, float] = {}
    for key, value in metrics.items():
        try:
            clean[str(key)] = round(float(value), 6)
        except (TypeError, ValueError):
            continue
    return clean


def remove_tree(path: Path) -> None:
    """Remove generated data even when OneDrive marks folders read-only."""
    def clear_and_retry(function: Callable[..., Any], target: str, _error: Any) -> None:
        os.chmod(target, stat.S_IREAD | stat.S_IWRITE)
        function(target)

    shutil.rmtree(path, onerror=clear_and_retry)
