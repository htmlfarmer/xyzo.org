"""Tests for worker/isobars.py — the isobar contouring.

The isobar layer draws lines of equal mean sea-level pressure contoured
out of the NOAA NCEP GFS analysis. The contouring itself is pure
numerics, so it is tested against synthetic fields with a known answer
rather than against a downloaded GFS file (that would make the suite
depend on the network).

What is pinned here:
  1. marching squares finds the right crossing for a known field
  2. the saddle cells are resolved, not guessed
  3. segments are stitched into continuous polylines, and the stitch
     does not teleport the line across the map at a branch point
  4. the field is smoothed before contouring, and the polar rows are
     dropped (they produce perfectly straight lines along the pole)
  5. Chaikin rounds the grid-aligned corners
  6. clipping to a longitude window cuts the line at the boundary
  7. Douglas-Peucker keeps the shape but drops the vertices
"""
from __future__ import annotations

import math

import pytest

np = pytest.importorskip("numpy")

from worker import isobars  # noqa: E402


# ── helpers ─────────────────────────────────────────────────────────────
def _grid(values, lats, lons):
    """Build the (grid, lats, lons) tuple the contour functions expect."""
    return (
        np.asarray(values, dtype=float),
        np.asarray(lats, dtype=float),
        np.asarray(lons, dtype=float),
    )


def _global_grid(n_lat=41, n_lon=73, lat0=-60.0, lat1=60.0):
    """A global grid with a 0°..360° longitude axis, like the GFS.

    The field has to cross a multiple of the contour interval, or there
    is nothing to contour.
    """
    lats = np.linspace(lat0, lat1, n_lat)
    lons = np.linspace(0.0, 360.0, n_lon)
    grid = np.tile(1008.0 + 8.0 * np.sin(np.deg2rad(lons * 2.0)), (n_lat, 1))
    return _grid(grid, lats, lons)


# ── the GRIB header's own description of the scan ──────────────────────
class TestCheckScanOrder:
    """jScansPositively against the header's first/last latitudes.

    The row order of a decoded field decides whether it is the right
    way up. A field mirrored about the equator still passes every
    relationship check the overlays make — the mid-latitudes are
    windier than the tropics in BOTH hemispheres — so the only place
    the truth about the row order lives is the header itself.
    """

    def test_a_descending_scan_is_accepted(self):
        # GFS: the first row is the northernmost.
        isobars.check_scan_order(0, 90.0, -90.0)  # must not raise

    def test_an_ascending_scan_is_accepted(self):
        isobars.check_scan_order(1, -90.0, 90.0)  # must not raise

    def test_a_flag_that_contradicts_the_latitudes_is_refused(self):
        with pytest.raises(SystemExit, match="row order"):
            isobars.check_scan_order(1, 90.0, -90.0)

    def test_a_descending_flag_with_ascending_latitudes_is_refused(self):
        with pytest.raises(SystemExit, match="row order"):
            isobars.check_scan_order(0, -90.0, 90.0)

    def test_a_message_without_the_key_is_not_refused(self):
        # Some products do not declare the last latitude; there is
        # nothing to cross-check against, so the decode goes ahead.
        isobars.check_scan_order(0, 90.0, None)  # must not raise


