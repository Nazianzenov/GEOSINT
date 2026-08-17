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

# Pin .svg -> image/svg+xml deterministically. send_file()'s SVG CSP/sandbox
# branch keys off guess_type returning exactly this; on Windows, mimetypes.init()
# consults the registry first, which can map .svg to something else and silently
# skip the CSP. Registering it here makes the guard fire on every platform.
mimetypes.add_type("image/svg+xml", ".svg")

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
GBIF_TILE_CACHE = CACHE / "gbif"        # browser used to hit api.gbif.org direct (#leak)
IMG_CACHE = CACHE / "img"               # wiki-search reference images, now proxied
# Global on-disk cache ceiling. Per-response writes are already bounded
# (MAX_UPSTREAM_BYTES) and prefetch is capped per request, but nothing bounded the
# *total* — sustained tile/pget proxying or repeated prefetch resumes could fill
# the disk over a long-lived run. After a write, atomic_write() occasionally sweeps
# CACHE and, if over the ceiling, deletes oldest-by-mtime files down to a low-water
# mark (a coarse LRU). Override with GEOSINT_CACHE_MAX_MB=0 to disable.
try:
    CACHE_MAX_BYTES = int(float(os.environ.get("GEOSINT_CACHE_MAX_MB", "2048")) * 1024 * 1024)
except ValueError:
    CACHE_MAX_BYTES = 2048 * 1024 * 1024
CACHE_EVICT_TO = 0.9            # sweep evicts down to 90% of the ceiling (low-water)
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
# GBIF occurrence-density overlay + wiki reference images: previously fetched
# browser-direct (leaking the analyst's IP/UA to api.gbif.org / geohints.com).
# Now proxied through the server (cached + routed via the OPSEC egress layer).
GBIF_TILE_TTL = 7 * 86400        # occurrence density refreshes; a week is plenty
IMG_TTL = 30 * 86400
# Allowlisted GBIF density-tile parameters (the URL is server-built from these, so
# the {z}/{x}/{y} path parser can't be steered to an arbitrary host/path).
GBIF_TILE_STYLES = {
    "purpleYellow-noborder.poly", "purpleYellow.poly", "classic.poly",
    "classic-noborder.poly", "green.poly", "orangeHeat.point", "classic.point",
}
GBIF_TILE_BINS = {"hex", "square", "point"}
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
# Version + User-Agent: single source of truth is geosint/__init__.py, so the
# version advertised by /api/status, --version and every outbound request can
# never drift from the package version. Import defensively — a frozen/standalone
# server.py must still start if the `geosint` package isn't importable.
try:
    from geosint import __version__ as VERSION, ua as _ua
    UA = _ua(VERSION)
except Exception:                       # pragma: no cover - frozen/standalone fallback
    VERSION = "1.0.0"
    UA = (f"GeOSINT-Workbench/{VERSION} "
          f"(https://github.com/Nazianzenov/GEOSINT; "
          f"non-commercial personal OSINT tool)")
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

