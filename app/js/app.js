/* GeOSINT Workbench — application logic.
   Vanilla JS. External calls: OSM/Esri/Carto tiles, Nominatim geocoding,
   Open-Meteo weather. Everything else is local. */
"use strict";

/* ════════════════════════════ state ════════════════════════════ */
const state = {
  map: null,
  point: null,            // L.LatLng — the "active point" all modules work from
  marker: null,
  module: null,           // open panel module name
  sunLayer: null,         // L.layerGroup for sun/shadow lines
  imgLayer: null,         // photo GPS marker + view cone
  measure: { on: false, pts: [], line: null, tip: null },
  tools: null,            // /api/status -> local desktop tool availability
  lastFile: null,         // last image dropped into the Image module
};

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
/* HTML-escape untrusted strings (EXIF fields, geocoder responses) before innerHTML */
const esc = (s) => String(s).replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/* ════════════════════════ formatting ═══════════════════════════ */
const fmtDD = (ll, p = 5) => `${ll.lat.toFixed(p)}, ${ll.lng.toFixed(p)}`;

function toDMS(deg, isLat) {
  const dir = deg >= 0 ? (isLat ? "N" : "E") : (isLat ? "S" : "W");
  const a = Math.abs(deg);
  const d = Math.floor(a), m = Math.floor((a - d) * 60);
  const s = ((a - d) * 3600 - m * 60).toFixed(1);
  return `${d}°${String(m).padStart(2, "0")}'${s}"${dir}`;
}
const fmtDMS = (ll) => `${toDMS(ll.lat, true)} ${toDMS(ll.lng, false)}`;

/* Parse "48.85, 2.35", "48.85 2.35", DMS like 48°51'30"N 2°17'40"E, or N48.85 E2.35 */
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
  return null;
}

/* Destination point ~accurate enough for drawing short lines */
function project(ll, bearingDeg, distM) {
  const br = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(br)) / 111320;
  const dLng = (distM * Math.sin(br)) / (111320 * Math.cos(ll.lat * Math.PI / 180));
  return L.latLng(ll.lat + dLat, ll.lng + dLng);
}

function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = (m) => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;

function status(msg, isErr = false, ms = 4000) {
  const el = $("#status-msg");
  el.textContent = msg;
  el.className = isErr ? "err" : "";
  clearTimeout(status._t);
  if (ms) status._t = setTimeout(() => { el.textContent = ""; }, ms);
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); status(`copied: ${t}`); }
  catch { status("clipboard blocked by browser", true); }
}

/* ════════════════════════════ map ══════════════════════════════ */
function initMap() {
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
  const esriSat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery &copy; Esri — Maxar, Earthstar Geographics" });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: '&copy; OpenStreetMap, SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a>' });
  const dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; <a href="https://carto.com/">CARTO</a>' });
  const hillshade = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, attribution: "Hillshade &copy; Esri — terrain/relief view" });
  const esriLabels = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Labels &copy; Esri" });

  state.map = L.map("map", { center: [30, 10], zoom: 3, layers: [dark], zoomControl: true });
  L.control.layers(
    { "Dark (CARTO)": dark, "OpenStreetMap": osm, "Satellite (Esri)": esriSat,
      "Topographic": topo, "Terrain hillshade (Esri)": hillshade },
    { "Place labels (Esri)": esriLabels },
    { position: "topleft" }
  ).addTo(state.map);
  L.control.scale({ imperial: true }).addTo(state.map);

  state.sunLayer = L.layerGroup().addTo(state.map);
  state.imgLayer = L.layerGroup().addTo(state.map);
  state.dataLayer = L.layerGroup().addTo(state.map);
  state.gbifLayers = {};   // name -> tileLayer

  state.map.on("mousemove", (e) => { $("#cursor-coords").textContent = fmtDD(e.latlng); });
  state.map.on("click", (e) => {
    if (state.measure.on) return measureClick(e.latlng);
    hideCtx();
    setPoint(e.latlng);
  });
  state.map.on("contextmenu", (e) => showCtx(e));
  state.map.on("movestart zoomstart", hideCtx);
}

function setPoint(ll, opts = {}) {
  state.point = L.latLng(ll.lat, ll.lng);
  if (!state.marker) {
    state.marker = L.marker(state.point, { draggable: true }).addTo(state.map);
    state.marker.on("dragend", () => setPoint(state.marker.getLatLng()));
  } else state.marker.setLatLng(state.point);
  $("#active-coords").textContent = fmtDD(state.point);
  fetchElevation(state.point);
  if (opts.fly) state.map.flyTo(state.point, opts.zoom || Math.max(state.map.getZoom(), 13), { duration: 1.2 });
  if (state.module === "sun") renderSun();
  if (state.module === "tools") renderTools();
  if (state.module === "weather") $("#wx-meta").textContent = `Point: ${fmtDD(state.point)} — pick a date and fetch.`;
}

/* ── elevation readout (Open-Meteo elevation API, cached per point) ── */
const _elevCache = new Map();
let _elevTimer;
function fetchElevation(ll) {
  clearTimeout(_elevTimer);
  _elevTimer = setTimeout(async () => {
    const key = `${ll.lat.toFixed(3)},${ll.lng.toFixed(3)}`;
    if (!_elevCache.has(key)) {
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${ll.lat.toFixed(4)}&longitude=${ll.lng.toFixed(4)}`);
        const j = await r.json();
        _elevCache.set(key, Math.round(j.elevation[0]));
      } catch { return; }
    }
    if (state.point && state.point.lat === ll.lat) {
      $("#active-coords").textContent = `${fmtDD(state.point)} · ${_elevCache.get(key)} m`;
    }
  }, 350);
}

/* ── context menu ── */
function showCtx(e) {
  const ll = e.latlng, menu = $("#ctx-menu");
  const items = [
    ["Set active point here", () => setPoint(ll)],
    [`Copy  ${fmtDD(ll)}`, () => copyText(fmtDD(ll))],
    [`Copy  ${fmtDMS(ll)}`, () => copyText(fmtDMS(ll))],
    ["Open Street View here ⇗", () => window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll.lat},${ll.lng}`)],
    ["Open Google Maps here ⇗", () => window.open(`https://www.google.com/maps/@${ll.lat},${ll.lng},16z`)],
    ["Open Google Earth here ⇗", () => window.open(`https://earth.google.com/web/@${ll.lat},${ll.lng},0a,2000d,35y,0h,0t,0r`)],
  ];
  menu.innerHTML = `<div class="ctx-coords">${fmtDD(ll)}</div>` +
    items.map((it, i) => `<div class="ctx-item" data-i="${i}">${it[0]}</div>`).join("");
  menu.querySelectorAll(".ctx-item").forEach((el) =>
    el.addEventListener("click", () => { hideCtx(); items[+el.dataset.i][1](); }));
  menu.style.left = Math.min(e.originalEvent.clientX, innerWidth - 240) + "px";
  menu.style.top  = Math.min(e.originalEvent.clientY, innerHeight - 230) + "px";
  menu.hidden = false;
}
const hideCtx = () => { $("#ctx-menu").hidden = true; };
document.addEventListener("click", (e) => { if (!$("#ctx-menu").contains(e.target)) hideCtx(); });

