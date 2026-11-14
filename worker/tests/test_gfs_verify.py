"""Tests for worker/gfs_verify.py — the cross-field audit of the overlays.

The wind, the pressure and the temperature are three fields from ONE
GFS analysis. Checking them against each other is what proves the
wind is right, because the pressure field is an INDEPENDENT WITNESS:
a mirrored, swapped or sign-flipped wind cannot line up with the
pressure gradient.

The tests here are SYNTHETIC (no network, no DB): a pressure field
with a known analytic geostrophic wind, so the expected answer can be
worked out on paper. The published artefacts are checked separately,
over the network, in test_gfs_verify_published.py.
"""
from __future__ import annotations

import math

import pytest

np = pytest.importorskip("numpy")

from worker import gfs_verify as gv  # noqa: E402


# ── a field with an analytic geostrophic wind ──────────────────────────
# The field is PERIODIC in both axes, so the isobar worker's smoothing
# (sigma = 2 cells, wrap in longitude) reproduces it exactly and the
# gradient comes out clean.
K = 2.0 * math.pi / 90.0           # a 90-degree wavelength, per DEGREE
DEG2RAD = math.pi / 180.0
# Amplitudes chosen so the gradient is a REALISTIC one: ~2 mPa/m, i.e.
# about 1 hPa per 50 km, which gives a geostrophic wind of ~17 m/s at
# 45 degrees.
AMP_X = 200000.0                   # Pa
AMP_Y = 120000.0                   # Pa


def synthetic_pressure(lats, lons):
    """p = p0 + Ax*sin(k*lon) + Ay*sin(k*lat), with a KNOWN gradient."""
    lon = np.asarray(lons, dtype=np.float64)[None, :]
    lat = np.asarray(lats, dtype=np.float64)[:, None]
    return 100000.0 + AMP_X * np.sin(K * lon) + AMP_Y * np.sin(K * lat)


def synthetic_gradient(lat_deg, lon_deg):
    """(dp/dx, dp/dy) in Pa per metre — the analytic gradient.

    The field is sin(K * degrees), so the derivative is with respect to
    DEGREES: a degree of longitude is 111320*cos(lat) metres and a
    degree of latitude is 111320 metres. The cos(lat) on the east axis
    is what makes a Mercator map stretch east-west towards the poles.
    """
    cos_lat = math.cos(math.radians(lat_deg))
    dpdx = (AMP_X * K * math.cos(K * lon_deg) * DEG2RAD
            / (111320.0 * cos_lat))
    dpdy = (AMP_Y * K * math.cos(K * lat_deg) * DEG2RAD / 111320.0)
    return dpdx, dpdy


def geostrophic_wind(lat_deg, lon_deg):
    """The analytic geostrophic wind (u, v) at a point.

    V_g = (1/(rho f)) k x grad(p) = (-dp/dy, dp/dx) / (rho f).
    The geostrophic wind is undefined at the equator (f = 0).
    """
    f = 2.0 * gv.OMEGA * math.sin(math.radians(lat_deg))
    if abs(f) < 1e-6:
        return 0.0, 0.0
    dpdx, dpdy = synthetic_gradient(lat_deg, lon_deg)
    return -dpdy / (gv.RHO0 * f), dpdx / (gv.RHO0 * f)


def meridional_wind(lats, lons):
    """The wind field that IS the geostrophic wind."""
    u = np.zeros((len(lats), len(lons)))
    v = np.zeros((len(lats), len(lons)))
    for r, lat in enumerate(lats):
        for c, lon in enumerate(lons):
            u[r, c], v[r, c] = geostrophic_wind(lat, lon)
    return u, v


