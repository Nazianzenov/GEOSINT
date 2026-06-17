#!/usr/bin/env bash
# GeOSINT Workbench launcher (macOS / Linux peer to run.ps1).
# Creates the venv on first run, builds the wiki if needed, starts the server.
#
# Usage: ./run.sh [--port 8650] [--rebuild-wiki] [--no-browser] [--host 127.0.0.1]
set -euo pipefail

cd "$(dirname "$0")"

PORT=8650
REBUILD=0
NO_BROWSER=""
HOST="127.0.0.1"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --rebuild-wiki) REBUILD=1; shift ;;
    --no-browser) NO_BROWSER="--no-browser"; shift ;;
    --host) HOST="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Pick a python: prefer python3, then python.
PY_BOOT="$(command -v python3 || command -v python || true)"
if [ -z "$PY_BOOT" ]; then
  echo "Python 3.10+ is required. Install it from https://www.python.org/downloads/" >&2
  exit 1
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "[geosint] Creating virtual environment (.venv)..."
  "$PY_BOOT" -m venv .venv
fi
PY=".venv/bin/python"
PIP=".venv/bin/pip"

if [ ! -x ".venv/bin/mkdocs" ]; then
  echo "[geosint] Installing wiki dependencies (mkdocs-material)..."
  "$PIP" install --quiet -r requirements.txt
fi

if [ "$REBUILD" -eq 1 ] || [ ! -f "wiki/site/index.html" ]; then
  echo "[geosint] Refreshing open datasets (cache hit if <30 days old)..."
  "$PY" tools/fetch_datasets.py || true
  "$PY" tools/build_flora.py || true
  echo "[geosint] Building wiki..."
  .venv/bin/mkdocs build -f wiki/mkdocs.yml
  echo "[geosint] Rebuilding search index + knowledge graph..."
  "$PY" tools/build_search_index.py || true
fi
if [ ! -f "app/data/search-index.json" ]; then
  "$PY" tools/build_search_index.py || true
fi

echo "[geosint] Starting server on port $PORT"
exec "$PY" server.py --port "$PORT" --host "$HOST" $NO_BROWSER
