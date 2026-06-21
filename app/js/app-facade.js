/* GeOSINT Workbench — App facade (#85).
   A thin, explicit seam over the shared spine so panel modules can depend on a
   named surface (App.state, App.setPoint, App.status, …) instead of reaching
   into free globals. This is NOT a new state container: `state` stays the single
   source of truth in core.js; the facade only FORWARDS to the existing globals.

   Why getters / wrapper methods rather than captured references: this file is
   loaded right after core.js but BEFORE map.js (setPoint) and case.js
   (logObservation), so those names aren't defined yet at eval time. Forwarding
   lazily (resolved at call time) sidesteps the load-order trap, and keeps the
   bare globals intact for the browser test-suite that calls them directly. */
"use strict";

window.App = {
  // ── shared state spine (core.js) ──
  get state() { return state; },
  get map() { return state.map; },           // convenience: the Leaflet map

  // ── actions (resolved lazily — defined in map.js / case.js / core.js) ──
  setPoint(ll, opts) { return setPoint(ll, opts); },
  logObservation(o) { return logObservation(o); },
  status(msg, isErr, ms) { return status(msg, isErr, ms); },
  markDirty() { return markDirty(); },
  copyText(t) { return copyText(t); },

  // ── helpers (common.js — already defined when this evaluates) ──
  esc, fetchT, cachedFetch, cacheNote, fmtDD,
};
