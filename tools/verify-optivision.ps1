$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $projectRoot 'worker'
$workerPython = Join-Path $workerRoot '.venv\Scripts\python.exe'
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npm = if ($npmCommand) { $npmCommand.Source } else { $null }

if (-not $npm) {
  throw 'Node.js/npm is not available. Install Node.js 20 or newer, then run Setup OptiVision.cmd.'
}
if (-not (Test-Path -LiteralPath $workerPython)) {
  throw 'The managed Python environment is missing. Run Setup OptiVision.cmd before verification.'
}

Write-Host '1/4 Checking the frontend production build...'
& $npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

Write-Host '2/4 Running Python worker tests...'
& $workerPython -m unittest discover -s $workerRoot -p 'test_*.py'
if ($LASTEXITCODE -ne 0) { throw 'Python worker tests failed.' }

Write-Host '3/4 Verifying AI package imports...'
& $workerPython -c 'import cv2, supervision, torch, ultralytics; print("AI packages import correctly")'
if ($LASTEXITCODE -ne 0) { throw 'One or more AI packages could not be imported.' }

Write-Host '4/4 Verifying the external Indian LPR dependency...'
$lprRoot = if ($env:OPTIVISION_LPR_ROOT) { $env:OPTIVISION_LPR_ROOT } else { Join-Path $workerRoot 'third_party\Indian_LPR' }
& $workerPython (Join-Path $workerRoot 'verify_lpr.py') --lpr-root $lprRoot
if ($LASTEXITCODE -ne 0) { throw 'Indian LPR verification failed.' }

Write-Host ''
Write-Host 'OptiVision verification passed.' -ForegroundColor Green
