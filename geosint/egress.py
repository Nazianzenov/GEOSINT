"""Egress routing for the running server's outbound proxies (OPSEC Axis A).

The workbench has two runtime outbound chokepoints — ``upstream_get()`` (tiles +
``/api/pget`` + GBIF/wiki-image proxies) and the Overpass loop — that, before
this module, both opened through one redirect-refusing opener with one fixed
User-Agent. This module makes the **route** of each outbound request configurable
per host-class ("feature"), so an analyst can send map tiles direct (behind their
system VPN), sensitive geocoding through a residential proxy, and a species
lookup through Tor — independently.

It is deliberately separate from :mod:`geosint.proxy` (the cache orchestration):
this module owns the **transport** (which opener, which proxy, which UA);
``proxy.py`` owns the cache (hit / miss / stale). The HTTP Handler stays thin.

Design invariants — DO NOT break:
  * **Every opener keeps the redirect-refusing handler** (anti-SSRF). The handler
    class is injected by the caller (server passes ``_NoRedirect``) so this module
    never imports ``server`` (no cycle) and the SSRF guard can't be dropped.
  * **Config + credentials live ONLY on disk** (``opsec.json``, chmod 600) and are
    **never logged**. ``masked()`` strips secrets for any value sent to a client.
  * **The default install stays pure-stdlib.** SOCKS routes (Tor / SOCKS5
    residential proxies) lazily import PySocks and degrade to a clear, catchable
    error if it is absent — the default config uses no SOCKS, so a stock install
    never needs the dependency.

Route vocabulary (a feature maps to exactly one):
  * ``"direct"`` — no app-level proxy; uses the OS route as-is (the real IP).
  * ``"vpn"``    — same transport as direct, but treated as "behind my system VPN":
                   subject to provider verification (see :func:`egress_allowed`),
                   so a VPN-routed feature fails **closed** when the machine is not
                   confirmed to be on the selected provider ("won't work" = no leak).
  * ``"proxy:<id>"`` — an HTTP(S) or SOCKS5 proxy from ``config["proxies"][id]``
                   (e.g. a Webshare residential proxy, with optional credentials).
  * ``"tor"``    — SOCKS5h to the local Tor SOCKS port (remote DNS, so lookups do
                   not leak to the system resolver).
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

# The routable host-classes. Each outbound request the server makes is tagged
# with one of these; the config maps each to a route. Keep in sync with the
# server call sites and the settings page.
FEATURES = ("tiles", "geocode", "weather", "overpass", "gbif", "media")

# Routes that need SOCKS (and therefore PySocks).
_SOCKS_SCHEMES = ("socks5", "socks5h", "socks4")

# IP-echo endpoints used by check_egress(), per VPN provider preset. These are the
# ONLY extra hosts this feature can reach, and only when a check is requested.
ECHO_ENDPOINTS = {
    # Proton's own location API reports the public IP + ISP; on Proton the ISP/org
    # reads as Proton, which is how we confirm the tunnel is actually up.
    "protonvpn": "https://api.protonvpn.ch/vpn/location",
    # Generic: a keyless IP/org/ASN echo. http-only on the free tier (it only
    # reveals the IP we are testing anyway, through the route under test).
    "generic": "http://ip-api.com/json/?fields=status,country,query,org,isp,as",
}

DEFAULT_CONFIG = {
    "version": 1,
    # Out of the box every feature is "direct" — identical to the pre-OPSEC
    # behaviour (real IP, honest UA). Routing is strictly opt-in; the settings
    # page's "Recommended" preset is what moves features onto the VPN lane.
    "routes": {f: "direct" for f in FEATURES},
    # provider: None | "protonvpn" | "generic"; verify: fail closed on vpn routes
    # when the provider can't be confirmed.
    "vpn": {"provider": None, "verify": True},
    # id -> {scheme: http|https|socks5|socks5h, host, port, user, pass}
    "proxies": {},
    # Tor SOCKS endpoint (only used by the "tor" route).
    "tor": {"host": "127.0.0.1", "port": 9050},
    # Outbound User-Agent: "default" (the honest GeOSINT UA) | "neutral" (drops the
    # repo URL + version so the tool/version isn't broadcast) | any custom string.
    "ua": "default",
}

NEUTRAL_UA = "Mozilla/5.0 (compatible)"


class EgressError(RuntimeError):
    """A route could not be built or is not permitted. Callers treat this like any
    upstream failure (it flows into their existing except: → cache-or-error), so a
    blocked/misconfigured route degrades gracefully and never leaks."""


# ── config load / validate / save / mask ────────────────────────────────────
def _coerce_proxy(p):
    """Validate one proxy entry; return a clean dict or None if unusable."""
    if not isinstance(p, dict):
        return None
    scheme = str(p.get("scheme") or "http").lower()
    if scheme not in ("http", "https") + _SOCKS_SCHEMES:
        return None
    host = str(p.get("host") or "").strip()
    if not host:
        return None
    try:
        port = int(p.get("port"))
    except (TypeError, ValueError):
        return None
    if not (0 < port < 65536):
        return None
    return {
        "scheme": scheme, "host": host, "port": port,
        "user": str(p.get("user") or ""), "pass": str(p.get("pass") or ""),
    }


def normalize(cfg):
    """Return a clean, fully-populated config from arbitrary (untrusted) input.
    Unknown keys are dropped; bad values fall back to the default. Never raises."""
    out = json.loads(json.dumps(DEFAULT_CONFIG))   # deep copy of defaults
    if not isinstance(cfg, dict):
        return out
    proxies = {}
    raw_proxies = cfg.get("proxies")
    if isinstance(raw_proxies, dict):
        for pid, p in raw_proxies.items():
            cp = _coerce_proxy(p)
            if cp is not None and isinstance(pid, str) and pid:
                proxies[pid[:40]] = cp
    out["proxies"] = proxies
    routes = cfg.get("routes")
    if isinstance(routes, dict):
        for f in FEATURES:
            r = routes.get(f)
            if r in ("direct", "vpn", "tor"):
                out["routes"][f] = r
            elif isinstance(r, str) and r.startswith("proxy:") and r[6:] in proxies:
                out["routes"][f] = r
            # else: keep the default ("direct")
    vpn = cfg.get("vpn")
    if isinstance(vpn, dict):
        prov = vpn.get("provider")
        out["vpn"]["provider"] = prov if prov in ("protonvpn", "generic") else None
        out["vpn"]["verify"] = bool(vpn.get("verify", True))
    tor = cfg.get("tor")
    if isinstance(tor, dict):
        out["tor"]["host"] = str(tor.get("host") or "127.0.0.1").strip() or "127.0.0.1"
        try:
            tp = int(tor.get("port", 9050))
            out["tor"]["port"] = tp if 0 < tp < 65536 else 9050
        except (TypeError, ValueError):
            out["tor"]["port"] = 9050
    ua = cfg.get("ua")
    if isinstance(ua, str) and ua.strip():
        out["ua"] = ua.strip()[:256]
    return out


def load_config(path: Path):
    """Read + normalize the on-disk OPSEC config, or defaults if absent/corrupt."""
    try:
        return normalize(json.loads(Path(path).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return json.loads(json.dumps(DEFAULT_CONFIG))


def save_config(path: Path, cfg, *, atomic_write):
    """Persist a normalized config via the injected atomic_write, then chmod 600
    (best-effort) — it can hold proxy credentials, so it must not be world-readable."""
    path = Path(path)
    clean = normalize(cfg)
    atomic_write(path, json.dumps(clean, indent=2).encode("utf-8"))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return clean


def masked(cfg):
    """A copy safe to send to a client: proxy passwords are never echoed back
    (replaced with a non-empty sentinel iff a password is set, so the UI can show
    'a password is stored' without revealing it)."""
    out = json.loads(json.dumps(normalize(cfg)))
    for p in out["proxies"].values():
        p["pass"] = "********" if p.get("pass") else ""
    return out


def merge_secrets(new_cfg, old_cfg):
    """When the UI re-saves config, a proxy whose password came back masked
    ('********') must keep the previously-stored secret rather than overwrite it
    with the mask. Apply that before saving."""
    new = normalize(new_cfg)
    old = normalize(old_cfg)
    for pid, p in new["proxies"].items():
        if p.get("pass") == "********":
            p["pass"] = old["proxies"].get(pid, {}).get("pass", "")
    return new


def ua_for(cfg, default_ua):
    mode = (cfg or {}).get("ua", "default")
    if mode == "default":
        return default_ua
    if mode == "neutral":
        return NEUTRAL_UA
    return mode or default_ua


def resolve(feature, cfg):
    """The route string for a feature (defaults to 'direct' for unknowns)."""
    return (cfg or {}).get("routes", {}).get(feature, "direct")


# ── opener factory (cached per route signature) ──────────────────────────────
_openers = {}        # signature -> urllib OpenerDirector


def reset_openers():
    """Drop the cached openers — called after the config changes so a new route
    (proxy host/port) takes effect immediately."""
    _openers.clear()


def _socks_handler(scheme, host, port, user, pwd):
    """Build a PySocks urllib handler (lazy import; clear error if missing)."""
    try:
        import socks                       # PySocks
        from sockshandler import SocksiPyHandler
    except Exception as e:                 # pragma: no cover - depends on optional dep
        raise EgressError(
            "SOCKS/Tor routing needs PySocks — install it with "
            "'pip install -r requirements-opsec.txt' (or 'pip install PySocks'), "
            "then restart the server.") from e
    stype = socks.SOCKS4 if scheme == "socks4" else socks.SOCKS5
    # rdns=True == socks5h: DNS is resolved at the proxy (Tor), not locally, so
    # hostname lookups don't leak to the system resolver.
    return SocksiPyHandler(stype, host, int(port), rdns=True,
                           username=(user or None), password=(pwd or None))


def _signature(route, cfg):
    if route in ("direct", "vpn"):
        return "direct"
    if route == "tor":
        t = cfg["tor"]
        return f"tor|{t['host']}:{t['port']}"
    if route.startswith("proxy:"):
        p = cfg["proxies"].get(route[6:])
        if not p:
            raise EgressError(f"unknown proxy '{route[6:]}'")
        return f"proxy|{p['scheme']}://{p['user']}@{p['host']}:{p['port']}"
    raise EgressError(f"unknown route '{route}'")


def opener_for(route, cfg, no_redirect_cls):
    """Return a cached urllib opener for ``route``. ALWAYS includes the injected
    redirect-refusing handler class (anti-SSRF). Raises EgressError for an
    unknown/misconfigured route or a missing SOCKS dependency."""
    sig = _signature(route, cfg)
    op = _openers.get(sig)
    if op is not None:
        return op
    if sig == "direct":
        op = urllib.request.build_opener(no_redirect_cls)
    elif sig.startswith("tor|"):
        t = cfg["tor"]
        op = urllib.request.build_opener(
            _socks_handler("socks5h", t["host"], t["port"], "", ""), no_redirect_cls)
    else:  # proxy
        p = cfg["proxies"][route[6:]]
        if p["scheme"] in _SOCKS_SCHEMES:
            op = urllib.request.build_opener(
                _socks_handler(p["scheme"], p["host"], p["port"], p["user"], p["pass"]),
                no_redirect_cls)
        else:
            cred = f"{p['user']}:{p['pass']}@" if p["user"] else ""
            url = f"{p['scheme']}://{cred}{p['host']}:{p['port']}"
            op = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": url, "https": url}),
                no_redirect_cls)
    _openers[sig] = op
    return op


# ── VPN verification + fail-closed gate ──────────────────────────────────────
# Last egress-check result per provider, set by check_egress() and read (without
# touching the network) by egress_allowed() on the request hot path.
_verify_state = {}       # provider -> {"on_vpn": bool|None, "ip", "country", "org", "at": monotonic}


def _provider_match(provider, ip, org, isp, country):
    blob = f"{org} {isp}".lower()
    if provider == "protonvpn":
        return "proton" in blob
    return None          # generic: cannot auto-confirm; the UI shows ip/org to judge


def check_egress(cfg, no_redirect_cls, *, now, timeout=12):
    """Fetch the IP-echo for the configured VPN provider THROUGH the vpn/direct
    opener and record whether the machine appears to be on that provider. Returns
    a dict {ok, ip, country, org, on_vpn, provider}. Updates _verify_state. Network
    call (to the provider's echo only); safe to call from a request handler."""
    provider = cfg["vpn"]["provider"] or "generic"
    url = ECHO_ENDPOINTS.get(provider, ECHO_ENDPOINTS["generic"])
    opener = opener_for("vpn", cfg, no_redirect_cls)   # vpn lane == direct transport
    try:
        req = urllib.request.Request(url, headers={"User-Agent": NEUTRAL_UA})
        with opener.open(req, timeout=timeout) as r:
            data = json.loads(r.read(65536).decode("utf-8", "replace"))
    except Exception as e:
        raise EgressError(str(e))
    ip = str(data.get("IP") or data.get("query") or data.get("ip") or "")
    country = str(data.get("Country") or data.get("country") or "")
    org = str(data.get("ISP") or data.get("Org") or data.get("org") or data.get("isp") or "")
    isp = str(data.get("ISP") or data.get("isp") or "")
    on_vpn = _provider_match(cfg["vpn"]["provider"], ip, org, isp, country)
    _verify_state[cfg["vpn"]["provider"] or "generic"] = {
        "on_vpn": on_vpn, "ip": ip, "country": country, "org": org, "at": now,
    }
    return {"ok": True, "ip": ip, "country": country, "org": org,
            "on_vpn": on_vpn, "provider": cfg["vpn"]["provider"]}


def egress_allowed(feature, cfg):
    """Pure, no-network gate on the request hot path. Returns (allowed, reason).

    Only the **vpn** route can fail closed (the user's "select ProtonVPN → if the
    machine isn't on it, it won't work"). For a Proton-verified lane we require a
    recent positive check; an explicit negative OR no check yet both block (fail
    closed). 'direct', 'proxy:*' and 'tor' are not gated here (they either work at
    the socket or fail like any upstream). The generalized offline/airplane mode +
    periodic kill-switch are tracked in Axis C (issue #131)."""
    route = resolve(feature, cfg)
    if route != "vpn" or not cfg["vpn"].get("verify", True):
        return True, ""
    provider = cfg["vpn"]["provider"]
    if provider is None:
        return False, "VPN lane selected but no provider chosen — set one in OPSEC settings"
    if provider == "generic":
        return True, ""          # cannot auto-verify a generic VPN; allowed (UI warns)
    st = _verify_state.get(provider)
    if not st:
        return False, f"{provider} not verified yet — run an egress check in OPSEC settings"
    if st.get("on_vpn") is True:
        return True, ""
    return False, f"egress is NOT going through {provider} — request blocked (fail-closed)"
