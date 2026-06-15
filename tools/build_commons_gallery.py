#!/usr/bin/env python3
"""GeOSINT - Wikimedia Commons category gallery builder (Phase 3 catalogues).

Builds country-organized reference galleries for "micro-detail" identification
subjects that Commons covers far more exhaustively than any single curated
source: fire hydrants, manhole covers, bus stops, electricity pylons, chevrons,
guardrails. For each topic it walks `<Topic> in <Country>` Commons categories
through the unified resilient client (tools/wikimedia.py), caches a handful of
thumbnails per country into wiki/docs/assets/<topic>/<iso2>/, and writes a wiki
page grouped by continent. Files keep any GPS coordinate as a map link.

Flag-only-style: image + country (+ map link when geotagged). Re-runs skip
already-cached files. Run:

    .venv\\Scripts\\python tools\\build_commons_gallery.py [topic ...]
"""
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wikimedia as wm

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "wiki" / "docs"
PAGES = DOCS / "identify" / "commons"
ASSETS = DOCS / "assets"
PER_COUNTRY = 6                 # thumbnails cached per country (browsable, polite)
THUMB_W = 480

# continent -> [(country display, iso2, Commons "in <X>" suffix if != display)]
# A broad spread for strong country-discrimination value; extend freely.
COUNTRIES = {
    "Europe": [
        ("France", "fr"), ("Germany", "de"), ("United Kingdom", "gb", "the United Kingdom"),
        ("Italy", "it"), ("Spain", "es"), ("Netherlands", "nl", "the Netherlands"),
        ("Switzerland", "ch"), ("Austria", "at"), ("Belgium", "be"), ("Poland", "pl"),
        ("Sweden", "se"), ("Norway", "no"), ("Finland", "fi"), ("Czech Republic", "cz", "the Czech Republic"),
        ("Portugal", "pt"), ("Russia", "ru"), ("Ukraine", "ua"),
    ],
    "Asia": [
        ("Japan", "jp"), ("China", "cn"), ("South Korea", "kr"), ("India", "in"),
        ("Thailand", "th"), ("Indonesia", "id"), ("Turkey", "tr"), ("Israel", "il"),
        ("Taiwan", "tw"),
    ],
    "Africa": [
        ("South Africa", "za"), ("Egypt", "eg"), ("Morocco", "ma"), ("Kenya", "ke"),
        ("Nigeria", "ng"),
    ],
    "North America": [
        ("United States", "us", "the United States"), ("Canada", "ca"), ("Mexico", "mx"),
    ],
    "South America": [
        ("Brazil", "br"), ("Argentina", "ar"), ("Chile", "cl"), ("Colombia", "co"),
    ],
    "Oceania": [("Australia", "au"), ("New Zealand", "nz")],
}

# topic key -> {title, intro, asset dir, category template "{}" = country phrase}
TOPICS = {
    "fire-hydrants": {
        "title": "Fire hydrants", "dir": "hydrants",
        "cat": "Fire hydrants in {}",
        "intro": "Hydrant type, colour and mounting (above-ground pillar vs flush/underground) "
                 "vary sharply by country and even utility — a strong micro-detail tell.",
    },
    "manhole-covers": {
        "title": "Manhole covers", "dir": "manholes",
        "cat": "Manhole covers in {}",
        "intro": "Cover shape, pattern, utility branding and script localise tightly; many carry "
                 "a city name or municipal crest.",
    },
    "bus-stops": {
        "title": "Bus stops & shelters", "dir": "busstops",
        "cat": "Bus stops in {}",
        "intro": "Shelter design, signage, livery and timetable format are regional — and often "
                 "carry an operator name or route network branding.",
    },
    "pylons": {
        "title": "Electricity pylons", "dir": "pylons",
        "cat": "Electricity pylons in {}",
        "intro": "Transmission-tower silhouette (lattice shape, insulator arrangement, crossarm "
                 "style) differs by national grid — complements the utility-poles page.",
    },
    "chevrons": {
        "title": "Chevron signs & guardrails", "dir": "chevrons",
        "cat": "Guardrails in {}",
        "intro": "Crash-barrier/guardrail type and chevron-sign style (colour, count, mounting) "
                 "are country tells on every road — complements road signs & markings.",
    },
}

