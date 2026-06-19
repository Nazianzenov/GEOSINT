/* GeOSINT Workbench — Data layers (OSM / GBIF / prefetch) module (split from app.js, #31).
   Classic <script>, shared global scope; loaded after common.js + core/map,
   before the app.js bootstrap. Behaviour-neutral extraction. */

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
  // border crossings & checkpoints (movement/conflict/migration analysis)
  ["Border crossings & checkpoints", ['nwr["barrier"="border_control"]',
    'nwr["amenity"="customs"]', 'nwr["barrier"="checkpoint"]'], 7],
  // extra investigative categories
  ["Prisons & detention", ['nwr["amenity"="prison"]'], 8],
  ["Embassies & consulates", ['nwr["diplomatic"="embassy"]',
    'nwr["diplomatic"="consulate"]', 'nwr["office"="diplomatic"]'], 9],
  ["Ports & harbours", ['nwr["industrial"="port"]', 'way["landuse"="port"]',
    'nwr["harbour"="yes"]', 'nwr["amenity"="ferry_terminal"]'], 7],
  // helipads alone (the "Airfields & helipads" preset bundles them with aerodromes;
  // a helipad-only view isolates rooftop/hospital/rig pads)
  ["Helipads", ['nwr["aeroway"="helipad"]'], 10],
  // cellular/radio infrastructure (corroborate a location from network
  // metadata; map comms infra for CTI). Distinct from "Towers & masts": this
  // filters to mobile-phone / telecom-tagged structures, not water/observation
  // towers. communication:mobile_phone=yes is the OSM convention for cell sites.
  ["Cell towers & radio masts", ['nwr["communication:mobile_phone"="yes"]',
    'nwr["man_made"="mast"]["tower:type"="communication"]',
    'nwr["man_made"="communications_tower"]', 'nwr["telecom"="data_center"]'], 11],
  // IXPs via OSM (not PeeringDB — data-reuse terms unstated; see ROADMAP 5D).
  ["Internet exchange points", ['nwr["telecom"="exchange"]',
    'nwr["telecom"="data_center"]'], 8],
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
    if (cancelOverpass("query cancelled.")) return;   // if a query is running, CLEAR cancels it
    state.dataLayer.clearLayers();
    state.lastData = null;
    state._plotted = [];
    $("#data-status").textContent = "";
    syncQgisButton();
  });
  $("#cables-toggle").addEventListener("click", toggleCables);
  $("#cables-qgis").addEventListener("click", cablesToQgis);
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
  // Each /api/prefetch call is wall-clock bounded server-side; on a large area it
  // returns done:false with a `remaining` count. Auto-resume by re-issuing until
  // done — cached tiles are skipped, so resuming is cheap — showing live progress.
  $("#pf-status").textContent = `caching ${layer} z${body.zmin}–${body.zmax} for this view…`;
  let fetched = 0, failed = 0, total = 0;
  try {
    for (let round = 0; round < 40; round++) {       // safety bound on resume rounds
      const r = await fetchT("/api/prefetch", {        // 35s: just above the server's per-request budget
        method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
        body: JSON.stringify(body),
      }, 35000);
      const j = await r.json();
      if (j.error) { $("#pf-status").textContent = `✗ ${j.error}`; return; }
      fetched += j.fetched; failed += j.failed; total = j.tiles;
      if (j.done) {
        $("#pf-status").textContent =
          `✓ ${total} tiles for ${layer}: ${fetched} downloaded`
          + (failed ? `, ${failed} failed` : "") + " — area available offline.";
        status(`prefetched ${fetched} tiles`);
        return;
      }
      $("#pf-status").textContent =
        `caching ${layer}… ${fetched} downloaded, ${j.remaining} to go (resuming)`;
    }
    $("#pf-status").textContent =
      `partly cached ${layer}: ${fetched} downloaded so far — press CACHE VIEW again to finish.`;
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
    const r = await fetchT("/api/qgis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ geojson: { type: "FeatureCollection", features }, name: label }),
    });
    const j = await r.json();
    status(j.error ? j.error : `QGIS opening with ${j.features} feature(s)…`, !!j.error, 8000);
  } catch { status("local server unreachable", true); }
}

