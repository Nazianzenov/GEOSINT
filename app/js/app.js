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
  overpass: null,         // in-flight Overpass query { ctrl, tick } — see modules/data.js
};

/* Shared helpers — $, $$, esc, dataThumb, fetchT/cachedFetch/cacheNote,
   fmtDD, toDMS, fmtDMS, compassAz, cardinal, parseCoords, project, drawSunChart
   — now live in app/js/common.js (loaded before this script). */

/* alternative grid formats (offline, via vendor/geocoords.js) — workbench-only */
const fmtUTM   = (ll) => GeoCoords.toUTM(ll.lat, ll.lng).str;
const fmtMGRS  = (ll) => GeoCoords.toMGRS(ll.lat, ll.lng, 5);
const fmtPlus  = (ll) => GeoCoords.toPlusCode(ll.lat, ll.lng, 11);

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

// Shared feedback for actions that need an active point (so they explain
// themselves instead of silently no-op'ing).
const NO_POINT_MSG = "Set an active point first — click the map.";

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
  state.cableLayer = L.layerGroup().addTo(state.map);   // submarine cables (toggled)
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
  markDirty();
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
  // While the ruler is armed, annotation actions are unavailable (they'd collide
  // with measure's clicks). Say so explicitly instead of silently omitting them.
  const note = state.measure.on
    ? `<div class="ctx-note">✎ Annotations paused — ruler is armed (press M to exit)</div>`
    : "";
  menu.innerHTML = `<div class="ctx-coords">${fmtDD(ll)}</div>` +
    items.map((it, i) => `<div class="ctx-item" data-i="${i}">${it[0]}</div>`).join("") +
    note;
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
  syncAnnoRulerWarn();                  // surface the ruler↔annotation conflict in the anno panel
}

// Show/hide the "ruler armed — annotations paused" banner in the annotations panel.
function syncAnnoRulerWarn() {
  const w = $("#anno-ruler-warn");
  if (w) w.hidden = !state.measure.on;
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
  markDirty();
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
  } catch {
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
  tools: "Tool Launcher", data: "Data Layers", anno: "Annotations", wiki: "Wiki Search" };

function openModule(name) {
  if (state.module === name) return closePanel();
  state.module = name;
  $("#panel").hidden = false;
  $("#panel").classList.toggle("wide", name === "wiki");   // wiki needs room for the photo grid
  $("#panel-title").textContent = MODULE_TITLES[name];
  $$("#panel-body > section").forEach((s) => s.hidden = s.id !== `module-${name}`);
  $$(".rail-btn[data-module]").forEach((b) => b.classList.toggle("active", b.dataset.module === name));
  state.map.invalidateSize();
  if (name === "sun") {
    renderSun();
    // carry the active point into the Studio so it opens already positioned
    const sl = $("#sun-studio-link");
    if (sl) sl.href = state.point ? `sun.html#ll=${state.point.lat.toFixed(5)},${state.point.lng.toFixed(5)}` : "sun.html";
  }
  else state.sunLayer.clearLayers();              // sun/shadow overlay only shows in its own module
  if (name === "tools") renderTools();
  if (name === "anno") { renderAnnoList(); syncAnnoRulerWarn(); }
  if (name === "wiki") openWiki();
  markDirty();
}

// Lazy-mount the docked Wiki Search the first time it's opened; re-focus thereafter.
// onPick jumps the active point in place — no new tab, no #ll= round-trip.
let _wikiMounted = false;
function openWiki() {
  if (window.GeoSearch) {
    if (!_wikiMounted) {
      _wikiMounted = true;
      GeoSearch.mount($("#module-wiki"), {
        onPick: ({ ll }) => setPoint(L.latLng(ll[0], ll[1]), { fly: true, zoom: 13 }),
        // 9A.2 — log a recognition card to the case as a sourced observation
        onLog: (card) => logObservation({
          text: card.t, source: card.page,
          ll: card.ll ? [card.ll[0], card.ll[1]] : undefined,
        }),
      }).then(() => GeoSearch.focus());
    } else {
      GeoSearch.focus();
    }
  } else {
    $("#module-wiki").innerHTML =
      `<p class="hint" style="padding:14px">Wiki Search failed to load. Open the standalone page: `
      + `<a href="search.html" target="_blank">search.html</a>.</p>`;
  }
}
function closePanel() {
  state.module = null;
  $("#panel").hidden = true;
  $("#panel").classList.remove("wide");
  $$(".rail-btn[data-module]").forEach((b) => b.classList.remove("active"));
  state.sunLayer.clearLayers();
  state.map.invalidateSize();
}

