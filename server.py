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

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
WIKI_SITE = ROOT / "wiki" / "site"
CACHE = ROOT / "cache"
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

# /api/pget?u=<url> — generic cached GET proxy, allowlisted prefixes only.
# Historical weather and elevation never change -> effectively permanent.
PGET_ALLOW = [
    ("https://archive-api.open-meteo.com/v1/archive?", 3650 * 86400),
    ("https://api.open-meteo.com/v1/elevation?", 3650 * 86400),
    ("https://api.open-meteo.com/v1/forecast?", 3 * 3600),
    ("https://nominatim.openstreetmap.org/search?", 30 * 86400),
    ("https://api.gbif.org/v1/species/match?", 30 * 86400),
]
UA = "GeOSINT-Workbench/1.0 (local personal OSINT tool; non-commercial)"
LOCALAPPDATA = os.environ.get("LOCALAPPDATA", "")

# Temp-file extensions ExifTool is allowed to see. The suffix steers ExifTool's
# format handler and is attacker-controlled via X-Filename, so a hostile client
# can't aim it at a riskier parser. Shared by /api/exif and /api/exif-preview.
EXIF_SUFFIXES = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff", ".bmp",
    ".heic", ".heif", ".avif", ".dng", ".cr2", ".cr3", ".nef", ".arw",
    ".raf", ".orf", ".rw2", ".pef", ".srw", ".mp4", ".mov", ".jxl",
}

# Host header allowlist (set in main() once the port is known). Defends against
# DNS rebinding: a remote page that rebinds its hostname to 127.0.0.1 sends
# same-origin requests (carrying our X-GeOSINT header), defeating the CORS/CSRF
# guard — but the Host header it sends is the attacker's domain, not loopback.
ALLOWED_HOSTS = set()

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


def find_exiftool():
    w = shutil.which("exiftool")
    if w:
        return Path(w)
    return _first_existing([
        Path(LOCALAPPDATA) / "Programs" / "ExifTool" / "exiftool.exe",
        r"C:\Program Files\exiftool\exiftool.exe",
        r"C:\Program Files\exiftool\exiftool(-k).exe",
    ])


def find_google_earth_pro():
    return _first_existing([
        r"C:\Program Files\Google\Google Earth Pro\client\googleearth.exe",
        r"C:\Program Files (x86)\Google\Google Earth Pro\client\googleearth.exe",
    ])


def find_qgis():
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


def find_sherloq():
    # expected layout: tools/sherloq (git clone) with its own venv
    base = ROOT / "tools" / "sherloq"
    py = base / ".venv" / "Scripts" / "python.exe"
    gui = base / "gui" / "sherloq.py"
    if py.is_file() and gui.is_file():
        return py  # launched as: python gui/sherloq.py
    return None


