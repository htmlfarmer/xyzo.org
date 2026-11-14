"""Tests for worker/windmap.py — the wind overlay's data contract.

Three layers, and this file covers the first two:

  1. THE DATA     — is grid.bin really the GFS 10 m wind analysis?
  2. THE SAMPLER  — does the browser read the right cell for a point?
  3. THE PHYSICS  — do the particles move the way the wind blows?

(3) lives in the frontend and is covered by
public_html/tests/wind-physics.bun.test.js.

The first half of this file is pure: no network, no DB. What is pinned
here is the verify() gate that must never be bypassed (a field decoded
in the wrong latitude order still looks like a plausible wind map), the
grid layout the browser reads, and the int16 storage.

The second half checks the PUBLISHED artefact against the GFS analysis
it claims to be — the check that actually answers "is this right?" when
somebody compares the map with windy.com. The cell-by-cell comparison
is marked `network`; the self-consistency checks are not.
"""
from __future__ import annotations

import json
import math
import os
import tempfile

import pytest

np = pytest.importorskip("numpy")

from worker import windmap  # noqa: E402
from worker import wind_verify  # noqa: E402


# ── the grid the browser reads ──────────────────────────────────────────
def _rows_for(pub, lat_lo: float, lat_hi: float):
    """The published grid's rows inside a latitude band.

    The rows come from the LATITUDE, never from hardcoded indices: the
    published wind moved from a 1° grid (181 rows) to a 0.25° one
    (721 rows) on 2026-11-04, and fixed indices that meant "the
    trades" started reading "the mid-latitude westerlies".
    """
    g = pub.grid
    step = float(g["lat_step"])
    lat_min = float(g["lat_min"])
    rows = int(g["rows"])
    r0 = max(0, int(math.floor((lat_lo - lat_min) / step)))
    r1 = min(rows, int(math.ceil((lat_hi - lat_min) / step)) + 1)
    return slice(r0, r1)


class TestWriteGrid:
    def _roundtrip(self, u, v):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "grid.bin")
            lats = np.linspace(-90, 90, u.shape[0])
            lons = np.linspace(0, 360, u.shape[1], endpoint=False)
            windmap.write_grid(u, v, lats, lons, path)
            back = np.fromfile(path, dtype="<i2")
            # Planar: u first, then v.
            return back[:u.size].reshape(u.shape), back[u.size:].reshape(v.shape)

    def test_values_are_hundredths_of_a_metre_per_second(self):
        # 0.01 m/s per unit: the frontend divides by meta.grid.scale.
        u = np.array([[2.01, -11.21]])
        v = np.array([[0.0, 0.0]])
        back_u, back_v = self._roundtrip(u, v)
        assert back_u.tolist() == [[201, -1121]]
        assert back_v.tolist() == [[0, 0]]

    def test_row_zero_is_the_southernmost_latitude(self):
        # The frontend indexes row 0 as lat_min and walks northwards.
        u = np.array([[-90.0], [90.0]])
        v = np.array([[-90.0], [90.0]])
        back_u, _ = self._roundtrip(u, v)
        assert back_u[0][0] == -9000
        assert back_u[1][0] == 9000

    def test_the_layout_is_planar_u_then_v(self):
        # The browser splits the buffer in half: u in [0, n), v in [n, 2n).
        u = np.array([[1.0, 2.0], [3.0, 4.0]])
        v = np.array([[-1.0, -2.0], [-3.0, -4.0]])
        back_u, back_v = self._roundtrip(u, v)
        assert back_u.tolist() == [[100, 200], [300, 400]]
        assert back_v.tolist() == [[-100, -200], [-300, -400]]

    def test_out_of_int16_range_is_refused(self):
        with pytest.raises(SystemExit):
            windmap.np_round_to_int16(np.array([[400.0]]), "u")

    def test_the_scale_leaves_headroom_for_a_decode_bug(self):
        # 32767 units = 327.67 m/s; the atmosphere tops out near 150.
        assert windmap.SCALE == 100
        assert 32767 / windmap.SCALE > windmap.MAX_PLAUSIBLE_MS


