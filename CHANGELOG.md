# Changelog

All notable changes to the GeOSINT Workbench. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the project uses semantic-ish
versioning (`server.py --version`, surfaced in `/api/status`).

## [Unreleased]

### Added — Phase 6 (Reach: run everywhere, install in one step)
- **Cross-platform tool detection (6.1):** ExifTool, Google Earth Pro, QGIS and
  Sherloq are now detected on Windows, macOS and Linux (PATH + per-OS install
  locations; `.app` bundles on macOS). Install hints are OS-specific.
- **Cross-platform launchers (6.2):** a single `_launch_app` / `_open_document_with`
  layer opens tools correctly per OS (`cmd /c` for Windows `.bat`, `open -a` for
  macOS `.app`, direct exec elsewhere) — no shell, argv-only.
- **One-command bootstrap (6.3):** `run.sh` (macOS/Linux peer to `run.ps1`) and
  `python -m geosint` to create the venv, build the wiki and serve.
- **Versioning (6.6):** `server.py --version`; `version` + `platform` in
  `/api/status`; this CHANGELOG.
- **Portable build (6.4):** PyInstaller spec (`geosint.spec`) bundling the app,
  wiki and data into a single executable (per-OS; build on the target OS).
- **Docker (6.5):** `Dockerfile` + `.dockerignore` for a self-contained,
  loopback-by-default image (`--host 0.0.0.0` opt-in for containers).
- **CI / reproducibility (6.7):** GitHub Actions workflow building per-OS
  artifacts on tag; pinned build deps; reproducible-build notes.

### Added — Phase 7 (Flow), shipped earlier this cycle
- 7.1 Docked Wiki Search; 7.2 autosave / crash recovery; 7.3 recent cases;
  7.4 command palette (Ctrl+K); 7.5 shortcut badges; 7.6 responsive layout;
  7.7 consistent empty/disabled states; 7.8 first-run welcome + sample case.

### Security (Phase 6 post-audit fixes)
- **DNS-rebinding guard hardened (H1):** `host_ok` now matches on the Host
  *hostname* (port stripped), not the host:port string. A rebound attacker
  domain is rejected in every bind mode; loopback works on any port (fixes
  Docker `-p 8665:8650` port-mapping). New `--allow-host` for trusted
  IP/hostname access when bound off-loopback.
- **Container hardening (H2):** the Docker image runs as a non-root user
  (`geosint`, uid 10001); docs default to `-p 127.0.0.1:8650:8650`.
- **Supply chain (M2):** `mkdocs-material` pinned to a compatible range; CI runs
  `pip-audit` on the build toolchain.

### Fixed
- Escape ExifTool error output before render (XSS); unpredictable temp file for
  the GE Pro fly-to KML; `/api/qgis` validates payload before probing for QGIS.

## [1.0.0]
- Phases 0–5 (see `ROADMAP.md`): map workspace, sun/shadow chronolocation,
  weather, image intelligence, ~35-tool launcher, sourced field wiki, case files
  with chain-of-custody, datasets and infrastructure layers.
