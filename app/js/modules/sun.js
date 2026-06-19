/* GeOSINT Workbench — Sun & Shadow module (split from app.js, #31).
   Classic <script>, shared global scope; loaded after common.js + core/map,
   before the app.js bootstrap. Behaviour-neutral extraction. */

/* ════════════════════════════ SUN ══════════════════════════════ */
function initSun() {
  const sel = $("#sun-offset");
  for (let q = -48; q <= 56; q++) {           // -12:00 .. +14:00 in 15-min steps
    const o = q / 4;
    const sign = o < 0 ? "-" : "+";
    const h = Math.floor(Math.abs(o)), mm = String(Math.round((Math.abs(o) % 1) * 60)).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = o; opt.textContent = `UTC${sign}${String(h).padStart(2, "0")}:${mm}`;
    sel.appendChild(opt);
  }
  sel.value = -(new Date().getTimezoneOffset()) / 60;
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $("#sun-dt").value = now.toISOString().slice(0, 16);
  $("#sun-dt").addEventListener("change", renderSun);
  sel.addEventListener("change", renderSun);
  $("#solver-run").addEventListener("click", runSolver);
}

/* Date from the datetime-local string interpreted at the chosen UTC offset */
function sunDate() {
  const v = $("#sun-dt").value;
  if (!v) return null;
  const off = parseFloat($("#sun-offset").value);
  const [d, tm] = v.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = tm.split(":").map(Number);
  return { date: new Date(Date.UTC(Y, M - 1, D, h, mi) - off * 3600e3), off, Y, M, D };
}
const fmtClock = (date, off) => {
  if (!date || isNaN(date)) return "—";
  const t = new Date(date.getTime() + off * 3600e3);
  return t.toISOString().slice(11, 16);
};
/* compassAz + cardinal are in common.js */

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

/* drawSunChart is in common.js (shared with the Sun Studio) */

/* shadow azimuth + length ratio of the sun at minute-of-day m (local to the
   chosen UTC offset) for the active point; null when the sun is at/below horizon */
function shadowAt(m, sd, lat, lng) {
  const d = new Date(Date.UTC(sd.Y, sd.M - 1, sd.D, 0, m) - sd.off * 3600e3);
  const pos = SunCalc.getPosition(d, lat, lng);
  if (pos.altitude <= 0.02) return null;
  return { shAz: (compassAz(pos.azimuth) + 180) % 360, ratio: 1 / Math.tan(pos.altitude) };
}

/* how well a shadow (shAz, ratio) fits target az/ratio; returns {ok, err} */
function shadowFit(s, azT, ratioT, tol) {
  let ok = true, err = 0;
  if (!isNaN(azT)) {
    const dAz = Math.min(Math.abs(s.shAz - azT), 360 - Math.abs(s.shAz - azT));
    if (dAz > tol) ok = false; else err += dAz;
  }
  if (ok && !isNaN(ratioT)) {
    const dR = Math.abs(s.ratio - ratioT) / ratioT;
    if (dR > 0.18) ok = false; else err += dR * 20;
  }
  return { ok, err };
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
  const twoShadow = !isNaN(dt2) && (!isNaN(az2) || !isNaN(ratio2));
  const sd = sunDate();
  const { lat, lng } = state.point;
  const matches = [];
  for (let m = 0; m < 1440; m += 2) {
    const s = shadowAt(m, sd, lat, lng);
    if (!s) continue;
    const f = shadowFit(s, azT, ratioT, tol);
    if (!f.ok) continue;
    let err = f.err;
    const shAz = s.shAz, ratio = s.ratio;
    if (twoShadow) {
      // the second reading must also fit, Δ minutes later, at the same place/date
      const s2 = shadowAt(m + dt2, sd, lat, lng);
      if (!s2) continue;
      const f2 = shadowFit(s2, az2, ratio2, tol);
      if (!f2.ok) continue;
      err += f2.err;
    }
    matches.push({ m, shAz, ratio, err });
  }
  if (!matches.length) {
    // A no-match is a falsification result; its strength depends on the tolerance
    // used — a tight tolerance makes the inconsistency more confident.
    const conf = tol <= 5 ? "high" : tol <= 12 ? "moderate" : "low";
    out.innerHTML = `<p class="nomatch">✗ <b>Claim inconsistent (${conf} confidence)</b> — no time on this
      date matches at this location. ${conf === "low"
        ? "Tolerance is wide, so this is weak; tighten your measurement to strengthen it."
        : "Tighten the tolerance only if you can justify a more precise reading."}</p>`;
    state.solverResult = { status: "inconsistent", confidence: conf, tol, twoShadow,
      inputs: { azT, ratioT, az2, ratio2, dt2 } };
    markDirty();
    return;
  }
  // group contiguous runs, report each window
  const groups = [];
  let g = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].m - matches[i - 1].m <= 6) g.push(matches[i]);
    else { groups.push(g); g = [matches[i]]; }
  }
  groups.push(g);
  const hm = (mins) => `${String(Math.floor(((mins % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((mins % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;

  // Confidence: total matched minutes (narrower = more precise) weighted by the
  // tolerance the analyst allowed (looser tolerance = weaker claim) and tightened
  // by two-shadow mode. Reported alongside the windows and carried to the dossier.
  const totalWidth = groups.reduce((s, gr) => s + (gr[gr.length - 1].m - gr[0].m + 2), 0);
  let conf, why;
  if (totalWidth <= 30 && tol <= 8 && groups.length === 1) { conf = "high"; why = "single narrow window, tight tolerance"; }
  else if (totalWidth <= 90 && groups.length <= 2) { conf = "moderate"; why = `${groups.length} window(s), ~${totalWidth} min total`; }
  else { conf = "low"; why = `${groups.length} windows spanning ~${totalWidth} min — ambiguous`; }
  if (twoShadow && conf !== "high") why += " (two-shadow constraint applied)";

  const header = twoShadow
    ? `<p class="hint">Two-shadow mode: times where both readings fit (1st reading's time shown; 2nd is ${dt2 > 0 ? "+" : ""}${dt2} min later).</p>`
    : "";
  const windowsHtml = groups.map((gr) => {
    const best = gr.reduce((a, b) => (a.err < b.err ? a : b));
    return `<div class="match">✓ ${hm(gr[0].m)}–${hm(gr[gr.length - 1].m)} local
      (best ${hm(best.m)} · shadow→${best.shAz.toFixed(0)}° · ${best.ratio.toFixed(2)}×)</div>`;
  }).join("");
  out.innerHTML = header + windowsHtml +
    `<div class="solver-conf conf-${conf}">Confidence: <b>${conf}</b> — ${why} (tolerance ±${tol}°).</div>`;

  // Persist the latest result so the dossier can state the chronolocation finding.
  state.solverResult = {
    status: "match", confidence: conf, why, tol, twoShadow,
    windows: groups.map((gr) => `${hm(gr[0].m)}–${hm(gr[gr.length - 1].m)}`),
    inputs: { azT, ratioT, az2, ratio2, dt2 },
  };
  markDirty();
}

