# Chronolocation cookbook — dating an image with the Workbench

A repeatable, **tool-by-tool procedure** for answering *"when was this taken?"* — or proving a
claimed date/time false — using only the Workbench's local modules. Where
[Chronolocation (sun & shadows)](chronolocation.md) covers the *physics* and the
[Geolocation workflow](workflow.md) covers *finding the place*, this page is the *temporal*
casework recipe: how to chain **Sun & Shadow → Meteorology → Vegetation/seasonal** into a
single converging estimate, with a worked example and a copy-paste worksheet.

The governing idea is **independent convergence**: each signal narrows the possible
date/time, and a real image makes all of them agree at once. One contradiction is enough to
falsify — *negative results are evidence*.[^conv]

!!! tip "Prerequisite — fix the place first"
    Time-of-day from shadows is meaningless without a location, and weather/season checks
    need coordinates. Pinpoint (or at least narrow to a region) using the
    [workflow](workflow.md) before starting here. Set that point as the **active point** on the
    map — every module below reads from it.

## The signals, fastest to slowest

| Signal | Module | Resolves | Best when |
|---|---|---|---|
| Shadow azimuth + length | **Sun & Shadow** (key `1`) | time of day, ± season | a clean vertical object + its shadow are visible |
| Sun/shadow vs. claimed clock | **Sun & Shadow** solver | confirms / falsifies a stated time | a timestamp or claim exists to test |
| Cloud, precip, snow, wind | **Meteorology** (key `2`) | the *date* (within a window) | sky/ground conditions are visible and the place is known |
| Leaf-on/leaf-off, snow line, crop stage | **Vegetation & climate** | the *season*, sometimes ± weeks | deciduous trees, fields, or snow are in frame |
| Sun + season together | **Sun & Shadow** day-curve | latitude sanity-check | shadow length seems too long/short for the claim |

## Recipe

### 1 — Read the shadow → time of day
1. In **Sun & Shadow**, set the date you want to test (or sweep candidates). Set the **UTC
   offset** for the location explicitly — do not trust the camera clock yet.
2. Estimate the **shadow azimuth** (the compass direction the shadow points) from a feature
   you've already map-aligned — an identified street, a building edge, the Street View compass.
3. Estimate **shadow length ÷ object height** (people ≈ 1.7–1.8 m; doors ≈ 2.0–2.1 m; guard-rail
   posts ≈ 0.75 m — use several objects, never one).[^heights]
4. Run the **shadow solver**: it returns the local time window(s) matching that date and place,
   or `✗ no match` — which means the claimed *place or date* is inconsistent with the shadow.

### 2 — Test the claimed clock
If the image carries a timestamp (EXIF `DateTimeOriginal`, a caption, a claim), the Image
module auto-fills the Sun & Weather date fields when you drop the photo. Compare the **solved**
time window against the **claimed** time:

- Agreement → the timestamp is *consistent* (not proof — timestamps are forgeable; treat as
  corroboration).
- Disagreement beyond tolerance → either the time is wrong, the location is wrong, or the EXIF
  was spoofed. Widen tolerance once to rule out measurement error before concluding.

### 3 — Pin the date with weather
Knowing the *place* and a *candidate date*, open **Meteorology** and fetch that date. ERA5
reanalysis covers any date since 1940; recent dates use the forecast model.[^om] Compare the
photo against the archive:

| In the photo | Check against |
|---|---|
| Overcast / blue sky | hourly **cloud cover** % |
| Wet ground, puddles, rain | **precipitation** mm that day/hour |
| Lying snow, snow on roofs | **snow depth** |
| Flags, smoke, tree-bend | **wind speed/direction** |
| Crisp hard shadows | low cloud cover **and** sun above horizon at that hour |

A photo with hard shadows on a day ERA5 records as fully overcast is a contradiction. Cross-read
with the deep-links the module emits (**Zoom Earth** daily satellite archive, **NASA
Worldview**, **Ventusky**) to see the actual cloud field over the site that day.

### 4 — Sanity-check the season
Open **Vegetation & climate** / the seasonal cues in frame:

- **Deciduous trees**: bare = late autumn–early spring; full leaf = summer; the leaf-on/leaf-off
  transition dates are latitude-dependent and narrow the window to weeks.
