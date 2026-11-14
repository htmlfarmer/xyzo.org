"""Tests for worker/magmap.py — the magnetic overlay's data contract.

Pure functions and the vendored model: no network, no DB. What is pinned
here is the NOAA test-value gate (the synthesis must reproduce NCEI's
published numbers), the coefficient parser, the branch-cut-free isogonic
contouring trick, the Int16 encoding the browser reads, and the
relationship checks that catch an axis swap the sparse test points miss.
"""
from __future__ import annotations

import json
import math
import os

import pytest

np = pytest.importorskip("numpy")

from worker import magmap  # noqa: E402


# ── the coefficient file ────────────────────────────────────────────────
class TestReadCof:
    def test_vendored_file_parses(self):
        epoch, model, release, coeffs = magmap.read_cof()
        assert epoch == 2025.0
        assert "WMM-2025" in model
        # 90 coefficients for degree/order 12: sum_{n=1..12} (n+1).
        assert len(coeffs) == 90
        assert max(n for n, _m, *_ in coeffs) == 12

    def test_every_record_is_well_formed(self):
        _epoch, _model, _release, coeffs = magmap.read_cof()
        for n, m, g, h, gdot, hdot in coeffs:
            assert 1 <= n <= 12
            assert 0 <= m <= n
            assert all(math.isfinite(v) for v in (g, h, gdot, hdot))

    def test_m_zero_has_no_h(self):
        # h(n, 0) is identically zero in the WMM (no axial sine term).
        _epoch, _model, _release, coeffs = magmap.read_cof()
        for n, m, _g, h, _gd, hd in coeffs:
            if m == 0:
                assert h == 0.0
                assert hd == 0.0


# ── the model against NOAA's published test values ─────────────────────
class TestVerifyGate:
    def test_the_gate_passes_on_the_vendored_model(self):
        # This is the whole point: the synthesis must reproduce numbers
        # computed by somebody else (NCEI) to within their published
        # precision. A sign flip, a transposed index or a missing
        # Schmidt factor fails here, not in production.
        model = magmap.WMMModel()
        magmap.verify(model)  # must not raise

    def test_test_values_file_is_present_and_sized(self):
        rows = magmap.parse_test_values()
        assert len(rows) >= 90  # the file ships ~100 points
        # The file spans dates and altitudes, including polar points near
        # the dip poles where H is small.
        times = {r["time"] for r in rows}
        assert len(times) >= 2
        assert any(r["lat"] >= 80 for r in rows)
        assert any(r["lat"] <= -50 for r in rows)
        assert any(r["alt"] > 0 for r in rows)

    def test_a_single_point_matches_to_test_precision(self):
        # The first row of the NOAA table: 2025.0, alt 28 km, lat 89,
        # lon -121. D is quoted to 2 decimals; our float64 synthesis
        # lands within half of that everywhere.
        model = magmap.WMMModel()
        row = magmap.parse_test_values()[0]
        els = model.elements(
            np.array([row["lat"]]), np.array([row["lon"]]),
            row["time"] - model.epoch, alt_km=row["alt"],
        )
        err_d = abs(float(els["d"][0, 0]) - row["d"])
        err_d = min(err_d, 360.0 - err_d)  # angle wrap
        assert err_d <= magmap.TEST_D_TOL_DEG
        assert abs(float(els["i"][0, 0]) - row["i"]) <= magmap.TEST_I_TOL_DEG
        # X/Y/Z to under a nanotesla: the test file quotes 0.1 nT and
        # the arithmetic is exact in float64.
        assert abs(float(els["x"][0, 0]) - row["x"]) <= magmap.TEST_XYZ_TOL_NT

    def test_secular_variation_is_the_analytic_rate(self):
        # The published dD/dt is the chain-rule derivative, NOT a
        # one-year forward difference: near the dip poles D curves fast
        # and the two disagree by ~0.1 deg/yr, which is exactly the
        # error that failed before this was fixed.
        model = magmap.WMMModel()
        row = magmap.parse_test_values()[0]  # lat 89, deep in the curve
        els = model.elements(
            np.array([row["lat"]]), np.array([row["lon"]]),
            row["time"] - model.epoch, alt_km=row["alt"],
        )
        assert abs(float(els["ddot"][0, 0]) - row["ddot"]) <= 0.001
        assert abs(float(els["idot"][0, 0]) - row["idot"]) <= 0.001


# ── the grid the browser reads ──────────────────────────────────────────
class TestEncodePlane:
    def test_scale_is_hundredths(self):
        # D/I in 0.01 deg, SV in 0.01 arcmin/yr — one SCALE for all.
        assert magmap.SCALE == 100
        data = magmap.encode_plane(np.array([[1.23, -4.56]]))
        back = np.frombuffer(data, dtype="<i2")
        assert back.tolist() == [123, -456]

    def test_row_zero_is_the_southernmost_latitude(self):
        data = magmap.encode_plane(np.array([[-90.0], [90.0]]))
        back = np.frombuffer(data, dtype="<i2")
        assert back[0] == -9000
        assert back[1] == 9000

    def test_out_of_int16_is_clamped_not_wrapped(self):
        # A wild value must saturate, never wrap to the opposite sign.
        data = magmap.encode_plane(np.array([[1e9]]))
        back = np.frombuffer(data, dtype="<i2")
        assert back[0] == np.iinfo(np.int16).max


class TestGridAxes:
    def test_longitudes_follow_the_gfs_convention(self):
        # 0..359, NOT -180..179: the torus-window arithmetic in
        # contour_scalar assumes the isobar pipeline's convention, and
        # with -180 origin every contoured line came out shifted 180
        # degrees (shipped lines sampled S = 5000+ nT instead of ~0).
        lats, lons = magmap.grid_axes()
        assert lons[0] == 0.0
        assert lons[-1] == 359.0
        assert len(lons) == 360
        assert len(lats) == 181
        assert lats[0] == -90.0 and lats[-1] == 90.0


