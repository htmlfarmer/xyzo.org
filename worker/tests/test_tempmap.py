"""Tests for worker/tempmap.py — the temperature overlay's data contract.

Pure functions only: no network, no DB. What is pinned here is the
°F/°C arithmetic the legend and probe depend on, the grid layout the
browser reads, and the verify() gate that must never be bypassed (a
field that decodes in the wrong latitude order still looks like a
plausible temperature map).
"""
from __future__ import annotations

import json
import math
import os
import tempfile

import pytest

np = pytest.importorskip("numpy")

from worker import tempmap  # noqa: E402


# ── the unit conversion ─────────────────────────────────────────────────
class TestFahrenheit:
    def test_known_points(self):
        assert tempmap.f_of(0.0) == pytest.approx(32.0)
        assert tempmap.f_of(100.0) == pytest.approx(212.0)
        assert tempmap.f_of(-40.0) == pytest.approx(-40.0)  # the crossover

    def test_every_tick_carries_both_scales(self):
        # The legend shows °C and °F on the same bar; they must agree.
        for tick in tempmap.ticks_for_range(-40, 40):
            assert tempmap.f_of(tick) == pytest.approx(
                round(tempmap.f_of(tick), 1)
            )
        # -40 C and -40 F are the same temperature — a classic trap.
        assert tempmap.f_of(-40) == -40


# ── the adaptive ramp ──────────────────────────────────────────────────
class TestChooseRange:
    def _field(self, lo, hi, n=400):
        """A field whose values run evenly from lo to hi."""
        vals = np.linspace(lo, hi, n)
        return np.tile(vals, (10, 1))

    def test_range_follows_the_field(self):
        lo, hi = tempmap.choose_range(self._field(-50, 40))
        assert (lo, hi) == (-50.0, 40.0)

    def test_ends_are_whole_tens(self):
        for grid in (self._field(-37.3, 28.9), self._field(-9, 61.4)):
            lo, hi = tempmap.choose_range(grid)
            assert lo % 10 == 0 and hi % 10 == 0, (lo, hi)

    def test_a_narrow_field_is_widened(self):
        # Otherwise a calm week would saturate the whole map.
        lo, hi = tempmap.choose_range(self._field(18, 24))
        assert hi - lo >= tempmap.RANGE_MIN_SPAN_C

    def test_a_wide_field_is_narrowed(self):
        # Otherwise the mid-latitudes collapse into one colour — the
        # exact problem with the old fixed -80..50 bar.
        lo, hi = tempmap.choose_range(self._field(-95, 60))
        assert hi - lo <= tempmap.RANGE_MAX_SPAN_C

    def test_the_span_is_wider_than_a_fixed_bar_covers(self):
        # A fixed -80..50 bar spends 130 C on a field that is only
        # ~93 C wide; the adaptive range must be tighter than that.
        lo, hi = tempmap.choose_range(self._field(-52, 41))
        assert hi - lo < 130


class TestTicks:
    def test_whole_tens_only(self):
        for t in tempmap.ticks_for_range(-40, 40):
            assert t % 10 == 0

    def test_the_ends_are_always_labelled(self):
        assert -40 in tempmap.ticks_for_range(-40, 40)
        assert 40 in tempmap.ticks_for_range(-40, 40)

    def test_the_interior_is_evenly_spaced(self):
        # Anchored at the low end and stepped by 20 C, so the ticks land
        # at the same fraction of the bar as the temperatures they name.
        assert tempmap.ticks_for_range(-40, 40) == [-40, -20, 0, 20, 40]
        assert tempmap.ticks_for_range(-50, 30) == [-50, -30, -10, 10, 30]
        assert tempmap.ticks_for_range(-60, 40) == [-60, -40, -20, 0, 20, 40]

    def test_a_narrow_range_uses_tight_steps(self):
        assert tempmap.ticks_for_range(-20, 20) == [-20, -10, 0, 10, 20]


