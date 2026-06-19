# Changelog

All notable changes to the GeOSINT Workbench. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the project uses semantic-ish
versioning (`server.py --version`, surfaced in `/api/status`).

## [Unreleased]

### Production-readiness pass (security, data integrity, resilience, hygiene)

A staff-level review cycle to bring the workbench to production quality,
sequenced as Phase A (production blockers), B (resilience), C (elegance). The
items below have shipped; remaining Phase C refactors (de-dup/split `app.js`,
route table, cache-state UX) are tracked as open issues.

#### Security & data integrity
- **Dossier no longer beacons (#25):** the dossier/redacted-dossier embeds an
  evidence thumbnail only when it's a local `data:` image. A tampered/shared
  `.geosint.json` could otherwise point `thumb` at an `http(s)` URL, making the
  "self-contained, nothing leaves your machine" export call out to a remote host
  on open (analyst deanonymization). New `dataThumb()` guard at both sinks.
- **Case files are validated on load (#26):** `applyCase` now runs every section
  of an untrusted case file through `sanitizeCase` — coordinates range-checked
  (lat/lng/zoom), malformed annotations/measure/gbif entries dropped and counted,
  `null`/`""` no longer coerced to a bogus `0,0`. A bad file is rejected cleanly
  (with a "skipped N…" message) instead of half-applying and leaving `NaN` state.
- **Redacted dossier closes a sourcing leak (#35):** image-artifact filenames are
  now genericized to "image evidence" in the publication-safe export (previously
  only URLs were). One shared `redLabel()` rule drives the artifact, relationship
  and timeline blocks so they can't drift apart again.

#### Resilience & observability
- **Server-side failure logging (#28):** the tile/pget/overpass proxies and the
  ExifTool handlers now log upstream/tool failures (`[geosint] WARN <endpoint>
  <host> <Error>: …`), so a degraded run is visible to the operator instead of
  looking like a silent app bug. OPSEC: only the upstream host is logged, never
  the full URL (pget/overpass URLs embed coordinates).
- **Bounded, resumable tile prefetch (#29):** `/api/prefetch` is capped to a
  wall-clock budget so it can't hold a server thread for minutes; it reports
  `remaining`/`done` and the client auto-resumes (cached tiles are skipped), with
  live progress, instead of an unbounded request behind an endless spinner.
- **Client fetch timeouts (#30):** all frontend API calls go through a `fetchT`
  wrapper with an `AbortController` timeout (30 s data / 120 s exif uploads /
  35 s per prefetch round). A stall now yields a definite, retryable error in the
  module's status area instead of an infinite spinner. The wrapper composes a
  caller's cancel signal (the OSM CANCEL button still works) and raises a distinct
  `TimeoutError` so a timeout isn't mistaken for a user cancel.

#### Testing, tooling & hygiene
- **Browser-driven JS tests (#27):** first automated coverage of the frontend's
  security-relevant logic — `esc`, `parseCoords`, the dossier escaping invariant,
  redaction safety, thumbnail guarding, and the case round-trip — via Playwright
  driving the real `/app/` page (new `js-tests` CI job). The server suite grew
  alongside it.
- **ESLint lint gate (#39):** `app/js` is now linted in CI (`npm run lint`).
  Node is **dev/CI tooling only** — the workbench still runs with no Node.
- **Named server caps (#32):** the 200 MB EXIF cap (previously a literal in three
  places that could silently diverge), the JSON cap and the ExifTool timeout are
  now single module constants.
- **CI/governance:** `main` is branch-protected (all checks required, linear
  history, no force-push); the unit/`js-tests`/`lint` jobs run per push/PR.

#### Modularization — front-end structure
- **Shared JS extracted (#24):** `esc` (triplicated) and ~10 near-identical
  helpers (`cachedFetch`, `parseCoords`, `fmtDD`/`toDMS`/`fmtDMS`, `compassAz`,
  `cardinal`, `project`, `drawSunChart`, …) moved into one `app/js/common.js`,
  ending the drift between `app.js`, `sun.js` and `search.js`. The dossier
  stylesheet became a `DOSSIER_CSS` constant.
- **`app.js` split into modules (#31):** the 3,142-line monolith was broken into
  cohesive, dependency-ordered files — `core.js` (state + search + panel),
  `map.js`, `modules/{sun,weather,image,tools,data,anno}.js`, `case.js` (evidence
  log / dossier / case file) and `palette.js` — leaving `app.js` a 109-line
  bootstrap. Behaviour-neutral (classic `<script>`s, shared global scope, no
  bundler); each file is now a targetable home for tests and future changes.
- **`dossier.js` extracted from `case.js`:** the self-contained dossier export
  (`DOSSIER_CSS` + `buildDossier` + `exportDossier`) moved to its own file, so
  `case.js` is now purely the evidence-log / chain-of-custody / case-file engine.

#### Audit follow-ups (data integrity, a11y)
- **Atomic cache writes:** the threaded server's cache writes (`/tiles`,
  `/api/prefetch`, `/api/pget`, `/api/overpass`, `/api/qgis`) now go through one
  `atomic_write()` helper (temp file + `os.replace`) — a concurrent reader can no
  longer observe a half-written cache file and serve/cache a truncated response.
  Also removes the duplicated `mkdir + write_bytes` pattern from the five sites.
- **Image alt text:** the timeline evidence thumbnail and the wiki search-result
  card image now carry `alt` attributes (screen-reader accessibility).

### Security & correctness — re-audit cycle (api / ux / pen-tester batches)

Hardening and fixes from a full multi-agent audit re-run (predates the
production-readiness pass; batches 1–5 + follow-ups).

- **Proxy/parse correctness (batch 1):** `/tiles` strict-integer `z/x/y` parse
  (negative coords were silently accepted) + in-range-for-zoom check;
  `/api/overpass` requires a real `\bout\b` statement (so "timeout"/"output" no
  longer bypass the guard); exif endpoints validate input (400/413) before
  probing for the tool; OSM POI loading gained a cancel (`AbortController`) and no
  longer leaks its progress-tick interval on concurrent runs.
- **HTTP & security-header hygiene (batch 2):** CSP + `X-Frame-Options` +
  `Referrer-Policy` on HTML; `X-Content-Type-Options: nosniff` and explicit
  `Cache-Control` on proxied bodies; correct `405 + Allow` (vs a misleading 404)
  for known paths hit with the wrong verb; `/api/pget` with no `u` returns 400;
  the static 404 no longer echoes the caller-supplied path.
- **Accessibility (batch 3):** global `:focus-visible` ring; skip-link;
  `aria-label`s on the 17 unlabeled inputs/selects; the side panel is a named
  `region`; Welcome/Help overlays are proper modal dialogs with focus management;
  live-region coordinate readout. Map-scale fix.
- **End-to-end API test suite (batch 4):** the offline-runnable `tests/test_api.py`
  asserting routing, the Host/CSRF guards, allowlists, validation and headers
  (incl. the negative-zoom and `out`-substring regressions).
- **Sun Studio ↔ case integration (batch 5 + follow-ups):** the shadow solver
  reports confidence (high/moderate/low); findings round-trip into the case;
  the Studio handoff via `localStorage` is validated/range-checked on ingest; the
  503 "wiki not built" page carries the same security headers.

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
