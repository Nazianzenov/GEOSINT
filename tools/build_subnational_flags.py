#!/usr/bin/env python3
"""GeOSINT - subnational & dependency flag builder.

Generates per-country flag subpages (e.g. "Cantons of Switzerland",
"States of Germany") plus an index, with flags resolved and fetched through the
resilient Wikimedia client (tools/wikimedia.py): each subdivision's flag is
looked up via its Wikidata P41 ("flag image") property, so we never hard-code a
Commons filename that can drift or 404. Flag-only for now — name + flag — the
knowledge may be expanded later (recognition notes, etc.).

Files:
  wiki/docs/identify/flags-subnational/<country-slug>.md   one page per country
  wiki/docs/identify/flags-subnational/index.md            overview + links
  wiki/docs/assets/flags/<iso2>/<slug>.svg                 cached flags

Data model: each member is a display name, optionally a tuple
(display, qid) when the plain label is ambiguous on Wikidata (e.g. Quebec the
province vs the city, Georgia the US state vs the country). The per-country
`hint` biases label searches. Re-runs skip already-cached flags (no network).

    .venv\\Scripts\\python tools\\build_subnational_flags.py
"""
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wikimedia as wm                     # resilient Wikidata/Commons client

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "wiki" / "docs"
PAGES = DOCS / "identify" / "flags-subnational"
ASSETS = DOCS / "assets" / "flags"

# country slug -> {name, iso2, kind, hint, members}
# A member is one of:
#   "Name"                      display = search label = Name
#   ("Name", "Qxxxx")           pin an ambiguous label to a Wikidata QID
#   ("Display", "Search label")  show Display, search Wikidata for "Search label"
# Flags are resolved from each member's Wikidata P41 — no Commons filenames here.
def _is_qid(x):
    return isinstance(x, str) and x.startswith("Q") and x[1:].isdigit()


def _member(m):
    """Normalize a member entry to (display, search_label, qid, commons_file).
    Accepts: "Name" | ("Name","Qxxx") | ("Display","Search") |
    {"name","search","qid","file"} for the awkward cases (no Wikidata P41)."""
    if isinstance(m, str):
        return m, m, None, None
    if isinstance(m, dict):
        return (m["name"], m.get("search", m["name"]), m.get("qid"), m.get("file"))
    if isinstance(m, tuple):
        if len(m) == 2 and _is_qid(m[1]):
            return m[0], m[0], m[1], None
        if len(m) == 2:
            return m[0], m[1], None, None
        if len(m) == 3:
            return m[0], m[1], m[2], None
    raise ValueError(f"bad member entry: {m!r}")
