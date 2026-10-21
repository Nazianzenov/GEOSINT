/* GeOSINT Workbench — submarine-cable overlay (split from data.js #87).
   A global overlay (cable routes + landing points) from a self-contained GeoJSON
   copy in app/data/; toggled on/off and handed to QGIS. Data fetched once and
   cached on state. Self-contained IIFE; toggle/toQgis re-exported on window. */
"use strict";

window.Cables = (function () {

  /* submarine cables & landing points (TeleGeography, CC BY-NC-SA 3.0).
     The data is fetched once and cached on state. */
  async function load() {
    const st = App.state;
    if (st.cables) return st.cables;
    const r = await App.fetchT("/app/data/submarine-cables.json");
    if (!r.ok) throw new Error("cable data not built — run the dataset fetcher + index build");
    st.cables = await r.json();
    return st.cables;
  }

  async function toggle() {
    const st = App.state, map = App.map;
    const btn = $("#cables-toggle");
    if (st.cablesShown) {                            // hide
      st.cableLayer.clearLayers();
      st.cablesShown = false;
      btn.textContent = "⎋ SHOW CABLES";
      btn.classList.remove("accent");
      $("#cables-status").textContent = "";
      return;
    }
    $("#cables-status").textContent = "loading cable map…";
    try {
      const d = await load();
      st.cableLayer.clearLayers();
      // cable routes (MultiLineString) — GeoJSON is [lng,lat]; Leaflet wants [lat,lng].
      L.geoJSON(d.cables, {
        style: (f) => ({ color: f.properties.color || "#4cc2ff", weight: 1.5, opacity: 0.75 }),
        onEachFeature: (f, lyr) => lyr.bindPopup(
          `<b>${App.esc(f.properties.name || "cable")}</b><br>submarine cable` +
          `<br><span class="muted">© TeleGeography · CC BY-NC-SA 3.0</span>`),
      }).addTo(st.cableLayer);
      // landing points
      for (const lp of d.landings.features) {
        const [lng, lat] = lp.geometry.coordinates;
        const lname = lp.properties.name || "landing point";
        L.circleMarker([lat, lng], {
          radius: 1.5, color: "#ffd23e", fillColor: "#ffd23e", fillOpacity: 0.9, weight: 1,
        }).bindPopup(() => setPointPopup(lname, "cable landing point", lat, lng))
          .addTo(st.cableLayer);
      }
      st.cablesShown = true;
      btn.textContent = "⎋ HIDE CABLES";
      btn.classList.add("accent");
      const nc = d.cables.features.length, nl = d.landings.features.length;
      $("#cables-status").textContent = `${nc} cables · ${nl} landing points · © TeleGeography (CC BY-NC-SA 3.0)`;
      App.status(`submarine cables overlaid (${nc} cables)`);
    } catch (err) {
      $("#cables-status").textContent = `✗ ${err.message}`;
      App.status(err.message, true, 8000);
    }
  }

  /* Hand the cable routes + landing points to QGIS as a GeoJSON layer. */
  async function toQgis() {
    try {
      const d = await load();
      const features = [...d.cables.features, ...d.landings.features];
      const r = await App.fetchT("/api/qgis", {
        method: "POST", headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
        body: JSON.stringify({ geojson: { type: "FeatureCollection", features }, name: "submarine-cables" }),
      });
      const j = await r.json();
      App.status(j.error ? j.error : `QGIS opening with ${j.features} cable feature(s)…`, !!j.error, 8000);
    } catch (err) { App.status(err.message || "local server unreachable", true); }
  }

  return { toggle, toQgis };
})();