/* ── Panel modules (Sun, Weather, Image, Tools, Data, Annotations) are in
   app/js/modules/*.js — split out per #31. They share this file's global
   scope (classic <script>, ordered in index.html before this bootstrap). ── */

/* ── Case engine (artifacts / custody / dossier / case-file / autosave) is in
   app/js/case.js — split out per #31. Shares this file's global scope. ── */

/* ═══════════════════════ command palette ═════════════════════
   Ctrl/Cmd+K: fuzzy-jump to any module, tool, coordinate action or wiki search.
   Commands are rebuilt on each open so point-dependent ones reflect live state. */
const _palette = { open: false, items: [], sel: 0, prevFocus: null };

function buildCommands() {
  const cmds = [];
  // kw = extra keywords matched in addition to the label (so "weather" finds
  // "Meteorology", "find"/"search" find Wiki Search, etc.)
  const C = (grp, label, run, hint, kw) => cmds.push({ grp, label, run, hint, kw: kw || "" });

  // modules
  C("Module", "Sun & Shadow", () => openModule("sun"), "1", "shadow chronolocation solar");
  C("Module", "Meteorology", () => openModule("weather"), "2", "weather climate rain cloud temperature");
  C("Module", "Image Intelligence", () => openModule("image"), "3", "exif photo metadata reverse");
  C("Module", "Tool Launcher", () => openModule("tools"), "4", "external tools open");
  C("Module", "Wiki Search", () => openModule("wiki"), "5", "find search identify bollards");
  C("Module", "Data Layers", () => openModule("data"), "6", "osm overpass features gbif");
  C("Module", "Annotations", () => openModule("anno"), "7", "pins labels arrows notes markup");
  C("Module", "Toggle ruler / measure", () => toggleMeasure(), "M", "distance bearing measure ruler");
  C("Module", "Case notes", () => toggleNotes(true), "N", "notes");

  // case actions
  C("Case", "Save case file", () => saveCase(), "Ctrl+S");
  C("Case", "Load case file", () => $("#case-file").click());
  C("Case", "Recent cases", () => toggleRecentMenu());
  C("Case", "Load sample case", () => loadSampleCase(), "", "demo example tour onboarding");
  C("Case", "Export dossier (HTML)", () => $("#btn-dossier").click());

  // coordinate actions (only meaningful with an active point)
  if (state.point) {
    const p = state.point;
    C("Coords", "Copy DD", () => copyText(fmtDD(p)));
    C("Coords", "Copy DMS", () => copyText(fmtDMS(p)));
    C("Coords", "Copy MGRS", () => copyText(fmtMGRS(p)));
    C("Coords", "Copy UTM", () => copyText(fmtUTM(p)));
    C("Coords", "Copy Plus Code", () => copyText(fmtPlus(p)));
    C("Coords", "Open Street View here", () => window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`));
    C("Coords", "Open Google Maps here", () => window.open(`https://www.google.com/maps/@${p.lat},${p.lng},16z`));
    C("Coords", "Open Google Earth here", () => window.open(`https://earth.google.com/web/@${p.lat},${p.lng},0a,2000d,35y,0h,0t,0r`));
  }

  // every tool (launchTool self-explains with a status if no active point)
  (typeof TOOLS !== "undefined" ? TOOLS : []).forEach((t) =>
    C("Tool", `Open ${t.name}`, () => launchTool(t)));

  return cmds;
}

// subsequence fuzzy match; exact-substring ranks higher. Matches the label first,
// then any extra keywords (so "weather" finds "Meteorology") at a lower rank.
function subseq(text, Q) {
  const L = text.toLowerCase();
  const idx = L.indexOf(Q);
  if (idx >= 0) return 1000 - idx;                 // contiguous, earlier = better
  let li = 0, hits = 0;
  for (const ch of Q) {
    const f = L.indexOf(ch, li);
    if (f < 0) return -1;
    li = f + 1; hits++;
  }
  return hits;                                      // looser subsequence match
}
function fuzzyScore(cmd, q) {
  const Q = (q || "").toLowerCase();
  if (!Q) return 1;
  const onLabel = subseq(cmd.label, Q);
  if (onLabel >= 0) return onLabel + 2000;          // label hits outrank keyword hits
  if (cmd.kw) { const onKw = subseq(cmd.kw, Q); if (onKw >= 0) return onKw; }
  return -1;
}

function renderPalette() {
  const q = $("#cmd-input").value.trim();
  const all = _palette.all;
  let list;
  if (q) {
    list = all.map((c) => ({ c, s: fuzzyScore(c, q) }))
              .filter((x) => x.s >= 0)
              .sort((a, b) => b.s - a.s)
              .map((x) => x.c);
    // always offer a wiki search for the raw query, appended last so it never
    // outranks a real command match (selection stays on the top match).
    list = list.concat([{ grp: "Wiki", label: `Search wiki for “${q}”`,
      run: () => { openModule("wiki"); setTimeout(() => { const i = document.querySelector("#module-wiki .s-q"); if (i) { i.value = q; i.dispatchEvent(new Event("input", { bubbles: true })); } }, 60); } }]);
  } else {
    list = all;
  }
  _palette.items = list;
  if (_palette.sel >= list.length) _palette.sel = Math.max(0, list.length - 1);
  const ul = $("#cmd-list");
  if (!list.length) { ul.innerHTML = `<li class="cmd-empty">No matching command</li>`; return; }
  ul.innerHTML = list.map((c, i) =>
    `<li role="option" data-i="${i}" aria-selected="${i === _palette.sel}">
       <span class="cmd-grp">${esc(c.grp)}</span>
       <span class="cmd-label">${esc(c.label)}</span>
       ${c.hint ? `<span class="cmd-hint">${esc(c.hint)}</span>` : ""}
     </li>`).join("");
  ul.querySelectorAll("li[data-i]").forEach((li) => {
    li.addEventListener("mousemove", () => { _palette.sel = +li.dataset.i; markSel(); });
    li.addEventListener("click", () => runPalette(+li.dataset.i));
  });
  scrollSelIntoView();
}

function markSel() {
  $("#cmd-list").querySelectorAll("li[data-i]").forEach((li) =>
    li.setAttribute("aria-selected", +li.dataset.i === _palette.sel));
  scrollSelIntoView();
}
function scrollSelIntoView() {
  const el = $("#cmd-list").querySelector(`li[data-i="${_palette.sel}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if (_palette.open) return;
  _palette.open = true;
  _palette.prevFocus = document.activeElement;
  _palette.all = buildCommands();
  _palette.sel = 0;
  $("#cmd-input").value = "";
  $("#cmd-palette").hidden = false;
  renderPalette();
  $("#cmd-input").focus();
}
function closePalette() {
  if (!_palette.open) return;
  _palette.open = false;
  $("#cmd-palette").hidden = true;
  if (_palette.prevFocus && _palette.prevFocus.focus) _palette.prevFocus.focus();
}
function runPalette(i) {
  const cmd = _palette.items[i != null ? i : _palette.sel];
  closePalette();
  if (cmd) try { cmd.run(); } catch { status("command failed", true); }
}

function initPalette() {
  const inp = $("#cmd-input");
  inp.addEventListener("input", () => { _palette.sel = 0; renderPalette(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); _palette.sel = Math.min(_palette.sel + 1, _palette.items.length - 1); markSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _palette.sel = Math.max(_palette.sel - 1, 0); markSel(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  // click outside the box closes
  $("#cmd-palette").addEventListener("mousedown", (e) => { if (e.target.id === "cmd-palette") closePalette(); });
}

/* ═══════════════════════ wiring / keyboard ═════════════════════ */
function initKeys() {
  document.addEventListener("keydown", (e) => {
    const inField = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    // Ctrl/Cmd+K opens the command palette from anywhere (even while typing)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault(); return openPalette();
    }
    // Ctrl/Cmd+S saves the case from anywhere (including while typing notes)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); return saveCase();
    }
    if (e.key === "Escape") {
      if (_palette.open) return closePalette();
      if (!$("#welcome-overlay").hidden) { dismissWelcome(); return; }
      if (!$("#recent-menu").hidden) { closeRecentMenu(); return; }
      if (cancelArrow()) return;
      if (state.measure.on) return toggleMeasure(false);
      if (!$("#timeline-panel").hidden) { $("#timeline-panel").hidden = true; return; }
      if (!$("#notes-drawer").hidden) return toggleNotes(false);
      if (!$("#elev-panel").hidden) { $("#elev-panel").hidden = true; return; }
      if (!$("#help-overlay").hidden) { closeModalOverlay("#help-overlay"); return; }
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
    if (e.key === "5" || e.key.toLowerCase() === "f") openModule("wiki");
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
    const r = await fetchT("/api/status");
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
  initMap(); initSearch(); initSun(); initWeather(); initImage(); initData(); annoInit(); initCase(); initElevPanel(); initKeys(); initPalette(); initStatus();
  // deep links: #ll=lat,lng (from search) and #species=gbifKey&name=... (from flora wiki)
  const ll = location.hash.match(/^#ll=(-?[\d.]+),(-?[\d.]+)/);
  if (ll) setPoint(L.latLng(+ll[1], +ll[2]), { fly: true, zoom: 13 });
  const sp = location.hash.match(/^#species=(\d+)(?:&name=([^&]+))?/);
  if (sp) { openModule("data"); gbifOverlay(decodeURIComponent(sp[2] || "species"), +sp[1]); }
  $$(".rail-btn[data-module]").forEach((b) => b.addEventListener("click", () => openModule(b.dataset.module)));
  $("#panel-close").addEventListener("click", closePanel);
  // 9A.1 — log a finding pasted from an external tool as an evidence observation
  const logFinding = () => {
    const v = $("#finding-input").value.trim();
    if (!v) return status("Paste a link or coordinates to log.", true);
    logObservation({ text: v, source: v });
    $("#finding-input").value = "";
  };
  $("#finding-log").addEventListener("click", logFinding);
  $("#finding-input").addEventListener("keydown", (e) => { if (e.key === "Enter") logFinding(); });
  $("#btn-measure").addEventListener("click", () => toggleMeasure());
  $("#btn-help").addEventListener("click", () => openModalOverlay("#help-overlay"));
  $("#help-close").addEventListener("click", () => closeModalOverlay("#help-overlay"));
  $("#btn-copy-dd").addEventListener("click", () =>
    state.point ? copyText(fmtDD(state.point)) : status(NO_POINT_MSG, true));
  $("#btn-copy-dms").addEventListener("click", () =>
    state.point ? copyText(fmtDMS(state.point)) : status(NO_POINT_MSG, true));
  // WIKI button: plain click docks the search in-workbench; modified clicks
  // (Ctrl/Cmd/middle) keep the native href so the standalone page still opens.
  $("#btn-wiki").addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault(); openModule("wiki");
  });
  // keep the Leaflet map sized correctly when the viewport changes (responsive)
  let _resizeT;
  window.addEventListener("resize", () => {
    clearTimeout(_resizeT);
    _resizeT = setTimeout(() => state.map && state.map.invalidateSize(), 150);
  });
});