COUNTRIES = {
    "switzerland": {
        "name": "Switzerland", "iso2": "ch", "kind": "Cantons", "hint": "canton of Switzerland",
        "members": [
            ("Zürich", "Canton of Zürich"), ("Bern", "Canton of Bern"), ("Lucerne", "Canton of Lucerne"),
            ("Uri", "Canton of Uri"), ("Schwyz", "Canton of Schwyz"), ("Obwalden", "Canton of Obwalden"),
            ("Nidwalden", "Canton of Nidwalden"), ("Glarus", "Canton of Glarus"), ("Zug", "Canton of Zug"),
            ("Fribourg", "Canton of Fribourg"), ("Solothurn", "Canton of Solothurn"),
            ("Basel-Stadt", "Canton of Basel-Stadt"), ("Basel-Landschaft", "Canton of Basel-Landschaft"),
            ("Schaffhausen", "Canton of Schaffhausen"), ("Appenzell Ausserrhoden", "Canton of Appenzell Ausserrhoden"),
            ("Appenzell Innerrhoden", "Canton of Appenzell Innerrhoden"), ("St. Gallen", "Canton of St. Gallen"),
            {"name": "Graubünden", "qid": "Q11925"}, ("Aargau", "Canton of Aargau"), ("Thurgau", "Canton of Thurgau"),
            ("Ticino", "Canton of Ticino"), ("Vaud", "Canton of Vaud"), ("Valais", "Canton of Valais"),
            ("Neuchâtel", "Canton of Neuchâtel"), ("Geneva", "Canton of Geneva"), ("Jura", "Canton of Jura"),
        ],
    },
    "germany": {
        "name": "Germany", "iso2": "de", "kind": "States (Länder)", "hint": "state of Germany",
        "members": [
            "Baden-Württemberg", "Bavaria", ("Berlin", "Q64"), ("Brandenburg", "Q1208"),
            ("Bremen", "Q24879"), ("Hamburg", "Q1055"), "Hesse", "Lower Saxony",
            "Mecklenburg-Vorpommern", "North Rhine-Westphalia", "Rhineland-Palatinate", "Saarland",
            ("Saxony", "Q1202"), "Saxony-Anhalt", "Schleswig-Holstein", "Thuringia",
        ],
    },
    "united-states": {
        "name": "United States", "iso2": "us", "kind": "States", "hint": "U.S. state",
        "members": [
            "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
            "Delaware", "Florida", ("Georgia", "Q1428"), "Hawaii", "Idaho", "Illinois", "Indiana",
            "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
            "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
            "New Hampshire", "New Jersey", "New Mexico", ("New York", "Q1384"), "North Carolina",
            "North Dakota", "Ohio", ("Oklahoma", "Q1649"), "Oregon", "Pennsylvania", "Rhode Island",
            "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
            ("Washington", "Q1223"), "West Virginia", "Wisconsin", "Wyoming",
        ],
    },
    "canada": {
        "name": "Canada", "iso2": "ca", "kind": "Provinces & territories", "hint": "province of Canada",
        "members": [
            "Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador",
            "Nova Scotia", "Ontario", "Prince Edward Island", ("Quebec", "Q176"), ("Saskatchewan", "Q1989"),
            "Northwest Territories", "Nunavut", "Yukon",
        ],
    },
    "spain": {
        "name": "Spain", "iso2": "es", "kind": "Autonomous communities", "hint": "autonomous community of Spain",
        "members": [
            "Andalusia", "Aragon", "Asturias", "Balearic Islands", "Basque Country", "Canary Islands",
            "Cantabria", "Castile and León", "Castilla–La Mancha", "Catalonia", "Extremadura",
            "Galicia", "La Rioja", ("Community of Madrid", "Q5756"), "Region of Murcia", "Navarre",
            "Valencian Community",
        ],
    },
    "france-regions": {
        "name": "France", "iso2": "fr", "kind": "Regions", "hint": "region of France",
        "members": [
            "Auvergne-Rhône-Alpes", "Bourgogne-Franche-Comté", "Brittany", "Centre-Val de Loire",
            "Corsica", "Grand Est", "Hauts-de-France", ("Île-de-France", "Q13917"), "Normandy",
            "Nouvelle-Aquitaine", "Occitania", "Pays de la Loire", "Provence-Alpes-Côte d'Azur",
            # overseas regions
            "Guadeloupe", "Martinique", "French Guiana", ("Réunion", "Q17070"), "Mayotte",
        ],
    },
    "spain-provinces": {
        "name": "Spain (provinces)", "iso2": "esp", "kind": "Provinces", "hint": "province of Spain",
        "members": [
            "Province of A Coruña", "Province of Álava", "Province of Albacete", "Province of Alicante",
            "Province of Almería", "Province of Asturias", "Province of Ávila", "Province of Badajoz",
            "Province of Barcelona", "Province of Biscay", "Province of Burgos", "Province of Cáceres",
            "Province of Cádiz", "Province of Cantabria", "Province of Castellón", "Province of Ciudad Real",
            "Province of Córdoba", "Province of Cuenca", "Province of Girona", "Province of Granada",
            "Province of Guadalajara", "Province of Gipuzkoa", "Province of Huelva", "Province of Huesca",
            "Province of Jaén", "Province of León", "Province of Lleida", "Province of Lugo",
            "Province of Madrid", "Province of Málaga", "Region of Murcia", "Province of Navarre",
            "Province of Ourense", "Province of Palencia", "Province of Las Palmas", "Province of Pontevedra",
            "Province of La Rioja", "Province of Salamanca", "Province of Santa Cruz de Tenerife",
            "Province of Segovia", "Province of Seville", "Province of Soria", "Province of Tarragona",
            "Province of Teruel", "Province of Toledo", "Province of Valencia", "Province of Valladolid",
            "Province of Zamora", "Province of Zaragoza", "Balearic Islands",
        ],
    },
    "united-kingdom": {
        "name": "United Kingdom", "iso2": "gb", "kind": "Constituent nations", "hint": "country United Kingdom",
        "members": [("England", "Q21"), ("Scotland", "Q22"), ("Wales", "Q25"), ("Northern Ireland", "Q26")],
    },
    "australia": {
        "name": "Australia", "iso2": "au", "kind": "States & territories", "hint": "state of Australia",
        "members": [
            "New South Wales", ("Victoria", "Q36687"), "Queensland", "South Australia",
            "Western Australia", "Tasmania",
            {"name": "Australian Capital Territory", "file": "Flag of the Australian Capital Territory.svg"},
            "Northern Territory",
        ],
    },
    "dependencies": {
        "name": "Notable dependencies & autonomous territories", "iso2": "dep", "kind": "Dependencies", "hint": "",
        "members": [
            ("Greenland", "Q223"), ("Faroe Islands", "Q4628"), ("Åland", "Q5689"), ("Gibraltar", "Q1410"),
            ("Isle of Man", "Q9676"), ("Jersey", "Q785"), ("Guernsey", "Q3311985"), ("Bermuda", "Q23635"),
            ("Cayman Islands", "Q5785"), ("Hong Kong", "Q8646"), ("Macau", "Q14773"),
            ("Puerto Rico", "Q1183"), ("Guam", "Q16635"), ("French Polynesia", "Q30971"),
            ("New Caledonia", "Q33788"), ("Curaçao", "Q25279"), ("Aruba", "Q21203"),
            ("Sint Maarten", "Q26273"),
        ],
    },
}


