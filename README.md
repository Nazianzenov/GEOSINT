# GeOSINT Workbench

A local, expert-grade geographical OSINT workstation: interactive map + sun/shadow
chronolocation + historical weather + image intelligence + a launcher for ~35 professional
tools + a fully sourced field wiki.

**Everything runs on your machine.** The only network traffic is map tiles, geocoding
(Nominatim), weather (Open-Meteo) and whatever external tools you choose to open.

## Quick start

```
run.bat            # Windows
./run.sh           # macOS / Linux
python -m geosint  # any OS (same one-command bootstrap)
```

That's it. First run creates `.venv`, installs the wiki builder (mkdocs-material), builds the
wiki, starts the server on `http://127.0.0.1:8650/` and opens your browser.

Prefer not to install Python? Use a **portable build** or the **Docker image** instead — see
[docs/DEPLOY.md](docs/DEPLOY.md).

Manual equivalent:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip
.venv/bin/mkdocs build -f wiki/mkdocs.yml
.venv/bin/python server.py
```

## The modules

| Module | Key | What it does |
|---|---|---|
| **Map** | — | Leaflet workspace: OSM / Esri satellite / topo / dark layers, draggable active point, right-click context menu (copy **DD / DMS / MGRS / UTM / Plus Code**, open Street View/Maps/Earth), distance + **bearing** ruler [M] (each leg shows distance and azimuth/compass heading; right-click the line for an **elevation profile** — terrain cross-section with gain/loss, sampled along the line and cached), coordinate & place search (accepts decimal, DMS, **MGRS** and **Plus Codes** — all converted offline) |
| **Case file** | N · Ctrl+S | Save/load the whole workspace to a local `*.geosint.json` — active point, map view, measure shapes, **annotations**, active OSM/GBIF layers, every module's inputs, and free-text **case notes** ([N]). Pure client-side: the file is downloaded to / read from your machine, nothing is uploaded |
| **Annotations** | 7 / A | Right-click the map to drop a **pin**, **label** or **arrow**; drag any marker to move it, click to rename/delete. Disabled while the ruler [M] is armed (so it never clashes with measure's right-click). Export all annotations as **GeoJSON** or **KML**, or hand off to **QGIS**. Saved in the case file |
| **Sun & Shadow** | 1 | SunCalc-based: azimuth/elevation/shadow ratio at any date+time+UTC offset, day elevation chart, solar events, moon phase, sun & shadow direction drawn on the map, and a **shadow solver** (enter shadow azimuth + length ratio from a photo → get matching time windows, or proof of inconsistency) |
| **Meteorology** | 2 | Open-Meteo: ERA5 reanalysis archive (any date since 1940) or forecast model for recent dates — hourly temp, cloud cover, precipitation, snow depth, wind. Deep links to Ventusky/Zoom Earth/NASA Worldview at the same date/place |
| **Image Intelligence** | 3 | Drag-drop an image: local EXIF parse (GPS → jump to map + camera view cone, timestamp → auto-fills Sun & Weather modules), **full ExifTool dump** (all tags, via the locally installed ExifTool — nothing leaves the machine), **batch EXIF** (drop a folder → sortable GPS/time/camera table, ⌖ jump-to-map per row — all local), reverse-search launchers for Google Lens / Yandex / Bing / TinEye (URL mode auto-submits) |
| **Wiki Search** | 5 / F | Entity-aware smart search over every piece of wiki information (2,600+ tagged cards): "asian bollards" → Asia bollard photo grid; a country name → everything about that country grouped by category; free text scored by MiniSearch (BM25, fuzzy, prefix). Facet sidebar: country, continent, category, photos-only. Rebuild index: `tools\build_search_index.py` (automatic in `run.ps1 -RebuildWiki`) |
| **Data Layers** | 6 / D | Plot **OSM features in the current view** (12 presets: mines & quarries, hospitals, power plants, wind turbines, military, lighthouses… or any custom `key=value` tag) via a locally **cached Overpass proxy** (7-day TTL). **GBIF species distribution overlays** by name (e.g. silver birch) — occurrence-density tiles on the map. **Offline tile prefetch**: cache the whole current view across a zoom range into `cache/tiles/` for fieldwork. Terrain hillshade base layer; elevation readout at the active point; the Weather module deep-links to Windy / earth.nullschool wind maps at the active point, layer and date |
| **Knowledge Graph** | via search | `/app/graph.html` — force-directed graph of categories ↔ countries ↔ continents (node size = wiki cards); click any node to run that search. The WIKI button now opens the **smart search** as the primary navigation; classic page browsing stays at `/wiki/` |
| **Tool Launcher** | 4 | ~35 curated tools, each opening **centred on your active point**: Google Earth web, Esri Wayback, Sentinel/Copernicus, NASA Worldview, Zoom Earth, Mapillary, KartaView, Yandex/Baidu, Overpass Turbo, Bellingcat OSM Search, OpenInfraMap, OpenRailwayMap, PeakVisor/PeakFinder, ShadeMap, Flightradar24, MarineTraffic, … |
| **Wiki** | top-right | MkDocs Material site: methodology (workflow, chronolocation, verification), identification catalogues (bollards, poles, road lines, signs, plates, architecture, vegetation, scripts, domains/phones, Street View meta), per-continent recognition notes, country quick-reference table, landmark gazetteer, master source list. **Every claim is referenced** to a standard, paper, database or maintained community catalogue |

### Desktop integration (optional tools)

These desktop tools are **optional** — the workbench detects whichever are
installed (shown in the Tools module under *Local desktop tools* and in the
status bar) and unlocks the matching one-click hand-off. Detection re-runs on
every page load: install a tool and refresh, no config needed. Anything not
installed is simply hidden; nothing else depends on it.

| Tool | Install | What it unlocks |
|---|---|---|
| **ExifTool** | `winget install OliverBetz.ExifTool` · macOS `brew install exiftool` · Linux `apt install libimage-exiftool-perl` | The Image module's **FULL METADATA** button runs it on your file via `/api/exif` — all ~hundreds of tags, locally |
| **Google Earth Pro** | [google.com/earth](https://www.google.com/earth/about/versions/#earth-pro) | Tools-module entry generates a KML and flies GE Pro to the active point (`/api/flyto`) |
| **QGIS** | `winget install OSGeo.QGIS.LTR` · macOS `brew install --cask qgis` · Linux `apt install qgis` | The Data-layers module's **Open in QGIS** button hands off the plotted OSM features + active point as a GeoJSON layer (`/api/qgis`) |
| **Sherloq** (image forensics) | `git clone https://github.com/GuidoBartoli/sherloq tools/sherloq` + a venv per its README | One-click launch once present in `tools/sherloq` |