GALLERY_CSS = (
    "<style>\n"
    ".gh-gallery { display: flex; flex-wrap: wrap; gap: 14px; }\n"
    ".gh-gallery figure { margin: 0; width: 200px; }\n"
    ".gh-gallery img { width: 200px; height: 150px; object-fit: cover; border-radius: 4px; }\n"
    ".gh-gallery figcaption { font-size: .72rem; text-align: center; }\n"
    "</style>\n\n"
)


def ext_of(mime, url):
    return {"image/jpeg": ".jpg", "image/png": ".png", "image/svg+xml": ".svg",
            "image/gif": ".gif", "image/webp": ".webp"}.get(mime) or \
        ("." + url.rsplit(".", 1)[-1].split("?")[0].lower() if "." in url else ".jpg")


def country_phrase(entry):
    # entry = (display, iso2[, commons phrase])
    return entry[2] if len(entry) > 2 else entry[0]


def build_topic(tkey, topic):
    adir = ASSETS / topic["dir"]
    fetched = skipped = failed = 0
    sections = []
    for continent, entries in COUNTRIES.items():
        figs = []
        for entry in entries:
            disp, iso2 = entry[0], entry[1]
            cat = topic["cat"].format(country_phrase(entry))
            try:
                imgs = wm.category_images(cat, limit=PER_COUNTRY * 2, thumb_width=THUMB_W)
            except Exception as e:
                print(f"  WARN {cat}: {e}")
                imgs = []
            kept = 0
            for img in imgs:
                if kept >= PER_COUNTRY:
                    break
                dest = adir / iso2 / f"{iso2}_{kept + 1}{ext_of(img['mime'], img['url'])}"
                if not dest.is_file():
                    try:
                        wm.download(img["url"], dest)
                        fetched += 1
                    except Exception as e:
                        print(f"  FAIL {cat} #{kept+1}: {e}")
                        failed += 1
                        continue
                else:
                    skipped += 1
                # page at /wiki/identify/commons/<x>/ (use_directory_urls)
                # → three levels up to reach /wiki/assets/
                rel = f"../../../assets/{topic['dir']}/{iso2}/{dest.name}"
                cap = disp
                if img.get("lat") is not None:
                    cap += (f' · <a href="/app/index.html#ll={img["lat"]},{img["lon"]}"'
                            f' target="_blank">map</a>')
                figs.append(f'<figure><img src="{rel}" loading="lazy" alt="{topic["title"]} — {disp}">'
                            f"<figcaption>{cap}</figcaption></figure>")
                kept += 1
        if figs:
            sections.append(f'### {continent}\n\n<div class="gh-gallery">\n'
                            + "\n".join(figs) + "\n</div>")

    page = (
        f"# {topic['title']} by country\n\n"
        f"{topic['intro']}\n\n"
        "Reference thumbnails from [Wikimedia Commons](https://commons.wikimedia.org/) "
        "(`" + topic["cat"].format("<country>") + "` categories), cached locally. Where the "
        "source photo is geotagged, a **map** link opens the spot on the workbench.\n\n"
        + GALLERY_CSS + "\n\n".join(sections) + "\n"
    )
    PAGES.mkdir(parents=True, exist_ok=True)
    (PAGES / f"{tkey}.md").write_text(page, encoding="utf-8")
    return fetched, skipped, failed


def write_index(done):
    idx = ["# Micro-detail catalogues (Wikimedia Commons)\n",
           "Country-organized galleries of small but high-discrimination features, sourced from "
           "Wikimedia Commons category trees and cached locally. Flag-only style: image + country "
           "(+ map link when the source photo is geotagged).\n",
           "| Catalogue | Page |", "|---|---|"]
    for tkey in done:
        idx.append(f"| {TOPICS[tkey]['title']} | [{tkey}]({tkey}.md) |")
    PAGES.mkdir(parents=True, exist_ok=True)
    (PAGES / "index.md").write_text("\n".join(idx) + "\n", encoding="utf-8")


def main():
    want = [a for a in sys.argv[1:] if a in TOPICS] or list(TOPICS)
    tot_f = tot_s = tot_x = 0
    for tkey in want:
        print(f"=== {tkey} ===")
        f, s, x = build_topic(tkey, TOPICS[tkey])
        tot_f += f; tot_s += s; tot_x += x
        print(f"  {tkey}: {f} fetched, {s} cached, {x} failed")
    write_index(list(TOPICS))
    print(f"done: {tot_f} fetched, {tot_s} cached, {tot_x} failed across {len(want)} topics")
    return 0


if __name__ == "__main__":
    sys.exit(main())
