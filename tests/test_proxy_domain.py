"""Unit tests for the extracted cached-proxy core (geosint/proxy.py, #88).

All dependencies are injected, so these run with no network and no server: we
stub fetch/cache_fresh/atomic_write and assert the hit/miss/stale/error states
and the no-leak-on-error invariant."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from geosint import proxy  # noqa: E402


def _fresh(_p, _ttl):       # cache_fresh stub: "the file is fresh"
    return True


def _stale(_p, _ttl):       # cache_fresh stub: "not fresh"
    return False


def test_fresh_cache_is_a_hit_no_fetch(tmp_path):
    f = tmp_path / "c.bin"
    f.write_bytes(b"cached")
    def fetch(*a, **k):
        raise AssertionError("must not fetch on a fresh hit")
    res = proxy.fetch_cached(f, "http://x", 100, "image/png",
                             fetch=fetch, cache_fresh=_fresh, atomic_write=None)
    assert res.ok and res.body == b"cached" and res.cache_state == "hit"


def test_miss_fetches_validates_and_writes(tmp_path):
    f = tmp_path / "c.json"
    written = {}
    res = proxy.fetch_cached(
        f, "http://x", 100, "application/json",
        fetch=lambda url, timeout: b'{"ok":1}', cache_fresh=_stale,
        atomic_write=lambda p, b: written.update(p=p, b=b),
        validate=lambda b: __import__("json").loads(b))
    assert res.ok and res.body == b'{"ok":1}' and res.cache_state == "miss"
    assert written["b"] == b'{"ok":1}'          # body was cached


def test_invalid_body_is_not_cached_and_falls_to_error(tmp_path):
    f = tmp_path / "c.json"                       # does NOT exist -> no stale copy
    wrote = []
    res = proxy.fetch_cached(
        f, "http://x", 100, "application/json",
        fetch=lambda url, timeout: b"not json", cache_fresh=_stale,
        atomic_write=lambda p, b: wrote.append(b),
        validate=lambda b: __import__("json").loads(b))     # raises on bad body
    assert not res.ok and res.status == 502
    assert wrote == []                            # bad body NEVER cached


def test_upstream_error_serves_stale_when_present(tmp_path):
    f = tmp_path / "c.bin"
    f.write_bytes(b"old")                          # a stale copy exists
    res = proxy.fetch_cached(
        f, "http://x", 100, "image/png",
        fetch=lambda url, timeout: (_ for _ in ()).throw(OSError("boom")),
        cache_fresh=_stale, atomic_write=None)
    assert res.ok and res.body == b"old" and res.cache_state == "stale"


def test_upstream_error_no_copy_is_502_and_detail_only_in_log(tmp_path):
    f = tmp_path / "missing.bin"                   # no copy on disk
    res = proxy.fetch_cached(
        f, "http://secret.example/x?lat=1&lng=2", 100, "image/png",
        fetch=lambda url, timeout: (_ for _ in ()).throw(OSError("connect failed to 10.0.0.1")),
        cache_fresh=_stale, atomic_write=None,
        log_where="secret.example", error_msg="tile upstream unreachable")
    assert not res.ok and res.status == 502
    assert res.client_msg == "tile upstream unreachable"
    # the upstream error text (could carry host/IP/coords) is log-only
    assert "10.0.0.1" not in res.client_msg
    assert "10.0.0.1" in res.log_detail
