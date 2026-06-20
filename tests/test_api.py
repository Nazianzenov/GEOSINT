"""End-to-end API tests: start the real stdlib server on an ephemeral loopback
port and exercise the HTTP surface (routing, guards, validation, headers).

These run offline — only endpoints that don't require the network for their
*validation/error* paths are asserted on (we never assert a successful upstream
fetch, which would need internet). The server is pure stdlib, so no app deps."""
import json
import socket
import threading
import urllib.error
import urllib.parse
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


# ── .svg resolves to image/svg+xml so send_file's CSP/sandbox branch fires ────
def test_svg_mimetype_registered(tmp_path):
    # AUD-01/#108: send_file keys its SVG CSP/sandbox headers off guess_type
    # returning exactly "image/svg+xml". Importing server must register that
    # mapping deterministically (mimetypes can otherwise vary by OS/registry).
    import mimetypes
    f = tmp_path / "flag.svg"
    f.write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    assert mimetypes.guess_type(str(f))[0] == "image/svg+xml"


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


def test_prefetch_done_false_when_a_tile_fails(monkeypatch, tmp_path):
    # #91: `done` must be (processed==len(tiles) AND failed==0). A run where every
    # tile fails has processed==len(tiles) but failed>0, so it must report
    # done:false (the client resumes/retries) — not done:true on remaining==0.
    def boom(url, timeout=20):
        raise OSError("upstream down")
    monkeypatch.setattr(server, "upstream_get", boom)
    monkeypatch.setattr(server, "TILE_CACHE", tmp_path / "tiles")
    st, _, body = jpost("/api/prefetch", {"layer": "osm", "bbox": [0, 0, 0.01, 0.01],
                                          "zmin": 1, "zmax": 1})
    assert st == 200
    j = json.loads(body)
    assert j["tiles"] > 0
    assert j["failed"] == j["tiles"]      # every tile failed
    assert j["fetched"] == 0 and j["cached"] == 0
    assert j["remaining"] == 0            # all tiles were processed (started)
    assert j["done"] is False            # but failures mean it is NOT done


def test_prefetch_bbox_swapped_corners_400():
    # #100: api_prefetch validates the bbox after the zoom check. A swapped
    # bbox (s > n) is rejected with 400 before any tile is computed/fetched.
    st, _, _ = jpost("/api/prefetch", {"layer": "osm", "bbox": [1, 0, 0, 1],
                                       "zmin": 1, "zmax": 1})
    assert st == 400


def test_prefetch_bbox_out_of_range_400():
    # #100: an out-of-range latitude/longitude in the bbox -> 400.
    st, _, _ = jpost("/api/prefetch", {"layer": "osm", "bbox": [-100, 0, 100, 1],
                                       "zmin": 1, "zmax": 1})
    assert st == 400


# ── cached proxy: X-Cache miss -> hit, Cache-Control always present ──────────
def test_pget_miss_then_hit(monkeypatch, tmp_path):
    # First request populates the cache (X-Cache: miss); the second is served from
    # disk (X-Cache: hit). Stub the upstream so no network is hit and redirect the
    # pget cache to a temp dir so the test leaves no artifacts. Cache-Control must
    # always be emitted (proxied OSINT data must not get heuristic browser caching).
    monkeypatch.setattr(server, "PGET_CACHE", tmp_path / "pget")
    monkeypatch.setattr(server, "upstream_get",
                        lambda url, timeout=30: b'{"elevation":[123]}')
    url = "https://api.open-meteo.com/v1/elevation?latitude=0&longitude=0"
    q = "/api/pget?u=" + urllib.parse.quote(url, safe="")
    st1, h1, b1 = req("GET", q)
    assert st1 == 200
    assert h1.get("X-Cache") == "miss"
    assert "Cache-Control" in h1
    assert json.loads(b1) == {"elevation": [123]}
    st2, h2, _ = req("GET", q)
    assert st2 == 200
    assert h2.get("X-Cache") == "hit"
    assert "Cache-Control" in h2


# ── static serving: nested file + directory -> index.html ───────────────────
def test_serve_static_nested_file():
    # A real nested static asset is served (200) with a sane content type.
    st, h, body = req("GET", "/app/css/app.css")
    assert st == 200
    assert "text/css" in h.get("Content-Type", "")
    assert len(body) > 0


def test_serve_static_dir_serves_index_html():
    # A directory request resolves to its index.html (the /app/ root). The SPA's
    # index is HTML and carries the locked-down CSP, so assert both.
    st, h, body = req("GET", "/app/")
    assert st == 200
    assert "text/html" in h.get("Content-Type", "")
    assert "default-src 'self'" in h.get("Content-Security-Policy", "")
    assert len(body) > 0


# ── tiles: POST to a GET-only proxy is 405 (not 404/501) ────────────────────
def test_post_tiles_405():
    # /tiles/ exists only under GET/HEAD; a POST (carrying the CSRF header so it
    # reaches routing, not the 403 guard) must get 405 with an Allow listing GET.
    st, h, _ = jpost("/tiles/osm/1/1/1", {})
    assert st == 405
    assert "GET" in h.get("Allow", "")


# ── launch: unknown tool key is a 400 (bad request), not 409/500 ────────────
def test_launch_unknown_tool_400():
    st, _, body = jpost("/api/launch", {"tool": "definitely-not-a-tool"})
    assert st == 400
    assert b"unknown tool" in body


# ── HEAD on the unbuilt wiki: status returned, ZERO-LENGTH body (#94) ────────
def test_head_wiki_unbuilt_has_empty_body():
    # #94: do_HEAD delegates to do_GET; on the unbuilt-wiki 503 the handler must
    # NOT write the explanatory HTML body for a HEAD (a HEAD response carries no
    # body). Skip if the wiki happens to be built in this checkout.
    get_st, _, _ = req("GET", "/wiki/index.html")
    if get_st != 503:
        pytest.skip("wiki is built in this checkout")
    st, h, body = req("HEAD", "/wiki/index.html")
    assert st == 503
    assert body == b""                    # zero-length body on HEAD
    # Content-Length still advertises the would-be body size (HEAD semantics).
    assert int(h.get("Content-Length", "0")) > 0


# ── host_ok / _host_name: IPv6 Host parsing (#99) ───────────────────────────
def test_host_name_ipv6_parsing():
    # #99: _host_name strips a trailing :port robustly for IPv6, never mistaking
    # the colons inside a bare v6 literal for a port separator, and never
    # fabricating a bracket for a malformed value.
    assert server._host_name("[::1]:8650") == "[::1]"
    assert server._host_name("[::1]") == "[::1]"
    assert server._host_name("::1") == "::1"            # bare v6: left intact
    assert server._host_name("fe80::1") == "fe80::1"    # multi-colon: no port strip
    assert server._host_name("127.0.0.1:8650") == "127.0.0.1"
    assert server._host_name("localhost:8650") == "localhost"
    assert server._host_name("[::1") == "[::1"          # malformed: returned as-is


def test_host_guard_accepts_bracketed_ipv6_loopback():
    # End-to-end: the rebinding guard accepts the loopback IPv6 Host names (port
    # stripped via _host_name), so an IPv6 Docker/loopback client isn't rejected.
    st, _, _ = req("GET", "/api/status", headers={"Host": "[::1]:9999"})
    assert st == 200
    st2, _, _ = req("GET", "/api/status", headers={"Host": "[::1]"})
    assert st2 == 200


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
