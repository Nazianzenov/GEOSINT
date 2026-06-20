#!/usr/bin/env python3
"""GeOSINT - open dataset fetcher (cached, 30-day TTL).

Pulls free/openly-licensed coordinate datasets into data/*.json and generates
summary wiki pages. The smart search index ingests every row as a card with
coordinates, so the datasets are navigable through search + map.

Sources (all permit local non-commercial use):
  - Wikidata SPARQL (CC0): UNESCO World Heritage sites, national parks,
    notable castles & palaces
  - OurAirports (public domain CSV): large + medium airports

Run:  .venv\\Scripts\\python tools\\fetch_datasets.py [--force]
"""
import argparse
import csv
import io
import json
import re
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import net                                  # shared polite HTTP layer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WIKI_DATA = ROOT / "wiki" / "docs" / "data"
TTL = timedelta(days=30)
# QLever's Wikidata mirror first (fast, generous limits); WDQS as fallback.
SPARQL_ENDPOINTS = [
    "https://qlever.cs.uni-freiburg.de/api/wikidata",
    "https://query.wikidata.org/sparql",
]
# QLever requires explicit prefix declarations (WDQS provides them implicitly);
# prepend these so the same query text works on both endpoints.
PREFIXES = ("PREFIX wd: <http://www.wikidata.org/entity/> "
            "PREFIX wdt: <http://www.wikidata.org/prop/direct/> "
            "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> "
            "PREFIX schema: <http://schema.org/> ")

CANON = {
    "united states of america": "United States", "people's republic of china": "China",
    "united kingdom of great britain and northern ireland": "United Kingdom",
    "kingdom of the netherlands": "Netherlands", "czech republic": "Czechia",
    "democratic republic of the congo": "DR Congo", "republic of the congo": "Congo",
}

