<!-- Thanks for contributing! Keep PRs focused. -->

**What & why**
What this changes and the use case it serves.

**Checklist**
- [ ] Tests pass: `python -m pytest tests/ -q`
- [ ] No new runtime pip dependency (the server stays pure stdlib; build-time deps go in `requirements-build.txt`)
- [ ] Cross-platform: no Windows-only assumptions in detection/launch
- [ ] Attacker-influenceable strings (EXIF, OSM tags, geocoder, pasted findings, case files) are `esc()`-escaped before reaching the DOM or a dossier
- [ ] Case-format changes bump `CASE_VERSION` and handle back-compat in `applyCase` (see docs/CASE-FORMAT.md)
- [ ] Knowledge-base content is sourced (every claim referenced; see CONTRIBUTING.md)
- [ ] Stays within the doctrine: local-first, no telemetry, no required cloud, no AI geolocation

**Verification**
How you tested it (manual steps, screenshots, or a Playwright/pytest run).
