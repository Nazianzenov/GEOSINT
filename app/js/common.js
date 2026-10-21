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

/* toDMS / fmtDMS / compassAz / cardinal are pure and live in coreutils.js (#89),
   loaded before this file; they remain available as bare globals. */

/* Populate a UTC-offset <select> with UTC-12:00 .. +14:00 in 15-min steps, and
   default it to the viewer's local offset. Shared by the workbench Sun module and
   the Studio (which then wire their own change listeners). */
function fillUtcOffsets(sel) {
  for (let q = -48; q <= 56; q++) {           // -12:00 .. +14:00 in 15-min steps
    const o = q / 4, sign = o < 0 ? "-" : "+";
    const h = Math.floor(Math.abs(o)), mm = String(Math.round((Math.abs(o) % 1) * 60)).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = o; opt.textContent = `UTC${sign}${String(h).padStart(2, "0")}:${mm}`;
    sel.appendChild(opt);
  }
  sel.value = -(new Date().getTimezoneOffset()) / 60;
}

/* Read #sun-dt + #sun-offset → { date (UTC instant for that local time), off, Y, M, D }
   or null when the date field is empty. */
function sunDate() {
  const v = $("#sun-dt").value;
  if (!v) return null;
  const off = parseFloat($("#sun-offset").value);
  const [d, tm] = v.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = tm.split(":").map(Number);
  return { date: new Date(Date.UTC(Y, M - 1, D, h, mi) - off * 3600e3), off, Y, M, D };
}

/* Format a Date at a UTC offset (hours) as HH:MM, or "—" for an invalid date. */
const fmtClock = (date, off) =>
  (!date || isNaN(date)) ? "—" : new Date(date.getTime() + off * 3600e3).toISOString().slice(11, 16);

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

/* ═══════════════════ shared by the workbench and the Sun Studio ═══════════════════
   The workbench panel (modules/sun.js, core.js) and the standalone Studio (sun.js)
   used to carry hand-copies of the place search, the sun readout and the solver
   UI, which drifted apart. One implementation here; each page keeps its own glue. */

/* Geocoder box: typed coordinates offer "go to"; anything else asks Nominatim (via
   the cached proxy) after a pause. onPick(ll, d) gets the chosen place — `d` is
   the Nominatim item, or null for typed coordinates. `polygons` also requests the
   area outline (d.geojson) for the workbench's boundary highlight. */