class TestRamp:
    def test_stops_are_fractions_of_the_range(self):
        # Defined as fractions, converted to degrees per run, so the
        # same colour sequence is used whatever the range turns out to
        # be — and the ends are always the extreme colours.
        fracs = [f for f, _ in tempmap.RAMP_STOPS]
        assert fracs == sorted(fracs)
        assert fracs[0] == 0.0 and fracs[-1] == 1.0

    def test_every_stop_has_a_colour(self):
        for frac, rgb in tempmap.RAMP_STOPS:
            assert rgb.startswith("#") and len(rgb) == 7, (frac, rgb)

    def test_the_ends_are_unmistakable(self):
        # Coldest = near-black purple, hottest = near-black red, so a
        # saturated extreme still reads as an extreme.
        assert tempmap.RAMP_STOPS[0][1] < "#303030"
        assert tempmap.RAMP_STOPS[-1][1] >= "#300000"

    def test_the_middle_is_green(self):
        # A warm day must never look cold.
        mid = min(tempmap.RAMP_STOPS, key=lambda s: abs(s[0] - 0.57))
        r, g, bl = int(mid[1][1:3], 16), int(mid[1][3:5], 16), int(mid[1][5:7], 16)
        assert g > r and g > bl

    def test_converted_stops_spread_over_the_whole_range(self):
        lo, hi = -40, 40
        span = hi - lo
        stops = [lo + f * span for f, _ in tempmap.RAMP_STOPS]
        assert stops[0] == lo and stops[-1] == hi
        # The colours must be spread across the range, not bunched at one
        # end — that is what makes neighbouring temperatures differ.
        quarter = [s for s in stops if lo <= s <= lo + span / 4]
        assert len(quarter) >= 4, quarter


# ── the grid the browser reads ──────────────────────────────────────────
class TestWriteGrid:
    def _roundtrip(self, grid):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "grid.bin")
            tempmap.write_grid(grid, np.linspace(-90, 90, grid.shape[0]),
                                np.linspace(0, 360, grid.shape[1], endpoint=False),
                                path)
            back = np.fromfile(path, dtype="<i2")
            return back, back.reshape(grid.shape)

    def test_values_are_tenths_of_a_degree(self):
        # Rounding is to nearest (numpy's rint), so use values that do
        # not sit on a half-tenth — those are a coin toss either way.
        grid = np.array([[-40.0, 0.0], [23.5, 41.26]])
        back, _ = self._roundtrip(grid)
        assert back.tolist() == [-400, 0, 235, 413]

    def test_row_zero_is_the_southernmost_latitude(self):
        # The frontend indexes row 0 as lat_min and walks northwards;
        # storing it south-to-north is what makes the probe agree with
        # the painted colour.
        grid = np.array([[-90.0, -90.0], [90.0, 90.0]])
        _, reshaped = self._roundtrip(grid)
        assert reshaped[0][0] == -900
        assert reshaped[1][0] == 900

    def test_out_of_int16_range_is_refused(self):
        with pytest.raises(SystemExit):
            tempmap.write_grid(np.array([[7000.0]]), np.array([0.0]),
                               np.array([0.0]), "/tmp/should-not-exist.bin")