# ── isogonic contouring through X and Y ────────────────────────────────
class TestIsogonicTrick:
    def _field(self):
        """A synthetic dipole-ish field with a known declination."""
        lats, lons = magmap.grid_axes()
        lon2d = np.broadcast_to(lons[None, :], (len(lats), len(lons)))
        # Declination that varies with longitude only: D = lon - 180.
        d = ((lon2d + 180.0) % 360.0) - 180.0
        h = np.full_like(d, 30000.0)
        x = h * np.cos(np.radians(d))
        y = h * np.sin(np.radians(d))
        return {
            "x": x, "y": y, "d": d, "h": h,
            "lats": lats, "lons": lons,
            "mask": np.zeros_like(d, dtype=bool),
        }

    def test_s_l_is_the_perpendicular_component(self):
        f = self._field()
        L = 30.0
        rad = math.radians(L)
        s = f["y"] * math.cos(rad) - f["x"] * math.sin(rad)
        # On the whole grid S = H sin(D - L) by construction.
        expect = f["h"] * np.sin(np.radians(f["d"] - L))
        assert np.allclose(s, expect, atol=1e-6)

    def test_p_l_sign_tells_the_branches_apart(self):
        f = self._field()
        L = 0.0
        p = f["x"] * math.cos(0) + f["y"] * math.sin(0)  # = X
        # Where D ~ 0 (X > 0) P > 0; where D ~ +/-180 (X < 0) P < 0.
        assert p[f["d"] == 0.0][0] > 0
        near_180 = p[np.abs(np.abs(f["d"]) - 180.0) < 1e-9]
        assert near_180.size > 0
        assert (near_180 < 0).all()


# ── the published artefacts ─────────────────────────────────────────────
class TestPublishedMeta:
    def _meta(self):
        path = os.path.join(magmap.OUT_DIR, "meta.json")
        if not os.path.exists(path):
            pytest.skip("overlay has not been built on this host")
        return json.load(open(path))

    def test_the_built_file_is_well_formed(self):
        meta = self._meta()
        assert meta["model"] == "WMM-2025"
        assert meta["epoch"] == 2025.0
        assert meta["license"].lower().startswith("us government")
        assert meta["grid"]["scale"] == 100
        assert meta["grid"]["rows"] == 181
        assert meta["grid"]["cols"] == 360
        # Longitudes start at 0 (the GFS/torus convention).
        assert meta["grid"]["lon_min"] == 0.0
        # Four planes + a mask + THREE line sets.
        for key in ("d", "i", "ddot", "idot"):
            assert meta["fields"][key]["file"].endswith(".bin")
        assert meta["contours"]["isogonics"] == "isogonics.geojson"
        assert meta["contours"]["isoclinics"] == "isoclinics.geojson"
        assert meta["contours"]["isoporics"] == "isoporics.geojson"
        assert meta["contours"]["major_interval_deg"] == magmap.ISO_MAJOR_DEG
        assert meta["contours"]["minor_interval_deg"] == magmap.ISO_MINOR_DEG
        assert meta["blackout_nt"] == 2000.0

    def test_all_four_diverging_ramps_sweep_cool_to_warm_around_cyan(self):
        # 2026-10-30: the ramp was redesigned TWICE after looking at the
        # rendered field rather than at swatches. First it was blue →
        # neon green → red with a green-tint shoulder on EACH side of the
        # plateau ("green on both sides of zero", and the ΔD wash — whose
        # plateau covered most of the globe — looked like a green ball).
        # The first fix used an ice-white centre, which came out *washed
        # out*: half the map sits inside the plateau, and a pastel over
        # half a map has no colour in it. The contract now: cool =
        # negative, warm = positive, a SATURATED cyan glow at zero, not
        # one stop on the ramp green-dominant, and a plateau narrow
        # enough that the gradient shows.
        meta = self._meta()
        # span is in the PLANNED unit: deg for D/I, arcmin/yr for SV.
        for key, span, plateau in (("d", 180.0, 6.0), ("i", 90.0, 3.0),
                                   ("ddot", 120.0, 4.0), ("idot", 30.0, 2.0)):
            ramp = meta["fields"][key]["ramp"]
            assert ramp[0]["c"] == -span, (key, ramp[0])
            assert ramp[-1]["c"] == span, (key, ramp[-1])
            # Stops must ascend — an out-of-order ramp silently
            # miscolours the wash (the Idot plateau once landed outside
            # its wing stop).
            stops = [r["c"] for r in ramp]
            assert stops == sorted(stops), key

            def rgb(hexstr):
                return (int(hexstr[1:3], 16), int(hexstr[3:5], 16),
                        int(hexstr[5:7], 16))

            # The plateau at ±plateau is the CYAN glow: full blue channel
            # and a near-full green — bright enough to read as a light
            # source on a dark basemap, saturated enough to still be a
            # colour (which the ice-white first attempt was not).
            plateau_stops = [r for r in ramp if abs(abs(r["c"]) - plateau) < 1e-9]
            assert len(plateau_stops) == 2, (key, ramp)
            for ps in plateau_stops:
                r, g, b = rgb(ps["rgb"])
                assert b >= 250 and g >= 200, (key, ps)
                assert r <= 40, (key, ps)
                assert ps["rgb"].lower() == "#00e5ff", (key, ps)

            # NO stop is green-dominant anywhere on the ramp.
            for st in ramp:
                r, g, b = rgb(st["rgb"])
                assert not (g > r and g > b), (key, st)
                assert st["rgb"].lower() != "#39ff14", (key, st)

            # The wings stay saturated, so wing → centre is a HUE change
            # and not merely a tint of the same pale colour: the azure
            # stop at −0.2·span must be clearly deeper than the centre.
            assert ramp[2]["rgb"].lower() == "#0072ff", (key, ramp[2])

            # Negative end is blue-dominant, positive end red-dominant.
            rn, _gn, bn = rgb(ramp[0]["rgb"])
            rp, _gp, bp = rgb(ramp[-1]["rgb"])
            assert bn > rn, (key, ramp[0])
            assert rp > bp, (key, ramp[-1])

    def test_alpha_tables_let_the_basemap_breathe_at_zero(self):
        # 2026-10-31: the wash baked alpha=255 everywhere, so the cyan
        # zero plateau — ~52 % of the globe for ΔD — painted an opaque
        # sheet over the basemap. Each field now publishes its own
        # {t, a} alpha table (the contract the lightning meta uses):
        # nearly clear at "nothing happening", solid where the signal
        # is. A client that ignores the table gets the old opaque wash,
        # so a MISSING table is a silent regression — hence the gate.
        meta = self._meta()
        for key, fm in meta["fields"].items():
            alpha = fm.get("alpha")
            assert alpha, key
            ts = [s["t"] for s in alpha]
            assert ts == sorted(ts), (key, ts)
            assert ts[0] >= 0 and ts[-1] <= 1, (key, ts)
            for s in alpha:
                assert 0 <= s["a"] <= 255, (key, s)
            spec = magmap.RAMP_SPEC[key]
            if spec["kind"] == "diverging":
                # The zero core must be nearly clear and the wings solid.
                core = min(alpha, key=lambda s: abs(s["t"] - 0.5))
                assert core["a"] < 80, (key, core)
                assert alpha[0]["a"] >= 200 and alpha[-1]["a"] >= 200, (key, alpha[0])
                # The transparent band is derived from the SAME plateau
                # the colour uses, so the see-through core and the flat
                # cyan band are the same width: the low shoulder sits AT
                # the plateau edge (t = 0.5 ± plateau/(2·span)), and the
                # climb to a solid wash happens further out — a flat
                # opaque band inside the clear one would show as a
                # coloured ring around a hole.
                plateau_t = spec["plateau"] / (2.0 * spec["span"])
                edge = min(
                    alpha, key=lambda s: abs(s["t"] - (0.5 + plateau_t)))
                assert edge["a"] <= core["a"] + 24, (key, edge, core)
                # ...and by 0.1 along the ramp it is well on its way up.
                outer = min(
                    alpha, key=lambda s: abs(s["t"] - (0.5 + 0.1)))
                assert outer["a"] >= core["a"] + 100, (key, outer, core)
            else:
                # A magnitude: ghost at the weak end, solid at the strong.
                assert alpha[0]["a"] < 80, (key, alpha[0])
                assert alpha[-1]["a"] >= 200, (key, alpha[-1])
                assert alpha[-1]["a"] > alpha[0]["a"] + 100, (key, alpha)

    def test_the_alpha_gate_rejects_an_opaque_core(self):
        # The gate itself must be able to fail — a check that cannot
        # fire is worse than no check.
        bad = {
            "d": {"alpha": [
                {"t": 0.0, "a": 255}, {"t": 0.5, "a": 255}, {"t": 1.0, "a": 255}]},
        }
        try:
            magmap.check_alpha_tables(bad)
        except SystemExit:
            pass
        else:
            raise AssertionError("an all-opaque alpha table passed the gate")

    def test_the_line_sets_carry_the_whole_circle(self):
        gdir = magmap.OUT_DIR
        iso = json.load(open(os.path.join(gdir, "isogonics.geojson")))
        levels = {f["properties"]["level"] for f in iso["features"]}
        # Every 10-degree INDEX step around the full circle must be
        # present — the P<0 half used to be dropped, deleting the
        # +/-100..180 family that circles each magnetic pole.
        for lvl in range(-180, 180, 10):
            assert float(lvl) in levels, lvl
        # Intermediate (minor) contours fill between them at 2° spacing.
        for lvl in range(-178, 180, 2):
            if lvl % 10 == 0:
                continue
            assert float(lvl) in levels, lvl
        # The agonic line is flagged and tagged as an index contour.
        specials = {f["properties"]["special"] for f in iso["features"] if f["properties"]["special"]}
        assert specials == {"agonic"}
        for f in iso["features"]:
            p = f["properties"]
            assert p["major"] is (abs(p["level"] % 10) < 1e-9), p

        icl = json.load(open(os.path.join(gdir, "isoclinics.geojson")))
        ilevels = {f["properties"]["level"] for f in icl["features"]}
        for lvl in range(-80, 81, 10):
            assert float(lvl) in ilevels, lvl
        ispecials = {f["properties"]["special"] for f in icl["features"] if f["properties"]["special"]}
        assert ispecials == {"aclinic"}

        # Isoporics: equal annual change of declination, every 0.25 °/yr,
        # with the "no change" line flagged like the agonic.
        iso_sv = json.load(open(os.path.join(gdir, "isoporics.geojson")))
        sv_levels = {f["properties"]["level"] for f in iso_sv["features"]}
        assert 0.0 in sv_levels
        for lvl in (-1.5, -1.0, -0.5, 0.5, 1.0, 1.5):
            assert any(abs(s - lvl) < 1e-9 for s in sv_levels), lvl
        sv_specials = {
            f["properties"]["special"]
            for f in iso_sv["features"] if f["properties"]["special"]
        }
        assert sv_specials == {"nochange"}
        # Index contours are the whole-degree levels.
        for f in iso_sv["features"]:
            p = f["properties"]
            expect_major = abs(p["level"] - round(p["level"])) < 1e-9
            assert p["major"] is expect_major, p

    def test_the_grid_planes_match_the_meta_shape(self):
        meta = self._meta()
        g = meta["grid"]
        expect = g["rows"] * g["cols"]
        for key in ("d", "i", "ddot", "idot"):
            path = os.path.join(magmap.OUT_DIR, meta["fields"][key]["file"])
            data = np.fromfile(path, dtype="<i2")
            assert data.size == expect, key
        mask = np.fromfile(os.path.join(magmap.OUT_DIR, meta["mask"]), dtype=np.uint8)
        assert mask.size == expect
        # The blackout caps must actually be marked.
        assert 0.0005 < mask.mean() < 0.05