# True when bound off-loopback (e.g. 0.0.0.0 in a container). Set in main().
# When set, host_ok() emits a throttled warning for any request accepted only via
# the unconditional loopback-name fallback — i.e. a peer reached the exposed bind
# and sent `Host: localhost`, the exact scenario the startup warning tells the
# operator to avoid. Makes that exposure observable per request (SEC-02).
OFF_LOOPBACK_BIND = False
_off_loopback_warn_at = [0.0]   # last warn time; throttle to avoid log flooding

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
        # No `exiftool(-k).exe` candidate: the documented install renames it to
        # `exiftool.exe` (which the PATH lookup above already finds), and the
        # parenthesised name is fragile to glob/quoting — drop it.
        return _first_existing([
            Path(LOCALAPPDATA) / "Programs" / "ExifTool" / "exiftool.exe",
            r"C:\Program Files\exiftool\exiftool.exe",
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
# Detach spawned GUI/CLI children into their own session on POSIX so they (a) get
# their own process group (a Ctrl-C in our terminal doesn't kill the user's app)
# and (b) re-parent cleanly when they outlive us. Windows has no equivalent here.
_DETACH = {"start_new_session": True} if not IS_WIN else {}


def _reap_children():
    """Non-blocking sweep of any finished child processes (POSIX only).

    api_launch/api_flyto/api_qgis spawn Popens and discard them; on POSIX an
    exited-but-unwaited child lingers as a zombie. Rather than a full registry,
    we opportunistically reap every already-dead child on each launch. No-op on
    Windows (no waitpid/WNOHANG) and harmless when there's nothing to reap."""
    if IS_WIN or not hasattr(os, "waitpid") or not hasattr(os, "WNOHANG"):
        return
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except (ChildProcessError, OSError):
            break                         # no children at all
        if pid == 0:                      # children exist but none have exited
            break


def _launch_app(path: Path, args=None, cwd=None):
    """Open a detected app cross-platform, no shell. Returns the Popen.
      - Windows .bat  -> `cmd /c <bat> [args]` (sets up the tool's env), no console.
      - macOS .app    -> `open -a <bundle> [--args ...]`.
      - everything else (exe / unix binary) -> direct argv Popen.
    Files to *hand to* the app (KML, GeoJSON) are passed as args."""
    _reap_children()                      # opportunistic zombie sweep (POSIX)
    args = [str(a) for a in (args or [])]
    p = str(path)
    if IS_WIN and path.suffix.lower() == ".bat":
        return subprocess.Popen(["cmd", "/c", p, *args], cwd=cwd, **_NO_WINDOW)
    if IS_MAC and path.suffix.lower() == ".app":
        cmd = ["open", "-a", p] + (["--args", *args] if args else [])
        return subprocess.Popen(cmd, cwd=cwd, **_DETACH)
    return subprocess.Popen([p, *args], cwd=cwd, **_DETACH)


def _open_document_with(app: Path, doc: Path):
    """Open a document (e.g. a KML) *with* a specific detected app, cross-platform.
      - Windows .bat -> cmd /c <bat> <doc>; exe -> <exe> <doc>.
      - macOS .app   -> `open -a <bundle> <doc>` (document-open form).
      - Linux binary -> <binary> <doc>.
    Used for the Google Earth Pro fly-to."""
    _reap_children()                      # opportunistic zombie sweep (POSIX)
    if IS_MAC and app.suffix.lower() == ".app":
        return subprocess.Popen(["open", "-a", str(app), str(doc)], **_DETACH)
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


def _chmod_600(path) -> None:
    """Restrict a just-created per-call temp file to the owner (0o600).

    tempfile.mkstemp() already does this, but NamedTemporaryFile honours the
    process umask, so on a permissive umask these files (uploaded images, the
    extracted preview, the fly-to KML — all carry private data) would be group/
    world-readable. Best-effort: a no-op where chmod isn't meaningful (Windows)
    or fails, leaving behaviour otherwise identical."""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def cache_fresh(path: Path, ttl: int) -> bool:
    return path.is_file() and time.time() - path.stat().st_mtime < ttl


_evict_lock = threading.Lock()
_writes_since_sweep = [0]


def _enforce_cache_cap() -> None:
    """Best-effort global cache eviction. When CACHE exceeds CACHE_MAX_BYTES,
    delete the oldest files (by mtime — a coarse LRU) until total size is back
    under CACHE_EVICT_TO × the ceiling. Triggered occasionally from atomic_write,
    not on every write (walking the tree is O(files)). Never raises: an eviction
    failure must not break the cache write or the request that drove it."""
    if CACHE_MAX_BYTES <= 0:
        return
    if not _evict_lock.acquire(blocking=False):
        return                      # another thread is already sweeping
    try:
        entries = []                # (mtime, size, path)
        total = 0
        for root, _dirs, files in os.walk(CACHE):
            for name in files:
                if name.startswith(".tmp-"):
                    continue        # in-flight atomic_write temp; not a cache entry
                fp = os.path.join(root, name)
                try:
                    st = os.stat(fp)
                except OSError:
                    continue        # vanished mid-walk (concurrent write/evict)
                entries.append((st.st_mtime, st.st_size, fp))
                total += st.st_size
        if total <= CACHE_MAX_BYTES:
            return
        target = int(CACHE_MAX_BYTES * CACHE_EVICT_TO)
        entries.sort()             # oldest mtime first
        for _mtime, size, fp in entries:
            if total <= target:
                break
            try:
                os.unlink(fp)
                total -= size
            except OSError:
                pass               # already gone / locked — skip, keep going
    except OSError:
        pass                       # CACHE missing or unwalkable — nothing to do
    finally:
        _evict_lock.release()


def atomic_write(path: Path, data: bytes) -> None:
    """Write a cache file atomically. The server is threaded, so two requests can
    race to populate the same cache entry while a third reads it; a plain
    write_bytes is not atomic, so the reader could see a half-written (truncated)
    file. Write to a unique temp file in the same dir, then os.replace() — which
    is atomic on POSIX and Windows — so a reader only ever sees the old file or
    the complete new one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    # Amortise the cap check: sweep roughly every 64th write rather than walking
    # the whole cache tree on every single one.
    _writes_since_sweep[0] += 1
    if _writes_since_sweep[0] >= 64:
        _writes_since_sweep[0] = 0
        _enforce_cache_cap()


# Pure Web-Mercator tile math lives in geosint/tiles.py (ARC-05 / #88) so it is
# unit-testable without the HTTP Handler. Imported defensively so a frozen/
# standalone server.py still starts if the package isn't importable, falling back
# to a local copy. _lonlat_to_tile keeps its old name (used internally + in tests).
try:
    from geosint.tiles import lonlat_to_tile as _lonlat_to_tile, tiles_in_bbox
except Exception:                       # pragma: no cover - frozen/standalone fallback
    def _lonlat_to_tile(lon, lat, z):
        n = 2 ** z
        x = int((lon + 180.0) / 360.0 * n)
        lat_r = math.radians(max(-85.0511, min(85.0511, lat)))
        y = int((1 - math.asinh(math.tan(lat_r)) / math.pi) / 2 * n)
        return max(0, min(n - 1, x)), max(0, min(n - 1, y))

    def tiles_in_bbox(s, w, n, e, zmin, zmax):
        for z in range(zmin, zmax + 1):
            x0, y0 = _lonlat_to_tile(w, n, z)
            x1, y1 = _lonlat_to_tile(e, s, z)
            for x in range(min(x0, x1), max(x0, x1) + 1):
                for y in range(min(y0, y1), max(y0, y1) + 1):
                    yield z, x, y

# Domain modules extracted from the Handler (#88): ExifTool orchestration + the
# cached-proxy core. Pure-stdlib and required by the exif/proxy endpoints, so
# import hard (no frozen fallback).
from geosint import exif as exif_domain
from geosint import proxy as proxy_domain
from geosint import egress as egress_domain


# Opener that refuses to follow 3xx redirects. The /api/pget and /tiles proxies
# only fetch allowlisted hosts; without this, an allowlisted host (or a DNS/MITM
# attacker on the path) could 302 us to an internal address — classic SSRF pivot.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_no_redirect_opener = urllib.request.build_opener(_NoRedirect)

# Hard ceiling on any single proxied response, so an upstream can't exhaust RAM/disk.
MAX_UPSTREAM_BYTES = 64 * 1024 * 1024

# ---- OPSEC egress routing (Axis A — geosint/egress.py) ----------------------
# Per-feature outbound routing (direct / VPN-verified / residential proxy / Tor)
# lives in geosint/egress.py; here we hold the active config and a thin helper
# that resolves a feature to (opener, UA) and enforces the fail-closed VPN gate.
# The config is read from opsec.json (next to the cache, chmod 600) and reloaded
# on POST /api/opsec. Default config = every feature "direct" => behaviour is
# byte-for-byte the pre-OPSEC server until the analyst opts in.
OPSEC_CONFIG_PATH = DATA_ROOT / "opsec.json"
_opsec_cfg = [None]
_opsec_lock = threading.Lock()


def current_opsec():
    if _opsec_cfg[0] is None:
        _opsec_cfg[0] = egress_domain.load_config(OPSEC_CONFIG_PATH)
    return _opsec_cfg[0]


def reload_opsec():
    _opsec_cfg[0] = egress_domain.load_config(OPSEC_CONFIG_PATH)
    egress_domain.reset_openers()
    return _opsec_cfg[0]


def _egress(feature):
    """Resolve a feature to (opener, user_agent) for this request, enforcing the
    fail-closed VPN gate. Raises egress.EgressError when the route is blocked or
    misconfigured — every caller already treats a raised fetch as a clean upstream
    failure (cache-or-error), so a blocked route degrades gracefully, never leaks."""
    cfg = current_opsec()
    allowed, reason = egress_domain.egress_allowed(feature, cfg)
    if not allowed:
        raise egress_domain.EgressError(reason)
    opener = egress_domain.opener_for(egress_domain.resolve(feature, cfg), cfg, _NoRedirect)
    return opener, egress_domain.ua_for(cfg, UA)


def upstream_get(url: str, timeout=30, feature="tiles") -> bytes:
    opener, ua = _egress(feature)             # per-feature route + UA + VPN gate
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with opener.open(req, timeout=timeout) as r:
        # Read one byte past the ceiling so we can DETECT an oversize body and
        # raise — rather than silently truncating it. Truncating would cache a
        # corrupt (partial) tile/JSON; raising makes every caller treat it as a
        # clean upstream failure (its except: block) and never cache a fragment.
        body = r.read(MAX_UPSTREAM_BYTES + 1)
        if len(body) > MAX_UPSTREAM_BYTES:
            raise ValueError("upstream response too large")
        return body


def _host_name(host: str) -> str:
    """Strip a trailing :port from a Host header value, robust to IPv6.

    The Host header can be any of: `[v6]:port`, `[v6]`, `host:port`, `host`, or a
    bare unbracketed IPv6 literal (`::1`, `fe80::1`). We must NOT mistake the
    colons inside an unbracketed v6 for a port separator, nor fabricate a closing
    bracket for a malformed `[::1`. Returns the lower-cased hostname (brackets
    preserved for bracketed forms, so it matches the `[::1]` entry in the
    allowlist; a bare `::1` stays bare to match the `::1` entry)."""
    host = (host or "").strip().lower()
    if host.startswith("["):
        # Bracketed IPv6: take exactly up to (and including) the closing bracket.
        # No `]` -> malformed; return as-is so it simply fails the allowlist match
        # rather than being silently "repaired" into something that could match.
        end = host.find("]")
        return host if end == -1 else host[:end + 1]
    # Unbracketed: a single colon is host:port; multiple colons is a bare IPv6
    # literal (no port) and must be left intact.
    if host.count(":") == 1:
        return host.rsplit(":", 1)[0]
    return host


def _host_of(url: str) -> str:
    """Just the host of a URL — safe to log. The full URL (pget/overpass/tile)
    can embed coordinates or a query, which we never write to the log."""
    try:
        return urlparse(url).netloc or "?"
    except ValueError:
        return "?"


_img_hosts = [None]


def _img_host_allow():
    """Allowlist of image hosts the /api/img proxy may fetch, so it can't be turned
    into an open image-fetch SSRF. Derived once from the hosts actually referenced
    by the shipped search index (first-party-curated reference imagery), plus a few
    well-known fallbacks. Lazy + cached (the index is large)."""
    if _img_hosts[0] is None:
        hosts = {"geohints.com", "upload.wikimedia.org", "commons.wikimedia.org"}
        try:
            txt = (APP_DIR / "data" / "search-index.json").read_text(
                encoding="utf-8", errors="ignore")
            for m in re.finditer(r'"img"\s*:\s*"https?://([^/"]+)', txt):
                hosts.add(m.group(1).lower())
        except OSError:
            pass
        _img_hosts[0] = hosts
    return _img_hosts[0]


def _img_host_ok(host):
    host = (host or "").lower()
    return bool(host) and any(host == h or host.endswith("." + h)
                              for h in _img_host_allow())


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

    def send_file(self, path: Path, frameable=False):
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
        #   frameable=True (wiki pages only): allow SAME-ORIGIN framing so the SPA
        #   can dock the wiki in a panel iframe. The SPA itself stays unframeable.
        #   The wiki is static reference content with no actions/secrets, so the
        #   clickjacking surface this opens is negligible.
        if ctype == "text/html":
            frame_ancestors = "'self'" if frameable else "'none'"
            # Wiki (frameable) pages legitimately hotlink remote identification-
            # gallery images, so they keep https: in img-src. The SPA/app pages now
            # proxy every remote image — GBIF density tiles via /api/gbif/tile and
            # wiki-search reference images via /api/img — so they tighten img-src to
            # self/data/blob: no arbitrary https image host can be contacted, closing
            # the browser-direct image leaks the egress audit flagged.
            img_src = "'self' data: blob: https:" if frameable else "'self' data: blob:"
            self.send_header("Content-Security-Policy",
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                f"img-src {img_src}; "
                "connect-src 'self' https:; "
                f"frame-ancestors {frame_ancestors}; base-uri 'self'")
            # X-Frame-Options can't express "self only" portably; emit DENY only when
            # framing is disallowed and let the CSP frame-ancestors govern the wiki.
            if not frameable:
                self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
        elif ctype == "image/svg+xml":
            # SVG is an active document (it can carry <script>/external refs), so a
            # raw SVG hit directly in a tab is an XSS vector. Lock it down: no
            # scripts/fetches at all, inline styles only (legit decorative SVGs),
            # sandboxed, and force inline display rather than letting it act as a
            # top-level navigable document.
            self.send_header("Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; sandbox")
            self.send_header("Content-Disposition", "inline")
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
        name = _host_name(host)
        if name not in ALLOWED_HOSTNAMES:
            return False
        # Accepted via the hostname fallback. If we are bound off-loopback and the
        # accepted name is a bare loopback alias, a network peer reached the exposed
        # port and forged `Host: localhost` to slip past the rebinding guard — log
        # it (throttled) so the operator sees the exposure they were warned about.
        if OFF_LOOPBACK_BIND and name in ("127.0.0.1", "localhost", "[::1]", "::1"):
            now = time.monotonic()
            if now - _off_loopback_warn_at[0] > 60:
                _off_loopback_warn_at[0] = now
                sys.stderr.write(
                    f"[geosint] WARNING: request accepted via loopback Host '{name}' while bound "
                    f"off-loopback — a network peer may be reaching this exposed port. "
                    f"Publish only to 127.0.0.1, or restrict with --allow-host.\n")
        return True

    def _is_cross_site(self):
        """True iff the browser explicitly flagged this request as cross-site.

        The cache-writing GET proxies (/api/pget, /tiles) are not behind the
        POST-only X-GeOSINT CSRF header, so a malicious page could drive them
        cross-origin to launder requests through the allowlist or poison the
        durable on-disk cache for the analyst's future lookups (SEC-01).

        `Sec-Fetch-Site` is set by the browser and cannot be forged by page JS.
        We reject ONLY the unambiguous `cross-site` value: the SPA's own requests
        are `same-origin`, and clients that send no Sec-Fetch-* header at all
        (older browsers, curl, the container HEALTHCHECK) are allowed through so
        we don't break legitimate non-browser/loopback use. `same-site` is left
        permitted (there is no other site on loopback to distinguish it from)."""
        return self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site"

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
        "/api/opsec": "api_opsec_set",
    }
    # Raw-bytes POST routes (handled before JSON parsing — they take image bytes).
    POST_RAW_PATHS = {"/api/exif", "/api/exif-preview"}

    # Known routes per method, for 405 (path exists but wrong verb) vs 404.
    GET_PATHS = {"/", "/index.html", "/api/pget", "/wiki", "/api/status",
                 "/api/health", "/api/opsec", "/api/opsec/check", "/api/img"}
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
                                     or path.startswith("/wiki") or path.startswith("/tiles/")
                                     or path.startswith("/api/gbif/tile/")):
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

    def serve_static(self, base: Path, rel: str, frameable=False):
        # Safe path resolution: never escape the base directory. The check is
        # separator-aware (plain startswith would let ".../app" match ".../app2").
        target = (base / unquote(rel)).resolve()
        root = base.resolve()
        if target != root and root not in target.parents:
            return self.send_json({"error": "forbidden"}, 403)
        if target.is_dir():
            target = target / "index.html"
        if target.is_file():
            return self.send_file(target, frameable=frameable)
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

    def render(self, result):
        """Map a DomainResult (from geosint/exif.py, geosint/proxy.py) to an HTTP
        response. The domain function already decided what is safe for the client;
        here we only route: unsafe `log_detail` -> _warn (operator log), the safe
        `client_msg` -> the response body. This is the thin-handler seam (#88)."""
        if not result.ok:
            if result.log_detail:
                self._warn("", result.log_where or "", result.log_detail)
            return self.send_json({"error": result.client_msg}, result.status)
        if result.body is not None:          # raw-bytes success (proxied image/JSON)
            return self.send_cached_body(result.body, result.ctype,
                                         result.cache_state or "miss", result.browser_ttl)
        return self.send_json(result.data, result.status)

    # ---- cached tile proxy: /tiles/<layer>/<z>/<x>/<y> -------------------
    def api_tile(self, path):
        # SEC-01: refuse an explicit cross-site drive-by before any cache read or
        # upstream fetch, so it can neither launder a request nor poison the cache.
        if self._is_cross_site():
            return self.send_json({"error": "cross-site request refused"}, 403)
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
        url = TILE_LAYERS[layer].format(z=z, x=x, y=y)
        return self.render(proxy_domain.fetch_cached(
            f, url, TILE_TTL, "image/png", timeout=20,
            fetch=lambda u, timeout: upstream_get(u, timeout, feature="tiles"),
            cache_fresh=cache_fresh, atomic_write=atomic_write,
            log_where=_host_of(url), browser_ttl=TILE_TTL, stale_browser_ttl=3600,
            error_msg="tile upstream unreachable"))

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
        # Validate the bbox itself (mirrors api_flyto's coordinate guard): reject
        # out-of-range or swapped corners before computing the tile list, which
        # would otherwise silently degenerate or cover the wrong area.
        if not (-90 <= s <= n <= 90 and -180 <= w <= e <= 180):
            return self.send_json({"error": "bbox must be [s,w,n,e] with -90<=s<=n<=90 and -180<=w<=e<=180"}, 400)
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
                body = upstream_get(TILE_LAYERS[layer].format(z=z, x=x, y=y), timeout=20, feature="tiles")
                atomic_write(f, body)
                fetched += 1
                time.sleep(0.05)                  # gentle on the tile server
            except Exception:
                failed += 1                       # surfaced in the `failed` count
        remaining = len(tiles) - processed
        # `done` must be honest: a run is complete only when every tile was
        # processed AND none failed. `processed` counts started tiles (including
        # failures), so `remaining == 0` alone would report done:true even with
        # failed>0 — the client would never resume to retry the failures.
        done = (processed == len(tiles) and failed == 0)
        return self.send_json({"ok": True, "layer": layer, "tiles": len(tiles),
                               "fetched": fetched, "cached": cached, "failed": failed,
                               "remaining": remaining, "done": done})

    # ---- generic cached GET proxy: /api/pget?u=<allowlisted url> ---------
    def api_pget(self, query):
        # SEC-01: refuse an explicit cross-site drive-by before any cache read or
        # upstream fetch (same rationale as api_tile).
        if self._is_cross_site():
            return self.send_json({"error": "cross-site request refused"}, 403)
        url = urllib.parse.parse_qs(query).get("u", [""])[0]
        if not url:                               # missing required param is a bad request, not "forbidden"
            return self.send_json({"error": "missing 'u' parameter"}, 400)
        ttl = next((t for prefix, t in PGET_ALLOW if url.startswith(prefix)), None)
        if ttl is None:
            return self.send_json({"error": "url not allowlisted"}, 403)
        # Map the allowlisted upstream to its OPSEC feature so each can be routed
        # independently (e.g. geocoding via Tor, weather direct).
        feat = ("geocode" if "nominatim" in url else
                "gbif" if "gbif.org" in url else "weather")
        f = PGET_CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".json")
        return self.render(proxy_domain.fetch_cached(
            f, url, ttl, "application/json; charset=utf-8", timeout=30,
            fetch=lambda u, timeout: upstream_get(u, timeout, feature=feat),
            cache_fresh=cache_fresh, atomic_write=atomic_write,
            validate=json.loads, log_where=_host_of(url), error_msg="upstream failed"))

    # ---- OPSEC egress settings (Axis A) --------------------------------
    def api_opsec_get(self):
        """Return the active OPSEC egress config (proxy passwords masked)."""
        if self._is_cross_site():
            return self.send_json({"error": "cross-site request refused"}, 403)
        return self.send_json({"config": egress_domain.masked(current_opsec()),
                               "features": list(egress_domain.FEATURES)})

    def api_opsec_set(self, payload):
        """Persist a new OPSEC config (X-GeOSINT-gated). A password that comes back
        masked keeps the stored secret; the file is written chmod 600; openers are
        reset so new routing takes effect at once. Best-effort verify so the VPN
        gate has fresh state — the save never fails on the verification."""
        cfg = payload.get("config") if isinstance(payload, dict) else None
        if not isinstance(cfg, dict):
            return self.send_json({"error": "config object required"}, 400)
        with _opsec_lock:
            merged = egress_domain.merge_secrets(cfg, current_opsec())
            try:
                egress_domain.save_config(OPSEC_CONFIG_PATH, merged, atomic_write=atomic_write)
            except OSError as e:
                self._warn("/api/opsec", "save", e)
                return self.send_json({"error": "could not save OPSEC config"}, 500)
            reload_opsec()
        check = None
        if current_opsec()["vpn"]["provider"]:
            try:
                check = egress_domain.check_egress(current_opsec(), _NoRedirect,
                                                   now=time.monotonic())
            except egress_domain.EgressError as e:
                self._warn("/api/opsec", "verify", e)
        return self.send_json({"ok": True,
                               "config": egress_domain.masked(current_opsec()),
                               "check": check})

    def api_opsec_check(self):
        """Verify the current egress: fetch the provider IP-echo through the VPN/
        direct opener and report apparent IP / country / org / on_vpn."""
        if self._is_cross_site():
            return self.send_json({"error": "cross-site request refused"}, 403)
        try:
            return self.send_json(egress_domain.check_egress(
                current_opsec(), _NoRedirect, now=time.monotonic()))
        except egress_domain.EgressError as e:
            self._warn("/api/opsec/check", "egress", e)
            return self.send_json({"ok": False, "error": "egress check failed"}, 502)

    # ---- GBIF density-tile proxy (closes the browser-direct GBIF leak) ----
    def api_gbif_tile(self, path, query):
        """Proxy + cache GBIF occurrence-density tiles that the browser used to
        fetch straight from api.gbif.org (leaking the analyst's IP/UA + species of
        interest). Routed via the OPSEC 'gbif' feature; params are allowlisted so
        the {z}/{x}/{y} path can't be steered to another host."""
        if self._is_cross_site():
            return self.send_json({"error": "cross-site request refused"}, 403)
        parts = path.strip("/").split("/")          # api, gbif, tile, z, x, y
        if len(parts) != 6 or not all(re.fullmatch(r"\d+", p) for p in parts[3:6]):
            return self.send_json({"error": "bad gbif tile path"}, 400)
        z, x, y = (int(p) for p in parts[3:6])
        if not (0 <= z <= 19):
            return self.send_json({"error": "bad zoom"}, 400)
        n = 1 << z
        if not (0 <= x < n and 0 <= y < n):
            return self.send_json({"error": "tile coords out of range"}, 400)
        qs = urllib.parse.parse_qs(query)
        taxon = qs.get("taxonKey", [""])[0]
        if not re.fullmatch(r"\d{1,12}", taxon):
            return self.send_json({"error": "bad taxonKey"}, 400)
        bin_ = qs.get("bin", ["hex"])[0]
        if bin_ not in GBIF_TILE_BINS:
            bin_ = "hex"
        hpt = qs.get("hexPerTile", ["100"])[0]
        if not re.fullmatch(r"\d{1,4}", hpt):
            hpt = "100"
        style = qs.get("style", ["purpleYellow-noborder.poly"])[0]
        if style not in GBIF_TILE_STYLES:
            style = "purpleYellow-noborder.poly"
        url = (f"https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png"
               f"?taxonKey={taxon}&bin={bin_}&hexPerTile={hpt}&style={style}")
        f = GBIF_TILE_CACHE / taxon / bin_ / str(z) / str(x) / f"{y}.png"
        return self.render(proxy_domain.fetch_cached(
            f, url, GBIF_TILE_TTL, "image/png", timeout=20,
            fetch=lambda u, timeout: upstream_get(u, timeout, feature="gbif"),
            cache_fresh=cache_fresh, atomic_write=atomic_write,
            log_where="api.gbif.org", browser_ttl=GBIF_TILE_TTL, stale_browser_ttl=3600,
            error_msg="GBIF tiles unreachable"))

    # ---- wiki reference-image proxy (closes the hotlinked-image leak) -----
    def api_img(self, query):
        """Proxy + cache a wiki-search reference image so the browser no longer
        hotlinks it straight to a third party (geohints.com etc.) on every search.
        Host is suffix-allowlisted (to the hosts the shipped index references) so
        this can't become an open image-fetch SSRF; routed via the 'media' feature."""
        if self._is_cross_site():
            return self.send_json({"error": "cross-site request refused"}, 403)
        u = urllib.parse.parse_qs(query).get("u", [""])[0]
        if not u:
            return self.send_json({"error": "missing 'u' parameter"}, 400)
        if not u.startswith(("http://", "https://")):
            return self.send_json({"error": "bad url"}, 400)
        if not _img_host_ok(urlparse(u).hostname):
            return self.send_json({"error": "image host not allowlisted"}, 403)
        ctype = mimetypes.guess_type(u)[0] or "image/jpeg"
        if not ctype.startswith("image/"):
            ctype = "image/jpeg"
        f = IMG_CACHE / (hashlib.sha1(u.encode()).hexdigest() + ".img")
        return self.render(proxy_domain.fetch_cached(
            f, u, IMG_TTL, ctype, timeout=20,
            fetch=lambda url, timeout: upstream_get(url, timeout, feature="media"),
            cache_fresh=cache_fresh, atomic_write=atomic_write,
            log_where=_host_of(u), browser_ttl=IMG_TTL, stale_browser_ttl=3600,
            error_msg="image upstream unreachable"))

    # ---- routes --------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        # Liveness probe: cheap, no tool detection, and exempt from the Host guard
        # so a container HEALTHCHECK (which probes via the container's own
        # IP/hostname, not loopback) isn't rejected as a bad host. It returns no
        # data beyond {"ok": true, "version"}, so skipping the guard leaks nothing.
        if path == "/api/health":
            return self.send_json({"ok": True, "version": VERSION})
        if not self.host_ok():
            return self.send_json({"error": "bad host"}, 403)
        if path in ("/", "/index.html"):
            return self.redirect("/app/")
        # Browsers probe the site root for a favicon whether or not our pages
        # carry a <link rel="icon"> (#135) — point them at the real asset so a
        # 404 doesn't land in the operator's log on every page load.
        if path == "/favicon.ico":
            return self.redirect("/app/favicon.svg")
        if path.startswith("/tiles/"):
            return self.api_tile(path)
        if path == "/api/pget":
            return self.api_pget(parsed.query)
        if path.startswith("/api/gbif/tile/"):
            return self.api_gbif_tile(path, parsed.query)
        if path == "/api/img":
            return self.api_img(parsed.query)
        if path == "/api/opsec":
            return self.api_opsec_get()
        if path == "/api/opsec/check":
            return self.api_opsec_check()
        if path == "/wiki":
            return self.redirect("/wiki/")
        if path == "/api/status":
            return self.send_json({
                "version": VERSION,
                "platform": PLATFORM,
                "tools": tool_status(),
                "wiki_built": (WIKI_SITE / "index.html").is_file(),
                "opsec": egress_domain.masked(current_opsec()),   # routes only; creds masked
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
                if self.command != "HEAD":        # HEAD must not carry a body
                    self.wfile.write(body)
                return
            # frameable: the SPA docks wiki pages in a panel iframe (same-origin).
            return self.serve_static(WIKI_SITE, path[len("/wiki"):].lstrip("/"), frameable=True)
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
        name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(payload.get("name") or "geosint"))[:40] or "geosint"
        f = out / f"{name}.geojson"
        atomic_write(f, json.dumps(fc).encode("utf-8"))
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
        # OPSEC: resolve the "overpass" route (residential proxy / Tor / VPN gate)
        # once before the failover loop. A blocked or misconfigured route skips the
        # network entirely and falls through to the stale-cache / error path below,
        # so the bbox in the query body is never sent on a disallowed egress.
        try:
            opener, ua = _egress("overpass")
        except egress_domain.EgressError as e:
            opener, ua, mirrors = None, None, []
            last_err = str(e)[:200]
        for mirror in mirrors:
            try:
                req = urllib.request.Request(mirror, data=data,
                                             headers={"User-Agent": ua})
                with opener.open(req, timeout=OVERPASS_TIMEOUT) as resp:
                    # Read one byte past the ceiling to DETECT an oversize body and
                    # raise (caught below), rather than silently truncating — same
                    # contract as upstream_get(). Avoids caching a partial response.
                    body = resp.read(MAX_UPSTREAM_BYTES + 1)
                    if len(body) > MAX_UPSTREAM_BYTES:
                        raise ValueError("overpass response too large")
                json.loads(body)            # validate before caching
                _preferred_mirror[0] = mirror
                atomic_write(cached, body)
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
            _chmod_600(f.name)            # owner-only: uploaded image is private
            f.write(raw)
            return Path(f.name)

    # ---- API: ExifTool deep metadata dump -------------------------------
    def api_exif(self, raw: bytes):
        """Run local ExifTool on an uploaded image; body = raw bytes,
        X-Filename header used only for the temp file extension. The request
        validation + tool probe stay here (they are HTTP-shaped); the ExifTool
        orchestration + scrubbing live in geosint/exif.run_exif (#88)."""
        # Validate the request (400/413) before probing for the tool (409), so a
        # bad request reports the bad request, not "tool missing".
        if not raw:
            return self.send_json({"error": "empty body"}, 400)
        if len(raw) > EXIF_MAX_BYTES:
            return self.send_json({"error": "file too large"}, 413)
        exiftool = find_exiftool()
        if exiftool is None:
            return self.send_json({"error": "ExifTool not found. Install: winget install OliverBetz.ExifTool"}, 409)
        return self.render(exif_domain.run_exif(raw, exiftool, self._write_exif_temp))

    # ---- API: extract the largest embedded preview/thumbnail -------------
    # Embedded previews are often the *uncropped* original — when an image is
    # cropped or redacted before sharing, the buried preview can still show what
    # was cut out. We also read the preview's OWN gps/time and flag any mismatch
    # with the main image (a tampering/splicing signal). Returns the preview as
    # raw image bytes; the forensic analysis rides in X-* response headers.
    PREVIEW_TAGS = ("JpgFromRaw", "PreviewImage", "OtherImage", "ThumbnailImage")

    def _write_private_temp(self, body: bytes) -> Path:
        """Owner-only (0600) temp file for an extracted preview (it is private)."""
        with tempfile.NamedTemporaryFile(prefix="geosint_prev_", suffix=".jpg", delete=False) as pf:
            _chmod_600(pf.name)
            pf.write(body)
            return Path(pf.name)

    def api_exif_preview(self, raw: bytes):
        if not raw:
            return self.send_json({"error": "empty body"}, 400)
        if len(raw) > EXIF_MAX_BYTES:
            return self.send_json({"error": "file too large"}, 413)
        exiftool = find_exiftool()
        if exiftool is None:
            return self.send_json({"error": "ExifTool not found. Install: winget install OliverBetz.ExifTool"}, 409)
        # Domain: extract the preview + the GPS/time-mismatch forensic analysis
        # (geosint/exif). The X-* header construction is genuinely HTTP, so it
        # stays here — we render the structured analysis into the response.
        res = exif_domain.analyze_preview(raw, exiftool, self._write_exif_temp,
                                          self._write_private_temp, self.PREVIEW_TAGS)
        if not res.ok or not res.data.get("has_preview"):
            return self.render(res)        # error, or the "no preview" 200 JSON

        a = res.data
        body = a["body"]
        # EXIF-derived header values are attacker-controlled — strip CR/LF and cap
        # length so they can't split the response / inject headers.
        def _hv(v):
            return re.sub(r"[\r\n]", " ", str(v))[:80]
        self.send_response(200)
        self.send_header("Content-Type", a["ctype"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Preview-Tag", _hv(a["tag"]))
        self.send_header("X-Preview-Bytes", str(a["bytes"]))
        if a["main_gps"]:  self.send_header("X-Main-GPS", _hv(a["main_gps"]))
        if a["prev_gps"]:  self.send_header("X-Preview-GPS", _hv(a["prev_gps"]))
        if a["main_time"]: self.send_header("X-Main-Time", _hv(a["main_time"]))
        if a["prev_time"]: self.send_header("X-Preview-Time", _hv(a["prev_time"]))
        self.send_header("X-GPS-Mismatch", "1" if a["gps_mismatch"] else "0")
        self.send_header("X-Time-Mismatch", "1" if a["time_mismatch"] else "0")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

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
                _reap_children()             # opportunistic zombie sweep (POSIX)
                gui = ROOT / "tools" / "sherloq" / "gui" / "sherloq.py"
                subprocess.Popen([str(path), str(gui)], cwd=str(gui.parent), **_DETACH)
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
            _chmod_600(f.name)            # owner-only: the KML embeds the target coordinate
            f.write(kml)
            kml_path = Path(f.name)
        _open_document_with(gep, kml_path)       # opens the KML in GE Pro, cross-platform
        return self.send_json({"ok": True, "kml": str(kml_path)})


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that doesn't cry wolf over routine disconnects (#134).

    A client dropping a keep-alive connection — closing the tab, navigating away,
    a probe that hangs up — surfaces here as ConnectionReset/BrokenPipe/
    ConnectionAborted from `rfile.readline`. The stdlib default prints a full
    traceback to stderr, which is the *foreground console* the operator watches
    (`run.bat` keeps it open), so normal browsing looks like a crash and buries
    the real request log. Swallow only those three; anything else keeps its
    traceback, since a genuine handler bug must stay loud."""

    _BENIGN = (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], self._BENIGN):
            super().handle_error(request, client_address)


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
    global ALLOWED_HOSTS, ALLOWED_HOSTNAMES, OFF_LOOPBACK_BIND
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
    OFF_LOOPBACK_BIND = not loopback
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

    # Load the OPSEC egress config (opsec.json) up front so the first request
    # doesn't pay the read, and surface any active routing in the startup banner.
    opsec0 = reload_opsec()
    _routed = {f: r for f, r in opsec0["routes"].items() if r != "direct"}
    if _routed or opsec0["ua"] != "default":
        print(f"[geosint] OPSEC egress routing: {_routed or '(per-UA only)'}  ua={opsec0['ua']}")

    try:
        srv = QuietThreadingHTTPServer((args.host, args.port), Handler)
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
