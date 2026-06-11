#!/usr/bin/env python3
"""GeOSINT - GeoHints page importer (unified-page mode).

GeoHints (geohints.com) blocks automated crawlers, so this tool never fetches
the site. Instead: open a category page in YOUR browser (e.g.
https://geohints.com/meta/bollards), save it with Ctrl+S into the import/
folder of this project (normal save or the view-source page both work), then:

    .venv\\Scripts\\python tools\\import_geohints.py

Known categories are spliced INTO the matching wiki topic page between
<!-- GEOHINTS:<name> START/END --> markers (re-running replaces the gallery
in place). Unknown categories get a standalone page in wiki/docs/geohints/.

Images are NOT downloaded or copied - the <img> tags point at geohints.com,
so your browser loads them directly from the site when you view the page.

Afterwards rebuild the wiki:  .\\run.ps1 -RebuildWiki
"""
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMPORT_DIR = ROOT / "import"
DOCS = ROOT / "wiki" / "docs"
STANDALONE_DIR = DOCS / "geohints"

# GeoHints category (camelCase, as in the /meta/<name> URL) -> wiki topic page
TARGETS = {
    "architecture": "identify/architecture.md",
    "bollards": "identify/bollards.md",
    "utilityPoles": "identify/utility-poles.md",
    "trafficLights": "identify/traffic-lights.md",
    "sceneries": "identify/vegetation-climate.md",
    "nature": "identify/vegetation-climate.md",
    "flags": "identify/flags.md",
    "licensePlates": "identify/license-plates.md",
    "lines": "identify/road-markings.md",
    "drivingSide": "identify/driving-side.md",
    "cameraGens": "identify/streetview-meta.md",
    "followCars": "identify/streetview-meta.md",
    "rifts": "identify/streetview-meta.md",
    "googleVehicles": "identify/streetview-meta.md",
    "domains": "identify/domains-phones.md",
    "phoneNumbers": "identify/domains-phones.md",
    "houseNumbers": "identify/architecture.md",
    "postBoxes": "identify/architecture.md",
}

TAG = re.compile(r"<[^>]+>")
HEADING = re.compile(r'<div class="text-center text-3xl font-bold">([^<]+)</div>')
BLOCK_SPLIT = re.compile(r'<div class="text-white text-md p-2')
COUNTRY = re.compile(r'<span class="font-bold">\s*([^<]+?)\s*</span>')
IMG = re.compile(r'<img[^>]+src="(https://[^"]*geohints\.com/storage/[^"]+?)"')
MAPS = re.compile(r'<a href="(https://(?:goo\.gl/maps|maps\.app\.goo\.gl)/[^"]+?)"')

GALLERY_CSS = """<style>
.gh-gallery { display: flex; flex-wrap: wrap; gap: 14px; }
.gh-gallery figure { margin: 0; width: 230px; }
.gh-gallery img { width: 230px; border-radius: 4px; }
.gh-gallery figcaption { font-size: .72rem; text-align: center; }
</style>
"""

FOOTER = (
    "\n*Images hotlinked from [GeoHints](https://geohints.com/) - they load directly from "
    "the site in your browser and are not stored in this wiki. Curation credit: the GeoHints "
    "community ([Ko-fi](https://ko-fi.com/mousewithbeer87045)). Street imagery (c) Google. "
    "Requires internet to display.*\n"
)


def decode_view_source(text):
    """Handle pages saved from Chrome's view-source: view, where every line of
    the original document is wrapped in highlight spans with the markup
    HTML-escaped. Stripping the wrapper tags and unescaping the entities
    recovers the original source."""
    if 'class="start-tag"' not in text:
        return text
    return html.unescape(TAG.sub("", text))


def page_name(stem):
    """'https___geohints.com_meta_utilityPoles' -> ('utility-poles', 'utilityPoles')."""
    m = re.search(r"meta[_/]([A-Za-z0-9]+)", stem)
    orig = m.group(1) if m else stem
    kebab = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", orig).lower()
    kebab = re.sub(r"[^a-z0-9_-]", "", kebab) or "page"
    return kebab, orig


