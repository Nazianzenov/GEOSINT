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

/* ═══════════════════════════ ARTIFACTS (case v2) ═══════════════════════════
   Append-only evidence log. Every item the analyst pulls in (an image, a logged
   observation) becomes an artifact with a timestamp and provenance, so the case
   can drive a timeline, a sourced dossier and a chain-of-custody
   view. Images store a SHA-256 of the ORIGINAL bytes + a small thumbnail
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
  markDirty();
  return art;
}

/* Pull the first "lat, lng" pair out of arbitrary text/URL (so a pasted
   permalink like ".../@48.8584,2.2945,17z" or "view 48.8584, 2.2945" yields
   coords). Returns [lat,lng] or null. */
function coordsFromText(s) {
  if (!s) return null;
  // Require a decimal point in BOTH numbers — real GPS pairs have them, which
  // avoids false matches on incidental integer pairs (zoom levels, versions,
  // "1, 2"). Lat/lng must also be in range.
  const m = String(s).match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) ? [lat, lng] : null;
}

/* Log an external/identified finding as an observation artifact (9A.1/9A.2/9A.4).
   `source` may be a URL or free text; coords are parsed from it when not given. */
function logObservation({ text, source, ll, t }) {
  if (!ll && source) ll = coordsFromText(source);   // lift coords out of the pasted text/URL
  if (!ll && text) ll = coordsFromText(text);
  // If the only "text" is a bare URL, keep the URL in `source` (which redaction
  // strips) and use a generic label as the text, so a redacted dossier doesn't
  // leak the URL through the finding's text.
  const isUrl = (v) => /^https?:\/\//i.test(String(v || ""));
  let label = text;
  if (!label || isUrl(label)) label = isUrl(source) || isUrl(text) ? "external finding" : (text || "observation");
  const realSource = source || (isUrl(text) ? text : undefined);
  const art = addArtifact({
    kind: "obs",
    t: t || new Date().toISOString(),
    text: label,
    source: realSource || undefined,
    ll: ll || undefined,
  });
  status(`logged to case: ${esc(art.text).slice(0, 40)}`, false, 3000);
  if (ll) state.imgLayer.addLayer(L.circleMarker(L.latLng(ll[0], ll[1]),
    { radius: 6, color: "#d2a8ff", fillColor: "#d2a8ff", fillOpacity: .6 }).bindTooltip(esc(art.text)));
  return art;
}

/* 9A.4 — pin a plotted overlay feature into the case as an observation. Called
   from the feature popup by registry index (no attacker-controlled string in an
   inline handler). */
function pinFeature(idx) {
  const f = (state._plotted || [])[idx];
  if (!f) return;
  const tagStr = Object.entries(f.tags || {}).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(", ");
  logObservation({
    text: `${f.name}${tagStr ? ` (${tagStr})` : ""}`,
    source: `OSM ${f.type}/${f.id}`,
    ll: [f.lat, f.lon],
  });
}
window.pinFeature = pinFeature;

/* Build a plotted-feature popup as a DOM element with wired listeners — no inline
   onclick (which needed window.setPoint, that was never exported, so the "set
   active point" link silently did nothing) and no string-injection surface. */
function featurePopup({ lat, lon, name, type, id, idx }) {
  const el = document.createElement("div");
  el.innerHTML =
    `<b>${esc(name)}</b><br><span class="mono">${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br>` +
    `<a href="https://www.openstreetmap.org/${esc(type)}/${esc(id)}" target="_blank" rel="noopener">OSM object</a> · ` +
    `<a href="#" class="fp-set">set active point</a> · ` +
    `<a href="#" class="fp-pin">📌 pin to case</a>`;
  el.querySelector(".fp-set").addEventListener("click", (e) => {
    e.preventDefault(); setPoint(L.latLng(lat, lon), { fly: true });
  });
  el.querySelector(".fp-pin").addEventListener("click", (e) => {
    e.preventDefault(); pinFeature(idx);
  });
  return el;
}

/* Minimal popup: a title, a subtitle, coords, and a wired "set active point". */
function setPointPopup(title, subtitle, lat, lng) {
  const el = document.createElement("div");
  el.innerHTML = `<b>${esc(title)}</b><br>${esc(subtitle)}` +
    `<br><span class="mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>` +
    `<br><a href="#" class="fp-set">set active point</a>`;
  el.querySelector(".fp-set").addEventListener("click", (e) => {
    e.preventDefault(); setPoint(L.latLng(lat, lng), { fly: true });
  });
  return el;
}

/* Pick up a chronolocation finding sent from the Sun & Shadow Studio (separate
   tab) via a shared localStorage key. Called on load + when the workbench regains
   focus. Logs it as a sourced observation, sets the active point, and adopts the
   solver result so the dossier's "Chronolocation finding" reflects the Studio. */