# ── the annual-change definition ───────────────────────────────────────
class TestAnnualChange:
    def test_it_is_not_a_forward_difference(self):
        # Pin the definition itself: D(t+1) - D(t) disagrees with the
        # analytic rate by ~0.1 deg/yr near the dip poles (D curves
        # fast there). The worker publishes the analytic rate, which is
        # what NOAA's test file quotes.
        model = magmap.WMMModel()
        row = magmap.parse_test_values()[0]  # lat 89, the worst case
        lats = np.array([row["lat"]])
        lons = np.array([row["lon"]])
        dt = row["time"] - model.epoch
        els = model.elements(lats, lons, dt, alt_km=row["alt"])
        ahead = model.elements(lats, lons, dt + 1.0, alt_km=row["alt"])
        fwd = float(ahead["d"][0, 0] - els["d"][0, 0])
        fwd = (fwd + 180.0) % 360.0 - 180.0
        analytic = float(els["ddot"][0, 0])
        # They are close but NOT equal — the whole reason the forward
        # difference failed the test gate.
        assert abs(fwd - row["ddot"]) > 0.01
        assert abs(analytic - row["ddot"]) <= 0.001


# ── the pure contour helpers ───────────────────────────────────────────
class TestSplitAtMask:
    def test_a_line_outside_the_mask_passes_through(self):
        line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
        out = magmap.split_at_mask(line, lambda lo, la: False)
        assert out == [line]

    def test_a_fully_masked_line_is_dropped(self):
        line = [(0.0, 0.0), (1.0, 0.0)]
        out = magmap.split_at_mask(line, lambda lo, la: True)
        assert out == []

    def test_the_line_is_cut_at_the_mask_edge(self):
        # The chart blanks the blackout circle and the line stops at its
        # edge — it must be CUT, not dropped wholesale, or a long
        # isogonic that merely clips the cap disappears entirely.
        line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (4.0, 0.0)]
        out = magmap.split_at_mask(line, lambda lo, la: 1.5 <= lo <= 2.5)
        assert len(out) == 2
        assert out[0] == [(0.0, 0.0), (1.0, 0.0)]
        assert out[1] == [(3.0, 0.0), (4.0, 0.0)]

    def test_a_fragment_shorter_than_the_minimum_is_dropped(self):
        # A single leftover vertex is not a line.
        line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
        out = magmap.split_at_mask(line, lambda lo, la: lo >= 1.0)
        assert out == [[(0.0, 0.0)]] or out == []
        # With MIN_LINE_POINTS = 2 a 1-point run must not survive.
        assert all(len(piece) >= magmap.MIN_LINE_POINTS for piece in out)


