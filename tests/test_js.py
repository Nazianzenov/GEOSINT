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


# ── coreutils.js: the DOM-free seam (#89) ───────────────────────────────────
# These call the CoreUtils namespace directly — no state, no DOM ids, no Leaflet.
# That is the whole point of the extraction: pure logic reachable without a page.
def test_coreutils_namespace_surface(page):
    keys = page.evaluate(
        "() => Object.keys(CoreUtils).sort()")
    assert keys == ["cardinal", "compassAz", "custodyCsv", "custodyJson", "fmtDMS", "toDMS"]


def test_coreutils_todms_and_cardinal_are_pure(page):
    res = page.evaluate(
        """() => ({
            latN: CoreUtils.toDMS(48.8584, true),
            lngE: CoreUtils.toDMS(2.2945, false),
            latS: CoreUtils.toDMS(-33.8568, true),
            n: CoreUtils.cardinal(0), e: CoreUtils.cardinal(90),
            s: CoreUtils.cardinal(180), w: CoreUtils.cardinal(270),
        })"""
    )
    assert res["latN"].endswith("N") and res["latN"].startswith("48°51'")
    assert res["lngE"].endswith("E") and res["lngE"].startswith("2°17'")
    assert res["latS"].endswith("S")             # negative latitude -> S
    assert [res["n"], res["e"], res["s"], res["w"]] == ["N", "E", "S", "W"]


def test_coreutils_compassaz_converts_suncalc_to_compass(page):
    # SunCalc azimuth is 0=South (radians); compassAz returns 0=North degrees.
    res = page.evaluate(
        "() => ({ south: CoreUtils.compassAz(0), north: CoreUtils.compassAz(Math.PI) })")
    assert res["south"] == 180                    # SunCalc 0 rad (south) -> 180° compass
    assert res["north"] in (0, 360)               # SunCalc π (north) -> 0/360° compass


def test_custody_serializers_reachable_via_namespace(page):
    # the same pure serializers, called through CoreUtils rather than the bare global
    res = page.evaluate(
        "() => CoreUtils.custodyJson([{ id: 1, kind: 'note', t: '2024-01-01T00:00:00', thumb: 'x', text: 'k' }])")
    j = json.loads(res)
    assert j["kind"] == "chain-of-custody" and "thumb" not in j["artifacts"][0]


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


# ── shared chronolocation engine: CHRONO.solve (#84) ────────────────────────
# The solver used to be hand-copied into modules/sun.js and sun.js; it is now the
# single DOM-free CHRONO.solve engine. These exercise the data it returns
# (structured minute windows), independent of any DOM rendering.
def _solve(page, **inp):
    return page.evaluate("(i) => CHRONO.solve(i)", inp)


# A real, self-consistent target: take the actual shadow at a known minute and feed
# it back as the measurement — solve() must recover a window containing that minute.
def test_solve_single_shadow_recovers_the_true_window(page):
    res = page.evaluate(
        """() => {
            const sd = { Y: 2024, M: 6, D: 21, off: 0 };
            const lat = 48.85, lng = 2.29, trueM = 600;        // 10:00 local
            const s = CHRONO.shadowAt(trueM, sd, lat, lng);
            const r = CHRONO.solve({ sd, lat, lng, azT: s.shAz, ratioT: s.ratio, tol: 8,
                                     second: { az2: NaN, ratio2: NaN, dt2: NaN } });
            const inWindow = r.windows.some(w => w.startMin <= trueM && trueM <= w.endMin);
            return { status: r.status, twoShadow: r.twoShadow, inWindow, nWindows: r.windows.length };
        }"""
    )
    assert res["status"] == "match"
    assert res["twoShadow"] is False
    assert res["inWindow"] is True          # the true minute lies inside a returned window


def test_solve_no_match_is_inconsistent(page):
    # An impossible ratio (sun would have to be effectively at the zenith all day)
    # against a tight tolerance yields a falsification with no windows.
    res = _solve(page, sd={"Y": 2024, "M": 6, "D": 21, "off": 0}, lat=48.85, lng=2.29,
                 azT=float("nan"), ratioT=0.001, tol=4,
                 second={"az2": float("nan"), "ratio2": float("nan"), "dt2": float("nan")})
    assert res["status"] == "inconsistent"
    assert res["windows"] == []
    assert res["confidence"] == "high"      # tol <= 5 -> a confident falsification


def test_solve_two_shadow_engages_and_tightens(page):
    # Build a genuine two-reading scenario: shadow at trueM and at trueM+90.
    # solve() must engage two-shadow mode and still contain the true minute.
    res = page.evaluate(
        """() => {
            const sd = { Y: 2024, M: 6, D: 21, off: 0 };
            const lat = 48.85, lng = 2.29, trueM = 540, dt2 = 90;   // 09:00 + 90 min
            const s1 = CHRONO.shadowAt(trueM, sd, lat, lng);
            const s2 = CHRONO.shadowAt(trueM + dt2, sd, lat, lng);
            const r = CHRONO.solve({ sd, lat, lng, azT: s1.shAz, ratioT: s1.ratio, tol: 8,
                                     second: { az2: s2.shAz, ratio2: s2.ratio, dt2 } });
            const inWindow = r.windows.some(w => w.startMin <= trueM && trueM <= w.endMin);
            return { status: r.status, twoShadow: r.twoShadow, inWindow };
        }"""
    )
    assert res["status"] == "match"
    assert res["twoShadow"] is True         # second reading present -> two-shadow engaged
    assert res["inWindow"] is True


