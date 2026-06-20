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

# Single shared build pipeline (tools/build_all.py) — same artifacts on every
# platform as run.ps1 / `python -m geosint` (#90). Idempotent: it skips when the
# wiki is already built unless --rebuild, and aborts only on a required step.
REBUILD_FLAG=""
[ "$REBUILD" -eq 1 ] && REBUILD_FLAG="--rebuild"
"$PY" tools/build_all.py --python "$PY" --mkdocs ".venv/bin/mkdocs" $REBUILD_FLAG

echo "[geosint] Starting server on port $PORT"
exec "$PY" server.py --port "$PORT" --host "$HOST" $NO_BROWSER
