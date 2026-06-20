/* GeOSINT Workbench — Sun & Shadow module (split from app.js, #31).
   Classic <script>, shared global scope; loaded after common.js + core/map,
   before the app.js bootstrap. Behaviour-neutral extraction. */

/* ════════════════════════════ SUN ══════════════════════════════ */
function initSun() {
  const sel = $("#sun-offset");
  fillUtcOffsets(sel);
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $("#sun-dt").value = now.toISOString().slice(0, 16);
  $("#sun-dt").addEventListener("change", renderSun);
  sel.addEventListener("change", renderSun);
  $("#solver-run").addEventListener("click", runSolver);
}

/* fillUtcOffsets, sunDate, fmtClock, compassAz, cardinal are in common.js */

function renderSun() {
  state.sunLayer.clearLayers();
  if (!state.point) { $("#sun-cards").innerHTML = `<p class="hint">⚠ Click the map to set the active point first.</p>`; return; }
  const sd = sunDate();
  if (!sd) return;
  const { lat, lng } = state.point;
  const pos = SunCalc.getPosition(sd.date, lat, lng);
  const alt = pos.altitude * 180 / Math.PI;
  const az = compassAz(pos.azimuth);
  const shadowAz = (az + 180) % 360;
  const ratio = alt > 0.2 ? (1 / Math.tan(pos.altitude)) : null;

  $("#sun-cards").innerHTML = `
    <div class="card"><div class="v">${az.toFixed(1)}°</div><div class="k">sun azimuth (${cardinal(az)})</div></div>
    <div class="card"><div class="v">${alt.toFixed(1)}°</div><div class="k">elevation ${alt < 0 ? "(below horizon)" : ""}</div></div>
    <div class="card"><div class="v">${ratio ? ratio.toFixed(2) + "×" : "—"}</div><div class="k">shadow ÷ height</div></div>
    <div class="card"><div class="v">${shadowAz.toFixed(0)}° ${cardinal(shadowAz)}</div><div class="k">shadow points to</div></div>`;

  const times = SunCalc.getTimes(sd.date, lat, lng);
  const azOf = (t) => (t && !isNaN(t)) ? compassAz(SunCalc.getPosition(t, lat, lng).azimuth) : null;
  const rows = [
    ["Civil dawn", times.dawn], ["Sunrise", times.sunrise, azOf(times.sunrise)],
    ["Golden hour ends", times.goldenHourEnd], ["Solar noon", times.solarNoon],
    ["Golden hour starts", times.goldenHour], ["Sunset", times.sunset, azOf(times.sunset)], ["Civil dusk", times.dusk],
  ];
  $("#sun-events").innerHTML = rows.map(([k, v, azv]) =>
    `<tr><td>${k}</td><td>${fmtClock(v, sd.off)}${azv != null ? ` <span class="muted">· ${azv.toFixed(0)}° ${cardinal(azv)}</span>` : ""}</td></tr>`).join("");

  const mi = SunCalc.getMoonIllumination(sd.date);
  const phases = ["New moon","Waxing crescent","First quarter","Waxing gibbous","Full moon","Waning gibbous","Last quarter","Waning crescent"];
  const mpos = SunCalc.getMoonPosition(sd.date, lat, lng);
  $("#sun-moon").innerHTML = `
    <tr><td>Phase</td><td>${phases[Math.round(mi.phase * 8) % 8]}</td></tr>
    <tr><td>Illumination</td><td>${(mi.fraction * 100).toFixed(0)}%</td></tr>
    <tr><td>Moon altitude</td><td>${(mpos.altitude * 180 / Math.PI).toFixed(1)}°</td></tr>`;

  const p = state.point;
  if (alt > 0) {
    // current shadow direction (thick grey) + sun direction (thin gold)
    state.sunLayer.addLayer(L.polyline([p, project(p, shadowAz, 200)], { color: "#30363f", weight: 5, opacity: .85 }));
    state.sunLayer.addLayer(L.polyline([p, project(p, az, 160)], { color: "#ffd23e", weight: 2, opacity: .8, dashArray: "2 4" }));
  }
  // sunrise / sunset azimuth rays for the chosen date — for "sun on the horizon" chronolocation
  const sunAzAt = (t) => (t && !isNaN(t)) ? compassAz(SunCalc.getPosition(t, lat, lng).azimuth) : null;
  const riseAz = sunAzAt(times.sunrise), setAz = sunAzAt(times.sunset);
  const ray = (deg, color, label) => {
    const end = project(p, deg, 1500);
    state.sunLayer.addLayer(L.polyline([p, end], { color, weight: 2.5, opacity: .9 })
      .bindTooltip(`${label} ${deg.toFixed(0)}° ${cardinal(deg)}`, { permanent: false }));
  };
  if (riseAz != null) ray(riseAz, "#ff9e3d", "sunrise");
  if (setAz != null) ray(setAz, "#ff5e62", "sunset");
  drawSunChart(sd, lat, lng);

  const dstr = `${sd.Y}.${String(sd.M).padStart(2, "0")}.${String(sd.D).padStart(2, "0")}`;
  const tstr = $("#sun-dt").value.split("T")[1];
  $("#sun-links").innerHTML = `
    <a class="btn" target="_blank" href="https://www.suncalc.org/#/${lat.toFixed(5)},${lng.toFixed(5)},15/${dstr}/${tstr}/1/3">SunCalc.org ⇗</a>
    <a class="btn" target="_blank" href="https://shademap.app/@${lat.toFixed(5)},${lng.toFixed(5)},15z">ShadeMap (3-D shadows) ⇗</a>
    <a class="btn" target="_blank" href="https://www.peakfinder.com/?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}">PeakFinder horizon ⇗</a>`;
}