/* ── measure tool ── */
function toggleMeasure(force) {
  const m = state.measure;
  m.on = force !== undefined ? force : !m.on;
  $("#btn-measure").classList.toggle("armed", m.on);
  state.map.getContainer().style.cursor = m.on ? "crosshair" : "";
  if (!m.on) {
    if (m.line) state.map.removeLayer(m.line);
    if (m.tip) state.map.removeLayer(m.tip);
    Object.assign(m, { pts: [], line: null, tip: null });
  } else status("measure: click points on the map — Esc to finish", false, 6000);
}
function measureClick(ll) {
  const m = state.measure;
  m.pts.push(ll);
  if (!m.line) m.line = L.polyline(m.pts, { color: "#ffb454", weight: 2, dashArray: "6 4" }).addTo(state.map);
  else m.line.setLatLngs(m.pts);
  let total = 0;
  for (let i = 1; i < m.pts.length; i++) total += haversine(m.pts[i - 1], m.pts[i]);
  const txt = m.pts.length > 1
    ? `${fmtDist(total)} · ${(total / 1609.344).toFixed(2)} mi`
    : "click next point";
  if (m.tip) state.map.removeLayer(m.tip);
  m.tip = L.marker(ll, {
    interactive: false,
    icon: L.divIcon({ className: "measure-tip", html: txt, iconAnchor: [-8, 8] }),
  }).addTo(state.map);
}

/* ════════════════════════ geocoding search ═════════════════════ */
function initSearch() {
  const input = $("#search"), box = $("#search-results");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (!q) { box.hidden = true; return; }
    const ll = parseCoords(q);
    if (ll) {
      box.innerHTML = `<div class="search-item sel">→ Go to coordinates<small>${fmtDD(ll)} · ${fmtDMS(ll)}</small></div>`;
      box.hidden = false;
      box.firstChild.onclick = () => { setPoint(ll, { fly: true }); box.hidden = true; input.blur(); };
      return;
    }
    t = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&q=${encodeURIComponent(q)}`,
          { headers: { "Accept-Language": "en" } });
        const data = await r.json();
        box.innerHTML = data.length
          ? data.map((d, i) =>
              `<div class="search-item" data-i="${i}"><b>${esc(d.name || d.display_name.split(",")[0])}</b> <span class="tag">${esc(d.type || "")}</span><small>${esc(d.display_name)}</small></div>`).join("")
          : `<div class="search-item">no results</div>`;
        box.hidden = false;
        box.querySelectorAll("[data-i]").forEach((el) => el.onclick = () => {
          const d = data[+el.dataset.i];
          setPoint(L.latLng(+d.lat, +d.lon), { fly: true, zoom: d.type === "country" ? 6 : 13 });
          box.hidden = true; input.blur();
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

/* ════════════════════════ panel / modules ══════════════════════ */
const MODULE_TITLES = { sun: "Sun & Shadow", weather: "Meteorology", image: "Image Intelligence",
  tools: "Tool Launcher", data: "Data Layers" };

function openModule(name) {
  if (state.module === name) return closePanel();
  state.module = name;
  $("#panel").hidden = false;
  $("#panel-title").textContent = MODULE_TITLES[name];
  $$("#panel-body > section").forEach((s) => s.hidden = s.id !== `module-${name}`);
  $$(".rail-btn[data-module]").forEach((b) => b.classList.toggle("active", b.dataset.module === name));
  state.map.invalidateSize();
  if (name === "sun") renderSun();
  if (name === "tools") renderTools();
}
function closePanel() {
  state.module = null;
  $("#panel").hidden = true;
  $$(".rail-btn[data-module]").forEach((b) => b.classList.remove("active"));
  state.map.invalidateSize();
}

/* ════════════════════════════ SUN ══════════════════════════════ */
function initSun() {
  const sel = $("#sun-offset");
  for (let q = -48; q <= 56; q++) {           // -12:00 .. +14:00 in 15-min steps
    const o = q / 4;
    const sign = o < 0 ? "-" : "+";
    const h = Math.floor(Math.abs(o)), mm = String(Math.round((Math.abs(o) % 1) * 60)).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = o; opt.textContent = `UTC${sign}${String(h).padStart(2, "0")}:${mm}`;
    sel.appendChild(opt);
  }
  sel.value = -(new Date().getTimezoneOffset()) / 60;
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $("#sun-dt").value = now.toISOString().slice(0, 16);
  $("#sun-dt").addEventListener("change", renderSun);
  sel.addEventListener("change", renderSun);
  $("#solver-run").addEventListener("click", runSolver);
}

/* Date from the datetime-local string interpreted at the chosen UTC offset */
function sunDate() {
  const v = $("#sun-dt").value;
  if (!v) return null;
  const off = parseFloat($("#sun-offset").value);
  const [d, tm] = v.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = tm.split(":").map(Number);
  return { date: new Date(Date.UTC(Y, M - 1, D, h, mi) - off * 3600e3), off, Y, M, D };
}
const compassAz = (rad) => (rad * 180 / Math.PI + 180) % 360;   // SunCalc az: 0=S → compass 0=N
const fmtClock = (date, off) => {
  if (!date || isNaN(date)) return "—";
  const t = new Date(date.getTime() + off * 3600e3);
  return t.toISOString().slice(11, 16);
};
const cardinal = (deg) =>
  ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(deg / 22.5) % 16];

function renderSun() {
  state.sunLayer.clearLayers();
  if (!state.point) { $("#sun-cards").innerHTML = `<p class="hint">⚠ Click the map to set the active point first.</p>`; return; }
  const sd = sunDate();
  if (!sd) return;
  const { lat, lng } = state.point;
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
  const rows = [
    ["Civil dawn", times.dawn], ["Sunrise", times.sunrise],
    ["Golden hour ends", times.goldenHourEnd], ["Solar noon", times.solarNoon],
    ["Golden hour starts", times.goldenHour], ["Sunset", times.sunset], ["Civil dusk", times.dusk],
  ];
  $("#sun-events").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${fmtClock(v, sd.off)}</td></tr>`).join("");

  const mi = SunCalc.getMoonIllumination(sd.date);
  const phases = ["New moon","Waxing crescent","First quarter","Waxing gibbous","Full moon","Waning gibbous","Last quarter","Waning crescent"];
  const mpos = SunCalc.getMoonPosition(sd.date, lat, lng);
  $("#sun-moon").innerHTML = `
    <tr><td>Phase</td><td>${phases[Math.round(mi.phase * 8) % 8]}</td></tr>
    <tr><td>Illumination</td><td>${(mi.fraction * 100).toFixed(0)}%</td></tr>
    <tr><td>Moon altitude</td><td>${(mpos.altitude * 180 / Math.PI).toFixed(1)}°</td></tr>`;

  if (alt > 0) {
    const p = state.point;
    state.sunLayer.addLayer(L.polyline([p, project(p, az, 400)], { color: "#ffd23e", weight: 3, opacity: .9 }));
    state.sunLayer.addLayer(L.polyline([p, project(p, shadowAz, 200)], { color: "#30363f", weight: 5, opacity: .85 }));
    state.sunLayer.addLayer(L.circleMarker(project(p, az, 400), { radius: 7, color: "#ffd23e", fillColor: "#ffd23e", fillOpacity: 1 }));
  }
  drawSunChart(sd, lat, lng);

  const dstr = `${sd.Y}.${String(sd.M).padStart(2, "0")}.${String(sd.D).padStart(2, "0")}`;
  const tstr = $("#sun-dt").value.split("T")[1];
  $("#sun-links").innerHTML = `
    <a class="btn" target="_blank" href="https://www.suncalc.org/#/${lat.toFixed(5)},${lng.toFixed(5)},15/${dstr}/${tstr}/1/3">SunCalc.org ⇗</a>
    <a class="btn" target="_blank" href="https://shademap.app/@${lat.toFixed(5)},${lng.toFixed(5)},15z">ShadeMap (3-D shadows) ⇗</a>
    <a class="btn" target="_blank" href="https://www.peakfinder.com/?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}">PeakFinder horizon ⇗</a>`;
}

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

