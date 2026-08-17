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

PORT = None
HOST = "127.0.0.1"
SRV = None


@pytest.fixture(scope="module", autouse=True)
def live_server():
    global PORT, SRV
    # mirror main()'s allowlist setup without parsing argv / opening a browser
    s = socket.socket(); s.bind((HOST, 0)); PORT = s.getsockname()[1]; s.close()
    server.ALLOWED_HOSTS = {f"{HOST}:{PORT}", f"localhost:{PORT}", HOST, "localhost"}
    server.ALLOWED_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]", "::1"}
    # the shipping server class, so the error-handling tests below exercise what
    # main() actually runs
    SRV = server.QuietThreadingHTTPServer((HOST, PORT), server.Handler)
    t = threading.Thread(target=SRV.serve_forever, daemon=True); t.start()
    yield
    SRV.shutdown()


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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get_no_redirect(path):
    """GET without following the redirect, so a 3xx is observable (`req` uses
    urlopen, which follows them transparently)."""
    r = urllib.request.Request(f"http://{HOST}:{PORT}{path}",
                               headers={"Host": f"{HOST}:{PORT}"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(r, timeout=10) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


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


# ── SEC-01: GET proxies refuse an explicit cross-site drive-by ──────────────
def test_pget_cross_site_refused(monkeypatch):
    # A cross-site Sec-Fetch-Site is rejected (403) BEFORE param/allowlist checks,
    # so a drive-by page can neither launder a request nor poison the cache.
    st, _, _ = req("GET", "/api/pget?u=https://api.open-meteo.com/v1/forecast?x=1",
                   headers={"Sec-Fetch-Site": "cross-site"})
    assert st == 403


def test_tile_cross_site_refused():
    st, _, _ = req("GET", "/tiles/osm/1/0/0", headers={"Sec-Fetch-Site": "cross-site"})
    assert st == 403


def test_pget_same_origin_not_blocked_by_csrf_guard():
    # same-origin (the SPA's own fetch) passes the cross-site guard — it then fails
    # later on the allowlist (403) or upstream, NOT on the Sec-Fetch-Site check.
    # Use the missing-param path to prove the guard let it through: 400, not 403.
    st, _, _ = req("GET", "/api/pget", headers={"Sec-Fetch-Site": "same-origin"})
    assert st == 400                             # reached the param check, not refused


def test_tile_no_sec_fetch_header_allowed():
    # Clients that send no Sec-Fetch-Site (older browsers, curl, HEALTHCHECK, bare
    # <img> in some engines) are NOT refused — an unknown layer still 404s normally.
    st, _, _ = req("GET", "/tiles/nope/1/0/0")   # no Sec-Fetch-Site header
    assert st == 404                             # normal validation, not a 403 refusal


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


# ── favicon: root probe is routed, not 404'd (#135) ─────────────────────────
def test_favicon_ico_redirects_to_the_asset():
    # browsers probe /favicon.ico regardless of the <link rel="icon"> in our
    # pages; that probe must not land a 404 in the operator's log
    st, h = get_no_redirect("/favicon.ico")
    assert st == 302
    assert h["Location"] == "/app/favicon.svg"


def test_favicon_asset_is_served_as_svg():
    st, h, body = req("GET", "/app/favicon.svg")
    assert st == 200
    assert h["Content-Type"] == "image/svg+xml"
    assert body.startswith(b"<svg")


def test_app_pages_declare_the_icon():
    # every HTML entry point, so no tab renders blank
    for page in ("/app/", "/app/search.html", "/app/sun.html",
                 "/app/graph.html", "/app/settings.html"):
        st, _, body = req("GET", page)
        assert st == 200, page
        assert b'rel="icon"' in body, page


# ── benign client disconnects don't spam the console (#134) ──────────────────
@pytest.mark.parametrize("exc", [ConnectionResetError, BrokenPipeError,
                                 ConnectionAbortedError])
def test_client_disconnect_is_silent(exc, capsys):
    # a dropped keep-alive connection is routine (closed tab, navigation away);
    # the stdlib default would print a full traceback to the foreground console
    try:
        raise exc("client went away")
    except exc:
        SRV.handle_error(None, (HOST, 0))
    assert capsys.readouterr().err == ""


def test_real_errors_still_print_a_traceback(capsys):
    # the suppression must be narrow: a genuine handler bug stays loud
    try:
        raise ValueError("boom")
    except ValueError:
        SRV.handle_error(None, (HOST, 0))
    err = capsys.readouterr().err
    assert "ValueError" in err and "boom" in err


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
    monkeypatch.setattr(server, "upstream_get", lambda url, timeout=20, feature=None: b"\x89PNG\r\n")
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
    def boom(url, timeout=20, feature=None):
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
                        lambda url, timeout=30, feature=None: b'{"elevation":[123]}')
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


# ── global cache size cap (#82) ─────────────────────────────────────────────
def test_cache_cap_evicts_oldest_over_ceiling(monkeypatch, tmp_path):
    # _enforce_cache_cap deletes oldest-by-mtime files until total is back under
    # CACHE_EVICT_TO × the ceiling. Build 10 × 1 KiB files with increasing mtimes,
    # set a 5 KiB ceiling, and assert the oldest are gone and we are under target.
    import os
    monkeypatch.setattr(server, "CACHE", tmp_path)
    monkeypatch.setattr(server, "CACHE_MAX_BYTES", 5 * 1024)
    monkeypatch.setattr(server, "CACHE_EVICT_TO", 0.9)
    (tmp_path / "tiles").mkdir()
    for i in range(10):
        f = tmp_path / "tiles" / f"e{i}.bin"
        f.write_bytes(b"x" * 1024)
        os.utime(f, (1000 + i, 1000 + i))       # e0 oldest ... e9 newest

    server._enforce_cache_cap()

    total = sum(p.stat().st_size for p in tmp_path.rglob("*.bin"))
    assert total <= int(5 * 1024 * 0.9)          # back under the low-water mark
    assert not (tmp_path / "tiles" / "e0.bin").exists()   # oldest evicted
    assert (tmp_path / "tiles" / "e9.bin").exists()       # newest kept


def test_cache_cap_disabled_when_zero(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "CACHE", tmp_path)
    monkeypatch.setattr(server, "CACHE_MAX_BYTES", 0)        # disabled
    f = tmp_path / "keep.bin"
    f.write_bytes(b"x" * (4 * 1024))
    server._enforce_cache_cap()
    assert f.exists()                            # nothing evicted when cap is off


def test_cache_cap_skips_inflight_temp_files(monkeypatch, tmp_path):
    # .tmp-* files are in-flight atomic_write temps, not cache entries — the sweep
    # must never count or delete them.
    import os
    monkeypatch.setattr(server, "CACHE", tmp_path)
    monkeypatch.setattr(server, "CACHE_MAX_BYTES", 1024)
    tmpf = tmp_path / ".tmp-writing.bin"
    tmpf.write_bytes(b"x" * (4 * 1024))          # bigger than the ceiling
    os.utime(tmpf, (1, 1))                        # very old, but must be ignored
    server._enforce_cache_cap()
    assert tmpf.exists()                         # in-flight temp untouched


# ── OPSEC egress settings (Axis A) ──────────────────────────────────────────
def test_opsec_get_shape():
    st, _, body = req("GET", "/api/opsec")
    assert st == 200
    j = json.loads(body)
    assert "config" in j and "features" in j
    assert set(j["features"]) == set(server.egress_domain.FEATURES)
    # default routing is all-direct (behaviour unchanged until the analyst opts in)
    assert all(j["config"]["routes"][f] == "direct" for f in server.egress_domain.FEATURES)


def test_status_includes_opsec():
    st, _, body = req("GET", "/api/status")
    assert st == 200
    assert "opsec" in json.loads(body)


def test_opsec_set_requires_csrf():
    st, _, body = jpost("/api/opsec", {"config": {}}, csrf=False)
    assert st == 403
    assert b"X-GeOSINT" in body


def test_opsec_set_bad_payload_400():
    st, _, _ = jpost("/api/opsec", {"nope": 1})
    assert st == 400


def test_opsec_round_trip(monkeypatch, tmp_path):
    # POST persists a route change to a temp opsec.json and GET reflects it; the
    # password is masked in the response but stored for real on disk. No network:
    # provider stays null so no verification fires.
    monkeypatch.setattr(server, "OPSEC_CONFIG_PATH", tmp_path / "opsec.json")
    server._opsec_cfg[0] = None
    cfg = {"version": 1,
           "routes": {"tiles": "direct", "geocode": "tor", "weather": "direct",
                      "overpass": "direct", "gbif": "direct", "media": "direct"},
           "proxies": {"res1": {"scheme": "http", "host": "p.example", "port": 8080,
                                "user": "u", "pass": "secret"}},
           "vpn": {"provider": None, "verify": True},
           "tor": {"host": "127.0.0.1", "port": 9050}, "ua": "neutral"}
    st, _, body = jpost("/api/opsec", {"config": cfg})
    assert st == 200
    j = json.loads(body)
    assert j["ok"] is True
    assert j["config"]["routes"]["geocode"] == "tor"
    assert j["config"]["ua"] == "neutral"
    assert j["config"]["proxies"]["res1"]["pass"] == "********"     # masked in response
    st2, _, body2 = req("GET", "/api/opsec")
    assert json.loads(body2)["config"]["routes"]["geocode"] == "tor"
    saved = json.loads((tmp_path / "opsec.json").read_text())
    assert saved["proxies"]["res1"]["pass"] == "secret"            # real secret on disk
    server._opsec_cfg[0] = None        # reset cache for later tests


def test_opsec_masked_password_kept_on_resave(monkeypatch, tmp_path):
    # Re-saving with the masked sentinel must KEEP the stored secret, not wipe it.
    monkeypatch.setattr(server, "OPSEC_CONFIG_PATH", tmp_path / "opsec.json")
    server._opsec_cfg[0] = None
    base = {"version": 1, "routes": {}, "proxies": {
        "res1": {"scheme": "http", "host": "p.example", "port": 8080, "user": "u", "pass": "secret"}},
        "vpn": {"provider": None, "verify": True}, "tor": {"host": "127.0.0.1", "port": 9050}, "ua": "default"}
    jpost("/api/opsec", {"config": base})
    base["proxies"]["res1"]["pass"] = "********"        # UI sends the mask back unchanged
    jpost("/api/opsec", {"config": base})
    saved = json.loads((tmp_path / "opsec.json").read_text())
    assert saved["proxies"]["res1"]["pass"] == "secret"
    server._opsec_cfg[0] = None


# ── GBIF density-tile proxy (leak closure) ──────────────────────────────────
def test_gbif_tile_cross_site_refused():
    st, _, _ = req("GET", "/api/gbif/tile/3/1/1?taxonKey=212",
                   headers={"Sec-Fetch-Site": "cross-site"})
    assert st == 403


def test_gbif_tile_bad_coords_400():
    st, _, _ = req("GET", "/api/gbif/tile/x/1/1?taxonKey=212")
    assert st == 400


def test_gbif_tile_missing_taxon_400():
    st, _, _ = req("GET", "/api/gbif/tile/3/1/1")
    assert st == 400


def test_gbif_tile_bad_zoom_400():
    st, _, _ = req("GET", "/api/gbif/tile/99/0/0?taxonKey=212")
    assert st == 400


def test_gbif_tile_success_proxied(monkeypatch, tmp_path):
    # Validates + fetches via upstream_get(feature="gbif") and caches as image/png.
    monkeypatch.setattr(server, "GBIF_TILE_CACHE", tmp_path / "gbif")
    seen = {}

    def fake(url, timeout=20, feature=None):
        seen["url"] = url
        seen["feature"] = feature
        return b"\x89PNG\r\n"
    monkeypatch.setattr(server, "upstream_get", fake)
    st, h, _ = req("GET", "/api/gbif/tile/3/1/2?taxonKey=212&bin=hex&hexPerTile=100"
                          "&style=purpleYellow-noborder.poly")
    assert st == 200
    assert h.get("Content-Type") == "image/png"
    assert seen["feature"] == "gbif"
    assert seen["url"].startswith("https://api.gbif.org/v2/map/occurrence/density/3/1/2")


# ── wiki reference-image proxy (leak closure) ───────────────────────────────
def test_img_missing_param_400():
    st, _, _ = req("GET", "/api/img")
    assert st == 400


def test_img_bad_scheme_400():
    st, _, _ = req("GET", "/api/img?u=ftp://x/y.jpg")
    assert st == 400


def test_img_non_allowlisted_host_403():
    u = urllib.parse.quote("https://evil.example.com/x.jpg", safe="")
    st, _, _ = req("GET", "/api/img?u=" + u)
    assert st == 403


def test_img_cross_site_refused():
    u = urllib.parse.quote("https://geohints.com/x.jpg", safe="")
    st, _, _ = req("GET", "/api/img?u=" + u, headers={"Sec-Fetch-Site": "cross-site"})
    assert st == 403


def test_img_allowlisted_host_proxied(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "IMG_CACHE", tmp_path / "img")
    seen = {}

    def fake(url, timeout=20, feature=None):
        seen["feature"] = feature
        return b"\xff\xd8\xff"        # jpeg magic-ish bytes
    monkeypatch.setattr(server, "upstream_get", fake)
    u = urllib.parse.quote("https://geohints.com/storage/x.jpg", safe="")
    st, h, _ = req("GET", "/api/img?u=" + u)
    assert st == 200
    assert h.get("Content-Type", "").startswith("image/")
    assert seen["feature"] == "media"


# ── img-src CSP: tightened for the SPA (everything proxied) ──────────────────
def test_app_csp_img_src_tightened():
    st, h, _ = req("GET", "/app/index.html")
    assert st == 200
    assert "img-src 'self' data: blob:;" in h.get("Content-Security-Policy", "")


# ── redacted dossier logic is JS, but the case-format guard is shared — n/a ──
