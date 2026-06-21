/* GeOSINT Workbench — Weather module (#85: IIFE + App facade).
   Self-contained module (window.Weather) talking to the App facade instead of
   free globals. Stateless helpers (cardinal — common.js) stay bare; the shared
   state spine and side-effecting app actions go through App. Behaviour-neutral.
   initWeather re-exported on window for the app.js bootstrap. */
"use strict";

window.Weather = (function () {

  /* ══════════════════════════ WEATHER ════════════════════════════ */
  const WMO = {
    0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Rime fog",
    51:"Light drizzle",53:"Drizzle",55:"Dense drizzle",56:"Freezing drizzle",57:"Freezing drizzle",
    61:"Light rain",63:"Rain",65:"Heavy rain",66:"Freezing rain",67:"Freezing rain",
    71:"Light snow",73:"Snow",75:"Heavy snow",77:"Snow grains",
    80:"Rain showers",81:"Rain showers",82:"Violent showers",85:"Snow showers",86:"Snow showers",
    95:"Thunderstorm",96:"Thunderstorm w/ hail",99:"Thunderstorm w/ hail" };

  function initWeather() {
    $("#wx-date").value = new Date().toISOString().slice(0, 10);
    $("#wx-fetch").addEventListener("click", fetchWeather);
    // Wind/weather-map launchers — these read the weather panel's own inputs
    // (#wx-wind-layer / #wx-date), so they live here, not in the Data module (#87).
    $("#wx-windy").addEventListener("click", () => openWindMap("windy"));
    $("#wx-nullschool").addEventListener("click", () => openWindMap("nullschool"));
  }

  async function fetchWeather() {
    const st = App.state;
    if (!st.point) { App.status("set the active point first", true); return; }
    const date = $("#wx-date").value;
    if (!date) return;
    const { lat, lng } = st.point;
    const ageDays = (Date.now() - new Date(date)) / 864e5;
    const base = ageDays > 6
      ? "https://archive-api.open-meteo.com/v1/archive"
      : "https://api.open-meteo.com/v1/forecast";
    const hourly = "temperature_2m,relative_humidity_2m,precipitation,snowfall,snow_depth,cloud_cover,wind_speed_10m,wind_direction_10m,weather_code";
    const url = `${base}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${date}&end_date=${date}&hourly=${hourly}&timezone=auto`;
    $("#wx-meta").textContent = "fetching…";
    try {
      const r = await App.cachedFetch(url);
      const j = await r.json();
      if (j.error) throw new Error(j.reason);
      renderWeather(j, date, ageDays > 6, App.cacheNote(r));
    } catch (err) {
      $("#wx-meta").textContent = "";
      $("#wx-cards").innerHTML = `<p class="nomatch">✗ ${err.message || "Open-Meteo unreachable (offline?)"}</p>`;
    }
  }

  function renderWeather(j, date, isArchive, note = "") {
    const h = j.hourly;
    const n = h.time.length;
    const nums = (a) => a.filter((x) => x != null);
    const tmax = Math.max(...nums(h.temperature_2m)), tmin = Math.min(...nums(h.temperature_2m));
    const precip = nums(h.precipitation).reduce((a, b) => a + b, 0);
    const snowMax = Math.max(0, ...nums(h.snow_depth));
    const cloudAvg = nums(h.cloud_cover).reduce((a, b) => a + b, 0) / Math.max(1, nums(h.cloud_cover).length);
    const windMax = Math.max(...nums(h.wind_speed_10m));
    $("#wx-meta").textContent =
      `${date} · ${j.timezone} (UTC${j.utc_offset_seconds >= 0 ? "+" : ""}${j.utc_offset_seconds / 3600}) · ` +
      `${isArchive ? "ERA5 reanalysis archive" : "forecast model (recent date)"} · elevation ${j.elevation} m` + note;
    $("#wx-cards").innerHTML = `
      <div class="card"><div class="v">${tmin.toFixed(0)}…${tmax.toFixed(0)}°C</div><div class="k">temperature</div></div>
      <div class="card"><div class="v">${precip.toFixed(1)} mm</div><div class="k">precipitation</div></div>
      <div class="card"><div class="v">${cloudAvg.toFixed(0)}%</div><div class="k">avg cloud cover</div></div>
      <div class="card"><div class="v">${snowMax > 0.005 ? (snowMax * 100).toFixed(0) + " cm" : "none"}</div><div class="k">snow depth</div></div>
      <div class="card"><div class="v">${windMax.toFixed(0)} km/h</div><div class="k">max wind</div></div>`;
    let rows = `<tr><th>local</th><th>°C</th><th>cloud%</th><th>precip</th><th>snow cm</th><th>wind</th><th>sky</th></tr>`;
    for (let i = 0; i < n; i++) {
      rows += `<tr><td>${h.time[i].slice(11)}</td><td>${h.temperature_2m[i] ?? "—"}</td>
        <td>${h.cloud_cover[i] ?? "—"}</td><td>${h.precipitation[i] ?? "—"}</td>
        <td>${h.snow_depth[i] != null ? (h.snow_depth[i] * 100).toFixed(0) : "—"}</td>
        <td>${h.wind_speed_10m[i] ?? "—"} ${h.wind_direction_10m[i] != null ? cardinal(h.wind_direction_10m[i]) : ""}</td>
        <td style="text-align:left">${WMO[h.weather_code[i]] ?? h.weather_code[i] ?? "—"}</td></tr>`;
    }
    $("#wx-table").innerHTML = rows;
    const { lat, lng } = App.state.point;
    const ymd = date.replaceAll("-", "");
    $("#wx-links").innerHTML = `
      <a class="btn" target="_blank" href="https://www.ventusky.com/?p=${lat.toFixed(3)};${lng.toFixed(3)};8&l=clouds-total&t=${ymd}/1200">Ventusky ⇗</a>
      <a class="btn" target="_blank" href="https://zoom.earth/maps/satellite/#view=${lat.toFixed(3)},${lng.toFixed(3)},8z/date=${date},12:00,+0">Zoom Earth (sat archive) ⇗</a>
      <a class="btn" target="_blank" href="https://worldview.earthdata.nasa.gov/?v=${(lng - 4).toFixed(2)},${(lat - 3).toFixed(2)},${(lng + 4).toFixed(2)},${(lat + 3).toFixed(2)}&t=${date}">NASA Worldview ⇗</a>
      <a class="btn" target="_blank" href="https://www.windy.com/${lat.toFixed(3)}/${lng.toFixed(3)}">Windy ⇗</a>`;
  }

  // Wind/weather maps open on their own sites (the embedded iframe was unstable —
  // Windy's player crashes on fast timeline scrubbing). For an area, the active
  // point is the Nominatim centroid. Windy accepts a UTC YYYY-MM-DD-HH time hash.
  function openWindMap(site) {
    const st = App.state;
    const p = st.point || st.map.getCenter();
    const lat = p.lat.toFixed(3), lon = p.lng.toFixed(3);
    if (site === "nullschool") {                       // current conditions only
      window.open(`https://earth.nullschool.net/#current/wind/surface/level/orthographic=${lon},${lat},2000`, "_blank");
      return;
    }
    const overlay = $("#wx-wind-layer").value || "wind";
    const d = $("#wx-date").value;                      // YYYY-MM-DD from the weather panel
    // Windy URL: ?overlay,YYYY-MM-DD-HH,lat,lon,zoom (UTC; midday on the chosen date)
    const t = d ? `${d}-12,` : "";
    window.open(`https://www.windy.com/?${overlay},${t}${lat},${lon},6`, "_blank");
  }

  return { initWeather };
})();

/* Cross-file entry point kept on window (app.js bootstrap calls initWeather). */
window.initWeather = Weather.initWeather;
