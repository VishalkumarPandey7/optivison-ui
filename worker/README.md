# OptiVision AI Worker

This folder contains the Python inference service required by the dashboard. It is intentionally source-controlled without a virtual environment, runtime data, uploaded training data, or model binaries.

Run `Setup OptiVision.cmd` from the repository root to create `.venv`, install the pinned dependencies, fetch the Indian LPR dependency, download the default YOLO weights, and build the dashboard.

The worker exposes:

- `GET /health` — service, dependency, pipeline, and model status.
- `GET /models` — available Ultralytics/custom/LPR models.
- `POST /analyze` — per-camera detection, tracking, ROI, signal, rule, and conveyor analysis.
- `/training/*` — local customer-model training workflow.
- `/alerts` and `/workspace` — local runtime configuration/state.

Default address: `http://127.0.0.1:8770`.

Indian LPR is fetched from `https://github.com/sanchit2843/Indian_LPR` during setup and stored under `worker/third_party/Indian_LPR`. That upstream project does not currently publish a conventional licence file; review redistribution terms before packaging it commercially.
