from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from io import BytesIO
from pathlib import Path
from threading import RLock
from time import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image

ultralytics_config_dir = Path(__file__).resolve().parent / ".ultralytics"
ultralytics_config_dir.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(ultralytics_config_dir))

import supervision as sv
from ultralytics import YOLO

from alerts import AlertService
from conveyor import ConveyorCountingRuntime
from engine import SignalRuleEngine
from training import TrainingService
from workspace import WorkspaceService
from lpr_runtime import IndianLprRuntime


COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
    "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
    "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    file_name: str
    task: str
    classes: list[str]
    downloadable: bool = False


MODEL_SPECS = {
    "yolo11n": ModelSpec("yolo11n", "YOLO11n Detect", "yolo11n.pt", "detect", COCO_CLASSES),
    "yolov8n": ModelSpec("yolov8n", "YOLOv8n Detect", "yolov8n.pt", "detect", COCO_CLASSES),
    "yolo26n": ModelSpec("yolo26n", "YOLO26n Detect", "yolo26n.pt", "detect", COCO_CLASSES),
    "yolo11n_pose": ModelSpec("yolo11n_pose", "YOLO11n Pose", "yolo11n-pose.pt", "pose", ["person"], True),
}


class UltralyticsRegistry:
    def __init__(self, model_dir: str) -> None:
        self.model_dir = Path(model_dir)
        self._models: dict[str, YOLO] = {}
        self._model_classes: dict[str, list[str]] = {}
        self._trackers: dict[tuple[str, str], Any] = {}
        self._lock = RLock()

    def _specs(self) -> dict[str, ModelSpec]:
        specs = dict(MODEL_SPECS)
        known_files = {spec.file_name.lower() for spec in specs.values()}
        if self.model_dir.exists():
            for model_path in sorted(self.model_dir.glob("*.pt")):
                if model_path.name.lower() in known_files:
                    continue
                model_id = model_path.stem.lower().replace("-", "_").replace(" ", "_")
                task = "pose" if "pose" in model_path.stem.lower() else "detect"
                classes = ["person"] if task == "pose" else []
                specs[model_id] = ModelSpec(
                    model_id,
                    f"{model_path.stem} (Local {task.title()})",
                    model_path.name,
                    task,
                    classes,
                )
        return specs

    def catalog(self) -> list[dict[str, Any]]:
        return [
            {
                "id": spec.id,
                "name": spec.name,
                "task": spec.task,
                "classes": self._model_classes.get(spec.id, spec.classes),
                "installed": (self.model_dir / spec.file_name).exists() or Path(spec.file_name).exists(),
                "downloadable": spec.downloadable,
            }
            for spec in self._specs().values()
        ]

    def activate_local_model(self, model_path: Path) -> dict[str, Any]:
        """Load an approved custom model and expose its classes immediately."""
        with self._lock:
            model = YOLO(str(model_path))
            model_id = model_path.stem.lower().replace("-", "_").replace(" ", "_")
            names = getattr(model, "names", {})
            if isinstance(names, dict):
                classes = [str(name) for _, name in sorted(names.items())]
            elif isinstance(names, (list, tuple)):
                classes = [str(name) for name in names]
            else:
                classes = []
            self._models[model_id] = model
            self._model_classes[model_id] = classes
            self._trackers = {
                key: tracker for key, tracker in self._trackers.items() if key[1] != model_id
            }
            return {"id": model_id, "classes": classes, "name": f"{model_path.stem} (Custom Detect)"}

    def remove_local_models(self, model_ids: list[str]) -> None:
        """Unload deleted custom weights and their camera trackers."""
        with self._lock:
            removed = set(model_ids)
            for model_id in removed:
                self._models.pop(model_id, None)
                self._model_classes.pop(model_id, None)
            self._trackers = {
                key: tracker for key, tracker in self._trackers.items() if key[1] not in removed
            }

    def analyze(
        self,
        model_id: str,
        camera_id: str,
        image: np.ndarray,
        confidence: float,
        zones: list[dict[str, Any]],
        class_names: list[str] | None = None,
        minimum_roi_overlap: float = 0.5,
    ) -> list[dict[str, Any]]:
        """Run Ultralytics inference, then normalize/track/zone with Supervision."""
        with self._lock:
            spec = self._specs().get(model_id)
            if not spec:
                raise ValueError(f"Unknown model: {model_id}")
            model = self._models.get(model_id)
            if model is None:
                local_path = self.model_dir / spec.file_name
                model = YOLO(str(local_path if local_path.exists() else spec.file_name))
                downloaded_path = Path(spec.file_name)
                if spec.downloadable and not local_path.exists() and downloaded_path.exists():
                    self.model_dir.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(downloaded_path), str(local_path))
                self._models[model_id] = model

            model_names = getattr(model, "names", {})
            if isinstance(model_names, dict):
                self._model_classes[model_id] = [str(name) for _, name in sorted(model_names.items())]
            elif isinstance(model_names, list):
                self._model_classes[model_id] = [str(name) for name in model_names]

            # Ultralytics is used only for model inference. Supervision converts the
            # model-specific result into a common Detections representation.
            class_ids = requested_model_class_ids(model_names, class_names)
            if class_names is not None and not class_ids:
                return []
            predict_options: dict[str, Any] = {"conf": confidence, "verbose": False}
            if class_ids is not None:
                predict_options["classes"] = class_ids
            results = model.predict(image, **predict_options)
            if not results:
                return []
            result = results[0]
            raw_detections = sv.Detections.from_ultralytics(result)
            raw_detections.data["detection_index"] = np.arange(len(raw_detections), dtype=int)

            tracker_key = (camera_id, model_id)
            tracker = self._trackers.get(tracker_key)
            if tracker is None:
                tracker = sv.ByteTrack(
                    track_activation_threshold=0.25,
                    minimum_consecutive_frames=1,
                    frame_rate=10.0,
                )
                self._trackers[tracker_key] = tracker
            tracked = tracker.update_with_detections(raw_detections)

            zone_ids_by_detection = supervision_zone_memberships(
                tracked,
                zones,
                image.shape[1],
                image.shape[0],
                minimum_roi_overlap,
            )
            keypoint_xy = result.keypoints.xy.cpu().numpy() if result.keypoints is not None else None
            keypoint_confidence = (
                result.keypoints.conf.cpu().numpy()
                if result.keypoints is not None and result.keypoints.conf is not None
                else None
            )
            source_indices = tracked.data.get("detection_index", np.arange(len(tracked), dtype=int))
            track_ids = tracked.tracker_id
            names = result.names

            detections = []
            for index, box in enumerate(tracked.xyxy):
                source_index = int(source_indices[index])
                keypoints = []
                if keypoint_xy is not None and source_index < len(keypoint_xy):
                    for point_index, point in enumerate(keypoint_xy[source_index]):
                        point_confidence = (
                            float(keypoint_confidence[source_index][point_index])
                            if keypoint_confidence is not None
                            else 1.0
                        )
                        keypoints.append({
                            "x": round(float(point[0]), 2),
                            "y": round(float(point[1]), 2),
                            "confidence": round(point_confidence, 4),
                        })

                class_id = int(tracked.class_id[index]) if tracked.class_id is not None else -1
                tracker_id = int(track_ids[index]) if track_ids is not None else -1
                track_confirmed = tracker_id >= 0
                public_track_id: int | str = tracker_id if track_confirmed else f"pending-{source_index}"
                confidence_value = (
                    float(tracked.confidence[index]) if tracked.confidence is not None else confidence
                )
                detections.append({
                    "id": f"{model_id}-{public_track_id}",
                    "trackId": public_track_id,
                    "trackConfirmed": track_confirmed,
                    "className": model_class_name(names, class_id),
                    "confidence": round(confidence_value, 4),
                    "box": [round(float(value), 2) for value in box],
                    "modelId": model_id,
                    "task": str(getattr(model, "task", spec.task)),
                    "keypoints": keypoints,
                    "zoneIds": zone_ids_by_detection[index],
                    "spatialEngine": "supervision-detections-box-overlap",
                })
            return detections

    def reset(self, camera_id: str | None = None) -> None:
        with self._lock:
            if camera_id is None:
                self._trackers.clear()
            else:
                self._trackers = {
                    key: tracker for key, tracker in self._trackers.items() if key[0] != camera_id
                }


