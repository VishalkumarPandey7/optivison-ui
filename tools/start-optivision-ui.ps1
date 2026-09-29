$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $projectRoot 'worker'
$workerPython = Join-Path $workerRoot '.venv\Scripts\python.exe'
$env:OPTIVISION_RUNTIME_DIR = Join-Path $projectRoot 'runtime'
if (-not $env:OPTIVISION_LPR_ROOT) {
  $env:OPTIVISION_LPR_ROOT = Join-Path $workerRoot 'third_party\Indian_LPR'
}
$lprDetector = Join-Path $env:OPTIVISION_LPR_ROOT 'weights\best_od.pth'
$lprRecognizer = Join-Path $env:OPTIVISION_LPR_ROOT 'weights\best_lprnet.pth'

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-WorkerHealth {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8770/health' -TimeoutSec 2
    return $health.ok -eq $true -and $health.service -eq 'optivision-signal-rule-lab'
  } catch {
    return $false
  }
}

function Invoke-HiddenNpm([string[]]$Arguments, [string]$FailureMessage) {
  $process = Start-Process -FilePath $npm -ArgumentList $Arguments -WorkingDirectory $projectRoot -Wait -WindowStyle Hidden -PassThru
  if ($process.ExitCode -ne 0) { throw $FailureMessage }
}

if (-not (Test-Path -LiteralPath $workerPython) -or -not (Test-Path -LiteralPath $lprDetector) -or -not (Test-Path -LiteralPath $lprRecognizer)) {
  Write-Host 'First run detected. Installing the local AI engine...' -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot 'setup-optivision.ps1')
  $lprDetector = Join-Path $env:OPTIVISION_LPR_ROOT 'weights\best_od.pth'
  $lprRecognizer = Join-Path $env:OPTIVISION_LPR_ROOT 'weights\best_lprnet.pth'
}

if (-not (Test-Path -LiteralPath $workerPython)) { throw 'The local AI engine is not installed. Run Setup OptiVision.cmd.' }
if (-not (Test-Path -LiteralPath $lprDetector) -or -not (Test-Path -LiteralPath $lprRecognizer)) { throw "Indian_LPR is not ready at $env:OPTIVISION_LPR_ROOT. Run Setup OptiVision.cmd." }

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeModules = Join-Path $projectRoot 'node_modules'
$builtIndex = Join-Path $projectRoot 'dist\index.html'

if (-not (Test-Path -LiteralPath $nodeModules)) {
  $installCommand = if (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json')) { 'ci' } else { 'install' }
  Invoke-HiddenNpm @($installCommand) 'Frontend dependency installation failed. Run Setup OptiVision.cmd to see the complete error.'
}

$buildRequired = -not (Test-Path -LiteralPath $builtIndex)
if (-not $buildRequired) {
  $builtAt = (Get-Item -LiteralPath $builtIndex).LastWriteTimeUtc
  $latestSource = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -File -Recurse |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  $packageFile = Get-Item -LiteralPath (Join-Path $projectRoot 'package.json')
  $buildRequired = ($latestSource -and $latestSource.LastWriteTimeUtc -gt $builtAt) -or $packageFile.LastWriteTimeUtc -gt $builtAt
}

if ($buildRequired) {
  Invoke-HiddenNpm @('run', 'build') 'Frontend build failed. Run Verify OptiVision.cmd to see the complete error.'
}

if (-not (Test-WorkerHealth)) {
  # Use the worker-relative model path so Start-Process does not split an
  # absolute project path containing spaces into separate arguments.
  Start-Process -FilePath $workerPython -ArgumentList @('server.py', '--model-dir', 'models') -WorkingDirectory $workerRoot -WindowStyle Hidden
}

if (-not (Test-Url 'http://127.0.0.1:4180/')) {
  Start-Process -FilePath $npm -ArgumentList @('run', 'preview', '--', '--host', '127.0.0.1', '--port', '4180') -WorkingDirectory $projectRoot -WindowStyle Hidden
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  if ((Test-WorkerHealth) -and (Test-Url 'http://127.0.0.1:4180/')) { break }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-WorkerHealth) -or -not (Test-Url 'http://127.0.0.1:4180/')) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('OptiVision did not start completely. Run Verify OptiVision.cmd to identify the missing dependency or port conflict.', 'OptiVision') | Out-Null
  exit 1
}

Start-Process 'http://127.0.0.1:4180/'
