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

# Neutral IP/ASN echo endpoints used by check_egress(), tried in order until one
# answers. These are the ONLY extra hosts this feature can reach, and only when a
# check is requested. We deliberately do NOT use Proton's own API
# (api.protonvpn.ch rejects generic clients with HTTP 422); a neutral echo that
# returns the org/ASN works for any provider and lets us recognise ProtonVPN by
# its ASN (AS62371) or name — and the analyst can set an explicit `vpn.match`
# signature for partner servers / any other VPN.
ECHO_ENDPOINTS = [
    # ipinfo.io: keyless, https; `org` is "AS<num> <name>" (e.g. "AS62371 Proton AG").
    ("https://ipinfo.io/json", "ipinfo"),
    # ip-api.com fallback: keyless, http on the free tier (reveals only the IP we
    # are deliberately testing, through the route under test).
    ("http://ip-api.com/json/?fields=status,country,query,org,isp,as", "ipapi"),
]

DEFAULT_CONFIG = {
    "version": 1,
    # Out of the box every feature is "direct" — identical to the pre-OPSEC
    # behaviour (real IP, honest UA). Routing is strictly opt-in; the settings
    # page's "Recommended" preset is what moves features onto the VPN lane.
    "routes": {f: "direct" for f in FEATURES},
    # provider: None | "protonvpn" | "generic"; verify: fail closed on vpn routes
    # when the exit can't be confirmed; match: optional user-supplied signature
    # (org / ASN / IP keyword) that overrides auto-detection (works for any VPN).
    "vpn": {"provider": None, "verify": True, "match": ""},
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
            elif isinstance(r, str) and r.startswith("proxy:") and r[6:]:
                # Kept even when that proxy is missing/invalid: opener_for() then
                # raises and the feature fails closed — never silently "direct".
                out["routes"][f] = r
            # else: keep the default ("direct")
    vpn = cfg.get("vpn")
    if isinstance(vpn, dict):
        prov = vpn.get("provider")
        out["vpn"]["provider"] = prov if prov in ("protonvpn", "generic") else None
        out["vpn"]["verify"] = bool(vpn.get("verify", True))
        out["vpn"]["match"] = str(vpn.get("match") or "")[:80]
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
    """Drop the cached openers and VPN verifications — called after the config
    changes so a new route (proxy host/port) takes effect immediately and a check
    made under the old config can't keep the VPN gate open."""
    _openers.clear()
    _verify_state.clear()


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
VERIFY_MAX_AGE = 120     # seconds a positive check is trusted; the server re-checks after
VERIFY_RETRY = 15        # seconds before re-checking after a failed / negative check


def _provider_match(vpn, info):
    """Decide whether the observed exit looks like the configured VPN. A
    user-supplied `match` substring (org / ASN / IP keyword) is authoritative and
    provider-agnostic; otherwise ProtonVPN is recognised by its ASN (AS62371) or
    name. Returns True/False, or None when there's nothing to match against (a
    generic VPN with no `match` — the UI shows the org for the analyst to judge)."""
    blob = (f"{info.get('ip', '')} {info.get('org', '')} "
            f"{info.get('isp', '')} {info.get('as', '')}").lower()
    match = (vpn.get("match") or "").strip().lower()
    if match:
        return match in blob
    if vpn.get("provider") == "protonvpn":
        return ("proton" in blob) or ("as62371" in blob)
    return None


def _parse_echo(kind, data):
    """Normalise an IP-echo response to {ip, country, org, isp, as}."""
    if kind == "ipinfo":
        org = str(data.get("org") or "")              # "AS<num> <name>"
        return {"ip": str(data.get("ip") or ""), "country": str(data.get("country") or ""),
                "org": org, "isp": org, "as": org}
    return {"ip": str(data.get("query") or ""), "country": str(data.get("country") or ""),
            "org": str(data.get("org") or ""), "isp": str(data.get("isp") or ""),
            "as": str(data.get("as") or "")}


def check_egress(cfg, no_redirect_cls, *, now, timeout=12):
    """Fetch the current exit IP/org THROUGH the vpn/direct opener (trying the echo
    endpoints in order) and record whether the machine appears to be on the
    configured VPN. Returns {ok, provider, on_vpn, ip, country, org, isp, as};
    updates _verify_state. Network call (to a neutral echo only); safe from a
    request handler."""
    opener = opener_for("vpn", cfg, no_redirect_cls)   # vpn lane == direct transport
    info, last = None, None
    for url, kind in ECHO_ENDPOINTS:
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": NEUTRAL_UA, "Accept": "application/json"})
            with opener.open(req, timeout=timeout) as r:
                data = json.loads(r.read(65536).decode("utf-8", "replace"))
            info = _parse_echo(kind, data)
            break
        except Exception as e:
            last = e
    key = cfg["vpn"]["provider"] or "generic"
    if info is None:
        _verify_state[key] = {"on_vpn": None, "at": now}   # a failed check closes the gate too
        raise EgressError(str(last) if last else "no IP-echo reachable")
    on_vpn = _provider_match(cfg["vpn"], info)
    _verify_state[key] = {**info, "on_vpn": on_vpn, "at": now}
    return {"ok": True, "provider": cfg["vpn"]["provider"], "on_vpn": on_vpn, **info}


def _gate(feature, cfg):
    """How the VPN gate treats `feature`: "open" (not gated), "blocked" (VPN lane
    with nothing to verify against) or "verify" (needs a recent positive check)."""
    if resolve(feature, cfg) != "vpn" or not cfg["vpn"].get("verify", True):
        return "open"
    provider = cfg["vpn"]["provider"]
    has_match = bool((cfg["vpn"].get("match") or "").strip())
    if provider is None and not has_match:
        return "blocked"
    # A generic VPN with no signature can't be auto-verified; allow it (the UI warns).
    if provider == "generic" and not has_match:
        return "open"
    return "verify"


def check_due(feature, cfg, now):
    """True when `feature` is gated on a VPN check that is missing or stale (older
    than VERIFY_MAX_AGE after a pass, VERIFY_RETRY after a fail). The server then
    re-runs check_egress() so a VPN that dropped after verification is caught."""
    if _gate(feature, cfg) != "verify":
        return False
    st = _verify_state.get(cfg["vpn"]["provider"] or "generic")
    if not st:
        return True
    return now - st["at"] >= (VERIFY_MAX_AGE if st.get("on_vpn") is True else VERIFY_RETRY)


def egress_allowed(feature, cfg, *, now):
    """Pure, no-network gate on the request hot path. Returns (allowed, reason).

    Only the **vpn** route can fail closed (the user's "select ProtonVPN → if the
    machine isn't on it, it won't work"). A verified lane needs a positive check
    younger than VERIFY_MAX_AGE; an explicit negative, a failed check, no check yet
    or an expired one all block (fail closed). 'direct', 'proxy:*' and 'tor' are not
    gated here (they either work at the socket or fail like any upstream). The
    generalized offline/airplane mode is tracked in Axis C (issue #131)."""
    gate = _gate(feature, cfg)
    if gate == "open":
        return True, ""
    if gate == "blocked":
        return False, "VPN lane selected but no provider / expected exit set — configure it in OPSEC settings"
    st = _verify_state.get(cfg["vpn"]["provider"] or "generic")
    if not st:
        return False, "VPN not verified yet — run an egress check in OPSEC settings"
    if st.get("on_vpn") is not True:
        return False, "egress is NOT going through the expected VPN — request blocked (fail-closed)"
    if now - st["at"] >= VERIFY_MAX_AGE:
        return False, "VPN check expired and could not be renewed — request blocked (fail-closed)"
    return True, ""
