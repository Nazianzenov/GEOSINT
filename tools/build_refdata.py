#!/usr/bin/env python3
"""GeOSINT - reference-data generator for the domains & phones page.

Builds the COMPLETE ccTLD and E.164 calling-code tables in
wiki/docs/identify/domains-phones.md from authoritative open data, between
REFDATA markers. Avoids hand-typing ~250 rows (the hallucination/typo risk):
the data is fetched, cross-checked against the IANA root zone, cached locally,
and the page is regenerated deterministically.

Sources (both fetched once, cached under data/):
  * mledoze/countries (CC0 / Unlicense) - ISO 3166-1 alpha-2, ccTLD, calling
    code (idd root+suffix), common name, region.
  * IANA root zone 2-letter list - to verify each ccTLD is actually delegated.

Run:  .venv\\Scripts\\python tools\\build_refdata.py   (offline after first run)
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import net                                  # shared polite HTTP layer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "wiki" / "docs" / "identify" / "domains-phones.md"
DATA = ROOT / "data"
COUNTRIES_CACHE = DATA / "countries.json"
IANA_CACHE = DATA / "iana_cctlds.txt"

COUNTRIES_URL = "https://raw.githubusercontent.com/mledoze/countries/master/dist/countries.json"
IANA_URL = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt"

TLD_START = "<!-- REFDATA:cctld START -->"
TLD_END = "<!-- REFDATA:cctld END -->"
CC_START = "<!-- REFDATA:callcode START -->"
CC_END = "<!-- REFDATA:callcode END -->"

# Corrections for known quirks in the upstream dataset, keyed by ISO alpha-2.
# Kept tiny and explicit so the bulk stays auto-generated and auditable.
NAME_OVERRIDE = {
    "ci": "Côte d'Ivoire", "cg": "Republic of the Congo", "tl": "Timor-Leste",
    "tw": "Taiwan", "sz": "Eswatini", "cd": "DR Congo",
}
# Calling codes the dataset encodes ambiguously (multiple suffixes / disputed).
CC_OVERRIDE = {
    "eh": "+212",   # Western Sahara dials via Morocco +212
    "aq": "",       # Antarctica: no single E.164 code
    "hm": "",       # Heard & McDonald Is.: uninhabited, no code
    "bv": "",       # Bouvet Is.: uninhabited
}


def fetch(url, cache, binary=False):
    if cache.is_file():
        return cache.read_bytes() if binary else cache.read_text(encoding="utf-8")
    data, _ = net.get(url)
    DATA.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)
    return data if binary else data.decode("utf-8")


def calling_code(idd):
    root = (idd or {}).get("root") or ""
    sufs = (idd or {}).get("suffixes") or []
    if not root:
        return None
    if len(sufs) == 1:
        return root + sufs[0]
    return root  # multiple suffixes (e.g. NANP +1) -> show the root only


def replace_block(text, start, end, body):
    i, j = text.find(start), text.find(end)
    if i < 0 or j < 0:
        raise SystemExit(f"markers {start}/{end} not found in page")
    return text[:i] + start + "\n\n" + body + "\n\n" + end + text[j + len(end):]


def main():
    countries = json.loads(fetch(COUNTRIES_URL, COUNTRIES_CACHE))
    iana = {ln.strip().lower() for ln in fetch(IANA_URL, IANA_CACHE).splitlines()
            if len(ln.strip()) == 2 and ln.strip().isalpha()}

    rows = []
    for c in countries:
        cca2 = c.get("cca2", "").lower()
        name = NAME_OVERRIDE.get(cca2) or c.get("name", {}).get("common", cca2.upper())
        region = c.get("region", "")
        subregion = c.get("subregion", "")
        tlds = [t for t in (c.get("tld") or []) if t]
        cc = CC_OVERRIDE[cca2] if cca2 in CC_OVERRIDE else calling_code(c.get("idd"))
        # primary ccTLD is the ISO code; some entries list extra (e.g. .uk has .gb alt)
        cctld = next((t for t in tlds if t.lstrip(".") == cca2), tlds[0] if tlds else None)
        delegated = (cca2 in iana)
        rows.append({"name": name, "cca2": cca2, "cctld": cctld, "tlds": tlds,
                     "cc": cc, "region": region, "subregion": subregion,
                     "delegated": delegated})

    # ── ccTLD table (alphabetical by ccTLD) ──────────────────────────────
    tld_rows = sorted([r for r in rows if r["cctld"]], key=lambda r: r["cctld"])
    lines = ["| ccTLD | Country / territory | also | calling code |",
             "|---|---|---|---|"]
    for r in tld_rows:
        extra = ", ".join(t for t in r["tlds"] if t != r["cctld"]) or ""
        cc = r["cc"] or ""
        flag = "" if r["delegated"] else " ⚠"
        lines.append(f"| `{r['cctld']}`{flag} | {r['name']} | {extra} | {cc} |")
    tld_body = "\n".join(lines)
    tld_body += ("\n\n*Every ISO-3166 country-code TLD currently delegated in the "
                 "[IANA root](https://www.iana.org/domains/root/db). "
                 "⚠ = listed by ISO but not (yet) delegated as a live ccTLD.*")

    # ── calling-code table (numeric order, grouped) ──────────────────────
    def cc_key(r):
        digits = "".join(ch for ch in (r["cc"] or "") if ch.isdigit())
        return (int(digits) if digits else 9999, r["name"])
    cc_rows = sorted([r for r in rows if r["cc"]], key=cc_key)
    lines = ["| Code | Country / territory | ccTLD |", "|---|---|---|"]
    for r in cc_rows:
        lines.append(f"| {r['cc']} | {r['name']} | {('`'+r['cctld']+'`') if r['cctld'] else ''} |")
    cc_body = "\n".join(lines)
    cc_body += ("\n\n*ITU-T E.164 assignments. `+1` covers the North American Numbering "
                "Plan (US, Canada, and many Caribbean states, distinguished by 3-digit "
                "area code); `+7` covers Russia and Kazakhstan.*")

    text = PAGE.read_text(encoding="utf-8")
    text = replace_block(text, TLD_START, TLD_END, tld_body)
    text = replace_block(text, CC_START, CC_END, cc_body)
    PAGE.write_text(text, encoding="utf-8")
    print(f"done: {len(tld_rows)} ccTLDs, {len(cc_rows)} calling codes written to "
          f"{PAGE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
