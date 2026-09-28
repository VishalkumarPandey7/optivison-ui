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

Indian LPR is cloned externally from `https://github.com/sanchit2843/Indian_LPR.git` at commit `43b6c37f1773741c7fae81681c4f4158d8be7c34` and stored under `worker/third_party/Indian_LPR`. Setup applies `tools/patches/indian_lpr_compat.patch`, verifies `weights/best_od.pth` and `weights/best_lprnet.pth`, and sets `OPTIVISION_LPR_ROOT` for the worker. That upstream project does not currently publish a conventional licence file; it is not copied into this repository, and its terms must be reviewed before commercial distribution.
