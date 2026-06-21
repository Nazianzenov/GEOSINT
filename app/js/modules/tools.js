/* GeOSINT Workbench — Tools launcher module (#85: IIFE + App facade).
   Self-contained module (window.Tools) talking to the App facade instead of free
   globals. Exposes Tools.list (the catalogue) + Tools.launch(t) so the command
   palette can read the catalogue through a named surface instead of a bare TOOLS
   global. Behaviour-neutral. renderTools re-exported on window for the re-render
   hooks (core.js / map.js / app.js). */
"use strict";

window.Tools = (function () {

  /* ═══════════════════════════ TOOLS ═════════════════════════════ */
  /* Each url() gets (lat, lng, zoom). homepage-only tools omit url(). */
  const TOOLS = [
    { g: "Imagery & 3-D", name: "Google Earth (web)", desc: "3-D globe, historical imagery slider",
      url: (a, o) => `https://earth.google.com/web/@${a},${o},0a,3000d,35y,0h,0t,0r` },
    { g: "Imagery & 3-D", name: "Google Earth Pro", desc: "desktop — best historical imagery; flies there via KML", desktop: true },
    { g: "Imagery & 3-D", name: "Esri Wayback", desc: "time machine of past satellite basemaps",
      url: (a, o, z) => `https://livingatlas.arcgis.com/wayback/#mapCenter=${o}%2C${a}%2C${Math.min(z, 17)}` },
    { g: "Imagery & 3-D", name: "Sentinel EO Browser", desc: "fresh Sentinel-2 imagery, NDVI, custom bands",
      url: (a, o, z) => `https://apps.sentinel-hub.com/eo-browser/?lat=${a}&lng=${o}&zoom=${Math.min(z, 16)}` },
    { g: "Imagery & 3-D", name: "Copernicus Browser", desc: "ESA Sentinel data, full archive",
      url: (a, o, z) => `https://browser.dataspace.copernicus.eu/?zoom=${Math.min(z, 16)}&lat=${a}&lng=${o}` },
    { g: "Imagery & 3-D", name: "NASA Worldview", desc: "daily MODIS/VIIRS — fires, smoke, storms by date",
      url: (a, o) => `https://worldview.earthdata.nasa.gov/?v=${(+o - 4).toFixed(2)},${(+a - 3).toFixed(2)},${(+o + 4).toFixed(2)},${(+a + 3).toFixed(2)}` },
    { g: "Imagery & 3-D", name: "Zoom Earth", desc: "near-live satellite + historical daily archive",
      url: (a, o, z) => `https://zoom.earth/#view=${a},${o},${Math.min(z, 18)}z` },

    { g: "Street-level", name: "Google Street View", desc: "drops you into pano at active point",
      url: (a, o) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${a},${o}` },
    { g: "Street-level", name: "Mapillary", desc: "crowdsourced street photos — covers where Google doesn't",
      url: (a, o, z) => `https://www.mapillary.com/app/?lat=${a}&lng=${o}&z=${z}` },
    { g: "Street-level", name: "KartaView", desc: "open street-level imagery (ex-OpenStreetCam)",
      url: (a, o, z) => `https://kartaview.org/map/@${a},${o},${z}z` },
    { g: "Street-level", name: "Yandex Panoramas", desc: "best street coverage in ex-USSR",
      url: (a, o, z) => `https://yandex.com/maps/?ll=${o},${a}&z=${z}&l=stv,sta` },
    { g: "Street-level", name: "Mapy.com (Czech)", desc: "excellent European panoramas + hiking maps",
      url: (a, o, z) => `https://mapy.com/en/turisticka?x=${o}&y=${a}&z=${z}` },
    { g: "Street-level", name: "Baidu Maps", desc: "China street view (Total View) — use for PRC",
      url: (a, o) => `https://map.baidu.com/?latlng=${a},${o}` },

    { g: "Maps & data", name: "Google Maps", desc: "reference map + business data",
      url: (a, o, z) => `https://www.google.com/maps/@${a},${o},${z}z` },
    { g: "Maps & data", name: "Bing Maps", desc: "Bird's Eye oblique aerials (US/EU cities)",
      url: (a, o, z) => `https://www.bing.com/maps?cp=${a}~${o}&lvl=${z}&style=h` },
    { g: "Maps & data", name: "Yandex Maps", desc: "superior detail in Russia/CIS",
      url: (a, o, z) => `https://yandex.com/maps/?ll=${o},${a}&z=${z}` },
    { g: "Maps & data", name: "OpenStreetMap", desc: "raw OSM — query individual mapped objects",
      url: (a, o, z) => `https://www.openstreetmap.org/#map=${z}/${a}/${o}` },
    { g: "Maps & data", name: "Overpass Turbo", desc: "query OSM: 'all churches near rail within 500 m'",
      url: (a, o, z) => `https://overpass-turbo.eu/?C=${a};${o};${z}` },
    { g: "Maps & data", name: "Bellingcat OSM Search", desc: "find places matching feature combinations" ,
      url: () => `https://osm-search.bellingcat.com/` },
    { g: "Maps & data", name: "OpenInfraMap", desc: "power lines, substations, telecom, pipelines",
      url: (a, o, z) => `https://openinframap.org/#${z}/${a}/${o}` },
    { g: "Maps & data", name: "OpenRailwayMap", desc: "rail lines, gauges, electrification — great clue source",
      url: (a, o, z) => `https://www.openrailwaymap.org/?lat=${a}&lon=${o}&zoom=${z}` },
    { g: "Maps & data", name: "Wikimapia", desc: "user-annotated places incl. industrial/military",
      url: (a, o, z) => `https://wikimapia.org/#lang=en&lat=${a}&lon=${o}&z=${z}` },
    { g: "Maps & data", name: "F4map 3-D", desc: "3-D buildings from OSM data",
      url: (a, o, z) => `https://demo.f4map.com/#lat=${a}&lon=${o}&zoom=${z}` },
    { g: "Maps & data", name: "what3words", desc: "convert w3w addresses seen in posts",
      url: (a, o, z) => `https://what3words.com/?maptype=satellite&zoom=${z}&center=${a},${o}` },

    { g: "Terrain & horizon", name: "PeakVisor", desc: "match mountain skylines to ID location",
      url: (a, o) => `https://peakvisor.com/panorama.html?lat=${a}&lng=${o}` },
    { g: "Terrain & horizon", name: "PeakFinder", desc: "rendered horizon from any point",
      url: (a, o) => `https://www.peakfinder.com/?lat=${a}&lng=${o}` },
    { g: "Terrain & horizon", name: "Topographic-map.com", desc: "elevation shading & contours",
      url: (a, o) => `https://en-gb.topographic-map.com/?center=${a}%2C${o}` },
    { g: "Terrain & horizon", name: "ShadeMap", desc: "terrain+building shadows at any date/time",
      url: (a, o, z) => `https://shademap.app/@${a},${o},${Math.min(z, 18)}z` },

    { g: "Weather & environment", name: "Ventusky", desc: "weather model maps incl. past dates",
      url: (a, o, z) => `https://www.ventusky.com/?p=${a};${o};${Math.min(z, 11)}` },
    { g: "Weather & environment", name: "Windy", desc: "wind/cloud/webcams — webcams are an OSINT gem",
      url: (a, o) => `https://www.windy.com/${a}/${o}` },
    { g: "Weather & environment", name: "earth.nullschool", desc: "global wind/ocean currents visual",
      url: (a, o) => `https://earth.nullschool.net/#current/wind/surface/level/orthographic=${o},${a},1024` },

    { g: "Transport trackers", name: "Flightradar24", desc: "live + historical aircraft (contrails in photos!)",
      url: (a, o, z) => `https://www.flightradar24.com/${(+a).toFixed(2)},${(+o).toFixed(2)}/${Math.min(z, 12)}` },
    { g: "Transport trackers", name: "MarineTraffic", desc: "ship positions — ID vessels in harbour shots",
      url: (a, o, z) => `https://www.marinetraffic.com/en/ais/home/centerx:${(+o).toFixed(2)}/centery:${(+a).toFixed(2)}/zoom:${Math.min(z, 14)}` },

    { g: "AI geolocation (uploads leave your machine!)", name: "GeoSpy", desc: "AI photo geolocation — closed, commercial", caution: true,
      url: () => `https://geospy.ai/` },
    { g: "AI geolocation (uploads leave your machine!)", name: "Picarta", desc: "AI photo geolocation — free tier", caution: true,
      url: () => `https://picarta.ai/` },
  ];

  /* Local desktop tools (detected by the server) shown above the web tools.
     ExifTool is CLI-only: it powers the deep dump in the Image module. */
  const LOCAL_TOOL_DESC = {
    exiftool: "powers the FULL METADATA dump in the Image module",
    google_earth_pro: "flies to the active point via KML (see Imagery group)",
    qgis: "professional GIS — load rasters, georeference photos",
    sherloq: "open-source image forensics (ELA, clone detection, noise)",
  };

  function renderLocalTools() {
    const t = App.state.tools;
    if (!t) return "";
    return `<div class="tool-group"><h3>Local desktop tools (this computer)</h3>
      ${Object.entries(t).map(([key, st]) => {
        const launchable = st.found && st.kind === "gui" && key !== "google_earth_pro";
        return `<div class="tool-item ${st.found ? "" : "disabled"}" data-local="${launchable ? key : ""}">
          <span class="t-name">${st.label}</span>
          <span class="tag desktop">${st.found ? "✓ INSTALLED" : "MISSING"}</span>
          <span class="t-desc">${st.found
            ? (LOCAL_TOOL_DESC[key] || st.path)
            : `install: <code>${st.install}</code>`}</span>
          ${launchable ? `<span class="t-go">▶</span>` : ""}</div>`;
      }).join("")}</div>`;
  }

  function renderTools() {
    const wrap = $("#tools-list");
    const p = App.state.point;
    const groups = [...new Set(TOOLS.map((t) => t.g))];
    wrap.innerHTML = renderLocalTools() + groups.map((g) => `
      <div class="tool-group"><h3>${g}</h3>
      ${TOOLS.filter((t) => t.g === g).map((t) => {
        const idx = TOOLS.indexOf(t);
        const needsPt = !!t.url && t.url.length > 0;
        const dis = (needsPt || t.desktop) && !p;
        return `<div class="tool-item ${dis ? "disabled" : ""}" data-idx="${idx}"${
          dis ? ` title="Set an active point first — click the map"` : ""}>
          <span class="t-name">${t.name}</span>
          ${t.desktop ? `<span class="tag desktop">DESKTOP</span>` : ""}
          ${t.caution ? `<span class="tag caution">UPLOADS</span>` : ""}
          <span class="t-desc">${t.desc}</span><span class="t-go">⇗</span></div>`;
      }).join("")}</div>`).join("");
    wrap.querySelectorAll(".tool-item:not(.disabled)[data-idx]").forEach((el) => {
      el.addEventListener("click", () => launch(TOOLS[+el.dataset.idx]));
    });
    // a disabled tool row explains why instead of doing nothing
    wrap.querySelectorAll(".tool-item.disabled[data-idx]").forEach((el) => {
      el.addEventListener("click", () => App.status(NO_POINT_MSG, true));
    });
    wrap.querySelectorAll("[data-local]").forEach((el) => {
      const key = el.dataset.local;
      if (key) el.addEventListener("click", () => launchLocal(key));
    });
  }

  async function launchLocal(key) {
    try {
      const r = await App.fetchT("/api/launch", {
        method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
        body: JSON.stringify({ tool: key }),
      });
      const j = await r.json();
      App.status(j.error ? j.error : `${key} launching…`, !!j.error, 8000);
    } catch { App.status("local server unreachable", true); }
  }

  async function launch(t) {
    const p = App.state.point, z = App.map.getZoom();
    if (t.desktop) {
      if (!p) return App.status(NO_POINT_MSG, true);
      try {
        const r = await App.fetchT("/api/flyto", {
          method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
          body: JSON.stringify({ lat: p.lat, lng: p.lng, name: App.fmtDD(p) }),
        });
        const j = await r.json();
        if (j.error) App.status(j.error, true, 8000);
        else App.status("Google Earth Pro launching…");
      } catch { App.status("local server unreachable", true); }
      return;
    }
    if (!t.url) return;
    const needsPt = t.url.length > 0;
    if (needsPt && !p) return App.status(NO_POINT_MSG, true);
    window.open(needsPt ? t.url(p.lat.toFixed(5), p.lng.toFixed(5), z) : t.url(), "_blank");
  }

  return { list: TOOLS, renderTools, launch };
})();

/* Cross-file entry point kept on window (core.js / map.js / app.js re-render the
   tools list on point/status change). The catalogue + launcher are read by the
   command palette through Tools.list / Tools.launch — no bare TOOLS global. */
window.renderTools = Tools.renderTools;
