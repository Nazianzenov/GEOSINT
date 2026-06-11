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
import json
import mimetypes
import os
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
OVERPASS_CACHE = ROOT / "cache" / "overpass"
OVERPASS_TTL = 7 * 86400
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "GeOSINT-Workbench/1.0 (local personal OSINT tool; non-commercial)"
LOCALAPPDATA = os.environ.get("LOCALAPPDATA", "")

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
    return _first_existing([
        r"C:\Program Files\QGIS*\bin\qgis-ltr-bin.exe",
        r"C:\Program Files\QGIS*\bin\qgis-bin.exe",
        r"C:\OSGeo4W\bin\qgis-ltr-bin.exe",
        r"C:\OSGeo4W\bin\qgis-bin.exe",
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

    # ---- routes --------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self.redirect("/app/")
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
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if path == "/api/exif":
            return self.api_exif(raw)

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
        self.send_json({"error": "not found"}, 404)

    # ---- API: cached Overpass proxy --------------------------------------
    def api_overpass(self, payload):
        """Run an Overpass QL query with a 7-day local file cache."""
        q = str(payload.get("q") or "")
        if not (10 < len(q) < 6000) or "out" not in q:
            return self.send_json({"error": "invalid query"}, 400)
        OVERPASS_CACHE.mkdir(parents=True, exist_ok=True)
        cached = OVERPASS_CACHE / (hashlib.sha1(q.encode()).hexdigest() + ".json")
        if cached.is_file() and time.time() - cached.stat().st_mtime < OVERPASS_TTL:
            body = cached.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Cache", "hit")
            self.end_headers()
            self.wfile.write(body)
            return
        data = ("data=" + urllib.parse.quote(q)).encode()
        last_err = "no mirror reachable"
        for mirror in OVERPASS_MIRRORS:
            try:
                req = urllib.request.Request(mirror, data=data,
                                             headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=90) as resp:
                    body = resp.read()
                json.loads(body)            # validate before caching
                cached.write_bytes(body)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Cache", "miss")
                self.end_headers()
                self.wfile.write(body)
                return
            except Exception as e:
                last_err = str(e)[:200]
        return self.send_json({"error": f"Overpass unreachable: {last_err}"}, 502)

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
        name = Path(unquote(self.headers.get("X-Filename") or "image.jpg")).name
        suffix = Path(name).suffix or ".jpg"
        tmp = None
        try:
            with tempfile.NamedTemporaryFile(prefix="geosint_", suffix=suffix, delete=False) as f:
                tmp = Path(f.name)
                f.write(raw)
            proc = subprocess.run(
                [str(exiftool), "-json", "-a", "-G1", "-api", "largefilesupport=1", str(tmp)],
                capture_output=True, timeout=30,
            )
            if proc.returncode not in (0, 1):  # 1 = minor warnings
                return self.send_json({"error": proc.stderr.decode("utf-8", "replace")[:500]}, 500)
            data = json.loads(proc.stdout.decode("utf-8", "replace"))
            tags = data[0] if data else {}
            tags.pop("SourceFile", None)
            tags.get("System:FileName") and tags.pop("System:FileName", None)
            # System group leaks temp paths — drop it
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
        kml_path = Path(tempfile.gettempdir()) / "geosint_flyto.kml"
        kml_path.write_text(kml, encoding="utf-8")
        subprocess.Popen([str(gep), str(kml_path)])
        return self.send_json({"ok": True, "kml": str(kml_path)})


def main():
    ap = argparse.ArgumentParser(description="GeOSINT Workbench server")
    ap.add_argument("--port", type=int, default=8650)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

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