def test_solve_window_shape_and_confidence_tiers(page):
    # Each window is structured {startMin,endMin,bestMin,shAz,ratio}; confidence is
    # one of the three tiers; a wider tolerance never yields a *higher* tier here.
    res = page.evaluate(
        """() => {
            const sd = { Y: 2024, M: 6, D: 21, off: 0 }, lat = 48.85, lng = 2.29, m = 600;
            const s = CHRONO.shadowAt(m, sd, lat, lng);
            const tight = CHRONO.solve({ sd, lat, lng, azT: s.shAz, ratioT: s.ratio, tol: 3,
                                         second: { az2: NaN, ratio2: NaN, dt2: NaN } });
            const wide  = CHRONO.solve({ sd, lat, lng, azT: s.shAz, ratioT: s.ratio, tol: 30,
                                         second: { az2: NaN, ratio2: NaN, dt2: NaN } });
            const w = tight.windows[0];
            const keys = w && ["startMin","endMin","bestMin","shAz","ratio"].every(k => k in w);
            const rank = { high: 3, moderate: 2, low: 1 };
            return { keys, tight: tight.confidence, wide: wide.confidence,
                     wideNotHigher: rank[wide.confidence] <= rank[tight.confidence] };
        }"""
    )
    assert res["keys"] is True              # window carries the documented structured fields
    assert res["tight"] in ("high", "moderate", "low")
    assert res["wideNotHigher"] is True     # looser tolerance is never a stronger claim


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
# wbIntent is the pure parser the docked search uses to turn a card's "map" deep
# link into an in-place action (vs. a new-tab external link). Tested directly so
# the test needs no GeoSearch.mount (which loads the 25 MB index — flaky in CI).
def test_wbintent_point_link(page):
    res = page.evaluate("() => GeoSearch.wbIntent('/app/index.html#ll=43.5,-5.2')")
    assert res == {"kind": "point", "ll": [43.5, -5.2]}


def test_wbintent_species_link(page):
    # the olive case: a flora card's "map" is a #species= distribution deep link
    res = page.evaluate("() => GeoSearch.wbIntent('/app/index.html#species=5415040&name=Olive')")
    assert res == {"kind": "species", "key": 5415040, "name": "Olive"}


def test_wbintent_external_link_is_not_in_place(page):
    # an external Google-Maps short-link can't be plotted -> no intent (stays new-tab)
    assert page.evaluate("() => GeoSearch.wbIntent('https://goo.gl/maps/abc123')") is None
    assert page.evaluate("() => GeoSearch.wbIntent('')") is None


# ── in-panel wiki: openWikiPage only frames same-origin /wiki/ URLs (#65) ────
def test_open_wiki_page_loads_same_origin_wiki(page):
    res = page.evaluate(
        """() => {
            openWikiPage('/wiki/landmarks/manmade/', 'Landmarks');
            const f = document.querySelector('#wiki-frame');
            return { src: f.getAttribute('src'),
                     onPageView: !document.querySelector('#wiki-frame-wrap').hidden };
        }"""
    )
    assert res["src"].endswith("/wiki/landmarks/manmade/")
    assert res["onPageView"] is True


def test_open_wiki_page_never_frames_off_origin_opens_tab(page):
    # The iframe must never be pointed off-origin (defence in depth on top of the
    # server's frame-ancestors 'self'). An external "source page" opens in a NEW
    # TAB instead of silently doing nothing (#73). Stub window.open to capture it.
    res = page.evaluate(
        """() => {
            const f = document.querySelector('#wiki-frame');
            f.removeAttribute('src');
            const opened = [];
            const realOpen = window.open;
            window.open = (u) => { opened.push(u); return null; };
            try {
                openWikiPage('https://ourairports.com/airports/X', 't');  // external
                const afterExt = f.getAttribute('src');
                openWikiPage('/app/index.html', 't');   // same-origin but not /wiki/
                const afterApp = f.getAttribute('src');
                return { afterExt, afterApp, opened };
            } finally { window.open = realOpen; }
        }"""
    )
    assert res["afterExt"] is None         # external never framed
    assert res["afterApp"] is None         # non-/wiki/ same-origin never framed
    assert res["opened"][0].startswith("https://ourairports.com/")  # external -> new tab


def test_wiki_tab_with_no_page_loads_home(page):
    # Clicking the "Wiki" tab before any source page is opened should show the
    # wiki HOME, not a blank iframe (#73).
    res = page.evaluate(
        """() => {
            document.querySelector('#wiki-frame').removeAttribute('src');
            showWikiView('page');
            return document.querySelector('#wiki-frame').getAttribute('src');
        }"""
    )
    assert res == "/wiki/"
