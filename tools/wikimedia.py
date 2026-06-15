#!/usr/bin/env python3
"""GeOSINT - resilient Wikimedia / Wikidata client (shared by the data tools).

Why this exists: hard-coding `Special:FilePath/Flag_of_X.svg` names is fragile —
exact Commons titles drift (St. Gallen → "Sankt Gallen", Basel-Stadt →
"Canton of Basel"), and bulk FilePath access is aggressively rate-limited
(HTTP 429). This module fixes both:

  * resolve_flag(label)  — look up a subject on Wikidata and return its P41
    ("flag image") Commons filename. No guessing, so no 404s.
  * file_url(title)      — resolve a Commons File: title to its real
    upload.wikimedia.org URL via the MediaWiki imageinfo API (not throttled
    like FilePath).
  * download(url, dest)  — fetch with the polite knobs Wikimedia asks for.

Politeness / resilience (per https://www.mediawiki.org/wiki/API:Etiquette):
  * descriptive User-Agent identifying the tool + contact,
  * serial requests with a small floor delay,
  * `maxlag=5` on API calls (server sheds load gracefully),
  * exponential backoff that honours the `Retry-After` header on 429/503.

The polite HTTP layer (UA, shared throttle, Retry-After backoff) lives in
net.py; this module adds the Wikidata/Commons logic on top.
"""
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import net                                  # shared polite HTTP layer

COMMONS = "commons.wikimedia.org"
WIKIDATA = "www.wikidata.org"


def get_bytes(url, timeout=40):
    """Fetch a URL via the shared polite layer. Returns (bytes, content_type)."""
    return net.get(url, timeout=timeout)


def api(host, params):
    """Call a MediaWiki/Wikidata api.php with JSON + maxlag; retries on maxlag."""
    for attempt in range(6):
        q = {**params, "format": "json", "maxlag": "5"}
        url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(q)
        data = net.get_json(url)
        if isinstance(data, dict) and data.get("error", {}).get("code") == "maxlag":
            time.sleep(min(60, 5 * (attempt + 1)))
            continue
        return data
    raise RuntimeError(f"maxlag persisted for {host} {params}")


def category_images(category, limit=8, thumb_width=480):
    """Return image files in a Commons category as a list of dicts:
    {title, url (thumbnail at thumb_width), mime, lat, lon}. Skips non-image
    members. Used to build country-organized reference galleries."""
    d = api(COMMONS, {
        "action": "query", "generator": "categorymembers",
        "gcmtitle": f"Category:{category}", "gcmtype": "file", "gcmlimit": limit,
        "prop": "imageinfo|coordinates",
        "iiprop": "url|mime", "iiurlwidth": thumb_width,
    })
    out = []
    for p in d.get("query", {}).get("pages", {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        if not (ii.get("mime") or "").startswith("image/"):
            continue
        coord = (p.get("coordinates") or [{}])[0]
        out.append({
            "title": p["title"].replace("File:", ""),
            "url": ii.get("thumburl") or ii.get("url"),
            "mime": ii.get("mime"),
            "lat": coord.get("lat"), "lon": coord.get("lon"),
        })
    return out


def flag_of_qid(qid):
    """Deterministic: return the P41 flag-image Commons filename for a Wikidata
    QID (e.g. 'Q176'), or None. Preferred when the subject label is ambiguous
    (Quebec city vs province, Georgia state vs country) — pin the QID once and it
    never drifts."""
    c = api(WIKIDATA, {"action": "wbgetclaims", "entity": qid, "property": "P41"})
    for cl in c.get("claims", {}).get("P41", []):
        try:
            return cl["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
    return None


def resolve_flag(label, hint=None):
    """Look up `label` on Wikidata and return its P41 ("flag image") Commons
    filename (no 'File:' prefix), or None. Robust to Commons title drift because
    it follows the entity, not a guessed filename.

    `wbsearchentities` does prefix matching, so the hint is NOT concatenated into
    the query (that yields zero hits). Instead, when several items match, the hint
    is used to rank candidates by overlap with each item's description, and the
    first candidate that actually carries a P41 flag wins."""
    s = api(WIKIDATA, {"action": "wbsearchentities", "search": label,
                       "language": "en", "limit": 7, "type": "item"})
    hits = s.get("search", [])
    if hint:
        hw = set(hint.lower().split())
        hits = sorted(hits, key=lambda h: -len(hw & set((h.get("description") or "").lower().split())))
    for hit in hits:
        c = api(WIKIDATA, {"action": "wbgetclaims", "entity": hit["id"], "property": "P41"})
        for cl in c.get("claims", {}).get("P41", []):
            try:
                return cl["mainsnak"]["datavalue"]["value"]   # Commons filename
            except (KeyError, TypeError):
                continue
    return None


def file_url(file_title):
    """Resolve a Commons 'File:Foo.svg' (or bare 'Foo.svg') to its real
    upload.wikimedia.org URL via imageinfo. Not subject to FilePath throttling."""
    title = file_title if file_title.startswith("File:") else "File:" + file_title
    d = api(COMMONS, {"action": "query", "titles": title,
                      "prop": "imageinfo", "iiprop": "url"})
    for _, pg in d.get("query", {}).get("pages", {}).items():
        ii = pg.get("imageinfo")
        if ii:
            return ii[0]["url"]
    return None


def download(url, dest, want_image=True):
    """Download `url` to Path `dest` (parent created). Optionally verify it looks
    like an image/SVG before writing. Returns the byte count."""
    data, ctype = net.get(url)
    if want_image:
        head = data.lstrip()[:200].lower()
        ok_svg = head.startswith((b"<?xml", b"<svg", b"<!doctype svg")) or b"<svg" in head
        ok_bin = (ctype or "").startswith("image/") or \
            url.lower().rsplit(".", 1)[-1] in ("png", "jpg", "jpeg", "gif", "webp", "svg")
        if not (ok_svg or ok_bin):
            raise ValueError(f"response does not look like an image (content-type {ctype})")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return len(data)


def fetch_flag(label, dest, hint=None, qid=None, commons_file=None):
    """Convenience: resolve a subject's flag and download it. Resolution order:
    explicit `commons_file` (when Wikidata has no P41) → pinned `qid` → label+hint
    search. Returns (commons_filename, bytes) or raises. Skips if dest exists."""
    if dest.is_file():
        return None, dest.stat().st_size
    fname = commons_file or (flag_of_qid(qid) if qid else None)
    if not fname:
        fname = resolve_flag(label, hint)
    if not fname:
        raise LookupError(f"no flag for '{label}'" + (f" / {qid}" if qid else ""))
    url = file_url(fname)
    if not url:
        raise LookupError(f"could not resolve URL for '{fname}'")
    n = download(url, dest)
    return fname, n
