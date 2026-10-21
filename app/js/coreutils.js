/* GeOSINT — pure, DOM-free utilities (coordinate formatting + custody
   serialization).  Issue #89 / ARC-06.

   The SPA's analytical logic was only reachable through a fully-loaded browser
   page (shared `state`, DOM ids), so it could only be tested via Playwright.
   This module is the front-end's DOM-free seam, the same pattern proven by
   chrono.js (#84) and search.js: pure functions that take plain arguments and
   return plain values — no DOM, no Leaflet, no `state`. Both the browser and a
   test can call them without page setup.

   NOTE on scope: coordinate *formatting* (toDMS/fmtDMS/compassAz/cardinal) and
   custody *serialization* (custodyCsv/custodyJson) are pure and live here.
   parseCoords/sanitizeCase remain in their modules because they legitimately
   depend on Leaflet (L.latLng) / window.GeoCoords; they are already covered by
   the Playwright suite.

   Loaded before common.js / case.js, which used to define these; the bare
   globals are kept so existing call sites and tests resolve unchanged. */
"use strict";

const CoreUtils = (function () {
  /* Decimal degrees -> D°MM'SS.s"<hemisphere>. isLat picks N/S vs E/W. */
  function toDMS(deg, isLat) {
    const dir = deg >= 0 ? (isLat ? "N" : "E") : (isLat ? "S" : "W");
    const a = Math.abs(deg);
    const d = Math.floor(a), m = Math.floor((a - d) * 60);
    const s = ((a - d) * 3600 - m * 60).toFixed(1);
    return `${d}°${String(m).padStart(2, "0")}'${s}"${dir}`;
  }
  const fmtDMS = (ll) => `${toDMS(ll.lat, true)} ${toDMS(ll.lng, false)}`;

  /* Longitude folded into [-180, 180). Leaflet doesn't wrap: a click east of the
     date line reads e.g. 181.5, which the weather/elevation/OSM APIs reject. */
  const wrapLng = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;

  /* A map view [s, w, n, e] as one bbox the APIs accept: shifted so its centre is
     within ±180°, then clamped to [-180, 180]. A view straddling the date line
     keeps its larger side; one wider than the world is clamped to it. */
  function wrapBbox(s, w, n, e) {
    const shift = 360 * Math.round((w + e) / 2 / 360);
    return [s, Math.max(-180, w - shift), n, Math.min(180, e - shift)];
  }

  /* An EXIF OffsetTime* value ("+10:00", "-0530") -> hours (10, -5.5), or null. */
  function utcOffsetHours(off) {
    const m = /([+-])(\d{2}):?(\d{2})/.exec(String(off || ""));
    return m ? (m[1] === "-" ? -1 : 1) * (+m[2] + (+m[3]) / 60) : null;
  }

  /* SunCalc azimuth is 0=South; convert to compass 0=North. */
  const compassAz = (rad) => (rad * 180 / Math.PI + 180) % 360;
  const cardinal = (deg) =>
    ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(deg / 22.5) % 16];

  /* Chain-of-custody CSV: RFC-4180 quoting (every field quoted, embedded quotes
     doubled), rows sorted by observed time, lat/lng split out. Pure: operates on
     the passed artifact array, touches no DOM/state. */
  function custodyCsv(arts) {
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [["id", "observed", "kind", "source", "sha256", "lat", "lng", "added", "text"]];
    [...arts].sort((a, b) => String(a.t).localeCompare(String(b.t))).forEach((a) =>
      rows.push([a.id, a.t, a.kind, a.source || "", a.sha256 || "",
                 a.ll ? a.ll[0] : "", a.ll ? a.ll[1] : "",
                 (a.meta && a.meta.added) || "", a.text || ""]));
    return rows.map((r) => r.map(q).join(",")).join("\r\n");
  }

  /* Chain-of-custody JSON: the raw artifacts minus bulky thumbnails (keeps the
     record small and text-diffable). Pure. */
  function custodyJson(arts) {
    const slim = arts.map(({ thumb, ...rest }) => rest);
    return JSON.stringify({ app: "geosint-workbench", kind: "chain-of-custody",
                            exported: new Date().toISOString(), artifacts: slim }, null, 1);
  }

  return { toDMS, fmtDMS, wrapLng, wrapBbox, utcOffsetHours, compassAz, cardinal, custodyCsv, custodyJson };
})();

/* Legacy bare globals: existing call sites in common.js / case.js / the Studio
   and the tests reference these by name. */
const toDMS = CoreUtils.toDMS;
const fmtDMS = CoreUtils.fmtDMS;
const wrapLng = CoreUtils.wrapLng;
const wrapBbox = CoreUtils.wrapBbox;
const utcOffsetHours = CoreUtils.utcOffsetHours;
const compassAz = CoreUtils.compassAz;
const cardinal = CoreUtils.cardinal;
const custodyCsv = CoreUtils.custodyCsv;
const custodyJson = CoreUtils.custodyJson;
