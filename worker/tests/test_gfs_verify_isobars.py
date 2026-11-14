"""Tests for the isobar cross-check of worker/gfs_verify.py.

The isobars on the map are contours of a SMOOTHED pressure field, cut
on the SOURCE'S OWN grid: the GFS lines come from the 0.25° PRMSL, the
ECMWF ones from the IFS 0.1° message. The check compares the stored
lines with THAT field — so the resolution the field is fetched at is
part of the check, not a detail of it.

What is pinned here:

  1. the field the check reads is fetched on the grid the lines were
     cut from (0.25° for GFS), and the wind/temperature checks keep
     their 1° product;
  2. the blur is the WORKER'S OWN — there is no second implementation
     of the sigma, and the two grids that matter get the same PHYSICAL
     width;
  3. lines cut from the field pass the check;
  4. a broken set FAILS the check — a line shifted by one grid row, a
     level off by 2 hPa, or a field that is not the one the lines were
     cut from. A check that cannot fail is worse than no check.

The tests are SYNTHETIC (no network, no DB): a global pressure field
with a known gradient is contoured with the worker's own code and then
read back by the checker.
"""
from __future__ import annotations

import math

import pytest

np = pytest.importorskip("numpy")

# worker.isobars imports worker.db (psycopg) at module level, and the
# import order matters: psycopg has to be in the process BEFORE eccodes
# or the interpreter segfaults while tearing the two native libraries
# down. Importing worker.isobars first guarantees that.
from worker import isobars  # noqa: E402
from worker import gfs_verify as gv  # noqa: E402


# ── a synthetic pressure field ──────────────────────────────────────────
# The field carries:
#   * a linear meridional ramp (0.8 hPa/deg) — its gradient has ONE
#     SIGN everywhere, so a systematic shift of the lines produces a
#     systematic offset, which is what the mean gate looks for;
#   * a slow zonal wave;
#   * a short zonal wave (8 deg) — the structure a 1° grid cannot
#     resolve, which is what makes "checked against the wrong grid"
#     visible rather than theoretical.
GRID_FINE = (361, 720)      # 0.5° — the stand-in for the GFS 0.25° grid
GRID_COARSE = (181, 360)    # 1°   — the stand-in for the 1p00 product
ISO_INTERVAL = 4            # the check is interval-agnostic; fewer levels = faster


def synthetic_field(n_rows: int, n_cols: int):
    """(field in hPa, lats ascending, lons 0..360) on a global grid."""
    lats = np.linspace(-90.0, 90.0, n_rows)
    lons = np.arange(n_cols) * (360.0 / n_cols)
    lat = lats[:, None]
    lon = lons[None, :]
    field = (
        1013.0
        + 0.8 * lat
        + 12.0 * np.sin(2 * math.pi * lon / 360.0)
        + 6.0 * np.sin(4 * math.pi * lat / 180.0)
        + 6.0 * np.sin(2 * math.pi * lon / 8.0)
    )
    return field, lats, lons


def raw_from(field_hpa: np.ndarray, lats: np.ndarray, lons: np.ndarray) -> gv.RawField:
    """The field as a RAW GRIB message would deliver it.

    The message is north-first (jScansPositively = 0) and in Pa, and
    its own index arithmetic is what the checker uses.
    """
    n_rows, n_cols = field_hpa.shape
    return gv.RawField(
        values=field_hpa[::-1, :] * 100.0,
        ni=n_cols,
        nj=n_rows,
        lat1=float(lats[-1]),
        lon1=0.0,
        di=360.0 / n_cols,
        dj=(float(lats[-1]) - float(lats[0])) / (n_rows - 1),
        jpos=0,
        short_name="prmsl",
    )


def stored_items(lines) -> list[dict]:
    """The worker's contour output in the shape the checker reads."""
    return [
        {"level_hpa": level, "coordinates": [list(p) for p in points]}
        for level, points in lines
    ]


@pytest.fixture(scope="module")
def fine():
    """(field, lats, lons, lines) on the 0.5° grid."""
    field, lats, lons = synthetic_field(*GRID_FINE)
    lines = isobars.contour_isobars(field, lats, lons, interval=ISO_INTERVAL)
    assert lines, "the synthetic field produced no contours"
    return field, lats, lons, lines


@pytest.fixture(scope="module")
def coarse():
    """(field, lats, lons) on the 1° grid."""
    return synthetic_field(*GRID_COARSE)


