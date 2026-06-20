"""`python -m geosint` — cross-platform one-command launcher.

Creates the .venv if missing, installs the wiki builder, builds the wiki +
search index on first run, then starts the server. Pure stdlib; works the same
on Windows, macOS and Linux. Equivalent to run.ps1 / run.sh.

Pass-through flags: --port, --host, --no-browser, --rebuild-wiki.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # repo root (where server.py lives)
IS_WIN = os.name == "nt"
VENV = ROOT / ".venv"
BIN = VENV / ("Scripts" if IS_WIN else "bin")
PY = BIN / ("python.exe" if IS_WIN else "python")
PIP = BIN / ("pip.exe" if IS_WIN else "pip")
MKDOCS = BIN / ("mkdocs.exe" if IS_WIN else "mkdocs")


def _run(cmd, **kw):
    print("[geosint]", " ".join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


def ensure_venv():
    if not PY.exists():
        print("[geosint] Creating virtual environment (.venv)…")
        _run([sys.executable, "-m", "venv", str(VENV)])
    if not MKDOCS.exists():
        print("[geosint] Installing wiki dependencies (mkdocs-material)…")
        _run([PIP, "install", "--quiet", "-r", str(ROOT / "requirements.txt")])


def ensure_wiki(rebuild=False):
    # Delegate to the single shared pipeline (tools/build_all.py) so `python -m
    # geosint`, run.ps1 and run.sh all build the SAME artifacts (#90). It is
    # idempotent (skips when already built unless --rebuild) and aborts only on a
    # required step (mkdocs / search index); network steps are best-effort.
    cmd = [PY, str(ROOT / "tools" / "build_all.py"), "--python", str(PY), "--mkdocs", str(MKDOCS)]
    if rebuild:
        cmd.append("--rebuild")
    _run(cmd)


def main():
    rebuild = "--rebuild-wiki" in sys.argv
    passthrough = [a for a in sys.argv[1:] if a != "--rebuild-wiki"]
    ensure_venv()
    ensure_wiki(rebuild=rebuild)
    print("[geosint] Starting server…")
    os.chdir(ROOT)
    sys.exit(subprocess.call([str(PY), str(ROOT / "server.py"), *passthrough]))


if __name__ == "__main__":
    main()
