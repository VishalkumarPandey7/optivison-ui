from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from threading import RLock
from typing import Any

import cv2
import numpy as np
import torch


def _box_iou(left: list[int], right: list[int]) -> float:
    intersection = max(0, min(left[2], right[2]) - max(left[0], right[0])) * max(0, min(left[3], right[3]) - max(left[1], right[1]))
    if intersection <= 0:
        return 0.0
    left_area = max(1, (left[2] - left[0]) * (left[3] - left[1]))
    right_area = max(1, (right[2] - right[0]) * (right[3] - right[1]))
    return intersection / max(1, left_area + right_area - intersection)


def _overlap_ratio(box: list[int], zone: dict[str, Any], width: int, height: int) -> float:
    left, top, right, bottom = box
    zone_left = float(zone.get("x", 0)) / 100 * width
    zone_top = float(zone.get("y", 0)) / 100 * height
    zone_right = zone_left + float(zone.get("width", 0)) / 100 * width
    zone_bottom = zone_top + float(zone.get("height", 0)) / 100 * height
    intersection = max(0.0, min(right, zone_right) - max(left, zone_left)) * max(0.0, min(bottom, zone_bottom) - max(top, zone_top))
    area = max(1.0, float((right - left) * (bottom - top)))
    return intersection / area


def _explicit_plate_zones(zones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return drawn ROIs that explicitly identify the LPR capture area."""
    return [
        zone
        for zone in zones
        if float(zone.get("width", 0)) > 0.5
        and float(zone.get("height", 0)) > 0.5
        and any(
            token in f'{zone.get("id", "")} {zone.get("name", "")} {zone.get("kind", "")}'.lower()
            for token in ("plate", "lpr", "number")
        )
    ]


class IndianLprRuntime:
    """Lazy adapter for the user's Indian_LPR detector and LPRNet OCR weights."""

    def __init__(self) -> None:
        default_root = Path(__file__).resolve().parent / "third_party" / "Indian_LPR"
        self.root = Path(os.environ.get("OPTIVISION_LPR_ROOT", default_root)).expanduser().resolve()
        self._lock = RLock()
        self._detector: Any = None
        self._recognizer: Any = None
        self._preprocess: Any = None
        self._decode: Any = None

    @property
    def available(self) -> bool:
        return (self.root / "weights" / "best_od.pth").exists() and (self.root / "weights" / "best_lprnet.pth").exists()

    def catalog_entry(self) -> dict[str, Any]:
        return {
            "id": "indian_lpr",
            "name": "Indian Number Plate Detection + OCR",
            "task": "detect",
            "classes": ["license_plate"],
            "installed": self.available,
            "downloadable": False,
        }

    def _load(self) -> None:
        if self._detector is not None:
            return
        if not self.available:
            raise FileNotFoundError(f"Indian LPR weights were not found at {self.root}")
        root_text = str(self.root)
        if root_text not in sys.path:
            sys.path.insert(0, root_text)
        from src.object_detection.model.fcos import FCOSDetector
        from src.object_detection.model.config import DefaultConfig
        from src.object_detection.utils.utils import preprocess_image
        from src.License_Plate_Recognition.model.LPRNet import build_lprnet
        from infer_objectdet import Greedy_Decode_inference

        detector = FCOSDetector(mode="inference", config=DefaultConfig).eval()
        detector.load_state_dict(torch.load(self.root / "weights" / "best_od.pth", map_location="cpu"))
        recognizer = build_lprnet(lpr_max_len=16, class_num=37).eval()
        recognizer.load_state_dict(torch.load(self.root / "weights" / "best_lprnet.pth", map_location="cpu"))
        if torch.cuda.is_available():
            detector = detector.cuda()
            recognizer = recognizer.cuda()
        self._detector = detector
        self._recognizer = recognizer
        self._preprocess = preprocess_image
        self._decode = Greedy_Decode_inference

    def _detect(self, image: np.ndarray) -> tuple[list[list[float]], list[float]]:
        prepared = self._preprocess(image.copy())
        if torch.cuda.is_available():
            prepared = prepared.cuda()
        with torch.no_grad():
            scores, _classes, boxes = self._detector(prepared)
        return boxes[0].detach().cpu().numpy().tolist(), scores[0].detach().cpu().numpy().tolist()

    @staticmethod
    def _plate_zone_views(image: np.ndarray, zones: list[dict[str, Any]]) -> list[tuple[np.ndarray, float, int, int]]:
        """Return enlarged plate-ROI views and their original-frame transforms.

        Indian_LPR's FCOS detector is sensitive to very small plates. Browser
        frames are capped at 960px, so a distant plate can disappear even
        though it is readable in the configured ROI. Retrying only the plate
        zone keeps the fallback bounded while preserving full-frame box
        coordinates for lifecycle filtering and display.
        """
        height, width = image.shape[:2]
        drawn = [zone for zone in zones if float(zone.get("width", 0)) > 0.5 and float(zone.get("height", 0)) > 0.5]
        named = _explicit_plate_zones(zones)
        selected = named or drawn
        views: list[tuple[np.ndarray, float, int, int]] = []
        for zone in selected:
            left = max(0, min(width - 1, round(float(zone.get("x", 0)) / 100 * width)))
            top = max(0, min(height - 1, round(float(zone.get("y", 0)) / 100 * height)))
            right = max(left + 1, min(width, round((float(zone.get("x", 0)) + float(zone.get("width", 0))) / 100 * width)))
            bottom = max(top + 1, min(height, round((float(zone.get("y", 0)) + float(zone.get("height", 0))) / 100 * height)))
            crop = image[top:bottom, left:right]
            if crop.size == 0:
                continue
            zone_coverage = (crop.shape[0] * crop.shape[1]) / max(1, height * width)
            scale = 1.0 if zone_coverage >= 0.9 else max(1.0, min(3.0, 1600.0 / max(crop.shape[:2])))
            enlarged = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            views.append((enlarged, scale, left, top))
        return views

    def analyze(self, image: np.ndarray, zones: list[dict[str, Any]], minimum_roi_overlap: float) -> list[dict[str, Any]]:
        with self._lock:
            self._load()
            height, width = image.shape[:2]
            plate_zones = _explicit_plate_zones(zones)
            plate_zone_ids = {str(zone.get("id")) for zone in plate_zones}
            crops: list[torch.Tensor] = []
            usable: list[tuple[list[int], float]] = []
            # A configured Number Plate Zone is the detector input, not merely
            # a post-detection filter. This prevents an easier plate elsewhere
            # in the frame from winning and lowers LPR latency substantially.
            views: list[tuple[np.ndarray, float, int, int]] = (
                self._plate_zone_views(image, zones)
                if plate_zones
                else [(image, 1.0, 0, 0)]
            )
            for view, scale, offset_x, offset_y in views:
                raw_boxes, raw_scores = self._detect(view)
                for raw_box, score in zip(raw_boxes, raw_scores):
                    view_height, view_width = view.shape[:2]
                    view_box = [max(0, int(raw_box[0])), max(0, int(raw_box[1])), min(view_width, int(raw_box[2])), min(view_height, int(raw_box[3]))]
                    if view_box[2] <= view_box[0] or view_box[3] <= view_box[1]:
                        continue
                    box = [
                        max(0, offset_x + int(view_box[0] / scale)),
                        max(0, offset_y + int(view_box[1] / scale)),
                        min(width, offset_x + int(view_box[2] / scale)),
                        min(height, offset_y + int(view_box[3] / scale)),
                    ]
                    if box[2] <= box[0] or box[3] <= box[1] or any(_box_iou(box, existing[0]) >= 0.65 for existing in usable):
                        continue
                    # Gate detections before accepting a crop. Otherwise a
                    # clearer plate elsewhere in the full frame prevents the
                    # enlarged plate-zone fallback from ever running.
                    if plate_zones and not any(
                        _overlap_ratio(box, zone, width, height) >= minimum_roi_overlap
                        for zone in plate_zones
                    ):
                        continue
                    crop = view[view_box[1]:view_box[3], view_box[0]:view_box[2], :]
                    if crop.size == 0:
                        continue
                    resized = cv2.resize(crop, (94, 24)).astype("float32")
                    resized = (resized - 127.5) * 0.0078125
                    crops.append(torch.from_numpy(np.transpose(resized, (2, 0, 1))))
                    usable.append((box, float(score)))
                if usable:
                    break
            if not crops:
                return []
            labels = self._decode(self._recognizer, torch.stack(crops, 0))
            results = []
            for index, ((box, score), label) in enumerate(zip(usable, labels)):
                plate = "".join(character for character in str(label).upper() if character.isalnum() or character == "-")
                if len(plate) < 4:
                    continue
                normalized_plate = plate.replace("-", "")
                standard_indian_plate = re.fullmatch(r"[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}", normalized_plate)
                bharat_series_plate = re.fullmatch(r"\d{2}BH\d{4}[A-Z]{1,2}", normalized_plate)
                if not standard_indian_plate and not bharat_series_plate:
                    continue
                zone_ids = [str(zone.get("id")) for zone in zones if _overlap_ratio(box, zone, width, height) >= minimum_roi_overlap]
                # A specifically named Number Plate/LPR zone is an explicit
                # capture boundary, not only a visual overlay. Keep whole-frame
                # behavior when no such zone has been configured.
                if plate_zone_ids and not plate_zone_ids.intersection(zone_ids):
                    continue
                results.append({
                    "id": f"lpr-{plate}-{index}",
                    "trackId": plate,
                    "trackConfirmed": True,
                    "className": "license_plate",
                    "plateText": plate,
                    "confidence": round(score, 4),
                    "box": box,
                    "modelId": "indian_lpr",
                    "task": "detect",
                    "zoneIds": zone_ids,
                })
            return results