# ── the resolution the field is fetched at ──────────────────────────────
class TestFetchedResolution:
    def test_the_gfs_isobar_field_is_fetched_at_0p25(self, monkeypatch):
        """The GFS isobars are contoured from the 0.25° PRMSL.

        Reading the 1° product instead compares a contour with a
        DIFFERENT field — the bug this replaces. The pair is asked for
        in the worker's own order (0p25 first, 1p00 only as the
        fallback), so the check and the worker see the same grid.
        """
        seen: dict = {}

        def fake_fetch(date_str, cycle, var, level, purpose, suffixes=None):
            seen["suffixes"] = suffixes
            return b"GRIB", (suffixes or ("1p00",))[0]

        monkeypatch.setattr(isobars, "fetch_grib_field", fake_fetch)
        monkeypatch.setattr(
            gv, "decode_raw",
            lambda blob: gv.RawField(np.zeros((2, 2)), 2, 2, 90.0, 0.0,
                                     1.0, 1.0, 0, "prmsl"),
        )

        gv.fetch_raw_isobar("20261104", "18", "gfs")
        assert seen["suffixes"] == ("0p25", "1p00"), seen

    def test_the_wind_and_temperature_fields_stay_at_1p00(self, monkeypatch):
        """Their published grids ARE 1° — they are held in the browser —
        so their checks must keep comparing against the 1° message."""
        seen: dict = {}

        def fake_fetch(date_str, cycle, var, level, purpose, suffixes=None):
            seen["suffixes"] = suffixes
            return b"GRIB", (suffixes or ("1p00",))[0]

        monkeypatch.setattr(isobars, "fetch_grib_field", fake_fetch)
        monkeypatch.setattr(
            gv, "decode_raw",
            lambda blob: gv.RawField(np.zeros((2, 2)), 2, 2, 90.0, 0.0,
                                     1.0, 1.0, 0, "10u"),
        )

        gv.fetch_raw("20261104", "18", "UGRD", "10_m_above_ground", "10u")
        assert seen["suffixes"] == ("1p00",), seen

    def test_the_ecmwf_field_is_fetched_from_its_own_source(self, monkeypatch):
        """ECMWF's lines are cut from the IFS 0.1° message, not from a
        GFS product."""
        called: dict = {}

        def fake_ecmwf(date_str, cycle):
            called["args"] = (date_str, cycle)
            return gv.RawField(np.zeros((2, 2)), 2, 2, 90.0, 0.0,
                               0.1, 0.1, 0, "msl")

        monkeypatch.setattr(gv, "fetch_raw_ecmwf", fake_ecmwf)
        gv.fetch_raw_isobar("20261104", "12", "ecmwf")
        assert called["args"] == ("20261104", "12"), called


# ── the blur ────────────────────────────────────────────────────────────
class TestSmoothing:
    def test_the_check_uses_the_workers_own_blur(self):
        """There is no second implementation of the sigma: the check
        calls the worker's function, so the two cannot drift."""
        field = np.random.default_rng(3).normal(size=(181, 360))
        for spacing in (0.1, 0.25, 0.5, 1.0):
            assert np.array_equal(
                gv.smooth_like_isobars(field, spacing),
                isobars.smooth_field(field, spacing),
            ), spacing

    def test_the_two_published_grids_get_the_same_physical_blur(self):
        """0.25° and 0.1° get the SAME 0.5° of blur — the sigma is a
        physical width, so the finer grid needs more cells for it."""
        assert isobars.smooth_sigma_cells(0.25) * 0.25 == pytest.approx(0.5)
        assert isobars.smooth_sigma_cells(0.1) * 0.1 == pytest.approx(0.5)

    def test_the_one_degree_floor_is_the_workers_own(self):
        """A 1° grid is blurred by 2 CELLS = 2°, not by 0.5°. That is
        the worker's floor, and it is the same floor the worker applies
        — so it is not a discrepancy as long as both sides read the
        same grid."""
        assert isobars.smooth_sigma_cells(1.0) == 2.0
        assert isobars.smooth_sigma_cells(1.0) * 1.0 == pytest.approx(2.0)