- **Snow line / lying snow** must agree with the weather check *and* the climate zone.
- **Crops**: ploughed vs. green vs. golden vs. stubble stages map to a few-week band for a given
  region.

The **day-elevation curve** in the Sun module is a second seasonal check: maximum solar
elevation at solar noon is a direct function of date and latitude. If the shadows imply a
high midday sun but the trees are bare, something is wrong.

### 5 — Converge or falsify
Lay the windows side by side. A genuine image yields a **single overlapping band** across
shadow-time, weather-date, and season. If any signal sits outside the others, document the
contradiction — that is a falsification, and it is often the whole result.

## Worked example

*Claim:* a protest photo is "Berlin, 14:00 local, 3 March."

1. **Place** — identified to a named Berlin square via the [workflow](workflow.md); active point set.
2. **Shadow** — shadows of lamp posts point roughly NE; ratio ≈ 1.6×. Solver for 3 March at
   Berlin returns a match band around **15:30–16:10 local**, *not* 14:00.
3. **Clock test** — the 14:00 claim falls outside the solved band by ~1.5 h → first red flag
   (or the photo is from a different date/time than stated).
4. **Weather** — ERA5 for 3 March shows 95 % cloud all afternoon, yet the photo has crisp
   hard shadows → second contradiction.
5. **Season** — the square's lindens are in **full leaf**; in Berlin that is impossible in early
   March → third, decisive contradiction.

**Conclusion:** the image is not from 3 March; the leaf-on state plus the shadow geometry are
consistent with **late spring/summer, ~16:00**. Three independent signals agree against the
claim — far stronger than any single one.[^mh17]

## Worksheet

Copy into your case notes:

```
Active point (lat, lng):        ____________   (elevation: ____ m)
Claimed date / time / tz:       ____________

[Shadow]   azimuth points: ____°   ratio (len/height): ____×
           solver window(s): ____________   matches claim? Y / N
[Weather]  cloud %: ____  precip: ____ mm  snow: ____  wind: ____
           photo shows: ____________   consistent? Y / N
[Season]   trees: bare / leaf   snow line: ____   crop stage: ____
           consistent with date + zone? Y / N
[Sun]      midday elevation curve plausible for date+lat? Y / N

Converged window: ____________________
Contradictions (falsifiers): ____________________
```

## Pitfalls specific to dating

- **Camera clock drift & wrong time zone** — phones usually sync, but standalone cameras drift
  for months and stay on the owner's home zone abroad. Solve in UTC, convert explicitly.
- **DST seams** — a one-hour error from daylight-saving will throw the shadow-time test by
  exactly 60 min; check whether the claimed date is inside DST for that country.
- **Reanalysis is coarse** — ERA5 is ~0.25° (~28 km) and hourly; a local shower or a single
  convective cloud can exist without showing in the grid. Treat weather as corroboration over a
  *window*, not a per-minute verdict.[^om]
- **Hemisphere flips the season** — leaf-on in July means nothing until you know which
  hemisphere; reconcile with the [sun/shadow hemisphere test](chronolocation.md#hemisphere-from-shadows).
- **Recycled imagery** — before dating anything, reverse-search it; an "old" date may simply be
  the image's true origin resurfacing.[^bc-img]

[^conv]: Triangulating independent, physically-unrelated indicators is the core of open-source verification; see Bellingcat, [*Using the Sun and the Shadows for Geolocation*](https://www.bellingcat.com/resources/2020/12/03/using-the-sun-and-the-shadows-for-geolocation/) and the [verification handbook](https://verificationhandbook.com/).
[^heights]: European Committee for Standardization, EN 1317 road restraint systems; door heights per common ISO building norms. Always measure several objects.
[^om]: Open-Meteo, [Historical Weather API documentation](https://open-meteo.com/en/docs/historical-weather-api) — ERA5 (0.25°, from 1940) and ERA5-Land (0.1°, from 1950) reanalysis.
[^mh17]: Bellingcat (2015), [*MH17 — The Open Source Investigation, One Year On*](https://www.bellingcat.com/news/uk-and-europe/2015/07/15/mh17-the-open-source-investigation-one-year-on/) — convoy timeline fixed by shadow chronolocation independent of testimony.
[^bc-img]: Bellingcat Online Investigation Toolkit, [Search by Image](https://bellingcat.gitbook.io/toolkit/more/all-tools/search-by-image) — TinEye's oldest-first sort exposes recycled images.
