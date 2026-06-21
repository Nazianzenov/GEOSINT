/* GeOSINT Workbench — OSM Data-layer presets (config, split from data.js #87).
   Pure configuration lifted out of the behaviour code so the Data panel reads as
   wiring, not a 40-line table. Kept as a plain const (not fetched JSON): there is
   no second reader (the Python indexer derives its categories from Wikidata
   SPARQL, not these OSM selectors), and a const has no offline/404 failure mode
   that a fetch would add. Exposed as window.DataPresets for the data modules. */
"use strict";

/* OSM feature presets — exact-match selectors only (regex selectors are an
   order of magnitude slower on Overpass). minZoom guards dense categories. */
const OSM_PRESETS = [
  ["Mines & quarries", ['nwr["man_made"="mineshaft"]', 'nwr["man_made"="adit"]',
    'way["landuse"="quarry"]', 'nwr["historic"="mine"]'], 8],
  ["Hospitals & clinics", ['nwr["amenity"="hospital"]', 'nwr["amenity"="clinic"]'], 10],
  ["Power plants & substations", ['nwr["power"="plant"]', 'nwr["power"="substation"]'], 9],
  ["Wind turbines", ['nwr["generator:source"="wind"]'], 8],
  ["Fuel stations", ['nwr["amenity"="fuel"]'], 11],
  ["Railway stations", ['node["railway"="station"]'], 9],
  ["Places of worship", ['nwr["amenity"="place_of_worship"]'], 12],
  ["Towers & masts", ['nwr["man_made"="tower"]', 'nwr["man_made"="mast"]',
    'nwr["man_made"="communications_tower"]'], 11],
  ["Airfields & helipads", ['nwr["aeroway"="aerodrome"]', 'nwr["aeroway"="helipad"]'], 8],
  ["Military areas", ['way["landuse"="military"]', 'nwr["military"="base"]',
    'nwr["military"="barracks"]'], 8],
  ["Water towers", ['nwr["man_made"="water_tower"]'], 9],
  ["Lighthouses", ['nwr["man_made"="lighthouse"]'], 6],
  // border crossings & checkpoints (movement/conflict/migration analysis)
  ["Border crossings & checkpoints", ['nwr["barrier"="border_control"]',
    'nwr["amenity"="customs"]', 'nwr["barrier"="checkpoint"]'], 7],
  // extra investigative categories
  ["Prisons & detention", ['nwr["amenity"="prison"]'], 8],
  ["Embassies & consulates", ['nwr["diplomatic"="embassy"]',
    'nwr["diplomatic"="consulate"]', 'nwr["office"="diplomatic"]'], 9],
  ["Ports & harbours", ['nwr["industrial"="port"]', 'way["landuse"="port"]',
    'nwr["harbour"="yes"]', 'nwr["amenity"="ferry_terminal"]'], 7],
  // helipads alone (the "Airfields & helipads" preset bundles them with aerodromes;
  // a helipad-only view isolates rooftop/hospital/rig pads)
  ["Helipads", ['nwr["aeroway"="helipad"]'], 10],
  // cellular/radio infrastructure (corroborate a location from network
  // metadata; map comms infra for CTI). Distinct from "Towers & masts": this
  // filters to mobile-phone / telecom-tagged structures, not water/observation
  // towers. communication:mobile_phone=yes is the OSM convention for cell sites.
  ["Cell towers & radio masts", ['nwr["communication:mobile_phone"="yes"]',
    'nwr["man_made"="mast"]["tower:type"="communication"]',
    'nwr["man_made"="communications_tower"]', 'nwr["telecom"="data_center"]'], 11],
  // IXPs via OSM (not PeeringDB — data-reuse terms unstated; see ROADMAP 5D).
  ["Internet exchange points", ['nwr["telecom"="exchange"]',
    'nwr["telecom"="data_center"]'], 8],
];

window.DataPresets = OSM_PRESETS;