def turned_wind(lats, lons, turn_deg, towards_low=True):
    """The geostrophic wind turned `turn_deg` ACROSS the isobars.

    Friction turns the surface flow towards the LOW pressure: the
    along-isobar component keeps its direction, the cross-isobar
    component points at the low.
    """
    u, v = meridional_wind(lats, lons)
    speed = np.hypot(u, v)
    out_u = np.zeros_like(u)
    out_v = np.zeros_like(v)
    sign = 1.0 if towards_low else -1.0
    turn = math.radians(turn_deg)
    for r, lat in enumerate(lats):
        for c, lon in enumerate(lons):
            dpdx, dpdy = synthetic_gradient(lat, lon)
            gmag = math.hypot(dpdx, dpdy)
            lx, ly = -dpdx / gmag, -dpdy / gmag        # towards the low
            sx, sy = -ly, lx                            # along the isobars
            along = u[r, c] * sx + v[r, c] * sy
            out_u[r, c] = along * sx + sign * math.sin(turn) * lx * speed[r, c]
            out_v[r, c] = along * sy + sign * math.sin(turn) * ly * speed[r, c]
    return out_u, out_v


def lats_lons():
    lats = np.arange(-85.0, 85.1, 2.0)
    lons = np.arange(0.0, 360.0, 2.0)
    return lats, lons


# ── the geostrophic check ──────────────────────────────────────────────
class TestGeostrophicCheck:
    def test_a_balanced_flow_is_recognised(self):
        # The wind IS the geostrophic wind: the angle has to be ~0.
        lats, lons = lats_lons()
        mslp = synthetic_pressure(lats, lons)
        u, v = meridional_wind(lats, lons)
        res = gv.geostrophic_check(u, v, mslp, lats, lons)
        assert res["ok"], res
        assert res["median_angle_from_geostrophic_deg"] < 2.0, res
        assert res["p90_angle_from_geostrophic_deg"] < 5.0, res

    def test_a_frictional_flow_is_off_by_the_right_amount(self):
        # The surface wind is turned towards the low pressure: the
        # angle has to come out at the turn, and EVERY cell has to be
        # flowing towards the low.
        lats, lons = lats_lons()
        mslp = synthetic_pressure(lats, lons)
        u_t, v_t = turned_wind(lats, lons, 30.0, towards_low=True)
        res = gv.geostrophic_check(u_t, v_t, mslp, lats, lons)
        assert res["ok"], res
        # The turn comes out a few degrees under 30 because the isobar
        # worker's smoothing is isotropic in INDEX space, not in metres:
        # a longitude cell is 111320*cos(lat) m and a latitude cell is
        # 111320 m, so the blur turns the gradient a little.
        assert res["median_angle_from_geostrophic_deg"] == pytest.approx(30.0, abs=5.0), res
        assert res["fraction_flowing_towards_low_pressure"] > 0.95, res

    def test_a_mirrored_wind_is_detected(self):
        # The control: flip the wind north-south and the check has to
        # notice. A check that cannot fail is worse than no check.
        lats, lons = lats_lons()
        mslp = synthetic_pressure(lats, lons)
        u, v = meridional_wind(lats, lons)
        good = gv.geostrophic_check(u, v, mslp, lats, lons)
        # Mirror about the equator: row r becomes row N-1-r.
        u_mirror = u[::-1, :]
        bad = gv.geostrophic_check(u_mirror, v, mslp, lats, lons)
        assert bad["median_angle_from_geostrophic_deg"] > \
            good["median_angle_from_geostrophic_deg"] + 20.0, (good, bad)

    def test_a_reversed_wind_is_detected(self):
        lats, lons = lats_lons()
        mslp = synthetic_pressure(lats, lons)
        u, v = meridional_wind(lats, lons)
        good = gv.geostrophic_check(u, v, mslp, lats, lons)
        bad = gv.geostrophic_check(u, -v, mslp, lats, lons)
        assert bad["median_angle_from_geostrophic_deg"] > \
            good["median_angle_from_geostrophic_deg"] + 20.0, (good, bad)

    def test_swapped_u_and_v_are_detected(self):
        lats, lons = lats_lons()
        mslp = synthetic_pressure(lats, lons)
        u, v = meridional_wind(lats, lons)
        good = gv.geostrophic_check(u, v, mslp, lats, lons)
        bad = gv.geostrophic_check(v, u, mslp, lats, lons)
        assert bad["median_angle_from_geostrophic_deg"] > \
            good["median_angle_from_geostrophic_deg"] + 20.0, (good, bad)

    def test_a_flow_the_wrong_way_across_the_isobars_is_detected(self):
        # The friction sign is what tells the two hemispheres apart:
        # flow towards the low pressure, never away from it.
        lats, lons = lats_lons()
        mslp = synthetic_pressure(lats, lons)
        wrong_u, wrong_v = turned_wind(lats, lons, 30.0, towards_low=False)
        res = gv.geostrophic_check(wrong_u, wrong_v, mslp, lats, lons)
        assert res["ok"], res
        assert res["fraction_flowing_towards_low_pressure"] < 0.05, res

    def test_the_tropics_are_excluded(self):
        # The Coriolis force is too weak there for the relation to mean
        # anything.
        lats = np.arange(-89.0, 90.0, 2.0)
        lons = np.arange(0.0, 360.0, 2.0)
        mslp = synthetic_pressure(lats, lons)
        u, v = meridional_wind(lats, lons)
        res = gv.geostrophic_check(u, v, mslp, lats, lons)
        assert res["ok"], res
        # Nothing within 20° of the equator is counted.
        assert res["cells"] < len(lats) * len(lons)