# ── verify() ────────────────────────────────────────────────────────────
class TestVerify:
    def _axes(self, n=61):
        lats = np.linspace(-90, 90, n)
        lons = np.linspace(0, 360, 360, endpoint=False)
        return lats, lons

    def _realistic(self, lats):
        """Trade winds in the tropics, westerlies in the mid-latitudes."""
        n = len(lats)
        u = np.zeros((n, 360))
        v = np.zeros((n, 360))
        for i, lat in enumerate(lats):
            if abs(lat) < 25:          # trades: easterly
                u[i, :] = -6.0
                v[i, :] = 1.0
            elif 30 < abs(lat) < 60:    # westerlies
                u[i, :] = 9.0
                v[i, :] = 2.0
            else:
                u[i, :] = 1.0
                v[i, :] = 0.5
        return u, v

    def test_a_realistic_field_is_accepted(self):
        lats, lons = self._axes()
        u, v = self._realistic(lats)
        windmap.verify(u, v, lats, lons)  # must not raise

    def test_a_mirrored_field_is_not_caught_by_verify(self):
        """The gap in the cheap gate, pinned so it stays a known gap.

        The mid-latitudes are windier than the tropics in BOTH
        hemispheres, so a field mirrored about the equator passes every
        relationship check in verify(). The defence is elsewhere: the
        GRIB header cross-check in worker/isobars.py, and the
        cell-by-cell comparison in worker/wind_verify.py (see
        TestIndependentVerification below). If this test ever starts
        failing, verify() has become strong enough to close the gap and
        the comment in windmap.verify() can be rewritten.
        """
        lats, lons = self._axes()
        u, v = self._realistic(lats)
        windmap.verify(u[::-1, :], v[::-1, :], lats, lons)  # does NOT raise

    def test_an_implausible_speed_is_refused(self):
        lats, lons = self._axes()
        u, v = self._realistic(lats)
        u[0, 0] = 400.0
        with pytest.raises(SystemExit, match="not air on Earth"):
            windmap.verify(u, v, lats, lons)

    def test_nan_is_refused(self):
        lats, lons = self._axes()
        u, v = self._realistic(lats)
        u[0, 0] = float("nan")
        with pytest.raises(SystemExit, match="NaN"):
            windmap.verify(u, v, lats, lons)

    def test_a_field_that_points_the_same_way_everywhere_is_refused(self):
        # u and v that are not independent — a sign flip or a swap.
        lats, lons = self._axes()
        u = np.full((len(lats), len(lons)), 5.0)
        v = np.full((len(lats), len(lons)), 1.0)
        with pytest.raises(SystemExit, match="coherence"):
            windmap.verify(u, v, lats, lons)

    def test_a_sign_flipped_u_is_refused(self):
        # Trades westerly AND mid-latitudes easterly = u is inverted.
        lats, lons = self._axes()
        u, v = self._realistic(lats)
        with pytest.raises(SystemExit, match="sign-flipped"):
            windmap.verify(-u, v, lats, lons)

    def test_a_shape_that_does_not_match_the_axes_is_refused(self):
        lats, lons = self._axes()
        with pytest.raises(SystemExit, match="shape"):
            windmap.verify(np.zeros((10, 10)), np.zeros((10, 10)), lats, lons)

    def test_u_and_v_of_different_shapes_are_refused(self):
        lats = np.linspace(-90, 90, 10)
        lons = np.linspace(0, 360, 10, endpoint=False)
        with pytest.raises(SystemExit, match="differ"):
            windmap.verify(np.zeros((10, 10)), np.zeros((5, 5)), lats, lons)


# ── the display range ───────────────────────────────────────────────────
class TestChooseRange:
    def test_the_range_follows_the_field(self):
        speed = np.tile(np.linspace(0, 30, 400), (10, 1))
        lo, hi = windmap.choose_range(speed)
        assert lo == 0.0
        assert hi == pytest.approx(30.0, abs=1.0)

    def test_a_calm_field_still_gets_a_usable_span(self):
        speed = np.full((10, 10), 1.0)
        lo, hi = windmap.choose_range(speed)
        assert hi - lo >= windmap.RANGE_MIN_MS

    def test_a_stormy_field_is_capped(self):
        speed = np.tile(np.linspace(0, 200, 400), (10, 1))
        lo, hi = windmap.choose_range(speed)
        assert hi <= windmap.RANGE_MAX_MS

    def test_the_range_never_starts_above_zero(self):
        speed = np.full((10, 10), 12.0)
        lo, hi = windmap.choose_range(speed)
        assert lo == 0.0