function runSolver() {
  const out = $("#solver-out");
  if (!state.point) { out.innerHTML = `<p class="nomatch">Set the active point first.</p>`; return; }
  const azT = parseFloat($("#solver-az").value);
  const ratioT = parseFloat($("#solver-ratio").value);
  const tol = parseFloat($("#solver-tol").value) || 8;
  if (isNaN(azT) && isNaN(ratioT)) { out.innerHTML = `<p class="nomatch">Enter a shadow azimuth and/or a length ratio.</p>`; return; }
  const sd = sunDate();
  const { lat, lng } = state.point;
  const matches = [];
  for (let m = 0; m < 1440; m += 2) {
    const d = new Date(Date.UTC(sd.Y, sd.M - 1, sd.D, 0, m) - sd.off * 3600e3);
    const pos = SunCalc.getPosition(d, lat, lng);
    if (pos.altitude <= 0.02) continue;
    const shAz = (compassAz(pos.azimuth) + 180) % 360;
    const ratio = 1 / Math.tan(pos.altitude);
    let ok = true, err = 0;
    if (!isNaN(azT)) {
      const dAz = Math.min(Math.abs(shAz - azT), 360 - Math.abs(shAz - azT));
      if (dAz > tol) ok = false; else err += dAz;
    }
    if (ok && !isNaN(ratioT)) {
      const dR = Math.abs(ratio - ratioT) / ratioT;
      if (dR > 0.18) ok = false; else err += dR * 20;
    }
    if (ok) matches.push({ m, shAz, ratio, err });
  }
  if (!matches.length) {
    out.innerHTML = `<p class="nomatch">✗ No time on this date matches at this location — the claimed
      place/date is inconsistent with the shadow, or your measurements need a wider tolerance.</p>`;
    return;
  }
  // group contiguous runs, report each window
  const groups = [];
  let g = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].m - matches[i - 1].m <= 6) g.push(matches[i]);
    else { groups.push(g); g = [matches[i]]; }
  }
  groups.push(g);
  const hm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  out.innerHTML = groups.map((gr) => {
    const best = gr.reduce((a, b) => (a.err < b.err ? a : b));
    return `<div class="match">✓ ${hm(gr[0].m)}–${hm(gr[gr.length - 1].m)} local
      (best ${hm(best.m)} · shadow→${best.shAz.toFixed(0)}° · ${best.ratio.toFixed(2)}×)</div>`;
  }).join("");
}

/* ══════════════════════════ WEATHER ════════════════════════════ */
const WMO = {
  0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Rime fog",
  51:"Light drizzle",53:"Drizzle",55:"Dense drizzle",56:"Freezing drizzle",57:"Freezing drizzle",
  61:"Light rain",63:"Rain",65:"Heavy rain",66:"Freezing rain",67:"Freezing rain",
  71:"Light snow",73:"Snow",75:"Heavy snow",77:"Snow grains",
  80:"Rain showers",81:"Rain showers",82:"Violent showers",85:"Snow showers",86:"Snow showers",
  95:"Thunderstorm",96:"Thunderstorm w/ hail",99:"Thunderstorm w/ hail" };

function initWeather() {
  $("#wx-date").value = new Date().toISOString().slice(0, 10);
  $("#wx-fetch").addEventListener("click", fetchWeather);
}

