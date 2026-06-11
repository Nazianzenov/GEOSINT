# Sources & databases — master list

Everything cited across this wiki plus the tools wired into the Workbench, in one place.

## Standards & treaties

| Source | What it settles |
|---|---|
| [Vienna Convention on Road Signs & Signals (UNECE 1968)](https://unece.org/transport/road-traffic/vienna-convention-road-signs-and-signals) | Sign shapes/colours for ~70 signatory states |
| [US MUTCD (FHWA)](https://mutcd.fhwa.dot.gov/) | US (+derivative) signage & yellow markings |
| [ISO 3166](https://www.iso.org/iso-3166-country-codes.html) | Country codes seen on plates/domains |
| [ITU-T E.164](https://www.itu.int/oth/T0202.aspx?parent=T0202) | Telephone country codes |
| [IANA Root Zone DB](https://www.iana.org/domains/root/db) | Every ccTLD |
| [EUR-Lex 2411/98](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31998R2411) | EU plate band |

## Science & reference data

| Source | What it gives |
|---|---|
| [Beck et al. 2018, *Scientific Data*](https://www.nature.com/articles/sdata2018214) ([maps](https://www.gloh2o.org/koppen/)) | Köppen-Geiger climate at 1 km |
| [GBIF](https://www.gbif.org/) / [POWO (Kew)](https://powo.science.kew.org/) | Plant/animal occurrence & native ranges |
| [Open-Meteo](https://open-meteo.com/en/docs/historical-weather-api) | ERA5 weather, any point, 1940→now (used by the Weather module) |
| [NOAA Solar Calculator](https://gml.noaa.gov/grad/solcalc/) | Reference solar geometry |
| [SunCalc library](https://github.com/mourner/suncalc) | The Sun module's engine (BSD-2) |
| [GeoNames](https://www.geonames.org/) | 11M placename gazetteer (CC-BY) |
| [CIA World Factbook](https://www.cia.gov/the-world-factbook/) | Country baseline facts |
| [FAO Soil Map of the World](https://www.fao.org/soils-portal/data-hub/soil-maps-and-databases/faounesco-soil-map-of-the-world/en/) | Soil colour/type regions |

## Community-verified geolocation guides

| Source | Notes |
|---|---|
| [GeoHints](https://geohints.com/) | Photo catalogues: bollards, poles, plates, chevrons, Google cars, camera gens |
| [PlonkIt](https://www.plonkit.net/guide) | Per-country recognition guides, maintained |
| [Geometas](https://geometas.com/) | Structured meta wiki |
| [Bellingcat Toolkit](https://bellingcat.gitbook.io/toolkit) | Curated, reviewed tool directory |
| [The OSINT Toolbox — Geolocation list](https://github.com/The-Osint-Toolbox/Geolocation-OSINT) | Large community link collection |

## Imagery & maps (wired into the Tools module)

[Google Earth](https://earth.google.com/web/) · [Google Earth Pro desktop](https://www.google.com/earth/about/versions/#earth-pro) ·
[Esri Wayback](https://livingatlas.arcgis.com/wayback/) · [Sentinel EO Browser](https://apps.sentinel-hub.com/eo-browser/) ·
[Copernicus Browser](https://browser.dataspace.copernicus.eu/) · [NASA Worldview](https://worldview.earthdata.nasa.gov/) ·
[Zoom Earth](https://zoom.earth/) · [Mapillary](https://www.mapillary.com/) · [KartaView](https://kartaview.org/) ·
[Yandex Maps/Panoramas](https://yandex.com/maps/) · [Baidu Maps](https://map.baidu.com/) · [Mapy.com](https://mapy.com/) ·
[OpenStreetMap](https://www.openstreetmap.org/) · [Overpass Turbo](https://overpass-turbo.eu/) ·
[Bellingcat OSM Search](https://osm-search.bellingcat.com/) · [OpenInfraMap](https://openinframap.org/) ·
[OpenRailwayMap](https://www.openrailwaymap.org/) · [Wikimapia](https://wikimapia.org/) · [F4map](https://demo.f4map.com/) ·
[what3words](https://what3words.com/) · [PeakVisor](https://peakvisor.com/) · [PeakFinder](https://www.peakfinder.com/) ·
[ShadeMap](https://shademap.app/) · [SunCalc.org](https://www.suncalc.org/) · [Ventusky](https://www.ventusky.com/) ·
[Windy](https://www.windy.com/) · [earth.nullschool](https://earth.nullschool.net/) ·
[Flightradar24](https://www.flightradar24.com/) · [MarineTraffic](https://www.marinetraffic.com/) ·
[Topographic-map.com](https://en-gb.topographic-map.com/)

## Reverse image search

[Google Lens](https://lens.google.com/) · [Yandex Images](https://yandex.com/images/) ·
[Bing Visual Search](https://www.bing.com/visualsearch) · [TinEye](https://tineye.com/) —
engine comparison: [Bellingcat's reverse-image guide](https://www.bellingcat.com/resources/how-tos/2019/12/26/guide-to-using-reverse-image-search-for-investigations/).

## Forensics

[ExifTool](https://exiftool.org/) (local metadata, reference implementation) ·
[exifr](https://github.com/MikeKovarik/exifr) (the Image module's parser, MIT) ·
[Sherloq](https://github.com/GuidoBartoli/sherloq) (open-source image forensics) ·
[FotoForensics](https://fotoforensics.com/) (online ELA — uploads leave your machine) ·
[C2PA](https://c2pa.org/) (provenance standard).

!!! note "AI geolocators"
    [GeoSpy](https://geospy.ai/) and [Picarta](https://picarta.ai/) can shortcut easy cases but
    (a) upload your image to a third party and (b) are confidently wrong often enough that
    every output needs the full verification workflow anyway.
