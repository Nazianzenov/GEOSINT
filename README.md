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
| **Map** | — | Leaflet workspace: OSM / Esri satellite / topo / dark layers, draggable active point, right-click context menu (copy DD/DMS, open Street View/Maps/Earth), distance ruler [M], coordinate & place search (supports decimal and DMS input) |
| **Sun & Shadow** | 1 | SunCalc-based: azimuth/elevation/shadow ratio at any date+time+UTC offset, day elevation chart, solar events, moon phase, sun & shadow direction drawn on the map, and a **shadow solver** (enter shadow azimuth + length ratio from a photo → get matching time windows, or proof of inconsistency) |
| **Meteorology** | 2 | Open-Meteo: ERA5 reanalysis archive (any date since 1940) or forecast model for recent dates — hourly temp, cloud cover, precipitation, snow depth, wind. Deep links to Ventusky/Zoom Earth/NASA Worldview at the same date/place |
| **Image Intelligence** | 3 | Drag-drop an image: local EXIF parse (GPS → jump to map + camera view cone, timestamp → auto-fills Sun & Weather modules), **full ExifTool dump** (all tags, via the locally installed ExifTool — nothing leaves the machine), reverse-search launchers for Google Lens / Yandex / Bing / TinEye (URL mode auto-submits) |
| **Wiki Search** | 5 / F | Entity-aware smart search over every piece of wiki information (2,600+ tagged cards): "asian bollards" → Asia bollard photo grid; a country name → everything about that country grouped by category; free text scored by MiniSearch (BM25, fuzzy, prefix). Facet sidebar: country, continent, category, photos-only. Rebuild index: `tools\build_search_index.py` (automatic in `run.ps1 -RebuildWiki`) |
| **Tool Launcher** | 4 | ~35 curated tools, each opening **centred on your active point**: Google Earth web, Esri Wayback, Sentinel/Copernicus, NASA Worldview, Zoom Earth, Mapillary, KartaView, Yandex/Baidu, Overpass Turbo, Bellingcat OSM Search, OpenInfraMap, OpenRailwayMap, PeakVisor/PeakFinder, ShadeMap, Flightradar24, MarineTraffic, … |
| **Wiki** | top-right | MkDocs Material site: methodology (workflow, chronolocation, verification), GeoHints-style identification catalogues (bollards, poles, road lines, signs, plates, architecture, vegetation, scripts, domains/phones, Street View meta), per-continent recognition notes, country quick-reference table, landmark gazetteer, master source list. **Every claim is referenced** to a standard, paper, database or maintained community catalogue |

### Desktop integration

The server detects locally installed tools (shown in the Tools module under
*Local desktop tools*, and in the status bar):

| Tool | Status | Role |
|---|---|---|
| **ExifTool** | ✓ installed (`winget install OliverBetz.ExifTool`) | "FULL METADATA" button in the Image module runs it on your file via `/api/exif` — all ~hundreds of tags, locally |
| **Google Earth Pro** | ✓ installed | Tools module entry generates a KML and flies GE Pro to the active point (`/api/flyto`) |
| **QGIS** | not installed — `winget install OSGeo.QGIS.LTR` (~2 GB) | one-click launch from the Tools module once installed |
| **Sherloq** (image forensics) | not installed — `git clone https://github.com/GuidoBartoli/sherloq tools\sherloq` + venv per its README | one-click launch once present in `tools\sherloq` |

Detection re-runs on every page load — install a tool and refresh; no config needed.

## Requirements & blockers

| Thing | Status |
|---|---|
| Python 3.10+ | ✓ you have 3.14 |
| `mkdocs-material` (in `.venv` only) | ✓ installed — the server itself is stdlib-only |
| Google Earth Pro | ✓ detected at `C:\Program Files\Google\Google Earth Pro\` |
| ExifTool | ✓ installed via winget (`%LOCALAPPDATA%\Programs\ExifTool`) |
| Wiki images | Wikimedia images are **cached locally** in `wiki/docs/assets/wm/` by `tools/cache_wikimedia.py` (re-checked against Commons only when >30 days old; manifest in `wiki/wm_manifest.json`) — wiki works offline. GeoHints galleries stay hotlinked, not copied: a crawl allowance is not a republication license, and the site blocks automated fetching anyway |
| Internet | needed for tiles/geocoding/weather/external tools; the wiki and EXIF parsing work offline |
| Reverse image with **local** files | engines can't be auto-submitted a local file — the app opens the engine and you drag/paste the image in (URL-based search *is* fully automated). This is an engine-side limitation, not a missing feature |
| AI geolocators (GeoSpy/Picarta) | linked but flagged: they upload your image to a third party |

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
