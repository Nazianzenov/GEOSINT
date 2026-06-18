/* GeOSINT Workbench — shared front-end utilities.
   Loaded (as a classic <script>) BEFORE app.js / sun.js / search.js in every page
   that uses them, so all three share one definition instead of near-identical
   copies (which drift). Pure helpers only — no module-specific state or DOM wiring.

   Globals consumed: L (Leaflet), SunCalc, and optionally GeoCoords (parseCoords
   guards its MGRS/Plus-Code branches with `window.GeoCoords`, so this file is safe
   on pages that don't load the geocoords vendor, e.g. sun.html). */
"use strict";

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* HTML-escape untrusted strings (EXIF fields, geocoder responses) before innerHTML */
const esc = (s) => String(s).replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/* Only ever render an evidence thumbnail that is a LOCAL base64 data URI.
   A loaded/tampered case file could set `thumb` to an http(s) URL — which would
   make the "self-contained, nothing leaves your machine" dossier beacon to an
   external host on open. Returns the safe value or "" (callers fall back to a
   no-image placeholder). */
const dataThumb = (s) => /^data:image\//i.test(String(s || "")) ? s : "";

/* fetch with a client-side timeout. The browser default is effectively unbounded,
   so a hung server thread or a stalled connection would leave a module spinner
   forever. AbortController caps every call; on timeout the rejection is a distinct
   TimeoutError the caller's catch turns into a concrete, retryable error. */