# ── the message's own geometry ──────────────────────────────────────────
class TestNativeGrid:
    def _reference(self, raw: gv.RawField) -> np.ndarray:
        """The straightforward loop the vectorised version replaced."""
        rows, cols = raw.nj, raw.ni
        raw_lats = (
            raw.lat1 - np.arange(rows) * raw.dj
            if raw.jpos == 0
            else raw.lat1 + np.arange(rows) * raw.dj
        )
        order = np.argsort(raw_lats)
        lats = raw_lats[order]
        south = float(lats[0])
        field = np.zeros((rows, cols), dtype=np.float64)
        for j in range(rows):
            row = int(round((float(lats[j]) - south) / abs(raw.dj)))
            if not (0 <= row < rows):
                continue
            raw_row = int(order[j])
            for i in range(cols):
                lon = (raw.lon1 + i * raw.di) % 360.0
                col = int(round(lon / abs(raw.di))) % cols
                field[row, col] = raw.values[raw_row, i]
        return field

    def test_it_matches_the_straightforward_implementation(self):
        rng = np.random.default_rng(5)
        for lat1, lon1, di, dj, jpos in (
            (90.0, 0.0, 1.0, 1.0, 0),
            (90.0, 0.0, 1.0, 1.0, 1),
            (90.0, 180.0, 0.1, 0.1, 0),
            (-90.0, 0.0, 0.25, 0.25, 1),
        ):
            nj, ni = 17, 36
            raw = gv.RawField(rng.normal(size=(nj, ni)), ni, nj, lat1, lon1,
                               di, dj, jpos, "prmsl")
            field, _lats, _lons, _sp = gv._native_grid(raw)
            assert np.array_equal(field, self._reference(raw)), (lat1, lon1, jpos)

    def test_it_puts_longitude_zero_at_column_zero(self):
        """ECMWF's IFS starts at longitude 180. The checker's grid has
        to put longitude 0 at column 0 — the worker's convention — or
        every ECMWF line would be read against the wrong place."""
        rows, cols, di = 18, 36, 10.0
        values = np.arange(rows * cols, dtype=float).reshape(rows, cols)
        raw = gv.RawField(values, ni=cols, nj=rows, lat1=90.0, lon1=180.0,
                          di=di, dj=di, jpos=0, short_name="msl")
        field, lats, lons, spacing = gv._native_grid(raw)
        assert lons[0] == 0.0
        assert spacing == pytest.approx(di)
        # In the message, longitude 0 sits at column (0 - 180) / 10 % 36
        # = 18, and the southernmost row is the LAST one (jpos = 0).
        assert field[0, 0] == values[rows - 1, 18]
        assert field[-1, 0] == values[0, 18]


# ── the check itself ────────────────────────────────────────────────────
class TestIsobarOffsets:
    def test_lines_cut_from_the_field_pass_the_check(self, fine):
        field, lats, lons, lines = fine
        res = gv.isobar_offsets(stored_items(lines), raw_from(field, lats, lons))
        assert res["ok"], res
        assert res["lines"] > 0, res
        assert res["vertices_checked"] > 50, res
        # The contour IS a contour of the smoothed field, so the offset
        # is the rounding the Chaikin + Douglas-Peucker pass leaves
        # behind — a hundredth of a hPa, not a hPa.
        assert res["median_abs_offset_hpa"] < 0.1, res
        assert res["p95_abs_offset_hpa"] < 0.25, res
        assert abs(res["mean_offset_hpa"]) < 0.05, res
        # And the gate is happy.
        assert gv.isobar_gate(res) is None, res

    def test_the_report_says_which_grid_was_used(self, fine):
        field, lats, lons, lines = fine
        res = gv.isobar_offsets(stored_items(lines), raw_from(field, lats, lons))
        assert res["grid_deg"] == pytest.approx(0.5), res
        assert res["smooth_sigma_cells"] == pytest.approx(2.0), res

    def test_an_empty_set_is_not_a_pass(self):
        res = gv.isobar_offsets([], None)
        assert not res["ok"], res
        # A check that could not run is a WARNING, never a failure.
        assert gv.isobar_gate(res) is None, res


