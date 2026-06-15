# Verification & debunking checklist

A fast, repeatable procedure for the question *"is this image/claim what it says it is?"* —
and for **breaking** it when it isn't. Where [Image verification & EXIF](verification.md)
covers the metadata mechanics and the [Geolocation workflow](workflow.md) and
[Chronolocation cookbook](chronolocation-cookbook.md) cover *where* and *when*, this page is
the **triage and debunking** layer that ties them together.

The default stance is **disconfirmation**: try to prove the claim *false*. A claim that
survives honest attempts to break it is strong; one contradiction is decisive. Record every
check and every negative result — negatives are evidence.[^stance]

## 30-second triage *(do this before any deep work)*

1. **Reverse-search the whole frame and a crop** (Lens · Yandex · Bing · TinEye). If it's
   recycled or older than claimed, you may be done already. TinEye's *oldest-first* sort
   exposes the earliest copy.[^bc-img]
2. **Read the metadata** if present (Image module → EXIF / full ExifTool). Treat as a lead,
   never proof — it is trivially edited.[^exif]
3. **Check the source account**: creation date, history, network, prior posts, whether the
   location/time is *stated* or *assumed by the reader*.
4. **Sniff the caption**: does it assert a place/date the pixels don't actually show? Most
   false imagery is **real but miscaptioned**, not fabricated.

If triage raises a flag, escalate to the full checklist.

## The five pillars

| Pillar | Question | Tools / pages |
|---|---|---|
| **Provenance** | What is the earliest appearance? | reverse search, [archive.org](https://web.archive.org/), TinEye dates |
| **Source** | Who published first, and what's their track record? | account history, network analysis |
| **Location** | Does an independent geolocation agree? | [workflow](workflow.md), satellite/Street View |
| **Time** | Do shadows, weather and season fit the claimed date? | [chronolocation cookbook](chronolocation-cookbook.md) |
| **Plausibility** | Does every element belong (uniforms, plates, signage, tech era)? | identification catalogues |

A claim is only *confirmed* when independent pillars agree; it is *debunked* the moment one
pillar contradicts the claim and the contradiction holds up.[^pillars]

## Disinformation patterns & how to break each

| Pattern | What it is | How to break it |
|---|---|---|
| **Recycled** | An old/unrelated real image presented as current | reverse search + earliest-date; check seasonal/visual anachronisms |
| **Miscaptioned** | Real image, wrong place/date/context attached | geolocate independently; ignore the caption's claim |
| **Staged** | Event real but arranged/performed for the camera | look for crew, repeated takes, inconsistent crowd reactions |
| **Edited** | Cloned, spliced, or object-removed | ELA/clone detection ([Sherloq](https://github.com/GuidoBartoli/sherloq) local, or [FotoForensics](https://fotoforensics.com/) — uploads leave your machine); look for impossible shadows/reflections |
| **AI-generated** | Wholly synthetic | verify the *place* exists as depicted; watch for impossible text/signage, boundary texture, lighting conflicts — **do not trust AI-detector scores**[^aidetect] |
| **Mislabeled scale/lethality** | Real footage, exaggerated framing | cross-source; check independent reporting and original uncropped versions |

## Falsification toolbox *(quick wins that kill many claims)*

- **Shadow vs. clock** — shadow azimuth/length must fit the claimed time at the claimed place
  ([cookbook](chronolocation-cookbook.md)). A 1-hour DST error is a common giveaway.
- **Weather vs. ground** — ERA5 archive (Weather module) for the date: hard shadows on a
  fully-overcast day, or dry ground under claimed heavy rain, is a contradiction.[^om]
- **Season vs. vegetation** — bare deciduous trees in claimed midsummer (or vice-versa), wrong
  snow line for the latitude/date.
- **Hemisphere flip** — sun in the wrong half of the sky for the stated hemisphere.
- **Tech/era anachronism** — a building not yet built (or already demolished) on the claimed
  date: check [Esri Wayback](https://livingatlas.arcgis.com/wayback/) / Google Earth history;
  vehicle, plate, or signage generation inconsistent with the date.
- **Sign/script mismatch** — language, script, plate format, or road markings that don't belong
  to the claimed country (the identification catalogues).

## Honest-analyst guardrails

- **Confirmation bias** — actively seek the disconfirming check, not just corroboration.
- **Absence ≠ proof** — no EXIF, no reverse-search hit, or no manipulation trace proves
  nothing on its own.
- **Precision theatre** — six decimal places or an AI "97% real" score is not accuracy; trust
  convergent physical evidence, not a single confident number.
- **Don't amplify** — when documenting a debunk, avoid republishing the false claim in a way
  that spreads it further; archive rather than link-live where appropriate.
- **State uncertainty** — "consistent with", "cannot be confirmed", "contradicted by" are
  distinct verdicts; use the right one.

## Printable checklist

```
Claim (place / date / context as stated): ____________________

Triage
 [ ] reverse-searched full frame + crop   earliest copy: __________
 [ ] metadata read (EXIF/ExifTool)         GPS/time present? Y/N (spoofable)
 [ ] source account checked                age/history/network: __________
 [ ] caption vs. pixels                    asserts more than shown? Y/N

Pillars
 [ ] Provenance  earliest appearance predates claim?      Y/N
 [ ] Source      first publisher + credibility             ____________
 [ ] Location    independent geolocation agrees?           Y/N
 [ ] Time        shadow + weather + season fit date?       Y/N
 [ ] Plausibility every element belongs (era/country)?     Y/N

Falsifiers found: ____________________________________________
Verdict:  confirmed / consistent-unconfirmed / contradicted / inconclusive
```

[^stance]: The disconfirmation-first stance is standard in professional verification training; see the [Verification Handbook](https://verificationhandbook.com/) and First Draft / DFRLab curricula.
[^bc-img]: Bellingcat Toolkit, [Search by Image](https://bellingcat.gitbook.io/toolkit/more/all-tools/search-by-image); Bellingcat (2019), [*Guide to using reverse image search for investigations*](https://www.bellingcat.com/resources/how-tos/2019/12/26/guide-to-using-reverse-image-search-for-investigations/).
[^exif]: See [Image verification & EXIF](verification.md); EXIF is editable plain text — [ExifTool](https://exiftool.org/) reads and writes it.
[^pillars]: First Draft News, [*Verifying photos and videos*](https://firstdraftnews.org/articles/verifying-photos-videos/); DFRLab methodology.
[^aidetect]: Detector classifiers are unreliable and adversarially fragile; geographic/physical verification is more robust. Cf. discussion in current OSINT practice and the [C2PA](https://c2pa.org/) provenance approach.
[^om]: Open-Meteo, [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) — ERA5 reanalysis from 1940.
