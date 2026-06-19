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
import json
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


def test_redacted_dossier_hides_image_artifact_filename(page):
    # #35: an image artifact's label is its original filename — must be
    # genericized to "image evidence" in a publication-safe export, like the
    # timeline already did. Shared redLabel() rule now covers all three blocks.
    art = {"id": 1, "kind": "image", "t": "2024-01-01T00:00:00",
           "text": "secret-photo-original.jpg",
           "source": "https://tracker.example.com/leak"}
    html = _build_dossier_with(page, redact=True, artifact=art)
    assert "secret-photo-original.jpg" not in html          # filename genericized
    assert "image evidence" in html                         # to the generic label


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


# ── applyCase validates untrusted structure (#26) ───────────────────────────
def test_sanitizecase_rejects_non_case(page):
    assert page.evaluate("() => sanitizeCase({foo: 1})") is None
    assert page.evaluate("() => sanitizeCase(null)") is None
    assert page.evaluate("() => sanitizeCase({app: 'something-else'})") is None


def test_sanitizecase_drops_malformed_point_and_view(page):
    res = page.evaluate(
        """() => sanitizeCase({
            app: 'geosint-workbench',
            point: { lat: 999, lng: 0 },
            view: { lat: 'x', lng: 2, zoom: 5 },
        })"""
    )
    assert "point" not in res["case"]                      # out-of-range point dropped
    assert "view" not in res["case"]                       # non-numeric view dropped
    assert any("active point" in d for d in res["dropped"])
    assert any("map view" in d for d in res["dropped"])


def test_sanitizecase_filters_bad_annotations_and_measure(page):
    res = page.evaluate(
        """() => sanitizeCase({
            app: 'geosint-workbench',
            measure: [[10, 20], [null, 5], ['x', 'y']],
            annos: [
                { type: 'pin', ll: [1, 2], text: 'ok' },
                { type: 'pin', ll: [200, 2], text: 'bad lat' },
                { type: 'arrow', ll: [1, 2], ll2: null, text: 'arrow missing ll2' },
            ],
        })"""
    )
    assert res["case"]["measure"] == [[10, 20]]            # only the valid pair kept
    assert len(res["case"]["annos"]) == 1                  # only the valid pin kept
    assert res["case"]["annos"][0]["text"] == "ok"


def test_applycase_loads_valid_parts_without_throwing(page):
    """A case with a bad point but a valid annotation applies the annotation and
    does not corrupt the session (no exception, point left unset)."""
    res = page.evaluate(
        """() => {
            clearAnnos();
            const before = state.point;
            try {
                applyCase({
                    app: 'geosint-workbench',
                    point: { lat: 999, lng: 999 },              // invalid -> dropped
                    annos: [{ type: 'pin', ll: [12, 34], text: 'kept' }],
                    measure: [], gbif: [], artifacts: [], inputs: {},
                });
                return { ok: true, annos: state.annos.length, pointChanged: state.point !== before };
            } catch (e) { return { ok: false, err: String(e) }; }
        }"""
    )
    assert res["ok"], res.get("err")
    assert res["annos"] == 1                                # valid annotation applied
    assert res["pointChanged"] is False                    # invalid point not applied


# ── fetchT: client-side timeout + caller-cancel composition (#30) ────────────
def test_fetcht_times_out_with_distinct_error(page):
    # A 1ms timeout against a never-resolving endpoint rejects with TimeoutError
    # (not a bare AbortError) so modules can show "timed out" vs. a user cancel.
    res = page.evaluate(
        """async () => {
            try { await fetchT('/api/status', {}, 1); return { name: 'NO_THROW' }; }
            catch (e) { return { name: e.name, msg: e.message }; }
        }"""
    )
    # Either the timeout fired (TimeoutError) or the request beat the 1ms timer.
    assert res["name"] in ("TimeoutError", "NO_THROW")
    if res["name"] == "TimeoutError":
        assert "timed out" in res["msg"]


