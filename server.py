"""GeOSINT Workbench — local server.

Pure Python stdlib (no pip dependencies). Serves:
  /app/   -> the workbench single-page app
  /wiki/  -> the built MkDocs Material wiki (wiki/site)
  /api/*  -> local API: tool detection/launch, ExifTool deep dump, GE Pro fly-to

Run:  python server.py [--port 8650] [--no-browser]
"""

import argparse
import glob
import hashlib
import math
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

# ROOT = read-only bundled assets (app/, wiki/site/, data/). When frozen by
# PyInstaller these live in the extracted bundle dir (sys._MEIPASS); otherwise
# next to this file. DATA_ROOT = writable runtime dir (cache/): next to the
# executable when frozen (the bundle dir is wiped on exit), else the repo root.
if getattr(sys, "frozen", False):
    ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    DATA_ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
    DATA_ROOT = ROOT
APP_DIR = ROOT / "app"
WIKI_SITE = ROOT / "wiki" / "site"
CACHE = DATA_ROOT / "cache"
OVERPASS_CACHE = CACHE / "overpass"
TILE_CACHE = CACHE / "tiles"
PGET_CACHE = CACHE / "pget"
OVERPASS_TTL = 30 * 86400
# Canonical instance first — it's the most reliable; the others are fallbacks for
# when it's rate-limiting. (kumi.systems used to lead but is frequently slow.)
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
# Per-mirror upstream timeout. Sits just above the query's own [timeout:20]
# compute budget (headroom for network + transfer), so a valid slow query isn't
# aborted by our socket before Overpass itself would have. A longer timeout
# mostly just prolongs a hung mirror before we fail over to the next.
OVERPASS_TIMEOUT = 25
_preferred_mirror = [None]      # last mirror that answered (tried first)

# /tiles/<layer>/<z>/<x>/<y> -> upstream template, cached 30 days on disk
TILE_LAYERS = {
    "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "carto-dark": "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "esri-sat": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "esri-hillshade": "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    "esri-labels": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    "opentopo": "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
}
TILE_TTL = 30 * 86400
# Offline tile prefetch (/api/prefetch). MAX_TILES is the politeness/disk cap on
# one request's bbox; BUDGET bounds its wall-clock so the request can't hold a
# server thread for minutes — when it runs out, the response reports `remaining`
# and the client resumes (cached tiles are skipped, so resuming is cheap).
PREFETCH_MAX_TILES = 6000
PREFETCH_BUDGET = 25            # seconds of wall-clock per prefetch request

# /api/pget?u=<url> — generic cached GET proxy, allowlisted prefixes only.
# Historical weather and elevation never change -> effectively permanent.
PGET_ALLOW = [
    ("https://archive-api.open-meteo.com/v1/archive?", 3650 * 86400),
    ("https://api.open-meteo.com/v1/elevation?", 3650 * 86400),
    ("https://api.open-meteo.com/v1/forecast?", 3 * 3600),
    ("https://nominatim.openstreetmap.org/search?", 30 * 86400),
    ("https://api.gbif.org/v1/species/match?", 30 * 86400),
]
VERSION = "1.0.0"
UA = f"GeOSINT-Workbench/{VERSION} (local personal OSINT tool; non-commercial)"
LOCALAPPDATA = os.environ.get("LOCALAPPDATA", "")

# Platform flags — the detection + launch layers branch on these so the workbench
# runs on Windows, macOS and Linux (the server itself is pure stdlib everywhere).
import platform as _platform
PLATFORM = _platform.system()           # 'Windows' | 'Darwin' | 'Linux'
IS_WIN = PLATFORM == "Windows"
IS_MAC = PLATFORM == "Darwin"
IS_LINUX = not IS_WIN and not IS_MAC     # treat *BSD etc. like Linux

# Temp-file extensions ExifTool is allowed to see. The suffix steers ExifTool's
# format handler and is attacker-controlled via X-Filename, so a hostile client
# can't aim it at a riskier parser. Shared by /api/exif and /api/exif-preview.
EXIF_SUFFIXES = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff", ".bmp",
    ".heic", ".heif", ".avif", ".dng", ".cr2", ".cr3", ".nef", ".arw",
    ".raf", ".orf", ".rw2", ".pef", ".srw", ".mp4", ".mov", ".jxl",
}

# Request-body caps. EXIF_MAX_BYTES is the upload ceiling for the two ExifTool
# endpoints (raw image bytes — RAW/video can be large); JSON_MAX_BYTES is for
# every other POST (small JSON). do_POST picks the cap by route and each exif
# handler re-checks EXIF_MAX_BYTES — naming them once means those two checks can
# never silently diverge. EXIF_TOOL_TIMEOUT bounds each ExifTool subprocess.
EXIF_MAX_BYTES = 200 * 1024 * 1024
JSON_MAX_BYTES = 2 * 1024 * 1024
EXIF_TOOL_TIMEOUT = 30          # seconds per ExifTool invocation

# Host header allowlist (set in main() once the port is known). Defends against
# DNS rebinding: a remote page that rebinds its hostname to 127.0.0.1 sends
# same-origin requests (carrying our X-GeOSINT header), defeating the CORS/CSRF
# guard — but the Host header it sends is the attacker's domain, not loopback.
ALLOWED_HOSTS = set()           # exact host:port strings (fast path)
# Accepted Host *hostnames* (port stripped). Always includes loopback names;
# off-loopback binds add the bind host + any --allow-host names. The guard matches
# on hostname, not port, so DNS-rebinding (an attacker domain) is rejected while
# Docker port-mapping (localhost:<any-port>) still works.
ALLOWED_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]", "::1"}