async function fetchWeather() {
  if (!state.point) { status("set the active point first", true); return; }
  const date = $("#wx-date").value;
  if (!date) return;
  const { lat, lng } = state.point;
  const ageDays = (Date.now() - new Date(date)) / 864e5;
  const base = ageDays > 6
    ? "https://archive-api.open-meteo.com/v1/archive"
    : "https://api.open-meteo.com/v1/forecast";
  const hourly = "temperature_2m,relative_humidity_2m,precipitation,snowfall,snow_depth,cloud_cover,wind_speed_10m,wind_direction_10m,weather_code";
  const url = `${base}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${date}&end_date=${date}&hourly=${hourly}&timezone=auto`;
  $("#wx-meta").textContent = "fetching…";
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.reason);
    renderWeather(j, date, ageDays > 6);
  } catch (err) {
    $("#wx-meta").textContent = "";
    $("#wx-cards").innerHTML = `<p class="nomatch">✗ ${err.message || "Open-Meteo unreachable (offline?)"}</p>`;
  }
}

function renderWeather(j, date, isArchive) {
  const h = j.hourly;
  const n = h.time.length;
  const nums = (a) => a.filter((x) => x != null);
  const tmax = Math.max(...nums(h.temperature_2m)), tmin = Math.min(...nums(h.temperature_2m));
  const precip = nums(h.precipitation).reduce((a, b) => a + b, 0);
  const snowMax = Math.max(0, ...nums(h.snow_depth));
  const cloudAvg = nums(h.cloud_cover).reduce((a, b) => a + b, 0) / Math.max(1, nums(h.cloud_cover).length);
  const windMax = Math.max(...nums(h.wind_speed_10m));
  $("#wx-meta").textContent =
    `${date} · ${j.timezone} (UTC${j.utc_offset_seconds >= 0 ? "+" : ""}${j.utc_offset_seconds / 3600}) · ` +
    `${isArchive ? "ERA5 reanalysis archive" : "forecast model (recent date)"} · elevation ${j.elevation} m`;
  $("#wx-cards").innerHTML = `
    <div class="card"><div class="v">${tmin.toFixed(0)}…${tmax.toFixed(0)}°C</div><div class="k">temperature</div></div>
    <div class="card"><div class="v">${precip.toFixed(1)} mm</div><div class="k">precipitation</div></div>
    <div class="card"><div class="v">${cloudAvg.toFixed(0)}%</div><div class="k">avg cloud cover</div></div>
    <div class="card"><div class="v">${snowMax > 0.005 ? (snowMax * 100).toFixed(0) + " cm" : "none"}</div><div class="k">snow depth</div></div>
    <div class="card"><div class="v">${windMax.toFixed(0)} km/h</div><div class="k">max wind</div></div>`;
  let rows = `<tr><th>local</th><th>°C</th><th>cloud%</th><th>precip</th><th>snow cm</th><th>wind</th><th>sky</th></tr>`;
  for (let i = 0; i < n; i++) {
    rows += `<tr><td>${h.time[i].slice(11)}</td><td>${h.temperature_2m[i] ?? "—"}</td>
      <td>${h.cloud_cover[i] ?? "—"}</td><td>${h.precipitation[i] ?? "—"}</td>
      <td>${h.snow_depth[i] != null ? (h.snow_depth[i] * 100).toFixed(0) : "—"}</td>
      <td>${h.wind_speed_10m[i] ?? "—"} ${h.wind_direction_10m[i] != null ? cardinal(h.wind_direction_10m[i]) : ""}</td>
      <td style="text-align:left">${WMO[h.weather_code[i]] ?? h.weather_code[i] ?? "—"}</td></tr>`;
  }
  $("#wx-table").innerHTML = rows;
  const { lat, lng } = state.point;
  const ymd = date.replaceAll("-", "");
  $("#wx-links").innerHTML = `
    <a class="btn" target="_blank" href="https://www.ventusky.com/?p=${lat.toFixed(3)};${lng.toFixed(3)};8&l=clouds-total&t=${ymd}/1200">Ventusky ⇗</a>
    <a class="btn" target="_blank" href="https://zoom.earth/maps/satellite/#view=${lat.toFixed(3)},${lng.toFixed(3)},8z/date=${date},12:00,+0">Zoom Earth (sat archive) ⇗</a>
    <a class="btn" target="_blank" href="https://worldview.earthdata.nasa.gov/?v=${(lng - 4).toFixed(2)},${(lat - 3).toFixed(2)},${(lng + 4).toFixed(2)},${(lat + 3).toFixed(2)}&t=${date}">NASA Worldview ⇗</a>
    <a class="btn" target="_blank" href="https://www.windy.com/${lat.toFixed(3)}/${lng.toFixed(3)}">Windy ⇗</a>`;
}

/* ═══════════════════════════ IMAGE ═════════════════════════════ */
function initImage() {
  const dz = $("#dropzone"), fi = $("#file-input");
  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", () => fi.files[0] && loadImage(fi.files[0]));
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) loadImage(f);
  });
  $("#img-url").addEventListener("input", renderUrlButtons);
  $("#img-url-all").addEventListener("click", () => {
    const u = $("#img-url").value.trim();
    if (!u) return status("enter an image URL first", true);
    engineUrls(u).forEach((e) => window.open(e.url, "_blank"));
  });
  renderUrlButtons();
}

