"""Download the standard OptiVision Ultralytics models into the local model folder."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO


DEFAULT_MODELS = ("yolo11n.pt", "yolo11n-pose.pt", "yolov8n.pt", "yolo26n.pt")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).expanduser().resolve()
    model_dir.mkdir(parents=True, exist_ok=True)

    for model_name in DEFAULT_MODELS:
        target = model_dir / model_name
        if target.exists():
            print(f"Ready: {target.name}")
            continue

        print(f"Downloading: {model_name}")
        model = YOLO(model_name)
        source = Path(getattr(model, "ckpt_path", model_name)).expanduser().resolve()
        if not source.exists():
            source = Path(model_name).resolve()
        if not source.exists():
            raise FileNotFoundError(f"Ultralytics did not create {model_name}")
        shutil.copy2(source, target)
        print(f"Ready: {target.name}")


if __name__ == "__main__":
    main()