class ZoneMotionAnalyzer:
    """Produces detector-independent motion facts for configured ROIs."""

    def __init__(self, pixel_delta_threshold: float = 18.0) -> None:
        self.pixel_delta_threshold = pixel_delta_threshold
        self._previous_frames: dict[str, np.ndarray] = {}

    def reset(self, camera_id: str | None = None) -> None:
        if not camera_id:
            self._previous_frames.clear()
        else:
            self._previous_frames.pop(camera_id, None)

    def analyze(
        self,
        camera_id: str,
        image: np.ndarray,
        zones: list[dict[str, Any]],
    ) -> dict[str, dict[str, Any]]:
        grayscale = np.dot(image[:, :, :3], [0.299, 0.587, 0.114]).astype(np.float32)
        previous = self._previous_frames.get(camera_id)
        self._previous_frames[camera_id] = grayscale.copy()
        height, width = grayscale.shape
        metrics: dict[str, dict[str, Any]] = {}

        for zone in zones:
            zone_id = str(zone.get("id") or "")
            if not zone_id:
                continue
            x, y, zone_width, zone_height = zone_bounds(zone, width, height)
            initialized = previous is not None and previous.shape == grayscale.shape and zone_width > 0 and zone_height > 0
            score = 0.0
            average_rgb = [0, 0, 0]
            if zone_width > 0 and zone_height > 0:
                color_region = image[y:y + zone_height, x:x + zone_width, :3]
                if color_region.size:
                    average_rgb = [round(float(value), 2) for value in color_region.reshape(-1, 3).mean(axis=0)]
            if initialized:
                difference = np.abs(
                    grayscale[y:y + zone_height, x:x + zone_width]
                    - previous[y:y + zone_height, x:x + zone_width]
                )
                score = float(np.count_nonzero(difference >= self.pixel_delta_threshold) / difference.size * 100)
            metrics[zone_id] = {
                "initialized": initialized,
                "motionScore": round(score, 4),
                "pixelDeltaThreshold": self.pixel_delta_threshold,
                "averageRgb": average_rgb,
                "averageColor": "#" + "".join(f"{max(0, min(255, round(value))):02x}" for value in average_rgb),
            }
        return metrics


