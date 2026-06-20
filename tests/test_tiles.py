"""Unit tests for the pure tile math (geosint/tiles.py, #88 / ARC-05).

These exercise the Web-Mercator geometry directly — no HTTP Handler, no server —
which is the whole point of extracting it from server.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from geosint import tiles  # noqa: E402


def test_lonlat_to_tile_origin_and_center():
    # zoom 0: the whole world is one tile (0,0)
    assert tiles.lonlat_to_tile(0, 0, 0) == (0, 0)
    assert tiles.lonlat_to_tile(-180, 85, 0) == (0, 0)
    # zoom 1 splits into a 2×2 grid; (lon 0, lat 0) sits at the grid seam -> (1,1)
    assert tiles.lonlat_to_tile(0.001, -0.001, 1) == (1, 1)
    assert tiles.lonlat_to_tile(-179, 85, 1) == (0, 0)        # NW tile


def test_lonlat_to_tile_clamps_to_valid_range():
    # out-of-range / pole latitudes never produce an out-of-grid index
    for z in (0, 1, 5, 12):
        n = 2 ** z
        for lon, lat in [(-181, 90), (181, -90), (0, 89.9), (179.999, -89.9)]:
            x, y = tiles.lonlat_to_tile(lon, lat, z)
            assert 0 <= x < n and 0 <= y < n


def test_tiles_in_bbox_counts_and_membership():
    # a small bbox at zoom 0 is exactly one tile
    assert list(tiles.tiles_in_bbox(-1, -1, 1, 1, 0, 0)) == [(0, 0, 0)]
    # a multi-zoom sweep yields each zoom's tiles; counts are (span_x)*(span_y)
    out = list(tiles.tiles_in_bbox(0, 0, 10, 10, 2, 3))
    zs = {z for z, _x, _y in out}
    assert zs == {2, 3}
    # every emitted tile is in range for its zoom
    for z, x, y in out:
        n = 2 ** z
        assert 0 <= x < n and 0 <= y < n


def test_tiles_in_bbox_handles_swapped_corner_order():
    # tiles_in_bbox uses min/max internally, so corner order doesn't change the set
    a = set(tiles.tiles_in_bbox(0, 0, 5, 5, 4, 4))
    b = set(tiles.tiles_in_bbox(5, 5, 0, 0, 4, 4))
    assert a == b and len(a) > 0


def test_server_reexports_match_module():
    # server.py imports these; the re-export must behave identically (no drift)
    import server
    assert server.tiles_in_bbox(0, 0, 5, 5, 3, 3) is not None
    assert list(server.tiles_in_bbox(0, 0, 5, 5, 3, 3)) == list(tiles.tiles_in_bbox(0, 0, 5, 5, 3, 3))
    assert server._lonlat_to_tile(2.29, 48.85, 12) == tiles.lonlat_to_tile(2.29, 48.85, 12)
