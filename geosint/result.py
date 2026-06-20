"""DomainResult — the contract between domain logic and the HTTP Handler (#88).

The goal is thin handlers: a handler parses the request, calls a domain function,
and renders the result. Domain functions (geosint/exif.py, geosint/proxy.py) know
nothing about HTTP — they return a DomainResult, and the Handler maps it to an
HTTP response.

The security reason this contract is explicit (rather than returning a bare dict
or raising): a domain failure carries TWO different texts that must never be
confused —
  * `client_msg` — a GENERIC, safe message the client may see (no paths, no
    stderr, no coordinates).
  * `log_detail` — the unsafe diagnostic (ExifTool stderr, exception text, the
    temp-file path) that goes ONLY to the operator log via Handler._warn.
Keeping them as separate fields makes it structurally hard to leak `log_detail`
to the client — the regression class SEC-11 / AUD-03 were about. The domain
function owns the security decision (what is safe vs. log-only); the Handler just
routes each field to the right place.
"""


class DomainResult:
    __slots__ = ("ok", "data", "body", "ctype", "cache_state", "browser_ttl",
                 "status", "client_msg", "log_where", "log_detail")

    def __init__(self, *, ok, data=None, body=None, ctype=None, cache_state=None,
                 browser_ttl=0, status=200, client_msg=None,
                 log_where=None, log_detail=None):
        self.ok = ok
        # success, JSON shape: `data` is a dict the Handler sends via send_json.
        self.data = data
        # success, raw-bytes shape (tiles/pget/overpass/preview): `body` + `ctype`
        # (+ optional cache_state "hit"/"miss"/"stale" and browser_ttl) -> sent via
        # send_cached_body. Exactly one of {data, body} is set on success.
        self.body = body
        self.ctype = ctype
        self.cache_state = cache_state
        self.browser_ttl = browser_ttl
        # failure: HTTP status + the SAFE generic message; plus the UNSAFE detail
        # that must only reach the operator log (never the client).
        self.status = status
        self.client_msg = client_msg
        self.log_where = log_where        # short host/tool tag for _warn (never a URL)
        self.log_detail = log_detail      # unsafe diagnostic; _warn only

    # ---- constructors (read at call sites like Ok(...)/Err(...)) ----
    @classmethod
    def json(cls, data):
        """Success with a JSON dict payload."""
        return cls(ok=True, data=data)

    @classmethod
    def raw(cls, body, ctype, cache_state=None, browser_ttl=0):
        """Success with raw bytes (a proxied image/JSON body)."""
        return cls(ok=True, body=body, ctype=ctype,
                   cache_state=cache_state, browser_ttl=browser_ttl)

    @classmethod
    def error(cls, status, client_msg, *, log_where=None, log_detail=None):
        """Failure: a SAFE client message + an optional UNSAFE log-only detail."""
        return cls(ok=False, status=status, client_msg=client_msg,
                   log_where=log_where, log_detail=log_detail)