// The in-flight Overpass query { ctrl: AbortController, tick: intervalId } is
// tracked on state.overpass (declared in the state object) so it can be cancelled
// (re-clicking PLOT, or the CANCEL affordance) and concurrent runs can't race.
function cancelOverpass(msg) {
  if (!state.overpass) return false;
  clearInterval(state.overpass.tick);
  state.overpass.ctrl.abort();
  state.overpass = null;
  setOverpassLoading(false);
  $("#data-status").textContent = msg || "query cancelled.";
  return true;
}

// Flip the PLOT buttons to a CANCEL affordance while a query runs.
function setOverpassLoading(on) {
  const run = $("#data-run"), runC = $("#data-run-custom");
  if (run) { run.textContent = on ? "✕ CANCEL" : "PLOT"; run.classList.toggle("armed", on); }
  if (runC) runC.disabled = on;     // custom PLOT disabled during a run (one query at a time)
}

async function runOverpass(selectors, label, minZoom = 10) {
  // Re-clicking PLOT while a query is in flight cancels it (toggle behaviour).
  if (state.overpass) { cancelOverpass("query cancelled — click PLOT to run again."); return; }
  if (state.map.getZoom() < minZoom) {
    return status(`zoom in to at least level ${minZoom} for "${label}" (current: ${state.map.getZoom()})`, true, 6000);
  }
  const b = state.map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(",");
  const q = `[out:json][timeout:20];(${selectors.map((s) => `${s}(${bbox});`).join("")});out center 600;`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const tick = setInterval(() => {
    $("#data-status").textContent =
      `querying OSM for ${label}… ${Math.round((Date.now() - t0) / 1000)}s ` +
      `(first run on an area can take ~10-30s; repeats are cached — click CANCEL to stop)`;
  }, 500);
  state.overpass = { ctrl, tick };
  setOverpassLoading(true);
  $("#data-status").textContent = `querying OSM for ${label}…`;
  try {
    const r = await fetchT("/api/overpass", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ q }), signal: ctrl.signal,
    });
    clearInterval(tick);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.overpass = null;
    setOverpassLoading(false);
    state.dataLayer.clearLayers();
    const feats = [];
    state._plotted = [];                          // registry for "pin to case" (avoids inline-onclick injection)
    for (const el of j.elements || []) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const name = el.tags?.name || el.tags?.operator || label;
      feats.push({ lat, lon, name, type: el.type, id: el.id, tags: el.tags || {} });
      const idx = state._plotted.push({ lat, lon, name, type: el.type, id: el.id, tags: el.tags || {}, label }) - 1;
      const mk = L.circleMarker([lat, lon], {
        radius: 6, color: "#ffb454", fillColor: "#ffb454", fillOpacity: 0.55, weight: 1.5,
      }).bindPopup(() => featurePopup({ lat, lon, name, type: el.type, id: el.id, idx }));
      state.dataLayer.addLayer(mk);
    }
    state.lastData = { label, features: feats };
    $("#data-status").textContent =
      `${label}: ${feats.length} features in view · ${Math.round((Date.now() - t0) / 1000)}s (cached 7 days; 600 max)` + cacheNote(r);
    status(`${feats.length} × ${label} plotted`);
    syncQgisButton();
  } catch (err) {
    clearInterval(tick);
    setOverpassLoading(false);
    if (err.name === "AbortError") return;        // user cancelled — message already set
    state.overpass = null;
    $("#data-status").textContent = "";
    status(err.message || "Overpass failed", true, 8000);
  }
}

/* submarine cables & landing points (TeleGeography, CC BY-NC-SA 3.0).
   A global overlay built from the self-contained GeoJSON copied to app/data/.
   Toggled on/off; the data is fetched once and cached on state. */
async function loadCables() {
  if (state.cables) return state.cables;
  const r = await fetchT("/app/data/submarine-cables.json");
  if (!r.ok) throw new Error("cable data not built — run the dataset fetcher + index build");
  state.cables = await r.json();
  return state.cables;
}

