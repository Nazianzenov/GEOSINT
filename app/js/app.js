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
  measure: { on: false, pts: [], line: null, tip: null, verts: [], dragIdx: null, shift: false, radius: null },
  tools: null,            // /api/status -> local desktop tool availability
  lastFile: null,         // last image dropped into the Image module
  artifacts: [],          // case v2 evidence log — see ARTIFACTS section
};

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
/* HTML-escape untrusted strings (EXIF fields, geocoder responses) before innerHTML */
const esc = (s) => String(s).replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
/* All point-API calls go through the server's cached proxy (immutable data —
   historical weather, elevation — is cached effectively forever). */
const cachedFetch = (url) => fetch("/api/pget?u=" + encodeURIComponent(url));

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
/* alternative grid formats (offline, via vendor/geocoords.js) */
const fmtUTM   = (ll) => GeoCoords.toUTM(ll.lat, ll.lng).str;
const fmtMGRS  = (ll) => GeoCoords.toMGRS(ll.lat, ll.lng, 5);
const fmtPlus  = (ll) => GeoCoords.toPlusCode(ll.lat, ll.lng, 11);

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
  // all layers go through the server's 30-day disk tile cache (/tiles/...)
  const osm = L.tileLayer("/tiles/osm/{z}/{x}/{y}", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
  const esriSat = L.tileLayer("/tiles/esri-sat/{z}/{x}/{y}", {
    maxZoom: 19, attribution: "Imagery &copy; Esri — Maxar, Earthstar Geographics" });
  const topo = L.tileLayer("/tiles/opentopo/{z}/{x}/{y}", {
    maxZoom: 17, attribution: '&copy; OpenStreetMap, SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a>' });
  const dark = L.tileLayer("/tiles/carto-dark/{z}/{x}/{y}", {
    maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; <a href="https://carto.com/">CARTO</a>' });
  const hillshade = L.tileLayer("/tiles/esri-hillshade/{z}/{x}/{y}", {
    maxZoom: 16, attribution: "Hillshade &copy; Esri — terrain/relief view" });
  const esriLabels = L.tileLayer("/tiles/esri-labels/{z}/{x}/{y}", {
    maxZoom: 19, attribution: "Labels &copy; Esri" });

  state.map = L.map("map", { center: [30, 10], zoom: 3, layers: [dark], zoomControl: true });
  L.control.layers(
    { "Dark (CARTO)": dark, "OpenStreetMap": osm, "Satellite (Esri)": esriSat,
      "Topographic": topo, "Terrain hillshade (Esri)": hillshade },
    { "Place labels (Esri)": esriLabels },
    { position: "topleft" }
  ).addTo(state.map);
  L.control.scale({ imperial: true }).addTo(state.map);

  state.boundaryLayer = L.layerGroup().addTo(state.map);  // admin-area highlight (under markers)
  state.sunLayer = L.layerGroup().addTo(state.map);
  state.imgLayer = L.layerGroup().addTo(state.map);
  state.dataLayer = L.layerGroup().addTo(state.map);
  state.gbifLayers = {};   // name -> tileLayer

  state.map.on("mousemove", (e) => { $("#cursor-coords").textContent = fmtDD(e.latlng); });
  state.map.on("click", (e) => {
    if (state.measure.on) return measureClick(e.latlng);
    hideCtx();
    if (state.annoArrowPending) return finishArrow(e.latlng);   // 2nd click = arrow head
    setPoint(e.latlng);
  });
  state.map.on("contextmenu", (e) => showCtx(e));
  state.map.on("movestart zoomstart", hideCtx);
}

function setPoint(ll, opts = {}) {
  clearBoundary();                      // moving the active point drops any area highlight
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
  if (state.module === "data") syncQgisButton();
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
        const r = await cachedFetch(`https://api.open-meteo.com/v1/elevation?latitude=${ll.lat.toFixed(4)}&longitude=${ll.lng.toFixed(4)}`);
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
  if (state.measure._suppressCtx) return;           // right-click began on a measure vertex
  const ll = e.latlng, menu = $("#ctx-menu");
  const items = [
    ["Set active point here", () => setPoint(ll)],
    [`Copy  ${fmtDD(ll)}`, () => copyText(fmtDD(ll))],
    [`Copy  ${fmtDMS(ll)}`, () => copyText(fmtDMS(ll))],
    [`Copy MGRS  ${fmtMGRS(ll)}`, () => copyText(fmtMGRS(ll))],
    [`Copy UTM  ${fmtUTM(ll)}`, () => copyText(fmtUTM(ll))],
    [`Copy Plus  ${fmtPlus(ll)}`, () => copyText(fmtPlus(ll))],
    ["Open Street View here ⇗", () => window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll.lat},${ll.lng}`)],
    ["Open Google Maps here ⇗", () => window.open(`https://www.google.com/maps/@${ll.lat},${ll.lng},16z`)],
    ["Open Google Earth here ⇗", () => window.open(`https://earth.google.com/web/@${ll.lat},${ll.lng},0a,2000d,35y,0h,0t,0r`)],
  ];
  // Annotation actions are disabled while the ruler is armed: in measure mode
  // right-click drives vertex-dragging and left-click adds vertices, so adding
  // annotations there would collide. Turn the ruler off (M / Esc) to annotate.
  if (!state.measure.on) {
    items.push(
      ["✎ Add pin here", () => addPin(ll)],
      ["✎ Add label here…", () => addLabel(ll)],
      ["➶ Start arrow here", () => startArrow(ll)],
    );
  } else if (state.measure.pts.length >= 2) {
    // ruler armed with a drawn line → offer its elevation profile
    items.push(["⛰ Elevation profile of this line", () => elevationProfile()]);
  }
  menu.innerHTML = `<div class="ctx-coords">${fmtDD(ll)}</div>` +
    items.map((it, i) => `<div class="ctx-item" data-i="${i}">${it[0]}</div>`).join("");
  menu.querySelectorAll(".ctx-item").forEach((el) =>
    el.addEventListener("click", () => { hideCtx(); items[+el.dataset.i][1](); }));
  menu.style.left = Math.min(e.originalEvent.clientX, innerWidth - 260) + "px";
  menu.style.top  = Math.min(e.originalEvent.clientY, innerHeight - 320) + "px";
  menu.hidden = false;
}
const hideCtx = () => { $("#ctx-menu").hidden = true; };
document.addEventListener("click", (e) => { if (!$("#ctx-menu").contains(e.target)) hideCtx(); });

/* ── measure tool ──
   Left-click adds vertices. Right-drag a vertex to move it (distances update live).
   Hold Shift while dragging to ring the radius of the edge being changed. */
function toggleMeasure(force) {
  const m = state.measure;
  m.on = force !== undefined ? force : !m.on;
  if (m.on) cancelArrow();              // never leave an arrow half-placed when arming the ruler
  $("#btn-measure").classList.toggle("armed", m.on);
  state.map.getContainer().style.cursor = m.on ? "crosshair" : "";
  if (!m.on) clearMeasure();
  else status("measure: left-click to add points (each leg shows distance + bearing) · right-drag a point to move · hold Shift for a range ring · Esc clears", false, 7000);
}

function clearMeasure() {
  const m = state.measure;
  endVertexDrag();                                  // detach any live drag listeners
  [m.line, m.tip, ...(m.verts || [])].forEach((l) => l && state.map.removeLayer(l));
  clearRadius();
  Object.assign(m, { pts: [], line: null, tip: null, verts: [], dragIdx: null, shift: false, radius: null });
}

function measureClick(ll) {
  state.measure.pts.push(ll);
  renderMeasure();
}

/* full (re)build of polyline + draggable vertex handles — only on add/remove, not per drag-frame */
function renderMeasure() {
  const m = state.measure;
  if (!m.line) m.line = L.polyline(m.pts, { color: "#ffb454", weight: 2, dashArray: "6 4" }).addTo(state.map);
  else m.line.setLatLngs(m.pts);
  (m.verts || []).forEach((v) => state.map.removeLayer(v));
  m.verts = m.pts.map((p, i) => {
    const v = L.circleMarker(p, {
      radius: 5, color: "#ffb454", weight: 2, fillColor: "#0b0e14", fillOpacity: 1, bubblingMouseEvents: false,
    }).addTo(state.map);
    v.on("mousedown", (e) => { if (e.originalEvent.button === 2) startVertexDrag(i, e); });
    return v;
  });
  updateMeasureTotal();
}

/* lightweight per-frame update of the running tooltip: last-leg bearing +
   distance (the A→B azimuth just drawn) plus the running total. */
function updateMeasureTotal() {
  const m = state.measure;
  let total = 0;
  for (let i = 1; i < m.pts.length; i++) total += haversine(m.pts[i - 1], m.pts[i]);
  const last = m.pts[m.pts.length - 1];
  let html;
  if (m.pts.length < 2) {
    html = "click next point";
  } else {
    const a = m.pts[m.pts.length - 2], b = last;
    const legD = haversine(a, b), legAz = bearing(a, b);
    const leg = `${fmtDist(legD)} · ${legAz.toFixed(0)}° ${cardinal(legAz)}`;
    // show the running total only once there's more than one leg
    html = m.pts.length > 2
      ? `<b>${leg}</b><span class="measure-tot">Σ ${fmtDist(total)} · ${(total / 1609.344).toFixed(2)} mi</span>`
      : `<b>${leg}</b><span class="measure-tot">${(legD / 1609.344).toFixed(2)} mi</span>`;
  }
  const icon = L.divIcon({ className: "measure-tip", html, iconAnchor: [-8, 8] });
  if (!m.tip) m.tip = L.marker(last, { interactive: false, icon }).addTo(state.map);
  else m.tip.setLatLng(last).setIcon(icon);
}

function startVertexDrag(i, e) {
  const m = state.measure;
  L.DomEvent.preventDefault(e.originalEvent);       // no text selection
  m.dragIdx = i;
  m._suppressCtx = true;                            // swallow the contextmenu on right-button release
  state.map.dragging.disable();                     // don't pan the map while moving the vertex
  hideCtx();
  state.map.on("mousemove", onVertexDrag);
  state.map.on("mouseup", endVertexDrag);
  document.addEventListener("mouseup", endVertexDrag);  // catch releases outside the map
  if (m.shift) updateRadius();
}

function onVertexDrag(e) {
  const m = state.measure;
  if (m.dragIdx == null) return;
  m.pts[m.dragIdx] = e.latlng;
  m.line.setLatLngs(m.pts);
  m.verts[m.dragIdx].setLatLng(e.latlng);
  updateMeasureTotal();
  if (m.shift) updateRadius();
}

function endVertexDrag() {
  const m = state.measure;
  state.map.off("mousemove", onVertexDrag);
  state.map.off("mouseup", endVertexDrag);
  document.removeEventListener("mouseup", endVertexDrag);
  state.map.dragging.enable();
  if (m.dragIdx == null) return;
  m.dragIdx = null;
  clearRadius();
  setTimeout(() => { m._suppressCtx = false; }, 50);
}

/* range ring: circle centred on the anchor neighbour, radius = length of the edge being dragged */
function updateRadius() {
  const m = state.measure;
  if (m.dragIdx == null) return;
  const i = m.dragIdx;
  const anchorIdx = i > 0 ? i - 1 : (m.pts.length > 1 ? i + 1 : -1);
  if (anchorIdx < 0) return clearRadius();          // a lone point has no edge
  const anchor = m.pts[anchorIdx], dist = haversine(anchor, m.pts[i]);
  if (!m.radius) {
    m.radius = L.circle(anchor, { radius: dist, color: "#4cc2ff", weight: 1.5, dashArray: "4 4",
      fillColor: "#4cc2ff", fillOpacity: .06, interactive: false }).addTo(state.map);
  }
  m.radius.setLatLng(anchor).setRadius(dist);
}

function clearRadius() {
  const m = state.measure;
  if (!m.radius) return;
  state.map.removeLayer(m.radius);
  m.radius = null;
}

/* ── elevation profile along the measured line ──
   Samples N points evenly by cumulative distance, fetches their elevations in
   one batched (cached) Open-Meteo request, and draws an interactive profile. */
const ELEV_SAMPLES = 100;                   // Open-Meteo elevation accepts up to 100 coords/request
let _elevProfile = null;                    // {dists[], elevs[], total}

function lerpLatLng(a, b, t) {
  return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
}

/* return N points spaced evenly along the polyline by ground distance */
function sampleAlong(pts, n) {
  if (pts.length < 2) return [];
  const segLen = [], cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    segLen.push(d); cum.push(cum[i - 1] + d);
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [];
  const out = [];
  for (let s = 0; s < n; s++) {
    const target = (total * s) / (n - 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const t = segLen[i - 1] ? (target - cum[i - 1]) / segLen[i - 1] : 0;
    out.push({ ll: lerpLatLng(pts[i - 1], pts[i], t), d: target });
  }
  return out;
}

async function elevationProfile() {
  const pts = state.measure.pts;
  if (pts.length < 2) return status("draw a line with the ruler first", true);
  const samples = sampleAlong(pts, ELEV_SAMPLES);
  if (!samples.length) return status("line has zero length", true);
  $("#elev-panel").hidden = false;
  $("#elev-stats").textContent = "fetching elevations…";
  const lats = samples.map((s) => s.ll.lat.toFixed(5)).join(",");
  const lngs = samples.map((s) => s.ll.lng.toFixed(5)).join(",");
  try {
    const r = await cachedFetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
    const j = await r.json();
    const elevs = j.elevation;
    if (!Array.isArray(elevs) || elevs.length !== samples.length) throw new Error("bad elevation response");
    _elevProfile = { dists: samples.map((s) => s.d), elevs, total: samples[samples.length - 1].d };
    drawElevProfile();
  } catch (e) {
    $("#elev-stats").textContent = "";
    $("#elev-readout").textContent = "✗ elevation service unreachable (offline?)";
  }
}

function drawElevProfile(hoverX) {
  const p = _elevProfile;
  if (!p) return;
  const cv = $("#elev-chart"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, padL = 40, padB = 18, padT = 8, padR = 8;
  ctx.clearRect(0, 0, W, H);
  const min = Math.min(...p.elevs), max = Math.max(...p.elevs);
  const span = Math.max(1, max - min);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (plotW * p.dists[i]) / p.total;
  const y = (e) => padT + plotH * (1 - (e - min) / span);

  // gain/loss
  let gain = 0, loss = 0;
  for (let i = 1; i < p.elevs.length; i++) {
    const d = p.elevs[i] - p.elevs[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  $("#elev-stats").textContent =
    `${Math.round(min)}–${Math.round(max)} m · ↗${Math.round(gain)} ↘${Math.round(loss)} m · ${fmtDist(p.total)}`;

  // grid + axis labels
  ctx.strokeStyle = "#232a3b"; ctx.fillStyle = "#8a93a6"; ctx.font = "9px monospace";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const yy = padT + (plotH * g) / 4, ev = max - (span * g) / 4;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText(`${Math.round(ev)}`, 2, yy + 3);
  }

  // filled profile
  ctx.beginPath();
  ctx.moveTo(x(0), y(p.elevs[0]));
  for (let i = 1; i < p.elevs.length; i++) ctx.lineTo(x(i), y(p.elevs[i]));
  ctx.strokeStyle = "#7ee787"; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(x(p.elevs.length - 1), padT + plotH); ctx.lineTo(x(0), padT + plotH); ctx.closePath();
  ctx.fillStyle = "rgba(126,231,135,.10)"; ctx.fill();

  // hover crosshair + readout
  if (hoverX != null) {
    const frac = Math.min(1, Math.max(0, (hoverX - padL) / plotW));
    const idx = Math.round(frac * (p.elevs.length - 1));
    if (p.elevs[idx] != null) {
      const hx = x(idx), hy = y(p.elevs[idx]);
      ctx.strokeStyle = "#4cc2ff"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
      ctx.fillStyle = "#4cc2ff"; ctx.beginPath(); ctx.arc(hx, hy, 3, 0, 7); ctx.fill();
      $("#elev-readout").textContent =
        `${fmtDist(p.dists[idx])} along · ${Math.round(p.elevs[idx])} m`;
    }
  } else {
    $("#elev-readout").textContent = "hover the profile to read distance + elevation";
  }
}

function initElevPanel() {
  $("#elev-close").addEventListener("click", () => { $("#elev-panel").hidden = true; });
  const cv = $("#elev-chart");
  cv.addEventListener("mousemove", (e) => {
    const rect = cv.getBoundingClientRect();
    drawElevProfile((e.clientX - rect.left) * (cv.width / rect.width));
  });
  cv.addEventListener("mouseleave", () => drawElevProfile());
}

/* ── administrative-area boundary highlight (Nominatim polygon_geojson) ── */
function showBoundary(geojson) {
  state.boundaryLayer.clearLayers();
  const layer = L.geoJSON(geojson, {
    interactive: false,
    style: { color: "#4cc2ff", weight: 2, opacity: .9, fillColor: "#4cc2ff", fillOpacity: .07 },
  }).addTo(state.boundaryLayer);
  try { state.map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 13 }); }
  catch { /* degenerate geometry */ }
}
function clearBoundary() { if (state.boundaryLayer) state.boundaryLayer.clearLayers(); }

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
        const r = await cachedFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&accept-language=en&polygon_geojson=1&polygon_threshold=0.001&q=${encodeURIComponent(q)}`);
        const raw = await r.json();
        // OSM sometimes stores one place as both a way and a relation (e.g. Windhoek):
        // identical name/type/coord, different object. Collapse, preferring the relation
        // (the canonical multipolygon boundary, and the better source for the highlight).
        const RANK = { relation: 3, way: 2, node: 1 };
        const seen = new Map();
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
          const poly = d.geojson && /Polygon$/.test(d.geojson.type);   // Polygon | MultiPolygon
          // for an area, fitBounds to the polygon instead of flying to the label point
          setPoint(L.latLng(+d.lat, +d.lon),
            poly ? {} : { fly: true, zoom: d.addresstype === "country" ? 6 : 13 });
          if (poly) showBoundary(d.geojson);
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
  tools: "Tool Launcher", data: "Data Layers", anno: "Annotations" };

function openModule(name) {
  if (state.module === name) return closePanel();
  state.module = name;
  $("#panel").hidden = false;
  $("#panel-title").textContent = MODULE_TITLES[name];
  $$("#panel-body > section").forEach((s) => s.hidden = s.id !== `module-${name}`);
  $$(".rail-btn[data-module]").forEach((b) => b.classList.toggle("active", b.dataset.module === name));
  state.map.invalidateSize();
  if (name === "sun") renderSun();
  else state.sunLayer.clearLayers();              // sun/shadow overlay only shows in its own module
  if (name === "tools") renderTools();
  if (name === "anno") renderAnnoList();
}
function closePanel() {
  state.module = null;
  $("#panel").hidden = true;
  $$(".rail-btn[data-module]").forEach((b) => b.classList.remove("active"));
  state.sunLayer.clearLayers();
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

  const p = state.point;
  if (alt > 0) {
    // current shadow direction (thick grey) + sun direction (thin gold)
    state.sunLayer.addLayer(L.polyline([p, project(p, shadowAz, 200)], { color: "#30363f", weight: 5, opacity: .85 }));
    state.sunLayer.addLayer(L.polyline([p, project(p, az, 160)], { color: "#ffd23e", weight: 2, opacity: .8, dashArray: "2 4" }));
  }
  // sunrise / sunset azimuth rays for the chosen date — for "sun on the horizon" chronolocation
  const sunAzAt = (t) => (t && !isNaN(t)) ? compassAz(SunCalc.getPosition(t, lat, lng).azimuth) : null;
  const riseAz = sunAzAt(times.sunrise), setAz = sunAzAt(times.sunset);
  const ray = (deg, color, label) => {
    const end = project(p, deg, 1500);
    state.sunLayer.addLayer(L.polyline([p, end], { color, weight: 2.5, opacity: .9 })
      .bindTooltip(`${label} ${deg.toFixed(0)}° ${cardinal(deg)}`, { permanent: false }));
  };
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

/* shadow azimuth + length ratio of the sun at minute-of-day m (local to the
   chosen UTC offset) for the active point; null when the sun is at/below horizon */
function shadowAt(m, sd, lat, lng) {
  const d = new Date(Date.UTC(sd.Y, sd.M - 1, sd.D, 0, m) - sd.off * 3600e3);
  const pos = SunCalc.getPosition(d, lat, lng);
  if (pos.altitude <= 0.02) return null;
  return { shAz: (compassAz(pos.azimuth) + 180) % 360, ratio: 1 / Math.tan(pos.altitude) };
}

/* how well a shadow (shAz, ratio) fits target az/ratio; returns {ok, err} */
function shadowFit(s, azT, ratioT, tol) {
  let ok = true, err = 0;
  if (!isNaN(azT)) {
    const dAz = Math.min(Math.abs(s.shAz - azT), 360 - Math.abs(s.shAz - azT));
    if (dAz > tol) ok = false; else err += dAz;
  }
  if (ok && !isNaN(ratioT)) {
    const dR = Math.abs(s.ratio - ratioT) / ratioT;
    if (dR > 0.18) ok = false; else err += dR * 20;
  }
  return { ok, err };
}

function runSolver() {
  const out = $("#solver-out");
  if (!state.point) { out.innerHTML = `<p class="nomatch">Set the active point first.</p>`; return; }
  const azT = parseFloat($("#solver-az").value);
  const ratioT = parseFloat($("#solver-ratio").value);
  const tol = parseFloat($("#solver-tol").value) || 8;
  if (isNaN(azT) && isNaN(ratioT)) { out.innerHTML = `<p class="nomatch">Enter a shadow azimuth and/or a length ratio.</p>`; return; }
  // optional second reading taken Δ minutes after the first
  const az2 = parseFloat($("#solver-az2").value);
  const ratio2 = parseFloat($("#solver-ratio2").value);
  const dt2 = parseFloat($("#solver-dt2").value);
  const twoShadow = !isNaN(dt2) && (!isNaN(az2) || !isNaN(ratio2));
  const sd = sunDate();
  const { lat, lng } = state.point;
  const matches = [];
  for (let m = 0; m < 1440; m += 2) {
    const s = shadowAt(m, sd, lat, lng);
    if (!s) continue;
    const f = shadowFit(s, azT, ratioT, tol);
    if (!f.ok) continue;
    let err = f.err;
    const shAz = s.shAz, ratio = s.ratio;
    if (twoShadow) {
      // the second reading must also fit, Δ minutes later, at the same place/date
      const s2 = shadowAt(m + dt2, sd, lat, lng);
      if (!s2) continue;
      const f2 = shadowFit(s2, az2, ratio2, tol);
      if (!f2.ok) continue;
      err += f2.err;
    }
    matches.push({ m, shAz, ratio, err });
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
  const hm = (mins) => `${String(Math.floor(((mins % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((mins % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;
  const header = twoShadow
    ? `<p class="hint">Two-shadow mode: times where both readings fit (1st reading's time shown; 2nd is ${dt2 > 0 ? "+" : ""}${dt2} min later).</p>`
    : "";
  out.innerHTML = header + groups.map((gr) => {
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
    const r = await cachedFetch(url);
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
  initBatch();
}

/* ── batch EXIF: parse many images locally into a sortable table ── */
const _batch = { rows: [], sort: { key: "name", dir: 1 } };

function initBatch() {
  const bz = $("#batch-zone"), bi = $("#batch-input");
  bz.addEventListener("click", () => bi.click());
  bi.addEventListener("change", () => batchProcess([...bi.files]));
  ["dragover", "dragenter"].forEach((ev) => bz.addEventListener(ev, (e) => { e.preventDefault(); bz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => bz.addEventListener(ev, (e) => { e.preventDefault(); bz.classList.remove("over"); }));
  bz.addEventListener("drop", (e) => {
    // drops can be files or a dropped folder (webkit entries) — collect images
    const fs = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith("image/"));
    if (fs.length) batchProcess(fs);
  });
}

async function batchProcess(files) {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return status("no images in that drop", true);
  _batch.rows = [];
  $("#batch-status").textContent = `parsing ${imgs.length} image(s) locally…`;
  let done = 0;
  for (const f of imgs) {
    let ex = null;
    try { ex = await exifr.parse(f, { gps: true, exif: true, ifd0: true }); } catch { /* none */ }
    _batch.rows.push({
      name: f.name,
      lat: ex && ex.latitude != null ? ex.latitude : null,
      lng: ex && ex.longitude != null ? ex.longitude : null,
      taken: ex && ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal) : null,
      camera: ex ? [ex.Make, ex.Model].filter(Boolean).join(" ") : "",
      dir: ex && ex.GPSImgDirection != null ? Math.round(ex.GPSImgDirection) : null,
      size: f.size,
    });
    captureImage(f, ex);                         // case v2 evidence log (hash + thumb; deduped)
    if (++done % 10 === 0) $("#batch-status").textContent = `parsed ${done}/${imgs.length}…`;
  }
  const withGps = _batch.rows.filter((r) => r.lat != null).length;
  $("#batch-status").textContent =
    `${imgs.length} images · ${withGps} with GPS · ${_batch.rows.filter((r) => r.taken).length} with timestamp`;
  renderBatch();
}

function renderBatch() {
  const out = $("#batch-out");
  if (!_batch.rows.length) { out.innerHTML = ""; return; }
  const { key, dir } = _batch.sort;
  const val = (r) => key === "taken" ? (r.taken ? r.taken.getTime() : -Infinity)
    : key === "gps" ? (r.lat != null ? r.lat : -Infinity)
    : (r[key] ?? (typeof r[key] === "number" ? -Infinity : ""));
  const rows = [..._batch.rows].sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  const hdr = (k, label) => `<th data-k="${k}" class="batch-th">${label}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  out.innerHTML = `<table class="data batch">
    <tr>${hdr("name", "File")}${hdr("gps", "GPS")}${hdr("taken", "Taken")}${hdr("camera", "Camera")}<th>dir</th><th></th></tr>
    ${rows.map((r) => `<tr>
      <td title="${esc(r.name)}">${esc(r.name.length > 28 ? r.name.slice(0, 26) + "…" : r.name)}</td>
      <td>${r.lat != null ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` : "<span class='muted'>—</span>"}</td>
      <td>${r.taken ? esc(r.taken.toLocaleString()) : "<span class='muted'>—</span>"}</td>
      <td>${esc(r.camera) || "<span class='muted'>—</span>"}</td>
      <td>${r.dir != null ? `${r.dir}°` : ""}</td>
      <td>${r.lat != null ? `<a href="#" class="batch-go" data-lat="${r.lat}" data-lng="${r.lng}">⌖</a>` : ""}</td>
    </tr>`).join("")}
  </table>`;
  out.querySelectorAll(".batch-th").forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    _batch.sort = { key: k, dir: _batch.sort.key === k ? -_batch.sort.dir : 1 };
    renderBatch();
  });
  out.querySelectorAll(".batch-go").forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    setPoint(L.latLng(+a.dataset.lat, +a.dataset.lng), { fly: true, zoom: 15 });
  });
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

/* Deep metadata dump + embedded-preview recovery via the locally installed
   ExifTool (server-side, stays on-machine). */
function exiftoolButton() {
  if (!state.tools || !state.tools.exiftool || !state.tools.exiftool.found) return "";
  return `<div class="gps-actions">
      <button class="btn" id="exiftool-dump">⚙ FULL METADATA (ExifTool)</button>
      <button class="btn" id="exiftool-preview" title="Extract the image embedded inside this file (RAW/HEIC/JPEG preview or thumbnail). Often the UNCROPPED original — recovers what a crop or redaction cut out.">⛏ RECOVER EMBEDDED PREVIEW</button>
    </div>
    <div id="exiftool-out"></div>`;
}

/* 5B.1 — extract the largest embedded preview/thumbnail and flag any
   main-vs-preview GPS/time mismatch (a tampering signal). The preview is often
   the uncropped original — what a crop/redaction removed can still live here. */
async function previewExtract() {
  const out = $("#exiftool-out");
  out.innerHTML = `<p class="hint">extracting embedded preview locally…</p>`;
  try {
    const r = await fetch("/api/exif-preview", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-GeOSINT": "1",
                 "X-Filename": encodeURIComponent(state.lastFile.name) },
      body: state.lastFile,
    });
    // a JSON body means "no preview" or an error; image bytes mean success
    if ((r.headers.get("Content-Type") || "").startsWith("application/json")) {
      const j = await r.json();
      out.innerHTML = `<p class="nomatch">✗ ${esc(j.error || j.msg || "no embedded preview")}</p>`;
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const tag = r.headers.get("X-Preview-Tag") || "preview";
    const kb = Math.round((+r.headers.get("X-Preview-Bytes") || blob.size) / 1024);
    const gpsBad = r.headers.get("X-GPS-Mismatch") === "1";
    const timeBad = r.headers.get("X-Time-Mismatch") === "1";
    const mainGps = r.headers.get("X-Main-GPS"), prevGps = r.headers.get("X-Preview-GPS");
    const mainTime = r.headers.get("X-Main-Time"), prevTime = r.headers.get("X-Preview-Time");
    let warn = "";
    if (gpsBad || timeBad) {
      const rows = [];
      if (gpsBad) rows.push(`<tr><td>GPS</td><td>main <b>${esc(mainGps)}</b></td><td>preview <b>${esc(prevGps)}</b></td></tr>`);
      if (timeBad) rows.push(`<tr><td>time</td><td>main <b>${esc(mainTime)}</b></td><td>preview <b>${esc(prevTime)}</b></td></tr>`);
      warn = `<div class="nomatch" style="margin:6px 0">⚠ <b>Preview metadata differs from the main image</b>
        — a possible edit/splice signal. Treat as a lead, not proof.
        <table class="kv" style="margin-top:4px">${rows.join("")}</table></div>`;
    }
    out.innerHTML = `<h3>Embedded preview — ${esc(tag)} · ${kb} KB</h3>
      ${warn}
      <p class="hint">If this differs from the visible image, the original was likely cropped or edited
        after capture — the embedded copy can show what was removed.</p>
      <img src="${url}" style="max-width:100%;border:1px solid var(--line);border-radius:4px;margin:6px 0" alt="embedded preview">
      <div class="gps-actions"><a class="btn" href="${url}" download="embedded-preview.jpg">⭳ save preview</a></div>`;
  } catch { out.innerHTML = `<p class="nomatch">✗ local server unreachable</p>`; }
}

async function exiftoolDump() {
  const out = $("#exiftool-out");
  out.innerHTML = `<p class="hint">running ExifTool locally…</p>`;
  try {
    const r = await fetch("/api/exif", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-GeOSINT": "1",
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
  captureImage(file, ex);                       // case v2 evidence log (hash + thumb; deduped)
  if (!ex || Object.keys(ex).length === 0) {
    out.innerHTML = `<h3>EXIF</h3><p class="hint">No metadata found — typical for images from social media
      (Twitter/X, Facebook, Telegram strip EXIF on upload). The pixels are still searchable below.</p>
      ${exiftoolButton()}`;
    const b0 = $("#exiftool-dump");
    if (b0) b0.onclick = exiftoolDump;
    const p0 = $("#exiftool-preview");
    if (p0) p0.onclick = previewExtract;
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
  const pv = $("#exiftool-preview");
  if (pv) pv.onclick = previewExtract;
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
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
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
        method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
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
/* OSM feature presets — exact-match selectors only (regex selectors are an
   order of magnitude slower on Overpass). minZoom guards dense categories. */
const OSM_PRESETS = [
  ["Mines & quarries", ['nwr["man_made"="mineshaft"]', 'nwr["man_made"="adit"]',
    'way["landuse"="quarry"]', 'nwr["historic"="mine"]'], 8],
  ["Hospitals & clinics", ['nwr["amenity"="hospital"]', 'nwr["amenity"="clinic"]'], 10],
  ["Power plants & substations", ['nwr["power"="plant"]', 'nwr["power"="substation"]'], 9],
  ["Wind turbines", ['nwr["generator:source"="wind"]'], 8],
  ["Fuel stations", ['nwr["amenity"="fuel"]'], 11],
  ["Railway stations", ['node["railway"="station"]'], 9],
  ["Places of worship", ['nwr["amenity"="place_of_worship"]'], 12],
  ["Towers & masts", ['nwr["man_made"="tower"]', 'nwr["man_made"="mast"]',
    'nwr["man_made"="communications_tower"]'], 11],
  ["Airfields & helipads", ['nwr["aeroway"="aerodrome"]', 'nwr["aeroway"="helipad"]'], 8],
  ["Military areas", ['way["landuse"="military"]', 'nwr["military"="base"]',
    'nwr["military"="barracks"]'], 8],
  ["Water towers", ['nwr["man_made"="water_tower"]'], 9],
  ["Lighthouses", ['nwr["man_made"="lighthouse"]'], 6],
  // 5D.3 — border crossings & checkpoints (movement/conflict/migration analysis)
  ["Border crossings & checkpoints", ['nwr["barrier"="border_control"]',
    'nwr["amenity"="customs"]', 'nwr["barrier"="checkpoint"]'], 7],
  // 5D.4 — extra investigative categories
  ["Prisons & detention", ['nwr["amenity"="prison"]'], 8],
  ["Embassies & consulates", ['nwr["diplomatic"="embassy"]',
    'nwr["diplomatic"="consulate"]', 'nwr["office"="diplomatic"]'], 9],
  ["Ports & harbours", ['nwr["industrial"="port"]', 'way["landuse"="port"]',
    'nwr["harbour"="yes"]', 'nwr["amenity"="ferry_terminal"]'], 7],
  // helipads alone (the "Airfields & helipads" preset bundles them with aerodromes;
  // a helipad-only view isolates rooftop/hospital/rig pads)
  ["Helipads", ['nwr["aeroway"="helipad"]'], 10],
];

function initData() {
  const sel = $("#data-preset");
  OSM_PRESETS.forEach(([name], i) => {
    const o = document.createElement("option"); o.value = i; o.textContent = name;
    sel.appendChild(o);
  });
  $("#data-run").addEventListener("click", () => {
    const [name, selectors, minZoom] = OSM_PRESETS[+sel.value];
    runOverpass(selectors, name, minZoom);
  });
  $("#data-run-custom").addEventListener("click", () => {
    const m = $("#data-custom").value.trim().match(/^([\w:]+)\s*=\s*([\w:;|-]+)$/);
    if (!m) return status("custom tag must look like  key=value", true);
    runOverpass([`nwr["${m[1]}"="${m[2]}"]`], `${m[1]}=${m[2]}`, 10);
  });
  $("#data-clear").addEventListener("click", () => {
    state.dataLayer.clearLayers();
    state.lastData = null;
    $("#data-status").textContent = "";
    syncQgisButton();
  });
  $("#gbif-add").addEventListener("click", () => gbifOverlay($("#gbif-name").value.trim()));
  $("#wx-windy").addEventListener("click", () => openWindMap("windy"));
  $("#wx-nullschool").addEventListener("click", () => openWindMap("nullschool"));
  const qb = $("#data-qgis");
  if (qb) qb.addEventListener("click", openInQgis);
  $("#pf-run").addEventListener("click", prefetchTiles);
  syncQgisButton();
}

/* Prefetch every tile of the current view across zoom..zoom+depth into the
   server's tile cache, so the area is available offline. */
async function prefetchTiles() {
  const b = state.map.getBounds();
  const z = state.map.getZoom();
  const depth = Math.max(0, Math.min(8, parseInt($("#pf-depth").value, 10) || 0));
  const layer = $("#pf-layer").value;
  const body = {
    layer,
    bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()],
    zmin: z, zmax: Math.min(19, z + depth),
  };
  $("#pf-status").textContent = `caching ${layer} z${body.zmin}–${body.zmax} for this view…`;
  try {
    const r = await fetch("/api/prefetch", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) { $("#pf-status").textContent = `✗ ${j.error}`; return; }
    $("#pf-status").textContent =
      `✓ ${j.tiles} tiles for ${j.layer}: ${j.fetched} downloaded, ${j.cached} already cached`
      + (j.failed ? `, ${j.failed} failed` : "") + " — area available offline.";
    status(`prefetched ${j.fetched} tiles`);
  } catch { $("#pf-status").textContent = "✗ local server unreachable"; }
}

/* Enable the QGIS button only when QGIS is installed; relabel by what we'd send. */
function syncQgisButton() {
  const qb = $("#data-qgis");
  if (!qb) return;
  const has = state.tools && state.tools.qgis && state.tools.qgis.found;
  const n = state.lastData ? state.lastData.features.length : 0;
  qb.disabled = !has;
  qb.title = has ? "Open the plotted features and/or active point in QGIS as a layer"
                 : "QGIS not detected — install it to enable hand-off";
  qb.textContent = !has ? "QGIS not installed"
    : n ? `▦ OPEN ${n} FEATURE${n > 1 ? "S" : ""} IN QGIS`
        : "▦ OPEN ACTIVE POINT IN QGIS";
}

async function openInQgis() {
  const features = [];
  if (state.lastData && state.lastData.features.length) {
    for (const el of state.lastData.features) {
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [el.lon, el.lat] },
        properties: { name: el.name, osm_type: el.type, osm_id: el.id, ...el.tags } });
    }
  }
  if (state.point) {
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [state.point.lng, state.point.lat] },
      properties: { name: "active point" } });
  }
  if (!features.length) return status("plot a dataset or set the active point first", true);
  const label = (state.lastData && state.lastData.label) || "active-point";
  try {
    const r = await fetch("/api/qgis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ geojson: { type: "FeatureCollection", features }, name: label }),
    });
    const j = await r.json();
    status(j.error ? j.error : `QGIS opening with ${j.features} feature(s)…`, !!j.error, 8000);
  } catch { status("local server unreachable", true); }
}

async function runOverpass(selectors, label, minZoom = 10) {
  if (state.map.getZoom() < minZoom) {
    return status(`zoom in to at least level ${minZoom} for "${label}" (current: ${state.map.getZoom()})`, true, 6000);
  }
  const b = state.map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(",");
  const q = `[out:json][timeout:25];(${selectors.map((s) => `${s}(${bbox});`).join("")});out center 600;`;
  const t0 = Date.now();
  const tick = setInterval(() => {
    $("#data-status").textContent =
      `querying OSM for ${label}… ${Math.round((Date.now() - t0) / 1000)}s ` +
      `(first run on an area can take ~10-30s; repeats are cached)`;
  }, 500);
  $("#data-status").textContent = `querying OSM for ${label}…`;
  try {
    const r = await fetch("/api/overpass", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ q }),
    });
    clearInterval(tick);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.dataLayer.clearLayers();
    const feats = [];
    for (const el of j.elements || []) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const name = el.tags?.name || el.tags?.operator || label;
      feats.push({ lat, lon, name, type: el.type, id: el.id, tags: el.tags || {} });
      const mk = L.circleMarker([lat, lon], {
        radius: 6, color: "#ffb454", fillColor: "#ffb454", fillOpacity: 0.55, weight: 1.5,
      }).bindPopup(
        `<b>${esc(name)}</b><br><span style="font-family:monospace">${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br>` +
        `<a href="https://www.openstreetmap.org/${el.type}/${el.id}" target="_blank">OSM object</a> · ` +
        `<a href="#" onclick="setPoint(L.latLng(${lat},${lon}));return false">set active point</a>`);
      state.dataLayer.addLayer(mk);
    }
    state.lastData = { label, features: feats };
    $("#data-status").textContent =
      `${label}: ${feats.length} features in view · ${Math.round((Date.now() - t0) / 1000)}s (cached 7 days; 600 max)`;
    status(`${feats.length} × ${label} plotted`);
    syncQgisButton();
  } catch (err) {
    clearInterval(tick);
    $("#data-status").textContent = "";
    status(err.message || "Overpass failed", true, 8000);
  }
}

