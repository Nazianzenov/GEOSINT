# GeOSINT Field Wiki

A sourced field reference for **geographical OSINT**: locating and verifying places, dates and
times from imagery. It accompanies the GeOSINT Workbench app (map, sun/shadow, weather,
reverse-image and tool-launcher modules).

## How to use this wiki

1. **Start wide, narrow down.** Hemisphere → continent → country → region → road → spot.
   The [geolocation workflow](methodology/workflow.md) walks the full funnel.
2. **Use the identification pages as elimination filters.** Driving side, bollards, poles,
   road lines, plates, scripts — each one removes most of the world.
3. **Verify, don't just locate.** Once you have a candidate, cross-check with
   [sun/shadow](methodology/chronolocation.md) and historical weather (Weather module)
   before calling it confirmed.

## Sourcing policy

Every factual claim on these pages carries a reference — a standard, paper, database or
established community-verified guide. The main source classes:

| Class | Examples |
|---|---|
| International standards & treaties | [Vienna Convention on Road Signs and Signals (UNECE, 1968)](https://unece.org/transport/road-traffic/vienna-convention-road-signs-and-signals), [ITU-T E.164 country codes](https://www.itu.int/en/ITU-T/inr/Pages/default.aspx), [ISO 3166](https://www.iso.org/iso-3166-country-codes.html) |
| National regulations | [US MUTCD (FHWA)](https://mutcd.fhwa.dot.gov/), national road-design manuals |
| Peer-reviewed science | [Beck et al. 2018, Köppen-Geiger maps, *Scientific Data*](https://www.nature.com/articles/sdata2018214) |
| Public databases | [CIA World Factbook](https://www.cia.gov/the-world-factbook/), [GeoNames](https://www.geonames.org/), [IANA ccTLD registry](https://www.iana.org/domains/root/db), [Open-Meteo/ERA5](https://open-meteo.com/) |
| Community-verified geolocation guides | [GeoHints](https://geohints.com/), [PlonkIt](https://www.plonkit.net/), [Geometas](https://geometas.com/), [Bellingcat toolkit](https://bellingcat.gitbook.io/toolkit) |

!!! warning "Community guides change"
    Street View-meta facts (camera generations, coverage) drift as Google re-shoots roads.
    GeoHints/PlonkIt/Geometas are actively maintained — when a claim matters to a real case,
    re-check it against the live guide before relying on it.

!!! tip "Smart search"
    The Workbench's **[Wiki Search](/app/search.html)** understands entities: try
    *"asian bollards"* (photo grid of Asia's bollards) or just a country name
    (everything the wiki knows about it, grouped by category). The search box in this
    wiki's header is plain page search; the smart one lives in the app.

## Page map

- **[Methodology](methodology/workflow.md)** — the investigative process itself.
- **[Identification features](identify/driving-side.md)** — GeoHints-style clue catalogues.
- **[World reference](world/index.md)** — per-continent country recognition notes + quick table.
- **[Landmarks](landmarks/natural.md)** — natural and man-made anchors with coordinates.
- **[Sources](sources.md)** — every database and tool in one list.
