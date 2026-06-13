/* GeOSINT — Sun & Shadow Studio (standalone chronolocation page).
   Pure astronomy (SunCalc) + a location (geocode or map-click) + click-to-measure
   object/shadow lengths on an uploaded photo. No dependency on the OSM data layers. */
"use strict";

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cachedFetch = (url) => fetch("/api/pget?u=" + encodeURIComponent(url));

const state = {
  loc: null,            // L.LatLng — the photo's location
  map: null, marker: null, sunLayer: null,
  img: { natW: 0, natH: 0, object: [], shadow: [], mode: "object" },
};

/* ════════════════════════ formatting / geo ═════════════════════ */
const fmtDD = (ll, p = 5) => `${ll.lat.toFixed(p)}, ${ll.lng.toFixed(p)}`;
function toDMS(deg, isLat) {
  const dir = deg >= 0 ? (isLat ? "N" : "E") : (isLat ? "S" : "W");
  const a = Math.abs(deg), d = Math.floor(a), m = Math.floor((a - d) * 60);
  const s = ((a - d) * 3600 - m * 60).toFixed(1);
  return `${d}°${String(m).padStart(2, "0")}'${s}"${dir}`;
}
const fmtDMS = (ll) => `${toDMS(ll.lat, true)} ${toDMS(ll.lng, false)}`;
const cardinal = (deg) =>
  ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(deg / 22.5) % 16];

