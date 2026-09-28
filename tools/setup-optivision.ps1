$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $projectRoot 'worker'
$venvRoot = Join-Path $workerRoot '.venv'
$workerPython = Join-Path $venvRoot 'Scripts\python.exe'
$lprRoot = Join-Path $workerRoot 'third_party\Indian_LPR'

function Stop-Setup([string]$Message) {
  Write-Host "`nSetup stopped: $Message" -ForegroundColor Red
  exit 1
}

Write-Host 'OptiVision local AI setup' -ForegroundColor Cyan
Write-Host "Project: $projectRoot"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { Stop-Setup 'Node.js/npm is required. Install the current Node.js LTS release, then run setup again.' }

if (-not (Test-Path -LiteralPath $workerPython)) {
  Write-Host 'Creating the Python virtual environment...'
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($py) { & $py.Source -3 -m venv $venvRoot }
  elseif ($python) { & $python.Source -m venv $venvRoot }
  else { Stop-Setup 'Python 3.11 or newer is required.' }
}

if (-not (Test-Path -LiteralPath $workerPython)) { Stop-Setup 'The Python virtual environment could not be created.' }

Write-Host 'Installing pinned AI dependencies. The first installation can take several minutes...'
& $workerPython -m pip install --upgrade pip
& $workerPython -m pip install -r (Join-Path $workerRoot 'requirements.txt')

$lprDetector = Join-Path $lprRoot 'weights\best_od.pth'
$lprRecognizer = Join-Path $lprRoot 'weights\best_lprnet.pth'
if (-not (Test-Path -LiteralPath $lprDetector) -or -not (Test-Path -LiteralPath $lprRecognizer)) {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { Stop-Setup 'Git is required to fetch the Indian LPR model. Install Git for Windows, then retry.' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $lprRoot) -Force | Out-Null
  if (Test-Path -LiteralPath $lprRoot) {
    Stop-Setup "The LPR folder exists but is incomplete: $lprRoot. Rename that folder and run setup again."
  }
  Write-Host 'Fetching the Indian LPR detector/OCR model...'
  & $git.Source clone --depth 1 https://github.com/sanchit2843/Indian_LPR $lprRoot
}

Write-Host 'Downloading the default YOLO detection models...'
$modelRoot = Join-Path $workerRoot 'models'
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
& $workerPython (Join-Path $workerRoot 'download_models.py') --model-dir $modelRoot

Write-Host 'Installing and building the dashboard...'
Push-Location $projectRoot
try {
  & $npm.Source install
  & $npm.Source run build
} finally {
  Pop-Location
}

Write-Host "`nSetup complete. Double-click 'Start OptiVision UI.cmd'." -ForegroundColor Green