const engineUrls = (u) => {
  const e = encodeURIComponent(u);
  return [
    { name: "Google Lens", url: `https://lens.google.com/uploadbyurl?url=${e}` },
    { name: "Yandex", url: `https://yandex.com/images/search?rpt=imageview&url=${e}` },
    { name: "Bing", url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${e}` },
    { name: "TinEye", url: `https://tineye.com/search?url=${e}` },
  ];
};

function renderUrlButtons() {
  const u = $("#img-url").value.trim();
  $("#img-url-btns").innerHTML = u
    ? engineUrls(u).map((e) => `<a class="btn" target="_blank" href="${e.url}">${e.name} ⇗</a>`).join("")
    : "";
}

/* Deep metadata dump via the locally installed ExifTool (server-side, stays on-machine). */
function exiftoolButton() {
  if (!state.tools || !state.tools.exiftool || !state.tools.exiftool.found) return "";
  return `<div class="gps-actions"><button class="btn" id="exiftool-dump">⚙ FULL METADATA (ExifTool)</button></div>
    <div id="exiftool-out"></div>`;
}

async function exiftoolDump() {
  const out = $("#exiftool-out");
  out.innerHTML = `<p class="hint">running ExifTool locally…</p>`;
  try {
    const r = await fetch("/api/exif", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream",
                 "X-Filename": encodeURIComponent(state.lastFile.name) },
      body: state.lastFile,
    });
    const j = await r.json();
    if (j.error) { out.innerHTML = `<p class="nomatch">✗ ${j.error}</p>`; return; }
    const keys = Object.keys(j.tags);
    out.innerHTML = `<h3>ExifTool — ${keys.length} tags</h3>
      <div class="table-scroll"><table class="kv">${keys.map((k) =>
        `<tr><td>${esc(k)}</td><td>${esc(String(j.tags[k]).slice(0, 200))}</td></tr>`).join("")}</table></div>`;
  } catch { out.innerHTML = `<p class="nomatch">✗ local server unreachable</p>`; }
}

async function loadImage(file) {
  const img = $("#img-preview");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  state.lastFile = file;
  state.imgLayer.clearLayers();
  const out = $("#exif-out");
  out.innerHTML = `<p class="hint">reading metadata…</p>`;
  let ex = null;
  try { ex = await exifr.parse(file, { gps: true, exif: true, tiff: true, ifd0: true }); } catch { /* not parseable */ }
  if (!ex || Object.keys(ex).length === 0) {
    out.innerHTML = `<h3>EXIF</h3><p class="hint">No metadata found — typical for images from social media
      (Twitter/X, Facebook, Telegram strip EXIF on upload). The pixels are still searchable below.</p>
      ${exiftoolButton()}`;
    const b0 = $("#exiftool-dump");
    if (b0) b0.onclick = exiftoolDump;
    return;
  }
  const rows = [];
  // EXIF strings are attacker-controlled file content — always escape.
  const add = (k, v, raw) => v != null && v !== "" && rows.push(`<tr><td>${k}</td><td>${raw ? v : esc(v)}</td></tr>`);
  add("Camera", [ex.Make, ex.Model].filter(Boolean).join(" "));
  add("Taken", ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal).toLocaleString() : null);
  add("Software", ex.Software);
  add("Lens", ex.LensModel);
  add("Exposure", ex.ExposureTime ? `1/${Math.round(1 / ex.ExposureTime)}s · f/${ex.FNumber} · ISO ${ex.ISO}` : null);
  let gpsHtml = "";
  if (ex.latitude != null && ex.longitude != null) {
    const ll = L.latLng(ex.latitude, ex.longitude);
    add("GPS", `${fmtDD(ll)} ${ex.GPSAltitude ? `· alt ${Math.round(ex.GPSAltitude)} m` : ""}`);
    if (ex.GPSImgDirection != null) add("Camera facing", `${Math.round(ex.GPSImgDirection)}° (${cardinal(ex.GPSImgDirection)})`);
    gpsHtml = `<div class="gps-actions">
      <button class="btn accent" id="exif-goto">⌖ GO TO GPS POSITION</button>
      <button class="btn" id="exif-copy">⧉ copy</button></div>`;
    // plot marker + camera view cone
    const mk = L.circleMarker(ll, { radius: 8, color: "#7ee787", fillColor: "#7ee787", fillOpacity: .6 })
      .bindTooltip("photo GPS", { permanent: false });
    state.imgLayer.addLayer(mk);
    if (ex.GPSImgDirection != null) {
      const d = ex.GPSImgDirection;
      state.imgLayer.addLayer(L.polygon([ll, project(ll, d - 25, 280), project(ll, d + 25, 280)],
        { color: "#7ee787", weight: 1, fillOpacity: .15 }));
    }
  } else {
    add("GPS", "<i>none embedded</i>", true);
  }
  out.innerHTML = `<h3>EXIF</h3><table class="kv">${rows.join("")}</table>${gpsHtml}
    ${exiftoolButton()}
    <p class="srcnote">EXIF can be edited or spoofed — treat as a lead, not proof. Cross-check with
      sun, weather and visual features. (<a target="_blank"
      href="https://www.bellingcat.com/resources/how-tos/2017/06/30/advanced-guide-verifying-video-content/">Bellingcat verification guide</a>)</p>`;
  const bd = $("#exiftool-dump");
  if (bd) bd.onclick = exiftoolDump;
  if (ex.latitude != null) {
    $("#exif-goto").onclick = () => setPoint(L.latLng(ex.latitude, ex.longitude), { fly: true, zoom: 16 });
    $("#exif-copy").onclick = () => copyText(`${ex.latitude.toFixed(6)}, ${ex.longitude.toFixed(6)}`);
  }
  if (ex.DateTimeOriginal) {
    const d = new Date(ex.DateTimeOriginal);
    const pad = (x) => String(x).padStart(2, "0");
    $("#sun-dt").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $("#wx-date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    status("EXIF timestamp copied to Sun & Weather modules");
  }
}

