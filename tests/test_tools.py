"""Unit tests for the data-build tools' failure handling (audit 2026-10-21, #141).

No network: urlopen / the Wikimedia client are stubbed. The contract under test is
what happens when the network is down or upstream answers badly — the build must
fail fast and must never overwrite good, tracked data with empty results."""
import json
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_commons_gallery as gallery  # noqa: E402
import build_flora  # noqa: E402
import fetch_datasets  # noqa: E402
import net  # noqa: E402


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    net._dead_hosts.clear()
    yield
    net._dead_hosts.clear()


def test_dead_host_fails_fast_after_its_first_url(monkeypatch):
    calls = []

    def down(req, timeout):
        calls.append(req.full_url)
        raise urllib.error.URLError("no route to host")
    monkeypatch.setattr(net.urllib.request, "urlopen", down)
    with pytest.raises(urllib.error.URLError):
        net.get("https://query.wikidata.org/a")
    assert len(calls) == net.NET_TRIES                 # a few attempts, not six
    with pytest.raises(urllib.error.URLError):
        net.get("https://query.wikidata.org/b")        # same host: no new attempt
    assert len(calls) == net.NET_TRIES


def test_numeric_retry_after_is_capped():
    assert net._retry_after_seconds("86400") == net._RETRY_AFTER_MAX
    assert net._retry_after_seconds("7") == 7.0


def test_empty_dataset_never_replaces_the_existing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(fetch_datasets, "DATA", tmp_path)
    (tmp_path / "unesco.json").write_text('{"rows": [1]}', encoding="utf-8")
    with pytest.raises(RuntimeError):
        fetch_datasets.write_dataset("unesco", "UNESCO", "CC0", "wikidata", [])
    assert json.loads((tmp_path / "unesco.json").read_text())["rows"] == [1]


def test_flora_keeps_good_data_when_lookups_fail(monkeypatch, tmp_path):
    data = tmp_path / "flora.json"
    old = {"fetched": "2020-01-01T00:00:00+00:00",          # stale -> a refetch is attempted
           "species": [{"common": "x", "img": "https://upload.wikimedia.org/x.jpg", "gbif": 1}]}
    data.write_text(json.dumps(old), encoding="utf-8")
    monkeypatch.setattr(build_flora, "DATA", data)
    monkeypatch.setattr(build_flora.time, "sleep", lambda s: None)

    def offline(url):
        raise urllib.error.URLError("offline")
    monkeypatch.setattr(build_flora, "http_json", offline)
    d, changed = build_flora.build_data(force=False)
    assert changed is False and d == old
    assert json.loads(data.read_text(encoding="utf-8")) == old


def _gallery_run(monkeypatch, tmp_path, imgs):
    """One build_topic run against stubbed Commons lookups; returns the page text."""
    monkeypatch.setattr(gallery, "ASSETS", tmp_path / "assets")
    monkeypatch.setattr(gallery, "PAGES", tmp_path / "pages")
    monkeypatch.setattr(gallery, "COUNTRIES", {"Europe": [("France", "fr")]})
    fetched = []

    def download(url, dest):
        fetched.append(url)
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(url.encode())
    monkeypatch.setattr(gallery.wm, "download", download)
    if isinstance(imgs, Exception):
        def lookup(*a, **k):
            raise imgs
    else:
        def lookup(*a, **k):
            return imgs
    monkeypatch.setattr(gallery.wm, "category_images", lookup)
    gallery.build_topic("fire-hydrants", gallery.TOPICS["fire-hydrants"])
    page = tmp_path / "pages" / "fire-hydrants.md"
    return page.read_text(encoding="utf-8"), fetched


def test_gallery_refetches_when_a_category_is_reordered(monkeypatch, tmp_path):
    a = {"url": "https://up/a.jpg", "mime": "image/jpeg", "lat": 1.0, "lon": 1.0}
    b = {"url": "https://up/b.jpg", "mime": "image/jpeg", "lat": 2.0, "lon": 2.0}
    _gallery_run(monkeypatch, tmp_path, [a, b])
    page, fetched = _gallery_run(monkeypatch, tmp_path, [b, a])      # Commons reordered
    first = tmp_path / "assets" / "hydrants" / "fr" / "fr_1.jpg"
    assert first.read_bytes() == b"https://up/b.jpg"                 # file now matches caption
    assert page.index("#ll=2.0,2.0") < page.index("#ll=1.0,1.0")
    assert sorted(fetched) == ["https://up/a.jpg", "https://up/b.jpg"]
    _, fetched = _gallery_run(monkeypatch, tmp_path, [b, a])          # unchanged -> cached
    assert fetched == []


def test_gallery_extension_ignores_the_tracking_query():
    # Commons thumb URLs now end in "?utm_source=commons.wikimedia.org&…"; its dots
    # used to become the file "extension" for mimes outside the table.
    url = ("https://upload.wikimedia.org/a/b/X.tif/lossy-page1-500px-X.tif.jpg"
           "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo")
    assert gallery.ext_of("image/tiff", url) == ".jpg"
    assert gallery.ext_of("image/png", url) == ".png"


def test_gallery_keeps_the_page_when_lookups_fail(monkeypatch, tmp_path):
    a = {"url": "https://up/a.jpg", "mime": "image/jpeg", "lat": 1.0, "lon": 1.0}
    good, _ = _gallery_run(monkeypatch, tmp_path, [a])
    page, _ = _gallery_run(monkeypatch, tmp_path, OSError("offline"))
    assert page == good