async function gbifOverlay(name, knownKey) {
  if (!name && !knownKey) return;
  try {
    let key = knownKey, shown = name;
    if (!key) {
      const r = await cachedFetch("https://api.gbif.org/v1/species/match?name=" + encodeURIComponent(name));
      const j = await r.json();
      if (!j.usageKey) return status(`GBIF: no match for "${name}"`, true);
      key = j.usageKey; shown = j.canonicalName || name;
    }
    if (state.gbifLayers[key]) return status("overlay already active");
    const tl = L.tileLayer(
      `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey=${key}&style=purpleYellow.point`,
      { opacity: 0.85, attribution: "Occurrences © GBIF" }).addTo(state.map);
    tl._caseName = shown;                       // remembered for case-file save/restore
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

// Wind/weather maps open on their own sites (the embedded iframe was unstable —
// Windy's player crashes on fast timeline scrubbing). For an area, state.point is
// the Nominatim centroid. Windy accepts a UTC YYYY-MM-DD-HH time in the hash.
function openWindMap(site) {
  const p = state.point || state.map.getCenter();
  const lat = p.lat.toFixed(3), lon = p.lng.toFixed(3);
  if (site === "nullschool") {                       // current conditions only
    window.open(`https://earth.nullschool.net/#current/wind/surface/level/orthographic=${lon},${lat},2000`, "_blank");
    return;
  }
  const overlay = $("#wx-wind-layer").value || "wind";
  const d = $("#wx-date").value;                      // YYYY-MM-DD from the weather panel
  // Windy URL: ?overlay,YYYY-MM-DD-HH,lat,lon,zoom (UTC; midday on the chosen date)
  const t = d ? `${d}-12,` : "";
  window.open(`https://www.windy.com/?${overlay},${t}${lat},${lon},6`, "_blank");
}

/* ═══════════════════════════ ANNOTATIONS ═══════════════════════ */
/* User overlay: pins, text labels and arrows. Added from the right-click
   context menu, stored in state.annos, drawn into state.annoLayer, persisted
   in the case file, and exportable to GeoJSON / KML. */
let _annoId = 0;
const ANNO_COLOR = "#ff7b72";

function annoInit() {
  state.annos = [];                              // {id, type:'pin'|'label'|'arrow', ll:[lat,lng], ll2?, text}
  state.annoLayer = L.layerGroup().addTo(state.map);
  state.annoArrowPending = null;                 // tail latlng while placing an arrow's head
  $("#anno-export-geojson").addEventListener("click", () => downloadAnno("geojson"));
  $("#anno-export-kml").addEventListener("click", () => downloadAnno("kml"));
  $("#anno-clear").addEventListener("click", clearAnnos);
  const qb = $("#anno-qgis");
  if (qb) qb.addEventListener("click", annoToQgis);
}

/* context-menu entry points */
function addPin(ll)   { addAnno({ type: "pin",   ll: [ll.lat, ll.lng], text: "pin" }); }
function addLabel(ll) {
  const t = prompt("Label text:", "label");
  if (t != null) addAnno({ type: "label", ll: [ll.lat, ll.lng], text: t || "label" });
}
function startArrow(ll) {
  state.annoArrowPending = ll;
  status("arrow: click the map again to set the arrow's head (Esc cancels)", false, 6000);
}
function finishArrow(ll) {
  const tail = state.annoArrowPending;
  state.annoArrowPending = null;
  addAnno({ type: "arrow", ll: [tail.lat, tail.lng], ll2: [ll.lat, ll.lng], text: "arrow" });
}
function cancelArrow() {
  if (!state.annoArrowPending) return false;
  state.annoArrowPending = null;
  status("arrow cancelled");
  return true;
}

function addAnno(a) {
  a.id = ++_annoId;
  state.annos.push(a);
  drawAnno(a);
  renderAnnoList();
  if (state.module === "anno") $("#anno-status").textContent = `${state.annos.length} annotation(s)`;
  return a;
}

function drawAnno(a) {
  if (a._layers) a._layers.forEach((l) => state.annoLayer.removeLayer(l));
  a._layers = [];
  if (a.type === "arrow") {
    // shaft + arrowhead barbs are rebuilt from a.ll/a.ll2 (drawShaft); the two
    // end handles are created once and reused so a live drag is never torn down.
    const line = L.polyline([], { color: ANNO_COLOR, weight: 3, opacity: .9 });
    const b1 = L.polyline([], { color: ANNO_COLOR, weight: 3, opacity: .9 });
    const b2 = L.polyline([], { color: ANNO_COLOR, weight: 3, opacity: .9 });
    a._drawShaft = () => {
      const p1 = L.latLng(a.ll), p2 = L.latLng(a.ll2), brng = bearing(p2, p1);
      line.setLatLngs([p1, p2]);
      b1.setLatLngs([p2, project(p2, brng - 22, headLen(p1, p2))]);
      b2.setLatLngs([p2, project(p2, brng + 22, headLen(p1, p2))]);
    };
    a._drawShaft();
    const tailH = L.marker(L.latLng(a.ll),  { draggable: true, icon: dotIcon() });
    const headH = L.marker(L.latLng(a.ll2), { draggable: true, icon: dotIcon() });
    tailH.on("drag", (e) => { a.ll = llArr(e.latlng); a._drawShaft(); });
    headH.on("drag", (e) => { a.ll2 = llArr(e.latlng); a._drawShaft(); });
    tailH.on("dragend", renderAnnoList); headH.on("dragend", renderAnnoList);
    headH.bindPopup(annoPopup(a));
    a._layers.push(line, b1, b2, tailH, headH);
  } else {
    const m = L.marker(L.latLng(a.ll), { draggable: true,
      icon: a.type === "label" ? labelIcon(a.text) : pinIcon() });
    m.on("drag", (e) => { a.ll = llArr(e.latlng); });
    m.on("dragend", (e) => { a.ll = llArr(e.latlng); renderAnnoList(); });
    m.bindPopup(annoPopup(a));
    if (a.type === "pin") m.bindTooltip(esc(a.text), { direction: "top", offset: [0, -8] });
    a._layers.push(m);
  }
  a._layers.forEach((l) => state.annoLayer.addLayer(l));
}

const llArr = (ll) => [ll.lat, ll.lng];
const headLen = (p1, p2) => Math.min(Math.max(haversine(p1, p2) * 0.18, 30), 4000);
function bearing(a, b) {                          // initial bearing a→b, degrees
  const toR = Math.PI / 180, toD = 180 / Math.PI;
  const dLng = (b.lng - a.lng) * toR;
  const y = Math.sin(dLng) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) -
            Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos(dLng);
  return (Math.atan2(y, x) * toD + 360) % 360;
}

const dotIcon  = () => L.divIcon({ className: "anno-dot", html: "", iconSize: [12, 12] });
const pinIcon  = () => L.divIcon({ className: "anno-pin", html: "📍", iconSize: [22, 22], iconAnchor: [6, 20] });
const labelIcon = (t) => L.divIcon({ className: "anno-label", html: esc(t), iconSize: null });

function annoPopup(a) {
  const div = document.createElement("div");
  div.className = "anno-pop";
  div.innerHTML = `<input class="anno-text" value="${esc(a.text)}" spellcheck="false">
    <div class="anno-pop-row"><span class="muted">${a.type}</span>
      <button class="btn anno-del">delete</button></div>`;
  div.querySelector(".anno-text").addEventListener("change", (e) => {
    a.text = e.target.value || a.type;
    drawAnno(a); renderAnnoList();
  });
  div.querySelector(".anno-del").addEventListener("click", () => removeAnno(a.id));
  return div;
}

function removeAnno(id) {
  const i = state.annos.findIndex((a) => a.id === id);
  if (i < 0) return;
  state.annos[i]._layers.forEach((l) => state.annoLayer.removeLayer(l));
  state.annos.splice(i, 1);
  renderAnnoList();
  $("#anno-status").textContent = `${state.annos.length} annotation(s)`;
}

function clearAnnos() {
  state.annoLayer.clearLayers();
  state.annos = [];
  renderAnnoList();
  $("#anno-status").textContent = "";
  status("annotations cleared");
}

function renderAnnoList() {
  const el = $("#anno-list");
  if (!el) return;
  if (!state.annos.length) { el.innerHTML = `<p class="hint">No annotations yet — right-click the map.</p>`; return; }
  const sym = { pin: "📍", label: "T", arrow: "➶" };
  el.innerHTML = state.annos.map((a) =>
    `<div class="anno-row" data-id="${a.id}">
       <span class="anno-sym">${sym[a.type] || "•"}</span>
       <span class="anno-name">${esc(a.text)}</span>
       <span class="anno-ll">${a.ll[0].toFixed(4)}, ${a.ll[1].toFixed(4)}</span>
       <button class="anno-go" title="zoom to">⌖</button>
       <button class="anno-x" title="delete">✕</button>
     </div>`).join("");
  el.querySelectorAll(".anno-row").forEach((row) => {
    const id = +row.dataset.id, a = state.annos.find((x) => x.id === id);
    row.querySelector(".anno-go").onclick = () => state.map.flyTo(L.latLng(a.ll), Math.max(state.map.getZoom(), 13));
    row.querySelector(".anno-x").onclick = () => removeAnno(id);
  });
}

/* ── export ── */
function annoFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: state.annos.map((a) => a.type === "arrow"
      ? { type: "Feature", properties: { name: a.text, kind: "arrow" },
          geometry: { type: "LineString", coordinates: [[a.ll[1], a.ll[0]], [a.ll2[1], a.ll2[0]]] } }
      : { type: "Feature", properties: { name: a.text, kind: a.type },
          geometry: { type: "Point", coordinates: [a.ll[1], a.ll[0]] } }),
  };
}