/* "48.85, 2.35", "48.85 2.35", DMS 48°51'30"N 2°17'40"E, or N48.85 E2.35 */
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
function project(ll, bearingDeg, distM) {
  const br = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(br)) / 111320;
  const dLng = (distM * Math.sin(br)) / (111320 * Math.cos(ll.lat * Math.PI / 180));
  return L.latLng(ll.lat + dLat, ll.lng + dLng);
}

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
  const input = $("#loc-search"), box = $("#loc-results");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (!q) { box.hidden = true; return; }
    const ll = parseCoords(q);
    if (ll) {
      box.innerHTML = `<div class="search-item sel">→ Go to coordinates<small>${fmtDD(ll)} · ${fmtDMS(ll)}</small></div>`;
      box.hidden = false;
      box.firstChild.onclick = () => { setLoc(ll, { fly: true }); box.hidden = true; input.blur(); };
      return;
    }
    t = setTimeout(async () => {
      try {
        const r = await cachedFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&accept-language=en&q=${encodeURIComponent(q)}`);
        const raw = await r.json();
        const RANK = { relation: 3, way: 2, node: 1 }, seen = new Map();
        for (const d of raw) {
          const key = `${d.addresstype}|${(+d.lat).toFixed(4)},${(+d.lon).toFixed(4)}|${d.display_name}`;
          const prev = seen.get(key);
          if (!prev || (RANK[d.osm_type] || 0) > (RANK[prev.osm_type] || 0)) seen.set(key, d);
        }
        const data = [...seen.values()];
        box.innerHTML = data.length
          ? data.map((d, i) => `<div class="search-item" data-i="${i}"><b>${esc(d.name || d.display_name.split(",")[0])}</b><span class="tag">${esc(d.addresstype || d.type || "")}</span><small>${esc(d.display_name)}</small></div>`).join("")
          : `<div class="search-item">no results</div>`;
        box.hidden = false;
        box.querySelectorAll("[data-i]").forEach((el) => el.onclick = () => {
          const d = data[+el.dataset.i];
          setLoc(L.latLng(+d.lat, +d.lon), { fly: true, zoom: d.addresstype === "country" ? 6 : 14 });
          box.hidden = true; input.blur();
        });
      } catch { box.innerHTML = `<div class="search-item">Nominatim unreachable</div>`; box.hidden = false; }
    }, 450);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const f = box.querySelector(".search-item"); if (f) f.click(); }
    if (e.key === "Escape") { box.hidden = true; input.blur(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap")) box.hidden = true; });
}

/* ════════════════════════ date / time ══════════════════════════ */
function initDate() {
  const sel = $("#sun-offset");
  for (let q = -48; q <= 56; q++) {
    const o = q / 4, sign = o < 0 ? "-" : "+";
    const h = Math.floor(Math.abs(o)), mm = String(Math.round((Math.abs(o) % 1) * 60)).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = o; opt.textContent = `UTC${sign}${String(h).padStart(2, "0")}:${mm}`;
    sel.appendChild(opt);
  }
  sel.value = -(new Date().getTimezoneOffset()) / 60;
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $("#sun-dt").value = now.toISOString().slice(0, 16);
  $("#sun-dt").addEventListener("change", recompute);
  sel.addEventListener("change", recompute);
}
function sunDate() {
  const v = $("#sun-dt").value;
  if (!v) return null;
  const off = parseFloat($("#sun-offset").value);
  const [d, tm] = v.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = tm.split(":").map(Number);
  return { date: new Date(Date.UTC(Y, M - 1, D, h, mi) - off * 3600e3), off, Y, M, D };
}
const compassAz = (rad) => (rad * 180 / Math.PI + 180) % 360;
const fmtClock = (date, off) => {
  if (!date || isNaN(date)) return "—";
  return new Date(date.getTime() + off * 3600e3).toISOString().slice(11, 16);
};

/* ════════════════════════ sun geometry ═════════════════════════ */
function renderGeometry() {
  state.sunLayer.clearLayers();
  if (!state.loc) {
    $("#sun-cards").innerHTML = `<p class="hint">⚠ Set the photo location (search, or click the map).</p>`;
    $("#sun-events").innerHTML = $("#sun-moon").innerHTML = $("#sun-links").innerHTML = "";
    const cv = $("#sun-chart"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    return;
  }
  const sd = sunDate(); if (!sd) return;
  const { lat, lng } = state.loc;
  const pos = SunCalc.getPosition(sd.date, lat, lng);
  const alt = pos.altitude * 180 / Math.PI;
  const az = compassAz(pos.azimuth);
  const shadowAz = (az + 180) % 360;
  const ratio = alt > 0.2 ? (1 / Math.tan(pos.altitude)) : null;

  $("#sun-cards").innerHTML = `
    <div class="card"><div class="v">${az.toFixed(1)}°</div><div class="k">sun azimuth (${cardinal(az)})</div></div>
    <div class="card"><div class="v">${alt.toFixed(1)}°</div><div class="k">elevation ${alt < 0 ? "(night)" : ""}</div></div>
    <div class="card"><div class="v">${ratio ? ratio.toFixed(2) + "×" : "—"}</div><div class="k">shadow ÷ height</div></div>
    <div class="card"><div class="v">${shadowAz.toFixed(0)}° ${cardinal(shadowAz)}</div><div class="k">shadow points to</div></div>`;

  const t = SunCalc.getTimes(sd.date, lat, lng);
  const rows = [["Civil dawn", t.dawn], ["Sunrise", t.sunrise], ["Golden hour ends", t.goldenHourEnd],
    ["Solar noon", t.solarNoon], ["Golden hour starts", t.goldenHour], ["Sunset", t.sunset], ["Civil dusk", t.dusk]];
  $("#sun-events").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${fmtClock(v, sd.off)}</td></tr>`).join("");

  const mi = SunCalc.getMoonIllumination(sd.date);
  const phases = ["New moon","Waxing crescent","First quarter","Waxing gibbous","Full moon","Waning gibbous","Last quarter","Waning crescent"];
  const mpos = SunCalc.getMoonPosition(sd.date, lat, lng);
  $("#sun-moon").innerHTML = `
    <tr><td>Phase</td><td>${phases[Math.round(mi.phase * 8) % 8]}</td></tr>
    <tr><td>Illumination</td><td>${(mi.fraction * 100).toFixed(0)}%</td></tr>
    <tr><td>Moon altitude</td><td>${(mpos.altitude * 180 / Math.PI).toFixed(1)}°</td></tr>`;

  if (alt > 0) {
    const p = state.loc;
    // shadow direction (compare against the satellite imagery to read off the true azimuth)
    state.sunLayer.addLayer(L.polyline([p, project(p, shadowAz, 60)], { color: "#30363f", weight: 5, opacity: .9 }));
    state.sunLayer.addLayer(L.polyline([p, project(p, az, 60)], { color: "#4cc2ff", weight: 2, dashArray: "4 5", opacity: .8 }));
  }
  drawSunChart(sd, lat, lng);

  const dstr = `${sd.Y}.${String(sd.M).padStart(2, "0")}.${String(sd.D).padStart(2, "0")}`;
  const tstr = $("#sun-dt").value.split("T")[1];
  $("#sun-links").innerHTML = `
    <a class="btn" target="_blank" href="https://www.suncalc.org/#/${lat.toFixed(5)},${lng.toFixed(5)},15/${dstr}/${tstr}/1/3">SunCalc.org ⇗</a>
    <a class="btn" target="_blank" href="https://shademap.app/@${lat.toFixed(5)},${lng.toFixed(5)},15z">ShadeMap ⇗</a>
    <a class="btn" target="_blank" href="https://www.peakfinder.com/?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}">PeakFinder horizon ⇗</a>`;
}

function drawSunChart(sd, lat, lng) {
  const cv = $("#sun-chart"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const y0 = H * 0.72;
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
  const v = $("#sun-dt").value.split("T")[1].split(":");
  const mNow = (+v[0]) * 60 + (+v[1]);
  const aNow = SunCalc.getPosition(sd.date, lat, lng).altitude * 180 / Math.PI;
  ctx.fillStyle = "#4cc2ff";
  ctx.beginPath(); ctx.arc((mNow / 1440) * W, y0 - (aNow / 90) * (H * 0.66), 4, 0, 7); ctx.fill();
}

/* ════════════════════════════ solver ═══════════════════════════ */
function runSolver() {
  const out = $("#solver-out");
  if (!state.loc) { out.innerHTML = `<p class="nomatch">Set the photo location first.</p>`; return; }
  const azT = parseFloat($("#solver-az").value);
  const ratioT = parseFloat($("#solver-ratio").value);
  const tol = parseFloat($("#solver-tol").value) || 8;
  if (isNaN(azT) && isNaN(ratioT)) { out.innerHTML = `<p class="hint">Measure object + shadow on the image, or type a shadow azimuth / ratio, to solve for the time.</p>`; return; }
  const sd = sunDate(); const { lat, lng } = state.loc;
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
  const groups = []; let g = [matches[0]];
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

function initSolver() {
  $("#solver-run").addEventListener("click", runSolver);
  ["solver-az", "solver-ratio", "solver-tol"].forEach((id) =>
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
    if (ex && ex.DateTimeOriginal) {
      const d = new Date(ex.DateTimeOriginal), pad = (x) => String(x).padStart(2, "0");
      $("#sun-dt").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      recompute();
    }
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
