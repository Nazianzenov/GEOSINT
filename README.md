# GeOSINT Workbench

A local, expert-grade geographical OSINT workstation: interactive map + sun/shadow
chronolocation + historical weather + image intelligence + a launcher for ~35 professional
tools + a fully sourced field wiki.

**Everything runs on your machine.** The only network traffic is map tiles, geocoding
(Nominatim), weather (Open-Meteo) and whatever external tools you choose to open.

## Quick start

```
run.bat
```

That's it. First run creates `.venv`, installs the wiki builder (mkdocs-material), builds the
wiki, starts the server on `http://127.0.0.1:8650/` and opens your browser.

Manual equivalent:

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\mkdocs build -f wiki\mkdocs.yml
.venv\Scripts\python server.py
```

## The modules

| Module | Key | What it does |
|---|---|---|
| **Map** | — | Leaflet workspace: OSM / Esri satellite / topo / dark layers, draggable active point, right-click context menu (copy **DD / DMS / MGRS / UTM / Plus Code**, open Street View/Maps/Earth), distance ruler [M], coordinate & place search (accepts decimal, DMS, **MGRS** and **Plus Codes** — all converted offline) |
| **Case file** | N · Ctrl+S | Save/load the whole workspace to a local `*.geosint.json` — active point, map view, measure shapes, **annotations**, active OSM/GBIF layers, every module's inputs, and free-text **case notes** ([N]). Pure client-side: the file is downloaded to / read from your machine, nothing is uploaded |
| **Annotations** | 7 / A | Right-click the map to drop a **pin**, **label** or **arrow**; drag any marker to move it, click to rename/delete. Disabled while the ruler [M] is armed (so it never clashes with measure's right-click). Export all annotations as **GeoJSON** or **KML**, or hand off to **QGIS**. Saved in the case file |
| **Sun & Shadow** | 1 | SunCalc-based: azimuth/elevation/shadow ratio at any date+time+UTC offset, day elevation chart, solar events, moon phase, sun & shadow direction drawn on the map, and a **shadow solver** (enter shadow azimuth + length ratio from a photo → get matching time windows, or proof of inconsistency) |
| **Meteorology** | 2 | Open-Meteo: ERA5 reanalysis archive (any date since 1940) or forecast model for recent dates — hourly temp, cloud cover, precipitation, snow depth, wind. Deep links to Ventusky/Zoom Earth/NASA Worldview at the same date/place |
| **Image Intelligence** | 3 | Drag-drop an image: local EXIF parse (GPS → jump to map + camera view cone, timestamp → auto-fills Sun & Weather modules), **full ExifTool dump** (all tags, via the locally installed ExifTool — nothing leaves the machine), reverse-search launchers for Google Lens / Yandex / Bing / TinEye (URL mode auto-submits) |
| **Wiki Search** | 5 / F | Entity-aware smart search over every piece of wiki information (2,600+ tagged cards): "asian bollards" → Asia bollard photo grid; a country name → everything about that country grouped by category; free text scored by MiniSearch (BM25, fuzzy, prefix). Facet sidebar: country, continent, category, photos-only. Rebuild index: `tools\build_search_index.py` (automatic in `run.ps1 -RebuildWiki`) |
| **Data Layers** | 6 / D | Plot **OSM features in the current view** (12 presets: mines & quarries, hospitals, power plants, wind turbines, military, lighthouses… or any custom `key=value` tag) via a locally **cached Overpass proxy** (7-day TTL). **GBIF species distribution overlays** by name (e.g. silver birch) — occurrence-density tiles on the map. Terrain hillshade base layer; elevation readout at the active point; Windy wind-map embed in the Weather module |
| **Knowledge Graph** | via search | `/app/graph.html` — force-directed graph of categories ↔ countries ↔ continents (node size = wiki cards); click any node to run that search. The WIKI button now opens the **smart search** as the primary navigation; classic page browsing stays at `/wiki/` |
| **Tool Launcher** | 4 | ~35 curated tools, each opening **centred on your active point**: Google Earth web, Esri Wayback, Sentinel/Copernicus, NASA Worldview, Zoom Earth, Mapillary, KartaView, Yandex/Baidu, Overpass Turbo, Bellingcat OSM Search, OpenInfraMap, OpenRailwayMap, PeakVisor/PeakFinder, ShadeMap, Flightradar24, MarineTraffic, … |
| **Wiki** | top-right | MkDocs Material site: methodology (workflow, chronolocation, verification), identification catalogues (bollards, poles, road lines, signs, plates, architecture, vegetation, scripts, domains/phones, Street View meta), per-continent recognition notes, country quick-reference table, landmark gazetteer, master source list. **Every claim is referenced** to a standard, paper, database or maintained community catalogue |

### Desktop integration

The server detects locally installed tools (shown in the Tools module under
*Local desktop tools*, and in the status bar):

| Tool | Status | Role |
|---|---|---|
| **ExifTool** | ✓ installed (`winget install OliverBetz.ExifTool`) | "FULL METADATA" button in the Image module runs it on your file via `/api/exif` — all ~hundreds of tags, locally |
| **Google Earth Pro** | ✓ installed | Tools module entry generates a KML and flies GE Pro to the active point (`/api/flyto`) |
| **QGIS** | installed (`winget install OSGeo.QGIS.LTR`) | launches via its `qgis-ltr.bat` (sets up the Qt/GDAL env). The Data-layers module's **Open in QGIS** button hands off the plotted OSM features + active point as a GeoJSON layer (`/api/qgis`) |
| **Sherloq** (image forensics) | not installed — `git clone https://github.com/GuidoBartoli/sherloq tools\sherloq` + venv per its README | one-click launch once present in `tools\sherloq` |