## Requirements

| Requirement | Notes |
|---|---|
| **Python 3.10+** | The only prerequisite to run from source; the server itself is stdlib-only (the lone dependency, `mkdocs-material`, builds the wiki and lives in `.venv`). Not needed if you use a portable build or the Docker image. |
| **Internet** | Needed for map tiles, geocoding, weather and the external tools; the wiki and local EXIF parsing work fully offline. Revisited areas are disk-cached and then work offline too. |
| **Wiki images** | Wikimedia images are cached locally so the wiki works offline; identification photo galleries are hotlinked (loaded in the browser, internet required to display them). |
| **Reverse image with local files** | Reverse-search engines fetch an image *URL* from their own servers, so a local file can't be auto-submitted. The workbench copies the image to your clipboard and opens the engines — you just paste. (URL-based search *is* fully automated.) |
| **AI geolocators (GeoSpy/Picarta)** | Linked but flagged — they upload your image to a third party; off by default, opt-in only. |

## Open datasets (all free / non-commercial licensed)

`tools/fetch_datasets.py` (30-day cache, run by `run.ps1 -RebuildWiki`) pulls:

| Dataset | Rows | Source / license |
|---|---|---|
| UNESCO World Heritage sites | ~1,250 | Wikidata SPARQL (CC0) |
| National parks | ~2,400 | Wikidata (CC0) |
| Castles & palaces (heritage-listed) | ~5,600 | Wikidata (CC0) |
| Airports (large+medium) | ~5,300 | OurAirports (public domain) |
| Botanical reference | 55 species | GBIF (CC0) + Wikipedia (CC BY-SA), `tools/build_flora.py`; each biome group cross-linked to its Köppen zone |

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
- **Built-in egress routing (⛨ OPSEC settings).** Each kind of outbound point lookup —
  map tiles, geocoding, weather/elevation, Overpass, GBIF, wiki reference images — can be
  sent **direct, through a verified system VPN, a residential proxy, or Tor**, so the
  coordinates you investigate need not leave from your real IP. The settings page can
  **verify your exit IP** and *fail closed* on a VPN-routed feature when the tunnel can't
  be confirmed. GBIF overlay tiles and wiki reference images are now proxied through the
  local server (previously browser-direct). SOCKS5/Tor needs the optional
  `requirements-opsec.txt` (`pip install -r requirements-opsec.txt`).
- **Publishing the Docker port.** The container binds `0.0.0.0` *inside* the container,
  so your real exposure is decided by **how you publish the port**. On an untrusted
  network the ONLY safe form is to bind host loopback:
  `docker run --rm -p 127.0.0.1:8650:8650 geosint`. A raw `-p 8650:8650` binds the host's
  `0.0.0.0` and exposes the launch/write API (which can run local programs and write
  files) to your whole LAN. The Host-header allowlist and the `X-GeOSINT` CSRF header are
  **defense-in-depth, not a network boundary** — do not rely on them to substitute for
  binding loopback.

## License

The **GeOSINT Workbench code** is licensed under the **GNU Affero General Public License
v3.0** (AGPL-3.0) — see [LICENSE](LICENSE). In short: you may use, study, modify and
redistribute it, and anyone you give it to (or run it for over a network) is entitled to the
corresponding source under the same terms. This keeps the tool — and any fork — open and
auditable, which matters for software handling sensitive casework.

**Bundled data and vendored assets keep their own upstream licenses** (they are not AGPL):

| Component | License |
|---|---|
| UNESCO / parks / castles / botanical (Wikidata, GBIF) | CC0 / public domain |
| Airports (OurAirports) | public domain |
| Wikipedia-derived botanical text | CC BY-SA |
| OSM / Overpass features | ODbL © OpenStreetMap contributors |
| Submarine cables & landing points (TeleGeography) | **CC BY-NC-SA 3.0 (NonCommercial)** |
| Wikimedia Commons images | per-file (CC0 / CC BY / CC BY-SA) |
| Vendored libraries (Leaflet, SunCalc, exifr, MiniSearch) | their own MIT/BSD licenses |

Because some bundled data is **NonCommercial** (TeleGeography) or **share-alike** (CC BY-SA,
ODbL), redistributing the repository *as a whole* inherits those obligations even though the
code is AGPL. The code license and the data licenses are independent; honour both.

## Contributing & governance

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the card schema,
sourcing bar, and workflow. Report security issues privately per [SECURITY.md](SECURITY.md).
The project is maintained on a best-effort basis; issues and pull requests are triaged on
GitHub. The guiding doctrine (local-first, no telemetry, no required cloud, no AI
geolocation) is non-negotiable for merged contributions.