class TestMergeLines:
    def test_two_abutting_pieces_become_one(self):
        a = [(0.0, 0.0), (1.0, 0.0)]
        b = [(1.0, 0.0), (2.0, 0.0)]
        merged = magmap.merge_lines([(10.0, a), (10.0, b)])
        assert len(merged) == 1
        level, pts = merged[0]
        assert level == 10.0
        assert len(pts) >= 2

    def test_different_levels_never_merge(self):
        a = [(0.0, 0.0), (1.0, 0.0)]
        b = [(1.0, 0.0), (2.0, 0.0)]
        merged = magmap.merge_lines([(10.0, a), (20.0, b)])
        assert len(merged) == 2

    def test_distant_pieces_stay_apart(self):
        # Pieces that are not near each other are separate lines, even
        # at the same level — joining them would teleport the line.
        a = [(0.0, 0.0), (1.0, 0.0)]
        b = [(50.0, 0.0), (51.0, 0.0)]
        merged = magmap.merge_lines([(0.0, a), (0.0, b)])
        assert len(merged) == 2

    def test_float_levels_are_supported(self):
        # This field contours at float levels (every 10 deg), unlike the
        # isobar pipeline's integer hPa keys.
        a = [(0.0, 0.0), (1.0, 0.0)]
        merged = magmap.merge_lines([(-70.0, a)])
        assert merged[0][0] == -70.0


class TestFilterShortChains:
    def test_a_short_lone_speck_is_dropped(self):
        speck = [(0.0, 0.0), (0.1, 0.0)]
        assert magmap.filter_short_chains([speck]) == []

    def test_a_long_line_survives(self):
        line = [(float(i), 0.0) for i in range(10)]
        assert magmap.filter_short_chains([line]) == [line]

    def test_a_short_bridging_piece_survives(self):
        # A short piece with two neighbours bridges a break in a line
        # and must stay — dropping it opens a visible gap.
        short = [(5.0, 0.0), (5.2, 0.0)]
        left = [(0.0, 0.0), (5.0, 0.0)]
        right = [(5.2, 0.0), (10.0, 0.0)]
        kept = magmap.filter_short_chains([left, short, right])
        assert short in kept


class TestChaikinAndSimplify:
    def test_chaikin_never_overshoots(self):
        # Corner-cutting stays on the convex side of the original line,
        # so the contour never crosses to the wrong side of the level.
        line = [(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)]
        smooth = magmap.chaikin_smooth(line, iterations=1)
        assert len(smooth) > len(line)
        # The smoothed line's vertices stay within the original's bounds.
        for x, y in smooth:
            assert -0.01 <= x <= 2.01
            assert -0.01 <= y <= 1.01

    def test_simplify_keeps_the_endpoints(self):
        line = [(0.0, 0.0), (1.0, 0.001), (2.0, 0.0)]
        out = magmap.simplify(line, tolerance=0.05)
        assert (out[0] == (0.0, 0.0)).all()
        assert (out[-1] == (2.0, 0.0)).all()
        # The middle vertex is within tolerance of the chord — dropped.
        assert len(out) == 2


class TestClipToLonRange:
    def test_a_line_inside_the_window_passes(self):
        line = [(10.0, 0.0), (20.0, 0.0)]
        out = magmap.clip_to_lon_range(line, 0.0, 30.0)
        assert out == [line]

    def test_a_line_outside_is_dropped(self):
        line = [(40.0, 0.0), (50.0, 0.0)]
        assert magmap.clip_to_lon_range(line, 0.0, 30.0) == []

    def test_a_crossing_line_is_cut_at_the_edge(self):
        # The cut point is interpolated ONTO the boundary so the line
        # still ends exactly at the edge.
        line = [(10.0, 0.0), (40.0, 0.0)]
        out = magmap.clip_to_lon_range(line, 0.0, 30.0)
        assert len(out) == 1
        assert out[0][-1][0] == 30.0
        assert out[0][0] == (10.0, 0.0)


class TestLabels:
    def test_isogonic_labels(self):
        assert magmap.isogonic_label(0.0) == "Agonic"
        assert magmap.isogonic_label(10.0) == "10°E"
        assert magmap.isogonic_label(-30.0) == "30°W"
        assert magmap.isogonic_label(180.0) == "180°W" or magmap.isogonic_label(180.0) == "180°E"

    def test_isoclinic_labels(self):
        assert magmap.isoclinic_label(0.0) == "Aclinic"
        assert magmap.isoclinic_label(45.0) == "45°"
        assert magmap.isoclinic_label(-60.0) == "-60°"


