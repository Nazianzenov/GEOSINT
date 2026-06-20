"""Pure slippy-map tile math — DOM-free, HTTP-free, dependency-free.

Extracted from server.py (ARC-05 / #88) so the Web-Mercator tile geometry that
backs /tiles and /api/prefetch can be reasoned about and unit-tested in isolation,
without the HTTP Handler. server.py imports these; the handlers keep only request
framing. Stdlib-only (math), so it imports cleanly in any context."""
import math


def lonlat_to_tile(lon, lat, z):
    """Slippy-map tile (x, y) for a lon/lat at zoom z (Web Mercator), clamped to
    the valid tile range [0, 2**z - 1]. Latitude is clamped to the Web-Mercator
    limit (±85.0511°) before projection."""
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(max(-85.0511, min(85.0511, lat)))
    y = int((1 - math.asinh(math.tan(lat_r)) / math.pi) / 2 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tiles_in_bbox(s, w, n, e, zmin, zmax):
    """Yield (z, x, y) for every tile covering bbox [s, w, n, e] over zmin..zmax."""
    for z in range(zmin, zmax + 1):
        x0, y0 = lonlat_to_tile(w, n, z)        # NW corner
        x1, y1 = lonlat_to_tile(e, s, z)        # SE corner
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                yield z, x, y