def test_fetcht_respects_caller_cancel(page):
    # A caller-provided already-aborted signal cancels immediately and surfaces as
    # an AbortError (NOT our TimeoutError), so the OSM CANCEL button still works.
    res = page.evaluate(
        """async () => {
            const ctrl = new AbortController();
            ctrl.abort();                                  // user cancelled before the call
            try { await fetchT('/api/status', { signal: ctrl.signal }, 30000); return { name: 'NO_THROW' }; }
            catch (e) { return { name: e.name }; }
        }"""
    )
    assert res["name"] == "AbortError"                     # cancel, not timeout


# ── cacheNote: surface stale-cache provenance (#34) ─────────────────────────
def test_cachenote_behavior(page):
    # cacheNote reads the proxy's X-Cache header; only `stale` (an expired copy
    # served because upstream was unreachable) warrants a warning to the analyst.
    res = page.evaluate(
        """() => {
            const mk = (v) => ({ headers: { get: (k) => k === 'X-Cache' ? v : null } });
            return {
                stale: cacheNote(mk('stale')),
                hit: cacheNote(mk('hit')),
                miss: cacheNote(mk('miss')),
                none: cacheNote(mk(null)),
                noHeaders: cacheNote({}),
            };
        }"""
    )
    assert "cached copy" in res["stale"] and "out of date" in res["stale"]
    assert res["hit"] == "" and res["miss"] == ""            # fresh -> no note
    assert res["none"] == "" and res["noHeaders"] == ""      # robust to missing header


# ── chain-of-custody serializers (#50 coverage) ─────────────────────────────
def test_custody_csv_quotes_and_orders(page):
    res = page.evaluate(
        """() => custodyCsv([
            { id: 2, kind: 'note', t: '2024-02-01T00:00:00', text: 'second, with comma' },
            { id: 1, kind: 'obs',  t: '2024-01-01T00:00:00', source: 'he said "hi"', ll: [1.5, 2.5] },
        ])"""
    )
    lines = res.split("\r\n")
    assert lines[0].startswith('"id","observed","kind"')        # header
    assert lines[1].startswith('"1"')                           # sorted by observed time
    assert '"he said ""hi"""' in lines[1]                       # embedded quotes doubled
    assert '"1.5"' in lines[1] and '"2.5"' in lines[1]          # lat/lng split out
    assert '"second, with comma"' in lines[2]                   # comma stays inside the quoted field
    assert len(lines) == 3                                       # header + 2 rows


def test_custody_json_strips_thumbnails(page):
    res = page.evaluate(
        """() => custodyJson([
            { id: 1, kind: 'image', t: '2024-01-01T00:00:00', sha256: 'abc',
              thumb: 'data:image/jpeg;base64,XXXX', text: 'keep me' }])"""
    )
    j = json.loads(res)
    assert j["kind"] == "chain-of-custody"
    art = j["artifacts"][0]
    assert "thumb" not in art                    # bulky thumbnail stripped
    assert art["sha256"] == "abc" and art["text"] == "keep me"   # everything else kept


# ── shadow solver maths (#50 coverage) ──────────────────────────────────────
def test_shadowfit_within_and_outside_tolerance(page):
    res = page.evaluate(
        """() => {
            const s = { shAz: 100, ratio: 1.5 };
            return {
                inAz:  shadowFit(s, 105, NaN, 8).ok,    // 5° off, tol 8 -> ok
                outAz: shadowFit(s, 120, NaN, 8).ok,    // 20° off, tol 8 -> reject
                wrap:  shadowFit({shAz: 5, ratio: 1}, 355, NaN, 12).ok,  // 10° across 0/360 -> ok
                ratioOk:  shadowFit(s, NaN, 1.5, 8).ok, // exact ratio -> ok
                ratioBad: shadowFit(s, NaN, 3.0, 8).ok, // ratio 2x off -> reject (>18%)
            };
        }"""
    )
    assert res["inAz"] is True and res["outAz"] is False
    assert res["wrap"] is True                    # azimuth difference wraps around 360
    assert res["ratioOk"] is True and res["ratioBad"] is False


