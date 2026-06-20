#!/usr/bin/env python3
"""GeOSINT - Wikimedia image cache.

Scans wiki/docs/**/*.md for Wikimedia image URLs
(https://commons.wikimedia.org/wiki/Special:FilePath/...), downloads each one
into wiki/docs/assets/wm/, and rewrites the markdown image reference to the
local copy. The original URL and fetch time are recorded in wiki/wm_manifest.json;
a cached image is only re-downloaded when its entry is older than 30 days
(pass --force to re-fetch everything).

Attribution links to the Commons file pages (/wiki/File:...) are left
untouched - only the displayed image is localized. Run any time:

    .venv\\Scripts\\python tools\\cache_wikimedia.py

run.ps1 -RebuildWiki runs this automatically before building.
"""
import argparse
import hashlib
import json
import re
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wikimedia as wm                     # unified resilient Wikimedia client

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "wiki" / "docs"
ASSETS = DOCS / "assets" / "wm"
MANIFEST = ROOT / "wiki" / "wm_manifest.json"
MAX_AGE = timedelta(days=30)

URL_RE = re.compile(
    r"https://(?:commons\.wikimedia\.org/wiki/Special:FilePath/"
    r"|upload\.wikimedia\.org/wikipedia/commons/)[^\s)\"'<>]+")
EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg",
       "image/gif": ".gif", "image/webp": ".webp", "image/tiff": ".tif"}


def safe_name(url):
    """Stable, filesystem-safe cache filename for a Special:FilePath URL."""
    name = url.rsplit("/", 1)[-1]
    name = urllib.parse.unquote(name.split("?")[0])
    width = re.search(r"[?&]width=(\d+)", url)
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")[:80] or "img"
    base = base.rsplit(".", 1)[0]  # extension comes from Content-Type
    h = hashlib.md5(url.encode()).hexdigest()[:8]
    return f"{base}{'_w' + width.group(1) if width else ''}_{h}"


def download(url, dest_name=None):
    """Fetch url through the unified Wikimedia client (polite + Retry-After
    backoff) and write it to assets/wm. Returns the final filename; if
    dest_name is given it is reused so existing markdown references stay valid."""
    data, ctype = wm.get_bytes(url)
    name = dest_name or (safe_name(url) + EXT.get(ctype, ".bin"))
    (ASSETS / name).write_bytes(data)
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-fetch everything regardless of age")
    args = ap.parse_args()

    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    now = datetime.now(timezone.utc)
    fetched = skipped = failed = rewritten = 0

    # Phase 1 - refresh: manifest entries older than MAX_AGE (markdown already
    # points at the local file, so we re-download to the SAME filename).
    for url, entry in manifest.items():
        have = (ASSETS / entry["file"]).is_file()
        age = now - datetime.fromisoformat(entry["fetched"])
        if have and not args.force and age <= MAX_AGE:
            skipped += 1
            continue
        try:
            download(url, dest_name=entry["file"] if have else None)
            entry["fetched"] = now.isoformat()
            fetched += 1
            print(f"  refreshed {entry['file']}")
        except Exception as e:
            if have:
                print(f"  WARN refresh failed, keeping cached copy: {entry['file']} ({e})")
            else:
                failed += 1
                print(f"  FAIL {url} ({e})")

    # Phase 2 - localize: any remote Wikimedia URLs still present in the
    # markdown (i.e. newly added images) get fetched and rewritten.
    for md in sorted(DOCS.rglob("*.md")):
        text = md.read_text(encoding="utf-8")
        urls = sorted(set(URL_RE.findall(text)))
        if not urls:
            continue
        changed = False
        for url in urls:
            entry = manifest.get(url)
            if not (entry and (ASSETS / entry["file"]).is_file()):
                try:
                    fname = download(url)
                    manifest[url] = entry = {"file": fname, "fetched": now.isoformat()}
                    fetched += 1
                    print(f"  fetched  {fname}")
                except Exception as e:
                    failed += 1
                    print(f"  FAIL {url} ({e})")
                    continue
            depth = len(md.relative_to(DOCS).parts) - 1
            rel = Path(*([".."] * depth)) / "assets" / "wm" / entry["file"]
            text = text.replace(url, rel.as_posix())
            changed = True
        if changed:
            md.write_text(text, encoding="utf-8")
            rewritten += 1

    MANIFEST.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    files = [f for f in ASSETS.iterdir() if f.is_file()]
    total_kb = sum(f.stat().st_size for f in files) // 1024
    print(f"done: {fetched} fetched, {skipped} fresh (<30 days, cache hit), {failed} failed, "
          f"{rewritten} pages rewritten to local paths. Cache: wiki/docs/assets/wm ({total_kb} KB)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