const FETCH_TIMEOUT = 30000;
const UPLOAD_TIMEOUT = 120000;   // exif endpoints accept large RAW uploads (up to 200 MB)
function fetchT(url, opts = {}, ms = FETCH_TIMEOUT) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  // Respect a caller-provided signal (e.g. the OSM query's CANCEL button): abort
  // when either the timeout OR the caller's signal fires, so the wrapper never
  // clobbers an existing manual-cancel controller.
  const caller = opts.signal;
  if (caller) {
    if (caller.aborted) ctl.abort();
    else caller.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  return fetch(url, { ...opts, signal: ctl.signal })
    .catch((e) => {
      // Distinguish our timeout from a caller cancel, so modules can show a
      // "timed out — retry" message instead of silently treating it as a cancel.
      if (timedOut && e && e.name === "AbortError") {
        const t = new Error("request timed out"); t.name = "TimeoutError"; throw t;
      }
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

/* All point-API calls go through the server's cached proxy (immutable data —
   historical weather, elevation — is cached effectively forever). */
const cachedFetch = (url) => fetchT("/api/pget?u=" + encodeURIComponent(url));

/* The proxy reports cache provenance via X-Cache: hit | miss | stale. `stale`
   means the upstream was unreachable and we served an EXPIRED copy — the analyst
   must know the data may be out of date (stale OSINT is a hazard), so surface it.
   hit/miss are both "fresh enough", so they add no note. */
const cacheNote = (r) =>
  (r && r.headers && r.headers.get("X-Cache") === "stale")
    ? " · ⚠ cached copy (upstream unreachable — may be out of date)"
    : "";

/* ════════════════════════ coordinate formatting ════════════════════════ */
const fmtDD = (ll, p = 5) => `${ll.lat.toFixed(p)}, ${ll.lng.toFixed(p)}`;

function toDMS(deg, isLat) {
  const dir = deg >= 0 ? (isLat ? "N" : "E") : (isLat ? "S" : "W");
  const a = Math.abs(deg);
  const d = Math.floor(a), m = Math.floor((a - d) * 60);
  const s = ((a - d) * 3600 - m * 60).toFixed(1);
  return `${d}°${String(m).padStart(2, "0")}'${s}"${dir}`;
}
const fmtDMS = (ll) => `${toDMS(ll.lat, true)} ${toDMS(ll.lng, false)}`;

/* SunCalc azimuth is 0=South; convert to compass 0=North. */
const compassAz = (rad) => (rad * 180 / Math.PI + 180) % 360;
const cardinal = (deg) =>
  ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(deg / 22.5) % 16];

/* Parse "48.85, 2.35", "48.85 2.35", DMS like 48°51'30"N 2°17'40"E, N48.85 E2.35,
   and (only when vendor/geocoords.js is loaded) MGRS / Plus Codes. */
function parseCoords(txt) {
  txt = txt.trim();
  let m = txt.match(/^(-?\d{1,2}(?:\.\d+)?)[ ,;\t]+(-?\d{1,3}(?:\.\d+)?)$/);
  if (m) {
    const lat = +m[1], lng = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return L.latLng(lat, lng);
  }
  const dms = /(\d{1,3})[°\s]+(\d{1,2})['′\s]+([\d.]+)?["″\s]*([NSEW])/gi;
  const parts = [...txt.matchAll(dms)];
  if (parts.length === 2) {
    const val = (p) => {
      let v = (+p[1]) + (+p[2]) / 60 + (+(p[3] || 0)) / 3600;
      if (/[SW]/i.test(p[4])) v = -v;
      return v;
    };
    const a = val(parts[0]), b = val(parts[1]);
    const latFirst = /[NS]/i.test(parts[0][4]);
    const lat = latFirst ? a : b, lng = latFirst ? b : a;
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return L.latLng(lat, lng);
  }
  m = txt.match(/^[NS]\s*([\d.]+)[ ,;]+[EW]\s*([\d.]+)$/i);
  if (m) {
    let lat = +m[1] * (/^s/i.test(txt) ? -1 : 1);
    let lng = +m[2] * (/[w]\s*[\d.]+$/i.test(txt) ? -1 : 1);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return L.latLng(lat, lng);
  }
  // MGRS, e.g. "31U DQ 48251 11932" / "31UDQ4825111932"
  if (window.GeoCoords && /^\d{1,2}[C-HJ-NP-X]/i.test(txt)) {
    const g = GeoCoords.fromMGRS(txt);
    if (g) return L.latLng(g.lat, g.lng);
  }
  // Plus Code (Open Location Code), e.g. "8FW4V75V+8Q"
  if (window.GeoCoords && /\+[23456789CFGHJMPQRVWX]{2,}$/i.test(txt)) {
    const g = GeoCoords.fromPlusCode(txt);
    if (g) return L.latLng(g.lat, g.lng);
  }
  return null;
}

/* Destination point ~accurate enough for drawing short lines. */
function project(ll, bearingDeg, distM) {
  const br = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(br)) / 111320;
  const dLng = (distM * Math.sin(br)) / (111320 * Math.cos(ll.lat * Math.PI / 180));
  return L.latLng(ll.lat + dLat, ll.lng + dLng);
}

/* Day-long sun-altitude chart into #sun-chart, with a marker at #sun-dt's time.
   Shared by the workbench Sun module and the full-screen Sun Studio. */
function drawSunChart(sd, lat, lng) {
  const cv = $("#sun-chart"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const y0 = H * 0.72;                                  // horizon line
  ctx.strokeStyle = "#232a3b"; ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();
  ctx.fillStyle = "#8a93a6"; ctx.font = "9px monospace";
  for (let h = 0; h <= 24; h += 6) {
    const x = (h / 24) * W;
    ctx.fillText(String(h).padStart(2, "0"), Math.min(x, W - 14), H - 3);
    ctx.strokeStyle = "#161b28"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 12); ctx.stroke();
  }
  ctx.strokeStyle = "#ffd23e"; ctx.lineWidth = 1.6; ctx.beginPath();
  let started = false;
  for (let m = 0; m <= 1440; m += 8) {
    const d = new Date(Date.UTC(sd.Y, sd.M - 1, sd.D, 0, m) - sd.off * 3600e3);
    const a = SunCalc.getPosition(d, lat, lng).altitude * 180 / Math.PI;
    const x = (m / 1440) * W, y = y0 - (a / 90) * (H * 0.66);
    started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
  }
  ctx.stroke();
  // marker for chosen time
  const v = $("#sun-dt").value.split("T")[1].split(":");
  const mNow = (+v[0]) * 60 + (+v[1]);
  const aNow = SunCalc.getPosition(sd.date, lat, lng).altitude * 180 / Math.PI;
  ctx.fillStyle = "#4cc2ff";
  ctx.beginPath();
  ctx.arc((mNow / 1440) * W, y0 - (aNow / 90) * (H * 0.66), 4, 0, 7);
  ctx.fill();
}
