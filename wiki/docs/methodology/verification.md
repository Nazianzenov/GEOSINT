# Image verification & EXIF

## Metadata (EXIF) — what to pull

The Workbench **Image module** parses these locally (via [exifr](https://github.com/MikeKovarik/exifr), MIT):

| Field | Use | Caveat |
|---|---|---|
| `GPSLatitude/Longitude` | Direct position | Easily spoofed/edited; phones can lag fix |
| `GPSImgDirection` | Compass bearing the camera faced | Magnetic vs true north ambiguity |
| `DateTimeOriginal` (+`OffsetTimeOriginal`) | Capture time | Camera clock drift; timezone often missing |
| `Make`/`Model`, `LensModel` | Device — cross-check against claimed source | |
| `Software` | Editing traces ("Adobe Photoshop…") | Absence ≠ unedited |

**EXIF is a lead, never proof.** It is plain text inside the file and trivially editable with
free tools.[^exiftool]

## Platform behaviour (what survives upload)

- **Strip EXIF**: X/Twitter, Facebook, Instagram, Telegram (photo mode), Reddit, most CDNs.[^strip]
- **May retain**: email attachments, Telegram/WhatsApp "send as file", direct file hosting,
  some forums and cloud links.

## Reverse image search — engine strengths

Documented engine-by-engine comparison in Bellingcat's guide:[^bc-img]

| Engine | Strength |
|---|---|
| **Google Lens** | Best global object/scene matching; crops; OCR + translate on signs |
| **Yandex Images** | Strongest for faces and for Eastern Europe / ex-USSR scenes |
| **Bing Visual Search** | Decent object match, different index than Google |
| **TinEye** | Exact-match crawler with **first-seen dates** — proves an image is recycled |

Always search **crops** of distinctive elements (a building, a sign) as well as the full frame.

## Detecting manipulation & AI generation

- Error-level analysis & clone detection: [FotoForensics](https://fotoforensics.com/)
  (uploads leave your machine), or locally [Sherloq](https://github.com/GuidoBartoli/sherloq)
  (open-source forensic toolset).[^sherloq]
- AI-image tells (as of 2025-26): texture inconsistency at boundaries, impossible
  text/signage, lighting direction conflicts — but **classifiers are unreliable; verify
  geographically instead** (does the place actually exist as depicted?).
- C2PA/Content Credentials may carry a signed provenance chain when present.[^c2pa]

## The verification checklist

1. **Provenance** — earliest appearance (TinEye/Lens date filters, archive.org).
2. **Source** — who posted first, what else did they post, stated vs. inferred location.
3. **Location** — independent geolocation (this wiki's workflow).
4. **Time** — chronolocation + weather + seasonal cross-check.
5. **Plausibility** — does every element fit (uniforms, vehicles, plates, signage era)?

This is the structure of the "5 pillars" used in professional verification training
(First Draft / DFRLab curricula).[^firstdraft]

[^exiftool]: Harvey, P. [ExifTool documentation](https://exiftool.org/) — the reference implementation for reading/writing EXIF.
[^strip]: Reviewed in: Bellingcat, [*Debunking false information guide*](https://www.bellingcat.com/resources/2021/08/13/debunk-fake-image-video-guide/); IPTC, [*Social media sites photo metadata test results*](https://iptc.org/standards/photo-metadata/social-media-sites-photo-metadata-test-results/).
[^bc-img]: Bellingcat Toolkit, [Search by Image](https://bellingcat.gitbook.io/toolkit/more/all-tools/search-by-image); Bellingcat (2019), [*Guide to using reverse image search for investigations*](https://www.bellingcat.com/resources/how-tos/2019/12/26/guide-to-using-reverse-image-search-for-investigations/) — documents Yandex's edge on faces/locations.
[^sherloq]: Bartoli, G. [Sherloq — open-source image forensics](https://github.com/GuidoBartoli/sherloq).
[^c2pa]: Coalition for Content Provenance and Authenticity, [C2PA specification](https://c2pa.org/specifications/specifications/1.3/specs/C2PA_Specification.html).
[^firstdraft]: First Draft News, [*Verifying photos and videos*](https://firstdraftnews.org/articles/verifying-photos-videos/) (archived); DFRLab methodology posts.
