#!/usr/bin/env python3
"""GeOSINT - botanical reference builder (cached, 30-day TTL).

For each indicator species: resolves the GBIF taxon key (for live
distribution-map overlays on the Workbench map), pulls the Wikipedia lead
image + summary, and generates wiki/docs/flora/ pages grouped by biome.
Images are later localized by tools/cache_wikimedia.py.

Sources: GBIF species API (CC0 metadata), Wikipedia REST (CC BY-SA text,
Commons images). Run:  .venv\\Scripts\\python tools\\build_flora.py [--force]
"""
import argparse
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
DATA = ROOT / "data" / "flora.json"
WIKI = ROOT / "wiki" / "docs" / "flora"
TTL = timedelta(days=30)

# Köppen ↔ flora cross-link: each biome group -> (Köppen codes, short label).
# Used to print "indicates climate X" on each flora group page and to build the
# reverse "what grows here, by Köppen zone" table on the vegetation-climate page.
GROUP_KOPPEN = {
    "Boreal & northern":  ("Dfc · Dfb · ET", "subarctic / cold-continental & tundra edge"),
    "Temperate":          ("Cfb · Cfa · Dfb", "temperate oceanic & humid-continental"),
    "Mediterranean":      ("Csa · Csb", "Mediterranean (dry-summer)"),
    "Arid & desert":      ("BWh · BWk · BSh", "hot & cold deserts and semi-arid steppe"),
    "Tropical":           ("Af · Am · Aw", "tropical rainforest, monsoon & savanna"),
    "East Asia":          ("Cfa · Cwa · Dwa", "humid subtropical & monsoon East Asia"),
    "Oceania & Americas": ("Cfb · Csb · Aw", "varied — oceanic, subtropical & tropical"),
    "Crops & landscape":  ("—", "cultivated; climate depends on the crop"),
    "Coastal":            ("—", "coastal strips across many zones"),
}
# wiki path of the Köppen reference + a per-letter anchor target
KOPPEN_PAGE = "/wiki/identify/vegetation-climate/"