# ── the published meta.json ─────────────────────────────────────────────
class TestMeta:
    def test_the_built_file_is_well_formed(self):
        path = os.path.join(windmap.OUT_DIR, "meta.json")
        if not os.path.exists(path):
            pytest.skip("overlay has not been built on this host")
        meta = json.load(open(path))
        assert meta["source"] == "NOAA NCEP GFS"
        assert meta["grid"]["file"] == "grid.bin"
        assert meta["grid"]["scale"] == 100
        assert meta["grid"]["layout"] == "planar_uv"
        # The ramp runs from the bottom of the range to the top of it.
        assert meta["ramp"][0]["ms"] == pytest.approx(meta["range_ms"][0])
        assert meta["ramp"][-1]["ms"] == pytest.approx(meta["range_ms"][1])
        assert len(meta["ramp"]) == 12   # SPEED_BUCKETS in wind-layer.js

    def test_the_run_time_is_the_analysis_time(self):
        path = os.path.join(windmap.OUT_DIR, "meta.json")
        if not os.path.exists(path):
            pytest.skip("overlay has not been built on this host")
        meta = json.load(open(path))
        run_time = meta["run_time"]
        assert run_time.endswith("Z")
        assert run_time[11:13] in {"00", "06", "12", "18"}

    def test_the_expected_stamp_is_the_cycle_itself(self):
        # The f000 analysis is the analysis for its own cycle.
        assert windmap.expected_stamp("20261027", "12") == "2026-10-27T12:00:00Z"

    def test_an_unchanged_cycle_is_a_no_op(self):
        # The timer fires every 6 h; a re-publish of the same analysis
        # would rewrite 260 KB and bust every client's cache.
        path = os.path.join(windmap.OUT_DIR, "meta.json")
        if not os.path.exists(path):
            pytest.skip("overlay has not been built on this host")
        meta = json.load(open(path))
        stamp = meta["run_time"]
        date_str = stamp[:10].replace("-", "")
        cycle = stamp[11:13]
        assert windmap.expected_stamp(date_str, cycle) == stamp


