# OptiVision — Local Vision Intelligence Platform

OptiVision is a Windows-first local computer-vision dashboard for worker monitoring, machine monitoring, conveyor counting, customer-model training, and Indian number-plate lifecycle tracking.

The orange-and-white React dashboard runs at `http://127.0.0.1:4180`. Detection is performed locally by the OptiVision 2 Python worker at `http://127.0.0.1:8770`; camera frames are not sent to a cloud service.

## Main capabilities

- Up to 7 independently configured cameras.
- Browser/USB camera, uploaded video, HTTP/HLS stream, RTSP/ONVIF/NVR bridge inputs.
- Ultralytics YOLO detection and pose models.
- Supervision detection normalization, ByteTrack tracking, ROI membership, and conveyor LineZone support.
- Per-camera models, ROIs, signals, rules, confidence, display settings, and Start/Pause state.
- 20 built-in signal templates and 20 rule templates, plus manual reusable templates.
- Worker presence, absence, working/idle time, restricted entry, phone proximity, machine activity, and class-independent conveyor counting.
- Local custom-model workflow: upload, annotate, choose epochs, train, review, activate, and delete.
- Indian LPR lifecycle tracking with saved plate crops, independent simultaneous vehicle journeys, station timing, worker timing, plate correction, manual completion, and record deletion.

## Required local folders

Keep the UI and worker in this layout (the names can differ only if you also update `tools/start-optivision-ui.ps1`):

```text
ChatGPT/
├─ Opti Vision/
│  └─ optivision-ui-flow/       <- this repository
└─ Opti Vision 2/
   └─ signal-lab-worker/        <- Python detection worker
```

The LPR model currently expects:

```text
C:\Users\visha\OneDrive\Desktop\LPR\Indian_LPR
```

That folder must contain `weights/best_od.pth` and `weights/best_lprnet.pth`. To use another location, change `$env:OPTIVISION_LPR_ROOT` in `tools/start-optivision-ui.ps1`.

## Prerequisites

Install these once:

1. Node.js with npm.
2. Python and the prepared OptiVision 2 worker virtual environment.
3. The Indian LPR files above when number-plate recognition is required.

## Easiest way to start

Double-click **`Start OptiVision UI.cmd`**.

The launcher automatically:

1. Installs frontend packages when required.
2. Builds the latest dashboard when required.
3. Starts the Python detection worker in the background.
4. Starts the dashboard in the background.
5. Opens `http://127.0.0.1:4180` in the browser.

No PowerShell command is required for normal operation. Keep the launcher folder and the OptiVision 2 worker folder in the layout shown above.

## Manual developer startup

Start the worker:

```powershell
cd "C:\Users\visha\OneDrive\Dokumen\ChatGPT\Opti Vision 2\signal-lab-worker"
$env:OPTIVISION_RUNTIME_DIR = "C:\Users\visha\OneDrive\Dokumen\ChatGPT\Opti Vision\optivision-ui-flow\runtime"
$env:OPTIVISION_LPR_ROOT = "C:\Users\visha\OneDrive\Desktop\LPR\Indian_LPR"
.\.venv\Scripts\python.exe server.py
```

In another terminal, start the UI:

```powershell
cd "C:\Users\visha\OneDrive\Dokumen\ChatGPT\Opti Vision\optivision-ui-flow"
npm install
npm run dev -- --host 127.0.0.1 --port 4180
```

Open `http://127.0.0.1:4180`.

## Configure and operate a camera

1. Open **Cameras** and select or add a camera.
2. Select the input source and connect/upload the feed.
3. Select the required models. Use **Indian Number Plate Detection + OCR** for LPR.
4. Draw any required ROI directly over the live/video feed. Drawing activates that ROI.
5. Add signal and rule templates, or create camera-specific definitions manually.
6. Save the camera configuration.
7. Open **User monitoring** and click **Start engine** for that camera.
8. Use **Pause engine** to stop analysis for only that camera.

Uploaded videos play through their complete duration and then loop for repeat testing. Raw `rtsp://` URLs cannot play directly in a browser; use an HLS, WebRTC, or HTTP bridge supplied by the camera gateway/NVR.

## Test the LPR lifecycle correctly

1. Open **Lifecycle Management → Station Mapping**.
2. Assign one mapped camera as the **Start Station** and one as the **End Station**. Intermediate mapped cameras represent processing stations.
3. Use **Whole camera frame** or select a plate ROI for each station.
4. Click **Save & Start Mapped Cameras**.
5. When the entry camera identifies a valid plate, its lifecycle starts automatically—there is no separate lifecycle Start button.
6. Every different plate creates a separate active journey, including vehicles detected at the same entry station.
7. When the same plate is identified at the next mapped camera, only that vehicle advances to the next station.
8. Detection at the mapped end camera completes the journey automatically.
9. Open **Lifecycle Tracking** to inspect station time, waiting time, worker time, captured events, and the stored plate crop.

For a controlled three-camera test, use three clips of the same vehicle: entry, processing, and exit. Start them in that order. Do not start the same full video simultaneously on every camera because every station would observe the vehicle at nearly the same time.

Before repeating a test, delete old incorrect test records from **Lifecycle Tracking**. Plate numbers can also be corrected manually when OCR is imperfect.

## Conveyor-counting test

1. Configure a camera and choose the conveyor use case.
2. Draw a **Counting Zone** over the conveyor.
3. Draw an optional direction line when directional counts are needed.
4. Add the conveyor-counting signal/rule.
5. Start that camera engine and pass objects completely through the line/zone.

Supervision tracking maintains object IDs; class-independent foreground motion allows counting objects that do not have a YOLO class.

## Customer-model training

1. Open **Model training** and create a project.
2. Define the required classes.
3. Upload customer images.
4. Draw and review every annotation.
5. Select epochs and image size, then start training.
6. Review the resulting metrics before activating a candidate.

Four reviewed images can test the workflow, but they are not sufficient for reliable production accuracy. Use at least 20–50 varied and correctly labelled images for an experiment, and substantially more for production validation.

## Local data and privacy

- Camera configuration and lifecycle journeys are stored in browser local storage.
- Runtime state and training artifacts are stored locally by the worker.
- `runtime/`, uploaded temporary files, trained weights, `node_modules/`, and production builds are intentionally excluded from Git.
- Clearing browser site data removes browser-stored configuration and journey history.

## Troubleshooting

- **Site cannot be reached:** double-click `Start OptiVision UI.cmd` again and wait for the browser to open.
- **Signal worker offline:** confirm the OptiVision 2 folder layout and `.venv/Scripts/python.exe`.
- **LPR model unavailable:** check both weight files and `OPTIVISION_LPR_ROOT`.
- **Plate detected but no lifecycle:** confirm that camera is mapped as the Start Station and its engine is running.
- **Old UI still visible:** press `Ctrl + F5`.
- **RTSP feed is blank:** use an HLS/WebRTC/HTTP bridge rather than the raw RTSP URL.

## Verified

- TypeScript production build passes.
- Dashboard: `http://127.0.0.1:4180`.
- Worker health: `http://127.0.0.1:8770/health`.
- The dashboard and Indian LPR model were verified online before this update.
