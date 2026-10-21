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


def test_normalize_drops_unknown_route_but_keeps_dangling_proxy():
    cfg = egress.normalize({
        "routes": {"tiles": "bogus", "geocode": "proxy:ghost", "weather": "tor"},
    })
    assert cfg["routes"]["tiles"] == "direct"       # unknown route -> direct
    # a proxy route whose proxy is missing (renamed / failed validation) must NOT
    # degrade to direct (real IP) — it stays, and the opener fails closed
    assert cfg["routes"]["geocode"] == "proxy:ghost"
    with pytest.raises(egress.EgressError):
        egress.opener_for(egress.resolve("geocode", cfg), cfg, _NoRedirect)
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
    now = 1000.0
    allowed = lambda f, c, t=now: egress.egress_allowed(f, c, now=t)[0]
    assert allowed("tiles", egress.normalize({"routes": {"tiles": "direct"}})) is True
    # vpn + verify + no provider -> blocked
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": None, "verify": True}})
    assert allowed("tiles", cfg) is False
    # vpn + proton + no check yet -> blocked (fail closed)
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "protonvpn", "verify": True}})
    assert allowed("tiles", cfg) is False
    egress._verify_state["protonvpn"] = {"on_vpn": True, "at": now}     # positive check
    assert allowed("tiles", cfg) is True
    # the same positive check, VERIFY_MAX_AGE later, no longer opens the gate
    assert allowed("tiles", cfg, now + egress.VERIFY_MAX_AGE) is False
    egress._verify_state["protonvpn"] = {"on_vpn": False, "at": now}    # tunnel down
    assert allowed("tiles", cfg) is False
    # verify disabled -> always allowed
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "protonvpn", "verify": False}})
    assert allowed("tiles", cfg) is True
    # generic provider can't be auto-verified -> allowed (the UI warns)
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "generic", "verify": True}})
    assert allowed("tiles", cfg) is True
    # ...but a generic VPN WITH an explicit expected-exit signature is enforced
    cfg = egress.normalize({"routes": {"tiles": "vpn"},
                            "vpn": {"provider": "generic", "verify": True, "match": "M247"}})
    assert allowed("tiles", cfg) is False     # no check yet -> blocked
    egress._verify_state["generic"] = {"on_vpn": True, "at": now}
    assert allowed("tiles", cfg) is True
    egress._verify_state.clear()


def test_check_due_rechecks_stale_and_backs_off_after_failure():
    egress._verify_state.clear()
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "protonvpn", "verify": True}})
    assert egress.check_due("tiles", cfg, 0) is True                       # never checked
    assert egress.check_due("geocode", cfg, 0) is False                    # direct: not gated
    egress._verify_state["protonvpn"] = {"on_vpn": True, "at": 100.0}
    assert egress.check_due("tiles", cfg, 100.0 + egress.VERIFY_MAX_AGE - 1) is False
    assert egress.check_due("tiles", cfg, 100.0 + egress.VERIFY_MAX_AGE) is True
    egress._verify_state["protonvpn"] = {"on_vpn": None, "at": 100.0}     # last check failed
    assert egress.check_due("tiles", cfg, 100.0 + egress.VERIFY_RETRY - 1) is False
    assert egress.check_due("tiles", cfg, 100.0 + egress.VERIFY_RETRY) is True
    egress._verify_state.clear()


def test_failed_check_closes_a_previously_open_gate(monkeypatch):
    # verified at t=0, then the echo endpoints become unreachable: the re-check must
    # record the failure instead of leaving the old positive result in place
    cfg = egress.normalize({"routes": {"tiles": "vpn"}, "vpn": {"provider": "protonvpn", "verify": True}})
    egress._verify_state["protonvpn"] = {"on_vpn": True, "at": 0.0}

    class _Down:
        def open(self, *a, **k):
            raise OSError("network unreachable")
    monkeypatch.setattr(egress, "opener_for", lambda *a, **k: _Down())
    with pytest.raises(egress.EgressError):
        egress.check_egress(cfg, _NoRedirect, now=50.0)
    assert egress.egress_allowed("tiles", cfg, now=51.0)[0] is False
    egress._verify_state.clear()


def test_reset_openers_drops_verification():
    egress._verify_state["protonvpn"] = {"on_vpn": True, "at": 0.0}
    egress.reset_openers()
    assert egress._verify_state == {}


def test_normalize_keeps_vpn_match():
    assert egress.normalize({"vpn": {"match": "AS62371"}})["vpn"]["match"] == "AS62371"
    assert egress.normalize({})["vpn"]["match"] == ""


def test_provider_match():
    proton = {"provider": "protonvpn", "match": ""}
    assert egress._provider_match(proton, {"org": "AS62371 Proton AG"}) is True    # name
    assert egress._provider_match(proton, {"org": "AS62371 Datacamp"}) is True     # ASN
    assert egress._provider_match(proton, {"org": "AS9009 M247 Europe SRL"}) is False
    # an explicit match overrides (works for partner servers / any VPN)
    m = {"provider": "generic", "match": "M247"}
    assert egress._provider_match(m, {"org": "AS9009 M247 Europe SRL"}) is True
    assert egress._provider_match(m, {"org": "AS3320 Deutsche Telekom"}) is False
    # generic, no match -> None (can't auto-confirm)
    assert egress._provider_match({"provider": "generic", "match": ""}, {"org": "x"}) is None


def test_parse_echo_shapes():
    a = egress._parse_echo("ipinfo", {"ip": "1.2.3.4", "country": "CH", "org": "AS62371 Proton AG"})
    assert a["ip"] == "1.2.3.4" and a["as"] == a["org"] and "Proton" in a["org"]
    b = egress._parse_echo("ipapi", {"query": "5.6.7.8", "country": "US",
                                     "org": "O", "isp": "I", "as": "AS1"})
    assert b["ip"] == "5.6.7.8" and b["isp"] == "I" and b["as"] == "AS1"


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
