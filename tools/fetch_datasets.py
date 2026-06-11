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
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WIKI_DATA = ROOT / "wiki" / "docs" / "data"
TTL = timedelta(days=30)
UA = "GeOSINT-Workbench/1.0 (local personal OSINT tool; non-commercial)"
# QLever's Wikidata mirror first (fast, generous limits); WDQS as fallback.
SPARQL_ENDPOINTS = [
    "https://qlever.cs.uni-freiburg.de/api/wikidata",
    "https://query.wikidata.org/sparql",
]

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
}

POINT_RE = re.compile(r"Point\(([-\d.]+) ([-\d.]+)\)")


def fresh(path):
    if not path.is_file():
        return False
    meta = json.loads(path.read_text(encoding="utf-8"))
    return datetime.now(timezone.utc) - datetime.fromisoformat(meta["fetched"]) < TTL


def http_get(url, accept=None, tries=3, backoff=10):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, **({"Accept": accept} if accept else {})})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:
            if attempt == tries - 1:
                raise
            wait = 70 if "429" in str(e) else backoff * (attempt + 1)
            print(f"  retry in {wait}s after: {e}")
            time.sleep(wait)


def canon_country(label):
    if not label:
        return None
    return CANON.get(label.lower(), label)


def fetch_wikidata(key, spec):
    raw = None
    for ep in SPARQL_ENDPOINTS:
        url = ep + "?format=json&query=" + urllib.parse.quote(spec["q"])
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


def write_dataset(key, label, license_, source, rows):
    DATA.mkdir(exist_ok=True)
    out = {"fetched": datetime.now(timezone.utc).isoformat(), "label": label,
           "license": license_, "source": source, "rows": rows}
    (DATA / f"{key}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"  {key}: {len(rows)} rows")


def write_wiki_pages():
    WIKI_DATA.mkdir(parents=True, exist_ok=True)
    for key in list(QUERIES) + ["airports"]:
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
    write_wiki_pages()
    return 0


if __name__ == "__main__":
    sys.exit(main())
