# GeOSINT Workbench launcher.
# Creates the venv on first run, builds the wiki if needed, starts the server.
param(
    [int]$Port = 8650,
    [switch]$RebuildWiki
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "[geosint] Creating virtual environment (.venv)..." -ForegroundColor Cyan
    python -m venv .venv
    if (-not $?) { Write-Host "Python 3.10+ is required. Install from https://www.python.org/downloads/" -ForegroundColor Red; exit 1 }
}

$pip = ".venv\Scripts\pip.exe"
$py  = ".venv\Scripts\python.exe"

if (-not (Test-Path ".venv\Scripts\mkdocs.exe")) {
    Write-Host "[geosint] Installing wiki dependencies (mkdocs-material)..." -ForegroundColor Cyan
    & $pip install --quiet -r requirements.txt
}

# Single shared build pipeline (tools\build_all.py) — same artifacts on every
# platform as run.sh / `python -m geosint` (#90). Idempotent: it skips when the
# wiki is already built unless --rebuild, and aborts only on a required step.
$rebuildArg = if ($RebuildWiki) { "--rebuild" } else { $null }
& $py tools\build_all.py --python $py --mkdocs ".venv\Scripts\mkdocs.exe" $rebuildArg
if ($LASTEXITCODE) { exit $LASTEXITCODE }   # a required step failed: stop, like run.sh / python -m geosint

Write-Host "[geosint] Starting server on port $Port" -ForegroundColor Green
& $py server.py --port $Port