/* drawSunChart is in common.js (shared with the Sun Studio). The shadow solver
   itself (shadowAt / shadowFit / solve) now lives in the shared, DOM-free
   app/js/chrono.js (CHRONO) — issue #84. This module keeps only input-reading,
   rendering and case-engine integration. */

// wrap-aware HH:MM (two-shadow's m+dt2 can push a window past midnight)
function hmClock(mins) {
  const w = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}

function runSolver() {
  const out = $("#solver-out");
  if (!state.point) { out.innerHTML = `<p class="nomatch">Set the active point first.</p>`; return; }
  const azT = parseFloat($("#solver-az").value);
  const ratioT = parseFloat($("#solver-ratio").value);
  const tol = parseFloat($("#solver-tol").value) || 8;
  if (isNaN(azT) && isNaN(ratioT)) { out.innerHTML = `<p class="nomatch">Enter a shadow azimuth and/or a length ratio.</p>`; return; }
  // optional second reading taken Δ minutes after the first
  const az2 = parseFloat($("#solver-az2").value);
  const ratio2 = parseFloat($("#solver-ratio2").value);
  const dt2 = parseFloat($("#solver-dt2").value);
  const sd = sunDate();
  const { lat, lng } = state.point;

  const res = CHRONO.solve({ sd, lat, lng, azT, ratioT, tol, second: { az2, ratio2, dt2 } });
  const twoShadow = res.twoShadow;

  if (res.status === "inconsistent") {
    out.innerHTML = `<p class="nomatch">✗ <b>Claim inconsistent (${res.confidence} confidence)</b> — no time on this
      date matches at this location. ${res.confidence === "low"
        ? "Tolerance is wide, so this is weak; tighten your measurement to strengthen it."
        : "Tighten the tolerance only if you can justify a more precise reading."}</p>`;
    state.solverResult = { status: "inconsistent", confidence: res.confidence, tol, twoShadow,
      inputs: { azT, ratioT, az2, ratio2, dt2 } };
    markDirty();
    return;
  }

  const header = twoShadow
    ? `<p class="hint">Two-shadow mode: times where both readings fit (1st reading's time shown; 2nd is ${dt2 > 0 ? "+" : ""}${dt2} min later).</p>`
    : "";
  const windowsHtml = res.windows.map((w) =>
    `<div class="match">✓ ${hmClock(w.startMin)}–${hmClock(w.endMin)} local
      (best ${hmClock(w.bestMin)} · shadow→${w.shAz.toFixed(0)}° · ${w.ratio.toFixed(2)}×)</div>`).join("");
  out.innerHTML = header + windowsHtml +
    `<div class="solver-conf conf-${res.confidence}">Confidence: <b>${res.confidence}</b> — ${res.why} (tolerance ±${tol}°).</div>`;

  // Persist the latest result so the dossier can state the chronolocation finding.
  state.solverResult = {
    status: "match", confidence: res.confidence, why: res.why, tol, twoShadow,
    windows: res.windows.map((w) => `${hmClock(w.startMin)}–${hmClock(w.endMin)}`),
    inputs: { azT, ratioT, az2, ratio2, dt2 },
  };
  markDirty();
}

