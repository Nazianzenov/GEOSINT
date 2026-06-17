# Deploying / packaging the GeOSINT Workbench

The server is **pure Python stdlib** — the only dependency (`mkdocs-material`)
builds the wiki and never runs in the serving process. That keeps every install
path simple. Four ways to run it, by audience.

## 1. From source (developers) — every OS
```bash
# Windows
.\run.ps1
# macOS / Linux
./run.sh
# OS-agnostic (creates the venv, builds the wiki, serves)
python -m geosint
```
Flags (all paths): `--port 8650`, `--no-browser`, `--rebuild-wiki`, `--host`.

## 2. Portable executable (analysts, no Python) — built per OS
PyInstaller does **not** cross-compile — build on the target OS:
```bash
pip install -r requirements-build.txt
mkdocs build -f wiki/mkdocs.yml          # bundle a built wiki
python tools/build_search_index.py
pyinstaller --noconfirm --clean geosint.spec
# -> dist/geosint  (dist/geosint.exe on Windows)
```
The executable bundles `app/`, `wiki/site/` and `data/` (resolved from
`sys._MEIPASS` at runtime). The writable `cache/` is created **next to the
executable**, not in the temp extract dir. CI builds all three OSes on tag (see
`.github/workflows/release.yml`).

## 3. Docker (newsrooms / standardized desktops)
```bash
docker build -t geosint .
docker run --rm -p 8650:8650 geosint     # http://localhost:8650/app/
# or pull a released image:
docker run --rm -p 8650:8650 ghcr.io/<owner>/<repo>:latest
```
The container binds `0.0.0.0` **inside** the container (so the published port is
reachable); the Host-header allowlist + `X-GeOSINT` CSRF guard still apply. Only
publish the port to networks you trust. ExifTool is installed in the image;
Google Earth Pro / QGIS are GUI desktop apps and are intentionally absent in a
headless container (the app degrades gracefully).

## 4. Releases
Tag `vX.Y.Z` → CI builds the per-OS executables (with `.sha256` checksums) and
the GHCR image, and attaches them to a GitHub Release. `server.py --version`
prints the version; it's also in `/api/status`.

## Reproducibility notes
- Runtime has **no** pip dependencies (stdlib only) — the serving process is the
  same bytes on every machine with the same Python.
- Build deps are pinned in `requirements-build.txt`; `mkdocs-material` in
  `requirements.txt`.
- The PyInstaller spec sets `upx=False` and `strip=False` so artifacts don't
  depend on an external UPX/strip being present (more reproducible across
  runners).
- The wiki/site and search index are generated; rebuild them before packaging so
  the bundle matches the current `wiki/docs/`.

## Security posture (unchanged across all paths)
Loopback bind by default; `--host 0.0.0.0` is an explicit opt-in for containers.
No telemetry, no required cloud, no AI geolocation. See the README OPSEC section.