# ── the published artefact against the analysis it claims to be ────────
class TestPublishedGrid:
    """The grid.bin that is actually being served.

    This is the part that answers "is the wind right?" — everything
    above it is about the code, this is about the data in production.
    """

    def test_the_published_file_is_self_consistent(self):
        pub = wind_verify.load_published()
        problems = wind_verify.check_self_consistency(pub)
        assert problems == [], problems

    def test_the_published_grid_has_the_shape_the_frontend_expects(self):
        pub = wind_verify.load_published()
        g = pub.grid
        # 0.25° since 2026-11-04. The wind used to be published at 1°,
        # and the same GFS cycle at 1° and at 0.25° agrees exactly at
        # nineteen of twenty sampled points and is 78° out at Nairobi —
        # so the 1° grid could not carry the answer where the flow has
        # structure finer than a degree.
        assert (g["rows"], g["cols"]) == (721, 1440)
        assert g["lat_step"] == 0.25 and g["lon_step"] == 0.25
        assert g["lat_min"] == -90.0 and g["lat_max"] == 90.0
        assert g["lon_min"] == 0.0
        # And the product says so, so the no-op can tell a resolution
        # change from an unchanged cycle.
        assert pub.meta["product"] == "gfs.0p25"

    def test_the_globe_gets_a_coarse_pair_from_the_same_field(self):
        # The globe's wind is a TEXTURE with no numbers in it, so it
        # reads the 1° copy — written by the same run from the same
        # fetch, so the two cannot disagree.
        import json
        import os
        from worker import windmap
        meta_path = os.path.join(windmap.OUT_DIR, "meta-1deg.json")
        grid_path = os.path.join(windmap.OUT_DIR, "grid-1deg.bin")
        assert os.path.exists(meta_path), meta_path
        assert os.path.exists(grid_path), grid_path
        with open(meta_path) as fh:
            meta = json.load(fh)
        g = meta["grid"]
        assert (g["rows"], g["cols"]) == (181, 360)
        assert g["file"] == "grid-1deg.bin"
        assert os.path.getsize(grid_path) == 181 * 360 * 2 * 2
        # Same analysis, same cycle.
        with open(os.path.join(windmap.OUT_DIR, "meta.json")) as fh:
            full = json.load(fh)
        assert meta["run_time"] == full["run_time"]

    def test_the_published_grid_reads_the_right_winds(self):
        # The external anchor is the cell-by-cell comparison with the
        # raw GRIB below — that one holds for every cycle. These are
        # the relationships that must hold in ANY GFS analysis, so
        # they do not go stale when the 6-hourly cycle advances.
        pub = wind_verify.load_published()
        for lat, lon in ((40.873, -64.739), (41.740, -82.390), (0.0, 0.0)):
            u, v = pub.bilinear(lat, lon)
            # The speed is the magnitude of the vector …
            assert math.hypot(u, v) == pytest.approx(
                wind_verify.describe(u, v)["speed_ms"], abs=0.02)
            # … and the field is a real wind, not a decode artefact.
            assert 0.0 < math.hypot(u, v) < 80.0, (lat, lon, u, v)

    def test_the_published_grid_has_the_right_bearings(self):
        # The wind comes FROM a compass direction, and the bearing is
        # derived from the (u, v) signs: u < 0 means the wind blows
        # west, so it comes from the east.
        #
        # The CONVENTION is tested with synthetic vectors — a live
        # point-sample at a fixed coordinate goes stale every 6 hours
        # when the GFS cycle advances (Lake Erie blew from SSE on
        # 2026-10-28, failing a hardcoded "from the east" for a day
        # when nothing was wrong). The climatological invariants below
        # hold in ANY analysis; the convention itself needs no data.
        assert wind_verify.describe(0.0, -5.0)["from_deg"] == pytest.approx(0.0, abs=0.1)    # blows south → from north
        assert wind_verify.describe(0.0, 5.0)["from_deg"] == pytest.approx(180.0, abs=0.1)   # blows north → from south
        assert wind_verify.describe(5.0, 0.0)["from_deg"] == pytest.approx(270.0, abs=0.1)   # blows east  → from west
        assert wind_verify.describe(-5.0, 0.0)["from_deg"] == pytest.approx(90.0, abs=0.1)   # blows west  → from east
        # And the trades are easterly while the westerlies are not.
        # The rows come from the LATITUDE BANDS, not from hardcoded
        # indices: the grid was 1° (181 rows) and is 0.25° (721 rows)
        # since 2026-11-04, and the old indices read the mid-latitude
        # westerlies when they meant the trades.
        pub = wind_verify.load_published()
        trade_rows = _rows_for(pub, -15.0, 15.0)
        westerly_rows = _rows_for(pub, 35.0, 55.0)
        assert float(pub.u[trade_rows].mean()) < 0
        assert float(pub.u[westerly_rows].mean()) > 0

    def test_the_trades_are_easterly_in_the_published_grid(self):
        # A global relationship that a scrambled field cannot keep.
        pub = wind_verify.load_published()
        trade_u = float(pub.u[_rows_for(pub, -15.0, 15.0)].mean())
        westerly_u = float(pub.u[_rows_for(pub, 35.0, 55.0)].mean())
        assert trade_u < 0, trade_u
        assert westerly_u > 0, westerly_u

    def test_the_published_grid_matches_the_raw_grib_cell_for_cell(self):
        """The published grid against a second, independent decode.

        The second decode uses the GRIB message's OWN index arithmetic
        rather than decode_field()'s normalisation, so a mirrored field,
        a swapped u/v, a wrong scale or a stale cycle all fail here.
        """
        pub = wind_verify.load_published()
        date_str, cycle = pub.cycle
        try:
            raw_u, raw_v = wind_verify.fetch_raw_cycle(date_str, cycle)
        except RuntimeError as exc:
            pytest.skip(f"NOMADS unreachable: {exc}")

        result = wind_verify.compare_cell_by_cell(pub, raw_u, raw_v)
        assert result["cells_over_tolerance"] == 0, result
        assert result["max_diff_ms"] <= wind_verify.TOL_MS, result

    def test_the_published_bilinear_matches_the_raw_grib(self):
        pub = wind_verify.load_published()
        date_str, cycle = pub.cycle
        try:
            raw_u, raw_v = wind_verify.fetch_raw_cycle(date_str, cycle)
        except RuntimeError as exc:
            pytest.skip(f"NOMADS unreachable: {exc}")

        result = wind_verify.compare_bilinear(
            pub, raw_u, raw_v, wind_verify.DEFAULT_POINTS)
        assert result["max_diff_ms"] <= wind_verify.TOL_MS, result

    @pytest.mark.network
    def test_the_published_grid_agrees_with_an_independent_implementation(self):
        """Open-Meteo's GFS — the same NOAA analysis, a different code path.

        This is the check that catches a field which decodes correctly
        but means something else: u and v swapped, the wrong level, the
        wrong sign. The direction is only compared where the wind is
        strong enough for it to mean anything.

        ONE coastal outlier is tolerated: a 1° bilinear cannot resolve
        a front against a coast (Tokyo swings 1.9..7.1 m/s inside one
        degree and Open-Meteo's 0.25° grid reads 7+ on the shore while
        our cell centre says 1.6). A swapped or mirrored field fails
        EVERY point by tens of m/s, so one outlier cannot hide it —
        any failure beyond 2× its tolerance still fails the test.
        """
        pub = wind_verify.load_published()
        rows = wind_verify.compare_reference(pub, wind_verify.DEFAULT_POINTS)
        checked = 0
        outliers = 0
        for row in rows:
            if not row.get("reference"):
                continue
            checked += 1
            if not row.get("calm"):
                assert row["delta_dir_deg"] <= wind_verify.TOL_DIRECTION_DEG + 60.0, row
            if abs(row["delta_speed_ms"]) <= row["speed_tolerance"]:
                continue
            # Over tolerance: allow a bounded coastal outlier only.
            outliers += 1
            assert abs(row["delta_speed_ms"]) <= 2 * row["speed_tolerance"], row
        assert checked >= 5, "the reference lookup returned nothing"
        assert outliers <= 1, f"{outliers} points over tolerance — not a coastal outlier"

    def test_the_local_spread_measures_the_sub_cell_variability(self):
        # The four 1° cells around a point can disagree wildly, and
        # that spread is what a 0.25° grid resolves and a 1° grid
        # cannot. Tokyo is the extreme case: 1.9 .. 7.1 m/s in one
        # degree, and the 0.25° analysis says 8.9.
        pub = wind_verify.load_published()
        spread = wind_verify.local_spread(pub, 35.68, 139.69)
        assert spread > 1.0, spread
        # A calm open-ocean point has little spread.
        assert wind_verify.local_spread(pub, 0.0, 0.0) < spread


