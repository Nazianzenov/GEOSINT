/* GeOSINT — Sun & Shadow Studio (standalone chronolocation page).
   Pure astronomy (SunCalc) + a location (geocode or map-click) + click-to-measure
   object/shadow lengths on an uploaded photo. No dependency on the OSM data layers. */
"use strict";

/* The place search, sun readout, solver UI and date inputs are shared with the
   workbench panel (initPlaceSearch / renderSunReadout / solveShadows /
   initSunInputs in app/js/common.js, loaded before this script). The Studio keeps
   its own map, photo measuring and the "send to case" hand-off. */

const state = {
  loc: null,            // L.LatLng — the photo's location
  map: null, marker: null, sunLayer: null,
  img: { natW: 0, natH: 0, object: [], shadow: [], mode: "object" },
};

function status(msg, isErr = false, ms = 4000) {
  const el = $("#status-msg");
  el.textContent = msg; el.className = isErr ? "err" : "";
  clearTimeout(status._t);
  if (ms) status._t = setTimeout(() => { el.textContent = ""; }, ms);
}

/* ════════════════════════════ map ══════════════════════════════ */
function initMap() {
  const dark = L.tileLayer("/tiles/carto-dark/{z}/{x}/{y}", { maxZoom: 20, attribution: "&copy; OSM &copy; CARTO" });
  const sat  = L.tileLayer("/tiles/esri-sat/{z}/{x}/{y}", { maxZoom: 19, attribution: "Imagery &copy; Esri" });
  const osm  = L.tileLayer("/tiles/osm/{z}/{x}/{y}", { maxZoom: 19, attribution: "&copy; OpenStreetMap" });
  const labels = L.tileLayer("/tiles/esri-labels/{z}/{x}/{y}", { maxZoom: 19, attribution: "Labels &copy; Esri" });
  state.map = L.map("studio-map", { center: [30, 10], zoom: 3, layers: [sat] });
  L.control.layers({ "Satellite (Esri)": sat, "Dark": dark, "OpenStreetMap": osm },
                   { "Place labels": labels }, { position: "topright" }).addTo(state.map);
  L.control.scale({ imperial: true }).addTo(state.map);
  state.sunLayer = L.layerGroup().addTo(state.map);
  state.map.on("click", (e) => setLoc(e.latlng));
  setTimeout(() => state.map.invalidateSize(), 120);   // flex pane can mis-measure at init
}

function setLoc(ll, opts = {}) {
  state.loc = L.latLng(ll.lat, ll.lng);
  if (!state.marker) {
    state.marker = L.marker(state.loc, { draggable: true }).addTo(state.map);
    state.marker.on("dragend", () => setLoc(state.marker.getLatLng()));
  } else state.marker.setLatLng(state.loc);
  $("#loc-readout").textContent = `${fmtDD(state.loc)}`;
  if (opts.fly) state.map.flyTo(state.loc, opts.zoom || Math.max(state.map.getZoom(), 13), { duration: 1.0 });
  recompute();
}

/* ════════════════════════ location search ══════════════════════ */
function initLocSearch() {
  initPlaceSearch($("#loc-search"), $("#loc-results"), (ll, d) =>
    setLoc(ll, { fly: true, zoom: d && d.addresstype === "country" ? 6 : 14 }));
}

/* ════════════════════════ date / time ══════════════════════════ */
function initDate() { initSunInputs(recompute); }

/* ════════════════════════ sun geometry ═════════════════════════ */
function renderGeometry() {
  if (!state.loc) {
    state.sunLayer.clearLayers();
    $("#sun-cards").innerHTML = `<p class="hint">⚠ Set the photo location (search, or click the map).</p>`;
    $("#sun-events").innerHTML = $("#sun-moon").innerHTML = $("#sun-links").innerHTML = "";
    const cv = $("#sun-chart"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    return;
  }
  renderSunReadout(state.loc, state.sunLayer);
}

/* ════════════════════════════ solver ═══════════════════════════ */
function runSolver() {
  if (!state.loc) { $("#solver-out").innerHTML = `<p class="nomatch">Set the photo location first.</p>`; return; }
  const r = solveShadows(state.loc,
    "Measure object + shadow on the image, or type a shadow azimuth / ratio, to solve for the time.");
  if (!r) return;
  state.solverResult = { ...r, loc: { lat: state.loc.lat, lng: state.loc.lng }, dt: $("#sun-dt").value };
  $("#solver-out").insertAdjacentHTML("beforeend", sendToCaseBtn());
  wireSendToCase();
}

/* Hand the Studio's chronolocation finding back to the main workbench case via a
   shared localStorage key (the Studio is a separate tab/document). The workbench
   picks it up on focus/load and logs it as an artifact + sets state.solverResult.
   100% local — same-origin localStorage, nothing uploaded. */
function sendToCaseBtn() {
  return `<button class="btn accent" id="send-to-case" style="margin-top:8px"
    title="Send this chronolocation result + location to the main workbench case">＋ Send to case</button>
    <span id="send-to-case-msg" class="muted" style="margin-left:8px"></span>`;
}
function wireSendToCase() {
  const b = document.getElementById("send-to-case");
  if (!b) return;
  b.onclick = () => {
    const r = state.solverResult;
    if (!r) return;
    try {
      localStorage.setItem(STUDIO_HANDOFF_KEY, JSON.stringify({ ...r, sent: new Date().toISOString() }));
      document.getElementById("send-to-case-msg").textContent =
        "✓ sent — switch to the workbench tab to log it";
    } catch {
      document.getElementById("send-to-case-msg").textContent = "✗ browser storage unavailable";
    }
  };
}

function initSolver() {
  $("#solver-run").addEventListener("click", runSolver);
  ["solver-az", "solver-ratio", "solver-tol", "solver-az2", "solver-ratio2", "solver-dt2"].forEach((id) =>
    $("#" + id).addEventListener("input", runSolver));
}

/* ════════════════════════ image + measure ══════════════════════ */
function initImage() {
  const dz = $("#dropzone"), fi = $("#file-input");
  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", () => fi.files[0] && loadImage(fi.files[0]));
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) loadImage(f); });

  $$("#measure-modes .btn[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#img-clear").addEventListener("click", () => {
    state.img.object = []; state.img.shadow = []; redrawMarks(); updateMeasureCards();
  });
  $("#studio-img").addEventListener("click", onImageClick);
  window.addEventListener("resize", fitOverlay);
  setMode("object");
  updateMeasureCards();
}

