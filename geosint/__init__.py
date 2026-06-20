"""GeOSINT Workbench — package shim so `python -m geosint` bootstraps + serves.

The real server is the stdlib `server.py` at the repo root; this package only
provides a cross-platform one-command launcher (see __main__.py).

This module is also the single source of truth for the project version and the
canonical User-Agent string: `server.py` and `tools/net.py` both derive their UA
from `ua()` here, so the advertised version can never drift between them."""
__version__ = "1.0.0"


def ua(version: str = __version__) -> str:
    """The one canonical User-Agent for every outbound GeOSINT request.

    Both the running server (`server.py`) and the offline data-fetch layer
    (`tools/net.py`) format their UA through this helper so there is exactly one
    template and one version. Accepts an explicit `version` only so a caller that
    cannot import this package (see tools/net.py's defensive fallback) can still
    reproduce the identical string."""
    return (f"GeOSINT-Workbench/{version} "
            f"(https://github.com/Nazianzenov/GEOSINT; "
            f"non-commercial personal OSINT tool)")