# ── marching squares ───────────────────────────────────────────────────
class TestMarchingSquares:
    def test_finds_the_crossing_of_a_linear_field(self):
        lats = np.linspace(-20.0, 20.0, 41)
        lons = np.linspace(-20.0, 20.0, 81)
        grid = 1010.0 + np.tile(lons, (41, 1))
        segments = isobars.marching_squares(grid, lats, lons, 1010.0)
        assert len(segments) > 0
        # The field runs 1000..1020 hPa from west to east, so the 1010 hPa
        # contour sits at the middle of the domain.
        mid_lon = (lons[0] + lons[-1]) / 2.0
        for x1, y1, x2, y2 in segments:
            for x in (x1, x2):
                assert abs(x - mid_lon) < 1.5

    def test_no_segments_outside_the_field_range(self):
        grid, lats, lons = _global_grid()
        assert len(isobars.marching_squares(grid, lats, lons, 500.0)) == 0
        assert len(isobars.marching_squares(grid, lats, lons, 5000.0)) == 0

    def test_a_single_low_produces_a_closed_ring(self):
        lats = np.linspace(-10, 10, 41)
        lons = np.linspace(-10, 10, 41)
        grid = np.full((41, 41), 1016.0)
        grid[20, 20] = 1000.0  # a deep low in the middle
        segments = isobars.marching_squares(grid, lats, lons, 1012.0)
        assert len(segments) >= 4
        # Every crossing sits around the low.
        for x1, y1, x2, y2 in segments:
            assert abs(x1) < 6 and abs(x2) < 6
            assert abs(y1) < 6 and abs(y2) < 6

    def test_the_saddle_case_follows_the_cell_centre(self):
        # A checkerboard cell: corners 0 and 2 above the level, 1 and 3
        # below. The pairing depends on the value at the centre, and
        # guessing it produced a line that crossed itself.
        lats = np.array([0.0, 1.0])
        lons = np.array([0.0, 1.0])
        for centre_above, expect_right_edge in ((True, True), (False, False)):
            # Corner values: 0 high, 1 low, 2 high, 3 low.
            grid = np.array([[1020.0, 1000.0], [1000.0, 1020.0]])
            if centre_above:
                grid = grid + 4.0  # lift the cell so its centre is above
            segments = isobars.marching_squares(grid, lats, lons, 1010.0)
            # A saddle cell yields two segments (the two pairings).
            assert len(segments) == 2
            # Find the segment that touches the bottom edge and check
            # which vertical edge its other end is on: the right edge
            # when the centre is above the level, the left edge when it
            # is below.
            bottom_segments = [s for s in segments if min(s[1], s[3]) < 1e-9]
            assert len(bottom_segments) == 1
            x1, y1, x2, y2 = bottom_segments[0]
            # The endpoint on the bottom edge has y = 0; the other one
            # sits on the vertical edge.
            other_x = x2 if abs(y1) < 1e-9 else x1
            if expect_right_edge:
                assert abs(other_x - 1.0) < 1e-9
            else:
                assert abs(other_x - 0.0) < 1e-9