KML_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>{name}</name>
    <description>Sent from GeOSINT Workbench</description>
    <LookAt>
      <longitude>{lng}</longitude>
      <latitude>{lat}</latitude>
      <altitude>0</altitude>
      <heading>0</heading>
      <tilt>{tilt}</tilt>
      <range>{range}</range>
      <altitudeMode>relativeToGround</altitudeMode>
    </LookAt>
    <Point><coordinates>{lng},{lat},0</coordinates></Point>
  </Placemark>
</kml>
"""


# ---- local desktop tool registry ---------------------------------------
def _first_existing(paths):
    for p in paths:
        for hit in glob.glob(str(p)):
            if Path(hit).is_file():
                return Path(hit)
    return None


def _venv_python_dir():
    """Where a venv keeps its interpreter: Scripts on Windows, bin elsewhere."""
    return "Scripts" if IS_WIN else "bin"


def find_exiftool():
    # exiftool is a CLI; PATH is the common case on every OS (winget/brew/apt).
    w = shutil.which("exiftool")
    if w:
        return Path(w)
    if IS_WIN:
        return _first_existing([
            Path(LOCALAPPDATA) / "Programs" / "ExifTool" / "exiftool.exe",
            r"C:\Program Files\exiftool\exiftool.exe",
            r"C:\Program Files\exiftool\exiftool(-k).exe",
        ])
    if IS_MAC:
        return _first_existing([
            "/opt/homebrew/bin/exiftool", "/usr/local/bin/exiftool",
        ])
    return _first_existing(["/usr/bin/exiftool", "/usr/local/bin/exiftool"])


def find_google_earth_pro():
    w = shutil.which("google-earth-pro") or shutil.which("googleearth")
    if w:
        return Path(w)
    if IS_WIN:
        return _first_existing([
            r"C:\Program Files\Google\Google Earth Pro\client\googleearth.exe",
            r"C:\Program Files (x86)\Google\Google Earth Pro\client\googleearth.exe",
        ])
    if IS_MAC:
        # the .app bundle; launched via `open -a` (handled in api_launch/api_flyto)
        return _first_existing([
            "/Applications/Google Earth Pro.app",
            str(Path.home() / "Applications" / "Google Earth Pro.app"),
        ])
    return _first_existing([
        "/usr/bin/google-earth-pro", "/opt/google/earth/pro/googleearth",
    ])


def find_qgis():
    if IS_WIN:
        # Prefer the .bat launcher: it sets up the Qt/GDAL/Python environment the
        # qgis-*-bin.exe needs. Launching the bare exe usually fails on missing DLLs.
        return _first_existing([
            r"C:\Program Files\QGIS*\bin\qgis-ltr.bat",
            r"C:\Program Files\QGIS*\bin\qgis.bat",
            r"C:\OSGeo4W\bin\qgis-ltr.bat",
            r"C:\OSGeo4W\bin\qgis.bat",
            r"C:\Program Files\QGIS*\bin\qgis-ltr-bin.exe",
            r"C:\Program Files\QGIS*\bin\qgis-bin.exe",
        ])
    if IS_MAC:
        return _first_existing([
            "/Applications/QGIS-LTR.app", "/Applications/QGIS.app",
        ])
    w = shutil.which("qgis") or shutil.which("qgis-ltr")
    if w:
        return Path(w)
    return _first_existing(["/usr/bin/qgis", "/usr/local/bin/qgis"])


def find_sherloq():
    # expected layout: tools/sherloq (git clone) with its own venv
    base = ROOT / "tools" / "sherloq"
    py = base / ".venv" / _venv_python_dir() / ("python.exe" if IS_WIN else "python")
    gui = base / "gui" / "sherloq.py"
    if py.is_file() and gui.is_file():
        return py  # launched as: python gui/sherloq.py
    return None


def _install_hint(per_os):
    """Pick the install instruction for the current OS (falls back to linux)."""
    if IS_WIN:
        return per_os["win"]
    if IS_MAC:
        return per_os["mac"]
    return per_os["linux"]


TOOLS = {
    "exiftool": {
        "label": "ExifTool",
        "find": find_exiftool,
        "kind": "cli",
        "install": _install_hint({
            "win": "winget install OliverBetz.ExifTool",
            "mac": "brew install exiftool",
            "linux": "sudo apt install libimage-exiftool-perl  (or your distro's package)",
        }),
    },
    "google_earth_pro": {
        "label": "Google Earth Pro",
        "find": find_google_earth_pro,
        "kind": "gui",
        "install": _install_hint({
            "win": "https://www.google.com/earth/about/versions/#earth-pro",
            "mac": "https://www.google.com/earth/about/versions/#earth-pro  (or: brew install --cask google-earth-pro)",
            "linux": "https://www.google.com/earth/about/versions/#earth-pro  (.deb/.rpm)",
        }),
    },
    "qgis": {
        "label": "QGIS",
        "find": find_qgis,
        "kind": "gui",
        "install": _install_hint({
            "win": "winget install OSGeo.QGIS.LTR  (~2 GB)",
            "mac": "brew install --cask qgis  (or https://qgis.org/download/)",
            "linux": "sudo apt install qgis  (or https://qgis.org/download/)",
        }),
    },
    "sherloq": {
        "label": "Sherloq (image forensics)",
        "find": find_sherloq,
        "kind": "gui",
        "install": "git clone https://github.com/GuidoBartoli/sherloq tools/sherloq, "
                   "then create tools/sherloq/.venv and pip install -r gui/requirements.txt",
    },
}

# Hide the transient console window when spawning a Windows .bat launcher.
_NO_WINDOW = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if IS_WIN else {}


def _launch_app(path: Path, args=None, cwd=None):
    """Open a detected app cross-platform, no shell. Returns the Popen.
      - Windows .bat  -> `cmd /c <bat> [args]` (sets up the tool's env), no console.
      - macOS .app    -> `open -a <bundle> [--args ...]`.
      - everything else (exe / unix binary) -> direct argv Popen.
    Files to *hand to* the app (KML, GeoJSON) are passed as args."""
    args = [str(a) for a in (args or [])]
    p = str(path)
    if IS_WIN and path.suffix.lower() == ".bat":
        return subprocess.Popen(["cmd", "/c", p, *args], cwd=cwd, **_NO_WINDOW)
    if IS_MAC and path.suffix.lower() == ".app":
        cmd = ["open", "-a", p] + (["--args", *args] if args else [])
        return subprocess.Popen(cmd, cwd=cwd)
    return subprocess.Popen([p, *args], cwd=cwd)


def _open_document_with(app: Path, doc: Path):
    """Open a document (e.g. a KML) *with* a specific detected app, cross-platform.
      - Windows .bat -> cmd /c <bat> <doc>; exe -> <exe> <doc>.
      - macOS .app   -> `open -a <bundle> <doc>` (document-open form).
      - Linux binary -> <binary> <doc>.
    Used for the Google Earth Pro fly-to."""
    if IS_MAC and app.suffix.lower() == ".app":
        return subprocess.Popen(["open", "-a", str(app), str(doc)])
    return _launch_app(app, [doc])


def tool_status():
    out = {}
    for key, t in TOOLS.items():
        path = t["find"]()
        out[key] = {
            "label": t["label"],
            "found": path is not None,
            "path": str(path) if path else None,
            "kind": t["kind"],
            "install": t["install"],
        }
    return out


def cache_fresh(path: Path, ttl: int) -> bool:
    return path.is_file() and time.time() - path.stat().st_mtime < ttl


def _lonlat_to_tile(lon, lat, z):
    """Slippy-map tile x,y for a lon/lat at zoom z (Web Mercator)."""
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(max(-85.0511, min(85.0511, lat)))
    y = int((1 - math.asinh(math.tan(lat_r)) / math.pi) / 2 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tiles_in_bbox(s, w, n, e, zmin, zmax):
    """Yield (z, x, y) for every tile covering bbox [s,w,n,e] over zmin..zmax."""
    for z in range(zmin, zmax + 1):
        x0, y0 = _lonlat_to_tile(w, n, z)        # NW corner
        x1, y1 = _lonlat_to_tile(e, s, z)        # SE corner
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                yield z, x, y


# Opener that refuses to follow 3xx redirects. The /api/pget and /tiles proxies
# only fetch allowlisted hosts; without this, an allowlisted host (or a DNS/MITM
# attacker on the path) could 302 us to an internal address — classic SSRF pivot.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_no_redirect_opener = urllib.request.build_opener(_NoRedirect)

# Hard ceiling on any single proxied response, so an upstream can't exhaust RAM/disk.
MAX_UPSTREAM_BYTES = 64 * 1024 * 1024


def upstream_get(url: str, timeout=30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with _no_redirect_opener.open(req, timeout=timeout) as r:
        return r.read(MAX_UPSTREAM_BYTES + 1)[:MAX_UPSTREAM_BYTES]


def _host_of(url: str) -> str:
    """Just the host of a URL — safe to log. The full URL (pget/overpass/tile)
    can embed coordinates or a query, which we never write to the log."""
    try:
        return urlparse(url).netloc or "?"
    except ValueError:
        return "?"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[geosint] %s\n" % (fmt % args))

    def _warn(self, endpoint, where, exc):
        """Log an upstream/tool failure so a degraded run is visible to the
        operator (otherwise these are swallowed into a client JSON error and the
        app just looks broken). OPSEC: `where` must be a host or mirror, never a
        full URL/query — pget/overpass URLs carry coordinates. We log only the
        exception class + message, not request bodies, file paths or coords."""
        cls = type(exc).__name__ if isinstance(exc, BaseException) else "error"
        msg = str(exc)[:200]
        sys.stderr.write(f"[geosint] WARN {endpoint} {where} {cls}: {msg}\n")

    # ---- helpers -------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_file(self, path: Path):
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # Defense-in-depth headers on HTML documents (the SPA + wiki). Scripts are
        # all locally vendored (no CDN), so a CSP that pins script/style to 'self'
        # — plus 'unsafe-inline' (the app uses some inline handlers/styles) and the
        # external img/connect origins it legitimately needs — backstops any missed
        # XSS sink and blocks framing/clickjacking.
        if ctype == "text/html":
            self.send_header("Content-Security-Policy",
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob: https:; "
                "connect-src 'self' https:; "
                "frame-ancestors 'none'; base-uri 'self'")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def host_ok(self):
        """Reject requests whose Host *hostname* isn't loopback or an explicit
        allow-host — blocks DNS-rebinding attacks reaching the local API.

        We match on the HOSTNAME, not the host:port string: the rebinding threat
        is an attacker domain (evil.com) rebound to our IP, and the attacker
        cannot make the victim's browser send Host: localhost for that domain.
        The port is irrelevant to the guard (and varies under Docker port
        mapping, e.g. -p 8664:8650), so we strip it. Off-loopback binds add the
        bind host + any --allow-host names to the accepted set."""
        host = (self.headers.get("Host") or "").strip().lower()
        if host in ALLOWED_HOSTS:                 # exact host:port (fast path)
            return True
        # strip a trailing :port (but not the colons inside a bracketed IPv6 [::1])
        if host.startswith("["):
            hostname = host.split("]", 1)[0] + "]"
        else:
            hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        return hostname in ALLOWED_HOSTNAMES

    # JSON POST routes: path -> handler-method name. do_POST dispatches the
    # uniform JSON endpoints from this one table, and POST_PATHS is derived from
    # it (plus the two raw-bytes exif routes), so a new endpoint is registered in
    # exactly one place — no GET_PATHS/POST_PATHS set to forget and let drift.
    POST_JSON_ROUTES = {
        "/api/flyto": "api_flyto",
        "/api/launch": "api_launch",
        "/api/overpass": "api_overpass",
        "/api/qgis": "api_qgis",
        "/api/prefetch": "api_prefetch",
    }
    # Raw-bytes POST routes (handled before JSON parsing — they take image bytes).
    POST_RAW_PATHS = {"/api/exif", "/api/exif-preview"}

    # Known routes per method, for 405 (path exists but wrong verb) vs 404.
    GET_PATHS = {"/", "/index.html", "/api/pget", "/wiki", "/api/status"}
    POST_PATHS = POST_RAW_PATHS | POST_JSON_ROUTES.keys()

    def send_405(self, allow):
        self.send_response(405)
        self.send_header("Allow", allow)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _not_found_or_405(self, path, this_method):
        """Emit 405+Allow when the path is valid under another verb, else 404."""
        if this_method != "GET" and (path in self.GET_PATHS or path.startswith("/app")
                                     or path.startswith("/wiki") or path.startswith("/tiles/")):
            return self.send_405("GET, HEAD")
        if this_method != "POST" and path in self.POST_PATHS:
            return self.send_405("POST")
        return self.send_json({"error": "not found"}, 404)

    # Reject other verbs with a clean JSON-ish 405 (not the stdlib HTML 501).
    def do_PUT(self):    self._reject_verb()
    def do_DELETE(self): self._reject_verb()
    def do_PATCH(self):  self._reject_verb()
    def do_OPTIONS(self): self._reject_verb()
    def _reject_verb(self):
        if not self.host_ok():
            return self.send_json({"error": "bad host"}, 403)
        self.send_405("GET, HEAD, POST")

    def do_HEAD(self):
        self.do_GET()

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def serve_static(self, base: Path, rel: str):
        # Safe path resolution: never escape the base directory. The check is
        # separator-aware (plain startswith would let ".../app" match ".../app2").
        target = (base / unquote(rel)).resolve()
        root = base.resolve()
        if target != root and root not in target.parents:
            return self.send_json({"error": "forbidden"}, 403)
        if target.is_dir():
            target = target / "index.html"
        if target.is_file():
            return self.send_file(target)
        self.send_json({"error": "not found"}, 404)   # don't echo the caller-supplied path

    def send_cached_body(self, body: bytes, ctype: str, hit: str, browser_ttl=0):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Cache", hit)
        # Always emit a Cache-Control directive so proxies/browsers don't apply
        # heuristic caching to proxied data (stale OSINT data is a hazard).
        self.send_header("Cache-Control", f"public, max-age={browser_ttl}" if browser_ttl else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ---- cached tile proxy: /tiles/<layer>/<z>/<x>/<y> -------------------
    def api_tile(self, path):
        parts = path.strip("/").split("/")          # tiles, layer, z, x, y
        if len(parts) != 5 or parts[1] not in TILE_LAYERS:
            return self.send_json({"error": "unknown tile layer"}, 404)
        layer = parts[1]
        # Strict integer parse (no \D-stripping, which silently turned "-1" into
        # "1" and let negative zoom/coords through). Reject anything non-integer.
        if not all(re.fullmatch(r"-?\d+", p) for p in parts[2:5]):
            return self.send_json({"error": "bad tile coords"}, 400)
        z, x, y = (int(p) for p in parts[2:5])
        if not (0 <= z <= 20):
            return self.send_json({"error": "bad zoom"}, 400)
        n = 1 << z
        if not (0 <= x < n and 0 <= y < n):
            return self.send_json({"error": "tile coords out of range"}, 400)
        f = TILE_CACHE / layer / str(z) / str(x) / f"{y}.png"
        if cache_fresh(f, TILE_TTL):
            return self.send_cached_body(f.read_bytes(), "image/png", "hit", TILE_TTL)
        url = TILE_LAYERS[layer].format(z=z, x=x, y=y)
        try:
            body = upstream_get(url, timeout=20)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
            return self.send_cached_body(body, "image/png", "miss", TILE_TTL)
        except Exception as e:
            self._warn("/tiles", _host_of(url), e)
            if f.is_file():                          # stale beats nothing
                return self.send_cached_body(f.read_bytes(), "image/png", "stale", 3600)
            return self.send_json({"error": "tile upstream unreachable"}, 502)

    # ---- API: prefetch a bbox of tiles for offline use ------------------
    def api_prefetch(self, payload):
        """Download every tile covering a bbox over a zoom range into the tile
        cache, so the area works offline later. Capped to keep it polite."""
        layer = str(payload.get("layer") or "")
        if layer not in TILE_LAYERS:
            return self.send_json({"error": "unknown tile layer"}, 400)
        try:
            s, w, n, e = (float(payload["bbox"][i]) for i in range(4))
            zmin, zmax = int(payload["zmin"]), int(payload["zmax"])
        except (KeyError, TypeError, ValueError, IndexError):
            return self.send_json({"error": "bbox [s,w,n,e] + zmin/zmax required"}, 400)
        if not (0 <= zmin <= zmax <= 19):
            return self.send_json({"error": "need 0 <= zmin <= zmax <= 19"}, 400)
        tiles = list(tiles_in_bbox(s, w, n, e, zmin, zmax))
        if len(tiles) > PREFETCH_MAX_TILES:
            return self.send_json({"error": f"{len(tiles)} tiles exceeds the {PREFETCH_MAX_TILES} "
                                            f"cap — narrow the area or lower max zoom"}, 413)
        # Bound the request's wall-clock so it can't hold a server thread + the
        # client connection for minutes on a cold cache / slow mirror. When the
        # budget runs out we stop and report `remaining` (+ done:false); the
        # client re-issues to resume — already-cached tiles are skipped, so a
        # resume is cheap. A run is `done` only when every tile was processed.
        fetched = cached = failed = 0
        deadline = time.monotonic() + PREFETCH_BUDGET
        processed = 0
        for z, x, y in tiles:
            if time.monotonic() >= deadline:
                break
            processed += 1
            f = TILE_CACHE / layer / str(z) / str(x) / f"{y}.png"
            if cache_fresh(f, TILE_TTL):
                cached += 1
                continue
            try:
                body = upstream_get(TILE_LAYERS[layer].format(z=z, x=x, y=y), timeout=20)
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(body)
                fetched += 1
                time.sleep(0.05)                  # gentle on the tile server
            except Exception:
                failed += 1                       # surfaced in the `failed` count
        remaining = len(tiles) - processed
        return self.send_json({"ok": True, "layer": layer, "tiles": len(tiles),
                               "fetched": fetched, "cached": cached, "failed": failed,
                               "remaining": remaining, "done": remaining == 0})

    # ---- generic cached GET proxy: /api/pget?u=<allowlisted url> ---------
    def api_pget(self, query):
        url = urllib.parse.parse_qs(query).get("u", [""])[0]
        if not url:                               # missing required param is a bad request, not "forbidden"
            return self.send_json({"error": "missing 'u' parameter"}, 400)
        ttl = next((t for prefix, t in PGET_ALLOW if url.startswith(prefix)), None)
        if ttl is None:
            return self.send_json({"error": "url not allowlisted"}, 403)
        f = PGET_CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".json")
        if cache_fresh(f, ttl):
            return self.send_cached_body(f.read_bytes(), "application/json; charset=utf-8", "hit")
        try:
            body = upstream_get(url, timeout=30)
            json.loads(body)
            PGET_CACHE.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
            return self.send_cached_body(body, "application/json; charset=utf-8", "miss")
        except Exception as e:
            self._warn("/api/pget", _host_of(url), e)
            if f.is_file():
                return self.send_cached_body(f.read_bytes(), "application/json; charset=utf-8", "stale")
            return self.send_json({"error": f"upstream failed: {str(e)[:160]}"}, 502)

    # ---- routes --------------------------------------------------------
    def do_GET(self):
        if not self.host_ok():
            return self.send_json({"error": "bad host"}, 403)
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            return self.redirect("/app/")
        if path.startswith("/tiles/"):
            return self.api_tile(path)
        if path == "/api/pget":
            return self.api_pget(parsed.query)
        if path == "/wiki":
            return self.redirect("/wiki/")
        if path == "/api/status":
            return self.send_json({
                "version": VERSION,
                "platform": PLATFORM,
                "tools": tool_status(),
                "wiki_built": (WIKI_SITE / "index.html").is_file(),
            })
        if path.startswith("/app"):
            return self.serve_static(APP_DIR, path[len("/app"):].lstrip("/"))
        if path.startswith("/wiki"):
            if not (WIKI_SITE / "index.html").is_file():
                body = (b"<h1>Wiki not built yet</h1><p>Start the workbench with "
                        b"<code>run.ps1</code> (Windows) or <code>run.sh</code> "
                        b"(macOS/Linux) \xe2\x80\x94 or run <code>python -m geosint</code> "
                        b"\xe2\x80\x94 to build the wiki, then reload.</p>")
                self.send_response(503)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
                self.send_header("X-Frame-Options", "DENY")
                self.end_headers()
                self.wfile.write(body)
                return
            return self.serve_static(WIKI_SITE, path[len("/wiki"):].lstrip("/"))
        self._not_found_or_405(path, "GET")

    def do_POST(self):
        if not self.host_ok():
            return self.send_json({"error": "bad host"}, 403)
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.send_json({"error": "bad content-length"}, 400)
        # The ExifTool endpoints take raw image bytes (bounded to 200 MB inside
        # the handler); every other POST is small JSON. Cap the read accordingly.
        cap = EXIF_MAX_BYTES if path in ("/api/exif", "/api/exif-preview") else JSON_MAX_BYTES
        if length < 0 or length > cap:
            return self.send_json({"error": "request too large"}, 413)
        raw = self.rfile.read(length) if length else b""

        # CSRF guard: every POST launches a local app or runs a local binary.
        # Require a custom header the SPA always sends. A custom header forces a
        # CORS preflight cross-origin, which this server never answers — so a
        # drive-by page in the browser cannot reach these endpoints, while
        # same-origin fetches from /app/ are unaffected.
        if self.headers.get("X-GeOSINT") != "1":
            return self.send_json({"error": "missing X-GeOSINT header"}, 403)

        if path == "/api/exif":
            return self.api_exif(raw)
        if path == "/api/exif-preview":
            return self.api_exif_preview(raw)

        handler = self.POST_JSON_ROUTES.get(path)
        if handler is None:
            return self._not_found_or_405(path, "POST")
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "bad json"}, 400)
        return getattr(self, handler)(payload)

    # ---- API: hand off GeoJSON to QGIS ----------------------------------
    def api_qgis(self, payload):
        """Write a GeoJSON FeatureCollection to disk and open it in QGIS as a layer."""
        # Validate the payload before probing for the tool, so a malformed request
        # gets a 400 (not a misleading "QGIS not found" 409). Mirrors api_flyto.
        fc = payload.get("geojson")
        if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
            return self.send_json({"error": "geojson FeatureCollection required"}, 400)
        feats = fc.get("features")
        if not isinstance(feats, list) or not (1 <= len(feats) <= 5000):
            return self.send_json({"error": "1-5000 features required"}, 400)
        qgis = find_qgis()
        if qgis is None:
            return self.send_json({"error": "QGIS not found. Install: winget install OSGeo.QGIS.LTR"}, 409)
        out = CACHE / "qgis"
        out.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(payload.get("name") or "geosint"))[:40] or "geosint"
        f = out / f"{name}.geojson"
        f.write_text(json.dumps(fc), encoding="utf-8")
        try:
            _launch_app(qgis, [f])           # hands the layer file to QGIS, cross-platform
            return self.send_json({"ok": True, "file": str(f), "features": len(feats)})
        except OSError as e:
            return self.send_json({"error": str(e)}, 500)

    # ---- API: cached Overpass proxy --------------------------------------
    def api_overpass(self, payload):
        """Run an Overpass QL query with a 7-day local file cache."""
        q = str(payload.get("q") or "")
        # Require a real `out` statement (word-boundary), not just the substring
        # "out" — otherwise "timeout"/"output" satisfied the old check and an
        # unvalidated query was forwarded to the mirrors.
        if not (10 < len(q) < 6000) or not re.search(r"\bout\b", q):
            return self.send_json({"error": "invalid query"}, 400)
        OVERPASS_CACHE.mkdir(parents=True, exist_ok=True)
        cached = OVERPASS_CACHE / (hashlib.sha1(q.encode()).hexdigest() + ".json")
        if cache_fresh(cached, OVERPASS_TTL):
            return self.send_cached_body(cached.read_bytes(),
                                         "application/json; charset=utf-8", "hit")
        data = ("data=" + urllib.parse.quote(q)).encode()
        last_err = "no mirror reachable"
        mirrors = OVERPASS_MIRRORS[:]
        if _preferred_mirror[0] in mirrors:          # last healthy mirror first
            mirrors.remove(_preferred_mirror[0])
            mirrors.insert(0, _preferred_mirror[0])
        for mirror in mirrors:
            try:
                req = urllib.request.Request(mirror, data=data,
                                             headers={"User-Agent": UA})
                with _no_redirect_opener.open(req, timeout=OVERPASS_TIMEOUT) as resp:
                    body = resp.read(MAX_UPSTREAM_BYTES + 1)[:MAX_UPSTREAM_BYTES]
                json.loads(body)            # validate before caching
                _preferred_mirror[0] = mirror
                cached.write_bytes(body)
                return self.send_cached_body(body, "application/json; charset=utf-8", "miss")
            except Exception as e:
                last_err = str(e)[:200]
                self._warn("/api/overpass", _host_of(mirror), e)   # show the failover chain
        if cached.is_file():                # expired cache beats an error
            return self.send_cached_body(cached.read_bytes(),
                                         "application/json; charset=utf-8", "stale")
        return self.send_json({"error": f"Overpass unreachable: {last_err}"}, 502)

    def _write_exif_temp(self, raw: bytes) -> Path:
        """Write uploaded image bytes to a temp file whose extension is restricted
        to the EXIF_SUFFIXES allowlist (X-Filename is attacker-controlled)."""
        name = Path(unquote(self.headers.get("X-Filename") or "image.jpg")).name
        suffix = Path(name).suffix.lower()
        if suffix not in EXIF_SUFFIXES:
            suffix = ".jpg"
        with tempfile.NamedTemporaryFile(prefix="geosint_", suffix=suffix, delete=False) as f:
            f.write(raw)
            return Path(f.name)

    # ---- API: ExifTool deep metadata dump -------------------------------
    def api_exif(self, raw: bytes):
        """Run local ExifTool on an uploaded image; body = raw bytes,
        X-Filename header used only for the temp file extension."""
        # Validate the request (400/413) before probing for the tool (409), so a
        # bad request reports the bad request, not "tool missing".
        if not raw:
            return self.send_json({"error": "empty body"}, 400)
        if len(raw) > EXIF_MAX_BYTES:
            return self.send_json({"error": "file too large"}, 413)
        exiftool = find_exiftool()
        if exiftool is None:
            return self.send_json({"error": "ExifTool not found. Install: winget install OliverBetz.ExifTool"}, 409)
        tmp = None
        try:
            tmp = self._write_exif_temp(raw)
            proc = subprocess.run(
                [str(exiftool), "-json", "-a", "-G1", "-api", "largefilesupport=1", str(tmp)],
                capture_output=True, timeout=EXIF_TOOL_TIMEOUT,
            )
            if proc.returncode not in (0, 1):  # 1 = minor warnings
                err = proc.stderr.decode("utf-8", "replace")[:500]
                self._warn("/api/exif", "exiftool", f"exit {proc.returncode}: {err}")
                return self.send_json({"error": err}, 500)
            data = json.loads(proc.stdout.decode("utf-8", "replace"))
            tags = data[0] if data else {}
            tags.pop("SourceFile", None)
            # System group leaks the temp file's path/name — drop it entirely
            tags = {k: v for k, v in tags.items() if not k.startswith("System:")}
            return self.send_json({"ok": True, "exiftool": str(exiftool), "tags": tags})
        except subprocess.TimeoutExpired as e:
            self._warn("/api/exif", "exiftool", e)
            return self.send_json({"error": "exiftool timed out"}, 504)
        except (OSError, json.JSONDecodeError, ValueError) as e:
            self._warn("/api/exif", "exiftool", e)
            return self.send_json({"error": str(e)[:500]}, 500)
        finally:
            if tmp:
                try:
                    tmp.unlink()
                except OSError:
                    pass

    # ---- API: extract the largest embedded preview/thumbnail -------------
    # Embedded previews are often the *uncropped* original — when an image is
    # cropped or redacted before sharing, the buried preview can still show what
    # was cut out. We also read the preview's OWN gps/time and flag any mismatch
    # with the main image (a tampering/splicing signal). Returns the preview as
    # raw image bytes; the forensic analysis rides in X-* response headers.
    PREVIEW_TAGS = ("JpgFromRaw", "PreviewImage", "OtherImage", "ThumbnailImage")

    def _exif_gps_time(self, exiftool, path):
        """Return (gps 'lat,lon' or None, DateTimeOriginal/CreateDate or None)."""
        try:
            proc = subprocess.run(
                [str(exiftool), "-json", "-n", "-GPSLatitude", "-GPSLongitude",
                 "-DateTimeOriginal", "-CreateDate", str(path)],
                capture_output=True, timeout=20, stdin=subprocess.DEVNULL,
            )
            d = (json.loads(proc.stdout.decode("utf-8", "replace")) or [{}])[0]
        except (OSError, json.JSONDecodeError, ValueError, subprocess.TimeoutExpired):
            return None, None
        lat, lon = d.get("GPSLatitude"), d.get("GPSLongitude")
        gps = f"{lat},{lon}" if (lat is not None and lon is not None) else None
        return gps, (d.get("DateTimeOriginal") or d.get("CreateDate"))

    def api_exif_preview(self, raw: bytes):
        if not raw:
            return self.send_json({"error": "empty body"}, 400)
        if len(raw) > EXIF_MAX_BYTES:
            return self.send_json({"error": "file too large"}, 413)
        exiftool = find_exiftool()
        if exiftool is None:
            return self.send_json({"error": "ExifTool not found. Install: winget install OliverBetz.ExifTool"}, 409)
        tmp = prev_tmp = None
        try:
            tmp = self._write_exif_temp(raw)
            # find the first preview tag that has bytes, extract it to stdout
            chosen, body = None, b""
            for tag in self.PREVIEW_TAGS:
                try:
                    p = subprocess.run([str(exiftool), "-b", "-" + tag, str(tmp)],
                                       capture_output=True, timeout=EXIF_TOOL_TIMEOUT, stdin=subprocess.DEVNULL)
                except subprocess.TimeoutExpired as e:
                    self._warn("/api/exif-preview", "exiftool", e)
                    return self.send_json({"error": "exiftool timed out"}, 504)
                if p.returncode in (0, 1) and p.stdout:
                    chosen, body = tag, p.stdout
                    break
            if not body:
                return self.send_json({"ok": True, "has_preview": False,
                                       "msg": "no embedded preview/thumbnail in this image"}, 200)

            # main vs preview gps/time — read the preview's own metadata
            main_gps, main_time = self._exif_gps_time(exiftool, tmp)
            with tempfile.NamedTemporaryFile(prefix="geosint_prev_", suffix=".jpg", delete=False) as pf:
                pf.write(body)
                prev_tmp = Path(pf.name)
            prev_gps, prev_time = self._exif_gps_time(exiftool, prev_tmp)
            gps_mismatch = bool(main_gps and prev_gps and main_gps != prev_gps)
            time_mismatch = bool(main_time and prev_time and main_time != prev_time)

            ctype = "image/jpeg" if body[:2] == b"\xff\xd8" else "application/octet-stream"
            # These values come from attacker-controlled EXIF — strip CR/LF and
            # cap length so they can't split the response / inject headers.
            def _hv(v):
                return re.sub(r"[\r\n]", " ", str(v))[:80]
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Preview-Tag", _hv(chosen))
            self.send_header("X-Preview-Bytes", str(len(body)))
            if main_gps:  self.send_header("X-Main-GPS", _hv(main_gps))
            if prev_gps:  self.send_header("X-Preview-GPS", _hv(prev_gps))
            if main_time: self.send_header("X-Main-Time", _hv(main_time))
            if prev_time: self.send_header("X-Preview-Time", _hv(prev_time))
            self.send_header("X-GPS-Mismatch", "1" if gps_mismatch else "0")
            self.send_header("X-Time-Mismatch", "1" if time_mismatch else "0")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (OSError, ValueError) as e:
            self._warn("/api/exif-preview", "exiftool", e)
            return self.send_json({"error": str(e)[:500]}, 500)
        finally:
            for t in (tmp, prev_tmp):
                if t:
                    try:
                        t.unlink()
                    except OSError:
                        pass

    # ---- API: launch a local GUI tool -----------------------------------
    def api_launch(self, payload):
        key = str(payload.get("tool") or "")
        t = TOOLS.get(key)
        if t is None:
            return self.send_json({"error": f"unknown tool '{key}'"}, 400)
        path = t["find"]()
        if path is None:
            return self.send_json({"error": f"{t['label']} not found. Install: {t['install']}"}, 409)
        try:
            if key == "sherloq":
                # path is sherloq's own venv python; run its GUI script directly
                gui = ROOT / "tools" / "sherloq" / "gui" / "sherloq.py"
                subprocess.Popen([str(path), str(gui)], cwd=str(gui.parent))
            else:
                _launch_app(path)            # .bat/.app/exe/binary handled per-OS
            return self.send_json({"ok": True, "launched": str(path)})
        except OSError as e:
            return self.send_json({"error": str(e)}, 500)

    # ---- API: Google Earth Pro fly-to ------------------------------------
    def api_flyto(self, payload):
        """Fly Google Earth Pro to a coordinate by opening a generated KML."""
        try:
            lat = float(payload["lat"])
            lng = float(payload["lng"])
        except (KeyError, TypeError, ValueError):
            return self.send_json({"error": "lat/lng required"}, 400)
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return self.send_json({"error": "coordinates out of range"}, 400)

        gep = find_google_earth_pro()
        if gep is None:
            return self.send_json({
                "error": "Google Earth Pro not found. Install it from "
                         "https://www.google.com/earth/about/versions/#earth-pro"
            }, 409)

        import html as _html
        name = str(payload.get("name") or f"{lat:.5f}, {lng:.5f}")[:120]
        rng = max(100, min(float(payload.get("range") or 1200), 5_000_000))
        kml = KML_TEMPLATE.format(
            name=_html.escape(name),
            lat=lat, lng=lng, range=rng, tilt=35,
        )
        # Unpredictable per-call name (not a fixed path in the shared temp dir):
        # a predictable world-readable name invites symlink/TOCTOU pre-creation
        # and lets another local user read the target coordinate.
        with tempfile.NamedTemporaryFile(prefix="geosint_flyto_", suffix=".kml",
                                         mode="w", encoding="utf-8", delete=False) as f:
            f.write(kml)
            kml_path = Path(f.name)
        _open_document_with(gep, kml_path)       # opens the KML in GE Pro, cross-platform
        return self.send_json({"ok": True, "kml": str(kml_path)})


def main():
    ap = argparse.ArgumentParser(description="GeOSINT Workbench server")
    ap.add_argument("--port", type=int, default=8650)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--version", action="version", version=f"GeOSINT Workbench {VERSION}")
    # Bind address. Default is loopback only (the security posture). 0.0.0.0 is an
    # explicit opt-in for containers (Docker) — the Host-header allowlist + the
    # X-GeOSINT CSRF guard still apply, but you are responsible for not exposing
    # the port to an untrusted network.
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default 127.0.0.1; use 0.0.0.0 only inside a container)")
    ap.add_argument("--allow-host", action="append", default=[], metavar="HOST[:PORT]",
                    help="extra Host header value to accept (repeatable); needed for direct "
                         "IP/hostname access when bound off-loopback")
    args = ap.parse_args()

    # Build the DNS-rebinding guard's accepted Host set for this run.
    global ALLOWED_HOSTS, ALLOWED_HOSTNAMES
    ALLOWED_HOSTS = {
        f"127.0.0.1:{args.port}", f"localhost:{args.port}", f"[::1]:{args.port}",
        "127.0.0.1", "localhost", "[::1]",
    }
    ALLOWED_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]", "::1"}
    # Operator-supplied trusted Host names (accepted on any port).
    for h in args.allow_host:
        h = h.strip().lower()
        ALLOWED_HOSTNAMES.add(h.rsplit(":", 1)[0] if (":" in h and not h.startswith("[")) else h)
    loopback = args.host in ("127.0.0.1", "localhost", "::1")
    if not loopback:
        # Off-loopback bind (e.g. 0.0.0.0 in a container). Loopback names still
        # work for the common `-p host:container` Docker case; direct IP/hostname
        # access needs --allow-host. The hostname-based guard still rejects a
        # rebound attacker domain. Make the network exposure explicit.
        ALLOWED_HOSTNAMES.add(args.host)
        print(f"[geosint] WARNING: binding to {args.host} (not loopback). Reach it via "
              f"http://localhost:{args.port}/ or pass --allow-host <name>. Do NOT publish "
              f"this port to an untrusted network (prefer "
              f"`-p 127.0.0.1:{args.port}:{args.port}` in Docker).")

    try:
        srv = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError:
        print(f"Port {args.port} is already in use — the Workbench is probably already "
              f"running at http://127.0.0.1:{args.port}/app/ (or pass --port to use another).")
        sys.exit(1)
    url = f"http://127.0.0.1:{args.port}/app/"
    print(f"GeOSINT Workbench {VERSION}  ->  {url}")
    print(f"Wiki               ->  http://127.0.0.1:{args.port}/wiki/"
          + ("" if (WIKI_SITE / 'index.html').is_file() else "   (NOT BUILT YET)"))
    for key, st in tool_status().items():
        print(f"  {st['label']:<28} {'OK  ' + st['path'] if st['found'] else 'not installed'}")
    print("Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye.")


if __name__ == "__main__":
    main()
