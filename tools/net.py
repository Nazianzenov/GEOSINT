#!/usr/bin/env python3
"""GeOSINT - shared polite HTTP layer for the data-fetching tools.

One place for "fetch a URL like a good citizen": a descriptive User-Agent, a
small inter-request floor delay shared across the whole run, and exponential
backoff that honours the `Retry-After` header on 429/503. Every fetcher
(Wikidata/Commons via wikimedia.py, the dataset/refdata/flora builders, the
GeoHints/Wikimedia image cachers) sits on top of this so behaviour is uniform.

    get(url)            -> (bytes, content_type)
    get_json(url, ...)  -> parsed JSON (sets Accept; raises on non-JSON)
    download(url, dest) -> bytes written (parent dir created)

Tools that talk to a specific service add their own logic above this — they do
not re-implement retries or rate limiting.
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

UA = ("GeOSINT-Workbench/1.0 (https://github.com/Nazianzenov/GEOSINT; "
      "non-commercial personal OSINT tool) python-urllib")

FLOOR = 0.5            # min seconds between any two requests (whole-run shared)
_last = [0.0]
_RETRY_CODES = (429, 500, 502, 503)


def _throttle():
    dt = time.time() - _last[0]
    if dt < FLOOR:
        time.sleep(FLOOR - dt)
    _last[0] = time.time()


def get(url, timeout=40, accept=None, tries=6):
    """GET `url` politely. Returns (bytes, content_type). Retries 429/5xx with
    backoff that honours Retry-After; raises on other HTTP errors / final fail."""
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    last = None
    for attempt in range(tries):
        _throttle()
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.headers.get_content_type()
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in _RETRY_CODES:
                raise
            ra = e.headers.get("Retry-After")
            wait = float(ra) if (ra and ra.isdigit()) else min(60, 5 * (attempt + 1) ** 2)
            time.sleep(wait)
        except urllib.error.URLError:
            last = None
            time.sleep(5 * (attempt + 1))
    if last:
        raise last
    raise RuntimeError(f"request failed after retries: {url}")


def get_json(url, timeout=60, accept="application/json"):
    """GET and parse JSON (raises if the body is not valid JSON)."""
    data, _ = get(url, timeout=timeout, accept=accept)
    return json.loads(data.decode("utf-8"))


def download(url, dest, timeout=60):
    """Fetch `url` and write the bytes to Path `dest` (parent created).
    Returns the byte count. Callers verify content type if they need to."""
    data, _ = get(url, timeout=timeout)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return len(data)