Detection re-runs on every page load — install a tool and refresh; no config needed.

## Requirements & blockers

| Thing | Status |
|---|---|
| Python 3.10+ | ✓ you have 3.14 |
| `mkdocs-material` (in `.venv` only) | ✓ installed — the server itself is stdlib-only |
| Google Earth Pro | ✓ detected at `C:\Program Files\Google\Google Earth Pro\` |
| ExifTool | ✓ installed via winget (`%LOCALAPPDATA%\Programs\ExifTool`) |
| Wiki images | Wikimedia images are **cached locally** in `wiki/docs/assets/wm/` by `tools/cache_wikimedia.py` (re-checked against Commons only when >30 days old; manifest in `wiki/wm_manifest.json`) — wiki works offline. Identification photo galleries are hotlinked, not copied — they load in the browser and are not stored in the repo (internet required to display them) |
| Internet | needed for tiles/geocoding/weather/external tools; the wiki and EXIF parsing work offline |
| Reverse image with **local** files | engines can't be auto-submitted a local file — the app opens the engine and you drag/paste the image in (URL-based search *is* fully automated). This is an engine-side limitation, not a missing feature |
| AI geolocators (GeoSpy/Picarta) | linked but flagged: they upload your image to a third party |

## Open datasets (all free / non-commercial licensed)

`tools/fetch_datasets.py` (30-day cache, run by `run.ps1 -RebuildWiki`) pulls:

| Dataset | Rows | Source / license |
|---|---|---|
| UNESCO World Heritage sites | ~1,250 | Wikidata SPARQL (CC0) |
| National parks | ~2,400 | Wikidata (CC0) |
| Castles & palaces (heritage-listed) | ~5,600 | Wikidata (CC0) |
| Airports (large+medium) | ~5,300 | OurAirports (public domain) |
| Botanical reference | 54 species | GBIF (CC0) + Wikipedia (CC BY-SA), `tools/build_flora.py` |

All rows are searchable cards with coordinates ("⌖ open on map"). The wiki's
**Datasets → Databases catalogue** page lists ~20 more geo-OSINT databases (USGS MRDS,
Austria's IRIS mining registry, Global Energy Monitor, WDPA, healthsites.io…).

## Caching policy

Everything external is disk-cached locally:

| What | TTL | Where |
|---|---|---|
| **Map tiles** (all base layers, via `/tiles/`) | 30 days | `cache/tiles/` — revisited areas load instantly and work offline |
| Historical weather (immutable) & elevation | ~forever | `cache/pget/` |
| Weather forecasts | 3 h | `cache/pget/` |
| Geocoding (Nominatim), GBIF lookups | 30 days | `cache/pget/` |
| Overpass/OSM queries | 30 days + **stale-on-error** | `cache/overpass/` |
| Wikimedia images | 30 days | `wiki/docs/assets/wm/` |
| Datasets & flora | 30 days | `data/*.json` |

The `/api/pget` proxy only fetches allowlisted hosts; the Overpass proxy remembers the
last healthy mirror and falls back across four instances.

## Editing the wiki

Pages are Markdown in `wiki/docs/`. After editing:

```powershell
.\run.ps1 -RebuildWiki
```

or live-preview while writing: `.venv\Scripts\mkdocs serve -f wiki\mkdocs.yml`.

## Layout

```
server.py          stdlib HTTP server (static + /api/status + /api/flyto KML launcher)
run.bat / run.ps1  one-click launcher
app/               the workbench SPA (vanilla JS; vendored Leaflet, SunCalc, exifr)
wiki/mkdocs.yml    wiki config (MkDocs Material)
wiki/docs/         23 sourced reference pages
wiki/site/         built wiki (generated)
.venv/             Python env (only dependency: mkdocs-material)
```

## OPSEC notes

- The server binds `127.0.0.1` only — nothing is exposed to your network.
- Images are parsed in the browser; nothing is uploaded unless **you** open an external
  engine and hand it the image.
- Nominatim/Open-Meteo queries necessarily reveal the coordinates you're investigating to
  those services; for sensitive casework, route the browser through your usual opsec setup.