def parse(text):
    """Return ordered events: ('heading', name) / ('entry', country, img, maps_or_None)."""
    events = [(m.start(), ("heading", m.group(1).strip())) for m in HEADING.finditer(text)]
    starts = [m.start() for m in BLOCK_SPLIT.finditer(text)]
    for i, s in enumerate(starts):
        chunk = text[s:starts[i + 1] if i + 1 < len(starts) else len(text)]
        c, im = COUNTRY.search(chunk), IMG.search(chunk)
        if not (c and im):
            continue
        mp = MAPS.search(chunk)
        events.append((s, ("entry", html.unescape(c.group(1)).strip(),
                           im.group(1), mp.group(1) if mp else None)))
    events.sort(key=lambda e: e[0])
    return [e[1] for e in events]


def render_fragment(url_name, events, heading_level="###"):
    """Gallery markdown without a page H1 (for splicing into a topic page)."""
    title = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", url_name).title()
    out = [GALLERY_CSS,
           f"## GeoHints photo gallery — {title}\n",
           f"From your browser-saved copy of <https://geohints.com/meta/{url_name}>.\n"]
    open_div, count = False, 0
    for ev in events:
        if ev[0] == "heading":
            if open_div:
                out.append("</div>\n")
            out.append(f"\n{heading_level} {ev[1]}\n")
            out.append('<div class="gh-gallery">')
            open_div = True
        else:
            _, country, img, maps = ev
            if not open_div:
                out.append('<div class="gh-gallery">')
                open_div = True
            cap = (f'{country} · <a href="{maps}" target="_blank">map</a>'
                   if maps else country)
            out.append(f'<figure><img src="{img}" loading="lazy">'
                       f"<figcaption>{cap}</figcaption></figure>")
            count += 1
    if open_div:
        out.append("</div>\n")
    out.append(FOOTER)
    return "\n".join(out), count


def splice(target: Path, key: str, fragment: str):
    """Replace (or append) the marker block for `key` in the target page."""
    start, end = f"<!-- GEOHINTS:{key} START -->", f"<!-- GEOHINTS:{key} END -->"
    block = f"{start}\n\n{fragment}\n{end}"
    text = target.read_text(encoding="utf-8")
    if start in text and end in text:
        pre = text[:text.index(start)]
        post = text[text.index(end) + len(end):]
        text = pre + block + post
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    target.write_text(text, encoding="utf-8")


def main():
    IMPORT_DIR.mkdir(exist_ok=True)
    done, standalone = [], []
    for f in sorted(IMPORT_DIR.glob("*.htm*")):
        events = parse(decode_view_source(f.read_text(encoding="utf-8", errors="replace")))
        kebab, url_name = page_name(f.stem)
        if not any(e[0] == "entry" for e in events):
            print(f"  {f.name}: no image entries recognised - skipped")
            continue
        if url_name in TARGETS:
            target = DOCS / TARGETS[url_name]
            if not target.is_file():
                print(f"  {f.name}: target page {TARGETS[url_name]} missing - skipped")
                continue
            fragment, count = render_fragment(url_name, events)
            splice(target, url_name, fragment)
            done.append((url_name, TARGETS[url_name], count))
            print(f"  {f.name} -> spliced {count} images into {TARGETS[url_name]}")
        else:
            STANDALONE_DIR.mkdir(parents=True, exist_ok=True)
            fragment, count = render_fragment(url_name, events)
            page = f"# {url_name} — GeoHints gallery\n\n" + fragment
            (STANDALONE_DIR / f"{kebab}.md").write_text(page, encoding="utf-8")
            standalone.append((kebab, count))
            print(f"  {f.name} -> standalone wiki/docs/geohints/{kebab}.md ({count} images) "
                  f"- add it to wiki/mkdocs.yml nav")
    print(f"done: {len(done)} spliced, {len(standalone)} standalone. Rebuild the wiki to publish.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