# (group, common name, scientific name, wikipedia title, geolocation hint)
SPECIES = [
    ("Boreal & northern", "Silver birch", "Betula pendula", "Betula_pendula",
     "THE Russia/Scandinavia/Baltics tree; white bark with black fissures"),
    ("Boreal & northern", "Norway spruce", "Picea abies", "Picea_abies",
     "Dark drooping conifer of N/C Europe; plantation forestry everywhere"),
    ("Boreal & northern", "Scots pine", "Pinus sylvestris", "Pinus_sylvestris",
     "Orange upper bark; Eurasia's most widespread pine"),
    ("Boreal & northern", "Siberian larch", "Larix sibirica", "Larix_sibirica",
     "Deciduous conifer — golden in autumn, bare in winter = Siberia/Mongolia"),
    ("Boreal & northern", "Rowan", "Sorbus aucuparia", "Sorbus_aucuparia",
     "Red berry clusters; N. European gardens and roadsides"),
    ("Temperate", "English oak", "Quercus robur", "Quercus_robur",
     "Broad solitary field trees in W/C Europe hedgerow landscapes"),
    ("Temperate", "European beech", "Fagus sylvatica", "Fagus_sylvatica",
     "Smooth grey bark, dense dark forests (C. Europe)"),
    ("Temperate", "London plane", "Platanus × acerifolia", "London_plane",
     "Camouflage-flaking bark; THE avenue tree of Paris/London/Madrid"),
    ("Temperate", "Horse chestnut", "Aesculus hippocastanum", "Aesculus_hippocastanum",
     "Hand-shaped leaves, conkers; C. European parks and beer gardens"),
    ("Temperate", "Small-leaved lime", "Tilia cordata", "Tilia_cordata",
     "Pollarded street rows in Germany/CEE (Unter den Linden)"),
    ("Temperate", "Lombardy poplar", "Populus nigra 'Italica'", "Populus_nigra",
     "Pencil-thin windbreak rows: Po valley, France, Argentina's pampa"),
    ("Mediterranean", "Olive", "Olea europaea", "Olea_europaea",
     "Silvery groves = Mediterranean climate worldwide"),
    ("Mediterranean", "Mediterranean cypress", "Cupressus sempervirens", "Cupressus_sempervirens",
     "Black-green exclamation marks of Tuscany/Greece; cemetery tree"),
    ("Mediterranean", "Stone pine", "Pinus pinea", "Pinus_pinea",
     "Umbrella-shaped crowns over Rome/Iberian coasts"),
    ("Mediterranean", "Cork oak", "Quercus suber", "Quercus_suber",
     "Stripped red-brown trunks = Portugal/SW Spain dehesa, Sardinia, Maghreb"),
    ("Mediterranean", "Oleander", "Nerium oleander", "Nerium",
     "Pink/white highway median shrub in every Mediterranean climate"),
    ("Mediterranean", "Citrus (orange)", "Citrus × sinensis", "Orange_(fruit)",
     "Street oranges = Seville/Athens/Valencia; groves = subtropics"),
    ("Arid & desert", "Saguaro", "Carnegiea gigantea", "Saguaro",
     "ONLY the Sonoran Desert (Arizona/Sonora) — instant pinpoint"),
    ("Arid & desert", "Joshua tree", "Yucca brevifolia", "Yucca_brevifolia",
     "Mojave Desert only (SE California/S Nevada)"),
    ("Arid & desert", "Prickly pear", "Opuntia ficus-indica", "Opuntia_ficus-indica",
     "Mexico native; naturalized fences across Med/N. Africa/India"),
    ("Arid & desert", "Date palm", "Phoenix dactylifera", "Date_palm",
     "Hot-desert oases: N. Africa, Gulf, Iran; California's Coachella"),
    ("Arid & desert", "Quiver tree", "Aloidendron dichotomum", "Aloidendron_dichotomum",
     "Namibia/NW South Africa — a southern-Africa pinpoint"),
    ("Arid & desert", "Welwitschia", "Welwitschia mirabilis", "Welwitschia",
     "Namib desert only; two ragged leaves on bare gravel"),
    ("Tropical", "Coconut palm", "Cocos nucifera", "Coconut",
     "Leaning over beaches throughout the humid tropics"),
    ("Tropical", "Oil palm", "Elaeis guineensis", "Elaeis_guineensis",
     "Plantation grids = Malaysia/Indonesia/W. Africa; NOT a wild beach palm"),
    ("Tropical", "Banana/plantain", "Musa × paradisiaca", "Banana",
     "Smallholder clumps across all humid tropics"),
    ("Tropical", "Mango", "Mangifera indica", "Mangifera_indica",
     "Huge dark-domed village shade tree: S/SE Asia, Africa, LatAm"),
    ("Tropical", "Banyan", "Ficus benghalensis", "Ficus_benghalensis",
     "Aerial-root curtains; S/SE Asia temple and roadside tree"),
    ("Tropical", "Royal poinciana", "Delonix regia", "Delonix_regia",
     "Scarlet flowering canopy; planted throughout the tropics"),
    ("Tropical", "Kapok", "Ceiba pentandra", "Ceiba_pentandra",
     "Massive buttressed emergent of neotropical/W. African forests"),
    ("Tropical", "African baobab", "Adansonia digitata", "Adansonia_digitata",
     "Sub-Saharan savanna icon; bottle trunk"),
    ("Tropical", "Grandidier's baobab", "Adansonia grandidieri", "Adansonia_grandidieri",
     "Madagascar only — Avenue of the Baobabs"),
    ("Tropical", "Traveller's palm", "Ravenala madagascariensis", "Ravenala",
     "Fan-plane of leaves; Madagascar native, tropical hotel landmark"),
    ("East Asia", "Japanese cedar", "Cryptomeria japonica", "Cryptomeria",
     "Japan's plantation conifer (sugi) — straight dark ranks on every hillside"),
    ("East Asia", "Ginkgo", "Ginkgo biloba", "Ginkgo_biloba",
     "Fan leaves, gold in autumn; street tree of Japan/Korea/China cities"),
    ("East Asia", "Tea", "Camellia sinensis", "Camellia_sinensis",
     "Corduroy hedge rows on hills: China/Japan/India/Sri Lanka/Kenya"),
    ("East Asia", "Moso bamboo", "Phyllostachys edulis", "Phyllostachys_edulis",
     "Giant bamboo groves of China/Japan"),
    ("East Asia", "Rice", "Oryza sativa", "Rice",
     "Paddies = monsoon Asia; terraces = S. China/SE Asia/Philippines/Nepal"),
    ("Oceania & Americas", "Tasmanian blue gum", "Eucalyptus globulus", "Eucalyptus_globulus",
     "Australia native; the eucalyptus planted across Iberia/California/E. Africa"),
    ("Oceania & Americas", "Grass tree", "Xanthorrhoea", "Xanthorrhoea",
     "Black trunk + grass skirt = Australia only"),
    ("Oceania & Americas", "Norfolk Island pine", "Araucaria heterophylla", "Araucaria_heterophylla",
     "Symmetrical tiers; seafront promenades worldwide, Pacific origin"),
    ("Oceania & Americas", "Monkey puzzle", "Araucaria araucana", "Araucaria_araucana",
     "Chile/Argentina Andes — reptilian branches"),
    ("Oceania & Americas", "Coast redwood", "Sequoia sempervirens", "Sequoia_sempervirens",
     "N. California fog belt only (wild)"),
    ("Oceania & Americas", "Douglas fir", "Pseudotsuga menziesii", "Pseudotsuga_menziesii",
     "Pacific NW giant; plantations in W. Europe/NZ"),
    ("Oceania & Americas", "Tree fern", "Cyathea", "Cyathea",
     "NZ/SE Australia/tropical highlands understory"),
    ("Oceania & Americas", "Pōhutukawa", "Metrosideros excelsa", "Metrosideros_excelsa",
     "Red December bloom on N. New Zealand coasts"),
    ("Crops & landscape", "Rapeseed", "Brassica napus", "Rapeseed",
     "Blinding yellow spring fields: N/C Europe, Canada, China"),
    ("Crops & landscape", "Sunflower", "Helianthus annuus", "Common_sunflower",
     "Summer fields: Ukraine/Russia/France/Argentina/US plains"),
    ("Crops & landscape", "Grapevine", "Vitis vinifera", "Vitis_vinifera",
     "Trellis rows; pergola-trained = N. Portugal/Galicia/Argentina"),
    ("Crops & landscape", "Hops", "Humulus lupulus", "Humulus_lupulus",
     "6-m pole trellises = Bavaria/Czechia/Slovenia/US PNW"),
    ("Crops & landscape", "Sugarcane", "Saccharum officinarum", "Saccharum_officinarum",
     "Tall cane fields: Brazil/India/Caribbean/Queensland/Fiji"),
    ("Crops & landscape", "Agave (tequila)", "Agave tequilana", "Agave_tequilana",
     "Blue-grey spiky rows = Jalisco, Mexico"),
    ("Coastal", "Red mangrove", "Rhizophora mangle", "Rhizophora_mangle",
     "Prop roots in tropical tidal water"),
    ("Coastal", "Screw pine", "Pandanus", "Pandanus",
     "Stilt-rooted spiky heads on Indo-Pacific shores"),
    ("Coastal", "Marram grass", "Ammophila arenaria", "Ammophila_arenaria",
     "European dune grass (planted worldwide for dunes)"),
]