class TestLinesToGeojson:
    def test_a_line_becomes_a_feature(self):
        lines = [(10.0, [(0.0, 0.0), (1.0, 1.0), (2.0, 0.5)])]
        fc = magmap.lines_to_geojson(lines, "isogonic", 10.0)
        assert fc["type"] == "FeatureCollection"
        assert len(fc["features"]) == 1
        feat = fc["features"][0]
        assert feat["geometry"]["type"] == "LineString"
        assert feat["properties"]["level"] == 10.0
        assert feat["properties"]["kind"] == "isogonic"
        assert feat["properties"]["label"] == "10°E"
        assert feat["properties"]["special"] is None

    def test_the_agonic_line_is_flagged(self):
        lines = [(0.0, [(0.0, 0.0), (1.0, 0.0)])]
        fc = magmap.lines_to_geojson(lines, "isogonic", 10.0)
        feat = fc["features"][0]
        assert feat["properties"]["special"] == "agonic"
        assert feat["properties"]["label"] == "Agonic"

    def test_the_aclinic_line_is_flagged(self):
        lines = [(0.0, [(0.0, 0.0), (1.0, 0.0)])]
        fc = magmap.lines_to_geojson(lines, "isoclinic", 10.0)
        feat = fc["features"][0]
        assert feat["properties"]["special"] == "aclinic"

    def test_coordinates_are_rounded_to_three_decimals(self):
        # ~100 m — far finer than the 0.03 deg simplification tolerance,
        # so no visible detail is lost, but the file stays small.
        lines = [(10.0, [(0.123456, 0.987654), (1.0, 1.0)])]
        fc = magmap.lines_to_geojson(lines, "isogonic", 10.0)
        lon, lat = fc["features"][0]["geometry"]["coordinates"][0]
        assert lon == 0.123
        assert lat == 0.988

    def test_a_too_short_line_is_skipped(self):
        lines = [(10.0, [(0.0, 0.0)])]
        fc = magmap.lines_to_geojson(lines, "isogonic", 10.0)
        assert fc["features"] == []


class TestDecimalYear:
    def test_new_years_day(self):
        from datetime import datetime, timezone
        y = magmap.decimal_year(datetime(2026, 1, 1, tzinfo=timezone.utc))
        assert y == pytest.approx(2026.0, abs=1e-6)

    def test_mid_year(self):
        from datetime import datetime, timezone
        y = magmap.decimal_year(datetime(2026, 7, 2, tzinfo=timezone.utc))
        assert y == pytest.approx(2026.5, abs=0.01)

    def test_it_lands_inside_the_model_life_span(self):
        # The gate in run() refuses a date outside epoch..epoch+5; the
        # default (now) must always be inside for the current model.
        y = magmap.decimal_year()
        model = magmap.WMMModel()
        assert model.epoch <= y <= model.epoch + 5.0


# ── the neon diverging ramp ────────────────────────────────────────────
class TestDivergingRamp:
    def test_stops_ascend_and_bracket_the_span(self):
        ramp = magmap.diverging_ramp(120.0, plateau=6.0)
        stops = [s["c"] for s in ramp]
        assert stops == sorted(stops)
        assert stops[0] == -120.0 and stops[-1] == 120.0

    def test_zero_glow_is_saturated_cyan_not_neon_green(self):
        ramp = magmap.diverging_ramp(180.0, plateau=6.0)
        # Two stops hold the flat CYAN plateau at ±plateau: zero has to
        # glow (it is the agonic / aclinic / no-change landmark) AND be
        # saturated, because the plateau covers half the map — a
        # near-white centre rendered as a washed-out pale sheet where the
        # old neon at least had colour.
        plateau_stops = [s for s in ramp if abs(abs(s["c"]) - 6.0) < 1e-9]
        assert len(plateau_stops) == 2
        for s in plateau_stops:
            assert s["rgb"] == "#00e5ff"

    def test_no_stop_on_the_ramp_is_green(self):
        # The whole point of the 2026-10-30 redesign.
        for span, plateau in ((180.0, 10.0), (120.0, 6.0), (30.0, 3.0),
                              (150.0, 20.0), (120.0, 20.0)):
            for s in magmap.diverging_ramp(span, plateau=plateau):
                r = int(s["rgb"][1:3], 16)
                g = int(s["rgb"][3:5], 16)
                b = int(s["rgb"][5:7], 16)
                assert not (g > r and g > b), (span, plateau, s)

    def test_a_narrow_field_still_produces_an_ordered_ramp(self):
        # Idot spans only ±30 arcmin/yr: the shoulder stop (plateau·2.5)
        # used to land OUTSIDE the wing stop (span·0.2) and had to be
        # rescued by the sort. The shoulder is now clamped to 15 % of the
        # span, so it is inside the wing by construction — the sort is
        # only a safety net, not what makes this true.
        ramp = magmap.diverging_ramp(30.0, plateau=3.0)
        stops = [s["c"] for s in ramp]
        assert stops == sorted(stops), stops
        shoulder = min(3.0 * 2.5, 30.0 * 0.15)
        wing = 30.0 * 0.2
        assert shoulder < wing, (shoulder, wing)
        assert -shoulder in stops and shoulder in stops

    def test_negative_end_is_blue_and_positive_end_is_red(self):
        ramp = magmap.diverging_ramp(90.0, plateau=5.0)
        rn, bn = int(ramp[0]["rgb"][1:3], 16), int(ramp[0]["rgb"][5:7], 16)
        rp, bp = int(ramp[-1]["rgb"][1:3], 16), int(ramp[-1]["rgb"][5:7], 16)
        assert bn > rn
        assert rp > bp


class TestIsoporicLabel:
    def test_zero_says_no_change(self):
        assert magmap.isoporic_label(0.0) == "No change"

    def test_rates_are_signed(self):
        assert magmap.isoporic_label(0.5) == "+0.5°/yr"
        assert magmap.isoporic_label(-1.25) == "−1.25°/yr"


class TestIndexLevel:
    def test_whole_degrees_are_index_levels(self):
        assert magmap._is_index_level(10.0, 10.0)
        assert magmap._is_index_level(-180.0, 10.0)
        assert magmap._is_index_level(0.0, 1.0)

    def test_intermediates_are_not(self):
        assert not magmap._is_index_level(2.0, 10.0)
        assert not magmap._is_index_level(0.25, 1.0)


class TestLinesToGeojsonMajorFlag:
    def test_index_and_intermediate_tags(self):
        lines = [
            (10.0, [(0.0, 0.0), (1.0, 1.0)]),
            (2.0, [(0.0, 0.0), (1.0, 1.0)]),
        ]
        fc = magmap.lines_to_geojson(lines, "isogonic", 10.0)
        by_level = {f["properties"]["level"]: f["properties"] for f in fc["features"]}
        assert by_level[10.0]["major"] is True
        assert by_level[2.0]["major"] is False

    def test_the_zero_isoporic_line_is_flagged_nochange(self):
        lines = [(0.0, [(0.0, 0.0), (1.0, 0.0)])]
        fc = magmap.lines_to_geojson(lines, "isoporic", 1.0)
        p = fc["features"][0]["properties"]
        assert p["special"] == "nochange"
        assert p["label"] == "No change"
        assert p["major"] is True