runtime_root = Path(os.environ.get("OPTIVISION_RUNTIME_DIR", Path(__file__).resolve().parent.parent / ".opti-vision-runtime")).expanduser().resolve()
runtime_root.mkdir(parents=True, exist_ok=True)

runtime = SignalRuleEngine()
motion_runtime = ZoneMotionAnalyzer()
conveyor_runtime = ConveyorCountingRuntime()
lpr_runtime = IndianLprRuntime()
alert_service = AlertService(runtime_root / "alert-state.json")
workspace_service = WorkspaceService(runtime_root / "workspace-state.json")
registry: UltralyticsRegistry | None = None
training_service: TrainingService | None = None


class SignalLabHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self._json({
                "ok": True,
                "service": "optivision-signal-rule-lab",
                "engine": "ultralytics-yolo+supervision",
                "pipeline": pipeline_metadata(),
                "versions": {
                    "ultralytics": package_version("ultralytics"),
                    "supervision": package_version("supervision"),
                },
                "models": [*(registry.catalog() if registry else []), lpr_runtime.catalog_entry()],
            })
            return
        if path == "/models":
            self._json({"models": [*(registry.catalog() if registry else []), lpr_runtime.catalog_entry()]})
            return
        if path == "/alerts":
            self._json(alert_service.snapshot())
            return
        if path == "/workspace":
            self._json(workspace_service.snapshot())
            return
        if path == "/training/projects":
            if training_service is None:
                raise RuntimeError("Training service is not ready")
            self._json(training_service.snapshot())
            return
        if path == "/training/image":
            if training_service is None:
                raise RuntimeError("Training service is not ready")
            query = parse_qs(parsed.query)
            image_path, content_type = training_service.image_file(
                str(query.get("projectId", [""])[0]),
                str(query.get("imageId", [""])[0]),
            )
            self._binary(image_path.read_bytes(), content_type)
            return
        self.send_error(404, "Not found")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            if path == "/alerts/config":
                self._json(alert_service.update_config(dict(payload.get("config") or {})))
                return
            if path == "/alerts/test-email":
                self._json(alert_service.queue_test_email(str(payload.get("authorityId") or "")))
                return
            if path == "/alerts/clear":
                self._json(alert_service.clear_alerts())
                return
            if path == "/workspace":
                self._json(workspace_service.update(
                    factory=dict(payload.get("factory") or {}),
                    deployment=dict(payload.get("deployment") or {}),
                ))
                return
            if path == "/training/projects/create":
                if training_service is None:
                    raise RuntimeError("Training service is not ready")
                self._json(training_service.create_project(
                    name=str(payload.get("name") or ""),
                    description=str(payload.get("description") or ""),
                    classes=list(payload.get("classes") or []),
                    base_model=str(payload.get("baseModel") or "yolo11n.pt"),
                ))
                return
            if path == "/training/images/upload":
                if training_service is None:
                    raise RuntimeError("Training service is not ready")
                self._json(training_service.upload_images(
                    project_id=str(payload.get("projectId") or ""),
                    images=list(payload.get("images") or []),
                ))
                return
            if path == "/training/annotations/save":
                if training_service is None:
                    raise RuntimeError("Training service is not ready")
                self._json(training_service.save_annotations(
                    project_id=str(payload.get("projectId") or ""),
                    image_id=str(payload.get("imageId") or ""),
                    annotations=list(payload.get("annotations") or []),
                    reviewed=bool(payload.get("reviewed", False)),
                ))
                return
            if path == "/training/start":
                if training_service is None:
                    raise RuntimeError("Training service is not ready")
                self._json(training_service.start_training(
                    project_id=str(payload.get("projectId") or ""),
                    epochs=int(payload.get("epochs", 30)),
                    image_size=int(payload.get("imageSize", 640)),
                ))
                return
            if path == "/training/activate":
                if training_service is None:
                    raise RuntimeError("Training service is not ready")
                self._json(training_service.activate_version(
                    project_id=str(payload.get("projectId") or ""),
                    version_id=str(payload.get("versionId") or ""),
                ))
                return
            if path == "/training/projects/delete":
                if training_service is None:
                    raise RuntimeError("Training service is not ready")
                self._json(training_service.delete_project(
                    project_id=str(payload.get("projectId") or ""),
                ))
                return
            if path == "/reset":
                camera_id = str(payload.get("cameraId") or "") or None
                runtime.reset(camera_id)
                motion_runtime.reset(camera_id)
                conveyor_runtime.reset(camera_id)
                if registry:
                    registry.reset(camera_id)
                self._json({"ok": True})
                return
            if path != "/analyze":
                self.send_error(404, "Not found")
                return
            if registry is None:
                raise RuntimeError("Model registry is not ready")

            image = decode_image(str(payload["image"]))
            height, width = image.shape[:2]
            confidence = max(0.01, min(1.0, float(payload.get("confidence", 0.35))))
            model_ids = list(dict.fromkeys(str(model_id) for model_id in payload.get("modelIds", ["yolo11n"])))
            raw_class_names = payload.get("classNames")
            class_names = (
                list(dict.fromkeys(str(class_name).strip().lower() for class_name in raw_class_names if str(class_name).strip()))
                if isinstance(raw_class_names, list)
                else None
            )
            camera_id = str(payload.get("cameraId", "signal-lab-camera"))
            zones = list(payload.get("zones") or [])
            analysis_roi_ids = {
                str(zone_id)
                for zone_id in payload.get("analysisRoiIds") or []
                if str(zone_id)
            }
            minimum_roi_overlap = max(0.1, min(1.0, float(payload.get("minimumRoiOverlap", 0.5))))
            detections = []
            model_errors = []
            for model_id in model_ids:
                try:
                    if model_id == "indian_lpr":
                        detections.extend(lpr_runtime.analyze(image, zones, minimum_roi_overlap))
                    else:
                        detections.extend(registry.analyze(
                            model_id,
                            camera_id,
                            image,
                            confidence,
                            zones,
                            class_names,
                            minimum_roi_overlap,
                        ))
                except Exception as error:
                    model_errors.append({"modelId": model_id, "error": str(error)})

            if "analysisRoiIds" in payload:
                detections = filter_detections_to_analysis_rois(detections, analysis_roi_ids)

            timestamp = float(payload.get("timestamp", time()))
            signal_definitions = list(payload.get("signalDefinitions") or [])
            counting_metrics, generic_detections = conveyor_runtime.analyze(
                camera_id=camera_id,
                timestamp=timestamp,
                image=image,
                detections=detections,
                zones=zones,
                counting_lines=list(payload.get("countingLines") or []),
                signal_definitions=signal_definitions,
            )
            detections.extend(generic_detections)
            zone_metrics = motion_runtime.analyze(camera_id, image, zones)
            evaluated = runtime.evaluate(
                camera_id=camera_id,
                timestamp=timestamp,
                width=width,
                height=height,
                detections=detections,
                zones=zones,
                signal_definitions=signal_definitions,
                rules=list(payload.get("rules") or []),
                zone_metrics=zone_metrics,
                counting_metrics=counting_metrics,
            )
            alert_service.process_frame(
                camera_id=camera_id,
                camera_name=str(payload.get("cameraName") or camera_id),
                timestamp=timestamp,
                rule_states=evaluated["rules"],
                signal_states=evaluated["signals"],
            )
            self._json({
                "ok": True,
                "frame": int(payload.get("frame", 0)),
                "timestamp": timestamp,
                "width": width,
                "height": height,
                "modelsRequested": model_ids,
                "classesRequested": class_names,
                "analysisRoiIds": sorted(analysis_roi_ids),
                "minimumRoiOverlap": minimum_roi_overlap,
                "modelErrors": model_errors,
                "pipeline": pipeline_metadata(),
                "detections": detections,
                "zoneMetrics": zone_metrics,
                "counting": list(counting_metrics.values()),
                **evaluated,
            })
        except Exception as error:
            self._json({"ok": False, "error": str(error)}, status=400)

    def do_OPTIONS(self) -> None:
        self._json({"ok": True})

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def _json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _binary(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def decode_image(image_payload: str) -> np.ndarray:
    if "," in image_payload:
        image_payload = image_payload.split(",", 1)[1]
    image_bytes = base64.b64decode(image_payload)
    return np.array(Image.open(BytesIO(image_bytes)).convert("RGB"))


def pipeline_metadata() -> dict[str, str]:
    return {
        "inference": "ultralytics-yolo",
        "normalization": "supervision-detections",
        "tracking": "supervision-bytetrack-per-camera",
        "roiMembership": "supervision-detections-minimum-box-overlap",
        "genericObjects": "grey-white-background-subtraction-mask+class-independent-nms",
        "directMotionCounting": "grey-white-motion-zone+gap-tolerant-centroid-tracking+stable-pass-deduplication",
        "lineCrossing": "supervision-linezone-when-configured+direct-motion-zone-fallback",
        "signals": "optivision-signal-engine",
        "rules": "optivision-rule-engine",
    }


def model_class_name(names: Any, class_id: int) -> str:
    if isinstance(names, dict):
        return str(names.get(class_id, class_id))
    if isinstance(names, (list, tuple)) and 0 <= class_id < len(names):
        return str(names[class_id])
    return str(class_id)


def requested_model_class_ids(names: Any, class_names: list[str] | None) -> list[int] | None:
    """Translate requested class names into the IDs understood by one YOLO model."""
    if class_names is None:
        return None
    requested = {str(class_name).strip().lower() for class_name in class_names if str(class_name).strip()}
    if isinstance(names, dict):
        return [int(class_id) for class_id, name in names.items() if str(name).strip().lower() in requested]
    if isinstance(names, (list, tuple)):
        return [index for index, name in enumerate(names) if str(name).strip().lower() in requested]
    return []


def filter_detections_to_analysis_rois(
    detections: list[dict[str, Any]],
    analysis_roi_ids: set[str],
) -> list[dict[str, Any]]:
    """Drop normalized detections that do not overlap an allowed analysis ROI."""
    return [
        detection
        for detection in detections
        if analysis_roi_ids.intersection(str(zone_id) for zone_id in detection.get("zoneIds") or [])
    ]


def supervision_zone_memberships(
    detections: sv.Detections,
    zones: list[dict[str, Any]],
    width: int,
    height: int,
    minimum_overlap: float = 0.5,
) -> list[list[str]]:
    """Return ROI IDs containing at least the requested share of each box.

    Ultralytics results are normalized as ``sv.Detections`` before this
    calculation. Requiring box-area overlap avoids the old center-anchor case
    where most of an object could sit outside the configured analysis region.
    """
    memberships: list[list[str]] = [[] for _ in range(len(detections))]
    overlap_threshold = max(0.1, min(1.0, float(minimum_overlap)))
    for zone in zones:
        zone_id = str(zone.get("id") or "")
        if not zone_id:
            continue
        x, y, zone_width, zone_height = zone_bounds(zone, width, height)
        if zone_width <= 0 or zone_height <= 0:
            continue
        zone_x2 = x + zone_width
        zone_y2 = y + zone_height
        for index, box in enumerate(detections.xyxy):
            x1, y1, x2, y2 = (float(value) for value in box)
            box_area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
            if box_area <= 0:
                continue
            intersection_width = max(0.0, min(x2, zone_x2) - max(x1, x))
            intersection_height = max(0.0, min(y2, zone_y2) - max(y1, y))
            overlap = intersection_width * intersection_height / box_area
            if overlap >= overlap_threshold:
                memberships[index].append(zone_id)
    return memberships


def zone_bounds(zone: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    if str(zone.get("coordinateSpace") or "percent") == "percent":
        x = round(float(zone.get("x", 0)) / 100 * width)
        y = round(float(zone.get("y", 0)) / 100 * height)
        zone_width = round(float(zone.get("width", 0)) / 100 * width)
        zone_height = round(float(zone.get("height", 0)) / 100 * height)
    else:
        x = round(float(zone.get("x", 0)))
        y = round(float(zone.get("y", 0)))
        zone_width = round(float(zone.get("width", 0)))
        zone_height = round(float(zone.get("height", 0)))
    x = max(0, min(width, x))
    y = max(0, min(height, y))
    return x, y, max(0, min(width - x, zone_width)), max(0, min(height - y, zone_height))


def main() -> None:
    global registry, training_service
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8770, type=int)
    parser.add_argument("--model-dir", default=str(Path(__file__).resolve().parent / "models"))
    args = parser.parse_args()
    registry = UltralyticsRegistry(args.model_dir)
    training_service = TrainingService(
        storage_dir=runtime_root / "training-data",
        model_dir=args.model_dir,
        on_model_activated=registry.activate_local_model,
        on_models_deleted=registry.remove_local_models,
    )
    server = ThreadingHTTPServer((args.host, args.port), SignalLabHandler)
    print(f"Signal & Rule Engine worker listening on http://{args.host}:{args.port}")
    print("Pipeline: grey/white ROI motion mask -> Supervision ByteTrack -> direct pass count -> signals -> rules")
    print("Models load lazily when selected. YOLO11n Pose downloads automatically if absent.")
    server.serve_forever()


if __name__ == "__main__":
    main()
