$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $projectRoot 'worker'
$venvRoot = Join-Path $workerRoot '.venv'
$workerPython = Join-Path $venvRoot 'Scripts\python.exe'
$lprRoot = Join-Path $workerRoot 'third_party\Indian_LPR'
$lprRepository = 'https://github.com/sanchit2843/Indian_LPR.git'
$lprCommit = '43b6c37f1773741c7fae81681c4f4158d8be7c34'
$lprPatch = Join-Path $PSScriptRoot 'patches\indian_lpr_compat.patch'

function Stop-Setup([string]$Message) {
  Write-Host "`nSetup stopped: $Message" -ForegroundColor Red
  exit 1
}

function Invoke-External([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { Stop-Setup $FailureMessage }
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
Invoke-External $workerPython @('-m', 'pip', 'install', '--upgrade', 'pip') 'Python package installer upgrade failed.'
Invoke-External $workerPython @('-m', 'pip', 'install', '-r', (Join-Path $workerRoot 'requirements.txt')) 'AI dependency installation failed.'

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { Stop-Setup 'Git is required to fetch the external Indian_LPR dependency. Install Git for Windows, then retry.' }
if (-not (Test-Path -LiteralPath $lprPatch)) { Stop-Setup "The required LPR compatibility patch is missing: $lprPatch" }

New-Item -ItemType Directory -Path (Split-Path -Parent $lprRoot) -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $lprRoot '.git'))) {
  if (Test-Path -LiteralPath $lprRoot) {
    Stop-Setup "The external LPR destination exists but is not a Git checkout: $lprRoot. Move it aside and run setup again."
  }
  Write-Host 'Cloning the external Indian_LPR dependency...'
  Invoke-External $git.Source @('clone', $lprRepository, $lprRoot) 'Could not clone the external Indian_LPR repository.'
}

$currentLprCommit = [string](& $git.Source -C $lprRoot rev-parse HEAD 2>$null)
$currentLprCommit = $currentLprCommit.Trim()
if ($LASTEXITCODE -ne 0) { $currentLprCommit = '' }
if ($currentLprCommit -ne $lprCommit) {
  $lprChanges = @(& $git.Source -C $lprRoot status --porcelain)
  if ($LASTEXITCODE -ne 0) { Stop-Setup "The external LPR checkout is not readable: $lprRoot" }
  if ($lprChanges.Count -gt 0) {
    Stop-Setup "The external LPR checkout has local changes at a different commit. It was not overwritten. Move it aside and rerun setup: $lprRoot"
  }
  Write-Host "Fetching pinned Indian_LPR commit $lprCommit..."
  Invoke-External $git.Source @('-C', $lprRoot, 'fetch', '--depth', '1', 'origin', $lprCommit) 'Could not fetch the required Indian_LPR commit.'
  Invoke-External $git.Source @('-C', $lprRoot, 'checkout', '--detach', $lprCommit) 'Could not check out the required Indian_LPR commit.'
}

& $git.Source -C $lprRoot apply --unidiff-zero --check $lprPatch 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Applying OptiVision compatibility changes to the external LPR checkout...'
  Invoke-External $git.Source @('-C', $lprRoot, 'apply', '--unidiff-zero', $lprPatch) 'The Indian_LPR compatibility patch could not be applied.'
} else {
  & $git.Source -C $lprRoot apply --unidiff-zero --reverse --check $lprPatch 2>$null
  if ($LASTEXITCODE -ne 0) {
    Stop-Setup "The external LPR checkout does not match the supported commit or compatibility state. No files were overwritten: $lprRoot"
  }
  Write-Host 'Indian_LPR compatibility changes are already applied.'
}

$lprDetector = Join-Path $lprRoot 'weights\best_od.pth'
$lprRecognizer = Join-Path $lprRoot 'weights\best_lprnet.pth'
$missingWeights = @()
if (-not (Test-Path -LiteralPath $lprDetector) -or (Get-Item -LiteralPath $lprDetector -ErrorAction SilentlyContinue).Length -lt 1000000) { $missingWeights += $lprDetector }
if (-not (Test-Path -LiteralPath $lprRecognizer) -or (Get-Item -LiteralPath $lprRecognizer -ErrorAction SilentlyContinue).Length -lt 1000000) { $missingWeights += $lprRecognizer }
if ($missingWeights.Count -gt 0) {
  Stop-Setup "The pinned upstream checkout did not provide valid LPR weights. Required files:`n$($missingWeights -join "`n")`nObtain the original best_od.pth and best_lprnet.pth files from the Indian_LPR project owner and place them at those exact paths."
}

$env:OPTIVISION_LPR_ROOT = $lprRoot
Write-Host "Verifying Indian_LPR detector and OCR from $env:OPTIVISION_LPR_ROOT..."
Invoke-External $workerPython @((Join-Path $workerRoot 'verify_lpr.py'), '--lpr-root', $lprRoot) 'Indian_LPR verification failed. Review the output above; setup did not remove the checkout or weights.'

Write-Host 'Downloading the default YOLO detection models...'
$modelRoot = Join-Path $workerRoot 'models'
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
Invoke-External $workerPython @((Join-Path $workerRoot 'download_models.py'), '--model-dir', $modelRoot) 'Default YOLO model download failed.'

Write-Host 'Installing and building the dashboard...'
Push-Location $projectRoot
try {
  if (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json')) {
    Invoke-External $npm.Source @('ci') 'Pinned frontend dependency installation failed.'
  } else {
    Invoke-External $npm.Source @('install') 'Frontend dependency installation failed.'
  }
  Invoke-External $npm.Source @('run', 'build') 'Frontend production build failed.'
} finally {
  Pop-Location
}

Write-Host "`nSetup complete. Double-click 'Start OptiVision UI.cmd'." -ForegroundColor Green
