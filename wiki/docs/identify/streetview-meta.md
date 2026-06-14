# Street View meta (cameras, cars, coverage)

When your source image **is** Street View (or you're searching within it), the capture
system itself is evidence. These "metas" are community-documented and **change as Google
re-shoots** — always confirm against the live catalogues:
[PlonkIt country guides](https://www.plonkit.net/) and
[Geometas](https://geometas.com/).[^sources]

## Coverage as a filter

- **No official Google coverage**: China (use **Baidu Total View**), most of Central Asia,
  Iran, much of the Sahel, Cuba (limited), Belarus (limited) — if it looks like Google SV
  and claims to be China, something is wrong.[^coverage]
- **Yandex Panoramas** covers Russia/CIS cities far better than Google.
- **Germany & Austria**: Google coverage was historically sparse (privacy law);
  a 2023 re-shoot added major cities — capture date matters.[^germany]
- Check live: [Google's official coverage map](https://www.google.com/streetview/explore/).

## Camera generations (Google)

Documented with photo examples per country:[^gens]

| Generation | Visual tells | Era |
|---|---|---|
| Gen 2 | Lower resolution, strong halo/vignette, visible roof bar shadow | ~2009–2013 |
| Gen 3 | Decent res, **blurred ground circle** under car, soft colours | ~2014–2017 |
| Gen 4 | Sharp HDR-look, clean nadir patch | 2018+ |
| Trekker/tripod | No car, walking height, often parks/trails | any |

Low-gen imagery in an area tells you the *capture year* — cross-check what existed then.

## The car itself

Visible fragments of the capture vehicle are country-stable for a given coverage pass:

- **Roof bars / racks** visible bottom-frame differ per country fleet (e.g. the famous
  snorkel in Kenya's fleet, roof straps in Ghana's, pickup beds in Mongolia).[^cars]
- **Follow vehicles**: police/military escorts trail the car in some countries (documented
  for Nigeria; escorts also seen in parts of the Middle East).[^cars]
- **Rifts/stitching artifacts** and sky smears are generation+vehicle specific.

!!! warning "Fast-moving facts"
    Car-meta details (snorkels, straps, escorts) are re-verified continuously by the
    GeoGuessr community and **go stale** when Google re-drives a country. Treat any car meta
    as a hypothesis and confirm against a live car-meta reference for the imagery's
    capture date.

## Using capture dates

Street View shows the **capture month/year** (top of screen in the official viewer) and
keeps **historical passes** (clock icon). For investigations: establish what the scene looked
like on multiple dates; combine with [Esri Wayback](https://livingatlas.arcgis.com/wayback/)
satellite history.[^wayback]

[^sources]: PlonkIt ([plonkit.net](https://www.plonkit.net/guide)) and Geometas ([geometas.com](https://geometas.com/)) — community-verified meta catalogues.
[^coverage]: Wikipedia, [Coverage of Google Street View](https://en.wikipedia.org/wiki/Coverage_of_Google_Street_View) (tracked per country with dates); Google, [Street View coverage map](https://www.google.com/streetview/explore/).
[^germany]: Google Germany blog (June 2023), announcement of refreshed German Street View coverage; coverage histories in the Wikipedia article above.
[^gens]: PlonkIt guide introductions document camera-generation tells per country.
[^cars]: Google Street View car/fleet photo differences per country.
[^wayback]: Esri, [World Imagery Wayback](https://livingatlas.arcgis.com/wayback/) — every historical version of the Esri basemap, with capture metadata.