class TestContourScalarTolerance:
    def test_a_tighter_tolerance_keeps_more_vertices(self):
        # The isoporics pass simplify_tol=0.01 because Ddot's steeper
        # gradients turn the default 0.03° into a visible value error.
        # Pin that the knob actually does something: a synthetic field
        # with real curvature (a Gaussian bump) contoured at both
        # tolerances must retain more vertices at the tighter one.
        lats, lons = magmap.grid_axes()
        lon2d = np.broadcast_to(lons[None, :], (len(lats), len(lons)))
        lat2d = np.broadcast_to(lats[:, None], (len(lats), len(lons)))
        field = np.exp(-((lon2d - 180.0) ** 2 + (lat2d - 30.0) ** 2) / 400.0)
        loose = magmap.contour_scalar(field, lats, lons, 0.3)
        tight = magmap.contour_scalar(field, lats, lons, 0.3, simplify_tol=0.001)
        assert loose and tight
        assert sum(len(p) for p in tight) > sum(len(p) for p in loose)

    def test_the_default_matches_the_module_constant(self):
        import inspect
        sig = inspect.signature(magmap.contour_scalar)
        assert sig.parameters["simplify_tol"].default == magmap.SIMPLIFY_TOL_DEG


# ══════════════════════════════════════════════════════════════════════
# The four components × two modes added on top of the original D/I pair
# (F total force, H horizontal, and the annual change of all four).
# ══════════════════════════════════════════════════════════════════════
class TestComponentSet:
    def test_eight_fields_in_two_modes(self):
        # D, F, H, I each get a main field and a secular-variation rate.
        assert set(magmap.FIELD_ORDER) == {
            "d", "f", "h", "i", "ddot", "fdot", "hdot", "idot",
        }
        for key, spec in magmap.FIELDS_SPEC.items():
            assert spec["mode"] in ("main", "sv")
        assert {k for k in magmap.FIELD_ORDER
                if magmap.FIELDS_SPEC[k]["mode"] == "main"} == {"d", "f", "h", "i"}
        assert {k for k in magmap.FIELD_ORDER
                if magmap.FIELDS_SPEC[k]["mode"] == "sv"} == {"ddot", "fdot", "hdot", "idot"}

    def test_every_field_has_a_plane_a_line_set_and_a_ramp(self):
        for key in magmap.FIELD_ORDER:
            assert magmap.LINE_FILES[key].endswith(".geojson"), key
            assert magmap.RAMP_SPEC[key]["kind"] in ("diverging", "sequential"), key
            assert magmap.COMPONENT_OF[key] in ("d", "f", "h", "i"), key
            assert key in magmap.LINE_INTERVALS, key
            assert magmap.LABEL_STEP[key] > 0, key
            assert key in magmap.LINE_KINDS, key

    def test_the_blackout_mask_is_per_field(self):
        # ONLY declination and its rate are undefined where H collapses:
        # D = atan2(Y, X) has no answer at the dip pole and dD/dt divides
        # by H². F is at its strongest there, H is merely small, I runs
        # smoothly to ±90 — blanketing those would delete the poles from
        # exactly the charts that show them.
        assert magmap.FIELDS_SPEC["d"]["boz"] is True
        assert magmap.FIELDS_SPEC["ddot"]["boz"] is True
        for key in ("f", "h", "i", "fdot", "hdot", "idot"):
            assert magmap.FIELDS_SPEC[key]["boz"] is False, key

    def test_f_and_h_scales_fit_int16_but_the_angles_keep_scale_100(self):
        # One scale cannot serve a ±180° angle and a 67,000 nT magnitude.
        assert magmap.FIELDS_SPEC["d"]["scale"] == magmap.SCALE
        assert magmap.FIELDS_SPEC["i"]["scale"] == magmap.SCALE
        # F needs a DIVISOR: 67,000 nT at scale 1 would overflow Int16.
        assert magmap.FIELDS_SPEC["f"]["scale"] < 1.0
        assert 67000.0 * magmap.FIELDS_SPEC["f"]["scale"] < 32767
        assert 42000.0 * magmap.FIELDS_SPEC["h"]["scale"] < 32767


class TestMagnitudesAndTheirRates:
    def _elements(self):
        model = magmap.WMMModel()
        lats, lons = magmap.grid_axes()
        return model.elements(lats, lons, magmap.decimal_year() - model.epoch)

    def test_f_and_h_are_present_and_bounded(self):
        els = self._elements()
        f, h = els["f"], els["h"]
        # All four new keys exist and are finite.
        for key in ("f", "h", "fdot", "hdot"):
            assert key in els, key
            assert bool(np.isfinite(els[key]).all()), key
        # Earth's field is 20,000–70,000 nT; anything outside means a
        # unit slip (µT) or a broken rotation out of geodetic space.
        assert 15000.0 < f.min() < f.max() < 80000.0
        assert 0.0 <= h.min() and h.max() < 50000.0
        # H = F·cos(I) can never exceed F, and F = sqrt(H²+Z²) can
        # never be below |Z|. Both hold pointwise, so a swapped or
        # double-scaled plane fails immediately.
        assert bool((f >= h - 1e-6).all())
        assert bool((f >= np.abs(els["z"]) - 1e-6).all())

    def test_the_rates_are_bounded(self):
        els = self._elements()
        # Measured WMM2025: ΔF −126…+104, ΔH −106…+77 nT/yr. A rate
        # that blew up would mean the H in dH/dt did not cancel.
        assert float(np.abs(els["fdot"]).max()) < 500.0
        assert float(np.abs(els["hdot"]).max()) < 500.0

    def test_the_rates_match_noaa_pointwise(self):
        # NOAA's table quotes dF/dt and dH/dt to six decimals; the
        # analytic chain rule must reproduce them, not a forward
        # difference of the field.
        model = magmap.WMMModel()
        checked = 0
        for row in magmap.parse_test_values():
            if not (model.epoch <= row["time"] <= model.epoch + 5.0):
                continue
            els = model.elements(
                np.array([row["lat"]]), np.array([row["lon"]]),
                row["time"] - model.epoch, alt_km=row["alt"],
            )
            assert abs(float(els["f"][0, 0]) - row["f"]) <= magmap.TEST_XYZ_TOL_NT
            assert abs(float(els["h"][0, 0]) - row["h"]) <= magmap.TEST_XYZ_TOL_NT
            assert abs(float(els["fdot"][0, 0]) - row["fdot"]) <= magmap.TEST_SV_TOL_NT_YR
            assert abs(float(els["hdot"][0, 0]) - row["hdot"]) <= magmap.TEST_SV_TOL_NT_YR
            checked += 1
        assert checked >= 90