async function loadImage(file) {
  const img = $("#studio-img");
  img.onload = () => {
    state.img.natW = img.naturalWidth; state.img.natH = img.naturalHeight;
    img.hidden = false; $("#img-placeholder").hidden = true;
    const ov = $("#img-overlay");
    ov.setAttribute("viewBox", `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
    ov.hidden = false;
    state.img.object = []; state.img.shadow = [];
    fitOverlay(); redrawMarks(); updateMeasureCards(); setMode("object");
  };
  img.src = URL.createObjectURL(file);

  // EXIF: auto-fill location + claimed time when present
  try {
    const ex = await exifr.parse(file, { gps: true, exif: true });
    if (ex && ex.latitude != null && ex.longitude != null) {
      setLoc(L.latLng(ex.latitude, ex.longitude), { fly: true, zoom: 16 });
      status("EXIF GPS → location set");
    }
    if (exifToSunInputs(ex)) recompute();
  } catch { /* no/!parseable EXIF — fine, this is a measurement tool */ }
}

function setMode(mode) {
  state.img.mode = mode;
  $$("#measure-modes .btn[data-mode]").forEach((b) => b.classList.toggle("armed", b.dataset.mode === mode));
}

/* overlay click → record point in natural-image coords (ratios are scale-independent) */
function onImageClick(e) {
  if (!state.img.natW) return;
  const r = $("#studio-img").getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * state.img.natW;
  const y = (e.clientY - r.top) / r.height * state.img.natH;
  const arr = state.img[state.img.mode];
  if (arr.length >= 2) arr.length = 0;          // third click starts the segment over
  arr.push([x, y]);
  redrawMarks();
  if (state.img.mode === "object" && arr.length === 2) setMode("shadow");   // guide the next step
  updateMeasureCards();
}

const segLen = (a) => a.length === 2 ? Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]) : 0;

function updateMeasureCards() {
  const o = segLen(state.img.object), s = segLen(state.img.shadow);
  const ratio = (o > 0 && s > 0) ? s / o : null;
  const elev = ratio ? Math.atan(o / s) * 180 / Math.PI : null;
  $("#measure-cards").innerHTML = `
    <div class="card"><div class="v">${o ? Math.round(o) + " px" : "—"}</div><div class="k">object height</div></div>
    <div class="card"><div class="v">${s ? Math.round(s) + " px" : "—"}</div><div class="k">shadow length</div></div>
    <div class="card"><div class="v">${ratio ? ratio.toFixed(2) + "×" : "—"}</div><div class="k">shadow ÷ height</div></div>
    <div class="card"><div class="v">${elev != null ? elev.toFixed(1) + "°" : "—"}</div><div class="k">implied sun elev.</div></div>`;
  if (ratio) { $("#solver-ratio").value = ratio.toFixed(2); }
  recompute();
}

function fitOverlay() {
  const img = $("#studio-img"), ov = $("#img-overlay"), wrap = $("#studio-imgwrap");
  if (img.hidden) return;
  const ir = img.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  Object.assign(ov.style, {
    left: (ir.left - wr.left) + "px", top: (ir.top - wr.top) + "px",
    right: "auto", bottom: "auto", width: ir.width + "px", height: ir.height + "px",
  });
}

const SVGNS = "http://www.w3.org/2000/svg";
function redrawMarks() {
  const ov = $("#img-overlay");
  while (ov.firstChild) ov.removeChild(ov.firstChild);
  const sw = Math.max(state.img.natW, state.img.natH) / 320 || 2;
  const draw = (seg, color) => {
    seg.forEach(([x, y]) => {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", sw * 1.8);
      c.setAttribute("fill", color);
      ov.appendChild(c);
    });
    if (seg.length === 2) {
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", seg[0][0]); ln.setAttribute("y1", seg[0][1]);
      ln.setAttribute("x2", seg[1][0]); ln.setAttribute("y2", seg[1][1]);
      ln.setAttribute("stroke", color); ln.setAttribute("stroke-width", sw);
      ov.appendChild(ln);
    }
  };
  draw(state.img.object, "#7ee787");   // green = object
  draw(state.img.shadow, "#4cc2ff");   // blue  = shadow
}

/* ════════════════════════ recompute / boot ═════════════════════ */
let _rt;
function recompute() { clearTimeout(_rt); _rt = setTimeout(() => { renderGeometry(); runSolver(); }, 30); }

document.addEventListener("DOMContentLoaded", () => {
  initMap(); initLocSearch(); initDate(); initImage(); initSolver();
  // deep link: #ll=lat,lng to preset the location
  const ll = location.hash.match(/^#ll=(-?[\d.]+),(-?[\d.]+)/);
  if (ll) setLoc(L.latLng(+ll[1], +ll[2]), { fly: true, zoom: 14 });
  else recompute();
});
