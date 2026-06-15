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

if ($RebuildWiki -or -not (Test-Path "wiki\site\index.html")) {
    Write-Host "[geosint] Refreshing open datasets (cache hit if <30 days old)..." -ForegroundColor Cyan
    & $py tools\fetch_datasets.py
    & $py tools\build_flora.py
    Write-Host "[geosint] Refreshing Wikimedia image cache (re-fetches only entries >30 days old)..." -ForegroundColor Cyan
    & $py tools\cache_wikimedia.py
    Write-Host "[geosint] Localizing GeoHints gallery images (one-off; skips already-cached, no auto-refresh)..." -ForegroundColor Cyan
    & $py tools\cache_geohints.py
    Write-Host "[geosint] Building wiki..." -ForegroundColor Cyan
    & ".venv\Scripts\mkdocs.exe" build -f wiki\mkdocs.yml
    Write-Host "[geosint] Rebuilding search index + knowledge graph..." -ForegroundColor Cyan
    & $py tools\build_search_index.py
}
if (-not (Test-Path "app\data\search-index.json")) {
    & $py tools\build_search_index.py
}

Write-Host "[geosint] Starting server on port $Port" -ForegroundColor Green
& $py server.py --port $Port
