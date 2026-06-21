/* GeOSINT Workbench — Overpass overlay + QGIS hand-off (split from data.js #87).
   Plots OSM features in the current view (one query at a time, cancellable) and
   hands the plotted features / active point to QGIS. Self-contained IIFE talking
   to the App facade; cross-file entry points are re-exported on window below. */
"use strict";

window.Overpass = (function () {

  // The in-flight Overpass query { ctrl: AbortController, tick: intervalId } is
  // tracked on App.state.overpass (declared in the state object) so it can be
  // cancelled (re-clicking PLOT, or the CANCEL affordance) and concurrent runs
  // can't race.
  function cancel(msg) {
    const st = App.state;
    if (!st.overpass) return false;
    clearInterval(st.overpass.tick);
    st.overpass.ctrl.abort();
    st.overpass = null;
    setLoading(false);
    $("#data-status").textContent = msg || "query cancelled.";
    return true;
  }

  // Flip the PLOT buttons to a CANCEL affordance while a query runs.
  function setLoading(on) {
    const run = $("#data-run"), runC = $("#data-run-custom");
    if (run) { run.textContent = on ? "✕ CANCEL" : "PLOT"; run.classList.toggle("armed", on); }
    if (runC) runC.disabled = on;     // custom PLOT disabled during a run (one query at a time)
  }

  async function run(selectors, label, minZoom = 10) {
    const st = App.state, map = App.map;
    // Re-clicking PLOT while a query is in flight cancels it (toggle behaviour).
    if (st.overpass) { cancel("query cancelled — click PLOT to run again."); return; }
    if (map.getZoom() < minZoom) {
      return App.status(`zoom in to at least level ${minZoom} for "${label}" (current: ${map.getZoom()})`, true, 6000);
    }
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(",");
    const q = `[out:json][timeout:20];(${selectors.map((s) => `${s}(${bbox});`).join("")});out center 600;`;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const tick = setInterval(() => {
      $("#data-status").textContent =
        `querying OSM for ${label}… ${Math.round((Date.now() - t0) / 1000)}s ` +
        `(first run on an area can take ~10-30s; repeats are cached — click CANCEL to stop)`;
    }, 500);
    st.overpass = { ctrl, tick };
    setLoading(true);
    $("#data-status").textContent = `querying OSM for ${label}…`;
    try {
      const r = await App.fetchT("/api/overpass", {
        method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
        body: JSON.stringify({ q }), signal: ctrl.signal,
      });
      clearInterval(tick);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      st.overpass = null;
      setLoading(false);
      st.dataLayer.clearLayers();
      const feats = [];
      st._plotted = [];                          // registry for "pin to case" (avoids inline-onclick injection)
      for (const el of j.elements || []) {
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (lat == null) continue;
        const name = el.tags?.name || el.tags?.operator || label;
        feats.push({ lat, lon, name, type: el.type, id: el.id, tags: el.tags || {} });
        const idx = st._plotted.push({ lat, lon, name, type: el.type, id: el.id, tags: el.tags || {}, label }) - 1;
        const mk = L.circleMarker([lat, lon], {
          radius: 6, color: "#ffb454", fillColor: "#ffb454", fillOpacity: 0.55, weight: 1.5,
        }).bindPopup(() => featurePopup({ lat, lon, name, type: el.type, id: el.id, idx }));
        st.dataLayer.addLayer(mk);
      }
      st.lastData = { label, features: feats };
      $("#data-status").textContent =
        `${label}: ${feats.length} features in view · ${Math.round((Date.now() - t0) / 1000)}s (cached 7 days; 600 max)` + App.cacheNote(r);
      App.status(`${feats.length} × ${label} plotted`);
      syncQgis();
    } catch (err) {
      clearInterval(tick);
      setLoading(false);
      if (err.name === "AbortError") return;        // user cancelled — message already set
      st.overpass = null;
      $("#data-status").textContent = "";
      App.status(err.message || "Overpass failed", true, 8000);
    }
  }

  /* ── QGIS hand-off (the plotted features and/or the active point) ── */

  /* Enable the QGIS button only when QGIS is installed; relabel by what we'd send. */
  function syncQgis() {
    const qb = $("#data-qgis");
    if (!qb) return;
    const st = App.state;
    const has = st.tools && st.tools.qgis && st.tools.qgis.found;
    const n = st.lastData ? st.lastData.features.length : 0;
    qb.disabled = !has;
    qb.title = has ? "Open the plotted features and/or active point in QGIS as a layer"
                   : "QGIS not detected — install it to enable hand-off";
    qb.textContent = !has ? "QGIS not installed"
      : n ? `▦ OPEN ${n} FEATURE${n > 1 ? "S" : ""} IN QGIS`
          : "▦ OPEN ACTIVE POINT IN QGIS";
  }

  async function openInQgis() {
    const st = App.state;
    const features = [];
    if (st.lastData && st.lastData.features.length) {
      for (const el of st.lastData.features) {
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [el.lon, el.lat] },
          properties: { name: el.name, osm_type: el.type, osm_id: el.id, ...el.tags } });
      }
    }
    if (st.point) {
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [st.point.lng, st.point.lat] },
        properties: { name: "active point" } });
    }
    if (!features.length) return App.status("plot a dataset or set the active point first", true);
    const label = (st.lastData && st.lastData.label) || "active-point";
    try {
      const r = await App.fetchT("/api/qgis", {
        method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
        body: JSON.stringify({ geojson: { type: "FeatureCollection", features }, name: label }),
      });
      const j = await r.json();
      App.status(j.error ? j.error : `QGIS opening with ${j.features} feature(s)…`, !!j.error, 8000);
    } catch { App.status("local server unreachable", true); }
  }

  return { run, cancel, setLoading, syncQgis, openInQgis };
})();

/* Cross-file / test entry points kept on window (callers in app.js, map.js,
   core.js, case.js and the data wiring still reference these bare names). */
window.runOverpass = Overpass.run;
window.cancelOverpass = Overpass.cancel;
window.syncQgisButton = Overpass.syncQgis;
window.openInQgis = Overpass.openInQgis;
