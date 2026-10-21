/* GeOSINT Workbench — offline tile prefetch (split from data.js #87).
   Downloads every tile of the current view across a zoom range into the server's
   disk tile cache, so the area works fully offline (fieldwork OPSEC). Each call
   is wall-clock bounded server-side; auto-resumes until done. Self-contained IIFE
   talking to the App facade; prefetchTiles re-exported on window. */
"use strict";

window.Prefetch = (function () {

  async function prefetchTiles() {
    const map = App.map;
    const b = map.getBounds();
    const z = map.getZoom();
    const depth = Math.max(0, Math.min(8, parseInt($("#pf-depth").value, 10) || 0));
    const layer = $("#pf-layer").value;
    const body = {
      layer,
      bbox: wrapBbox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()),   // Leaflet doesn't wrap
      zmin: z, zmax: Math.min(19, z + depth),
    };
    // Each /api/prefetch call is wall-clock bounded server-side; on a large area it
    // returns done:false with a `remaining` count. Auto-resume by re-issuing until
    // done — cached tiles are skipped, so resuming is cheap — showing live progress.
    $("#pf-status").textContent = `caching ${layer} z${body.zmin}–${body.zmax} for this view…`;
    let fetched = 0, failed = 0, total = 0;
    try {
      for (let round = 0; round < 40; round++) {       // safety bound on resume rounds
        const r = await App.fetchT("/api/prefetch", {     // 35s: just above the server's per-request budget
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
          App.status(`prefetched ${fetched} tiles`);
          return;
        }
        $("#pf-status").textContent =
          `caching ${layer}… ${fetched} downloaded, ${j.remaining} to go (resuming)`;
      }
      $("#pf-status").textContent =
        `partly cached ${layer}: ${fetched} downloaded so far — press CACHE VIEW again to finish.`;
    } catch { $("#pf-status").textContent = "✗ local server unreachable"; }
  }

  return { prefetchTiles };
})();