QUERIES = {
    "unesco": {
        "label": "UNESCO World Heritage sites",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (P1435 = Q9259)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P1435 wd:Q9259; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }""",
    },
    "national-parks": {
        "label": "National parks",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (P31 = Q46169)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31 wd:Q46169; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 9000""",
    },
    "castles": {
        "label": "Notable castles & palaces",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (castles/palaces, >=20 sitelinks)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 VALUES ?cls { wd:Q23413 wd:Q16560 wd:Q751876 }
                 ?item wdt:P31 ?cls; wdt:P625 ?coord; wdt:P1435 ?heritage;
                       rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 6000""",
    },
    "lighthouses": {
        "label": "Lighthouses",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (P31 = Q39715)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31 wd:Q39715; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 9000""",
    },
    "stadiums": {
        "label": "Stadiums & arenas",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (stadium subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q483110; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 12000""",
    },
    "dams": {
        "label": "Dams & reservoirs",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (dam subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q12323; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 9000""",
    },
    "universities": {
        "label": "Universities",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (university subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q3918; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 15000""",
    },
    # notable instances of the OSM Data-layer presets (the live Overpass presets
    # stay for "what's in view"; these add searchable, named global coverage).
    "power-plants": {
        "label": "Power plants",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (power station subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q159719; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 8000""",
    },
    "mines": {
        "label": "Mines & quarries",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (mine subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q820477; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 6000""",
    },
    "railway-stations": {
        "label": "Railway stations",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (railway station subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q55488; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 18000""",
    },
    "hospitals": {
        "label": "Hospitals",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (hospital subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q16917; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 10000""",
    },
    "worship": {
        "label": "Places of worship",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (place-of-worship subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q1370598; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 18000""",
    },
    "military": {
        "label": "Military bases",
        "license": "Wikidata, CC0",
        "source": "https://query.wikidata.org/ (military installation subclasses, en-wiki article)",
        "q": """SELECT DISTINCT ?item ?itemLabel ?coord ?countryLabel WHERE {
                 ?item wdt:P31/wdt:P279* wd:Q245016; wdt:P625 ?coord; rdfs:label ?itemLabel.
                 ?article schema:about ?item;
                          schema:isPartOf <https://en.wikipedia.org/>.
                 FILTER(LANG(?itemLabel)="en")
                 OPTIONAL { ?item wdt:P17 ?country.
                            ?country rdfs:label ?countryLabel.
                            FILTER(LANG(?countryLabel)="en") } }
                 LIMIT 7000""",
    },
}

# WDQS emits "Point(lng lat)", QLever emits "POINT(lng lat)" — match either.
POINT_RE = re.compile(r"point\(([-\d.]+) ([-\d.]+)\)", re.IGNORECASE)


def fresh(path):
    if not path.is_file():
        return False
    meta = json.loads(path.read_text(encoding="utf-8"))
    return datetime.now(timezone.utc) - datetime.fromisoformat(meta["fetched"]) < TTL


def http_get(url, accept=None):
    """Fetch via the shared polite layer (long timeout for big SPARQL pulls)."""
    data, _ = net.get(url, timeout=180, accept=accept)
    return data


def canon_country(label):
    if not label:
        return None
    return CANON.get(label.lower(), label)


def fetch_wikidata(key, spec):
    raw = None
    for ep in SPARQL_ENDPOINTS:
        url = ep + "?format=json&query=" + urllib.parse.quote(PREFIXES + spec["q"])
        try:
            raw = json.loads(http_get(url, accept="application/sparql-results+json"))
            break
        except Exception as e:
            print(f"  endpoint {ep.split('/')[2]} failed ({e}); trying next")
    if raw is None:
        raise RuntimeError(f"all SPARQL endpoints failed for {key}")
    rows, seen = [], set()
    for b in raw["results"]["bindings"]:
        qid = b["item"]["value"].rsplit("/", 1)[-1]
        if qid in seen:
            continue
        seen.add(qid)
        m = POINT_RE.match(b["coord"]["value"])
        if not m:
            continue
        name = b.get("itemLabel", {}).get("value", qid)
        if re.fullmatch(r"Q\d+", name):
            continue                       # label fell back to the QID
        rows.append({
            "n": name,
            "lat": round(float(m.group(2)), 5), "lng": round(float(m.group(1)), 5),
            "c": canon_country(b.get("countryLabel", {}).get("value")),
            "url": "https://www.wikidata.org/wiki/" + qid,
        })
    return rows


def fetch_airports():
    # countries.csv (same public-domain dataset) maps ISO codes -> names,
    # so airport rows carry real country names like every other dataset.
    raw = http_get("https://davidmegginson.github.io/ourairports-data/countries.csv")
    iso = {rec["code"]: rec["name"]
           for rec in csv.DictReader(io.StringIO(raw.decode("utf-8")))}
    raw = http_get("https://davidmegginson.github.io/ourairports-data/airports.csv")
    rows = []
    for rec in csv.DictReader(io.StringIO(raw.decode("utf-8"))):
        if rec["type"] not in ("large_airport", "medium_airport"):
            continue
        try:
            lat, lng = float(rec["latitude_deg"]), float(rec["longitude_deg"])
        except ValueError:
            continue
        rows.append({
            "n": f'{rec["name"]} ({rec["iata_code"] or rec["ident"]})',
            "lat": round(lat, 5), "lng": round(lng, 5),
            "c": canon_country(iso.get(rec["iso_country"], rec["iso_country"])),
            "url": f'https://ourairports.com/airports/{rec["ident"]}/',
            "x": rec["type"].replace("_", " "),
        })
    return rows


# 5D.2 — submarine cables & landing points (TeleGeography, CC BY-NC-SA 3.0).
# Public GeoJSON, no key. Cable routes are line geometry (kept as a self-contained
# GeoJSON the map overlays directly); landing points are named coordinates (also
# fed to the search index via the standard rows shape). Attribution is mandatory
# and surfaced in the Data Layers UI.
TELEGEOGRAPHY = {
    "cables": "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
    "landings": "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json",
}
TG_LICENSE = "TeleGeography, CC BY-NC-SA 3.0"
TG_ATTRIB = "© TeleGeography · CC BY-NC-SA 3.0"
TG_SOURCE = "https://www.submarinecablemap.com/"


def fetch_submarine_cables():
    """Write data/submarine-cables.json: a self-contained cable-route GeoJSON
    (MultiLineString) plus the landing points (Point), with attribution baked in.
    Returns the landing-point rows for the search index."""
    cables = net.get_json(TELEGEOGRAPHY["cables"], timeout=120)
    landings = net.get_json(TELEGEOGRAPHY["landings"], timeout=120)

    # Slim the cable features to what the map needs (drop the redundant
    # properties.coordinates label point TeleGeography ships per feature).
    cable_feats = []
    for f in cables.get("features", []):
        if not f.get("geometry"):
            continue                       # malformed feature: no geometry
        p = f.get("properties", {})
        cable_feats.append({
            "type": "Feature", "geometry": f["geometry"],
            "properties": {"id": p.get("id"), "name": p.get("name"),
                           "color": p.get("color")},
        })
    landing_feats = []
    rows = []
    for f in landings.get("features", []):
        p = f.get("properties", {})
        if p.get("is_tbd"):
            continue                       # unconfirmed/planned landing
        geom = f.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates")
        if not (isinstance(coords, list) and len(coords) >= 2):
            continue                       # empty/null/short coordinates
        lng, lat = coords[:2]
        name = p.get("name") or p.get("id") or "landing point"
        landing_feats.append({
            "type": "Feature", "geometry": geom,
            "properties": {"id": p.get("id"), "name": name},
        })
        # search-index row: "Town, Country" splits to a name + a country guess.
        country = name.rsplit(",", 1)[-1].strip() if "," in name else None
        rows.append({"n": name, "lat": round(lat, 5), "lng": round(lng, 5),
                     "c": canon_country(country), "url": TG_SOURCE})

    out = {
        "fetched": datetime.now(timezone.utc).isoformat(),
        "label": "Submarine cables & landing points",
        "license": TG_LICENSE, "attribution": TG_ATTRIB, "source": TG_SOURCE,
        "cables": {"type": "FeatureCollection", "features": cable_feats},
        "landings": {"type": "FeatureCollection", "features": landing_feats},
    }
    DATA.mkdir(exist_ok=True)
    (DATA / "submarine-cables.json").write_text(
        json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"  submarine-cables: {len(cable_feats)} cables, {len(landing_feats)} landing points")
    return rows


def write_dataset(key, label, license_, source, rows):
    DATA.mkdir(exist_ok=True)
    out = {"fetched": datetime.now(timezone.utc).isoformat(), "label": label,
           "license": license_, "source": source, "rows": rows}
    (DATA / f"{key}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"  {key}: {len(rows)} rows")


def write_wiki_pages():
    WIKI_DATA.mkdir(parents=True, exist_ok=True)
    for key in list(QUERIES) + ["airports", "cable-landings"]:
        f = DATA / f"{key}.json"
        if not f.is_file():
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        counts = {}
        for r in d["rows"]:
            counts[r.get("c") or "—"] = counts.get(r.get("c") or "—", 0) + 1
        top = sorted(counts.items(), key=lambda x: -x[1])[:40]
        md = [f"# {d['label']}\n",
              f"**{len(d['rows'])} entries** · source: {d['source']} · license: {d['license']} · "
              f"fetched {d['fetched'][:10]} (auto-refreshed when older than 30 days).\n",
              "Every entry is in the **[smart search](/app/search.html)** with coordinates — "
              f"search a country or filter the *{d['label']}* category, then “⌖ open on map”.\n",
              "## Entries by country (top 40)\n", "| Country | Entries |", "|---|---|"]
        md += [f"| {c} | {n} |" for c, n in top]
        (WIKI_DATA / f"{key}.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("  wiki data pages written")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    for key, spec in QUERIES.items():
        path = DATA / f"{key}.json"
        if not args.force and fresh(path):
            print(f"  {key}: fresh (cache hit)")
            continue
        print(f"  fetching {key} from Wikidata…")
        rows = fetch_wikidata(key, spec)
        write_dataset(key, spec["label"], spec["license"], spec["source"], rows)
        time.sleep(3)
    path = DATA / "airports.json"
    if args.force or not fresh(path):
        print("  fetching airports from OurAirports…")
        write_dataset("airports", "Airports (large & medium)",
                      "OurAirports, public domain",
                      "https://ourairports.com/data/", fetch_airports())
    else:
        print("  airports: fresh (cache hit)")
    # 5D.2 — submarine cables (self-contained GeoJSON) + landing points (searchable).
    path = DATA / "submarine-cables.json"
    if args.force or not fresh(path):
        print("  fetching submarine cables from TeleGeography…")
        landing_rows = fetch_submarine_cables()
        write_dataset("cable-landings", "Cable landing points",
                      TG_LICENSE, TG_SOURCE, landing_rows)
    else:
        print("  submarine-cables: fresh (cache hit)")
    write_wiki_pages()
    return 0


if __name__ == "__main__":
    sys.exit(main())