/* ═══════════════════════════ TOOLS ═════════════════════════════ */
/* Each url() gets (lat, lng, zoom). homepage-only tools omit url(). */
const TOOLS = [
  { g: "Imagery & 3-D", name: "Google Earth (web)", desc: "3-D globe, historical imagery slider",
    url: (a, o) => `https://earth.google.com/web/@${a},${o},0a,3000d,35y,0h,0t,0r` },
  { g: "Imagery & 3-D", name: "Google Earth Pro", desc: "desktop — best historical imagery; flies there via KML", desktop: true },
  { g: "Imagery & 3-D", name: "Esri Wayback", desc: "time machine of past satellite basemaps",
    url: (a, o, z) => `https://livingatlas.arcgis.com/wayback/#mapCenter=${o}%2C${a}%2C${Math.min(z, 17)}` },
  { g: "Imagery & 3-D", name: "Sentinel EO Browser", desc: "fresh Sentinel-2 imagery, NDVI, custom bands",
    url: (a, o, z) => `https://apps.sentinel-hub.com/eo-browser/?lat=${a}&lng=${o}&zoom=${Math.min(z, 16)}` },
  { g: "Imagery & 3-D", name: "Copernicus Browser", desc: "ESA Sentinel data, full archive",
    url: (a, o, z) => `https://browser.dataspace.copernicus.eu/?zoom=${Math.min(z, 16)}&lat=${a}&lng=${o}` },
  { g: "Imagery & 3-D", name: "NASA Worldview", desc: "daily MODIS/VIIRS — fires, smoke, storms by date",
    url: (a, o) => `https://worldview.earthdata.nasa.gov/?v=${(+o - 4).toFixed(2)},${(+a - 3).toFixed(2)},${(+o + 4).toFixed(2)},${(+a + 3).toFixed(2)}` },
  { g: "Imagery & 3-D", name: "Zoom Earth", desc: "near-live satellite + historical daily archive",
    url: (a, o, z) => `https://zoom.earth/#view=${a},${o},${Math.min(z, 18)}z` },

  { g: "Street-level", name: "Google Street View", desc: "drops you into pano at active point",
    url: (a, o) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${a},${o}` },
  { g: "Street-level", name: "Mapillary", desc: "crowdsourced street photos — covers where Google doesn't",
    url: (a, o, z) => `https://www.mapillary.com/app/?lat=${a}&lng=${o}&z=${z}` },
  { g: "Street-level", name: "KartaView", desc: "open street-level imagery (ex-OpenStreetCam)",
    url: (a, o, z) => `https://kartaview.org/map/@${a},${o},${z}z` },
  { g: "Street-level", name: "Yandex Panoramas", desc: "best street coverage in ex-USSR",
    url: (a, o, z) => `https://yandex.com/maps/?ll=${o},${a}&z=${z}&l=stv,sta` },
  { g: "Street-level", name: "Mapy.com (Czech)", desc: "excellent European panoramas + hiking maps",
    url: (a, o, z) => `https://mapy.com/en/turisticka?x=${o}&y=${a}&z=${z}` },
  { g: "Street-level", name: "Baidu Maps", desc: "China street view (Total View) — use for PRC",
    url: (a, o) => `https://map.baidu.com/?latlng=${a},${o}` },

  { g: "Maps & data", name: "Google Maps", desc: "reference map + business data",
    url: (a, o, z) => `https://www.google.com/maps/@${a},${o},${z}z` },
  { g: "Maps & data", name: "Bing Maps", desc: "Bird's Eye oblique aerials (US/EU cities)",
    url: (a, o, z) => `https://www.bing.com/maps?cp=${a}~${o}&lvl=${z}&style=h` },
  { g: "Maps & data", name: "Yandex Maps", desc: "superior detail in Russia/CIS",
    url: (a, o, z) => `https://yandex.com/maps/?ll=${o},${a}&z=${z}` },
  { g: "Maps & data", name: "OpenStreetMap", desc: "raw OSM — query individual mapped objects",
    url: (a, o, z) => `https://www.openstreetmap.org/#map=${z}/${a}/${o}` },
  { g: "Maps & data", name: "Overpass Turbo", desc: "query OSM: 'all churches near rail within 500 m'",
    url: (a, o, z) => `https://overpass-turbo.eu/?C=${a};${o};${z}` },
  { g: "Maps & data", name: "Bellingcat OSM Search", desc: "find places matching feature combinations" ,
    url: () => `https://osm-search.bellingcat.com/` },
  { g: "Maps & data", name: "OpenInfraMap", desc: "power lines, substations, telecom, pipelines",
    url: (a, o, z) => `https://openinframap.org/#${z}/${a}/${o}` },
  { g: "Maps & data", name: "OpenRailwayMap", desc: "rail lines, gauges, electrification — great clue source",
    url: (a, o, z) => `https://www.openrailwaymap.org/?lat=${a}&lon=${o}&zoom=${z}` },
  { g: "Maps & data", name: "Wikimapia", desc: "user-annotated places incl. industrial/military",
    url: (a, o, z) => `https://wikimapia.org/#lang=en&lat=${a}&lon=${o}&z=${z}` },
  { g: "Maps & data", name: "F4map 3-D", desc: "3-D buildings from OSM data",
    url: (a, o, z) => `https://demo.f4map.com/#lat=${a}&lon=${o}&zoom=${z}` },
  { g: "Maps & data", name: "what3words", desc: "convert w3w addresses seen in posts",
    url: (a, o, z) => `https://what3words.com/?maptype=satellite&zoom=${z}&center=${a},${o}` },

  { g: "Terrain & horizon", name: "PeakVisor", desc: "match mountain skylines to ID location",
    url: (a, o) => `https://peakvisor.com/panorama.html?lat=${a}&lng=${o}` },
  { g: "Terrain & horizon", name: "PeakFinder", desc: "rendered horizon from any point",
    url: (a, o) => `https://www.peakfinder.com/?lat=${a}&lng=${o}` },
  { g: "Terrain & horizon", name: "Topographic-map.com", desc: "elevation shading & contours",
    url: (a, o) => `https://en-gb.topographic-map.com/?center=${a}%2C${o}` },
  { g: "Terrain & horizon", name: "ShadeMap", desc: "terrain+building shadows at any date/time",
    url: (a, o, z) => `https://shademap.app/@${a},${o},${Math.min(z, 18)}z` },

  { g: "Weather & environment", name: "Ventusky", desc: "weather model maps incl. past dates",
    url: (a, o, z) => `https://www.ventusky.com/?p=${a};${o};${Math.min(z, 11)}` },
  { g: "Weather & environment", name: "Windy", desc: "wind/cloud/webcams — webcams are an OSINT gem",
    url: (a, o) => `https://www.windy.com/${a}/${o}` },
  { g: "Weather & environment", name: "earth.nullschool", desc: "global wind/ocean currents visual",
    url: (a, o) => `https://earth.nullschool.net/#current/wind/surface/level/orthographic=${o},${a},1024` },

  { g: "Transport trackers", name: "Flightradar24", desc: "live + historical aircraft (contrails in photos!)",
    url: (a, o, z) => `https://www.flightradar24.com/${(+a).toFixed(2)},${(+o).toFixed(2)}/${Math.min(z, 12)}` },
  { g: "Transport trackers", name: "MarineTraffic", desc: "ship positions — ID vessels in harbour shots",
    url: (a, o, z) => `https://www.marinetraffic.com/en/ais/home/centerx:${(+o).toFixed(2)}/centery:${(+a).toFixed(2)}/zoom:${Math.min(z, 14)}` },

  { g: "AI geolocation (uploads leave your machine!)", name: "GeoSpy", desc: "AI photo geolocation — closed, commercial", caution: true,
    url: () => `https://geospy.ai/` },
  { g: "AI geolocation (uploads leave your machine!)", name: "Picarta", desc: "AI photo geolocation — free tier", caution: true,
    url: () => `https://picarta.ai/` },
];

/* Local desktop tools (detected by the server) shown above the web tools.
   ExifTool is CLI-only: it powers the deep dump in the Image module. */
const LOCAL_TOOL_DESC = {
  exiftool: "powers the FULL METADATA dump in the Image module",
  google_earth_pro: "flies to the active point via KML (see Imagery group)",
  qgis: "professional GIS — load rasters, georeference photos",
  sherloq: "open-source image forensics (ELA, clone detection, noise)",
};

function renderLocalTools() {
  const t = state.tools;
  if (!t) return "";
  return `<div class="tool-group"><h3>Local desktop tools (this computer)</h3>
    ${Object.entries(t).map(([key, st]) => {
      const launchable = st.found && st.kind === "gui" && key !== "google_earth_pro";
      return `<div class="tool-item ${st.found ? "" : "disabled"}" data-local="${launchable ? key : ""}">
        <span class="t-name">${st.label}</span>
        <span class="tag desktop">${st.found ? "✓ INSTALLED" : "MISSING"}</span>
        <span class="t-desc">${st.found
          ? (LOCAL_TOOL_DESC[key] || st.path)
          : `install: <code>${st.install}</code>`}</span>
        ${launchable ? `<span class="t-go">▶</span>` : ""}</div>`;
    }).join("")}</div>`;
}

function renderTools() {
  const wrap = $("#tools-list");
  const p = state.point;
  const groups = [...new Set(TOOLS.map((t) => t.g))];
  wrap.innerHTML = renderLocalTools() + groups.map((g) => `
    <div class="tool-group"><h3>${g}</h3>
    ${TOOLS.filter((t) => t.g === g).map((t) => {
      const idx = TOOLS.indexOf(t);
      const needsPt = !!t.url && t.url.length > 0;
      const dis = (needsPt || t.desktop) && !p;
      return `<div class="tool-item ${dis ? "disabled" : ""}" data-idx="${idx}">
        <span class="t-name">${t.name}</span>
        ${t.desktop ? `<span class="tag desktop">DESKTOP</span>` : ""}
        ${t.caution ? `<span class="tag caution">UPLOADS</span>` : ""}
        <span class="t-desc">${t.desc}</span><span class="t-go">⇗</span></div>`;
    }).join("")}</div>`).join("");
  wrap.querySelectorAll(".tool-item:not(.disabled)[data-idx]").forEach((el) => {
    el.addEventListener("click", () => launchTool(TOOLS[+el.dataset.idx]));
  });
  wrap.querySelectorAll("[data-local]").forEach((el) => {
    const key = el.dataset.local;
    if (key) el.addEventListener("click", () => launchLocal(key));
  });
}

async function launchLocal(key) {
  try {
    const r = await fetch("/api/launch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: key }),
    });
    const j = await r.json();
    status(j.error ? j.error : `${key} launching…`, !!j.error, 8000);
  } catch { status("local server unreachable", true); }
}