function annoKml() {
  const esx = (s) => esc(String(s));
  const placemarks = state.annos.map((a) => {
    if (a.type === "arrow") {
      return `  <Placemark><name>${esx(a.text)}</name><LineString><tessellate>1</tessellate>` +
        `<coordinates>${a.ll[1]},${a.ll[0]},0 ${a.ll2[1]},${a.ll2[0]},0</coordinates></LineString></Placemark>`;
    }
    return `  <Placemark><name>${esx(a.text)}</name>` +
      `<Point><coordinates>${a.ll[1]},${a.ll[0]},0</coordinates></Point></Placemark>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n` +
    `  <name>GeOSINT annotations</name>\n${placemarks}\n</Document></kml>\n`;
}

function downloadAnno(fmt) {
  if (!state.annos.length) return status("no annotations to export", true);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const [body, type, ext] = fmt === "kml"
    ? [annoKml(), "application/vnd.google-earth.kml+xml", "kml"]
    : [JSON.stringify(annoFeatureCollection(), null, 1), "application/geo+json", "geojson"];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = `annotations-${stamp}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`exported ${state.annos.length} annotation(s) as ${ext.toUpperCase()}`);
}

async function annoToQgis() {
  if (!state.annos.length) return status("no annotations to send", true);
  if (!(state.tools && state.tools.qgis && state.tools.qgis.found))
    return status("QGIS not detected", true);
  try {
    const r = await fetch("/api/qgis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ geojson: annoFeatureCollection(), name: "annotations" }),
    });
    const j = await r.json();
    status(j.error ? j.error : `QGIS opening with ${j.features} annotation(s)…`, !!j.error, 8000);
  } catch { status("local server unreachable", true); }
}

/* ═══════════════════════════ ARTIFACTS (case v2) ═══════════════════════════
   Append-only evidence log. Every item the analyst pulls in (an image, a logged
   observation) becomes an artifact with a timestamp and provenance, so the case
   can drive a timeline (5C.1), a sourced dossier (5C.2) and a chain-of-custody
   view (5C.3). Images store a SHA-256 of the ORIGINAL bytes + a small thumbnail
   — never the full image. All local: crypto.subtle and canvas, nothing uploaded.

   Artifact shape:
     { id, kind: 'image'|'note'|'point'|'obs',
       t: ISO8601 (observed/added time), source, sha256?, ll?, text?, thumb?,
       meta? }                                                                    */
let _artId = 0;
const _artPending = new Set();   // in-flight logImageArtifact() promises; saveCase awaits them

/* SHA-256 of a Blob/ArrayBuffer/string → lowercase hex. Uses the Web Crypto API
   (local, no network). */
async function sha256(input) {
  const buf = input instanceof Blob ? await input.arrayBuffer()
            : typeof input === "string" ? new TextEncoder().encode(input)
            : input;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Render a small JPEG thumbnail (base64 data URL) from an image File, longest
   side `max` px. Returns null if the file can't be decoded. Drawn on a canvas
   entirely in-browser. */
function makeThumbnail(file, max = 160) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      try { resolve(cv.toDataURL("image/jpeg", 0.7)); }
      catch { resolve(null); }                 // tainted canvas etc.
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* Append an artifact; defaults id + time. Returns the stored artifact. */
function addArtifact(a) {
  const art = { id: ++_artId, t: a.t || new Date().toISOString(), ...a };
  state.artifacts.push(art);
  renderEvidenceLog();
  return art;
}

/* Evidence-log readout + chain-of-custody table in the notes drawer (5C.3).
   Confirms capture is happening, originals are not stored, and gives a
   defensible, exportable provenance record. */
const ART_SYM = { image: "🖼", note: "📝", point: "📍", obs: "👁" };

function renderEvidenceLog() {
  const el = $("#evidence-log"), wrap = $("#custody-wrap");
  if (!el) return;
  const arts = state.artifacts;
  if (!arts.length) {
    el.textContent = "";
    if (wrap) wrap.hidden = true;
    return;
  }
  const imgs = arts.filter((a) => a.kind === "image").length;
  const withGps = arts.filter((a) => a.ll).length;
  el.textContent = `🔒 evidence log: ${arts.length} artifact(s) · ${imgs} image(s) · ${withGps} geotagged `
    + `— SHA-256 + thumbnail only, originals stay on disk`;
  renderCustodyTable();
  if (wrap) wrap.hidden = false;
}

/* Append-only custody table: observed time, kind, source, sha-256 (short), GPS.
   Sorted by observed time (the chronological provenance record). */
function renderCustodyTable() {
  const t = $("#custody-table");
  if (!t) return;
  const arts = [...state.artifacts].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const short = (h) => h ? `<span title="${esc(h)}" style="font-family:monospace">${esc(h.slice(0, 10))}…</span>` : "—";
  t.innerHTML = `<tr><th>observed</th><th>kind</th><th>source</th><th>sha-256</th><th>GPS</th></tr>` +
    arts.map((a) => `<tr>
      <td>${esc(String(a.t).replace("T", " ").slice(0, 19))}</td>
      <td>${ART_SYM[a.kind] || "•"} ${esc(a.kind)}</td>
      <td title="${esc(a.source || "")}">${esc((a.source || "—").slice(0, 28))}</td>
      <td>${short(a.sha256)}</td>
      <td>${a.ll ? `${a.ll[0].toFixed(4)}, ${a.ll[1].toFixed(4)}` : "—"}</td>
    </tr>`).join("");
}

/* Chain-of-custody export. JSON = the raw artifacts (minus bulky thumbnails);
   CSV = a flat provenance table for a report appendix. */
function exportCustody(fmt) {
  const arts = state.artifacts;
  if (!arts.length) return status("evidence log is empty", true);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  let body, type, ext;
  if (fmt === "csv") {
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [["id", "observed", "kind", "source", "sha256", "lat", "lng", "added", "text"]];
    [...arts].sort((a, b) => String(a.t).localeCompare(String(b.t))).forEach((a) =>
      rows.push([a.id, a.t, a.kind, a.source || "", a.sha256 || "",
                 a.ll ? a.ll[0] : "", a.ll ? a.ll[1] : "",
                 (a.meta && a.meta.added) || "", a.text || ""]));
    body = rows.map((r) => r.map(q).join(",")).join("\r\n");
    type = "text/csv"; ext = "csv";
  } else {
    // strip thumbnails so the custody record stays small and text-diffable
    const slim = arts.map(({ thumb, ...rest }) => rest);
    body = JSON.stringify({ app: "geosint-workbench", kind: "chain-of-custody",
                            exported: new Date().toISOString(), artifacts: slim }, null, 1);
    type = "application/json"; ext = "json";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = `custody-${stamp}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`exported ${arts.length} custody record(s) as ${ext.toUpperCase()}`);
}

/* ── timeline (5C.1) ──
   Chronological strip of every dated artifact plus case-context events (the
   weather date and the Sun module's date), so a sequence-of-events reads off
   one view. Each event carries an optional location → ⌖ jump-to-map. */
function timelineEvents() {
  const ev = [];
  for (const a of state.artifacts) {
    ev.push({ t: a.t, kind: a.kind, sym: ART_SYM[a.kind] || "•",
              label: a.source || a.text || a.kind,
              detail: a.kind === "image" ? (a.meta && a.meta.camera || "") : (a.text || ""),
              ll: a.ll || null, thumb: a.thumb || null,
              sha: a.sha256 || null });
  }
  // case-context events from module inputs (date-only → noon, for ordering)
  const sunDt = val("#sun-dt");
  if (sunDt) ev.push({ t: sunDt.length === 16 ? sunDt + ":00" : sunDt, kind: "context",
                       sym: "☀", label: "Sun & Shadow date", detail: "chronolocation reading",
                       ll: state.point ? [state.point.lat, state.point.lng] : null });
  const wxDate = val("#wx-date");
  if (wxDate) ev.push({ t: wxDate + "T12:00:00", kind: "context",
                        sym: "☁", label: "Weather date", detail: "meteorology lookup",
                        ll: state.point ? [state.point.lat, state.point.lng] : null });
  // sort ascending by parseable time; unparseable sink to the bottom
  const key = (e) => { const d = Date.parse(String(e.t).replace(" ", "T")); return isNaN(d) ? Infinity : d; };
  return ev.sort((a, b) => key(a) - key(b));
}

function openTimeline() {
  const panel = $("#timeline-panel"), body = $("#timeline-body");
  const ev = timelineEvents();
  $("#timeline-stats").textContent = ev.length ? `${ev.length} event(s)` : "";
  if (!ev.length) {
    body.innerHTML = `<p class="hint" style="padding:10px">No dated events yet — drop an image, or set the weather/sun dates.</p>`;
  } else {
    const fmtT = (t) => { const d = new Date(String(t).replace(" ", "T")); return isNaN(d) ? esc(String(t)) : d.toISOString().replace("T", " ").slice(0, 16); };
    body.innerHTML = `<div class="tl">${ev.map((e, i) => `
      <div class="tl-row" data-i="${i}">
        <div class="tl-time">${fmtT(e.t)}</div>
        <div class="tl-dot">${e.sym}</div>
        <div class="tl-card">
          <div class="tl-label"><b>${esc(e.label)}</b>${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ""}</div>
          ${e.thumb ? `<img src="${esc(e.thumb)}" style="max-width:120px;border-radius:3px;margin:4px 0">` : ""}
          ${e.sha ? `<div class="muted" style="font-family:monospace;font-size:11px">sha256 ${esc(e.sha.slice(0, 16))}…</div>` : ""}
          ${e.ll ? `<a href="#" class="tl-go" data-i="${i}">⌖ ${e.ll[0].toFixed(4)}, ${e.ll[1].toFixed(4)}</a>` : ""}
        </div>
      </div>`).join("")}</div>`;
    body.querySelectorAll(".tl-go").forEach((el) => el.onclick = (e) => {
      e.preventDefault();
      const ll = ev[+el.dataset.i].ll;
      if (ll) { setPoint(L.latLng(ll[0], ll[1]), { fly: true, zoom: 15 }); }
    });
  }
  panel.hidden = false;
}

/* ── dossier export (5C.2) ──
   A self-contained HTML report of the case: active point (all coord formats),
   notes, annotations, the evidence log with inline thumbnails, the timeline,
   and a sources/provenance section. Renders from case state + v2 artifacts;
   thumbnails are already base64 so no originals are needed. 100% local. */
function buildDossier() {
  const now = new Date();
  const p = state.point;
  const ptBlock = p ? `
    <table class="kv">
      <tr><td>Decimal</td><td>${esc(fmtDD(p))}</td></tr>
      <tr><td>DMS</td><td>${esc(fmtDMS(p))}</td></tr>
      <tr><td>MGRS</td><td>${esc(fmtMGRS(p))}</td></tr>
      <tr><td>UTM</td><td>${esc(fmtUTM(p))}</td></tr>
      <tr><td>Plus Code</td><td>${esc(fmtPlus(p))}</td></tr>
    </table>` : `<p class="muted">No active point set.</p>`;

  const notes = (val("#case-notes") || "").trim();
  const notesBlock = notes
    ? `<pre>${esc(notes)}</pre>` : `<p class="muted">No notes.</p>`;

  const annos = state.annos || [];
  const annoBlock = annos.length ? `<table class="kv">
      <tr><th>type</th><th>text</th><th>location</th></tr>
      ${annos.map((a) => `<tr><td>${esc(a.type)}</td><td>${esc(a.text)}</td>
        <td>${a.ll[0].toFixed(5)}, ${a.ll[1].toFixed(5)}</td></tr>`).join("")}
    </table>` : `<p class="muted">No annotations.</p>`;

  const arts = state.artifacts || [];
  const artBlock = arts.length ? `<div class="grid">
      ${[...arts].sort((a, b) => String(a.t).localeCompare(String(b.t))).map((a) => `
        <div class="ev">
          ${a.thumb ? `<img src="${esc(a.thumb)}" alt="">` : `<div class="noimg">${ART_SYM[a.kind] || "•"}</div>`}
          <div class="ev-meta">
            <b>${esc(a.source || a.text || a.kind)}</b>
            <div class="muted">${esc(String(a.t).replace("T", " ").slice(0, 19))} · ${esc(a.kind)}</div>
            ${a.ll ? `<div class="muted">${a.ll[0].toFixed(5)}, ${a.ll[1].toFixed(5)}</div>` : ""}
            ${a.sha256 ? `<div class="mono">sha256 ${esc(a.sha256)}</div>` : ""}
          </div>
        </div>`).join("")}
    </div>` : `<p class="muted">No evidence artifacts.</p>`;

  const ev = timelineEvents();
  const tlBlock = ev.length ? `<table class="kv">
      <tr><th>time</th><th>event</th><th>location</th></tr>
      ${ev.map((e) => `<tr><td class="mono">${esc(String(e.t).replace("T", " ").slice(0, 16))}</td>
        <td>${esc(e.label)}${e.detail ? ` <span class="muted">— ${esc(e.detail)}</span>` : ""}</td>
        <td>${e.ll ? `${e.ll[0].toFixed(4)}, ${e.ll[1].toFixed(4)}` : ""}</td></tr>`).join("")}
    </table>` : `<p class="muted">No dated events.</p>`;

  const css = `body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#1a1d24;max-width:880px;margin:24px auto;padding:0 16px}
    h1{font-size:22px;margin:0 0 2px} h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
    .muted{color:#6b7280} .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#374151;word-break:break-all}
    table.kv{border-collapse:collapse;width:100%} table.kv td,table.kv th{border:1px solid #e5e7eb;padding:4px 7px;text-align:left;vertical-align:top;font-size:13px}
    table.kv th{background:#f3f4f6} pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:8px;border-radius:4px}
    .grid{display:flex;flex-wrap:wrap;gap:10px} .ev{display:flex;gap:8px;border:1px solid #e5e7eb;border-radius:5px;padding:6px;width:260px}
    .ev img{width:80px;height:80px;object-fit:cover;border-radius:3px} .ev .noimg{width:80px;height:80px;display:flex;align-items:center;justify-content:center;font-size:28px;background:#f3f4f6;border-radius:3px}
    .ev-meta{font-size:12px;overflow:hidden} footer{margin-top:28px;color:#6b7280;font-size:12px;border-top:1px solid #ddd;padding-top:8px}`;

  return `<!doctype html><html><head><meta charset="utf-8">
    <title>GeOSINT dossier — ${esc(now.toISOString().slice(0, 16).replace("T", " "))}</title>
    <style>${css}</style></head><body>
    <h1>GeOSINT case dossier</h1>
    <div class="muted">Generated ${esc(now.toISOString().replace("T", " ").slice(0, 19))} (UTC) · GeOSINT Workbench (local)</div>
    <h2>Active point</h2>${ptBlock}
    <h2>Case notes</h2>${notesBlock}
    <h2>Annotations (${annos.length})</h2>${annoBlock}
    <h2>Evidence log (${arts.length})</h2>
    <p class="muted">SHA-256 of original bytes + embedded thumbnail. Originals retained on the analyst's machine.</p>${artBlock}
    <h2>Timeline (${ev.length})</h2>${tlBlock}
    <footer>EXIF, geocoder and OSM data are leads, not proof — cross-check with sun, weather and visual features.
      Map data © OpenStreetMap contributors (ODbL). Generated entirely on-machine; nothing was uploaded.</footer>
    </body></html>`;
}

function exportDossier() {
  const html = buildDossier();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = `dossier-${stamp}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status("dossier exported to your Downloads folder");
}

/* Fire-and-forget capture that's still safe to SAVE against: the promise is
   tracked in _artPending and awaited by saveCase, so a case saved right after a
   drop never loses the just-dropped image. */
function captureImage(file, ex) {
  const p = logImageArtifact(file, ex).catch(() => null).finally(() => _artPending.delete(p));
  _artPending.add(p);
}

/* Record a dropped image as an evidence artifact (sha-256 of original bytes +
   thumbnail + the parsed EXIF facts we already have). Deduped by hash so the
   same file dropped twice doesn't double-log. `ex` is the exifr result (or null). */
async function logImageArtifact(file, ex) {
  let hash = null;
  try { hash = await sha256(file); } catch { /* crypto unavailable — log without */ }
  if (hash && state.artifacts.some((a) => a.kind === "image" && a.sha256 === hash)) return null;
  const thumb = await makeThumbnail(file);
  return addArtifact({
    kind: "image",
    t: ex && ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal).toISOString() : new Date().toISOString(),
    source: file.name,
    sha256: hash,
    ll: (ex && ex.latitude != null && ex.longitude != null) ? [ex.latitude, ex.longitude] : undefined,
    thumb: thumb || undefined,
    meta: {
      added: new Date().toISOString(),
      size: file.size,
      camera: ex ? [ex.Make, ex.Model].filter(Boolean).join(" ") || undefined : undefined,
      taken: ex && ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal).toISOString() : undefined,
    },
  });
}

/* ═══════════════════════════ CASE FILE ═════════════════════════ */
/* Save/restore the whole workspace to a local .geosint.json — point, map view,
   measure shapes, active data/GBIF layers, every module's inputs, notes, and
   the v2 artifacts evidence log.
   Pure client-side: the file never leaves the machine. */
const CASE_VERSION = 2;
const val = (sel) => { const el = $(sel); return el ? el.value : undefined; };
const setVal = (sel, v) => { const el = $(sel); if (el && v != null) el.value = v; };

function serializeCase() {
  const c = state.map.getCenter();
  return {
    app: "geosint-workbench", version: CASE_VERSION,
    saved: new Date().toISOString(),
    point: state.point ? { lat: state.point.lat, lng: state.point.lng } : null,
    view: { lat: c.lat, lng: c.lng, zoom: state.map.getZoom() },
    module: state.module || null,
    measure: state.measure.pts.map((p) => [p.lat, p.lng]),
    annos: (state.annos || []).map((a) => ({ type: a.type, ll: a.ll, ll2: a.ll2, text: a.text })),
    gbif: Object.entries(state.gbifLayers).map(([key, tl]) => ({ key: +key, name: tl._caseName || "" })),
    data: state.lastData ? { label: state.lastData.label } : null,
    notes: val("#case-notes") || "",
    artifacts: state.artifacts,

    inputs: {
      sunDt: val("#sun-dt"), sunOffset: val("#sun-offset"),
      solverAz: val("#solver-az"), solverRatio: val("#solver-ratio"), solverTol: val("#solver-tol"),
      solverAz2: val("#solver-az2"), solverRatio2: val("#solver-ratio2"), solverDt2: val("#solver-dt2"),
      wxDate: val("#wx-date"), imgUrl: val("#img-url"),
      dataPreset: val("#data-preset"), dataCustom: val("#data-custom"), gbifName: val("#gbif-name"),
    },
  };
}

async function saveCase() {
  // Let any in-flight image captures (hash + thumbnail) finish so a case saved
  // right after a drop includes the just-dropped evidence.
  if (_artPending.size) {
    status("finalizing evidence log…", false, 1500);
    await Promise.all([..._artPending]);
  }
  const data = JSON.stringify(serializeCase(), null, 1);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = `case-${stamp}.geosint.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status("case saved to your Downloads folder");
}

function applyCase(c) {
  if (!c || c.app !== "geosint-workbench") return status("not a GeOSINT case file", true);
  // notes + every field first (so module renders pick them up)
  setVal("#case-notes", c.notes || "");
  // evidence log (v2). Rehydrate _artId past the loaded max so new artifacts
  // don't collide with restored ids.
  state.artifacts = Array.isArray(c.artifacts) ? c.artifacts : [];
  _artId = state.artifacts.reduce((m, a) => Math.max(m, a.id || 0), 0);
  renderEvidenceLog();
  const f = c.inputs || {};
  setVal("#sun-dt", f.sunDt); setVal("#sun-offset", f.sunOffset);
  setVal("#solver-az", f.solverAz); setVal("#solver-ratio", f.solverRatio); setVal("#solver-tol", f.solverTol);
  setVal("#solver-az2", f.solverAz2); setVal("#solver-ratio2", f.solverRatio2); setVal("#solver-dt2", f.solverDt2);
  setVal("#wx-date", f.wxDate); setVal("#img-url", f.imgUrl);
  setVal("#data-preset", f.dataPreset); setVal("#data-custom", f.dataCustom); setVal("#gbif-name", f.gbifName);
  renderUrlButtons();

  // map view + active point
  if (c.view) state.map.setView([c.view.lat, c.view.lng], c.view.zoom);
  if (c.point) setPoint(L.latLng(c.point.lat, c.point.lng));

  // measure shapes
  clearMeasure();
  if (Array.isArray(c.measure) && c.measure.length) {
    toggleMeasure(true);
    state.measure.pts = c.measure.map(([lat, lng]) => L.latLng(lat, lng));
    renderMeasure();
  }

  // annotations (rebuild from stored geometry + text)
  clearAnnos();
  (c.annos || []).forEach((a) => addAnno({ type: a.type, ll: a.ll, ll2: a.ll2, text: a.text }));

  // GBIF overlays (re-add by stored taxon key + name)
  Object.values(state.gbifLayers).forEach((tl) => state.map.removeLayer(tl));
  state.gbifLayers = {};
  $("#gbif-active").innerHTML = "";
  (c.gbif || []).forEach((g) => gbifOverlay(g.name, g.key));

  if (c.module) openModule(c.module);
  status(`case loaded${c.saved ? " (saved " + c.saved.slice(0, 16).replace("T", " ") + ")" : ""}`);
}

function loadCase(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { applyCase(JSON.parse(reader.result)); }
    catch { status("could not parse case file", true); }
  };
  reader.readAsText(file);
}