# ── the independent verification has teeth ─────────────────────────────
class TestIndependentVerification:
    """worker/wind_verify.py must FAIL when the published grid is wrong.

    A verification tool that only ever says "yes" is worse than no
    tool at all, so each check is run against a deliberately broken
    copy of the published grid.
    """

    def _published(self):
        pub = wind_verify.load_published()
        import copy
        broken = copy.deepcopy(pub)
        return pub, broken

    def _raw(self, pub):
        date_str, cycle = pub.cycle
        try:
            return wind_verify.fetch_raw_cycle(date_str, cycle)
        except RuntimeError as exc:
            pytest.skip(f"NOMADS unreachable: {exc}")

    def test_a_mirrored_grid_is_caught(self):
        pub, broken = self._published()
        raw_u, raw_v = self._raw(pub)
        broken.u = broken.u[::-1, :]
        broken.v = broken.v[::-1, :]
        result = wind_verify.compare_cell_by_cell(broken, raw_u, raw_v)
        assert result["cells_over_tolerance"] > 10000, result

    def test_swapped_u_and_v_are_caught(self):
        pub, broken = self._published()
        raw_u, raw_v = self._raw(pub)
        broken.u, broken.v = broken.v, broken.u
        result = wind_verify.compare_cell_by_cell(broken, raw_u, raw_v)
        assert result["cells_over_tolerance"] > 1000, result

    def test_a_flipped_sign_is_caught(self):
        pub, broken = self._published()
        raw_u, raw_v = self._raw(pub)
        broken.u = -broken.u
        result = wind_verify.compare_cell_by_cell(broken, raw_u, raw_v)
        assert result["cells_over_tolerance"] > 1000, result

    def test_a_rescaled_grid_is_caught(self):
        pub, broken = self._published()
        raw_u, raw_v = self._raw(pub)
        broken.u = broken.u * 1.5
        result = wind_verify.compare_cell_by_cell(broken, raw_u, raw_v)
        assert result["cells_over_tolerance"] > 1000, result

    def test_a_shifted_latitude_is_caught(self):
        # The classic "off by one row" — the field looks plausible and
        # every single check on the values passes.
        pub, broken = self._published()
        raw_u, raw_v = self._raw(pub)
        broken.u = np.roll(broken.u, 1, axis=0)
        broken.v = np.roll(broken.v, 1, axis=0)
        result = wind_verify.compare_cell_by_cell(broken, raw_u, raw_v)
        assert result["cells_over_tolerance"] > 1000, result

    def test_the_antimeridian_is_interpolated_across_the_seam(self):
        # The two neighbours of the last column are the last column and
        # column ZERO — not the last column and itself. A clamp there
        # leaves a stripe at the dateline where the wind is stale.
        #
        # The seam is half a cell from the edge, so the probe point
        # moves with the grid: it was 359.5° on the 1° grid and is
        # 359.875° on the 0.25° one.
        pub = wind_verify.load_published()
        step = float(pub.grid["lon_step"])
        seam = 360.0 - step / 2.0
        u_last = pub.bilinear(0.0, 360.0 - step)[0]
        u0 = pub.bilinear(0.0, 0.0)[0]
        u_half = pub.bilinear(0.0, seam)[0]
        assert u_half == pytest.approx((u_last + u0) / 2, abs=0.02)

    def test_the_self_consistency_check_notices_a_broken_meta(self):
        pub, broken = self._published()
        broken.meta["mean_ms"] = 99.0
        problems = wind_verify.check_self_consistency(broken)
        assert any("mean_ms" in p for p in problems), problems


