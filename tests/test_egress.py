"""Unit tests for the OPSEC egress routing module (geosint/egress.py).

Pure logic — NO network: config normalize / mask / merge-secrets, route
resolution, UA selection, opener construction (anti-SSRF handler preserved), and
the fail-closed VPN gate."""
import urllib.request
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from geosint import egress  # noqa: E402


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def test_defaults_all_direct():
    cfg = egress.normalize({})
    assert set(cfg["routes"]) == set(egress.FEATURES)
    assert all(v == "direct" for v in cfg["routes"].values())
    assert cfg["ua"] == "default"


def test_normalize_drops_unknown_route_and_dangling_proxy():
    cfg = egress.normalize({
        "routes": {"tiles": "bogus", "geocode": "proxy:ghost", "weather": "tor"},
    })
    assert cfg["routes"]["tiles"] == "direct"       # unknown route -> direct
    assert cfg["routes"]["geocode"] == "direct"     # proxy id doesn't exist -> direct
    assert cfg["routes"]["weather"] == "tor"
    cfg2 = egress.normalize({"routes": {"tiles": "proxy:p"},
                             "proxies": {"p": {"scheme": "http", "host": "h", "port": 8080}}})
    assert cfg2["routes"]["tiles"] == "proxy:p"     # valid proxy route survives


def test_normalize_rejects_bad_proxies():
    cfg = egress.normalize({"proxies": {
        "ok": {"scheme": "socks5", "host": "h", "port": 1080},
        "noport": {"scheme": "http", "host": "h"},
        "badscheme": {"scheme": "ftp", "host": "h", "port": 1},
        "badport": {"scheme": "http", "host": "h", "port": 99999},
    }})
    assert set(cfg["proxies"]) == {"ok"}


def test_masked_hides_passwords():
    cfg = egress.normalize({"proxies": {
        "p": {"scheme": "http", "host": "h", "port": 8080, "pass": "s3cret"}}})
    assert egress.masked(cfg)["proxies"]["p"]["pass"] == "********"
    cfg2 = egress.normalize({"proxies": {"p": {"scheme": "http", "host": "h", "port": 8080}}})
    assert egress.masked(cfg2)["proxies"]["p"]["pass"] == ""


def test_merge_secrets_keeps_stored_password():
    old = egress.normalize({"proxies": {
        "p": {"scheme": "http", "host": "h", "port": 8080, "pass": "real"}}})
    incoming = egress.masked(old)                   # what the UI receives (masked)
    assert egress.merge_secrets(incoming, old)["proxies"]["p"]["pass"] == "real"
    incoming["proxies"]["p"]["pass"] = "new"        # a genuine change overrides
    assert egress.merge_secrets(incoming, old)["proxies"]["p"]["pass"] == "new"


def test_ua_for():
    assert egress.ua_for({"ua": "default"}, "HONEST") == "HONEST"
    assert egress.ua_for({"ua": "neutral"}, "HONEST") == egress.NEUTRAL_UA
    assert egress.ua_for({"ua": "custom-agent/1"}, "HONEST") == "custom-agent/1"


def test_opener_direct_preserves_no_redirect_and_vpn_shares_it():
    egress.reset_openers()
    cfg = egress.normalize({})
    op = egress.opener_for("direct", cfg, _NoRedirect)
    assert isinstance(op, urllib.request.OpenerDirector)
    assert any(isinstance(h, _NoRedirect) for h in op.handlers)   # SSRF guard kept
    assert egress.opener_for("vpn", cfg, _NoRedirect) is op       # vpn == direct transport


def test_opener_unknown_proxy_raises():
    cfg = egress.normalize({})
    with pytest.raises(egress.EgressError):
        egress.opener_for("proxy:missing", cfg, _NoRedirect)
    with pytest.raises(egress.EgressError):
        egress.opener_for("nonsense", cfg, _NoRedirect)


def test_opener_http_proxy_routes_through_configured_host():
    egress.reset_openers()
    cfg = egress.normalize({"proxies": {
        "p": {"scheme": "http", "host": "127.0.0.1", "port": 8080}}})
    op = egress.opener_for("proxy:p", cfg, _NoRedirect)
    assert any(isinstance(h, _NoRedirect) for h in op.handlers)
    phs = [h for h in op.handlers if isinstance(h, urllib.request.ProxyHandler)]
    assert phs and "127.0.0.1:8080" in phs[0].proxies.get("http", "")


def test_egress_allowed_vpn_gate():
    egress._verify_state.clear()
    assert egress.egress_allowed("tiles", egress.normalize({"routes": {"tiles": "direct"}}))[0] is True
    # vpn + verify + no provider -> blocked
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": None, "verify": True}})
    assert egress.egress_allowed("tiles", cfg)[0] is False
    # vpn + proton + no check yet -> blocked (fail closed)
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "protonvpn", "verify": True}})
    assert egress.egress_allowed("tiles", cfg)[0] is False
    egress._verify_state["protonvpn"] = {"on_vpn": True, "at": 0}     # positive check
    assert egress.egress_allowed("tiles", cfg)[0] is True
    egress._verify_state["protonvpn"] = {"on_vpn": False, "at": 0}    # tunnel down
    assert egress.egress_allowed("tiles", cfg)[0] is False
    # verify disabled -> always allowed
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "protonvpn", "verify": False}})
    assert egress.egress_allowed("tiles", cfg)[0] is True
    # generic provider can't be auto-verified -> allowed (the UI warns)
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "generic", "verify": True}})
    assert egress.egress_allowed("tiles", cfg)[0] is True
    egress._verify_state.clear()


def test_save_and_load_round_trip(tmp_path):
    wrote = {}

    def atomic_write(path, data):
        Path(path).write_bytes(data)
        wrote["ok"] = True

    p = tmp_path / "opsec.json"
    egress.save_config(p, egress.normalize({"routes": {"geocode": "tor"}, "ua": "neutral"}),
                       atomic_write=atomic_write)
    assert wrote.get("ok")
    loaded = egress.load_config(p)
    assert loaded["routes"]["geocode"] == "tor" and loaded["ua"] == "neutral"
    assert egress.load_config(tmp_path / "nope.json")["routes"]["tiles"] == "direct"
