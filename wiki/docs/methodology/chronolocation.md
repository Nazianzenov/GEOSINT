# Chronolocation — sun & shadows

Determining **when** an image was taken (or proving a claimed time false) from the sun's
position. The physics is exact: for a given place, date and time, the sun's azimuth and
elevation are fully determined.[^astro]

## The two measurables

| Measurement | What it gives you |
|---|---|
| **Shadow direction** (azimuth the shadow points) | Sun azimuth = shadow azimuth + 180°. Combined with a date, this pins the time of day; combined with a time it constrains longitude/latitude. |
| **Shadow length ÷ object height** | Sun elevation: `elevation = atan(height / shadow_length)`. A 1.8 m person casting a 1.8 m shadow ⇒ sun at 45°. |

Both are implemented in the Workbench **Sun module** (including the reverse "shadow solver").
The underlying library is [SunCalc](https://github.com/mourner/suncalc) (BSD-2), which
implements the algorithms from Astronomy Answers.[^suncalc]

## Hemisphere from shadows

At local midday the sun is due **south** in the northern hemisphere (shadows point north) and
due **north** in the southern hemisphere (shadows point south). Between the tropics it varies
with season.[^noaa] This single observation halves the planet.

## Workflow

1. Find a vertical object with a clean shadow (pole, person, fence post).
2. Estimate shadow azimuth from map-aligned features in the image (a street you've identified,
   building edges). North in Street View's compass, or measure on satellite imagery.
3. Estimate the height ratio. People ≈ 1.7–1.8 m; standard doors ≈ 2.0–2.1 m; guardrail
   posts ≈ 0.75 m (EU EN 1317 systems vary).[^heights]
4. Enter both in the Sun module's shadow solver → it returns the time window(s) on the
   claimed date that match, or **no match** (claim falsified).
5. Cross-check in [suncalc.org](https://www.suncalc.org/) and
   [ShadeMap](https://shademap.app/) (terrain + building shadows in 3-D).

## Worked example (classic Bellingcat method)

The MH17 Buk convoy videos were chronolocated by comparing shadow angles of lamp posts and
trees against SunCalc outputs for the claimed routes and dates — confirming the convoy's
timeline independent of any testimony.[^mh17]

## Pitfalls

- **Time zones & DST**: cameras record local time, EXIF `OffsetTimeOriginal` is often absent.
  Always work in UTC and convert explicitly (the Sun module's UTC-offset selector exists for
  this reason).
- **Sloped ground** stretches or shortens shadows — prefer shadows falling on flat paving.
- **Wide-angle distortion** bends lines near frame edges; measure near the image centre.
- **Reflected/diffuse light** under overcast gives soft shadows — combine with the Weather
  module: heavy overcast on the claimed date + crisp shadows in the photo = inconsistency.

[^astro]: Meeus, J. (1998). *Astronomical Algorithms*, 2nd ed. Willmann-Bell. The standard reference for solar position computation.
[^suncalc]: Mourner/SunCalc, [github.com/mourner/suncalc](https://github.com/mourner/suncalc); formulas from [Astronomy Answers: Position of the Sun](https://www.aa.quae.nl/en/reken/zonpositie.html).
[^noaa]: NOAA GML, [Solar Calculator](https://gml.noaa.gov/grad/solcalc/) and its [calculation details](https://gml.noaa.gov/grad/solcalc/calcdetails.html).
[^heights]: European Committee for Standardization, EN 1317 road restraint systems; typical door height per ISO building norms. Use several objects, never just one.
[^mh17]: Bellingcat (2015), [*MH17 — The Open Source Investigation, One Year On*](https://www.bellingcat.com/news/uk-and-europe/2015/07/15/mh17-the-open-source-investigation-one-year-on/); see also the Bellingcat guide [*Shadows and chronolocation*](https://www.bellingcat.com/resources/2020/12/03/using-the-sun-and-the-shadows-for-geolocation/).