def test_shadowat_null_below_horizon(page):
    # midnight UTC at the equator/prime meridian on an equinox -> sun below horizon
    res = page.evaluate(
        """() => {
            const sd = { Y: 2024, M: 3, D: 20, off: 0 };
            return { night: shadowAt(0, sd, 0, 0), noon: !!shadowAt(720, sd, 0, 0) };
        }"""
    )
    assert res["night"] is None        # no shadow when the sun is at/below the horizon
    assert res["noon"] is True         # a shadow exists around local noon


# ── artifact link picker (#50 coverage; replaces the old prompt flow) ───────
def test_link_picker_records_link(page):
    res = page.evaluate(
        """() => {
            state.artifacts = [
              { id: 1, kind: 'note', t: '2024-01-01T00:00:00', text: 'first' },
              { id: 2, kind: 'obs',  t: '2024-01-02T00:00:00', text: 'second' }];
            renderCustodyTable();
            openLinkPicker(1, document.querySelector('.art-link-cell'));
            const sel = document.querySelector('.art-link-sel');
            const opts = sel.options.length;
            sel.value = '2';
            document.querySelector('.art-link-ok').click();
            return { opts, linked: (state.artifacts.find(a => a.id === 1).links || []).includes(2) };
        }"""
    )
    assert res["opts"] == 1            # only the OTHER artifact is offered
    assert res["linked"] is True       # confirming records the link (no prompt())


# ── docked search "map" links act in place, no new tab (search.js) ──────────
def _mount_search(page):
    return page.evaluate(
        """async () => {
            window._pk = null;
            const root = document.createElement('div'); document.body.appendChild(root);
            window._ui = await GeoSearch.mount(root, { onPick: (p) => { window._pk = p; } });
            return true;
        }"""
    )


def test_docked_search_point_link_is_in_place(page):
    # A card with structured coords -> in-place point pick (not target=_blank),
    # and clicking it hands onPick a {kind:'point', ll}.
    _mount_search(page)
    res = page.evaluate(
        """() => {
            const frag = _ui.factList([{ t: 'A place', x: 'desc', ll: [43.5, 5.2] }], 10, '');
            document.body.appendChild(frag);
            const a = frag.querySelector('a.s-pick');
            const blank = !!frag.querySelector('a.s-pick[target=_blank]');
            a.click();
            return { inPlace: !!a, blank, pick: window._pk };
        }"""
    )
    assert res["inPlace"] is True and res["blank"] is False
    assert res["pick"] == {"kind": "point", "ll": [43.5, 5.2]}


def test_docked_search_species_link_is_in_place(page):
    # The olive case: a flora card's map is a #species= deep link. It must become
    # an in-place pick that hands onPick a {kind:'species', key, name} — NOT a new
    # tab — so the distribution loads on the current map.
    _mount_search(page)
    res = page.evaluate(
        """() => {
            const html = _ui.mapLinkHtml({ map: '/app/index.html#species=5415040&name=Olive' });
            const wrap = document.createElement('div'); wrap.innerHTML = html;
            _ui.wirePicks(wrap);
            const a = wrap.querySelector('a.s-pick');
            a.click();
            return { inPlace: !!a, newTab: html.includes('target="_blank"'), pick: window._pk };
        }"""
    )
    assert res["inPlace"] is True and res["newTab"] is False
    assert res["pick"] == {"kind": "species", "key": 5415040, "name": "Olive"}


def test_docked_search_external_map_stays_new_tab(page):
    # An external Google-Maps short-link can't be plotted in app -> stays a
    # target=_blank link even in workbench mode.
    _mount_search(page)
    res = page.evaluate("() => _ui.mapLinkHtml({ map: 'https://goo.gl/maps/abc123' })")
    assert 'target="_blank"' in res and "goo.gl/maps/abc123" in res
    assert "s-pick" not in res
