/* GeOSINT Workbench — Sun & Shadow module (#85: IIFE + App facade).
   Self-contained module (window.Sun) talking to the App facade instead of free
   globals. The readout and the solver UI are shared with the Sun Studio
   (renderSunReadout / solveShadows / initSunInputs in common.js; the astronomy is
   CHRONO in chrono.js); this module keeps only the workbench glue — the active
   point, the dossier's solver result and autosave. */
"use strict";

window.Sun = (function () {

  function initSun() {
    initSunInputs(renderSun);
    $("#solver-run").addEventListener("click", runSolver);
  }

  function renderSun() {
    const st = App.state;
    if (!st.point) {
      st.sunLayer.clearLayers();
      $("#sun-cards").innerHTML = `<p class="hint">⚠ Click the map to set the active point first.</p>`;
      return;
    }
    renderSunReadout(st.point, st.sunLayer);
  }

  function runSolver() {
    const st = App.state;
    if (!st.point) { $("#solver-out").innerHTML = `<p class="nomatch">Set the active point first.</p>`; return; }
    const r = solveShadows(st.point, "Enter a shadow azimuth and/or a length ratio.");
    if (!r) return;
    st.solverResult = r;          // the dossier states the chronolocation finding
    App.markDirty();
  }

  return { initSun, renderSun };
})();

/* Cross-file entry points kept on window (app.js bootstrap, core.js/map.js
   re-render hooks call these bare names). */
window.initSun = Sun.initSun;
window.renderSun = Sun.renderSun;
