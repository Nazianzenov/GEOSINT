#!/usr/bin/env python3
"""GeOSINT - wiki search index builder.

Extracts every atomic piece of wiki information into a tagged "card" and
writes app/data/search-index.json for the client-side search engine
(app/search.html, MiniSearch).

Card schema:
  id        stable integer
  t         title (short)
  x         text body (searchable)
  c         [countries]           (canonical names)
  k         continent             (Africa/Asia/Europe/North America/Oceania/South America)
  g         category key          (bollards, utility-poles, country-facts, recognition, ...)
  img       image URL/path        (optional; relative paths are wiki-rooted)
  map       street-view source    (optional)
  page      wiki page URL (with anchor where possible)
  ll        [lat, lng]            (optional, landmarks)

Tagging is derived from the structure itself: GeoHints gallery captions carry
the country, gallery ### headings carry the continent, bold-leading table
rows / bullets carry the country, and the page a card lives on carries its
category. Run:  .venv\\Scripts\\python tools\\build_search_index.py
"""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "wiki" / "docs"
DATA_DIR = ROOT / "data"
OUT = ROOT / "app" / "data" / "search-index.json"
GRAPH_OUT = ROOT / "app" / "data" / "graph.json"
WM_MANIFEST = ROOT / "wiki" / "wm_manifest.json"

# dataset file -> (category key, label, wiki summary page)
DATASETS = {
    "unesco": ("unesco", "UNESCO sites", "/wiki/data/unesco/"),
    "national-parks": ("national-parks", "National parks", "/wiki/data/national-parks/"),
    "castles": ("castles", "Castles & palaces", "/wiki/data/castles/"),
    "airports": ("airports", "Airports", "/wiki/data/airports/"),
}

CONTINENTS = ["Africa", "Asia", "Europe", "North America", "Oceania", "South America"]

# page stem -> category key (also used as the display grouping)
PAGE_CATEGORY = {
    "bollards": "bollards", "utility-poles": "utility-poles", "architecture": "architecture",
    "traffic-lights": "traffic-lights", "flags": "flags", "vegetation-climate": "vegetation-climate",
    "license-plates": "license-plates", "road-markings": "road-markings", "road-signs": "road-signs",
    "driving-side": "driving-side", "language-scripts": "language-scripts",
    "domains-phones": "domains-phones", "streetview-meta": "streetview-meta",
}
GEOHINTS_KEY = {  # marker key -> category key
    "bollards": "bollards", "utilityPoles": "utility-poles", "architecture": "architecture",
    "trafficLights": "traffic-lights", "flags": "flags", "sceneries": "sceneries",
    "nature": "sceneries", "licensePlates": "license-plates", "lines": "road-markings",
    "houseNumbers": "architecture", "postBoxes": "architecture",
    "cameraGens": "streetview-meta", "followCars": "streetview-meta",
}
CATEGORY_LABEL = {
    "bollards": "Bollards", "utility-poles": "Utility poles", "architecture": "Architecture",
    "traffic-lights": "Traffic lights", "flags": "Flags", "sceneries": "Scenery",
    "vegetation-climate": "Vegetation & climate", "license-plates": "License plates",
    "road-markings": "Road markings", "road-signs": "Road signs", "driving-side": "Driving side",
    "language-scripts": "Languages & scripts", "domains-phones": "Domains & phones",
    "streetview-meta": "Street View meta", "country-facts": "Country quick facts",
    "recognition": "Country recognition", "landmarks": "Landmarks",
    "methodology": "Methodology", "page": "Wiki pages",
    "unesco": "UNESCO sites", "national-parks": "National parks",
    "castles": "Castles & palaces", "airports": "Airports", "flora": "Botanical",
}

# canonicalization of multi-name cells; extended by the flags gallery at runtime
CANON = {
    "uk": "United Kingdom", "usa": "United States", "us": "United States",
    "nz": "New Zealand", "uae": "United Arab Emirates", "drc": "DR Congo",
    "czech republic": "Czechia", "ivory coast": "Côte d'Ivoire",
    "cabo verde": "Cape Verde", "burma": "Myanmar",
}

