from __future__ import annotations

import os
import sys
from pathlib import Path
from threading import RLock
from typing import Any

import cv2
import numpy as np
import torch


def _overlap_ratio(box: list[int], zone: dict[str, Any], width: int, height: int) -> float:
    left, top, right, bottom = box
    zone_left = float(zone.get("x", 0)) / 100 * width
    zone_top = float(zone.get("y", 0)) / 100 * height
    zone_right = zone_left + float(zone.get("width", 0)) / 100 * width
    zone_bottom = zone_top + float(zone.get("height", 0)) / 100 * height
    intersection = max(0.0, min(right, zone_right) - max(left, zone_left)) * max(0.0, min(bottom, zone_bottom) - max(top, zone_top))
    area = max(1.0, float((right - left) * (bottom - top)))
    return intersection / area


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

    def analyze(self, image: np.ndarray, zones: list[dict[str, Any]], minimum_roi_overlap: float) -> list[dict[str, Any]]:
        with self._lock:
            self._load()
            prepared = self._preprocess(image.copy())
            if torch.cuda.is_available():
                prepared = prepared.cuda()
            with torch.no_grad():
                scores, _classes, boxes = self._detector(prepared)
            raw_boxes = boxes[0].detach().cpu().numpy().tolist()
            raw_scores = scores[0].detach().cpu().numpy().tolist()
            height, width = image.shape[:2]
            crops: list[torch.Tensor] = []
            usable: list[tuple[list[int], float]] = []
            for raw_box, score in zip(raw_boxes, raw_scores):
                box = [max(0, int(raw_box[0])), max(0, int(raw_box[1])), min(width, int(raw_box[2])), min(height, int(raw_box[3]))]
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                crop = image[box[1]:box[3], box[0]:box[2], :]
                if crop.size == 0:
                    continue
                resized = cv2.resize(crop, (94, 24)).astype("float32")
                resized = (resized - 127.5) * 0.0078125
                crops.append(torch.from_numpy(np.transpose(resized, (2, 0, 1))))
                usable.append((box, float(score)))
            if not crops:
                return []
            labels = self._decode(self._recognizer, torch.stack(crops, 0))
            results = []
            for index, ((box, score), label) in enumerate(zip(usable, labels)):
                plate = "".join(character for character in str(label).upper() if character.isalnum() or character == "-")
                if len(plate) < 4:
                    continue
                zone_ids = [str(zone.get("id")) for zone in zones if _overlap_ratio(box, zone, width, height) >= minimum_roi_overlap]
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