function toggleNotes(force) {
  const d = $("#notes-drawer");
  d.hidden = force !== undefined ? !force : !d.hidden;
  if (!d.hidden) $("#case-notes").focus();
}

function initCase() {
  $("#btn-case-save").addEventListener("click", saveCase);
  $("#btn-case-load").addEventListener("click", () => $("#case-file").click());
  $("#case-file").addEventListener("change", (e) => {
    if (e.target.files[0]) loadCase(e.target.files[0]);
    e.target.value = "";                       // allow re-loading the same file
  });
  $("#btn-notes").addEventListener("click", () => toggleNotes());
  $("#notes-close").addEventListener("click", () => toggleNotes(false));
  const cc = $("#custody-csv"), cj = $("#custody-json");
  if (cc) cc.addEventListener("click", () => exportCustody("csv"));
  if (cj) cj.addEventListener("click", () => exportCustody("json"));
  const tlo = $("#timeline-open"), tlc = $("#timeline-close");
  if (tlo) tlo.addEventListener("click", openTimeline);
  if (tlc) tlc.addEventListener("click", () => { $("#timeline-panel").hidden = true; });
  const dz = $("#btn-dossier");
  if (dz) dz.addEventListener("click", async () => {
    if (_artPending.size) { status("finalizing evidence log…", false, 1500); await Promise.all([..._artPending]); }
    exportDossier();
  });
}

