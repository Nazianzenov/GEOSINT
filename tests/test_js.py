"""Browser-driven tests for the security-relevant pure logic in app/js/app.js.

The workbench frontend is one large script tightly coupled to the DOM, Leaflet
(``L``) and ``GeoCoords`` — its functions are not importable in isolation. So we
exercise them where they actually run: load the real ``/app/`` page in headless
Chromium (the same Playwright lane the ux-tester uses) and call the functions
in-page via ``page.evaluate``.

Covered (the core, XSS-/integrity-sensitive paths called out in issue #27):
  * ``esc`` — HTML-escapes every metacharacter.
  * ``parseCoords`` — DD/DMS parsing + range rejection.
  * ``buildDossier`` escaping invariant — a ``<script>``/``onerror`` payload in
    notes, an annotation or an artifact is escaped in the dossier HTML.
  * redacted dossier never leaks a raw source URL, filename or precise coord.
  * ``serializeCase`` -> ``applyCase`` -> ``serializeCase`` round-trips losslessly.

These run fully offline (the page's network calls — tiles, /api/status — are not
needed for the functions under test; we wait only for app.js to define them).

Skips cleanly if Playwright or its Chromium build isn't present, so the pure
stdlib unit suite (test_api / test_platform) is unaffected on a bare machine.
"""
import socket
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

playwright = pytest.importorskip("playwright.sync_api")
from playwright.sync_api import sync_playwright, Error as PWError  # noqa: E402

HOST = "127.0.0.1"


