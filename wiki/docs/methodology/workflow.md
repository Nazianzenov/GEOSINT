# Geolocation workflow

The standard funnel used by professional open-source investigators (Bellingcat, OCCRP, NYT
Visual Investigations). Work from the **largest filter to the smallest**, writing down every
clue and every elimination — negative results are evidence too.

## 0 — Preserve & inspect

- Save the original file. Never work on a re-compressed copy if avoidable.
- Extract metadata first ([EXIF guide](verification.md)) — GPS, timestamp, camera model.
  Social platforms (X/Twitter, Facebook, Instagram, Telegram) strip EXIF; original files from
  messengers as "document/file" often retain it.[^exif]
- Reverse-search the image immediately (Lens, Yandex, Bing, TinEye) — someone may already
  have located it, or it may be old/recycled content. TinEye sorts by *oldest* crawl date,
  which exposes recycled images.[^bc-img]

## 1 — Hemisphere & climate zone

- **Sun position**: in the northern hemisphere the midday sun is in the south (shadows point
  north); reversed in the southern hemisphere. See [chronolocation](chronolocation.md).[^noaa]
- **Vegetation & climate**: palm trees, birch, eucalyptus, tundra — match against the
  [Köppen-Geiger climate map](../identify/vegetation-climate.md).[^beck]

## 2 — Country

Apply the elimination filters in roughly this order (fastest first):

1. [Driving side](../identify/driving-side.md) — removes ~⅓ or ~⅔ of countries instantly.
2. [Language & script](../identify/language-scripts.md) on signs and shopfronts.
3. [License plate](../identify/license-plates.md) color/shape (even blurred).
4. [Road infrastructure](../identify/road-markings.md): line colors, [bollards](../identify/bollards.md),
   [poles](../identify/utility-poles.md), [signs](../identify/road-signs.md).
5. Phone numbers, [domain names](../identify/domains-phones.md), currency symbols on ads.
6. If from Street View: [camera/car meta](../identify/streetview-meta.md).

## 3 — Region within country

- Area codes on phone numbers; postal codes; regional plate prefixes.
- Terrain profile: match mountains with [PeakVisor](https://peakvisor.com/) /
  [PeakFinder](https://www.peakfinder.com/).[^peakvisor]
- Road numbering (e.g. French "D" departmental roads carry the département number context;
  US county roads).
- Architecture and roof styles ([architecture](../identify/architecture.md)).

## 4 — Pinpoint

- **Satellite sweep**: Google Earth / Esri imagery along candidate roads. Use distinctive
  fixed features: road junctions, bridges, towers, field boundaries, building footprints.
- **OSM queries**: [Overpass Turbo](https://overpass-turbo.eu/) can find e.g. *all fuel
  stations within 200 m of a rail line in region X*. Bellingcat's
  [OSM search](https://osm-search.bellingcat.com/) does this without writing queries.[^osm-search]
- **Street-level confirm**: Street View / Mapillary / KartaView / Yandex Panoramas.

## 5 — Verify

A location is only *confirmed* when independent evidence agrees:

- [ ] Camera position & line of sight reproduce the photo's geometry (building alignments!)
- [ ] Sun/shadow direction consistent with claimed time ([chronolocation](chronolocation.md))
- [ ] Weather on the claimed date matches (Workbench Weather module — ERA5 archive)[^om]
- [ ] Seasonal state of vegetation consistent (deciduous leaves, snow line, crops)
- [ ] No anachronisms (buildings not yet built, demolished structures — check
  [Esri Wayback](https://livingatlas.arcgis.com/wayback/) / Google Earth history)

[^exif]: Smith, A. "What stays and what goes: photo metadata across social networks" — see also Bellingcat, [*Debunking false information: image verification*](https://www.bellingcat.com/resources/2021/08/13/debunk-fake-image-video-guide/).
[^bc-img]: Bellingcat Online Investigation Toolkit, [Search by Image](https://bellingcat.gitbook.io/toolkit/more/all-tools/search-by-image).
[^noaa]: NOAA Global Monitoring Laboratory, [Solar Position Calculator](https://gml.noaa.gov/grad/solcalc/) — authoritative solar geometry.
[^beck]: Beck, H.E. et al. (2018). "Present and future Köppen-Geiger climate classification maps at 1-km resolution". *Scientific Data* 5, 180214. [doi:10.1038/sdata.2018.214](https://www.nature.com/articles/sdata2018214).
[^peakvisor]: Nieman Reports, [*Lessons from Building an Online Toolkit to Aid Open-Source Investigations*](https://niemanreports.org/osint-open-source-investigations-bellingcat-volunteers/) — PeakVisor adopted by OSINT journalists for skyline matching.
[^osm-search]: Bellingcat, [OpenStreetMap search tool](https://osm-search.bellingcat.com/) ([source on GitHub](https://github.com/bellingcat/osm-search)).
[^om]: Open-Meteo, [Historical Weather API documentation](https://open-meteo.com/en/docs/historical-weather-api) — ERA5 (0.25°, from 1940) and ERA5-Land (0.1°, from 1950) reanalysis.