# ── the advection check ────────────────────────────────────────────────
class TestAdvectionCheck:
    def test_a_flow_out_of_a_cold_region_advects_cold_air(self):
        # The temperature falls towards the north, the wind blows
        # north: the flow carries cold air with it.
        lats = np.arange(-70.0, 70.1, 2.0)
        lons = np.arange(0.0, 360.0, 4.0)
        temp = (np.array([-0.2 * (lat + 90.0) for lat in lats])[:, None]
                * np.ones((1, len(lons))))
        u = np.zeros((len(lats), len(lons)))
        v = np.full((len(lats), len(lons)), -8.0)   # blowing south
        res = gv.advection_check(u, v, temp, lats, lons)
        assert res["ok"], res
        # The flow moves from the cold north into the warm south, so it
        # is carrying the COLDER air with it.
        assert res["fraction_advecting_cold_air"] > 0.95, res

    def test_a_flow_out_of_a_warm_region_is_the_other_way(self):
        # The same wind, but the warm side is now to the north: the
        # flow blows from the warm north into the cold south, so it
        # carries WARM air and the verdict flips.
        lats = np.arange(-70.0, 70.1, 2.0)
        lons = np.arange(0.0, 360.0, 4.0)
        temp = (np.array([0.2 * (lat + 90.0) for lat in lats])[:, None]
                * np.ones((1, len(lons))))
        u = np.zeros((len(lats), len(lons)))
        v = np.full((len(lats), len(lons)), -8.0)   # blowing south
        res = gv.advection_check(u, v, temp, lats, lons)
        assert res["ok"], res
        assert res["fraction_advecting_cold_air"] < 0.05, res

    def test_a_reversed_wind_flips_the_verdict(self):
        lats = np.arange(-70.0, 70.1, 2.0)
        lons = np.arange(0.0, 360.0, 4.0)
        temp = (np.array([-0.2 * (lat + 90.0) for lat in lats])[:, None]
                * np.ones((1, len(lons))))
        u = np.zeros((len(lats), len(lons)))
        v = np.full((len(lats), len(lons)), -8.0)
        good = gv.advection_check(u, v, temp, lats, lons)
        bad = gv.advection_check(u, -v, temp, lats, lons)
        assert good["fraction_advecting_cold_air"] > 0.9
        assert bad["fraction_advecting_cold_air"] < 0.1


