/* GeOSINT Workbench — map: Leaflet setup, active point, context menu,
   measure/ruler, elevation profile. Loaded after core (uses `state`). #31. */

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
    const lng = wrapLng(ll.lng);                // a point past the date line reads e.g. 181.5
    const key = `${ll.lat.toFixed(3)},${lng.toFixed(3)}`;
    if (!_elevCache.has(key)) {
      try {
        const r = await cachedFetch(`https://api.open-meteo.com/v1/elevation?latitude=${ll.lat.toFixed(4)}&longitude=${lng.toFixed(4)}`);
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
  const lngs = samples.map((s) => wrapLng(s.ll.lng).toFixed(5)).join(",");
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

