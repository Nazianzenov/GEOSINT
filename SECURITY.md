# Security Policy

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue for them.**

Use GitHub's **[Private vulnerability reporting](https://github.com/Nazianzenov/GEOSINT/security/advisories/new)**
("Report a vulnerability" under the repo's *Security* tab). If that's unavailable,
open a minimal public issue asking for a private contact channel — without
details — and the maintainer will follow up.

Please include: affected version (`server.py --version` / the `/api/status`
`version`), OS, repro steps, and the impact you observed. A proof-of-concept
helps. We aim to acknowledge within a few days (best-effort, single maintainer).

Coordinated disclosure is appreciated: give us a reasonable window to fix before
publishing. We'll credit reporters who want it.

## Threat model (what "secure" means here)

GeOSINT is a **local, single-user** workbench. The server binds `127.0.0.1` by
default and is meant to be reached only from the same machine. Its POST endpoints
can **launch local desktop programs and write local files**, so the security
design centers on stopping a *remote web page or other origin* from reaching
those endpoints through the user's browser:

- **Loopback bind** — not exposed to the network unless you explicitly pass a
  non-loopback `--host` (which warns, and is intended only for containers behind
  your own access controls).
- **DNS-rebinding guard** — the `Host` header is validated against an allowed-host
  set (hostname-based), rejecting rebound attacker domains.
- **CSRF guard** — every state-changing POST requires the custom `X-GeOSINT`
  header, which forces a CORS preflight that the server never answers, so a
  drive-by cross-origin page cannot invoke the launch/write endpoints.
- **SSRF guards** — the `/api/pget`, `/tiles` and `/api/overpass` proxies use a
  host allowlist and refuse to follow redirects, with a response-size cap.
- **No shell** — all subprocess launches are argv-lists (no `shell=True`);
  attacker-controlled strings (EXIF, OSM tags, pasted findings) are escaped before
  reaching the DOM or a dossier.
- **Native parser hygiene** — the `/api/exif*` endpoints run **ExifTool** over
  untrusted image/video bytes, and ExifTool has had parser CVEs. Keep ExifTool
  patched: rebuild the Docker image periodically (its `Dockerfile` documents this)
  or keep your locally installed ExifTool up to date.

### In scope
- Bypasses of the loopback / Host / CSRF / SSRF guards above.
- Injection (command/path/SSRF/XSS) reachable from image input, OSM/Overpass
  responses, pasted findings, case files, or the proxies.
- Redaction bypasses in the **redacted dossier** export (it must not leak exact
  coordinates, source URLs/filenames, notes, or full hashes).
- Path traversal in static serving or any file write; insecure temp-file handling.

### Out of scope
- Attacks requiring an already-compromised local account or physical access (the
  tool trusts the local user).
- Findings that depend on the user intentionally binding to a public interface
  and exposing the port to an untrusted network (you're warned not to).
- Third-party services the user opts into (external tool sites, AI geolocators —
  which are flagged as uploading) or vulnerabilities in vendored upstreams (report
  those upstream; we'll bump the vendored copy).
- The build-time `mkdocs-material` toolchain (not part of the running server).

## Supported versions

This is an actively developed single-maintainer project; fixes land on `main`.
There is no long-term-support branch — run a recent build.