async function launchTool(t) {
  const p = state.point, z = state.map.getZoom();
  if (t.desktop) {
    if (!p) return;
    try {
      const r = await fetch("/api/flyto", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: p.lat, lng: p.lng, name: fmtDD(p) }),
      });
      const j = await r.json();
      if (j.error) status(j.error, true, 8000);
      else status("Google Earth Pro launching…");
    } catch { status("local server unreachable", true); }
    return;
  }
  if (!t.url) return;
  const needsPt = t.url.length > 0;
  if (needsPt && !p) return;
  window.open(needsPt ? t.url(p.lat.toFixed(5), p.lng.toFixed(5), z) : t.url(), "_blank");
}

/* ═══════════════════════ DATA LAYERS ═══════════════════════════ */
/* OSM feature presets — each maps to Overpass selectors run on the view bbox */
const OSM_PRESETS = [
  ["Mines & quarries", ['nwr["man_made"~"mineshaft|adit"]', 'nwr["landuse"="quarry"]', 'nwr["historic"="mine"]']],
  ["Hospitals & clinics", ['nwr["amenity"~"hospital|clinic"]']],
  ["Power plants & substations", ['nwr["power"~"plant|substation"]']],
  ["Wind turbines", ['nwr["generator:source"="wind"]']],
  ["Fuel stations", ['nwr["amenity"="fuel"]']],
  ["Railway stations", ['nwr["railway"="station"]']],
  ["Places of worship", ['nwr["amenity"="place_of_worship"]']],
  ["Towers & masts", ['nwr["man_made"~"^(tower|mast|communications_tower)$"]']],
  ["Airfields & helipads", ['nwr["aeroway"~"aerodrome|helipad"]']],
  ["Military areas", ['nwr["landuse"="military"]', 'nwr["military"]']],
  ["Water towers", ['nwr["man_made"="water_tower"]']],
  ["Lighthouses", ['nwr["man_made"="lighthouse"]']],
];

function initData() {
  const sel = $("#data-preset");
  OSM_PRESETS.forEach(([name], i) => {
    const o = document.createElement("option"); o.value = i; o.textContent = name;
    sel.appendChild(o);
  });
  $("#data-run").addEventListener("click", () => runOverpass(OSM_PRESETS[+sel.value][1], OSM_PRESETS[+sel.value][0]));
  $("#data-run-custom").addEventListener("click", () => {
    const m = $("#data-custom").value.trim().match(/^([\w:]+)\s*=\s*([\w:;|-]+)$/);
    if (!m) return status("custom tag must look like  key=value", true);
    runOverpass([`nwr["${m[1]}"="${m[2]}"]`], `${m[1]}=${m[2]}`);
  });
  $("#data-clear").addEventListener("click", () => {
    state.dataLayer.clearLayers();
    $("#data-status").textContent = "";
  });
  $("#gbif-add").addEventListener("click", () => gbifOverlay($("#gbif-name").value.trim()));
  $("#wx-wind-load").addEventListener("click", loadWindEmbed);
}