# ── the wind itself ─────────────────────────────────────────────────────
class TestDescribe:
    def test_an_easterly_wind_comes_from_the_west(self):
        d = wind_verify.describe(u=10.0, v=0.0)
        assert d["from_deg"] == pytest.approx(270.0)
        assert d["from"] == "W"

    def test_a_northerly_wind_comes_from_the_south(self):
        # v is northward, so a positive v blows north — and a wind that
        # blows north comes FROM the south.
        d = wind_verify.describe(u=0.0, v=10.0)
        assert d["from_deg"] == pytest.approx(180.0)
        assert d["from"] == "S"

    def test_a_southerly_wind_comes_from_the_north(self):
        d = wind_verify.describe(u=0.0, v=-10.0)
        assert d["from_deg"] == pytest.approx(0.0)
        assert d["from"] == "N"

    def test_the_units_are_consistent(self):
        d = wind_verify.describe(u=3.0, v=4.0)
        assert d["speed_ms"] == pytest.approx(5.0)
        assert d["speed_kmh"] == pytest.approx(18.0)
        assert d["speed_kt"] == pytest.approx(9.72, abs=0.05)

    def test_a_calm_wind_has_no_direction(self):
        d = wind_verify.describe(u=0.0, v=0.0)
        assert d["speed_ms"] == 0.0
        assert math.isfinite(d["from_deg"])


# ── the 15-minute poll's skip path ─────────────────────────────────────
class TestNoOpProductGuard:
    """The no-op is only real if BOTH halves can match.

    `write_meta` publishes the product PREFIXED (`"product":
    f"gfs.{product}"`), so meta.json holds `gfs.0p25` — while the guard
    compared the bare `PRODUCT` (`"0p25"`). The run_time half matched
    and the product half could never match, so the skip path was dead
    code: measured on 2026-11-06, after the poll went from 6 h to 15
    min, **seventy minutes** of ticks produced **zero** "already
    published" lines and **sixteen** writes — every tick decoded both
    components and rewrote grid.bin (4,056 KB) plus the 1° pair for a
    cycle that had not moved. tempmap.py had the identical bug and the
    identical fix.
    """

    def test_write_meta_publishes_the_string_the_guard_compares(self):
        from datetime import datetime, timezone

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "meta.json")
            speed = np.linspace(0.0, 18.0, 50).reshape(5, 10)
            lats = np.linspace(10.0, 12.0, 5)
            lons = np.linspace(0.0, 9.0, 10)
            windmap.write_meta(
                speed, speed, speed, lats, lons,
                datetime(2026, 11, 7, 0, 0, tzinfo=timezone.utc),
                windmap.PRODUCT, path,
            )
            with open(path) as fh:
                published = json.load(fh)["product"]

        assert published == windmap.PUBLISHED_PRODUCT
        assert published == windmap.published_product(windmap.PRODUCT)
        # genuinely prefixed — this is the whole trap
        assert published == "gfs.0p25"
        assert windmap.PRODUCT == "0p25"
        assert published != windmap.PRODUCT

    def test_the_guard_uses_it_not_the_bare_constant(self):
        # Assert on the SOURCE: the guard only runs on a tick with the
        # network up, so a behavioural test would need to fetch.
        from pathlib import Path

        src = Path(windmap.__file__).read_text()
        assert "current_product() == PUBLISHED_PRODUCT" in src
        assert "current_product() == PRODUCT\n" not in src
        assert src.count("current_product() == PUBLISHED_PRODUCT") == 2
        assert '"product": published_product(product)' in src