const STUDIO_HANDOFF_KEY = "geosint:studio-finding";
function ingestStudioFinding() {
  let r;
  try {
    const raw = localStorage.getItem(STUDIO_HANDOFF_KEY);
    if (!raw) return;
    localStorage.removeItem(STUDIO_HANDOFF_KEY);   // consume once
    r = JSON.parse(raw);
  } catch { return; }
  if (!r || !r.loc) return;
  // Validate the (possibly tampered/malformed) handoff before it reaches setPoint/
  // .toFixed()/.join() downstream — a NaN coord or non-array windows would throw
  // and break the custody/timeline/dossier renders.
  const lat = +r.loc.lat, lng = +r.loc.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const windows = Array.isArray(r.windows) ? r.windows.map(String) : [];
  state.solverResult = {              // shape the dossier/buildDossier already reads
    status: r.status, confidence: r.confidence, why: r.why, tol: r.tol,
    windows, twoShadow: false,
  };
  const summary = r.status === "inconsistent"
    ? `Chronolocation: claim inconsistent (${r.confidence} confidence)`
    : `Chronolocation: ${windows.join(", ")} local (${r.confidence} confidence)`;
  logObservation({ text: summary, ll: [lat, lng], source: "Sun & Shadow Studio" });
  setPoint(L.latLng(lat, lng), { fly: true, zoom: 14 });
  status("chronolocation finding received from the Studio — logged to the case", false, 6000);
}

/* Evidence-log readout + chain-of-custody table in the notes drawer.
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
  const nLinks = (a) => (a.links && a.links.length) ? ` <span class="muted">🔗${a.links.length}</span>` : "";
  t.innerHTML = `<tr><th>observed</th><th>kind</th><th>source</th><th>sha-256</th><th>GPS</th><th></th></tr>` +
    arts.map((a) => `<tr>
      <td>${esc(String(a.t).replace("T", " ").slice(0, 19))}</td>
      <td>${ART_SYM[a.kind] || "•"} ${esc(a.kind)}${nLinks(a)}</td>
      <td title="${esc(a.source || "")}">${esc((a.source || "—").slice(0, 28))}</td>
      <td>${short(a.sha256)}</td>
      <td>${a.ll ? `${a.ll[0].toFixed(4)}, ${a.ll[1].toFixed(4)}` : "—"}</td>
      <td><a href="#" class="art-link" data-id="${a.id}" title="Link this artifact to another (builds the case relationship graph)">🔗</a></td>
    </tr>`).join("");
  t.querySelectorAll(".art-link").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); linkArtifact(+el.dataset.id); }));
}

/* 9A.3 — link one artifact to another so the case becomes a graph (rendered as a
   Relationships section in the dossier). Lightweight prompt-based picker. */
