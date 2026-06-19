/* GeOSINT Workbench — core: shared state spine + geocoding search + the
   panel/module switcher. Loaded FIRST among the app scripts (after
   common.js): everything else reads `state`, so it must lead. #31. */

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
// A docked-search "map" link acts in place — no new tab, no deep-link round-trip.
// The search hands us a typed intent; we apply it WITHOUT leaving the wiki view
// (gbifOverlay/setPoint don't switch modules), so the analyst can keep searching.
function applyPick(intent) {
  if (intent.kind === "point") setPoint(L.latLng(intent.ll[0], intent.ll[1]), { fly: true, zoom: 13 });
  else if (intent.kind === "species") gbifOverlay(intent.name, intent.key);
}
// The docked Wiki module has two in-panel views — the search engine and the wiki
// pages themselves (an iframe over the same-origin MkDocs site) — toggled by a
// navbar. A "source page"/wiki link in a search result loads the page here
// instead of a new tab. Only same-origin /wiki/ URLs are framed (never an
// arbitrary URL), so the iframe can't be pointed off-origin.
function showWikiView(which) {              // 'search' | 'page'
  const page = which === "page";
  $("#wiki-search").hidden = page;
  $("#wiki-frame-wrap").hidden = !page;
  $("#wiki-tab-search").classList.toggle("active", !page);
  $("#wiki-tab-page").classList.toggle("active", page);
  $("#wiki-tab-search").setAttribute("aria-selected", String(!page));
  $("#wiki-tab-page").setAttribute("aria-selected", String(page));
  if (!page) GeoSearch.focus();
}

// Load a wiki page into the docked iframe and switch to the wiki view. `url` is a
// site-relative wiki path (e.g. /wiki/landmarks/) or a full same-origin /wiki/
// URL; anything else is ignored (defence against framing an off-origin page).
function openWikiPage(url, title) {
  let path;
  try { path = new URL(url, location.origin); }
  catch { return; }
  if (path.origin !== location.origin || !path.pathname.startsWith("/wiki/")) return;
  const frame = $("#wiki-frame");
  if (frame.getAttribute("src") !== path.href) frame.setAttribute("src", path.href);
  $("#wiki-page-title").textContent = title || "";
  showWikiView("page");
}

let _wikiMounted = false;
function openWiki() {
  if (!window.GeoSearch) {
    $("#wiki-search").innerHTML =
      `<p class="hint" style="padding:14px">Wiki Search failed to load. Open the standalone page: `
      + `<a href="search.html" target="_blank">search.html</a>.</p>`;
    return;
  }
  if (!_wikiMounted) {
    _wikiMounted = true;
    $("#wiki-tab-search").addEventListener("click", () => showWikiView("search"));
    $("#wiki-tab-page").addEventListener("click", () => showWikiView("page"));
    GeoSearch.mount($("#wiki-search"), {
      onPick: applyPick,
      onWiki: (url, title) => openWikiPage(url, title),   // dock a wiki page in-panel
      // 9A.2 — log a recognition card to the case as a sourced observation
      onLog: (card) => logObservation({
        text: card.t, source: card.page,
        ll: card.ll ? [card.ll[0], card.ll[1]] : undefined,
      }),
    }).then(() => GeoSearch.focus());
  } else {
    GeoSearch.focus();
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

