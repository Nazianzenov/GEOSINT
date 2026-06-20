"""Cached-proxy domain logic — the cache-fresh/fetch/stale flow behind /tiles and
/api/pget, extracted from the HTTP Handler (#88).

The Handler keeps request parsing (tile-coord / allowlist validation, the SEC-01
cross-site refusal) and renders the result; this module owns the cache+fetch core
so it is testable without the HTTP machinery. Dependencies (the upstream getter,
the cache-freshness check, the atomic writer) are INJECTED so the module needs
nothing from server.py's globals and can be unit-tested with simple stubs.

The contract mirrors the original handler behaviour exactly:
  * fresh cache hit            -> raw(body, "hit")
  * miss: fetch + validate + write -> raw(body, "miss")
  * upstream error, stale copy exists -> raw(stale_body, "stale")
  * upstream error, no copy    -> error(502, generic, log=str(e))
The upstream error text (which can embed the URL/coords) goes to log_detail only.
"""
from .result import DomainResult


def fetch_cached(cache_file, url, ttl, ctype, *, fetch, cache_fresh, atomic_write,
                 timeout=30, validate=None, log_where=None, browser_ttl=0,
                 error_msg="upstream unreachable", stale_browser_ttl=0):
    """Serve `url` through the on-disk cache at `cache_file`.

    Injected: fetch(url, timeout)->bytes, cache_fresh(path, ttl)->bool,
    atomic_write(path, bytes). Optional validate(bytes) is called on a freshly
    fetched body before it is cached (e.g. json.loads); if it raises, the fetch is
    treated as a failure (the bad body is NOT cached).
    """
    if cache_fresh(cache_file, ttl):
        return DomainResult.raw(cache_file.read_bytes(), ctype, "hit", browser_ttl)
    try:
        body = fetch(url, timeout=timeout)
        if validate is not None:
            validate(body)
        atomic_write(cache_file, body)
        return DomainResult.raw(body, ctype, "miss", browser_ttl)
    except Exception as e:
        if cache_file.is_file():            # stale beats nothing
            return DomainResult.raw(cache_file.read_bytes(), ctype, "stale", stale_browser_ttl)
        return DomainResult.error(502, error_msg, log_where=log_where, log_detail=str(e))