# demonyms / adjectives -> country (used by the client query parser)
DEMONYMS = {
    "french": "France", "german": "Germany", "dutch": "Netherlands", "belgian": "Belgium",
    "spanish": "Spain", "portuguese": "Portugal", "italian": "Italy", "swiss": "Switzerland",
    "austrian": "Austria", "polish": "Poland", "czech": "Czechia", "slovak": "Slovakia",
    "hungarian": "Hungary", "romanian": "Romania", "bulgarian": "Bulgaria", "greek": "Greece",
    "turkish": "Turkey", "swedish": "Sweden", "norwegian": "Norway", "danish": "Denmark",
    "finnish": "Finland", "icelandic": "Iceland", "estonian": "Estonia", "latvian": "Latvia",
    "lithuanian": "Lithuania", "ukrainian": "Ukraine", "russian": "Russia",
    "british": "United Kingdom", "english": "United Kingdom", "scottish": "United Kingdom",
    "irish": "Ireland", "american": "United States", "canadian": "Canada", "mexican": "Mexico",
    "brazilian": "Brazil", "argentine": "Argentina", "argentinian": "Argentina",
    "chilean": "Chile", "colombian": "Colombia", "peruvian": "Peru", "bolivian": "Bolivia",
    "japanese": "Japan", "korean": "South Korea", "chinese": "China", "taiwanese": "Taiwan",
    "indian": "India", "pakistani": "Pakistan", "bangladeshi": "Bangladesh",
    "thai": "Thailand", "vietnamese": "Vietnam", "cambodian": "Cambodia", "laotian": "Laos",
    "indonesian": "Indonesia", "malaysian": "Malaysia", "filipino": "Philippines",
    "philippine": "Philippines", "mongolian": "Mongolia", "kazakh": "Kazakhstan",
    "israeli": "Israel", "saudi": "Saudi Arabia", "emirati": "United Arab Emirates",
    "egyptian": "Egypt", "moroccan": "Morocco", "tunisian": "Tunisia", "kenyan": "Kenya",
    "nigerian": "Nigeria", "ghanaian": "Ghana", "ethiopian": "Ethiopia",
    "south african": "South Africa", "malagasy": "Madagascar",
    "australian": "Australia", "aussie": "Australia",
    "andorran": "Andorra", "maltese": "Malta", "monacan": "Monaco", "cypriot": "Cyprus",
    "albanian": "Albania", "serbian": "Serbia", "croatian": "Croatia", "slovenian": "Slovenia",
    "bosnian": "Bosnia & Herzegovina", "belarusian": "Belarus", "moldovan": "Moldova",
    "georgian": "Georgia", "armenian": "Armenia", "azerbaijani": "Azerbaijan",
}
CONTINENT_ALIAS = {
    "asian": "Asia", "asia": "Asia",
    "european": "Europe", "europe": "Europe",
    "african": "Africa", "africa": "Africa",
    "north american": "North America", "north america": "North America",
    "central america": "North America", "caribbean": "North America",
    "south american": "South America", "south america": "South America",
    "latin america": "South America",
    "oceania": "Oceania", "oceanian": "Oceania", "pacific": "Oceania",
}
CATEGORY_ALIAS = {
    "bollard": "bollards", "bollards": "bollards", "delineator": "bollards",
    "pole": "utility-poles", "poles": "utility-poles", "utility pole": "utility-poles",
    "utility poles": "utility-poles", "pylon": "utility-poles", "lamp post": "utility-poles",
    "lamppost": "utility-poles", "street light": "utility-poles", "streetlight": "utility-poles",
    "traffic light": "traffic-lights", "traffic lights": "traffic-lights",
    "signal": "traffic-lights", "stoplight": "traffic-lights",
    "flag": "flags", "flags": "flags",
    "scenery": "sceneries", "sceneries": "sceneries", "landscape": "sceneries",
    "landscapes": "sceneries", "terrain": "sceneries",
    "architecture": "architecture", "building": "architecture", "buildings": "architecture",
    "house": "architecture", "houses": "architecture",
    "plate": "license-plates", "plates": "license-plates", "license plate": "license-plates",
    "license plates": "license-plates", "licence plate": "license-plates",
    "registration": "license-plates", "numberplate": "license-plates",
    "road line": "road-markings", "road lines": "road-markings", "lines": "road-markings",
    "marking": "road-markings", "markings": "road-markings", "centerline": "road-markings",
    "sign": "road-signs", "signs": "road-signs", "chevron": "road-signs",
    "chevrons": "road-signs", "stop sign": "road-signs",
    "driving side": "driving-side", "driving": "driving-side", "lht": "driving-side",
    "rht": "driving-side", "left hand": "driving-side", "right hand": "driving-side",
    "language": "language-scripts", "languages": "language-scripts", "script": "language-scripts",
    "scripts": "language-scripts", "alphabet": "language-scripts", "cyrillic": "language-scripts",
    "domain": "domains-phones", "domains": "domains-phones", "tld": "domains-phones",
    "phone": "domains-phones", "phones": "domains-phones", "calling code": "domains-phones",
    "camera": "streetview-meta", "google car": "streetview-meta",
    "street view": "streetview-meta", "coverage": "streetview-meta",
    "vegetation": "vegetation-climate", "climate": "vegetation-climate",
    "koppen": "vegetation-climate", "köppen": "vegetation-climate", "tree": "vegetation-climate",
    "trees": "vegetation-climate", "plants": "vegetation-climate",
    "landmark": "landmarks", "landmarks": "landmarks", "mountain": "landmarks",
    "mountains": "landmarks", "tower": "landmarks", "bridge": "landmarks",
    "facts": "country-facts", "recognition": "recognition",
    "unesco": "unesco", "heritage": "unesco", "world heritage": "unesco",
    "park": "national-parks", "parks": "national-parks", "national park": "national-parks",
    "national parks": "national-parks",
    "castle": "castles", "castles": "castles", "palace": "castles", "palaces": "castles",
    "airport": "airports", "airports": "airports", "airfield": "airports",
    "flora": "flora", "tree": "flora", "trees": "flora", "plant": "flora",
    "plants": "flora", "species": "flora", "botanical": "flora",
}