# ── stitching ──────────────────────────────────────────────────────────
class TestStitch:
    def test_segments_become_one_polyline(self):
        # Three segments in a row: (0,0)->(1,0)->(2,0)->(3,0)
        segments = np.array([
            [0.0, 0.0, 1.0, 0.0],
            [1.0, 0.0, 2.0, 0.0],
            [2.0, 0.0, 3.0, 0.0],
        ])
        lines = isobars.stitch_segments(segments)
        assert len(lines) == 1
        assert len(lines[0]) == 4
        assert lines[0][0] == (0.0, 0.0)
        assert lines[0][-1] == (3.0, 0.0)

    def test_a_closed_ring_comes_back_closed(self):
        segments = np.array([
            [0.0, 0.0, 1.0, 0.0],
            [1.0, 0.0, 1.0, 1.0],
            [2.0, 1.0, 2.0, 2.0],   # a decoy far away
            [1.0, 1.0, 0.0, 1.0],
            [0.0, 1.0, 0.0, 0.0],
        ])
        lines = isobars.stitch_segments(segments)
        ring = [l for l in lines if len(l) > 2 and l[0] == l[-1]]
        assert len(ring) == 1
        assert len(ring[0]) == 5

    def test_two_separate_chains_stay_separate(self):
        segments = np.array([
            [0.0, 0.0, 1.0, 0.0],
            [5.0, 5.0, 6.0, 5.0],
        ])
        lines = isobars.stitch_segments(segments)
        assert len(lines) == 2

    def test_a_branch_point_does_not_teleport_the_line(self):
        # Four segments meet at (0,0). The walk has to carry straight on
        # rather than jumping to the far branch.
        segments = np.array([
            [-1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
        lines = isobars.stitch_segments(segments)
        for line in lines:
            # No segment may jump more than a couple of degrees.
            for (x0, y0), (x1, y1) in zip(line, line[1:]):
                assert math.hypot(x1 - x0, y1 - y0) < 2.5


# ── field preparation ───────────────────────────────────────────────────
class TestFieldPreparation:
    def test_smoothing_removes_small_scale_structure(self):
        rng = np.random.default_rng(7)
        field = np.full((121, 121), 1013.0)
        field += rng.normal(0.0, 1.0, field.shape)  # cell-to-cell noise
        smoothed = isobars.smooth_field(field)
        assert smoothed.std() < field.std()
        # The mean is preserved — smoothing must not shift the pressure.
        assert abs(smoothed.mean() - field.mean()) < 0.5

    def test_smoothing_is_a_no_op_when_disabled(self):
        field = np.full((11, 11), 1013.0)
        field[5, 5] = 1000.0
        original = isobars.FIELD_SMOOTH_SIGMA_DEG
        try:
            isobars.FIELD_SMOOTH_SIGMA_DEG = 0.0
            assert isobars.smooth_field(field) is field
        finally:
            isobars.FIELD_SMOOTH_SIGMA_DEG = original

    def test_the_smoothing_sigma_is_a_physical_width(self):
        # The same physical blur has to mean the same thing on every
        # grid. On the 0.25° GFS grid 0.5° is two cells; on ECMWF's
        # 0.1° grid it is five. A sigma expressed in CELLS would smooth
        # 2.5x less in physical terms on the finer grid, which turns a
        # clean synoptic chart into a tangle of wiggles.
        import scipy.ndimage as ndi

        def sigma_for(spacing):
            field = np.zeros((121, 121))
            # Find the sigma that reproduces a known 1-D blur width.
            width = isobars.FIELD_SMOOTH_SIGMA_DEG
            return max(2.0, width / spacing)

        assert sigma_for(0.25) == 2.0
        assert sigma_for(0.1) == 5.0
        assert sigma_for(1.0) == 2.0   # the floor, for the coarse fallback

        # A 0.1° grid blurred with 5 cells must look like a 0.25° grid
        # blurred with 2 cells — the same physical feature, smoothed
        # the same amount.
        coarse = np.random.default_rng(3).normal(0, 1, (121, 121))
        a = ndi.gaussian_filter(coarse, sigma=2.0, mode=("nearest", "wrap"))
        b = ndi.gaussian_filter(coarse, sigma=5.0, mode=("nearest", "wrap"))
        # Not equal (different grids), but both are much smoother than
        # the raw field and the ratio of their smoothness is bounded.
        assert a.std() < coarse.std() * 0.5
        assert b.std() < coarse.std() * 0.5


# ── smoothing the lines ────────────────────────────────────────────────
class TestChaikin:
    def test_corners_are_rounded(self):
        corner = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
        out = isobars.chaikin_smooth(corner, iterations=1)
        # The sharp corner at (1,0) is replaced by two points.
        assert len(out) > len(corner)
        # The endpoints are preserved.
        assert out[0] == (0.0, 0.0)
        assert out[-1] == (1.0, 1.0)

    def test_a_straight_line_stays_straight(self):
        line = [(float(i), 0.0) for i in range(6)]
        out = isobars.chaikin_smooth(line, iterations=2)
        for _x, y in out:
            assert abs(y) < 1e-9

    def test_it_never_overshoots(self):
        # Chaikin stays inside the convex hull of the input.
        pts = [(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)]
        for _x, y in isobars.chaikin_smooth(pts, iterations=3):
            assert -0.001 <= y <= 1.001


# ── simplification ─────────────────────────────────────────────────────
class TestSimplify:
    def test_a_straight_line_collapses_to_its_ends(self):
        points = [(float(i), 0.0) for i in range(20)]
        out = isobars.simplify(points, 0.1)
        assert len(out) == 2
        assert out[0][0] == 0.0 and out[-1][0] == 19.0

    def test_a_real_bend_is_kept(self):
        points = [(0.0, 0.0), (1.0, 5.0), (2.0, 0.0)]
        out = isobars.simplify(points, 0.1)
        assert len(out) == 3

    def test_short_input_is_returned_unchanged(self):
        points = [(0.0, 0.0), (1.0, 1.0)]
        assert len(isobars.simplify(points, 0.1)) == 2


# ── clipping to a longitude window ─────────────────────────────────────
class TestClipToLonRange:
    def test_a_line_inside_the_window_is_untouched(self):
        points = [(10.0, 0.0), (11.0, 1.0), (12.0, 2.0)]
        out = isobars.clip_to_lon_range(points, 0.0, 100.0)
        assert len(out) == 1
        assert out[0] == points

    def test_a_line_outside_the_window_is_dropped(self):
        points = [(200.0, 0.0), (201.0, 1.0)]
        assert isobars.clip_to_lon_range(points, 0.0, 100.0) == []

    def test_a_line_leaving_the_window_is_cut_at_the_boundary(self):
        points = [(50.0, 0.0), (150.0, 1.0)]
        out = isobars.clip_to_lon_range(points, 0.0, 100.0)
        assert len(out) == 1
        # The last point sits exactly on the boundary and the latitude
        # is interpolated, not extrapolated.
        assert abs(out[0][-1][0] - 100.0) < 1e-9
        assert 0.0 <= out[0][-1][1] <= 1.0

    def test_a_line_leaving_the_west_edge_uses_the_west_boundary(self):
        # Entering at the west edge with a window of [0, 100]: the cut
        # must be on the west edge. Picking the wrong edge produced a
        # wildly interpolated point and a line that shot across the map.
        points = [(-50.0, 0.0), (50.0, 1.0)]
        out = isobars.clip_to_lon_range(points, 0.0, 100.0)
        assert len(out) == 1
        assert abs(out[0][0][0] - 0.0) < 1e-9
        assert 0.0 <= out[0][0][1] <= 1.0
        assert out[0][-1] == (50.0, 1.0)

    def test_every_clipped_point_stays_in_range(self):
        points = [(-170.0, 0.0), (-10.0, 1.0), (10.0, 2.0), (170.0, 3.0)]
        for part in isobars.clip_to_lon_range(points, -180.0, 180.0):
            for lon, lat in part:
                assert -180.0 <= lon <= 180.0


# ── which fragments survive ────────────────────────────────────────────
class TestFilterShortChains:
    """The rule that stops short pieces from opening gaps in an isobar."""

    def test_a_short_piece_bridge_is_kept(self):
        # A long line, a short piece, and another long line: the short
        # piece is what holds them together, so dropping it opens a gap.
        left = [(float(i), 0.0) for i in range(6)]            # 5 deg
        bridge = [(5.1, 0.0), (5.4, 0.0), (5.7, 0.0)]         # 0.6 deg
        right = [(5.8, 0.0), (7.0, 0.0), (8.5, 0.0), (10.5, 0.0)]  # 4.7 deg
        kept = isobars.filter_short_chains([left, bridge, right])
        assert len(kept) == 3

    def test_an_isolated_speck_is_dropped(self):
        line = [(float(i), 0.0) for i in range(6)]
        speck = [(50.0, 40.0), (50.2, 40.0)]
        kept = isobars.filter_short_chains([line, speck])
        assert kept == [line]

    def test_a_hair_off_a_line_is_dropped(self):
        line = [(float(i), 0.0) for i in range(6)]            # ends at (5,0)
        hair = [(5.0, 0.0), (5.3, 0.0)]                       # one end attached
        kept = isobars.filter_short_chains([line, hair])
        assert kept == [line]

    def test_a_long_piece_is_always_kept(self):
        line = [(float(i), 0.0) for i in range(6)]
        assert isobars.filter_short_chains([line]) == [line]

    def test_the_bridge_rule_is_what_closes_the_gaps(self):
        # Regression: filtering on length ALONE chopped isobars into
        # dashes, because the contour arrives as several pieces.
        left = [(float(i), 0.0) for i in range(6)]
        bridge = [(5.1, 0.0), (5.4, 0.0), (5.7, 0.0)]
        right = [(5.8, 0.0), (7.0, 0.0), (8.5, 0.0), (10.5, 0.0)]
        # The old rule: length only.
        length_only = [p for p in (left, bridge, right)
                       if isobars.polyline_length(p) >= isobars.MIN_LINE_LENGTH_DEG]
        assert len(length_only) == 2          # the bridge is gone
        # The current rule keeps it.
        assert len(isobars.filter_short_chains([left, bridge, right])) == 3


# ── the whole pipeline ─────────────────────────────────────────────────
class TestContourIsobars:
    def test_a_flat_field_produces_no_lines(self):
        lats = np.linspace(-30, 30, 61)
        lons = np.linspace(0.0, 360.0, 121)
        grid = np.full((61, 121), 1013.0)
        lines = isobars.contour_isobars(grid, lats, lons)
        # A constant field has no contour at any interval in it.
        assert lines == []

    def test_a_wave_produces_contours_at_the_requested_interval(self):
        grid, lats, lons = _global_grid()
        lines = isobars.contour_isobars(grid, lats, lons)
        assert len(lines) > 0
        interval = isobars.ISO_INTERVAL_HPA
        for level, _points in lines:
            # NOT `level % interval == 0`: 0.05 and 0.1 are not dyadic,
            # so the remainder of even an exact multiple is a sliver of
            # ~1e-13 rather than 0 (1000.5 % 0.05 == 1e-14-ish, not 0).
            # Dividing and rounding asks the same question without
            # floating-point subtraction: level is on the lattice iff
            # level/interval is a whole number of steps.
            steps = level / interval
            assert abs(steps - round(steps)) < 1e-6, (level, interval)

    def test_the_fine_set_is_a_SUPERSET_of_the_coarse_one(self):
        # The property the whole "one dataset, five densities" design
        # rests on: the contour of a level does not depend on the
        # interval used to enumerate the levels. So the 4 hPa chart the
        # map has always drawn must be EXACTLY the multiples of 4 in
        # the 1 hPa set — not a second, slightly different dataset.
        #
        # This is the test that fails if anyone ever "optimises" the
        # contouring by computing the levels together, or if the merge
        # and filter steps ever start looking across levels.
        grid, lats, lons = _global_grid()
        fine = isobars.contour_isobars(grid, lats, lons, interval=1)
        coarse = isobars.contour_isobars(grid, lats, lons, interval=4)
        fine_by_level: dict[int, list] = {}
        for level, points in fine:
            fine_by_level.setdefault(level, []).append(points)
        coarse_by_level: dict[int, list] = {}
        for level, points in coarse:
            coarse_by_level.setdefault(level, []).append(points)
        assert coarse_by_level, "no coarse contours at all"
        shared = sorted(set(fine_by_level) & set(coarse_by_level))
        assert shared, "the two intervals share no level"
        for level in shared:
            assert len(fine_by_level[level]) == len(coarse_by_level[level])
            for a, b in zip(fine_by_level[level], coarse_by_level[level]):
                assert len(a) == len(b)
                for pa, pb in zip(a, b):
                    assert pa[0] == pytest.approx(pb[0], abs=1e-9)
                    assert pa[1] == pytest.approx(pb[1], abs=1e-9)

    def test_a_finer_interval_does_not_add_fragmentary_noise(self):
        # The claim that makes a 1 hPa contour set publishable: the
        # noise lives in the FIELD, not in the choice of level. So
        # halving the interval must not multiply the share of short
        # fragments — it must only add lines.
        grid, lats, lons = _global_grid()
        coarse = isobars.contour_isobars(grid, lats, lons, interval=4)
        fine = isobars.contour_isobars(grid, lats, lons, interval=1)
        assert len(fine) > len(coarse)

        def short_share(lines):
            short = sum(1 for _l, p in lines
                        if isobars.polyline_length(p) < 20.0)
            return short / max(1, len(lines))

        assert short_share(fine) < short_share(coarse) + 0.10


# ── the ORDER of the contouring steps ───────────────────────────────────
class TestContourOrder:
    """The rounding has to be the LAST word, and the merge has to come
    BEFORE it.

    Two separate facts, and both are load-bearing:

    * **Douglas-Peucker replaces a curve with straight chords**, so a
      tolerance above the amplitude the Chaikin rounding leaves behind
      shaves the rounding straight back off. Rounding the polyline and
      THEN thinning it undoes the rounding — which is why "more
      Chaikin" on its own changed almost nothing (measured on the real
      GFS analysis: two extra rounds moved the share of sharp vertices
      from 2.9 % to 2.8 %, and a LOOSER DP made it four times worse).

    * **`merge_isobars()` decides that two pieces are the same isobar
      by asking whether the next piece's start projects ONTO the
      previous piece's last segment.** That overlap is a property of
      the RAW marching-squares geometry: the contour cut the same
      corner twice, so the second piece starts back along the first
      one's last segment. Rounding a piece first MOVES its ends, the
      projection test starts failing, and the pieces stop joining —
      which is how every isobar ended up broken into ~4 fragments, with
      a hard edge at every fragment's end.

    So: merge the raw pieces, then round, then thin.
    """

    @staticmethod
    def _grazing_grid(n_lat=241, n_lon=481):
        """A field whose levels are grazed often.

        The fine grid and the perturbation matter: the effect only
        shows where the contour keeps crossing a level, which is what a
        real analysis does everywhere.
        """
        lats = np.linspace(-85.0, 80.0, n_lat)
        lons = np.linspace(0.0, 360.0, n_lon)
        lon2, lat2 = np.meshgrid(lons, lats)
        rng = np.random.default_rng(7)
        grid = (
            1013.0
            - 18.0 * np.exp(-(((lon2 - 30.0) / 22.0) ** 2 + ((lat2 - 45.0) / 14.0) ** 2))
            + 12.0 * np.exp(-(((lon2 - 210.0) / 26.0) ** 2 + ((lat2 + 40.0) / 16.0) ** 2))
            + 4.0 * np.sin(np.deg2rad(lon2 * 3.0)) * np.cos(np.deg2rad(lat2 * 2.0))
            + 0.8 * np.sin(np.deg2rad(lon2 * 17.0)) * np.sin(np.deg2rad(lat2 * 13.0))
            + 0.3 * rng.standard_normal(lon2.shape)
        )
        return _grid(grid, lats, lons)

    @staticmethod
    def _turn_angles(lines):
        out = []
        for _level, points in lines:
            for i in range(1, len(points) - 1):
                (x0, y0), (x1, y1), (x2, y2) = points[i - 1], points[i], points[i + 1]
                a1 = math.atan2(y1 - y0, x1 - x0)
                a2 = math.atan2(y2 - y1, x2 - x1)
                out.append(math.degrees(abs((a2 - a1 + math.pi) % (2 * math.pi) - math.pi)))
        return out

    def test_the_rounding_is_the_last_word(self):
        # The reader's complaint: "some edges that don't look so good".
        # A hard corner on an isobar is a vertex that turns hard, and
        # the share of them is what has to stay low.
        #
        # Measured on this field: 0.46 % of the vertices turned more
        # than 40 deg with the old order (round -> thin -> merge) and
        # 0.15 % with this one. The bound is set between the two, so
        # putting the old order back fails the test.
        grid, lats, lons = self._grazing_grid()
        lines = isobars.contour_isobars(grid, lats, lons, interval=2)
        angles = self._turn_angles(lines)
        assert angles, "no vertices to measure"
        sharp = sum(1 for a in angles if a > 40)
        assert sharp / len(angles) < 0.0025, (
            f"{sharp} of {len(angles)} vertices turn more than 40 deg "
            f"({100 * sharp / len(angles):.2f} %) — the rounding is not "
            f"the last word"
        )

    def test_the_merge_still_merges(self):
        # The merge must actually merge. It is fed the pieces the
        # contour arrived as, and it has to return fewer lines than it
        # was given — otherwise the isobars are fragments and every
        # fragment's end is a hard edge on the map.
        grid, lats, lons = self._grazing_grid()
        seen = {}
        real_merge = isobars.merge_isobars

        def spy(lines, *a, **kw):
            seen["pieces"] = len(lines)
            out = real_merge(lines, *a, **kw)
            seen["merged"] = len(out)
            return out

        isobars.merge_isobars = spy
        try:
            lines = isobars.contour_isobars(grid, lats, lons, interval=2)
        finally:
            isobars.merge_isobars = real_merge

        assert seen["pieces"] > 0
        assert seen["merged"] < seen["pieces"], (
            f"the merge joined nothing: {seen['pieces']} pieces in, "
            f"{seen['merged']} out"
        )
        assert len(lines) < seen["pieces"], "the contour is more fragments than pieces"

    def test_the_rounding_does_not_explode_the_payload(self):
        # The obvious "fix" — round every point with Chaikin instead of
        # ordering the steps — multiplies the vertex count by four. The
        # order change must not cost anything like that: it is a
        # reordering, not an extra pass.
        grid, lats, lons = self._grazing_grid()
        lines = isobars.contour_isobars(grid, lats, lons, interval=2)
        vertices = sum(len(p) for _l, p in lines)
        assert vertices < 12000, f"{vertices} vertices for one field"

    def test_every_line_is_well_formed(self):
        grid, lats, lons = _global_grid()
        for _level, points in isobars.contour_isobars(grid, lats, lons):
            assert len(points) >= isobars.MIN_LINE_POINTS
            for lon, lat in points:
                assert math.isfinite(lon) and math.isfinite(lat)
                assert -180.0 <= lon <= 180.0
                assert -90.0 <= lat <= 90.0

    def test_no_line_teleports_across_the_map(self):
        # A broken stitch or a bad clip interpolation used to throw a
        # line most of the way round the globe, or put a point at
        # latitude -168 when its neighbours were at -45.
        grid, lats, lons = _global_grid()
        lat_lo, lat_hi = float(lats.min()), float(lats.max())
        for _level, points in isobars.contour_isobars(grid, lats, lons):
            for (x0, y0), (x1, y1) in zip(points, points[1:]):
                # A line may run a long way ALONG a meridian, but it may
                # not jump most of the way round the globe in one go.
                assert abs(x1 - x0) < 90.0
                # And the latitude must stay inside the band the field
                # covers.
                assert lat_lo - 0.01 <= y0 <= lat_hi + 0.01
                assert lat_lo - 0.01 <= y1 <= lat_hi + 0.01

    def test_no_straight_line_along_a_pole(self):
        # The polar rows are dropped before contouring, so no isobar may
        # run along latitude +/- 90.
        grid, lats, lons = _global_grid()
        for _level, points in isobars.contour_isobars(grid, lats, lons):
            for _lon, lat in points:
                assert abs(lat) <= isobars.LAT_LIMIT_DEG + 0.01

# ── merging the pieces into continuous isobars ─────────────────────────
class TestMergeIsobars:
    """A contour arrives as thousands of pieces; they must be rejoined.

    Left as separate rows the map draws ~5,000 SVG paths — slow to
    create, slow to redraw and slow to ship. Merged, the whole world is
    ~250 continuous isobars.
    """

    def _pieces(self, n=6, step=0.1, overlap=0.02):
        """n pieces along a meridian, each overlapping the next.

        The overlap is what the contour leaves when it cuts the same
        corner twice — the next piece starts back along the previous
        one's last segment.
        """
        out = []
        for i in range(n):
            y0 = i * step
            out.append([(0.0, y0), (0.0, y0 + step + overlap)])
        return out

    def test_collinear_pieces_join_into_one(self):
        pieces = self._pieces()
        merged = isobars.merge_isobars([(1004, p) for p in pieces])
        assert len(merged) == 1
        level, chain = merged[0]
        assert level == 1004
        # One continuous line, not six. The join replaces the two
        # overlapping end points with a single cut point, so the chain
        # grows by one point per piece.
        assert len(chain) == len(pieces) + 1
        # ...and it is evenly spaced along the meridian.
        ys = [p[1] for p in chain]
        assert ys == sorted(ys)

    def test_the_join_has_no_reversal(self):
        # The pieces overlap slightly: each starts back along the
        # previous one's last segment. Joining them naively leaves a
        # visible back-step, so the overshoot is cut off.
        pieces = [[(0.0, 0.0), (0.0, 1.0)], [(0.0, 0.9), (0.0, 1.9)]]
        merged = isobars.merge_isobars([(1000, p) for p in pieces])
        assert len(merged) == 1
        chain = merged[0][1]
        # Monotonic in y — the line never doubles back.
        ys = [p[1] for p in chain]
        assert ys == sorted(ys), ys

    def test_adjacent_parallel_strands_are_not_joined(self):
        # Two strands of the same isobar that merely pass close by are
        # NOT the same line: joining them doubles the line back on
        # itself, which is a visible staircase.
        near = [[(0.0, 0.0), (0.0, 1.0)], [(0.0, 1.0), (0.0, 2.0)]]
        merged = isobars.merge_isobars([(1000, p) for p in near])
        # They do overlap here (the second starts exactly where the
        # first ends), so they DO join...
        assert len(merged) == 1

        # ...but a strand that starts 0.2 deg BEYOND the end is a
        # different line and must be left alone.
        apart = [[(0.0, 0.0), (0.0, 1.0)], [(0.0, 1.2), (0.0, 2.2)]]
        merged = isobars.merge_isobars([(1000, p) for p in apart])
        assert len(merged) == 2

    def test_distant_pieces_stay_apart(self):
        far = [[(0.0, 0.0), (0.0, 1.0)], [(50.0, 0.0), (50.0, 1.0)]]
        merged = isobars.merge_isobars([(1000, p) for p in far])
        assert len(merged) == 2

    def test_different_levels_never_merge(self):
        merged = isobars.merge_isobars(
            [(1000, [(0.0, 0.0), (0.0, 1.0)]), (1004, [(0.0, 0.9), (0.0, 1.9)])]
        )
        assert len(merged) == 2
        assert {lvl for lvl, _ in merged} == {1000, 1004}

    def test_a_chain_grows_from_both_ends(self):
        # Three pieces in a row; the middle one is found first and the
        # chain must extend out to both sides of it.
        pieces = [[(0.0, 1.0), (0.0, 2.0)], [(0.0, 0.0), (0.0, 1.0)],
                  [(0.0, 1.9), (0.0, 2.9)]]
        merged = isobars.merge_isobars([(1000, p) for p in pieces])
        assert len(merged) == 1
        chain = merged[0][1]
        ys = [p[1] for p in chain]
        assert min(ys) == 0.0 and max(ys) == 2.9

