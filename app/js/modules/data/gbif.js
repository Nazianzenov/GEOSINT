/* GeOSINT Workbench — GBIF species-distribution overlay (split from data.js #87).
   Live occurrence-density tiles for a species, added as a Leaflet tileLayer with
   a removable chip. ONLINE-ONLY (tiles fetched from api.gbif.org). Self-contained
   IIFE; gbifOverlay() is re-exported on window for case restore / deep links. */
"use strict";

window.Gbif = (function () {

  async function overlay(name, knownKey) {
    if (!name && !knownKey) return;
    const st = App.state, map = App.map;
    try {
      let key = knownKey, shown = name, note = "";
      if (!key) {
        const r = await App.cachedFetch("https://api.gbif.org/v1/species/match?name=" + encodeURIComponent(name));
        const j = await r.json();
        if (!j.usageKey) return App.status(`GBIF: no match for "${name}"`, true);
        key = j.usageKey; shown = j.canonicalName || name; note = App.cacheNote(r);
      }
      if (st.gbifLayers[key]) return App.status("overlay already active");
      // Fine hex-binned density (#63): a DENSE grid of small filled cells reads as a
      // smooth density field that scales with zoom — not the old fixed-pixel `.point`
      // dots (barely visible zoomed in, "in water" near coasts) nor coarse blocky
      // hexes. `hexPerTile=100` keeps cells small; `-noborder.poly` drops hard edges;
      // opacity 0.55 lets the basemap show through so it doesn't bury the map.
      // GBIF density tiles are 512 px, so set tileSize 512 + zoomOffset -1 (the
      // default 256 squashed each tile into a quarter-slot and broke alignment).
      // Density tiles are proxied + cached + OPSEC-routed through the LOCAL server
      // (/api/gbif/tile) rather than fetched straight from api.gbif.org by the
      // browser — which used to leak the analyst's IP + browser UA + species of
      // interest to GBIF on every pan/zoom. Same density params; the server
      // allowlists them and routes the fetch per the OPSEC "gbif" setting.
      const tl = L.tileLayer(
        `/api/gbif/tile/{z}/{x}/{y}?taxonKey=${key}&bin=hex&hexPerTile=100&style=purpleYellow-noborder.poly`,
        { opacity: 0.55, tileSize: 512, zoomOffset: -1, attribution: "Occurrences © GBIF" }).addTo(map);
      tl._caseName = shown;                       // remembered for case-file save/restore
      st.gbifLayers[key] = tl;
      const chip = document.createElement("span");
      chip.className = "tag desktop";
      chip.style.cssText = "cursor:pointer;margin:4px 6px 0 0;display:inline-block";
      chip.textContent = `● ${shown} ✕`;
      chip.onclick = () => { map.removeLayer(tl); delete st.gbifLayers[key]; chip.remove(); };
      $("#gbif-active").appendChild(chip);
      App.status(`GBIF distribution overlay: ${shown}${note}`);
    } catch { App.status("GBIF unreachable", true); }
  }

  return { overlay };
})();

window.gbifOverlay = Gbif.overlay;