async function runOverpass(selectors, label) {
  if (state.map.getZoom() < 8) return status("zoom in (≥ city scale) before plotting OSM features", true, 6000);
  const b = state.map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(",");
  const q = `[out:json][timeout:60];(${selectors.map((s) => `${s}(${bbox});`).join("")});out center 600;`;
  $("#data-status").textContent = `querying OSM for ${label}…`;
  try {
    const r = await fetch("/api/overpass", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.dataLayer.clearLayers();
    let n = 0;
    for (const el of j.elements || []) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const name = el.tags?.name || el.tags?.operator || label;
      const mk = L.circleMarker([lat, lon], {
        radius: 6, color: "#ffb454", fillColor: "#ffb454", fillOpacity: 0.55, weight: 1.5,
      }).bindPopup(
        `<b>${esc(name)}</b><br><span style="font-family:monospace">${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br>` +
        `<a href="https://www.openstreetmap.org/${el.type}/${el.id}" target="_blank">OSM object</a> · ` +
        `<a href="#" onclick="setPoint(L.latLng(${lat},${lon}));return false">set active point</a>`);
      state.dataLayer.addLayer(mk);
      n++;
    }
    $("#data-status").textContent = `${label}: ${n} features in view (cached 7 days; 600 max)`;
    status(`${n} × ${label} plotted`);
  } catch (err) {
    $("#data-status").textContent = "";
    status(err.message || "Overpass failed", true, 8000);
  }
}

async function gbifOverlay(name, knownKey) {
  if (!name && !knownKey) return;
  try {
    let key = knownKey, shown = name;
    if (!key) {
      const r = await fetch("https://api.gbif.org/v1/species/match?name=" + encodeURIComponent(name));
      const j = await r.json();
      if (!j.usageKey) return status(`GBIF: no match for "${name}"`, true);
      key = j.usageKey; shown = j.canonicalName || name;
    }
    if (state.gbifLayers[key]) return status("overlay already active");
    const tl = L.tileLayer(
      `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey=${key}&style=purpleYellow.point`,
      { opacity: 0.85, attribution: "Occurrences © GBIF" }).addTo(state.map);
    state.gbifLayers[key] = tl;
    const chip = document.createElement("span");
    chip.className = "tag desktop";
    chip.style.cssText = "cursor:pointer;margin:4px 6px 0 0;display:inline-block";
    chip.textContent = `● ${shown} ✕`;
    chip.onclick = () => { state.map.removeLayer(tl); delete state.gbifLayers[key]; chip.remove(); };
    $("#gbif-active").appendChild(chip);
    status(`GBIF distribution overlay: ${shown}`);
  } catch { status("GBIF unreachable", true); }
}

function loadWindEmbed() {
  const p = state.point || state.map.getCenter();
  $("#wx-wind").innerHTML =
    `<iframe width="100%" height="380" style="border:1px solid var(--line);border-radius:4px" loading="lazy"
      src="https://embed.windy.com/embed2.html?lat=${p.lat.toFixed(3)}&lon=${p.lng.toFixed(3)}&detailLat=${p.lat.toFixed(3)}&detailLon=${p.lng.toFixed(3)}&zoom=6&level=surface&overlay=wind&menu=&message=true&marker=true&calendar=now&type=map&location=coordinates&metricWind=km%2Fh&metricTemp=%C2%B0C"></iframe>`;
}

/* ═══════════════════════ wiring / keyboard ═════════════════════ */
function initKeys() {
  document.addEventListener("keydown", (e) => {
    const inField = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === "Escape") {
      if (state.measure.on) return toggleMeasure(false);
      $("#help-overlay").hidden = true;
      if (!inField) closePanel();
      return;
    }
    if (inField) return;
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    const mods = { 1: "sun", 2: "weather", 3: "image", 4: "tools", 6: "data",
      s: "sun", w: "weather", i: "image", t: "tools", d: "data" };
    if (mods[e.key.toLowerCase()]) openModule(mods[e.key.toLowerCase()]);
    if (e.key.toLowerCase() === "m") toggleMeasure();
    if (e.key === "5" || e.key.toLowerCase() === "f") window.open("search.html", "_blank");
  });
}

async function initStatus() {
  try {
    const r = await fetch("/api/status");
    const j = await r.json();
    state.tools = j.tools;
    const found = Object.values(j.tools).filter((t) => t.found).length;
    $("#ge-status").textContent =
      `local tools: ${found}/${Object.keys(j.tools).length} · ` +
      `wiki: ${j.wiki_built ? "✓ built" : "✗ not built (run run.bat)"}`;
    if (state.module === "tools") renderTools();
  } catch { $("#ge-status").textContent = "local API offline"; }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap(); initSearch(); initSun(); initWeather(); initImage(); initData(); initKeys(); initStatus();
  // deep links: #ll=lat,lng (from search) and #species=gbifKey&name=... (from flora wiki)
  const ll = location.hash.match(/^#ll=(-?[\d.]+),(-?[\d.]+)/);
  if (ll) setPoint(L.latLng(+ll[1], +ll[2]), { fly: true, zoom: 13 });
  const sp = location.hash.match(/^#species=(\d+)(?:&name=([^&]+))?/);
  if (sp) { openModule("data"); gbifOverlay(decodeURIComponent(sp[2] || "species"), +sp[1]); }
  $$(".rail-btn[data-module]").forEach((b) => b.addEventListener("click", () => openModule(b.dataset.module)));
  $("#panel-close").addEventListener("click", closePanel);
  $("#btn-measure").addEventListener("click", () => toggleMeasure());
  $("#btn-help").addEventListener("click", () => { $("#help-overlay").hidden = false; });
  $("#btn-copy-dd").addEventListener("click", () => state.point && copyText(fmtDD(state.point)));
  $("#btn-copy-dms").addEventListener("click", () => state.point && copyText(fmtDMS(state.point)));
});
