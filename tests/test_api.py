"""End-to-end API tests: start the real stdlib server on an ephemeral loopback
port and exercise the HTTP surface (routing, guards, validation, headers).

These run offline — only endpoints that don't require the network for their
*validation/error* paths are asserted on (we never assert a successful upstream
fetch, which would need internet). The server is pure stdlib, so no app deps."""
import json
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

from http.server import ThreadingHTTPServer  # noqa: E402

PORT = None
HOST = "127.0.0.1"


@pytest.fixture(scope="module", autouse=True)
def live_server():
    global PORT
    # mirror main()'s allowlist setup without parsing argv / opening a browser
    s = socket.socket(); s.bind((HOST, 0)); PORT = s.getsockname()[1]; s.close()
    server.ALLOWED_HOSTS = {f"{HOST}:{PORT}", f"localhost:{PORT}", HOST, "localhost"}
    server.ALLOWED_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]", "::1"}
    srv = ThreadingHTTPServer((HOST, PORT), server.Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    yield
    srv.shutdown()


def req(method, path, body=None, headers=None, raw=False):
    url = f"http://{HOST}:{PORT}{path}"
    data = None
    h = {"Host": f"{HOST}:{PORT}"}
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def jpost(path, body, csrf=True):
    h = {"X-GeOSINT": "1"} if csrf else {}
    return req("POST", path, body=body, headers=h)


# ── status ────────────────────────────────────────────────────────────────
def test_status_shape():
    st, _, body = req("GET", "/api/status")
    assert st == 200
    j = json.loads(body)
    assert j["version"] == server.VERSION
    assert j["platform"] == server.PLATFORM
    assert "tools" in j and "wiki_built" in j
    for t in j["tools"].values():
        assert {"label", "found", "path", "kind", "install"} <= set(t)


# ── health (liveness probe) ─────────────────────────────────────────────────
def test_health_ok():
    st, _, body = req("GET", "/api/health")
    assert st == 200
    j = json.loads(body)
    assert j == {"ok": True, "version": server.VERSION}


def test_health_exempt_from_host_guard():
    # A container HEALTHCHECK probes via the container's own host (not loopback);
    # /api/health must answer 200 even for a Host the rebinding guard would reject.
    st, _, _ = req("GET", "/api/health", headers={"Host": "evil.example.com"})
    assert st == 200


def test_health_wrong_verb_405():
    st, h, _ = jpost("/api/health", {})        # POST to a GET-only path
    assert st == 405 and "GET" in h.get("Allow", "")


# ── host / CSRF guards ──────────────────────────────────────────────────────
def test_bad_host_rejected():
    st, _, _ = req("GET", "/api/status", headers={"Host": "evil.example.com"})
    assert st == 403


def test_post_requires_csrf_header():
    st, _, body = jpost("/api/flyto", {"lat": 1, "lng": 2}, csrf=False)
    assert st == 403
    assert b"X-GeOSINT" in body


# ── pget allowlist ──────────────────────────────────────────────────────────
def test_pget_missing_param_is_400():
    st, _, _ = req("GET", "/api/pget")
    assert st == 400


def test_pget_non_allowlisted_403():
    st, _, _ = req("GET", "/api/pget?u=https://evil.example.com/x")
    assert st == 403


# ── tiles ───────────────────────────────────────────────────────────────────
def test_tiles_unknown_layer_404():
    st, _, _ = req("GET", "/tiles/nope/1/1/1")
    assert st == 404


def test_tiles_negative_zoom_rejected():
    # regression: re.sub(\D) used to strip the minus and accept z=-1 as z=1
    st, _, _ = req("GET", "/tiles/osm/-1/0/0")
    assert st == 400


def test_tiles_bad_zoom_400():
    st, _, _ = req("GET", "/tiles/osm/99/0/0")
    assert st == 400


def test_tiles_coord_out_of_range_400():
    st, _, _ = req("GET", "/tiles/osm/2/99/0")   # x must be < 2**2
    assert st == 400


# ── overpass validation ─────────────────────────────────────────────────────
def test_overpass_short_query_400():
    st, _, _ = jpost("/api/overpass", {"q": "short"})
    assert st == 400


def test_overpass_substring_out_rejected():
    # regression: "timeout"/"output" must NOT satisfy the `out` requirement
    st, _, _ = jpost("/api/overpass", {"q": "[timeout:5];node(1,2,3,4);"})
    assert st == 400


# ── exif: input validated before tool presence (400 before 409) ─────────────
def test_exif_empty_body_400_even_without_tool():
    # empty body is a 400 regardless of whether ExifTool is installed
    st, _, _ = jpost("/api/exif", b"")
    assert st == 400


def test_exif_preview_empty_body_400():
    st, _, _ = jpost("/api/exif-preview", b"")
    assert st == 400


# ── flyto / qgis validation (400 before the 409 tool-missing) ───────────────
def test_flyto_missing_coords_400():
    st, _, _ = jpost("/api/flyto", {})
    assert st == 400


def test_flyto_out_of_range_400():
    st, _, _ = jpost("/api/flyto", {"lat": 200, "lng": 0})
    assert st == 400


def test_qgis_bad_payload_400_before_tool_check():
    st, _, _ = jpost("/api/qgis", {})
    assert st == 400


def test_qgis_zero_features_400():
    st, _, _ = jpost("/api/qgis", {"geojson": {"type": "FeatureCollection", "features": []}})
    assert st == 400


# ── prefetch validation ─────────────────────────────────────────────────────
def test_prefetch_missing_bbox_400():
    st, _, _ = jpost("/api/prefetch", {"layer": "osm", "zmin": 1, "zmax": 1})
    assert st == 400


def test_prefetch_unknown_layer_400():
    st, _, _ = jpost("/api/prefetch", {"layer": "nope", "bbox": [0, 0, 1, 1], "zmin": 1, "zmax": 1})
    assert st == 400


def test_prefetch_tile_cap_413():
    st, _, _ = jpost("/api/prefetch", {"layer": "osm", "bbox": [-85, -180, 85, 180], "zmin": 0, "zmax": 12})
    assert st == 413


def test_prefetch_contract_done_when_complete(monkeypatch, tmp_path):
    # #29: a small bbox that finishes within the budget reports the full contract
    # with done:true / remaining:0. Stub the upstream so no real network is hit,
    # and redirect the tile cache to a temp dir so the test leaves no artifacts.
    monkeypatch.setattr(server, "upstream_get", lambda url, timeout=20: b"\x89PNG\r\n")
    monkeypatch.setattr(server, "TILE_CACHE", tmp_path / "tiles")
    st, _, body = jpost("/api/prefetch", {"layer": "osm", "bbox": [0, 0, 0.01, 0.01],
                                          "zmin": 1, "zmax": 1})
    assert st == 200
    j = json.loads(body)
    assert {"ok", "layer", "tiles", "fetched", "cached", "failed", "remaining", "done"} <= set(j)
    assert j["done"] is True and j["remaining"] == 0
    assert j["fetched"] + j["cached"] + j["failed"] == j["tiles"]


def test_prefetch_budget_stops_with_remaining(monkeypatch):
    # A zero budget stops before any tile is processed -> done:false, remaining=all.
    monkeypatch.setattr(server, "PREFETCH_BUDGET", 0)
    st, _, body = jpost("/api/prefetch", {"layer": "osm", "bbox": [0, 0, 1, 1],
                                          "zmin": 5, "zmax": 6})
    assert st == 200
    j = json.loads(body)
    assert j["done"] is False
    assert j["remaining"] == j["tiles"] and j["tiles"] > 0
    assert j["fetched"] == 0


# ── verb / 404 / 405 handling ───────────────────────────────────────────────
def test_wrong_verb_returns_405_with_allow():
    st, h, _ = jpost("/api/status", {})           # status is GET-only
    assert st == 405
    assert "GET" in h.get("Allow", "")


def test_get_on_post_route_405():
    st, h, _ = req("GET", "/api/flyto")
    assert st == 405 and "POST" in h.get("Allow", "")


def test_unknown_path_404():
    st, _, _ = req("GET", "/api/does-not-exist")
    assert st == 404


def test_put_rejected_405_not_html_501():
    st, h, _ = req("PUT", "/api/status")
    assert st == 405 and "Allow" in h


# ── security headers ────────────────────────────────────────────────────────
def test_html_has_security_headers():
    st, h, _ = req("GET", "/app/index.html")
    assert st == 200
    assert "default-src 'self'" in h.get("Content-Security-Policy", "")
    # the SPA itself is never frameable
    assert "frame-ancestors 'none'" in h.get("Content-Security-Policy", "")
    assert h.get("X-Frame-Options") == "DENY"
    assert h.get("X-Content-Type-Options") == "nosniff"


def test_wiki_is_same_origin_frameable():
    # Wiki pages allow same-origin framing (the SPA docks them in a panel iframe),
    # but NOT via X-Frame-Options: DENY, which would block even same-origin.
    st, h, _ = req("GET", "/wiki/index.html")
    if st == 503:
        import pytest
        pytest.skip("wiki not built in this checkout")
    assert st == 200
    assert "frame-ancestors 'self'" in h.get("Content-Security-Policy", "")
    assert "X-Frame-Options" not in h           # DENY would defeat the same-origin frame


def test_static_traversal_blocked():
    st, _, _ = req("GET", "/app/%2e%2e/%2e%2e/server.py")
    assert st in (403, 404)
    st2, _, _ = req("GET", "/app/../server.py")
    assert st2 in (403, 404)


# ── redacted dossier logic is JS, but the case-format guard is shared — n/a ──
