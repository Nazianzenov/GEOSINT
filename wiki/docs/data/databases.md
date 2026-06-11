# Coordinate databases — catalogue

Free / openly-licensed (or explicitly non-commercial-friendly) databases of
**geo-located things**. For the categories with live map support, use the Workbench's
**Data layers module** (rail ⛏), which queries OpenStreetMap and plots results on the map.

## Mining & industry

| Database | Coverage | Access |
|---|---|---|
| [USGS MRDS](https://mrdata.usgs.gov/mrds/) | **Worldwide mineral deposits & mines** (~300k records, coordinates, commodity) | Public domain; CSV/KML download, search UI |
| [IRIS Austria](https://www.geologie.ac.at/services/webapplikationen/iris-interaktives-rohstoffinformationssystem) | **All Austrian mineral occurrences & mines** — GeoSphere Austria's interactive raw-materials system | Free web map; the authoritative source for *mines in Austria* |
| [Global Energy Monitor](https://globalenergymonitor.org/projects/) | Coal/gas/steel plants, **coal mines** (Global Coal Mine Tracker), terminals — geolocated | Free for non-commercial use (CC BY-NC) |
| OpenStreetMap via [Overpass](https://overpass-turbo.eu/) | `man_made=mineshaft`, `landuse=quarry`, `historic=mine` anywhere | ODbL; wired into the Data layers module |
| [OpenInfraMap](https://openinframap.org/) | Power lines, substations, telecom, pipelines (OSM-derived) | ODbL |

## Health, transport, infrastructure

| Database | Coverage | Access |
|---|---|---|
| [healthsites.io](https://healthsites.io/) | Hospitals/clinics worldwide (OSM-synced) | ODbL, API + downloads |
| [OurAirports](https://ourairports.com/data/) | ~80k airports with idents & runways | **Public domain** CSV — large+medium airports are in the smart search |
| [OpenFlights](https://openflights.org/data.php) | Airports + airline routes | ODbL |
| [OpenRailwayMap](https://www.openrailwaymap.org/) | Rail lines, gauges, electrification | ODbL |
| [MarineTraffic](https://www.marinetraffic.com/) / [AISHub](https://www.aishub.net/) | Ship positions | Free tiers |
| [Global Power Plant DB (WRI)](https://datasets.wri.org/dataset/globalpowerplantdatabase) | ~35k power plants, fuel, capacity, coords | CC BY 4.0 |

## Places, boundaries, names

| Database | Coverage | Access |
|---|---|---|
| [GeoNames](https://www.geonames.org/export/) | 11M+ placenames, full dump | CC BY |
| [Natural Earth](https://www.naturalearthdata.com/) | Country/admin boundaries, rivers, cities at 3 scales | Public domain |
| [Wikidata](https://query.wikidata.org/) | Anything with a coordinate (P625) — SPARQL | CC0 — powers the UNESCO/parks/castles datasets here |
| [Protected Planet (WDPA)](https://www.protectedplanet.net/) | All protected areas incl. national parks, polygons | Free for non-commercial use |
| [UNESCO World Heritage](https://whc.unesco.org/en/list/) | Official list + documentation per site | Free with attribution |

## Nature & environment

| Database | Coverage | Access |
|---|---|---|
| [GBIF](https://www.gbif.org/) | 2B+ species occurrence records; **map tile API** for distribution overlays | CC0/CC BY — powers the species map layer |
| [POWO (Kew)](https://powo.science.kew.org/) | Authoritative plant distributions | CC BY |
| [Open-Meteo](https://open-meteo.com/) | Weather (1940→now), **elevation API** | Free non-commercial |
| [Copernicus / Sentinel](https://dataspace.copernicus.eu/) | Satellite imagery archive | Free |

!!! tip "From database to map"
    Anything OSM-tagged (mines, hospitals, fuel, churches, masts…) can be plotted live on
    the Workbench map via the **Data layers** module; species ranges via the **species
    overlay** (GBIF tiles). Results are cached locally.