async function toggleCables() {
  const btn = $("#cables-toggle");
  if (state.cablesShown) {                         // hide
    state.cableLayer.clearLayers();
    state.cablesShown = false;
    btn.textContent = "⎋ SHOW CABLES";
    btn.classList.remove("accent");
    $("#cables-status").textContent = "";
    return;
  }
  $("#cables-status").textContent = "loading cable map…";
  try {
    const d = await loadCables();
    state.cableLayer.clearLayers();
    // cable routes (MultiLineString) — GeoJSON is [lng,lat]; Leaflet wants [lat,lng].
    L.geoJSON(d.cables, {
      style: (f) => ({ color: f.properties.color || "#4cc2ff", weight: 1.5, opacity: 0.75 }),
      onEachFeature: (f, lyr) => lyr.bindPopup(
        `<b>${esc(f.properties.name || "cable")}</b><br>submarine cable` +
        `<br><span class="muted">© TeleGeography · CC BY-NC-SA 3.0</span>`),
    }).addTo(state.cableLayer);
    // landing points
    for (const lp of d.landings.features) {
      const [lng, lat] = lp.geometry.coordinates;
      const lname = lp.properties.name || "landing point";
      L.circleMarker([lat, lng], {
        radius: 1.5, color: "#ffd23e", fillColor: "#ffd23e", fillOpacity: 0.9, weight: 1,
      }).bindPopup(() => setPointPopup(lname, "cable landing point", lat, lng))
        .addTo(state.cableLayer);
    }
    state.cablesShown = true;
    btn.textContent = "⎋ HIDE CABLES";
    btn.classList.add("accent");
    const nc = d.cables.features.length, nl = d.landings.features.length;
    $("#cables-status").textContent = `${nc} cables · ${nl} landing points · © TeleGeography (CC BY-NC-SA 3.0)`;
    status(`submarine cables overlaid (${nc} cables)`);
  } catch (err) {
    $("#cables-status").textContent = `✗ ${err.message}`;
    status(err.message, true, 8000);
  }
}

/* Hand the cable routes + landing points to QGIS as a GeoJSON layer. */
async function cablesToQgis() {
  try {
    const d = await loadCables();
    const features = [...d.cables.features, ...d.landings.features];
    const r = await fetchT("/api/qgis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ geojson: { type: "FeatureCollection", features }, name: "submarine-cables" }),
    });
    const j = await r.json();
    status(j.error ? j.error : `QGIS opening with ${j.features} cable feature(s)…`, !!j.error, 8000);
  } catch (err) { status(err.message || "local server unreachable", true); }
}

async function gbifOverlay(name, knownKey) {
  if (!name && !knownKey) return;
  try {
    let key = knownKey, shown = name, note = "";
    if (!key) {
      const r = await cachedFetch("https://api.gbif.org/v1/species/match?name=" + encodeURIComponent(name));
      const j = await r.json();
      if (!j.usageKey) return status(`GBIF: no match for "${name}"`, true);
      key = j.usageKey; shown = j.canonicalName || name; note = cacheNote(r);
    }
    if (state.gbifLayers[key]) return status("overlay already active");
    // Fine hex-binned density (#63): a DENSE grid of small filled cells reads as a
    // smooth density field that scales with zoom — not the old fixed-pixel `.point`
    // dots (barely visible zoomed in, "in water" near coasts) nor coarse blocky
    // hexes. `hexPerTile=100` keeps cells small; `-noborder.poly` drops hard edges;
    // opacity 0.55 lets the basemap show through so it doesn't bury the map.
    // GBIF density tiles are 512 px, so set tileSize 512 + zoomOffset -1 (the
    // default 256 squashed each tile into a quarter-slot and broke alignment).
    const tl = L.tileLayer(
      `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey=${key}&bin=hex&hexPerTile=100&style=purpleYellow-noborder.poly`,
      { opacity: 0.55, tileSize: 512, zoomOffset: -1, attribution: "Occurrences © GBIF" }).addTo(state.map);
    tl._caseName = shown;                       // remembered for case-file save/restore
    state.gbifLayers[key] = tl;
    const chip = document.createElement("span");
    chip.className = "tag desktop";
    chip.style.cssText = "cursor:pointer;margin:4px 6px 0 0;display:inline-block";
    chip.textContent = `● ${shown} ✕`;
    chip.onclick = () => { state.map.removeLayer(tl); delete state.gbifLayers[key]; chip.remove(); };
    $("#gbif-active").appendChild(chip);
    status(`GBIF distribution overlay: ${shown}${note}`);
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