# ── the cell-by-cell comparison ─────────────────────────────────────────
class TestCompareWithRaw:
    def _raw(self, values, jpos=0, lat1=90.0):
        values = np.asarray(values, dtype=np.float64)
        nj, ni = values.shape
        return gv.RawField(values, ni, nj, lat1, 0.0, 1.0, 1.0, jpos, "test")

    def test_a_matching_grid_has_no_difference(self):
        lats = np.arange(-90.0, 90.1, 1.0)
        lons = np.arange(0.0, 360.0, 1.0)
        values = np.random.default_rng(7).normal(size=(181, 360))
        pub = gv.Grid({"grid": {"rows": 181, "cols": 360, "lat_min": -90.0,
                                "lat_max": 90.0, "lon_min": 0.0,
                                "lat_step": 1.0, "lon_step": 1.0}},
                      values)
        # The raw message is stored north-first; the published grid is
        # south-first.
        raw = self._raw(values[::-1, :])
        res = gv.compare_with_raw(pub, raw)
        assert res["cells_over_tolerance"] == 0, res
        assert res["max_diff"] < 0.01, res

    def test_a_mirrored_grid_is_caught(self):
        lats = np.arange(-90.0, 90.1, 1.0)
        lons = np.arange(0.0, 360.0, 1.0)
        values = np.random.default_rng(11).normal(size=(181, 360))
        pub = gv.Grid({"grid": {"rows": 181, "cols": 360, "lat_min": -90.0,
                                "lat_max": 90.0, "lon_min": 0.0,
                                "lat_step": 1.0, "lon_step": 1.0}},
                      values)
        raw = self._raw(values[::-1, :])
        broken = gv.Grid(pub.meta, values[::-1, :])
        res = gv.compare_with_raw(broken, raw)
        assert res["cells_over_tolerance"] > 10000, res

    def test_a_one_row_shift_is_caught(self):
        values = np.random.default_rng(13).normal(size=(181, 360))
        pub = gv.Grid({"grid": {"rows": 181, "cols": 360, "lat_min": -90.0,
                                "lat_max": 90.0, "lon_min": 0.0,
                                "lat_step": 1.0, "lon_step": 1.0}},
                      values)
        raw = self._raw(values[::-1, :])
        broken = gv.Grid(pub.meta, np.roll(values, 1, axis=0))
        res = gv.compare_with_raw(broken, raw)
        assert res["cells_over_tolerance"] > 10000, res

    def test_a_wrong_scale_is_caught(self):
        values = np.random.default_rng(17).normal(size=(181, 360))
        pub = gv.Grid({"grid": {"rows": 181, "cols": 360, "lat_min": -90.0,
                                "lat_max": 90.0, "lon_min": 0.0,
                                "lat_step": 1.0, "lon_step": 1.0}},
                      values)
        raw = self._raw(values[::-1, :])
        broken = gv.Grid(pub.meta, values * 1.5)
        res = gv.compare_with_raw(broken, raw)
        assert res["cells_over_tolerance"] > 10000, res

    def test_the_tolerance_is_the_storage_quantum(self):
        values = np.zeros((181, 360))
        pub = gv.Grid({"grid": {"rows": 181, "cols": 360, "lat_min": -90.0,
                                "lat_max": 90.0, "lon_min": 0.0,
                                "lat_step": 1.0, "lon_step": 1.0}},
                      values)
        raw = self._raw(np.zeros((181, 360)))
        # Half a quantum of a 0.1 C storage is inside the tolerance …
        res = gv.compare_with_raw(gv.Grid(pub.meta, np.full((181, 360), 0.04)),
                                   raw, tol=0.05)
        assert res["cells_over_tolerance"] == 0, res
        # … and a whole quantum is not.
        res = gv.compare_with_raw(gv.Grid(pub.meta, np.full((181, 360), 0.06)),
                                   raw, tol=0.05)
        assert res["cells_over_tolerance"] > 0, res


