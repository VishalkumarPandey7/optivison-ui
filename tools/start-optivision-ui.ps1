$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '..\..\Opti Vision 2\signal-lab-worker'))
$workerPython = Join-Path $workerRoot '.venv\Scripts\python.exe'
$env:OPTIVISION_RUNTIME_DIR = Join-Path $projectRoot 'runtime'
$env:OPTIVISION_LPR_ROOT = 'C:\Users\visha\OneDrive\Desktop\LPR\Indian_LPR'

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $workerPython)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("OptiVision 2 worker was not found at:`n$workerRoot", 'OptiVision') | Out-Null
  exit 1
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeModules = Join-Path $projectRoot 'node_modules'
$builtIndex = Join-Path $projectRoot 'dist\index.html'

if (-not (Test-Path -LiteralPath $nodeModules)) {
  Start-Process -FilePath $npm -ArgumentList @('install') -WorkingDirectory $projectRoot -Wait -WindowStyle Hidden
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
  Start-Process -FilePath $npm -ArgumentList @('run', 'build') -WorkingDirectory $projectRoot -Wait -WindowStyle Hidden
}

if (-not (Test-Url 'http://127.0.0.1:8770/health')) {
  Start-Process -FilePath $workerPython -ArgumentList 'server.py' -WorkingDirectory $workerRoot -WindowStyle Hidden
}

if (-not (Test-Url 'http://127.0.0.1:4180/')) {
  Start-Process -FilePath $npm -ArgumentList @('run', 'preview', '--', '--host', '127.0.0.1', '--port', '4180') -WorkingDirectory $projectRoot -WindowStyle Hidden
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  if ((Test-Url 'http://127.0.0.1:8770/health') -and (Test-Url 'http://127.0.0.1:4180/')) { break }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Url 'http://127.0.0.1:4180/')) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('OptiVision did not start. Check that Node.js is installed, then try again.', 'OptiVision') | Out-Null
  exit 1
}

Start-Process 'http://127.0.0.1:4180/'