class TestTheCheckFailsOnABrokenSet:
    """A check that cannot fail is worse than no check."""

    def test_a_line_shifted_by_grid_rows_is_caught(self, fine):
        field, lats, lons, lines = fine
        step = (float(lats[-1]) - float(lats[0])) / (len(lats) - 1)
        # The assertion below is the MEAN gate, so the shift has to be
        # a systematic BIAS: this synthetic field's ramp is 0.8 hPa/deg
        # on a 0.5 deg grid, so three rows is a measured ~1.3 hPa of
        # bias against a 0.25 hPa mean tolerance. (One row is 0.44 hPa
        # — also past it, but there the p95 gate would be the one
        # firing, and this test is about the mean.)
        rows = 3
        shifted = [
            {"level_hpa": it["level_hpa"],
             "coordinates": [[lon, lat + rows * step] for lon, lat in it["coordinates"]]}
            for it in stored_items(lines)
        ]
        res = gv.isobar_offsets(shifted, raw_from(field, lats, lons))
        assert res["ok"], res
        # Three rows of a field with a 0.8 hPa/deg gradient is a
        # systematic bias of about 0.6 hPa — past the mean gate.
        assert abs(res["mean_offset_hpa"]) > gv.ISO_MEAN_TOL_HPA, res
        assert gv.isobar_gate(res) is not None, res

    def test_a_level_off_by_two_hpa_is_caught(self, fine):
        field, lats, lons, lines = fine
        off = [
            {"level_hpa": it["level_hpa"] + 2, "coordinates": it["coordinates"]}
            for it in stored_items(lines)
        ]
        res = gv.isobar_offsets(off, raw_from(field, lats, lons))
        assert res["ok"], res
        assert abs(res["mean_offset_hpa"]) > gv.ISO_MEAN_TOL_HPA, res
        assert gv.isobar_gate(res) is not None, res

    def test_a_field_the_lines_were_not_cut_from_is_caught(self, fine, coarse):
        """The false alarm this whole fix is about.

        The SAME lines, read against the 1° field instead of the one
        they were cut from, come out more than 2.5 hPa away from it —
        the gate fires. Reading the right grid is the difference
        between a clean audit and a false alarm.
        """
        field, lats, lons, lines = fine
        items = stored_items(lines)

        good = gv.isobar_offsets(items, raw_from(field, lats, lons))
        assert gv.isobar_gate(good) is None, good

        c_field, c_lats, c_lons = coarse
        bad = gv.isobar_offsets(items, raw_from(c_field, c_lats, c_lons))
        assert bad["ok"], bad
        assert bad["p95_abs_offset_hpa"] > gv.ISO_P95_TOL_HPA, bad
        assert gv.isobar_gate(bad) is not None, bad
        # … and it is the same lines: the difference is the field, not
        # the geometry.
        assert bad["lines"] == good["lines"]
        assert bad["vertices_checked"] == good["vertices_checked"]

    def test_the_gate_catches_a_single_cell_displacement(self):
        """A displacement a decoder bug makes has to trip the gate.

        Measured on the REAL published lines (2026-11-04 18Z, the
        default Middle-East box): a shift of one 0.25 row gives a p95
        of 0.698 hPa and a shift of one 0.25 column 0.491 hPa — both
        above the 0.4 hPa tolerance, which is exactly what the
        tolerance was calibrated to catch. The tolerance was raised to
        1.0 hPa for one build cycle on the strength of "measurements"
        that turned out to be the checker's own `int(level_hpa)`
        truncation, and this test was weakened to TWO cells to stay
        outside it; with the tolerance back at 0.4 the gate catches a
        single cell again, so the test is back to one.

        On this synthetic field one row measures p95 0.606 / mean
        0.441 and one column p95 1.732 — comfortably outside both
        tolerances, so the assertion cannot be mistaken for noise.

        The synthetic field here has a coherent gradient, so its MEAN
        offset is large too — but the assertion is on the p95, because
        that is the statistic that works on the real field as well
        (a column shift has a near-zero mean: -0.003 here).
        """
        field, lats, lons = synthetic_field(*GRID_FINE)
        lines = isobars.contour_isobars(field, lats, lons, interval=ISO_INTERVAL)
        items = stored_items(lines)
        raw = raw_from(field, lats, lons)

        good = gv.isobar_offsets(items, raw)
        assert gv.isobar_gate(good) is None, good

        step = (float(lats[-1]) - float(lats[0])) / (len(lats) - 1)
        shifted = [
            {"level_hpa": it["level_hpa"],
             "coordinates": [[lon, lat + step] for lon, lat in it["coordinates"]]}
            for it in items
        ]
        res = gv.isobar_offsets(shifted, raw)
        assert res["ok"], res
        assert res["p95_abs_offset_hpa"] > gv.ISO_P95_TOL_HPA, res
        assert gv.isobar_gate(res) is not None, res

        # And the field rolled ONE column east is caught too.
        n_rows, n_cols = field.shape
        rolled = np.roll(field, 1, axis=1)
        raw_rolled = raw_from(rolled, lats, lons)
        res = gv.isobar_offsets(items, raw_rolled)
        assert res["ok"], res
        assert res["p95_abs_offset_hpa"] > gv.ISO_P95_TOL_HPA, res
        assert gv.isobar_gate(res) is not None, res

    def test_a_wrongly_smoothed_field_is_caught(self, fine):
        """The blur is part of the field: a contour is a contour of the
        SMOOTHED field, so checking it against a differently blurred
        field has to show."""
        from scipy.ndimage import gaussian_filter

        field, lats, lons, lines = fine
        # The field the worker blurs once, and the same field blurred
        # TWICE as hard — a genuinely different field.
        once = isobars.smooth_field(field, 0.5)
        twice = gaussian_filter(field, sigma=4.0, mode=("nearest", "wrap"))
        assert not np.array_equal(once, twice)

        # Rebuild the raw message with the doubly-blurred field and the
        # check has to notice.
        res = gv.isobar_offsets(stored_items(lines), raw_from(twice, lats, lons))
        assert res["ok"], res
        assert res["p95_abs_offset_hpa"] > gv.ISO_P95_TOL_HPA, res
        assert gv.isobar_gate(res) is not None, res


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