/* ═══════════════════════ wiring / keyboard ═════════════════════ */
function initKeys() {
  document.addEventListener("keydown", (e) => {
    const inField = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    // Ctrl/Cmd+S saves the case from anywhere (including while typing notes)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); return saveCase();
    }
    if (e.key === "Escape") {
      if (cancelArrow()) return;
      if (state.measure.on) return toggleMeasure(false);
      if (!$("#timeline-panel").hidden) { $("#timeline-panel").hidden = true; return; }
      if (!$("#notes-drawer").hidden) return toggleNotes(false);
      if (!$("#elev-panel").hidden) { $("#elev-panel").hidden = true; return; }
      $("#help-overlay").hidden = true;
      if (!inField) closePanel();
      return;
    }
    if (inField) return;
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    if (e.key.toLowerCase() === "n") return toggleNotes();
    const mods = { 1: "sun", 2: "weather", 3: "image", 4: "tools", 6: "data", 7: "anno",
      s: "sun", w: "weather", i: "image", t: "tools", d: "data", a: "anno" };
    if (mods[e.key.toLowerCase()]) openModule(mods[e.key.toLowerCase()]);
    if (e.key.toLowerCase() === "m") toggleMeasure();
    if (e.key === "5" || e.key.toLowerCase() === "f") window.open("search.html", "_blank");
  });
  // Shift toggles the measure range ring live while a vertex is being right-dragged
  document.addEventListener("keydown", (e) => {
    if (e.key === "Shift") { state.measure.shift = true; if (state.measure.dragIdx != null) updateRadius(); }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift") { state.measure.shift = false; clearRadius(); }
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
    syncQgisButton();
  } catch { $("#ge-status").textContent = "local API offline"; }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap(); initSearch(); initSun(); initWeather(); initImage(); initData(); annoInit(); initCase(); initElevPanel(); initKeys(); initStatus();
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
