/* GeOSINT Workbench — application logic.
   Vanilla JS. External calls: OSM/Esri/Carto tiles, Nominatim geocoding,
   Open-Meteo weather. Everything else is local. */
"use strict";

/* The workbench is split into ordered <script> modules (see index.html):
     common.js  — shared helpers (esc, fetchT, coord fmt, …)
     core.js    — state spine + geocoding search + panel switcher
     map.js     — Leaflet map, active point, measure, elevation
     modules/*  — the six panels (sun, weather, image, tools, data, anno)
     case.js    — evidence log, dossier, case-file save/load, autosave
     palette.js — command palette
   This file is the bootstrap: global keyboard wiring + DOMContentLoaded. */

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