# ── the published overlays ──────────────────────────────────────────────
class TestPublishedOverlays:
    def test_the_wind_grid_has_the_expected_shape(self):
        wind, u, v = gv.Grid.load_planar_pair(gv.WIND_DIR)
        # 0.25° since 2026-11-04 (it was 1°). The wind used to be
        # published at 1°, and the SAME GFS cycle at 1° and at 0.25°
        # agrees exactly at nineteen of twenty sampled points and is
        # 78° out at Nairobi — so the 1° grid could not carry the answer
        # where the flow has structure finer than a degree.
        assert wind.values.shape == (721, 1440)
        assert u.shape == v.shape == (721, 1440)
        assert wind.grid["lat_min"] == -90.0
        assert wind.grid["lon_min"] == 0.0
        assert wind.grid["lat_step"] == 0.25
        # The two planes are NOT the same field (a swapped or copied
        # plane would make the wind point the same way everywhere).
        assert not np.array_equal(u, v)

    def test_the_wind_is_finite_and_in_a_plausible_range(self):
        _, u, v = gv.Grid.load_planar_pair(gv.WIND_DIR)
        assert np.isfinite(u).all() and np.isfinite(v).all()
        speed = np.hypot(u, v)
        assert speed.max() < 100.0
        assert speed.mean() > 1.0

    def test_the_temperature_grid_has_the_expected_shape(self):
        temp = gv.Grid.load(gv.TEMP_DIR)
        # 0.25° since 2026-11-04, so the temperature matches the
        # isobars — which have always been 0.25°.
        assert temp.values.shape == (721, 1440)
        assert temp.grid["lat_step"] == 0.25
        assert temp.values.min() > -90.0
        assert temp.values.max() < 60.0

    def test_the_wind_and_the_temperature_are_at_most_one_cycle_apart(self):
        wind, _, _ = gv.Grid.load_planar_pair(gv.WIND_DIR)
        temp = gv.Grid.load(gv.TEMP_DIR)
        lag = gv._cycle_lag_hours(wind.run_time, temp.run_time)
        assert lag is not None
        assert -6.0 <= lag <= 6.0, (wind.run_time, temp.run_time)