class TestSequentialRamp:
    def test_stops_ascend_and_bracket_the_range(self):
        ramp = magmap.sequential_ramp(22000.0, 67000.0)
        stops = [s["c"] for s in ramp]
        assert stops == sorted(stops)
        assert stops[0] == 22000.0
        assert stops[-1] == 67000.0

    def test_it_is_one_sided_not_diverging(self):
        # F and H are magnitudes: a diverging ramp would spend half the
        # spectrum on values that never occur and paint the low end in a
        # colour that means "negative".
        ramp = magmap.sequential_ramp(0.0, 42000.0)
        assert all(s["c"] >= 0.0 for s in ramp)
        # No neon-green plateau — that colour belongs to zero — and, after
        # the 2026-10-30 redesign, no green stop at all: the old
        # teal → lime → orange ramp put green across the middle of every
        # force chart, which is what the "not green" ask was about.
        for s in ramp:
            r = int(s["rgb"][1:3], 16)
            g = int(s["rgb"][3:5], 16)
            b = int(s["rgb"][5:7], 16)
            assert not (g > r and g > b), s
            assert s["rgb"].lower() != "#39ff14", s

    def test_low_end_is_blue_and_high_end_is_hot(self):
        ramp = magmap.sequential_ramp(22000.0, 67000.0)
        lo_r, lo_b = int(ramp[0]["rgb"][1:3], 16), int(ramp[0]["rgb"][5:7], 16)
        hi_r, hi_b = int(ramp[-1]["rgb"][1:3], 16), int(ramp[-1]["rgb"][5:7], 16)
        assert lo_b > lo_r          # weak field reads blue
        assert hi_r > hi_b          # strong field reads hot
        assert hi_r >= 200          # and bright enough to read at 55 % opacity

    def test_a_degenerate_range_does_not_divide_by_zero(self):
        ramp = magmap.sequential_ramp(5.0, 5.0)
        assert ramp[-1]["c"] > ramp[0]["c"]


class TestLevelsFor:
    def test_the_step_is_exact(self):
        # Built from integer multiples, not repeated float addition: a
        # level that lands at 0.1499999999999999 contours a hair beside
        # the line it claims to be.
        levels = magmap._levels_for("idot")   # minor 0.05
        assert 0.1 in levels
        for lvl in levels:
            assert abs(lvl / 0.05 - round(lvl / 0.05)) < 1e-6, lvl

    def test_levels_stay_inside_the_declared_span(self):
        for key in magmap.FIELD_ORDER:
            lo, hi = magmap.LINE_INTERVALS[key]["span"]
            for lvl in magmap._levels_for(key):
                assert lo - 1e-9 <= lvl <= hi + 1e-9, (key, lvl)

    def test_the_force_span_reaches_within_one_step_of_both_ends(self):
        # The chart must have a line near BOTH ends of the field it
        # paints — otherwise the strongest/weakest band of F comes out
        # blank. The span need not contain the sub-step margins (a
        # contour at 22,000 nT would lie below the field's own minimum),
        # so the bound is one MINOR step of slack.
        # verify() gates the ramp separately, over the same visibility
        # rule the wash uses: outside the blackout zone, since h's
        # smallest cells are the ones a compass cannot read anyway.
        model = magmap.WMMModel()
        grids = magmap.build_grids(model, magmap.decimal_year())
        outside = grids["h"] >= magmap.BLACKOUT_NT
        for key in ("f", "h"):
            minor = magmap.LINE_INTERVALS[key]["minor"]
            lo, hi = magmap.LINE_INTERVALS[key]["span"]
            data = grids[key][outside]
            assert lo <= data.min() + minor + 1e-9, (key, lo, data.min(), minor)
            assert hi >= data.max() - minor - 1e-9, (key, hi, data.max(), minor)

    def test_the_force_intervals_are_the_index_intermediate_pair(self):
        for key in ("f", "h"):
            spec = magmap.LINE_INTERVALS[key]
            assert spec["major"] % spec["minor"] == 0
            assert spec["major"] / spec["minor"] == 5.0   # textbook 5-interval ratio


class TestContourFieldDispatch:
    def test_declination_takes_the_branch_cut_free_path(self):
        # The one field that CANNOT go through contour_generic: a cell
        # straddling ±180 would draw a false line. Pin the dispatch so
        # nobody "simplifies" it into the generic path later.
        import inspect
        src = inspect.getsource(magmap.contour_field)
        assert 'key == "d"' in src
        assert "contour_isogonics" in src

    def test_an_unknown_field_raises_rather_than_silently_skipping(self):
        # A typo'd key must fail the build, not write an empty file.
        # The guard runs before the grid is touched, so a bare dict is
        # enough to exercise it.
        with pytest.raises(KeyError):
            magmap.contour_field({"lats": np.zeros(2), "lons": np.zeros(2)}, "x")

    def test_the_generic_path_ignores_the_blackout_for_force_fields(self):
        # f and h are defined where a compass is not; the predicate it
        # builds must be the one that never fires.
        assert magmap.FIELDS_SPEC["f"]["boz"] is False
        assert magmap._mask_off(0.0, 0.0) is False


class TestNTLabels:
    def test_force_labels_carry_the_unit(self):
        assert magmap.isodynamic_label(50000.0) == "50,000 nT"
        assert magmap.isodynamic_label(1000.0) == "1,000 nT"

    def test_nt_rates_are_not_printed_as_degrees(self):
        # The ΔF / ΔH isoporics are isoporic LINES carrying nT/yr
        # values; the default isoporic label would say "+12°/yr" on a
        # line that means twelve nanoteslas a year.
        assert magmap.ntrate_label(12.0) == "+12 nT/yr"
        assert magmap.ntrate_label(-3.5) == "−3.5 nT/yr"
        assert magmap.ntrate_label(0.0) == "No change"
        # The angle rates keep their own, degrees.
        assert magmap.isoporic_label(0.5) == "+0.5°/yr"

    def test_the_line_kinds_route_to_the_right_label(self):
        for key in ("fdot", "hdot"):
            kind, label_key = magmap.LINE_KINDS[key]
            assert kind == "isoporic"          # it IS an isoporic line
            assert magmap._LABEL_FNS[label_key] is magmap.ntrate_label
        for key in ("d", "i", "f", "h", "ddot", "idot"):
            _kind, label_key = magmap.LINE_KINDS[key]
            assert label_key is None            # the kind's own label

    def test_the_force_kinds_have_no_landmark_special(self):
        # .get(), not []: F never reaches zero and an H = 0 contour sits
        # under the polar rows the contourer drops, so there is no
        # agonic-equivalent to flag.
        assert magmap._SPECIALS.get("isodynamic") is None
        assert magmap._SPECIALS.get("isohorizontal") is None
        assert magmap._SPECIALS["isoporic"] == "nochange"