# Wikipedia lead images for crop species are often the FRUIT, not the plant —
# useless for field recognition. Explicit Commons overrides (plant/landscape).
IMG_OVERRIDES = {
    "Citrus (orange)": "Florida orange grove.JPG",
    "Olive": "Olive groves in Andalucia.jpg",
    "Date palm": "Lush Oasis of Date Palm Trees.jpg",
    "Banana/plantain": "04. Mature Vegatative Myndoli Banana plants at 8-10 plants.jpg",
    "Mango": "Close-up View Under Mango Tree Canopy – Nazra Village, Bihar.jpg",
    "Coconut palm": "Corong Corong Beach, Coconut palm trees, El Nido, Palawan Island, Philippines.jpg",
    "Oil palm": "Oil palm plantation in Paloh Hinai, Pahang.jpg",
    "Horse chestnut": "Horse chestnut (Aesculus hippocastanum) - geograph.org.uk - 755747.jpg",
    "Tea": "Tea plantations in Munnar, Kerala.jpg",
    "Rice": "Longsheng Rice Terraces November 2017 014.jpg",
}


def override_url(common):
    f = IMG_OVERRIDES.get(common)
    if not f:
        return None
    return ("https://commons.wikimedia.org/wiki/Special:FilePath/"
            + urllib.parse.quote(f) + "?width=640")


def http_json(url):
    return net.get_json(url)


def thumb_url(src, width=640):
    """Normalize any Commons image URL (original, /thumb/, or FilePath) to a
    sized Special:FilePath URL — full-size originals are heavy and Wikimedia
    rejects arbitrary /thumb/ widths from non-browser clients."""
    if "Special:FilePath" in src:
        return src
    leaf = src.rsplit("/", 1)[-1]
    m = re.match(r"\d+px-(.+)$", leaf)
    if m:
        leaf = m.group(1)
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{leaf}?width={width}"


