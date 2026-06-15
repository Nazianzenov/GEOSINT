# Satellite imagery sourcing guide

Which provider to reach for, and why — matched to the imagery tools the Workbench's
**Tool Launcher** already opens centred on your active point. The right source depends on
three axes: **resolution** (how small a feature you can resolve), **recency** (how fresh),
and **history** (how far back, and whether you can pick a past date).[^providers]

No single source wins on all three — geolocation pinpointing wants high resolution and a
time slider; change-detection and event work want frequent revisits and date control.

## Pick by task

| You need… | Use | Why |
|---|---|---|
| **Pinpoint a building/junction** (highest res) | Google Earth (web/Pro), Esri World Imagery | sub-metre in many areas; GE Pro has the deepest historical slider |
| **See how a place looked on/around a date** | Esri **Wayback**, Google Earth Pro history | Wayback exposes every past Esri basemap version by date |
| **Fresh imagery, last few days** | Sentinel-2 (EO Browser / Copernicus), Zoom Earth | Sentinel-2 ~5-day revisit, 10 m; Zoom Earth near-live daily |
| **A specific past date, free, dated** | Sentinel-2 archive (Copernicus), NASA Worldview | full archive, pick the exact acquisition date |
| **Fires / smoke / floods / storms by day** | NASA Worldview (MODIS/VIIRS) | daily global, many science layers, date picker |
| **Vegetation / agriculture / burn scars** | Sentinel-2 custom bands (EO Browser) | NDVI and false-colour band combos on demand |
| **Night lights** | NASA Worldview (VIIRS Day/Night Band) | power outages, settlement extent |

## The providers (all launched from the Tools module)

- **Google Earth Pro (desktop)** — the strongest **historical** slider; can go back years/decades
  in populated areas. The Workbench flies it to the active point via KML. Best first stop for
  confirming a fixed-feature match over time.
- **Esri Wayback** — a time machine of Esri's World Imagery basemaps; each version is dated, so
  you can find when a feature appeared or vanished. Excellent for **anachronism checks**.[^wayback]
- **Sentinel-2** (via **Copernicus Browser** / **Sentinel Hub EO Browser**) — free ESA imagery,
  10 m, ~5-day revisit, full archive from 2015, custom band math. The workhorse for **dated,
  free, recent-ish** imagery and vegetation work.[^sentinel]
- **NASA Worldview** — daily MODIS/VIIRS at coarse resolution (250 m–1 km) but **every day,
  globally, with a date picker** and dozens of science layers — the tool for events (fires,
  smoke, dust, floods, ice, night lights).[^worldview]
- **Zoom Earth** — friendly near-live and recent daily satellite mosaics; quick situational
  context rather than analysis.

## Resolution / recency / history at a glance

| Source | Resolution | Revisit / recency | Historical depth | Free? |
|---|---|---|---|---|
| Google Earth (Pro) | ~0.3–0.5 m (varies) | months–years | **deep, dated slider** | yes |
| Esri Wayback | ~0.3–1 m | months | dated versions since ~2014 | yes |
| Sentinel-2 | 10 m | ~5 days | full archive since 2015 | yes |
| NASA Worldview (VIIRS/MODIS) | 250 m–1 km | **daily** | since ~2012/2000 | yes |
| Zoom Earth | varies (mosaic) | near-live / daily | limited | yes |

## Workflow tips

1. **Two-source rule.** Confirm a pinpoint on at least two independent providers — high-res for
   the feature match, dated archive (Wayback / GE history / Sentinel) to rule out anachronisms.
2. **Date the scene, then fetch that date.** Once chronolocation narrows the date
   ([cookbook](chronolocation-cookbook.md)), pull the matching Sentinel-2 acquisition or
   Worldview day to compare snow/flood/vegetation/burn state.
3. **Resolution ≠ truth.** A crisp basemap may be months or years old; always check the
   acquisition date before asserting "as of".
4. **Mind cloud cover.** Optical satellites see nothing through cloud — if Sentinel is clouded
   on your date, step to the nearest clear pass and note the gap.

!!! note "OPSEC"
    These are third-party web services; opening one reveals the coordinates you're viewing to
    that provider. For sensitive casework, route the browser through your usual setup. The
    Workbench itself only hands the tool a lat/lng in the URL — it uploads nothing.

[^providers]: Overview of open-source satellite sources for investigations: Bellingcat Toolkit, [Satellite & aerial imagery](https://bellingcat.gitbook.io/toolkit/more/all-tools/satellite); and Bellingcat, [*A guide to using satellite imagery*](https://www.bellingcat.com/resources/2017/04/13/using-satellite-imagery-confirm-photographed-location/).
[^wayback]: Esri, [World Imagery Wayback](https://livingatlas.arcgis.com/wayback/) — versioned, dated basemap archive.
[^sentinel]: ESA Copernicus, [Sentinel-2 mission](https://sentinels.copernicus.eu/web/sentinel/missions/sentinel-2) (10 m, ~5-day revisit); access via [Copernicus Browser](https://browser.dataspace.copernicus.eu/) and [Sentinel Hub EO Browser](https://apps.sentinel-hub.com/eo-browser/).
[^worldview]: NASA EOSDIS, [Worldview](https://worldview.earthdata.nasa.gov/) — daily MODIS/VIIRS imagery with a date picker and science layers.
