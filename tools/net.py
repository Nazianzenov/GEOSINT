#!/usr/bin/env python3
"""GeOSINT - shared polite HTTP layer for the data-fetching tools.

One place for "fetch a URL like a good citizen": a descriptive User-Agent, a
small inter-request floor delay shared across the whole run, and exponential
backoff that honours the `Retry-After` header on 429/503. Every fetcher
(Wikidata/Commons via wikimedia.py, the dataset/refdata/flora builders, the
GeoHints/Wikimedia image cachers) sits on top of this so behaviour is uniform.

    get(url)            -> (bytes, content_type)
    get_json(url, ...)  -> parsed JSON (sets Accept; raises on non-JSON)

Tools that talk to a specific service add their own logic above this — they do
not re-implement retries or rate limiting.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

# Single source of truth for version + UA is geosint/__init__.py. Derive both
# from it so the fetchers advertise the same version as the server. Import
# defensively (and add the repo root to sys.path) so this module still works when
# run as a loose script where the package isn't already importable; the fallback
# reproduces the identical UA template if the import can't be resolved.
try:
    from geosint import __version__, ua as _ua
except Exception:                       # pragma: no cover - loose-script fallback
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from geosint import __version__, ua as _ua
    except Exception:
        __version__ = "1.0.0"

        def _ua(version=__version__):
            return (f"GeOSINT-Workbench/{version} "
                    f"(https://github.com/Nazianzenov/GEOSINT; "
                    f"non-commercial personal OSINT tool)")

UA = _ua(__version__)

FLOOR = 0.5            # min seconds between any two requests (whole-run shared)
_last = [0.0]
_RETRY_CODES = (429, 500, 502, 503)


def _throttle():
    dt = time.time() - _last[0]
    if dt < FLOOR:
        time.sleep(FLOOR - dt)
    _last[0] = time.time()


# Per RFC 7231 Retry-After is either delta-seconds (an integer) or an HTTP-date;
# Wikidata/Commons send the HTTP-date form. Returns the seconds to wait, or None
# if the header is missing/unparseable (caller then uses its default backoff).
# Far-future dates are clamped so a bad header can't hang the build, and any
# parse failure is swallowed so this never raises out of get().
_RETRY_AFTER_MAX = 300.0


def _retry_after_seconds(ra):
    if not ra:
        return None
    ra = ra.strip()
    if ra.isdigit():
        return min(_RETRY_AFTER_MAX, float(ra))
    try:
        parsed = parsedate_to_datetime(ra)
        if parsed is None:
            return None
        now = datetime.now(timezone.utc) if parsed.tzinfo else datetime.now()
        delta = (parsed - now).total_seconds()
    except Exception:
        return None
    return max(0.0, min(_RETRY_AFTER_MAX, delta))


# Hosts that failed every connection attempt (DNS failure, refused, unreachable)
# earlier in this run: later calls fail at once instead of sleeping through the
# same retries per URL — an offline build used to take hours. HTTP 429/5xx are
# still retried `tries` times; a dead network gets NET_TRIES attempts per host.
_dead_hosts = set()
NET_TRIES = 3


def get(url, timeout=40, accept=None, tries=6):
    """GET `url` politely. Returns (bytes, content_type). Retries 429/5xx with
    backoff that honours Retry-After (both delta-seconds and HTTP-date forms);
    raises on other HTTP errors / final fail."""
    host = urllib.parse.urlsplit(url).hostname
    if host in _dead_hosts:
        raise urllib.error.URLError(f"{host} unreachable earlier in this run")
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    last, net_fails = None, 0
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
            ra = _retry_after_seconds(e.headers.get("Retry-After"))
            wait = ra if ra is not None else min(60, 5 * (attempt + 1) ** 2)
            time.sleep(wait)
        except urllib.error.URLError as e:
            last, net_fails = e, net_fails + 1
            if net_fails >= NET_TRIES:
                _dead_hosts.add(host)
                break
            time.sleep(5 * net_fails)
    raise last if last else RuntimeError(f"request failed after retries: {url}")


def get_json(url, timeout=60, accept="application/json"):
    """GET and parse JSON (raises if the body is not valid JSON)."""
    data, _ = get(url, timeout=timeout, accept=accept)
    return json.loads(data.decode("utf-8"))