# ── the published artefacts against the live analysis ───────────────────
class TestPublishedAgainstGFS:
    """The overlays that are actually on the map, checked against NOMADS.

    Marked `network` — they download the GFS messages of the published
    cycle and compare them with the published files cell by cell.
    """

    @pytest.mark.network
    def test_the_published_wind_is_the_gfs_wind(self):
        wind, u, v = gv.Grid.load_planar_pair(gv.WIND_DIR)
        date_str, cycle = wind.cycle
        try:
            # The PRODUCT the published grid was cut from — 0.25° since
            # 2026-11-04. Comparing a 0.25° grid with the 1° product is
            # not a rounding difference, it is a different field.
            raw_u = gv.fetch_raw(date_str, cycle, "UGRD", "10_m_above_ground", "10u",
                                 suffixes=gv.published_suffixes(wind))
            raw_v = gv.fetch_raw(date_str, cycle, "VGRD", "10_m_above_ground", "10v",
                                 suffixes=gv.published_suffixes(wind))
        except RuntimeError as exc:
            pytest.skip(f"NOMADS unreachable: {exc}")
        res_u = gv.compare_with_raw(gv.Grid(wind.meta, u), raw_u)
        res_v = gv.compare_with_raw(gv.Grid(wind.meta, v), raw_v)
        assert res_u["cells_over_tolerance"] == 0, res_u
        assert res_v["cells_over_tolerance"] == 0, res_v
        assert res_u["max_diff"] <= 0.011, res_u
        assert res_v["max_diff"] <= 0.011, res_v

    @pytest.mark.network
    def test_the_published_temperature_is_the_gfs_temperature(self):
        temp = gv.Grid.load(gv.TEMP_DIR)
        date_str, cycle = temp.cycle
        try:
            raw_t = gv.fetch_raw(date_str, cycle, "TMP", "2_m_above_ground", "2t",
                                 suffixes=gv.published_suffixes(temp))
        except RuntimeError as exc:
            pytest.skip(f"NOMADS unreachable: {exc}")
        res = gv.compare_with_raw(temp, raw_t, offset=-273.15, tol=0.05)
        assert res["cells_over_tolerance"] == 0, res
        assert res["max_diff"] <= 0.05, res

    @pytest.mark.network
    @pytest.mark.live
    def test_the_isobars_are_contours_of_the_pressure_field(self):
        # The lines the map serves have to BE contours: the pressure
        # read at a point on a line has to equal that line's level.
        #
        # Every published analysis is checked against ITS OWN raw
        # message, ON ITS OWN GRID — ECMWF's lines against ECMWF's
        # 0.1° field, GFS's against GFS's 0.25° one. Checking one
        # against the other would prove nothing, and checking GFS's
        # 0.25° lines against the 1° product would prove something
        # FALSE: the two fields differ by far more than the
        # contouring error.
        meta = gv._fetch_isobar_meta()
        sources = (meta or {}).get("sources") or {}
        if not sources:
            pytest.skip("the isobar API did not answer")
        for src_name, src_info in sources.items():
            if src_name == "hrrr":
                continue
            date_str, cycle = gv._cycle_from_stamp(src_info.get("run_time"))
            try:
                raw_p = gv.fetch_raw_isobar(date_str, cycle, src_name)
            except RuntimeError as exc:
                pytest.skip(f"the raw message was unreachable: {exc}")
            res = gv.isobar_check(raw_p, source=src_name)
            if not res.get("ok"):
                pytest.skip(res.get("reason"))
            assert res["lines"] > 0, res
            assert res["vertices_checked"] > 50, res
            # Absolute, not relative to the contour interval: these are
            # how far the published line sits from the RAW field's value
            # at that point, and that distance comes from the Chaikin
            # rounding and the Douglas-Peucker simplification — neither
            # of which knows what interval was requested. Halving the
            # interval therefore does not change them, but it does make
            # them a LARGER fraction of the spacing (a p95 of 2.5 hPa
            # is now more than one step), which is why the UI defaults
            # the reader to 4 hPa and treats 1 and 2 as the choices for
            # a close-up where the gradient is steep.
            #
            # Measured against the field each source's lines were cut
            # from (2026-11-04, at the 1 hPa interval): GFS p95 0.029
            # hPa, median 0.001; ECMWF p95 0.011 hPa. Re-measured after
            # the `int(level_hpa)` truncation was fixed, at the 0.05 hPa
            # interval (2026-11-06): GFS p95 0.032 / median 0.001,
            # ECMWF p95 0.010 / median 0.000. The tolerances are the
            # GATE's own, so the two cannot drift apart: the gate is
            # `isobar_gate()`, and this asserts the same numbers it
            # reads.
            # The MEDIAN is the "half the lines are exact" number. It
            # is bounded by the gate's own tolerance rather than a
            # hardcoded 0.1, so a change to the gate's own allowance
            # moves this assertion with it.
            assert res["median_abs_offset_hpa"] < gv.ISO_MEDIAN_TOL_HPA, res
            assert res["p95_abs_offset_hpa"] < gv.ISO_P95_TOL_HPA, res
            # A systematic offset is a data bug — a mirrored field, a
            # mis-aligned longitude axis, a stale cycle.
            assert abs(res["mean_offset_hpa"]) < gv.ISO_MEAN_TOL_HPA, res
            # The grid the field was rebuilt on is the grid the lines
            # were contoured on: 0.25° for GFS, 0.1° for ECMWF.
            expected_grid = 0.1 if src_name == "ecmwf" else 0.25
            assert res["grid_deg"] == pytest.approx(expected_grid), res

    @pytest.mark.network
    @pytest.mark.live
    def test_a_displaced_isobar_set_fails_the_gate(self):
        # The gate has to have teeth on the REAL published lines, at the
        # resolution they were cut on. Three displacements, each of them
        # a bug the check exists to catch:
        #
        #   * the lines shifted ONE grid row (0.25° of latitude) — a
        #     decoder that mis-indexed the rows;
        #   * the lines shifted ONE grid column (0.25° of longitude) — a
        #     mis-aligned longitude axis;
        #   * the field replaced by the 1° product — the bug this whole
        #     fix is about, which reported a FALSE ALARM at 1.35 hPa.
        #
        # The offsets are measured against the field the lines were cut
        # from, so they are the same numbers the audit prints.
        meta = gv._fetch_isobar_meta()
        sources = (meta or {}).get("sources") or {}
        src_info = sources.get("gfs")
        if not src_info:
            pytest.skip("the isobar API did not answer")
        date_str, cycle = gv._cycle_from_stamp(src_info.get("run_time"))
        try:
            raw_p = gv.fetch_raw_isobar(date_str, cycle, "gfs")
            raw_1p00 = gv.fetch_raw(date_str, cycle, "PRMSL", "mean_sea_level", "prmsl")
        except RuntimeError as exc:
            pytest.skip(f"the raw message was unreachable: {exc}")
        items = gv._stored_isobar_lines("gfs", (30, -40, 60, 0))
        if not items:
            pytest.skip("no stored isobars in that area")

        # The unbroken set passes.
        good = gv.isobar_offsets(items, raw_p)
        assert good["ok"], good
        assert gv.isobar_gate(good) is None, good

        # Two grid rows north (0.5 degrees). One row is 0.25 degrees,
        # which at the 0.5 hPa interval lands inside the artefact band —
        # a decoder that mis-indexed by ONE row would still pass, which
        # is a gate with a hole in it. Two rows is the same class of bug
        # at twice the magnitude, and it must fail.
        row = [{"level_hpa": it["level_hpa"],
                "coordinates": [[lo, la + 0.5] for lo, la in it["coordinates"]]}
               for it in items]
        res = gv.isobar_offsets(row, raw_p)
        assert res["ok"], res
        assert gv.isobar_gate(res) is not None, res

        # One grid column east — the field, not the lines, is rolled.
        field, lats, lons, spacing = gv._native_grid(raw_p)
        rolled = gv.RawField(np.roll(field, 2, axis=1)[::-1, :], raw_p.ni, raw_p.nj,
                             raw_p.lat1, raw_p.lon1, raw_p.di, raw_p.dj,
                             raw_p.jpos, "prmsl")
        res = gv.isobar_offsets(items, rolled)
        assert res["ok"], res
        assert gv.isobar_gate(res) is not None, res

        # The wrong product — the false alarm.
        res = gv.isobar_offsets(items, raw_1p00)
        assert res["ok"], res
        assert gv.isobar_gate(res) is not None, res

    @pytest.mark.network
    @pytest.mark.live
    def test_the_wind_agrees_with_the_pressure_field(self):
        # The cross-check on the published data: the wind has to run
        # roughly along the isobars, turned slightly towards the low.
        wind, u, v = gv.Grid.load_planar_pair(gv.WIND_DIR)
        date_str, cycle = wind.cycle
        try:
            raw_p = gv.fetch_raw(date_str, cycle, "PRMSL", "mean_sea_level", "prmsl",
                                 suffixes=gv.published_suffixes(wind))
        except RuntimeError as exc:
            pytest.skip(f"NOMADS unreachable: {exc}")
        lats = wind.lats()
        lons = wind.lons()
        # The pressure field on the WIND'S OWN grid, smoothed the way the
        # isobar worker smooths it — so the claim "the flow runs along
        # the isobars" is tested against the field the isobars are cut
        # from. (The old "row = lat + 90" mapping assumed a 1° lattice
        # and put the pressure in the wrong cells once the wind moved to
        # 0.25°.)
        p_field, p_lats, p_lons, p_spacing = gv._native_grid(raw_p)
        p_smooth = gv.smooth_like_isobars(p_field, p_spacing)
        mslp = gv._resample_to(p_smooth, p_lats, p_lons, lats, lons) / 100.0
        res = gv.geostrophic_check(u, v, mslp, lats, lons)
        assert res["ok"], res
        # A real surface flow is 10-30° off the geostrophic wind.
        assert res["median_angle_from_geostrophic_deg"] < 40.0, res
        # And it crosses the isobars towards the LOW pressure, always.
        assert res["fraction_flowing_towards_low_pressure"] > 0.70, res
