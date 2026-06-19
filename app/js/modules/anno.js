/* GeOSINT Workbench — Annotations module (split from app.js, #31).
   Classic <script>, shared global scope; loaded after common.js + core/map,
   before the app.js bootstrap. Behaviour-neutral extraction. */

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
  markDirty();
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
  markDirty();
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
    const r = await fetchT("/api/qgis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ geojson: annoFeatureCollection(), name: "annotations" }),
    });
    const j = await r.json();
    status(j.error ? j.error : `QGIS opening with ${j.features} annotation(s)…`, !!j.error, 8000);
  } catch { status("local server unreachable", true); }
}