TOOLS = {
    "exiftool": {
        "label": "ExifTool",
        "find": find_exiftool,
        "kind": "cli",
        "install": "winget install OliverBetz.ExifTool",
    },
    "google_earth_pro": {
        "label": "Google Earth Pro",
        "find": find_google_earth_pro,
        "kind": "gui",
        "install": "https://www.google.com/earth/about/versions/#earth-pro",
    },
    "qgis": {
        "label": "QGIS",
        "find": find_qgis,
        "kind": "gui",
        "install": "winget install OSGeo.QGIS.LTR  (~2 GB)",
    },
    "sherloq": {
        "label": "Sherloq (image forensics)",
        "find": find_sherloq,
        "kind": "gui",
        "install": "git clone https://github.com/GuidoBartoli/sherloq tools\\sherloq, "
                   "then create tools\\sherloq\\.venv and pip install -r gui/requirements.txt",
    },
}


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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[geosint] %s\n" % (fmt % args))

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
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def host_ok(self):
        """Reject requests whose Host header isn't our loopback bind — blocks
        DNS-rebinding attacks that would otherwise reach the local API."""
        host = (self.headers.get("Host") or "").strip().lower()
        # Bracketed IPv6 loopback or bare host with no port are also fine.
        if host in ALLOWED_HOSTS:
            return True
        hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        return hostname in ("127.0.0.1", "localhost", "[::1]", "::1")

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
        self.send_json({"error": "not found", "path": rel}, 404)

    def send_cached_body(self, body: bytes, ctype: str, hit: str, browser_ttl=0):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Cache", hit)
        if browser_ttl:
            self.send_header("Cache-Control", f"public, max-age={browser_ttl}")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ---- cached tile proxy: /tiles/<layer>/<z>/<x>/<y> -------------------
    def api_tile(self, path):
        parts = path.strip("/").split("/")          # tiles, layer, z, x, y
        if len(parts) != 5 or parts[1] not in TILE_LAYERS:
            return self.send_json({"error": "unknown tile layer"}, 404)
        layer = parts[1]
        try:
            z, x, y = (int(re.sub(r"\D", "", p)) for p in parts[2:5])
        except ValueError:
            return self.send_json({"error": "bad tile coords"}, 400)
        if not (0 <= z <= 20):
            return self.send_json({"error": "bad zoom"}, 400)
        f = TILE_CACHE / layer / str(z) / str(x) / f"{y}.png"
        if cache_fresh(f, TILE_TTL):
            return self.send_cached_body(f.read_bytes(), "image/png", "hit", TILE_TTL)
        url = TILE_LAYERS[layer].format(z=z, x=x, y=y)
        try:
            body = upstream_get(url, timeout=20)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
            return self.send_cached_body(body, "image/png", "miss", TILE_TTL)
        except Exception:
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
        MAX_TILES = 6000                          # ~politeness/disk guard
        if len(tiles) > MAX_TILES:
            return self.send_json({"error": f"{len(tiles)} tiles exceeds the {MAX_TILES} "
                                            f"cap — narrow the area or lower max zoom"}, 413)
        fetched = cached = failed = 0
        for z, x, y in tiles:
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
                failed += 1
        return self.send_json({"ok": True, "layer": layer, "tiles": len(tiles),
                               "fetched": fetched, "cached": cached, "failed": failed})

    # ---- generic cached GET proxy: /api/pget?u=<allowlisted url> ---------
    def api_pget(self, query):
        url = urllib.parse.parse_qs(query).get("u", [""])[0]
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
                "tools": tool_status(),
                "wiki_built": (WIKI_SITE / "index.html").is_file(),
            })
        if path.startswith("/app"):
            return self.serve_static(APP_DIR, path[len("/app"):].lstrip("/"))
        if path.startswith("/wiki"):
            if not (WIKI_SITE / "index.html").is_file():
                body = (b"<h1>Wiki not built yet</h1><p>Run <code>run.bat</code> "
                        b"(or <code>.venv\\Scripts\\mkdocs build -f wiki\\mkdocs.yml</code>) "
                        b"to build the wiki, then reload.</p>")
                self.send_response(503)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return self.serve_static(WIKI_SITE, path[len("/wiki"):].lstrip("/"))
        self.send_json({"error": "not found"}, 404)

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
        cap = 200 * 1024 * 1024 if path in ("/api/exif", "/api/exif-preview") else 2 * 1024 * 1024
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

        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "bad json"}, 400)
        if path == "/api/flyto":
            return self.api_flyto(payload)
        if path == "/api/launch":
            return self.api_launch(payload)
        if path == "/api/overpass":
            return self.api_overpass(payload)
        if path == "/api/qgis":
            return self.api_qgis(payload)
        if path == "/api/prefetch":
            return self.api_prefetch(payload)
        self.send_json({"error": "not found"}, 404)

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
            if qgis.suffix.lower() == ".bat":
                subprocess.Popen(["cmd", "/c", str(qgis), str(f)],
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                subprocess.Popen([str(qgis), str(f)])
            return self.send_json({"ok": True, "file": str(f), "features": len(feats)})
        except OSError as e:
            return self.send_json({"error": str(e)}, 500)

    # ---- API: cached Overpass proxy --------------------------------------
    def api_overpass(self, payload):
        """Run an Overpass QL query with a 7-day local file cache."""
        q = str(payload.get("q") or "")
        if not (10 < len(q) < 6000) or "out" not in q:
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
        exiftool = find_exiftool()
        if exiftool is None:
            return self.send_json({"error": "ExifTool not found. Install: winget install OliverBetz.ExifTool"}, 409)
        if not raw:
            return self.send_json({"error": "empty body"}, 400)
        if len(raw) > 200 * 1024 * 1024:
            return self.send_json({"error": "file too large"}, 413)
        tmp = None
        try:
            tmp = self._write_exif_temp(raw)
            proc = subprocess.run(
                [str(exiftool), "-json", "-a", "-G1", "-api", "largefilesupport=1", str(tmp)],
                capture_output=True, timeout=30,
            )
            if proc.returncode not in (0, 1):  # 1 = minor warnings
                return self.send_json({"error": proc.stderr.decode("utf-8", "replace")[:500]}, 500)
            data = json.loads(proc.stdout.decode("utf-8", "replace"))
            tags = data[0] if data else {}
            tags.pop("SourceFile", None)
            # System group leaks the temp file's path/name — drop it entirely
            tags = {k: v for k, v in tags.items() if not k.startswith("System:")}
            return self.send_json({"ok": True, "exiftool": str(exiftool), "tags": tags})
        except subprocess.TimeoutExpired:
            return self.send_json({"error": "exiftool timed out"}, 504)
        except (OSError, json.JSONDecodeError, ValueError) as e:
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
        exiftool = find_exiftool()
        if exiftool is None:
            return self.send_json({"error": "ExifTool not found. Install: winget install OliverBetz.ExifTool"}, 409)
        if not raw:
            return self.send_json({"error": "empty body"}, 400)
        if len(raw) > 200 * 1024 * 1024:
            return self.send_json({"error": "file too large"}, 413)
        tmp = prev_tmp = None
        try:
            tmp = self._write_exif_temp(raw)
            # find the first preview tag that has bytes, extract it to stdout
            chosen, body = None, b""
            for tag in self.PREVIEW_TAGS:
                try:
                    p = subprocess.run([str(exiftool), "-b", "-" + tag, str(tmp)],
                                       capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
                except subprocess.TimeoutExpired:
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
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Preview-Tag", chosen)
            self.send_header("X-Preview-Bytes", str(len(body)))
            if main_gps:  self.send_header("X-Main-GPS", main_gps)
            if prev_gps:  self.send_header("X-Preview-GPS", prev_gps)
            if main_time: self.send_header("X-Main-Time", main_time)
            if prev_time: self.send_header("X-Preview-Time", prev_time)
            self.send_header("X-GPS-Mismatch", "1" if gps_mismatch else "0")
            self.send_header("X-Time-Mismatch", "1" if time_mismatch else "0")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (OSError, ValueError) as e:
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
                gui = ROOT / "tools" / "sherloq" / "gui" / "sherloq.py"
                subprocess.Popen([str(path), str(gui)], cwd=str(gui.parent))
            elif path.suffix.lower() == ".bat":
                # run the launcher .bat via a hidden cmd so it sets up its
                # environment and no console window lingers
                subprocess.Popen(["cmd", "/c", str(path)],
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                subprocess.Popen([str(path)])
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
        subprocess.Popen([str(gep), str(kml_path)])
        return self.send_json({"ok": True, "kml": str(kml_path)})


def main():
    ap = argparse.ArgumentParser(description="GeOSINT Workbench server")
    ap.add_argument("--port", type=int, default=8650)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    # Lock the Host allowlist to this run's loopback bind (DNS-rebinding guard).
    global ALLOWED_HOSTS
    ALLOWED_HOSTS = {
        f"127.0.0.1:{args.port}", f"localhost:{args.port}", f"[::1]:{args.port}",
        "127.0.0.1", "localhost", "[::1]",
    }

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        print(f"Port {args.port} is already in use — the Workbench is probably already "
              f"running at http://127.0.0.1:{args.port}/app/ (or pass --port to use another).")
        sys.exit(1)
    url = f"http://127.0.0.1:{args.port}/app/"
    print(f"GeOSINT Workbench  ->  {url}")
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