# ── verify() ────────────────────────────────────────────────────────────
class TestVerify:
    def _axes(self, n=61):
        lats = np.linspace(-90, 90, n)
        lons = np.linspace(0, 360, n, endpoint=False)
        return lats, lons

    def test_a_realistic_field_is_accepted(self):
        lats, lons = self._axes()
        # Warm at the equator, cold at the poles — a real temperature field.
        field = 30.0 - 0.75 * np.abs(lats)[:, None] * np.ones((1, len(lons)))
        tempmap.verify(field, lats, lons)  # must not raise

    def test_a_field_that_is_cold_at_the_equator_is_refused(self):
        lats, lons = self._axes()
        field = -40.0 + 0.5 * np.abs(lats)[:, None] * np.ones((1, len(lons)))
        with pytest.raises(SystemExit, match="equator"):
            tempmap.verify(field, lats, lons)

    def test_a_field_with_an_impossible_range_is_refused(self):
        lats, lons = self._axes()
        field = np.full((len(lats), len(lons)), 400.0)  # 400 C air
        with pytest.raises(SystemExit, match="implausible"):
            tempmap.verify(field, lats, lons)

    def test_a_shape_that_does_not_match_the_axes_is_refused(self):
        lats, lons = self._axes()
        field = np.zeros((10, 10))
        with pytest.raises(SystemExit, match="shape"):
            tempmap.verify(field, lats, lons)

    def test_poles_that_are_warm_are_refused(self):
        lats, lons = self._axes()
        field = np.full((len(lats), len(lons)), 35.0)
        with pytest.raises(SystemExit):
            tempmap.verify(field, lats, lons)


# ── the published meta.json ─────────────────────────────────────────────
class TestMeta:
    def test_the_built_file_is_well_formed(self):
        path = os.path.join(tempmap.OUT_DIR, "meta.json")
        if not os.path.exists(path):
            pytest.skip("overlay has not been built on this host")
        meta = json.load(open(path))
        assert meta["source"] == "NOAA NCEP GFS"
        assert meta["grid"]["file"] == "grid.bin"
        assert meta["grid"]["scale"] == 10
        # Both scales are published, and they agree.
        for tick in meta["ticks"]:
            assert tick["f"] == pytest.approx(tick["c"] * 9 / 5 + 32, abs=0.6)
        assert meta["ramp"][0]["c"] <= meta["range_c"][0]
        # No tile pyramid — see temp-layer.js.
        assert "tiles" not in meta


# ── the 15-minute poll's skip path ─────────────────────────────────────
class TestNoOpProductGuard:
    """The no-op is only real if BOTH halves can match.

    `write_meta` publishes the product PREFIXED (`"product":
    f"gfs.{product}"`), so meta.json holds `gfs.0p25` — while the guard
    compared the bare `PRODUCT` (`"0p25"`). The run_time half matched
    and the product half could never match, so the skip path was dead
    code: measured on 2026-11-06, after the poll went from 6 h to 15
    min, two consecutive ticks (23:29, 23:44) BOTH fetched the GRIB
    (873 KB), decoded, verified and rewrote grid.bin for a cycle that
    had not moved, and `journalctl` held **zero** "already published"
    lines.
    """

    def test_write_meta_publishes_the_string_the_guard_compares(self):
        from datetime import datetime, timezone

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "meta.json")
            grid = np.linspace(-5.0, 35.0, 50).reshape(5, 10)
            lats = np.linspace(10.0, 12.0, 5)
            lons = np.linspace(0.0, 9.0, 10)
            tempmap.write_meta(
                grid, lats, lons,
                datetime(2026, 11, 7, 0, 0, tzinfo=timezone.utc),
                tempmap.PRODUCT, path,
            )
            with open(path) as fh:
                published = json.load(fh)["product"]

        # the round trip: what lands in meta.json IS what the guard tests
        assert published == tempmap.PUBLISHED_PRODUCT
        assert published == tempmap.published_product(tempmap.PRODUCT)
        # and it is genuinely prefixed — this is the whole trap
        assert published == "gfs.0p25"
        assert tempmap.PRODUCT == "0p25"
        assert published != tempmap.PRODUCT

    def test_the_guard_uses_it_not_the_bare_constant(self):
        # Assert on the SOURCE: the guard only runs on a tick with the
        # network up, so a behavioural test would need to fetch.
        from pathlib import Path

        src = Path(tempmap.__file__).read_text()
        assert "current_product() == PUBLISHED_PRODUCT" in src
        # the bare comparison must be gone from both guard sites
        assert "current_product() == PRODUCT\n" not in src
        assert src.count("current_product() == PUBLISHED_PRODUCT") == 2
        # and the writer takes the format from the same place
        assert '"product": published_product(product)' in src