def clean_display(name):
    """Trim Wikidata-style qualifiers from a search label for the caption:
    'Province of A Coruña' -> 'A Coruña', 'Jura (department)' -> 'Jura'."""
    for pre in ("Province of ", "Canton of "):
        if name.startswith(pre):
            name = name[len(pre):]
    if name.endswith(" (department)"):
        name = name[: -len(" (department)")]
    return name


def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = s.lower().replace("'", "").replace(".", "")
    s = "".join(ch if ch.isalnum() else "_" for ch in s)
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")


GALLERY_CSS = (
    "<style>\n"
    ".gh-gallery { display: flex; flex-wrap: wrap; gap: 14px; }\n"
    ".gh-gallery figure { margin: 0; width: 160px; }\n"
    ".gh-gallery img { width: 160px; border: 1px solid var(--md-default-fg-color--lightest); border-radius: 3px; }\n"
    ".gh-gallery figcaption { font-size: .72rem; text-align: center; }\n"
    "</style>\n\n"
)


def _assert_unique_members():
    """Fail loudly at startup if any country lists the same display name twice
    (a duplicate would silently collide on its cached flag path / caption)."""
    for cslug, c in COUNTRIES.items():
        seen = {}
        for member in c["members"]:
            name = _member(member)[0]
            if name in seen:
                raise ValueError(
                    f"duplicate member {name!r} in country {cslug!r}: "
                    f"{seen[name]!r} and {member!r}")
            seen[name] = member


def main():
    _assert_unique_members()
    PAGES.mkdir(parents=True, exist_ok=True)
    fetched = skipped = failed = 0
    index_rows = []

    for cslug, c in COUNTRIES.items():
        iso2, hint = c["iso2"], c.get("hint") or None
        figs = []
        for member in c["members"]:
            name, search, qid, cfile = _member(member)
            name = clean_display(name)
            local = ASSETS / iso2 / f"{slug(name)}.svg"
            if local.is_file():
                skipped += 1
            else:
                try:
                    fname, _ = wm.fetch_flag(search, local, hint=hint, qid=qid, commons_file=cfile)
                    fetched += 1
                    print(f"  fetched  {c['name']:22} {name:28} -> {iso2}/{local.name}  [{fname}]")
                except Exception as e:
                    failed += 1
                    print(f"  FAIL {c['name']} / {name}: {e}")
                    continue
            # page at /wiki/identify/flags-subnational/<x>/ (use_directory_urls)
            # → three levels up to reach /wiki/assets/
            rel = f"../../../assets/flags/{iso2}/{local.name}"
            figs.append(f'<figure><img src="{rel}" loading="lazy" alt="Flag of {name}">'
                        f"<figcaption>{name}</figcaption></figure>")
        title = f"{c['kind']} of {c['name']}" if iso2 != "dep" else c["name"]
        page = (
            f"# {title}\n\n"
            f"Subnational flags pin a photo *inside* {c['name']}. **Flag-only reference** for now — "
            "names + flags, resolved via each subject's Wikidata flag (P41) and cached locally from "
            "[Wikimedia Commons](https://commons.wikimedia.org/). May be expanded with recognition "
            "notes later.\n\n"
            + GALLERY_CSS
            + '<div class="gh-gallery">\n' + "\n".join(figs) + "\n</div>\n"
        )
        (PAGES / f"{cslug}.md").write_text(page, encoding="utf-8")
        index_rows.append((title, cslug, len(figs)))

    idx = ["# Subnational & dependency flags\n",
           "Per-country flag references for regions, states, cantons, provinces and dependencies "
           "— to localize a photo *within* a country. Flag-only for now; each flag is resolved via "
           "its Wikidata flag property (P41) and cached locally from "
           "[Wikimedia Commons](https://commons.wikimedia.org/).\n",
           "| Region set | Flags |", "|---|---|"]
    for title, cslug, n in index_rows:
        idx.append(f"| [{title}]({cslug}.md) | {n} |")
    (PAGES / "index.md").write_text("\n".join(idx) + "\n", encoding="utf-8")

    n_assets = sum(1 for _ in ASSETS.rglob("*/*.svg"))
    print(f"done: {fetched} fetched, {skipped} cached, {failed} failed. "
          f"{len(COUNTRIES)} subpages + index. Subnational assets: {n_assets}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
