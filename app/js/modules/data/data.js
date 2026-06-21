/* GeOSINT Workbench — Data layers panel wiring (#87).
   This file is now just the panel's init: it builds the preset dropdown from
   DataPresets and binds each control to its overlay module (Overpass / Gbif /
   Cables / Prefetch). The behaviour lives in app/js/modules/data/*.js. */
"use strict";

function initData() {
  const sel = $("#data-preset");
  DataPresets.forEach(([name], i) => {
    const o = document.createElement("option"); o.value = i; o.textContent = name;
    sel.appendChild(o);
  });
  $("#data-run").addEventListener("click", () => {
    const [name, selectors, minZoom] = DataPresets[+sel.value];
    Overpass.run(selectors, name, minZoom);
  });
  $("#data-run-custom").addEventListener("click", () => {
    const m = $("#data-custom").value.trim().match(/^([\w:]+)\s*=\s*([\w:;|-]+)$/);
    if (!m) return App.status("custom tag must look like  key=value", true);
    Overpass.run([`nwr["${m[1]}"="${m[2]}"]`], `${m[1]}=${m[2]}`, 10);
  });
  $("#data-clear").addEventListener("click", () => {
    if (Overpass.cancel("query cancelled.")) return;   // if a query is running, CLEAR cancels it
    const st = App.state;
    st.dataLayer.clearLayers();
    st.lastData = null;
    st._plotted = [];
    $("#data-status").textContent = "";
    Overpass.syncQgis();
  });
  $("#cables-toggle").addEventListener("click", Cables.toggle);
  $("#cables-qgis").addEventListener("click", Cables.toQgis);
  $("#gbif-add").addEventListener("click", () => Gbif.overlay($("#gbif-name").value.trim()));
  const qb = $("#data-qgis");
  if (qb) qb.addEventListener("click", Overpass.openInQgis);
  $("#pf-run").addEventListener("click", Prefetch.prefetchTiles);
  Overpass.syncQgis();
}