def apply_overrides(d):
    for e in d["species"]:
        ov = override_url(e["common"])
        if ov:
            e["img"] = ov
    return d


def build_data(force):
    if DATA.is_file() and not force:
        d = json.loads(DATA.read_text(encoding="utf-8"))
        if datetime.now(timezone.utc) - datetime.fromisoformat(d["fetched"]) < TTL:
            print(f"  flora.json fresh ({len(d['species'])} species, cache hit)")
            d = apply_overrides(d)
            DATA.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
            return d
    out = []
    for group, common, sci, wp, hint in SPECIES:
        entry = {"group": group, "common": common, "sci": sci, "hint": hint}
        try:
            m = http_json("https://api.gbif.org/v1/species/match?name="
                          + urllib.parse.quote(sci))
            entry["gbif"] = m.get("usageKey")
        except Exception as e:
            print(f"  WARN gbif {sci}: {e}")
        try:
            s = http_json("https://en.wikipedia.org/api/rest_v1/page/summary/"
                          + urllib.parse.quote(wp))
            entry["summary"] = s.get("extract", "")[:600]
            entry["wiki_url"] = s.get("content_urls", {}).get("desktop", {}).get("page")
            img = (s.get("originalimage") or {}).get("source", "")
            if "upload.wikimedia.org/wikipedia/commons" in img:
                entry["img"] = thumb_url(img)
        except Exception as e:
            print(f"  WARN wikipedia {wp}: {e}")
        out.append(entry)
        print(f"  {common}: gbif={entry.get('gbif')} img={'y' if entry.get('img') else 'n'}")
        time.sleep(0.5)
    d = apply_overrides({"fetched": datetime.now(timezone.utc).isoformat(), "species": out})
    DATA.parent.mkdir(exist_ok=True)
    DATA.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return d


def write_wiki(d):
    WIKI.mkdir(parents=True, exist_ok=True)
    groups = {}
    for s in d["species"]:
        groups.setdefault(s["group"], []).append(s)
    slug = lambda g: re.sub(r"[^a-z]+", "-", g.lower()).strip("-")
    index = ["# Botanical reference\n",
             "Indicator species for geolocation: what a plant tells you about where you are. ",
             "Each entry has a photo, the field tell, and a **live distribution map** ",
             "(GBIF occurrence density on the Workbench map).\n",
             f"Data: [GBIF](https://www.gbif.org/) (taxon keys, CC0) + ",
             f"[Wikipedia/Commons](https://en.wikipedia.org/) (text CC BY-SA, images per file). ",
             f"Fetched {d['fetched'][:10]}, auto-refreshed monthly.\n"]
    for g, specs in groups.items():
        kz, klabel = GROUP_KOPPEN.get(g, ("—", ""))
        zone_note = f" — Köppen **{kz}** ({klabel})" if kz != "—" else ""
        index.append(f"- [{g}]({slug(g)}.md) — {len(specs)} species{zone_note}")
        md = [f"# {g} — indicator species\n"]
        if kz != "—":
            md.append(f"**Climate signal:** these species indicate **Köppen {kz}** — {klabel}. "
                      f"See the [Köppen-Geiger map & quick read]({KOPPEN_PAGE}) to place the zone.\n")
        for s in specs:
            md.append(f"## {s['common']} (*{s['sci']}*)\n")
            if s.get("img"):
                md.append(f"![{s['common']}]({s['img']})\n{{ width=340 }}\n")
            md.append(f"**Geolocation tell:** {s['hint']}\n")
            if s.get("summary"):
                md.append(s["summary"] + f" *([Wikipedia]({s.get('wiki_url', '#')}), CC BY-SA)*\n")
            links = [f"[POWO](https://powo.science.kew.org/results?q={urllib.parse.quote(s['sci'])})"]
            if s.get("gbif"):
                links.insert(0, f"[**⌖ live distribution map**](/app/index.html#species={s['gbif']}"
                                f"&name={urllib.parse.quote(s['common'])})")
                links.append(f"[GBIF](https://www.gbif.org/species/{s['gbif']})")
            md.append(" · ".join(links) + "\n")
        (WIKI / f"{slug(g)}.md").write_text("\n".join(md), encoding="utf-8")
    (WIKI / "index.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    print(f"  flora wiki pages written ({len(groups)} groups)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    d = build_data(args.force)
    write_wiki(d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