function linkArtifact(fromId) {
  const arts = state.artifacts;
  const from = arts.find((a) => a.id === fromId);
  if (!from) return;
  const others = arts.filter((a) => a.id !== fromId);
  if (!others.length) return status("Need a second artifact to link to.", true);
  const menu = others.map((a) => `${a.id}: ${(a.text || a.source || a.kind).slice(0, 40)}`).join("\n");
  const pick = prompt(`Link "${(from.text || from.source || from.kind).slice(0, 40)}" to which artifact?\n\n${menu}\n\nEnter the id:`);
  if (pick == null) return;
  const toId = parseInt(pick, 10);
  if (!others.some((a) => a.id === toId)) return status("No artifact with that id.", true);
  from.links = from.links || [];
  if (!from.links.includes(toId)) from.links.push(toId);
  renderCustodyTable();
  markDirty();
  status("artifacts linked");
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

/* ── timeline ──
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
          ${dataThumb(e.thumb) ? `<img src="${esc(dataThumb(e.thumb))}" style="max-width:120px;border-radius:3px;margin:4px 0">` : ""}
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

/* ── dossier export ──
   A self-contained HTML report of the case: active point (all coord formats),
   notes, annotations, the evidence log with inline thumbnails, the timeline,
   and a sources/provenance section. Renders from case state + v2 artifacts;
   thumbnails are already base64 so no originals are needed. 100% local. */

/* Dossier stylesheet — a module-level constant, not an inline string buried in
   buildDossier (where a typo failed silently). */
const DOSSIER_CSS = `body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#1a1d24;max-width:880px;margin:24px auto;padding:0 16px}
  h1{font-size:22px;margin:0 0 2px} h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
  .muted{color:#6b7280} .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#374151;word-break:break-all}
  table.kv{border-collapse:collapse;width:100%} table.kv td,table.kv th{border:1px solid #e5e7eb;padding:4px 7px;text-align:left;vertical-align:top;font-size:13px}
  table.kv th{background:#f3f4f6} pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:8px;border-radius:4px}
  .grid{display:flex;flex-wrap:wrap;gap:10px} .ev{display:flex;gap:8px;border:1px solid #e5e7eb;border-radius:5px;padding:6px;width:260px}
  .ev img{width:80px;height:80px;object-fit:cover;border-radius:3px} .ev .noimg{width:80px;height:80px;display:flex;align-items:center;justify-content:center;font-size:28px;background:#f3f4f6;border-radius:3px}
  .ev-meta{font-size:12px;overflow:hidden} footer{margin-top:28px;color:#6b7280;font-size:12px;border-top:1px solid #ddd;padding-top:8px}`;

function buildDossier(redact = false) {
  const now = new Date();
  // 9C.3 — redaction helpers: coarsen coords, hide source URLs/filenames, keep
  // the analytical findings + provenance hashes.
  const coord = (lat, lng) => redact ? `${lat.toFixed(1)}, ${lng.toFixed(1)} (coarsened)` : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const src = (s) => !s ? "" : (redact ? "[redacted]" : esc(s));
  // Single redaction-label rule, shared by the artifact, relationship and
  // timeline blocks so they can't drift (they did: only the timeline used to
  // genericize image filenames). An image artifact's label is its original
  // filename + camera detail (sourcing), and any label that's a URL is a source
  // — both must be hidden from a publication-safe export.
  const redLabel = (kind, label) => {
    if (!redact) return label;
    if (kind === "image") return "image evidence";
    if (/^https?:\/\//i.test(String(label || ""))) return "external finding";
    return label;
  };

  const p = state.point;
  const ptBlock = p ? (redact
    ? `<table class="kv"><tr><td>Approx. location</td><td>${esc(coord(p.lat, p.lng))}</td></tr></table>`
    : `<table class="kv">
      <tr><td>Decimal</td><td>${esc(fmtDD(p))}</td></tr>
      <tr><td>DMS</td><td>${esc(fmtDMS(p))}</td></tr>
      <tr><td>MGRS</td><td>${esc(fmtMGRS(p))}</td></tr>
      <tr><td>UTM</td><td>${esc(fmtUTM(p))}</td></tr>
      <tr><td>Plus Code</td><td>${esc(fmtPlus(p))}</td></tr>
    </table>`) : `<p class="muted">No active point set.</p>`;

  const notes = (val("#case-notes") || "").trim();
  const notesBlock = redact ? `<p class="muted">Notes omitted from redacted export.</p>`
    : (notes ? `<pre>${esc(notes)}</pre>` : `<p class="muted">No notes.</p>`);

  const annos = state.annos || [];
  const annoBlock = annos.length ? `<table class="kv">
      <tr><th>type</th><th>text</th><th>location</th></tr>
      ${annos.map((a) => `<tr><td>${esc(a.type)}</td><td>${esc(a.text)}</td>
        <td>${esc(coord(a.ll[0], a.ll[1]))}</td></tr>`).join("")}
    </table>` : `<p class="muted">No annotations.</p>`;

  const arts = state.artifacts || [];
  const artBlock = arts.length ? `<div class="grid">
      ${[...arts].sort((a, b) => String(a.t).localeCompare(String(b.t))).map((a) => `
        <div class="ev">
          ${(!redact && dataThumb(a.thumb)) ? `<img src="${esc(dataThumb(a.thumb))}" alt="">` : `<div class="noimg">${ART_SYM[a.kind] || "•"}</div>`}
          <div class="ev-meta">
            <b>${redact ? esc(redLabel(a.kind, a.text || a.kind)) : esc(a.source || a.text || a.kind)}</b>
            <div class="muted">${esc(String(a.t).replace("T", " ").slice(0, 19))} · ${esc(a.kind)}</div>
            ${(redact && a.source) ? `<div class="muted">source: ${src(a.source)}</div>` : ""}
            ${a.ll ? `<div class="muted">${esc(coord(a.ll[0], a.ll[1]))}</div>` : ""}
            ${a.sha256 ? `<div class="mono">sha256 ${esc(redact ? a.sha256.slice(0, 16) + "…" : a.sha256)}</div>` : ""}
          </div>
        </div>`).join("")}
    </div>` : `<p class="muted">No evidence artifacts.</p>`;

  // 9A.3 — relationships: artifact links rendered as a graph-ish edge list.
  const byId = Object.fromEntries(arts.map((a) => [a.id, a]));
  const label = (a) => redLabel(a.kind, a.text || a.source || a.kind || `#${a.id}`);
  const edges = arts.flatMap((a) => (a.links || [])
    .filter((id) => byId[id])
    .map((id) => `<li>${esc(label(a))} <span class="muted">↔</span> ${esc(label(byId[id]))}</li>`));
  const relBlock = edges.length
    ? `<ul>${edges.join("")}</ul>` : `<p class="muted">No linked artifacts.</p>`;

  // 9B.3 — bibliography: de-duped numbered list of every source/page URL the case
  // references (artifact sources + the active point's notes are excluded; sources
  // only). Omitted from redacted exports.
  const cites = [...new Set(arts.map((a) => a.source).filter((s) => s && /^https?:\/\//i.test(s)))];
  const biblioBlock = redact
    ? `<p class="muted">Bibliography omitted from redacted export.</p>`
    : (cites.length
      ? `<ol>${cites.map((u) => `<li><a href="${esc(u)}">${esc(u)}</a></li>`).join("")}</ol>`
      : `<p class="muted">No web sources cited.</p>`);

  const ev = timelineEvents();
  // Timeline labels go through the same shared redaction rule as the artifact /
  // relationship blocks (redLabel): image events -> "image evidence", URL labels
  // -> "external finding". (timelineEvents sets label = source||text||kind.)
  const evLabel = (e) => redLabel(e.kind, e.label);
  const evDetail = (e) => (redact && e.kind === "image") ? "" : e.detail;   // camera make/model is sourcing
  const tlBlock = ev.length ? `<table class="kv">
      <tr><th>time</th><th>event</th><th>location</th></tr>
      ${ev.map((e) => `<tr><td class="mono">${esc(String(e.t).replace("T", " ").slice(0, 16))}</td>
        <td>${esc(evLabel(e))}${evDetail(e) ? ` <span class="muted">— ${esc(evDetail(e))}</span>` : ""}</td>
        <td>${e.ll ? esc(coord(e.ll[0], e.ll[1])) : ""}</td></tr>`).join("")}
    </table>` : `<p class="muted">No dated events.</p>`;

  // chronolocation finding with its stated uncertainty (if the solver ran).
  const sr = state.solverResult;
  const chronoBlock = !sr ? "" : (sr.status === "inconsistent"
    ? `<h2>Chronolocation finding</h2><p><b>Claim inconsistent</b> (${esc(sr.confidence)} confidence) —
       no time on the analysed date matches the shadow at the active point, within ±${esc(String(sr.tol))}° tolerance.</p>`
    : `<h2>Chronolocation finding</h2>
       <p>Shadow solver matched <b>${esc(sr.windows.join(", "))}</b> local time.
       Confidence <b>${esc(sr.confidence)}</b> — ${esc(sr.why)}; tolerance ±${esc(String(sr.tol))}°${sr.twoShadow ? ", two-shadow constraint" : ""}.</p>
       <p class="muted">Uncertainty is driven by the measurement tolerance; a narrower window at a tighter tolerance is a stronger finding.</p>`);

  return `<!doctype html><html><head><meta charset="utf-8">
    <title>GeOSINT ${redact ? "redacted " : ""}dossier — ${esc(now.toISOString().slice(0, 16).replace("T", " "))}</title>
    <style>${DOSSIER_CSS}</style></head><body>
    <h1>GeOSINT case dossier${redact ? " <span style=\"font-size:13px;color:#b91c1c\">(REDACTED)</span>" : ""}</h1>
    <div class="muted">Generated ${esc(now.toISOString().replace("T", " ").slice(0, 19))} (UTC) · GeOSINT Workbench (local)${redact ? " · sensitive sourcing removed for publication" : ""}</div>
    <h2>Active point</h2>${ptBlock}
    ${chronoBlock}
    <h2>Case notes</h2>${notesBlock}
    <h2>Annotations (${annos.length})</h2>${annoBlock}
    <h2>Evidence log (${arts.length})</h2>
    <p class="muted">SHA-256 of original bytes + embedded thumbnail. Originals retained on the analyst's machine.</p>${artBlock}
    <h2>Relationships</h2>${relBlock}
    <h2>Timeline (${ev.length})</h2>${tlBlock}
    <h2>Bibliography</h2>${biblioBlock}
    <footer>EXIF, geocoder and OSM data are leads, not proof — cross-check with sun, weather and visual features.
      Map data © OpenStreetMap contributors (ODbL). Generated entirely on-machine; nothing was uploaded.</footer>
    </body></html>`;
}

function exportDossier(redact = false) {
  const html = buildDossier(redact);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = `dossier-${redact ? "redacted-" : ""}${stamp}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`${redact ? "redacted " : ""}dossier exported to your Downloads folder`);
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
  const caseObj = serializeCase();
  const data = JSON.stringify(caseObj, null, 1);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");  // second precision: distinct saves get distinct names
  const fname = `case-${stamp}.geosint.json`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  clearAutosave();                                // durable copy exists; drop the snapshot
  recordRecent(caseObj, fname);                   // add to the in-app recent list
  status("case saved to your Downloads folder");
}

/* Validate + coerce an untrusted case object (hand-edited, truncated, or from a
   different version) into one applyCase can apply without producing NaN/half-
   applied state. A case file is the one place untrusted structured data enters
   the app, so every geometry field is range-checked here; malformed sections are
   dropped (not fatal — we load the valid parts) and counted so the user is told.
   Returns { case: cleaned, dropped: [reasons] }, or null if it isn't a case. */
function sanitizeCase(c) {
  if (!c || typeof c !== "object" || c.app !== "geosint-workbench") return null;
  const dropped = [];
  // Coerce only real numbers / non-empty numeric strings. Critically, reject
  // null/""/[]/booleans — unary + turns those into 0, which would sneak a bogus
  // 0,0 coordinate past the range checks below.
  const num = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") { const n = +v; return Number.isNaN(n) ? NaN : n; }
    return NaN;
  };
  const lat = (v) => { const n = num(v); return Number.isFinite(n) && Math.abs(n) <= 90 ? n : null; };
  const lng = (v) => { const n = num(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
  const ll  = (a) => Array.isArray(a) && lat(a[0]) !== null && lng(a[1]) !== null ? [lat(a[0]), lng(a[1])] : null;

  const out = {
    app: c.app, version: c.version,
    saved: typeof c.saved === "string" ? c.saved : null,
    notes: typeof c.notes === "string" ? c.notes : "",
    module: typeof c.module === "string" ? c.module : null,
    inputs: (c.inputs && typeof c.inputs === "object") ? c.inputs : {},
    artifacts: Array.isArray(c.artifacts) ? c.artifacts : [],
  };

  // active point
  if (c.point != null) {
    const la = lat(c.point.lat), lo = lng(c.point.lng);
    if (la !== null && lo !== null) out.point = { lat: la, lng: lo };
    else dropped.push("active point (out of range)");
  }
  // map view (zoom 0–24; default if absent/bad)
  if (c.view != null) {
    const la = lat(c.view.lat), lo = lng(c.view.lng), z = num(c.view.zoom);
    if (la !== null && lo !== null) out.view = { lat: la, lng: lo, zoom: Number.isFinite(z) ? Math.max(0, Math.min(24, z)) : 13 };
    else dropped.push("map view (out of range)");
  }
  // measure points — keep only valid [lat,lng] pairs
  if (Array.isArray(c.measure)) {
    out.measure = c.measure.map(ll).filter(Boolean);
    if (out.measure.length !== c.measure.length) dropped.push(`${c.measure.length - out.measure.length} measure point(s)`);
  } else out.measure = [];
  // annotations — need a valid ll, and arrows also a valid ll2
  if (Array.isArray(c.annos)) {
    const before = c.annos.length;
    out.annos = c.annos.filter((a) => a && ll(a.ll) && (a.type !== "arrow" || ll(a.ll2)))
      .map((a) => ({ type: a.type, ll: ll(a.ll), ll2: ll(a.ll2), text: typeof a.text === "string" ? a.text : "" }));
    if (out.annos.length !== before) dropped.push(`${before - out.annos.length} annotation(s)`);
  } else out.annos = [];
  // gbif overlays — keyed by a numeric taxon key (name is cosmetic, may be "")
  out.gbif = Array.isArray(c.gbif)
    ? c.gbif.filter((g) => g && Number.isFinite(num(g.key))).map((g) => ({ key: num(g.key), name: String(g.name || "") }))
    : [];

  return { case: out, dropped };
}

function applyCase(raw) {
  const v = sanitizeCase(raw);
  if (!v) return status("not a GeOSINT case file", true);
  const c = v.case;
  // notes + every field first (so module renders pick them up)
  setVal("#case-notes", c.notes || "");
  // evidence log (v2). Rehydrate _artId past the loaded max so new artifacts
  // don't collide with restored ids.
  state.artifacts = c.artifacts;
  _artId = state.artifacts.reduce((m, a) => Math.max(m, (a && a.id) || 0), 0);
  renderEvidenceLog();
  const f = c.inputs;
  setVal("#sun-dt", f.sunDt); setVal("#sun-offset", f.sunOffset);
  setVal("#solver-az", f.solverAz); setVal("#solver-ratio", f.solverRatio); setVal("#solver-tol", f.solverTol);
  setVal("#solver-az2", f.solverAz2); setVal("#solver-ratio2", f.solverRatio2); setVal("#solver-dt2", f.solverDt2);
  setVal("#wx-date", f.wxDate); setVal("#img-url", f.imgUrl);
  setVal("#data-preset", f.dataPreset); setVal("#data-custom", f.dataCustom); setVal("#gbif-name", f.gbifName);
  renderUrlButtons();

  // map view + active point (validated above — never NaN)
  if (c.view) state.map.setView([c.view.lat, c.view.lng], c.view.zoom);
  if (c.point) setPoint(L.latLng(c.point.lat, c.point.lng));

  // measure shapes
  clearMeasure();
  if (c.measure.length) {
    toggleMeasure(true);
    state.measure.pts = c.measure.map(([lat, lng]) => L.latLng(lat, lng));
    renderMeasure();
  }

  // annotations (rebuild from stored geometry + text)
  clearAnnos();
  c.annos.forEach((a) => addAnno({ type: a.type, ll: a.ll, ll2: a.ll2, text: a.text }));

  // GBIF overlays (re-add by stored taxon key + name)
  Object.values(state.gbifLayers).forEach((tl) => state.map.removeLayer(tl));
  state.gbifLayers = {};
  $("#gbif-active").innerHTML = "";
  c.gbif.forEach((g) => gbifOverlay(g.name, g.key));

  if (c.module) openModule(c.module);
  const drop = v.dropped.length ? ` — skipped ${v.dropped.join(", ")}` : "";
  status(`case loaded${c.saved ? " (saved " + c.saved.slice(0, 16).replace("T", " ") + ")" : ""}${drop}`, v.dropped.length > 0);
}

function loadCase(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const c = JSON.parse(reader.result);
      applyCase(c);
      clearAutosave();
      recordRecent(c, file.name);                  // a loaded file is now a working case
    } catch { status("could not parse case file", true); }
  };
  reader.readAsText(file);
}

/* ── recent cases ──────────────────────────────────────────────
   A small local index of saved/loaded cases so you can reopen one in-app
   (no file re-pick). Stores the full snapshot per entry; capped + quota-safe.
   100% local (localStorage). The browser can't reopen files by path, so this
   keeps the snapshots itself. */
const RECENT_KEY = "geosint:recent";
const RECENT_MAX = 8;

function readRecent() {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); return true; }
  catch {
    // Quota: drop oldest snapshots (tombstone), then oldest entries, until it fits.
    const trimmed = list.slice();
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i].snapshot) { trimmed[i] = { ...trimmed[i], snapshot: null }; }
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); return true; } catch { /* keep trimming */ }
    }
    while (trimmed.length) {
      trimmed.pop();
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); return true; } catch { /* keep popping */ }
    }
    return false;
  }
}

function recordRecent(caseObj, name) {
  if (!caseObj || caseObj.app !== "geosint-workbench") return;
  if (!lsAvailable()) return;
  const entry = {
    id: Date.now(),
    name: (name || `case ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).replace(/\.geosint\.json$/i, ""),
    saved: caseObj.saved || new Date().toISOString(),
    point: caseObj.point ? `${caseObj.point.lat.toFixed(4)}, ${caseObj.point.lng.toFixed(4)}` : null,
    counts: { annos: (caseObj.annos || []).length, artifacts: (caseObj.artifacts || []).length,
              measure: (caseObj.measure || []).length },
    snapshot: caseObj,
  };
  let list = readRecent().filter((e) => e.name !== entry.name);   // dedupe by name
  list.unshift(entry);
  if (list.length > RECENT_MAX) list = list.slice(0, RECENT_MAX);
  writeRecent(list);
}

function renderRecentMenu() {
  const menu = $("#recent-menu");
  const list = readRecent();
  let html = list.map((e, i) => {
    const tomb = !e.snapshot;
    const meta = [e.point || "no point",
      `${e.counts ? e.counts.annos : 0}📌 ${e.counts ? e.counts.artifacts : 0}🖼`,
      (e.saved || "").slice(0, 16).replace("T", " ")].join(" · ");
    return `<div class="rc-item${tomb ? " tomb" : ""}" data-i="${i}"${tomb ? ' title="Snapshot dropped to save space — use ⭱ LOAD to open the file"' : ""}>
      <div class="rc-name">${esc(e.name)}${tomb ? " (file only)" : ""}</div>
      <div class="rc-meta">${esc(meta)}</div></div>`;
  }).join("");
  if (!list.length) html = `<div class="rc-empty">No recent cases yet — save one with ⭳ SAVE.</div>`;
  html += `<div class="rc-open" data-open="1">⭱ Open a case file…</div>`;
  menu.innerHTML = html;
  menu.querySelectorAll(".rc-item[data-i]").forEach((el) => el.addEventListener("click", () => {
    const e = list[+el.dataset.i];
    closeRecentMenu();
    if (e.snapshot) { applyCase(e.snapshot); clearAutosave(); }
    else { status("snapshot was dropped to save space — opening file picker", false, 4000); $("#case-file").click(); }
  }));
  menu.querySelector("[data-open]").addEventListener("click", () => { closeRecentMenu(); $("#case-file").click(); });
}

function openRecentMenu() { renderRecentMenu(); $("#recent-menu").hidden = false; }
function closeRecentMenu() { $("#recent-menu").hidden = true; }
function toggleRecentMenu() { $("#recent-menu").hidden ? openRecentMenu() : closeRecentMenu(); }

/* ── bundled sample case + first-run onboarding ─────────────────
   A real, self-contained demo case that teaches the verification spine.
   No network, no external file — loaded via the existing applyCase(). */
const SAMPLE_CASE = {
  app: "geosint-workbench", version: 2,
  saved: "(bundled sample)",
  point: { lat: -33.85679, lng: 151.21528 },        // Sydney Opera House
  view: { lat: -33.8568, lng: 151.2153, zoom: 17 },
  module: null,
  measure: [],
  annos: [
    { type: "pin", ll: [-33.85679, 151.21528], text: "Claimed location: the sail-shell roof" },
    { type: "label", ll: [-33.8575, 151.2140], text: "Cross-check: harbour bridge to the NW" },
  ],
  gbif: [], data: null,
  notes: [
    "SAMPLE CASE — Sydney Opera House (a worked example of the verification spine).",
    "",
    "The workflow GeOSINT is built around:",
    "1. IMAGE [3] — drop a photo. Local EXIF gives GPS (→ jump to map) and a",
    "   timestamp (auto-fills Sun & Weather). No EXIF? Recover the embedded",
    "   preview and reverse-search the pixels.",
    "2. Map — set/confirm the active point (already set here). Right-click to copy",
    "   DD/DMS/MGRS/UTM/Plus, or open Street View / Google Earth centred here.",
    "3. SUN [1] — verify a claimed time from shadows; the shadow solver inverts a",
    "   shadow azimuth + length ratio into matching time windows (or proves the",
    "   claim impossible).",
    "4. WEATHER [2] — ERA5 archive back to 1940: was it really clear/overcast/",
    "   snowing there that day?",
    "5. Build the case — annotations (here: a pin + a label), this notes file, and",
    "   the evidence log feed the TIMELINE and the one-click DOSSIER. Save with",
    "   Ctrl+S; reopen from ↺ RECENT.",
    "",
    "Press Ctrl+K any time for the command palette. Replace this with your own case.",
  ].join("\n"),
  artifacts: [],
  inputs: { sunDt: "2023-06-15T14:30", wxDate: "2023-06-15" },
};

function loadSampleCase() {
  applyCase(SAMPLE_CASE);
  clearAutosave();
  status("sample case loaded — see the notes [N] for the workflow", false, 6000);
}

const SEEN_KEY = "geosint:seen";
/* ── modal overlay a11y: focus the first control on open, trap Tab inside, and
   restore focus to the opener on close. Used by the welcome + help overlays. */
let _modalReturnFocus = null;
function openModalOverlay(sel) {
  const el = $(sel);
  if (!el) return;
  _modalReturnFocus = document.activeElement;
  el.hidden = false;
  const focusables = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusables.length) focusables[0].focus();
  el._trap = (e) => {
    if (e.key !== "Tab" || !focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  el.addEventListener("keydown", el._trap);
}
function closeModalOverlay(sel) {
  const el = $(sel);
  if (!el || el.hidden) return;
  el.hidden = true;
  if (el._trap) { el.removeEventListener("keydown", el._trap); el._trap = null; }
  if (_modalReturnFocus && _modalReturnFocus.focus) _modalReturnFocus.focus();
  _modalReturnFocus = null;
}

function maybeWelcome() {
  // Don't double-prompt: if an autosave restore is being offered, skip the welcome.
  let seen = true;
  try { seen = !!localStorage.getItem(SEEN_KEY); } catch { seen = true; }
  if (seen || !$("#restore-bar").hidden) return;
  openModalOverlay("#welcome-overlay");
}
function dismissWelcome() {
  closeModalOverlay("#welcome-overlay");
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
}

/* ── autosave / crash recovery ─────────────────────────────────
   Continuously snapshot the live case to localStorage so a crash / accidental
   close / reload never loses work since the last manual Save. 100% local —
   localStorage is per-origin, on the user's disk; nothing is uploaded.
   Explicit Save/Load clears the snapshot (the user then has a durable copy). */
const AUTOSAVE_KEY = "geosint:autosave";
let _autosaveTimer = null, _autosaveLast = null, _autosavePaused = false;
// After an explicit Save/Load the in-memory case is "clean" — suppress autosave
// (incl. the pagehide/interval flushes) until the user edits again, so leaving the
// page doesn't silently re-snapshot a case the user already has a durable copy of.
let _autosaveClean = true;

function lsAvailable() {
  try { localStorage.setItem("geosint:_t", "1"); localStorage.removeItem("geosint:_t"); return true; }
  catch { return false; }
}

// A case is worth autosaving only once it holds real work — otherwise startup
// (deep-link setPoint, openModule) would snapshot an empty default and pop a
// pointless "restore" banner on the next load.
function caseHasContent(c) {
  return !!(c.point || (c.notes || "").trim() || (c.annos || []).length ||
            (c.measure || []).length || (c.artifacts || []).length ||
            (c.gbif || []).length || c.data);
}

function writeAutosave() {
  if (_autosaveClean || _autosavePaused || !lsAvailable()) return;
  let c;
  try { c = serializeCase(); } catch { return; }
  if (!caseHasContent(c)) {                       // nothing worth restoring yet
    if (_autosaveLast !== null) clearAutosave();  // also drop a now-emptied case
    return;
  }
  const snap = JSON.stringify(c);
  if (snap === _autosaveLast) return;            // no change since last write
  try {
    localStorage.setItem(AUTOSAVE_KEY, snap);
    _autosaveLast = snap;
  } catch {
    // Quota: retry once with thumbnails stripped (keep the rest of the case).
    try {
      const c = serializeCase();
      c.artifacts = (c.artifacts || []).map(({ thumb, ...rest }) => rest);
      const lean = JSON.stringify(c);
      localStorage.setItem(AUTOSAVE_KEY, lean);
      _autosaveLast = lean;
    } catch {
      _autosavePaused = true;                     // give up quietly for this session
      status("autosave paused — case too large for browser storage", true, 3000);
    }
  }
}

// Debounced: most edits fire this; a coarse interval + pagehide flush back it up.
function markDirty() {
  _autosaveClean = false;                          // a real edit happened → re-arm autosave
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(writeAutosave, 1500);
}

function clearAutosave() {
  _autosaveLast = null;
  _autosaveClean = true;                           // durable copy / no snapshot → don't re-flush
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

function readAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return (c && c.app === "geosint-workbench") ? c : null;
  } catch { return null; }
}

// On startup: if a snapshot exists, offer to restore it (never auto-apply, so a
// fresh session isn't silently overwritten).
function maybeOfferRestore() {
  const c = readAutosave();
  const bar = $("#restore-bar");
  if (!c || !bar) { if (!c) clearAutosave(); return; }
  const when = c.saved ? c.saved.slice(0, 16).replace("T", " ") : "earlier";
  $("#restore-when").textContent = when;
  bar.hidden = false;
  $("#restore-yes").onclick = () => {
    applyCase(c);                                 // serializeCase is sync; nothing to await
    bar.hidden = true;
    _autosaveLast = null;                          // restored case becomes the new baseline
  };
  $("#restore-no").onclick = () => { clearAutosave(); bar.hidden = true; };
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
  // recent-cases dropdown
  $("#btn-recent").addEventListener("click", (e) => { e.stopPropagation(); toggleRecentMenu(); });
  document.addEventListener("click", (e) => {
    if (!$("#recent-menu").hidden && !e.target.closest(".menu-wrap")) closeRecentMenu();
  });
  const cc = $("#custody-csv"), cj = $("#custody-json");
  if (cc) cc.addEventListener("click", () => exportCustody("csv"));
  if (cj) cj.addEventListener("click", () => exportCustody("json"));
  const tlo = $("#timeline-open"), tlc = $("#timeline-close");
  if (tlo) tlo.addEventListener("click", openTimeline);
  if (tlc) tlc.addEventListener("click", () => { $("#timeline-panel").hidden = true; });
  const dossierExport = (redact) => async () => {
    if (_artPending.size) { status("finalizing evidence log…", false, 1500); await Promise.all([..._artPending]); }
    exportDossier(redact);
  };
  const dz = $("#btn-dossier");
  if (dz) dz.addEventListener("click", dossierExport(false));
  const dzr = $("#btn-dossier-redacted");
  if (dzr) dzr.addEventListener("click", dossierExport(true));

  // ── autosave wiring ──
  const notes = $("#case-notes");
  if (notes) notes.addEventListener("input", markDirty);
  setInterval(writeAutosave, 20000);             // coarse backstop in case a mutator is missed
  // Flush synchronously when the tab is hidden/closed so the last edits survive
  // an abrupt close (the debounce timer may not fire otherwise).
  window.addEventListener("pagehide", writeAutosave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) writeAutosave(); });
  maybeOfferRestore();                            // offer to restore a prior unsaved snapshot

  // first-run welcome + sample case
  $("#welcome-sample").addEventListener("click", () => { dismissWelcome(); loadSampleCase(); });
  $("#welcome-keys").addEventListener("click", () => { dismissWelcome(); openModalOverlay("#help-overlay"); });
  $("#welcome-start").addEventListener("click", dismissWelcome);
  maybeWelcome();                                 // show on first visit (after restore check)

  // pick up a finding handed off from the Sun & Shadow Studio tab
  ingestStudioFinding();
  window.addEventListener("focus", ingestStudioFinding);
}

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
