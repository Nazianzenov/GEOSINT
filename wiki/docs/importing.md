# Importing GeoHints photo galleries

GeoHints blocks automated crawlers, so this workflow uses **your browser** (a normal,
permitted visitor) and splices the photos into the matching wiki topic page. Images are
hotlinked — they load directly from geohints.com when you view a page; nothing is copied.

## How to import a category

1. Open the category on [geohints.com](https://geohints.com/) (e.g. `/meta/licensePlates`).
2. `Ctrl+S` → save into this project's `import/` folder. Both a normal page save and a
   view-source save work; keep the default filename (it contains the category name).
3. Run the importer and rebuild:

```powershell
.venv\Scripts\python tools\import_geohints.py
.\run.ps1 -RebuildWiki
```

## Where each category lands

| GeoHints category | Goes into wiki page |
|---|---|
| bollards | Identification → Bollards |
| utilityPoles | Identification → Utility poles |
| architecture, houseNumbers, postBoxes | Identification → Architecture |
| trafficLights | Identification → Traffic lights |
| sceneries, nature | Identification → Vegetation & climate |
| flags | Identification → Flags |
| licensePlates | Identification → License plates |
| lines | Identification → Road markings |
| drivingSide | Identification → Driving side |
| cameraGens, followCars, rifts, googleVehicles | Identification → Street View meta |
| domains, phoneNumbers | Identification → Domains & phones |
| anything else | standalone page under `geohints/` (add to nav manually) |

Re-importing a category **replaces** its gallery in place (the content between the
`<!-- GEOHINTS:... -->` markers), so refreshing from the live site is safe.

## Wikimedia image cache

Wikimedia/Commons images used across the wiki are **downloaded locally** to
`wiki/docs/assets/wm/` by `tools/cache_wikimedia.py` (the wiki therefore shows them
offline). The manifest `wiki/wm_manifest.json` records when each image was fetched;
a cached image is only re-downloaded when it is **older than 30 days** (or with
`--force`). `run.ps1 -RebuildWiki` runs the cache refresh automatically before building.
Attribution "source" links still point to the Commons file pages. GeoHints gallery images
remain hotlinked (not copied) by design.