class TestPublishedComponents:
    """The built artefacts — skip on a host that has not run the build."""

    def _meta(self):
        path = os.path.join(magmap.OUT_DIR, "meta.json")
        if not os.path.exists(path):
            pytest.skip("overlay has not been built on this host")
        return json.load(open(path))

    def test_all_eight_fields_are_published(self):
        meta = self._meta()
        for key in magmap.FIELD_ORDER:
            assert key in meta["fields"], key
            f = meta["fields"][key]
            assert f["file"] == f"grid_{key}.bin"
            assert f["component"] in ("d", "f", "h", "i")
            assert f["mode"] in ("main", "sv")
            assert isinstance(f["scale"], (int, float)) and f["scale"] > 0
            assert f["lines"].endswith(".geojson")
            assert f["label_step"] > 0
            assert len(f["range"]) == 2 and f["range"][0] < f["range"][1]

    def test_the_selector_dimensions_come_from_meta(self):
        meta = self._meta()
        assert meta["components"] == ["d", "f", "h", "i"]
        assert set(meta["modes"]) == {"main", "sv"}
        assert len(meta["modes"]["main"]) == 4
        assert len(meta["modes"]["sv"]) == 4

    def test_the_shapefile_upstream_is_recorded(self):
        # The published contour shapefiles are the same model's output;
        # meta names them so nobody has to rediscover where they live.
        meta = self._meta()
        assert "wmm2025/shapefiles" in meta.get("shapefiles", "")

    def test_all_eight_line_families_are_published(self):
        meta = self._meta()
        for key in magmap.FIELD_ORDER:
            path = os.path.join(magmap.OUT_DIR, meta["fields"][key]["lines"])
            assert os.path.exists(path), key
            fc = json.load(open(path))
            assert fc["type"] == "FeatureCollection", key
            assert len(fc["features"]) > 0, key
            for feat in fc["features"][:5]:
                assert feat["geometry"]["type"] == "LineString"
                assert set(feat["properties"]) >= {"level", "kind", "major", "label"}

    def test_the_intensity_contours_carry_index_and_intermediate_ranks(self):
        meta = self._meta()
        fc = json.load(open(os.path.join(magmap.OUT_DIR, "isodynamics.geojson")))
        levels = {f["properties"]["level"] for f in fc["features"]}
        # Index (major) contours every 5000 nT...
        for lvl in range(25000, 65001, 5000):
            assert float(lvl) in levels, lvl
        # ...with 1000 nT intermediate lines filling in between.
        for lvl in range(24000, 65001, 1000):
            if lvl % 5000 == 0:
                continue
            assert float(lvl) in levels, lvl
        for feat in fc["features"]:
            p = feat["properties"]
            assert p["major"] is (abs(p["level"] % 5000) < 1e-9), p
            assert p["kind"] == "isodynamic"
            assert p["label"].endswith(" nT")

    def test_the_nt_rate_labels_reach_the_geojson(self):
        meta = self._meta()
        fc = json.load(open(os.path.join(magmap.OUT_DIR, "isoporics-f.geojson")))
        labels = {f["properties"]["label"] for f in fc["features"]}
        assert any(l.endswith("nT/yr") for l in labels), sorted(labels)[:5]
        # And never the degree spelling on an nT/yr family.
        assert not any(l.endswith("°/yr") for l in labels)

    def test_every_plane_decodes_to_its_ramp_range(self):
        meta = self._meta()
        g = meta["grid"]
        expect = g["rows"] * g["cols"]
        rail = np.iinfo(np.int16)
        for key in magmap.FIELD_ORDER:
            f = meta["fields"][key]
            data = np.fromfile(os.path.join(magmap.OUT_DIR, f["file"]), dtype="<i2")
            assert data.size == expect, key
            lo, hi = f["range"]
            visible = data
            if f["boz"]:
                mask = np.fromfile(
                    os.path.join(magmap.OUT_DIR, meta["mask"]), dtype=np.uint8
                )
                visible = data[mask == 0]
            # encode_plane() CLIPS rather than wraps, so a plane that
            # needed more room sits pinned at an Int16 rail — and a
            # rail-saturated cell in the VISIBLE field means the wash
            # is showing a flat, wrong colour. (dD/dt legitimately
            # saturates inside the blackout zone, where it is masked out
            # and the probe says so.)
            assert not (visible == rail.max).any(), (key, "clipped at +32767")
            assert not (visible == rail.min).any(), (key, "clipped at -32768")
            values = visible.astype(np.float64) / f["scale"]
            # The ramp must bracket every cell the wash can paint.
            assert values.min() >= lo - 1e-6, (key, values.min(), lo)
            assert values.max() <= hi + 1e-6, (key, values.max(), hi)

    def test_the_force_planes_read_back_as_force(self):
        # The unit test for "did the scale get applied the right way
        # round": read a known grid point back and compare against the
        # model evaluated at the very second the grid was built.
        meta = self._meta()
        model = magmap.WMMModel()
        g = meta["grid"]
        dt = meta["evaluated_at"] - meta["epoch"]
        for lat, lon in ((40.0, -100.0), (-25.0, -60.0), (0.0, 140.0)):
            row = int(round((lat - g["lat_min"]) / g["lat_step"]))
            # Longitudes are stored 0..359 (the GFS/torus convention), so
            # a negative one has to WRAP — index arithmetic with -100
            # lands 100 cells early and reads the neighbouring country's
            # field, which is how this test first "failed" by 527 nT.
            col = int(round((lon - g["lon_min"]) / g["lon_step"]))
            col = ((col % g["cols"]) + g["cols"]) % g["cols"]
            expect = model.elements(np.array([lat]), np.array([lon]), dt)
            for key in ("f", "h"):
                f = meta["fields"][key]
                data = np.fromfile(
                    os.path.join(magmap.OUT_DIR, f["file"]), dtype="<i2"
                )
                got = float(data[row * g["cols"] + col]) / f["scale"]
                want = float(expect[key][0, 0])
                # We read the grid POINT itself, so the only error left
                # is the Int16 quantization: 4 nT for F at scale 0.25.
                assert abs(got - want) <= 5.0, (key, lat, lon, got, want)