@pytest.fixture(scope="module")
def base_url():
    """Start the real stdlib server on an ephemeral loopback port."""
    s = socket.socket(); s.bind((HOST, 0)); port = s.getsockname()[1]; s.close()
    server.ALLOWED_HOSTS = {f"{HOST}:{port}", f"localhost:{port}", HOST, "localhost"}
    server.ALLOWED_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]", "::1"}
    srv = ThreadingHTTPServer((HOST, port), server.Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    yield f"http://{HOST}:{port}"
    srv.shutdown()


@pytest.fixture(scope="module")
def page(base_url):
    """A loaded /app/ page whose app.js functions are ready to call."""
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.launch()
    except PWError as e:                       # browser build missing on this host
        pytest.skip(f"Playwright Chromium unavailable: {e}")
    pg = browser.new_page()
    pg.goto(f"{base_url}/app/")
    # app.js defines its functions synchronously on load; wait for a late one.
    pg.wait_for_function("typeof buildDossier === 'function'", timeout=15000)
    yield pg
    browser.close()
    pw.stop()


# ── esc ─────────────────────────────────────────────────────────────────────
def test_esc_escapes_all_metacharacters(page):
    out = page.evaluate("""() => esc(`<img src=x onerror="alert(1)">&'`)""")
    assert "<" not in out and ">" not in out
    assert '"' not in out and "'" not in out
    assert "&lt;img" in out and "onerror=&quot;" in out
    assert "&amp;" in out and "&#39;" in out


# ── parseCoords ─────────────────────────────────────────────────────────────
def test_parsecoords_decimal(page):
    ll = page.evaluate("() => { const p = parseCoords('48.8584, 2.2945'); return p && [p.lat, p.lng]; }")
    assert ll == pytest.approx([48.8584, 2.2945])


def test_parsecoords_dms(page):
    ll = page.evaluate("""() => { const p = parseCoords(`48°51'30"N 2°17'40"E`); return p && [p.lat, p.lng]; }""")
    assert ll[0] == pytest.approx(48.8583, abs=1e-3)
    assert ll[1] == pytest.approx(2.2944, abs=1e-3)


def test_parsecoords_out_of_range_rejected(page):
    assert page.evaluate("() => parseCoords('200, 0')") is None
    assert page.evaluate("() => parseCoords('not coords at all')") is None


# ── dossier escaping invariant (XSS) ────────────────────────────────────────
XSS = '<script>alert(1)</script><img src=x onerror="steal()">'


def _build_dossier_with(page, *, redact, notes="", anno_text="", artifact=None):
    """Seed minimal state + notes, then return buildDossier(redact) HTML."""
    return page.evaluate(
        """({redact, notes, annoText, artifact}) => {
            const back = { point: state.point, annos: state.annos, artifacts: state.artifacts };
            const ta = document.querySelector('#case-notes');
            const prevNotes = ta ? ta.value : '';
            try {
                if (ta) ta.value = notes;
                state.point = { lat: 48.858000, lng: 2.294500 };
                state.annos = annoText ? [{ type: 'pin', ll: [48.85, 2.29], text: annoText }] : [];
                state.artifacts = artifact ? [artifact] : [];
                return buildDossier(redact);
            } finally {
                if (ta) ta.value = prevNotes;
                state.point = back.point; state.annos = back.annos; state.artifacts = back.artifacts;
            }
        }""",
        {"redact": redact, "notes": notes, "annoText": anno_text, "artifact": artifact},
    )


def test_dossier_escapes_xss_in_notes(page):
    html = _build_dossier_with(page, redact=False, notes=XSS)
    assert "<script>alert(1)</script>" not in html
    assert 'onerror="steal()"' not in html
    assert "&lt;script&gt;" in html


def test_dossier_escapes_xss_in_annotation(page):
    html = _build_dossier_with(page, redact=False, anno_text=XSS)
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_dossier_escapes_xss_in_artifact(page):
    art = {"id": 1, "kind": "note", "t": "2024-01-01T00:00:00",
           "text": XSS, "source": XSS}
    html = _build_dossier_with(page, redact=False, artifact=art)
    assert "<script>alert(1)</script>" not in html
    assert 'onerror="steal()"' not in html


# ── redacted dossier must not leak sourcing ─────────────────────────────────
def test_redacted_dossier_hides_url_notes_and_precise_coords(page):
    art = {"id": 1, "kind": "image", "t": "2024-01-01T00:00:00",
           "text": "secret-photo-original.jpg",
           "source": "https://tracker.example.com/leak"}
    html = _build_dossier_with(page, redact=True, notes="sensitive note text", artifact=art)
    assert "https://tracker.example.com/leak" not in html   # source URL gone
    assert "sensitive note text" not in html                # notes omitted
    assert "2.294500" not in html and "48.858000" not in html  # precise coord coarsened
    assert "coarsened" in html                              # coarsening marker present


@pytest.mark.xfail(reason="bug #35: redacted dossier leaks image-artifact filename "
                          "(only URLs are genericized in the artifact label)",
                   strict=True)
def test_redacted_dossier_hides_image_artifact_filename(page):
    art = {"id": 1, "kind": "image", "t": "2024-01-01T00:00:00",
           "text": "secret-photo-original.jpg",
           "source": "https://tracker.example.com/leak"}
    html = _build_dossier_with(page, redact=True, artifact=art)
    assert "secret-photo-original.jpg" not in html          # filename must be genericized


# ── dossier embeds only local data: thumbnails (#25) ────────────────────────
def test_dossier_embeds_data_uri_thumbnail(page):
    art = {"id": 1, "kind": "image", "t": "2024-01-01T00:00:00", "text": "ok",
           "thumb": "data:image/jpeg;base64,/9j/AAAA"}
    html = _build_dossier_with(page, redact=False, artifact=art)
    assert "data:image/jpeg;base64,/9j/AAAA" in html      # local thumb is kept


def test_dossier_drops_external_url_thumbnail(page):
    # a tampered case file pointing thumb at a remote host must NOT be embedded
    # (would beacon on open) — falls back to the no-image placeholder.
    art = {"id": 1, "kind": "image", "t": "2024-01-01T00:00:00", "text": "ok",
           "thumb": "https://tracker.example.com/beacon.gif"}
    html = _build_dossier_with(page, redact=False, artifact=art)
    assert "tracker.example.com" not in html
    assert "noimg" in html                                 # placeholder used instead


# ── case round-trip: serializeCase -> applyCase -> serializeCase ─────────────
def test_case_round_trip_is_lossless(page):
    """Apply a case, re-serialize, and confirm the meaningful fields survive."""
    result = page.evaluate(
        """() => {
            const original = {
                app: 'geosint-workbench', version: 2,
                point: { lat: -33.85679, lng: 151.21528 },
                view: { lat: -33.8568, lng: 151.2153, zoom: 15 },
                module: null, measure: [], gbif: [], data: null,
                notes: 'round trip notes',
                annos: [{ type: 'pin', ll: [-33.85, 151.21], ll2: null, text: 'a pin' }],
                artifacts: [{ id: 7, kind: 'note', t: '2024-01-01T00:00:00', text: 'art' }],
                inputs: {},
            };
            applyCase(original);
            const again = serializeCase();
            return { again };
        }"""
    )
    again = result["again"]
    assert again["app"] == "geosint-workbench"
    assert again["point"]["lat"] == pytest.approx(-33.85679)
    assert again["point"]["lng"] == pytest.approx(151.21528)
    assert again["notes"] == "round trip notes"
    assert again["annos"] == [{"type": "pin", "ll": [-33.85, 151.21], "ll2": None, "text": "a pin"}]
    assert again["artifacts"][0]["id"] == 7