FIG_RE = re.compile(
    r'<figure><img src="([^"]+)"[^>]*><figcaption>(.*?)</figcaption></figure>', re.S)
CAP_RE = re.compile(r'^\s*(.*?)\s*(?:·\s*<a href="([^"]+)"[^>]*>map</a>)?\s*$', re.S)
MARKER_RE = re.compile(r"<!-- GEOHINTS:(\w+) START -->(.*?)<!-- GEOHINTS:\1 END -->", re.S)
H3_RE = re.compile(r"^### (.+)$", re.M)
MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
BOLD_ROW_RE = re.compile(r"^\|\s*\*\*(.+?)\*\*[^|]*\|(.+)\|\s*$", re.M)
BULLET_RE = re.compile(r"^- \*\*(.+?)\*\*[^:]*:\s*(.+)$", re.M)
COORD_RE = re.compile(r"(-?\d{1,2}\.\d{2,}),\s*(-?\d{1,3}\.\d{2,})")


def strip_md(text):
    text = re.sub(r"\[\^[^\]]+\]", "", text)              # footnote refs
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links -> label
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[*_`#|]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def page_url(md: Path, anchor=""):
    rel = md.relative_to(DOCS).with_suffix("")
    url = "/wiki/" + rel.as_posix().replace("index", "") + "/"
    url = url.replace("//", "/")
    return url + (f"#{anchor}" if anchor else "")


class Indexer:
    def __init__(self):
        self.cards = []
        self.country_continent = {}

    def add(self, **kw):
        kw.setdefault("c", [])
        self.cards.append({"id": len(self.cards), **{k: v for k, v in kw.items() if v}})

    def canon(self, name):
        name = strip_md(name).strip(" .")
        name = re.sub(r"\s*\(.*?\)\s*", "", name).strip()
        return CANON.get(name.lower(), name)

    def split_countries(self, cell):
        """'Russia / Ukraine / CIS' -> known countries found in the cell."""
        parts = re.split(r"\s*(?:/|,|&| and | vs\.? )\s*", strip_md(cell))
        out = []
        for p in parts:
            p = self.canon(p)
            if p in self.country_continent:
                out.append(p)
        return out

    # ── extractors ────────────────────────────────────────────────────
    def galleries(self, md, text):
        for m in MARKER_RE.finditer(text):
            cat = GEOHINTS_KEY.get(m.group(1), PAGE_CATEGORY.get(md.stem, "page"))
            body = m.group(2)
            # walk continent sections in order
            pos = [(h.start(), h.group(1).strip()) for h in H3_RE.finditer(body)]
            for i, (start, continent) in enumerate(pos):
                chunk = body[start:pos[i + 1][0] if i + 1 < len(pos) else len(body)]
                for img, cap in FIG_RE.findall(chunk):
                    cm = CAP_RE.match(cap.strip())
                    country = self.canon(cm.group(1))
                    if country and continent in CONTINENTS:
                        self.country_continent.setdefault(country, continent)
                    self.add(t=f"{country} — {CATEGORY_LABEL.get(cat, cat)}",
                             x=f"{country} {CATEGORY_LABEL.get(cat, cat)} photo",
                             c=[country], k=continent if continent in CONTINENTS else None,
                             g=cat, img=img, map=cm.group(2),
                             page=page_url(md))

    def md_images(self, md, text):
        cat = PAGE_CATEGORY.get(md.stem) or ("landmarks" if md.parent.name == "landmarks" else None)
        if not cat:
            return
        clean = MARKER_RE.sub("", text)
        for alt, src in MD_IMG_RE.findall(clean):
            if "assets/" not in src:
                continue
            words = strip_md(alt)
            countries = self.split_countries(words)
            low = words.lower()
            for d, ctry in DEMONYMS.items():
                if d in low and ctry in self.country_continent:
                    countries.append(ctry)
            countries = sorted(set(countries))
            self.add(t=words or md.stem, x=f"{words} photo",
                     c=countries,
                     k=self.country_continent.get(countries[0]) if countries else None,
                     g=cat, img=src.replace("../", "/wiki/").replace("assets/", "assets/")
                     if src.startswith("../") else "/wiki/" + src,
                     page=page_url(md))

    def world_index_table(self, md, text):
        for m in re.finditer(r"^\|\s*([A-ZÅ][^|*]+?)\s*\|\s*(\*\*Left\*\*|Left|Right|Right\*)\s*\|"
                             r"\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|", text, re.M):
            country = self.canon(m.group(1))
            drives = strip_md(m.group(2))
            self.add(t=country,
                     x=f"{country} drives {drives} · {strip_md(m.group(3))} · "
                       f"{strip_md(m.group(4))} · {strip_md(m.group(5))}",
                     c=[country], k=self.country_continent.get(country),
                     g="country-facts", page=page_url(md))

    def bold_entries(self, md, text, cat, continent=None):
        clean = MARKER_RE.sub("", text)
        for m in BOLD_ROW_RE.finditer(clean):
            countries = self.split_countries(m.group(1)) or self.split_countries(m.group(2))
            body = strip_md(m.group(2))
            if not body or len(body) < 8:
                continue
            title = strip_md(m.group(1))
            for ctry in countries:
                if continent and ctry not in self.country_continent:
                    self.country_continent[ctry] = continent
            self.add(t=title if countries else f"{title}",
                     x=body, c=sorted(set(countries)),
                     k=continent or (self.country_continent.get(countries[0]) if countries else None),
                     g=cat, page=page_url(md))
        for m in BULLET_RE.finditer(clean):
            countries = self.split_countries(m.group(1))
            body = strip_md(m.group(2))
            if not body:
                continue
            for ctry in countries:
                if continent and ctry not in self.country_continent:
                    self.country_continent[ctry] = continent
            self.add(t=strip_md(m.group(1)), x=body, c=sorted(set(countries)),
                     k=continent or (self.country_continent.get(countries[0]) if countries else None),
                     g=cat, page=page_url(md))

    def landmarks(self, md, text):
        for m in re.finditer(r"^\|\s*([^|]+?)\s*\|\s*([^|]*?(-?\d{1,2}\.\d{2,})[ ,]+"
                             r"(-?\d{1,3}\.\d{2,}))[^|]*\|\s*([^|]+)\|", text, re.M):
            name = strip_md(m.group(1))
            if not name or name.lower().startswith(("landmark", "structure", "---")):
                continue
            self.add(t=name, x=f"{name} {strip_md(m.group(2))} {strip_md(m.group(5))}",
                     c=self.split_countries(m.group(1)),
                     g="landmarks", ll=[float(m.group(3)), float(m.group(4))],
                     page=page_url(md))

    def page_card(self, md, text):
        title = re.search(r"^# (.+)$", text, re.M)
        para = re.search(r"^#[^\n]+\n+([^#|<!\n][^\n]+)", text, re.M)
        if title:
            self.add(t=strip_md(title.group(1)),
                     x=strip_md(para.group(1)) if para else "",
                     g="page", page=page_url(md))

    def datasets(self):
        """Ingest data/*.json coordinate datasets (UNESCO, parks, castles, airports)."""
        for fname, (g, label, page) in DATASETS.items():
            f = DATA_DIR / f"{fname}.json"
            if not f.is_file():
                continue
            d = json.loads(f.read_text(encoding="utf-8"))
            for r in d["rows"]:
                country = self.canon(r.get("c") or "") or None
                if country:
                    self.country_continent.setdefault(country, None)
                self.add(t=r["n"], x=f'{r["n"]} {country or ""} {r.get("x", "")} {label}',
                         c=[country] if country else [],
                         k=self.country_continent.get(country),
                         g=g, ll=[r["lat"], r["lng"]], page=r.get("url"))

    def flora(self):
        f = DATA_DIR / "flora.json"
        if not f.is_file():
            return
        wm = json.loads(WM_MANIFEST.read_text(encoding="utf-8")) if WM_MANIFEST.is_file() else {}
        localize = {url: "/wiki/assets/wm/" + meta["file"] for url, meta in wm.items()}
        slug = lambda gr: re.sub(r"[^a-z]+", "-", gr.lower()).strip("-")
        for s in json.loads(f.read_text(encoding="utf-8"))["species"]:
            img = s.get("img")
            self.add(t=f'{s["common"]} ({s["sci"]})',
                     x=f'{s["common"]} {s["sci"]} {s["hint"]} {s.get("summary", "")[:200]}',
                     g="flora", img=localize.get(img, img),
                     map=(f'/app/index.html#species={s["gbif"]}&name='
                          f'{s["common"].replace(" ", "%20")}') if s.get("gbif") else None,
                     page=f"/wiki/flora/{slug(s['group'])}/")

    def graph(self):
        """Country × category data for the matrix + ego-explorer views.
        A global force graph of this (dense, near-bipartite) data is a
        hairball by construction — so we ship the matrix instead."""
        cat_count, country_count, cc = {}, {}, {}
        for card in self.cards:
            g = card["g"]
            if g == "page":
                continue
            cat_count[g] = cat_count.get(g, 0) + 1
            for ctry in card.get("c", []):
                country_count[ctry] = country_count.get(ctry, 0) + 1
                cc.setdefault(ctry, {})[g] = cc.setdefault(ctry, {}).get(g, 0) + 1
        ranked = sorted(country_count.items(), key=lambda x: -x[1])
        out = {
            "categories": [{"g": g, "label": CATEGORY_LABEL.get(g, g), "total": n}
                           for g, n in sorted(cat_count.items(), key=lambda x: -x[1])],
            "countries": [{"n": c, "k": self.country_continent.get(c), "total": n}
                          for c, n in ranked],          # all; matrix slices client-side
            "counts": cc,
        }
        GRAPH_OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        print(f"graph data: {len(out['countries'])} countries × "
              f"{len(out['categories'])} categories -> {GRAPH_OUT}")

    # ── driver ────────────────────────────────────────────────────────
    def run(self):
        files = {p.relative_to(DOCS).as_posix(): p for p in DOCS.rglob("*.md")}
        # pass 1: flags + galleries bootstrap the country->continent map
        for rel, md in files.items():
            self.galleries(md, md.read_text(encoding="utf-8"))
        # pass 2: everything else
        for rel, md in files.items():
            text = md.read_text(encoding="utf-8")
            self.page_card(md, text)
            if rel == "world/index.md":
                self.world_index_table(md, text)
            elif rel.startswith("world/"):
                cont = {"europe": "Europe", "asia": "Asia", "africa": "Africa",
                        "north-america": "North America", "south-america": "South America",
                        "oceania": "Oceania"}.get(md.stem)
                self.bold_entries(md, text, "recognition", cont)
            elif rel.startswith("landmarks/"):
                self.landmarks(md, text)
                self.md_images(md, text)
            elif rel.startswith("identify/"):
                self.bold_entries(md, text, PAGE_CATEGORY.get(md.stem, "page"))
                self.md_images(md, text)
        self.datasets()
        self.flora()
        out = {
            "cards": self.cards,
            "countries": self.country_continent,
            "aliases": {"demonyms": DEMONYMS, "continents": CONTINENT_ALIAS,
                        "categories": CATEGORY_ALIAS},
            "labels": CATEGORY_LABEL,
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        self.graph()
        cats = {}
        for c in self.cards:
            cats[c["g"]] = cats.get(c["g"], 0) + 1
        print(f"{len(self.cards)} cards, {len(self.country_continent)} countries -> {OUT}")
        for g, n in sorted(cats.items(), key=lambda x: -x[1]):
            print(f"  {g:<20} {n}")
        return 0


if __name__ == "__main__":
    sys.exit(Indexer().run())
