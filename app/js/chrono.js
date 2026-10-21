/* GeOSINT — chronolocation engine (shared, DOM-free).  Issue #84.

   The shadow solver is the product's flagship engine, and it used to exist as
   two hand-copied implementations: the in-panel workbench module
   (app/js/modules/sun.js) and the standalone Sun & Shadow Studio (app/js/sun.js).
   Every confidence/heuristic change had to be written twice or silently drifted,
   and two-shadow mode reached the panel but never the Studio.

   This module is the single source of truth for that astronomy. It has NO DOM,
   NO `state`, and NO host integration — it takes plain inputs and returns plain
   data (structured minute windows, not pre-formatted "HH:MM" strings). Each
   caller keeps only its own rendering + host glue and formats the minutes with
   its own clock helper.

   Depends only on the global `SunCalc` and `compassAz` (from common.js), exactly
   as both former copies did. Exposes `shadowAt`/`shadowFit` as page globals too,
   because the existing browser-driven tests (tests/test_js.py) call them by bare
   name; new code should prefer the `CHRONO` namespace. */
"use strict";

const CHRONO = (function () {
  // Named thresholds — these were duplicated as bare literals in both solvers
  // and are now defined exactly once.
  const ALT_FLOOR = 0.02;   // sun altitude (rad) at/below which there is no usable shadow
  const RATIO_TOL = 0.18;   // fractional tolerance on the shadow-length ratio

  /* shadow azimuth + length ratio of the sun at minute-of-day m (local to the
     chosen UTC offset) for the given point; null when the sun is at/below the
     horizon. */
  function shadowAt(m, sd, lat, lng) {
    const d = new Date(Date.UTC(sd.Y, sd.M - 1, sd.D, 0, m) - sd.off * 3600e3);
    const pos = SunCalc.getPosition(d, lat, lng);
    if (pos.altitude <= ALT_FLOOR) return null;
    return { shAz: (compassAz(pos.azimuth) + 180) % 360, ratio: 1 / Math.tan(pos.altitude) };
  }

  /* how well a shadow (shAz, ratio) fits a target az/ratio; returns {ok, err}. */
  function shadowFit(s, azT, ratioT, tol) {
    let ok = true, err = 0;
    if (!isNaN(azT)) {
      const dAz = Math.min(Math.abs(s.shAz - azT), 360 - Math.abs(s.shAz - azT));
      if (dAz > tol) ok = false; else err += dAz;
    }
    if (ok && !isNaN(ratioT)) {
      const dR = Math.abs(s.ratio - ratioT) / ratioT;
      if (dR > RATIO_TOL) ok = false; else err += dR * 20;
    }
    return { ok, err };
  }

  /* Sweep the day, fit each candidate minute, group contiguous matches into
     windows, and score confidence. Pure: returns data only.

     input = {
       sd,                     // {Y, M, D, off} from sunDate()
       lat, lng,
       azT, ratioT, tol,       // first reading (azT/ratioT may be NaN; at least one set)
       second?: { az2, ratio2, dt2 },   // optional — enables two-shadow mode
     }
     returns {
       status: "match" | "inconsistent",
       confidence: "high" | "moderate" | "low",
       why,                    // present on both statuses
       tol, twoShadow,
       windows: [{ startMin, endMin, bestMin, shAz, ratio }],   // [] when inconsistent
     }
     Callers format startMin/endMin/bestMin with their own clock helper. */
  function solve(input) {
    const { sd, lat, lng, azT, ratioT, tol, second } = input;
    const twoShadow = !!(second && !isNaN(second.dt2) && (!isNaN(second.az2) || !isNaN(second.ratio2)));

    const matches = [];
    for (let m = 0; m < 1440; m += 2) {
      const s = shadowAt(m, sd, lat, lng);
      if (!s) continue;
      const f = shadowFit(s, azT, ratioT, tol);
      if (!f.ok) continue;
      let err = f.err;
      if (twoShadow) {
        // the second reading must also fit, dt2 minutes later, same place/date
        const s2 = shadowAt(m + second.dt2, sd, lat, lng);
        if (!s2) continue;
        const f2 = shadowFit(s2, second.az2, second.ratio2, tol);
        if (!f2.ok) continue;
        err += f2.err;
      }
      matches.push({ m, shAz: s.shAz, ratio: s.ratio, err });
    }

    if (!matches.length) {
      // A no-match is a falsification result; its strength depends on the
      // tolerance used — a tight tolerance makes the inconsistency more confident.
      const confidence = tol <= 5 ? "high" : tol <= 12 ? "moderate" : "low";
      const why = confidence === "low"
        ? "wide tolerance — weak; tighten the measurement to strengthen it"
        : "no time on this date matches at this location";
      return { status: "inconsistent", confidence, why, tol, twoShadow, windows: [] };
    }

    // group contiguous runs (a gap > 6 min starts a new window)
    const groups = [];
    let g = [matches[0]];
    for (let i = 1; i < matches.length; i++) {
      if (matches[i].m - matches[i - 1].m <= 6) g.push(matches[i]);
      else { groups.push(g); g = [matches[i]]; }
    }
    groups.push(g);

    // Confidence: total matched minutes (narrower = more precise) weighted by the
    // tolerance the analyst allowed (looser = weaker) and tightened by two-shadow.
    const totalWidth = groups.reduce((s, gr) => s + (gr[gr.length - 1].m - gr[0].m + 2), 0);
    let confidence, why;
    if (totalWidth <= 30 && tol <= 8 && groups.length === 1) { confidence = "high"; why = "single narrow window, tight tolerance"; }
    else if (totalWidth <= 90 && groups.length <= 2) { confidence = "moderate"; why = `${groups.length} window(s), ~${totalWidth} min total`; }
    else { confidence = "low"; why = `${groups.length} windows spanning ~${totalWidth} min — ambiguous`; }
    if (twoShadow && confidence !== "high") why += " (two-shadow constraint applied)";

    const windows = groups.map((gr) => {
      const best = gr.reduce((a, b) => (a.err < b.err ? a : b));
      return { startMin: gr[0].m, endMin: gr[gr.length - 1].m, bestMin: best.m, shAz: best.shAz, ratio: best.ratio };
    });
    return { status: "match", confidence, why, tol, twoShadow, windows };
  }

  return { shadowAt, shadowFit, solve };
})();

/* Legacy page globals: the existing tests/test_js.py call shadowAt/shadowFit by
   bare name, and they are cheap to keep available for any other in-page caller. */
const shadowAt = CHRONO.shadowAt;
const shadowFit = CHRONO.shadowFit;
