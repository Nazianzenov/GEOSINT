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
  // shared with the Sun Studio (common.js); the workbench adds the area outline
  initPlaceSearch($("#search"), $("#search-results"), (ll, d) => {
    const poly = d && d.geojson && /Polygon$/.test(d.geojson.type);   // Polygon | MultiPolygon
    // for an area, fitBounds to the polygon instead of flying to the label point
    const zoom = !d ? undefined : d.addresstype === "country" ? 6 : 13;   // typed coords: setPoint's default
    setPoint(ll, poly ? {} : { fly: true, zoom });
    if (poly) showBoundary(d.geojson);
  }, { polygons: true });
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
  // Switching to the Wiki view with nothing loaded yet -> show the wiki home,
  // not a blank iframe.
  if (page) {
    const frame = $("#wiki-frame");
    if (!frame.getAttribute("src")) {
      frame.setAttribute("src", "/wiki/");
      $("#wiki-page-title").textContent = "GeOSINT Field Wiki";
    }
  }
  $("#wiki-search").hidden = page;
  $("#wiki-frame-wrap").hidden = !page;
  $("#wiki-tab-search").classList.toggle("active", !page);
  $("#wiki-tab-page").classList.toggle("active", page);
  $("#wiki-tab-search").setAttribute("aria-selected", String(!page));
  $("#wiki-tab-page").setAttribute("aria-selected", String(page));
  if (!page) GeoSearch.focus();
}

// Open a card's "source page". Same-origin /wiki/ pages dock in the iframe; an
// external page (wikidata, ourairports, …) can't be framed cross-origin, so it
// opens in a new tab — most indexed cards point off-site, and silently doing
// nothing for them was the bug. Anything unparseable is ignored.
function openWikiPage(url, title) {
  let path;
  try { path = new URL(url, location.origin); }
  catch { return; }
  const internalWiki = path.origin === location.origin && path.pathname.startsWith("/wiki/");
  if (!internalWiki) {
    // external (or non-/wiki/ same-origin) — open in a new tab, never frame it
    if (/^https?:$/.test(path.protocol)) window.open(path.href, "_blank", "noopener");
    return;
  }
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
    // Keep the page-title label in sync when the user navigates INSIDE the iframe
    // (clicking links in the wiki) — otherwise the label stayed stuck on whatever
    // card first opened it. Same-origin /wiki/, so we can read the loaded title.
    $("#wiki-frame").addEventListener("load", () => {
      try {
        const t = $("#wiki-frame").contentDocument?.title || "";
        // MkDocs titles are "Page - Site"; keep just the page part.
        $("#wiki-page-title").textContent = t.split(" - ")[0].trim();
      } catch { /* cross-origin (shouldn't happen) — leave the label as-is */ }
    });
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