function initPlaceSearch(input, box, onPick, { polygons = false } = {}) {
  let t;
  const pick = (ll, d) => { onPick(ll, d); box.hidden = true; input.blur(); };
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (!q) { box.hidden = true; return; }
    const ll = parseCoords(q);
    if (ll) {
      box.innerHTML = `<div class="search-item sel">→ Go to coordinates<small>${fmtDD(ll)} · ${fmtDMS(ll)}</small></div>`;
      box.hidden = false;
      box.firstChild.onclick = () => pick(ll, null);
      return;
    }
    t = setTimeout(async () => {
      try {
        const poly = polygons ? "&polygon_geojson=1&polygon_threshold=0.001" : "";
        const r = await cachedFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&accept-language=en${poly}&q=${encodeURIComponent(q)}`);
        const raw = await r.json();
        // OSM sometimes stores one place as both a way and a relation (e.g. Windhoek):
        // identical name/type/coord, different object. Collapse, preferring the relation
        // (the canonical multipolygon boundary, and the better source for the highlight).
        const RANK = { relation: 3, way: 2, node: 1 }, seen = new Map();
        for (const d of raw) {
          const key = `${d.addresstype}|${(+d.lat).toFixed(4)},${(+d.lon).toFixed(4)}|${d.display_name}`;
          const prev = seen.get(key);
          if (!prev || (RANK[d.osm_type] || 0) > (RANK[prev.osm_type] || 0)) seen.set(key, d);
        }
        const data = [...seen.values()];
        box.innerHTML = data.length
          ? data.map((d, i) =>
              `<div class="search-item" data-i="${i}"><b>${esc(d.name || d.display_name.split(",")[0])}</b> <span class="tag">${esc(d.addresstype || d.type || "")}</span><small>${esc(d.display_name)}</small></div>`).join("")
          : `<div class="search-item">no results</div>`;
        box.hidden = false;
        box.querySelectorAll("[data-i]").forEach((el) => el.onclick = () => {
          const d = data[+el.dataset.i];
          pick(L.latLng(+d.lat, +d.lon), d);
        });
      } catch { box.innerHTML = `<div class="search-item">Nominatim unreachable</div>`; box.hidden = false; }
    }, 450);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const f = box.querySelector(".search-item"); if (f) f.click(); }
    if (e.key === "Escape") { box.hidden = true; input.blur(); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) box.hidden = true;
  });
}

/* Studio -> workbench hand-off of a chronolocation finding (same-origin localStorage). */
const STUDIO_HANDOFF_KEY = "geosint:studio-finding";

/* wrap-aware HH:MM (two-shadow's m+dt2 can push a window past midnight) */
function hmClock(mins) {
  const w = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}

/* Default #sun-dt to now (viewer's local time), fill #sun-offset, and call
   onChange when either changes. */
function initSunInputs(onChange) {
  const sel = $("#sun-offset");
  fillUtcOffsets(sel);
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $("#sun-dt").value = now.toISOString().slice(0, 16);
  $("#sun-dt").addEventListener("change", onChange);
  sel.addEventListener("change", onChange);
}

/* EXIF capture time -> #sun-dt (the camera's wall clock: exifr ignores the offset)
   and, when the camera recorded it, its UTC offset -> #sun-offset. Without the
   offset the sun is computed in the analyst's own zone — hours off for a photo
   taken elsewhere. Returns the capture Date, or null when there is none. */
function exifToSunInputs(ex) {
  if (!ex || !ex.DateTimeOriginal) return null;
  const d = new Date(ex.DateTimeOriginal), pad = (x) => String(x).padStart(2, "0");
  $("#sun-dt").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const off = utcOffsetHours(ex.OffsetTimeOriginal || ex.OffsetTime);
  const opt = off === null ? null : [...$("#sun-offset").options].find((o) => +o.value === off);
  if (opt) $("#sun-offset").value = opt.value;
  return d;
}

/* Sun position cards, day events, moon, chart and deep links for point `p` at
   #sun-dt / #sun-offset, plus the shadow / sun / sunrise / sunset rays drawn into
   `layer`. */
function renderSunReadout(p, layer) {
  layer.clearLayers();
  const sd = sunDate();
  if (!sd) return;
  const lat = p.lat, lng = wrapLng(p.lng);
  const pos = SunCalc.getPosition(sd.date, lat, lng);
  const alt = pos.altitude * 180 / Math.PI;
  const az = compassAz(pos.azimuth);
  const shadowAz = (az + 180) % 360;
  const ratio = alt > 0.2 ? (1 / Math.tan(pos.altitude)) : null;

  $("#sun-cards").innerHTML = `
    <div class="card"><div class="v">${az.toFixed(1)}°</div><div class="k">sun azimuth (${cardinal(az)})</div></div>
    <div class="card"><div class="v">${alt.toFixed(1)}°</div><div class="k">elevation ${alt < 0 ? "(below horizon)" : ""}</div></div>
    <div class="card"><div class="v">${ratio ? ratio.toFixed(2) + "×" : "—"}</div><div class="k">shadow ÷ height</div></div>
    <div class="card"><div class="v">${shadowAz.toFixed(0)}° ${cardinal(shadowAz)}</div><div class="k">shadow points to</div></div>`;

  const times = SunCalc.getTimes(sd.date, lat, lng);
  const azOf = (t) => (t && !isNaN(t)) ? compassAz(SunCalc.getPosition(t, lat, lng).azimuth) : null;
  const rows = [
    ["Civil dawn", times.dawn], ["Sunrise", times.sunrise, azOf(times.sunrise)],
    ["Golden hour ends", times.goldenHourEnd], ["Solar noon", times.solarNoon],
    ["Golden hour starts", times.goldenHour], ["Sunset", times.sunset, azOf(times.sunset)], ["Civil dusk", times.dusk],
  ];
  $("#sun-events").innerHTML = rows.map(([k, v, azv]) =>
    `<tr><td>${k}</td><td>${fmtClock(v, sd.off)}${azv != null ? ` <span class="muted">· ${azv.toFixed(0)}° ${cardinal(azv)}</span>` : ""}</td></tr>`).join("");

  const mi = SunCalc.getMoonIllumination(sd.date);
  const phases = ["New moon","Waxing crescent","First quarter","Waxing gibbous","Full moon","Waning gibbous","Last quarter","Waning crescent"];
  const mpos = SunCalc.getMoonPosition(sd.date, lat, lng);
  $("#sun-moon").innerHTML = `
    <tr><td>Phase</td><td>${phases[Math.round(mi.phase * 8) % 8]}</td></tr>
    <tr><td>Illumination</td><td>${(mi.fraction * 100).toFixed(0)}%</td></tr>
    <tr><td>Moon altitude</td><td>${(mpos.altitude * 180 / Math.PI).toFixed(1)}°</td></tr>`;

  if (alt > 0) {
    // current shadow direction (thick grey) + sun direction (thin gold)
    layer.addLayer(L.polyline([p, project(p, shadowAz, 200)], { color: "#30363f", weight: 5, opacity: .85 }));
    layer.addLayer(L.polyline([p, project(p, az, 160)], { color: "#ffd23e", weight: 2, opacity: .8, dashArray: "2 4" }));
  }
  // sunrise / sunset azimuth rays for the chosen date — for "sun on the horizon" chronolocation
  const ray = (deg, color, label) => {
    layer.addLayer(L.polyline([p, project(p, deg, 1500)], { color, weight: 2.5, opacity: .9 })
      .bindTooltip(`${label} ${deg.toFixed(0)}° ${cardinal(deg)}`, { permanent: false }));
  };
  const riseAz = azOf(times.sunrise), setAz = azOf(times.sunset);
  if (riseAz != null) ray(riseAz, "#ff9e3d", "sunrise");
  if (setAz != null) ray(setAz, "#ff5e62", "sunset");
  drawSunChart(sd, lat, lng);

  const dstr = `${sd.Y}.${String(sd.M).padStart(2, "0")}.${String(sd.D).padStart(2, "0")}`;
  const tstr = $("#sun-dt").value.split("T")[1];
  $("#sun-links").innerHTML = `
    <a class="btn" target="_blank" href="https://www.suncalc.org/#/${lat.toFixed(5)},${lng.toFixed(5)},15/${dstr}/${tstr}/1/3">SunCalc.org ⇗</a>
    <a class="btn" target="_blank" href="https://shademap.app/@${lat.toFixed(5)},${lng.toFixed(5)},15z">ShadeMap (3-D shadows) ⇗</a>
    <a class="btn" target="_blank" href="https://www.peakfinder.com/?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}">PeakFinder horizon ⇗</a>`;
}

/* Read the shadow-solver inputs, run the shared CHRONO engine for point `p` and
   render the matching windows into #solver-out. Returns the result to keep (the
   dossier and the Studio hand-off read it), or null when there is nothing to
   solve yet (`emptyHint` is shown then). */
function solveShadows(p, emptyHint) {
  const out = $("#solver-out");
  const azT = parseFloat($("#solver-az").value);
  const ratioT = parseFloat($("#solver-ratio").value);
  const tol = parseFloat($("#solver-tol").value) || 8;
  if (isNaN(azT) && isNaN(ratioT)) { out.innerHTML = `<p class="hint">${emptyHint}</p>`; return null; }
  const sd = sunDate();
  if (!sd) { out.innerHTML = `<p class="nomatch">Set the date and time first.</p>`; return null; }
  // optional second reading taken Δ minutes after the first (two-shadow mode)
  const az2 = parseFloat($("#solver-az2").value);
  const ratio2 = parseFloat($("#solver-ratio2").value);
  const dt2 = parseFloat($("#solver-dt2").value);

  const res = CHRONO.solve({ sd, lat: p.lat, lng: wrapLng(p.lng), azT, ratioT, tol, second: { az2, ratio2, dt2 } });
  const result = { status: res.status, confidence: res.confidence, why: res.why, tol, twoShadow: res.twoShadow,
                   windows: [], inputs: { azT, ratioT, az2, ratio2, dt2 } };

  if (res.status === "inconsistent") {
    out.innerHTML = `<p class="nomatch">✗ <b>Claim inconsistent (${res.confidence} confidence)</b> — no time on this
      date matches at this location, within ±${tol}° tolerance. ${res.confidence === "low"
        ? "Tolerance is wide, so this is weak; tighten your measurement to strengthen it."
        : "Tighten the tolerance only if you can justify a more precise reading."}</p>`;
    return result;
  }
  const header = res.twoShadow
    ? `<p class="hint">Two-shadow mode: times where both readings fit (1st reading's time shown; 2nd is ${dt2 > 0 ? "+" : ""}${dt2} min later).</p>`
    : "";
  out.innerHTML = header + res.windows.map((w) =>
    `<div class="match">✓ ${hmClock(w.startMin)}–${hmClock(w.endMin)} local
      (best ${hmClock(w.bestMin)} · shadow→${w.shAz.toFixed(0)}° · ${w.ratio.toFixed(2)}×)</div>`).join("") +
    `<div class="solver-conf conf-${res.confidence}">Confidence: <b>${res.confidence}</b> — ${res.why} (tolerance ±${tol}°).</div>`;
  result.windows = res.windows.map((w) => `${hmClock(w.startMin)}–${hmClock(w.endMin)}`);
  return result;
}
