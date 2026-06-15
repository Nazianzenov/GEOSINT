#!/usr/bin/env python3
"""GeOSINT - GeoHints image cache (one-time localizer).

Scans wiki/docs/**/*.md for GeoHints gallery image URLs
(https://<host>.geohints.com/storage/<category>/<name>.<ext>), downloads each
one into wiki/docs/assets/gh/<category>/<name>.<ext>, and rewrites the markdown
<img src="..."> reference to the local copy. The original URL and fetch time
are recorded in wiki/gh_manifest.json.

Unlike cache_wikimedia.py this is a deliberate ONE-OFF mirror: by policy these
images are NOT refreshed automatically. Once an image exists locally it is
never re-downloaded; the only network traffic on later runs is for genuinely
new GeoHints URLs that someone has added to the markdown. Pass --force to
re-fetch everything (e.g. to repair a corrupted cache).

GeoHints (https://geohints.com/) is credited in wiki/docs/sources.md; the map
links in each caption are left untouched. Run once:

    .venv\\Scripts\\python tools\\cache_geohints.py
"""
import argparse
import json
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import net                                  # shared polite HTTP layer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "wiki" / "docs"
ASSETS = DOCS / "assets" / "gh"
MANIFEST = ROOT / "wiki" / "gh_manifest.json"

# https://<sub>.geohints.com/storage/<category>/<file>.<ext>
URL_RE = re.compile(
    r"https://[a-z0-9-]+\.geohints\.com/storage/"
    r"(?P<cat>[A-Za-z0-9_-]+)/(?P<name>[^\s)\"'<>]+)")


def local_relpath(url):
    """Repo-relative cache path (assets/gh/<category>/<file>) for a URL,
    preserving GeoHints' own category/filename layout. Returns None for a
    non-matching URL."""
    m = URL_RE.match(url)
    if not m:
        return None
    name = urllib.parse.unquote(m.group("name").split("?")[0])
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.") or "img"
    cat = re.sub(r"[^A-Za-z0-9._-]+", "-", m.group("cat")).strip("-.") or "misc"
    return ASSETS.relative_to(DOCS) / cat / name


def download(url, dest):
    """Fetch url via the shared polite layer to dest (a Path). Refuses to write a
    response that isn't an image — guards against an error page or MITM'd payload
    being saved as a .jpg."""
    data, ctype = net.get(url)
    if not (ctype.startswith("image/") or ctype == "application/octet-stream"):
        raise ValueError(f"non-image content-type '{ctype}'")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="re-fetch every image even if already cached")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    now = datetime.now(timezone.utc)
    fetched = skipped = failed = rewritten = 0

    for md in sorted(DOCS.rglob("*.md")):
        text = md.read_text(encoding="utf-8")
        urls = {m.group(0) for m in URL_RE.finditer(text)}
        if not urls:
            continue
        changed = False
        for url in sorted(urls):
            rel = local_relpath(url)
            if rel is None:
                continue
            dest = DOCS / rel
            if dest.is_file() and not args.force:
                skipped += 1
                manifest.setdefault(url, {"file": rel.as_posix(),
                                         "fetched": now.isoformat()})
            else:
                try:
                    download(url, dest)
                    manifest[url] = {"file": rel.as_posix(), "fetched": now.isoformat()}
                    fetched += 1
                    print(f"  fetched  {rel.as_posix()}")
                except Exception as e:
                    failed += 1
                    print(f"  FAIL {url} ({e})")
                    continue
            # rewrite to a path relative to THIS markdown file's BUILT location.
            # With mkdocs use_directory_urls, page foo/bar.md is served at
            # /wiki/foo/bar/, i.e. one directory deeper than the source — so add
            # one extra ".." on top of the source-relative depth.
            depth = len(md.relative_to(DOCS).parts) - 1 + 1
            ref = Path(*([".."] * depth)) / rel
            text = text.replace(url, ref.as_posix())
            changed = True
        if changed:
            md.write_text(text, encoding="utf-8")
            rewritten += 1

    MANIFEST.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    total_kb = (sum(f.stat().st_size for f in ASSETS.rglob("*") if f.is_file()) // 1024
                if ASSETS.is_dir() else 0)
    print(f"done: {fetched} fetched, {skipped} already cached, {failed} failed, "
          f"{rewritten} pages rewritten to local paths. "
          f"Cache: wiki/docs/assets/gh ({total_kb} KB)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
