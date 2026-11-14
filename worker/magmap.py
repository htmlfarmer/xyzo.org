#!/usr/bin/env python3
"""Build the magnetic-field overlay from the World Magnetic Model (WMM).

The map's "🧭 Magnetic Field" layer draws the **isogonic lines** (equal
magnetic declination, D) and the **isoclinic lines** (equal magnetic
inclination / dip, I) that every magnetic chart is built from, plus an
optional colour wash and a point probe. There is no free magnetic-contour
tile service, so the field is computed here from NOAA's coefficient file
and written as static files.

Data source (100 % free, no key, no rate limit, US Government work —
public domain):

    NOAA NCEI / British Geological Survey, World Magnetic Model 2025
    (WMM2025), valid 2025.0–2030.0. Degree/order 12 spherical-harmonic
    main-field model plus a degree/order 12 secular-variation (SV) model.

        https://www.ncei.noaa.gov/products/world-magnetic-model
        https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip

    The whole model is a 3 KB coefficient file (WMM.COF): 90 Gauss
    coefficients, each row carrying both the main-field term and its
    annual-change rate. D, I and their yearly change all come from this
    one file, so the overlay costs no network traffic at build time.

    The coefficient file is VENDORED at worker/data/WMM2025.COF.
    NCEI is mid-cloud-migration and their downloads have been
    intermittently unavailable; a build must never depend on their uptime.
    Run with --fetch to refresh the vendored copy from NCEI.

Unlike the weather overlays (isobars, temperature, wind) this field is
essentially STATIC: the WMM changes over years, not 6 hours. There is no
fetch cycle, no systemd timer and no GRIB decoding. Rebuild when a new
WMM ships (every five years — WMM2030 is expected in late 2029) or to
roll the evaluation date forward.

The field is evaluated at "now" (the current decimal year, which must
fall inside the model's 5-year life span). The annual change is the
forward difference D(t+1) − D(t), exactly how NCEI's own software
defines it.

Why contour D through X and Y rather than D itself
--------------------------------------------------
Declination is an ANGLE in [−180, +180]. A cell that straddles the
±180 branch cut holds two corners whose D values differ by ~358° while
the true field barely changes, so marching squares would draw a FALSE
contour line wherever D wraps. The isogonic line at level L is instead
the zero set of the smooth scalar field

    S_L = Y·cos L − X·sin L          (the component of the horizontal
                                      field perpendicular to direction L)

which is linear in the smooth components X and Y and therefore has no
branch cut anywhere. The companion field

    P_L = X·cos L + Y·sin L          (the component ALONG direction L)

is positive exactly where the field points along +L rather than L+180,
so keeping only the parts of the S_L = 0 contour where P_L > 0 selects
the right half of each zero set. Inclination lives in [−90, +90] with no
wrap, so it is contoured directly.

Blackout zones
--------------
Near each magnetic dip pole the horizontal intensity H collapses toward
zero, declination becomes undefined (a compass needle stands vertical)
and every isogonic line converges. NCEI's charts replace those caps with
a blank "blackout circle" defined as H < 2000 nT (their own error model
calls that the Blackout Zone; 2000–6000 nT is the Caution Zone). This
worker computes the same mask, sets the wash to transparent inside it,
and clips the contour lines at its boundary.

Published components
--------------------
Four components × two modes = eight selectable fields — the two chart
series NCEI publishes as its Miller-Projection "Main Field" and
"Secular Variation" maps for the elements a reader actually asks about
(their page lists seven components; X, Y and Z are the vector
decomposition of the three below, so they are computed for the verify
gate but not published as overlays of their own):

    D  declination        the compass's error from true north, degrees
    F  total force        |B|, the field a magnetometer reads, nT
    H  horizontal force   the part of B lying flat, nT
    I  inclination        the dip of the field, degrees

each with a MAIN FIELD value (at the evaluation date) and a SECULAR
VARIATION rate (its change per year).

    F and H are magnitudes: always positive, smooth, and perfectly
    well-defined inside the blackout zone (where H simply runs towards
    zero and F is at its strongest). Only D — and the rate of D, which
    divides by H² — lose their meaning there, so the blackout mask is
    applied PER FIELD, not globally. Blanketing F or I with it would
    delete the most interesting part of those two charts.

Outputs (all under public_html/data/mag/, and deliberately NOT .png —
Caddy serves every *.png under public_html `immutable` for a year, which
would freeze stale tiles behind a version token):

    grid_d.bin        Int16Array, declination in 0.01°, row 0 = −90°
    grid_i.bin        Int16Array, inclination in 0.01°
    grid_f.bin        Int16Array, total force, scale 0.25 → nT
    grid_h.bin        Int16Array, horizontal force, scale 0.5 → nT
    grid_ddot.bin     Int16Array, annual change of D in 0.01 arcmin/yr
    grid_idot.bin     Int16Array, annual change of I in 0.01 arcmin/yr
    grid_fdot.bin     Int16Array, annual change of F in 0.01 nT/yr
    grid_hdot.bin     Int16Array, annual change of H in 0.01 nT/yr
    mask.bin          Uint8Array, 1 = blackout zone (no data)
    isogonics.geojson         equal-declination contours        (D)
    isoclinics.geojson        equal-inclination contours        (I)
    isodynamics.geojson       equal-total-force contours        (F)
    isohorizontals.geojson    equal-horizontal-force contours   (H)
    isoporics.geojson         equal-annual-change of D          (ΔD)
    isoporics-i.geojson       equal-annual-change of I          (ΔI)
    isoporics-f.geojson       equal-annual-change of F          (ΔF)
    isoporics-h.geojson       equal-annual-change of H          (ΔH)
    meta.json         grid layout, per-field scale/ramp/lines, attribution

    "Isoporic" literally means "equal rate of change", so all FOUR rate
    families are isoporics — the suffix says which component. The
    total-force lines are isodynamics and the horizontal-force lines
    isohorizontals, the names NOAA's own charts use.

    The Int16 planes need a per-FIELD scale: one scale cannot serve both
    a ±180° angle and a 67,000 nT magnitude (67,000 × 100 is three
    orders of magnitude outside Int16). `meta.grid.scale` stays 100 for
    the four fields that shipped first; `meta.fields[k].scale` is the
    one the browser divides by, and `verify()` asserts no plane clips.

    Chart lines come in two ranks: INDEX (major) contours every 10° are
    the labelled lines, INTERMEDIATE (minor) contours every 2° fill in
    between the way a topographic map draws thin lines between its bold
    index contours. Isoporic lines (equal Ddot, every 0.25 °/yr) show
    where the compass reading is drifting and how fast. The wash ramps
    are diverging — blue (negative) → bright neon green (zero) → red
    (positive) — because zero is the meaningful state for every SIGNED
    field here (agonic, aclinic, "no change") and should glow, not
    vanish. F and H are magnitudes with no meaningful zero inside their
    range, so those two take a SEQUENTIAL ramp instead (deep blue → hot
    red): a diverging ramp would paint half of a one-sided field in a
    colour that means "negative".

The frontend (public_html/mag-layer.js) paints the wash client-side into
a Mercator-warped canvas (temp-layer pattern), draws the GeoJSON line
sets (river-layer pattern) and samples the grids for the probe — so
what you read IS the colour you are looking at.

The marching-squares machinery below is copied from worker/isobars.py.
It is imported there behind `from .db import connect` (the psycopg-before-
eccodes ordering rule), so importing it would drag in psycopg and
eccodes for a worker that needs neither. The functions are pure and this
field never changes, so a self-contained copy is the safer trade.

Usage:
    python -m worker.magmap               # verify, compute, write
    python -m worker.magmap --dry-run     # verify + compute, write nothing
    python -m worker.magmap --verify-only # just the NOAA test-value gate
    python -m worker.magmap --fetch       # refresh the vendored WMM.COF first
    python -m worker.magmap --time 2026.5 # evaluate at a specific decimal year
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import Sequence

import numpy as np

log = logging.getLogger("xyzo.magmap")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "mag")
DATA_DIR = os.path.join(REPO, "worker", "data")
COF_PATH = os.path.join(DATA_DIR, "WMM2025.COF")
TEST_VALUES_PATH = os.path.join(DATA_DIR, "WMM2025_TestValues.txt")

# The live NCEI download, used only by --fetch to refresh the vendored copy.
WMM_COF_URL = "https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip"

# ── Field / grid configuration ──────────────────────────────────────────
# 1° is generous: the WMM is a degree-12 spherical harmonic, smooth on
# ~15° scales, so nothing finer than the GFS temperature grid carries
# information. 181 x 360 cells = 65,160 points; four Int16 planes cost
# ~520 KB uncompressed and compress to a fraction of that.
GRID_STEP_DEG = 1.0

# Magnetic declination in degrees (range [−180, +180]).
# Inclination in degrees (range [−90, +90]).
# Annual change is stored in ARCMinutes per year (the NOAA convention on
# its charts); |Ddot| rarely exceeds 1.5°/yr = 90′/yr.
SCALE = 100  # stored = value * SCALE  →  0.01° for D/I, 0.01′/yr for SV
NODATA = -32768  # Int16 sentinel; real D/I/SV values never come near it

# |value × a field's scale| must stay under this once encoded: Int16
# tops out at 32,767 and encode_plane() clips (never wraps), so a plane
# that needs more is silently FLATTENED at its extremes. verify() uses
# this as the no-clip gate; the 2,767 of margin is for rounding.
INT16_HEADROOM = 30000.0

# NCEI's own error model: H < 2000 nT is the Blackout Zone (compass
# unusable), 2000–6000 nT the Caution Zone. The charts blank the former.
BLACKOUT_NT = 2000.0

# Chart lines come in two ranks. INDEX (major) contours are the labelled
# every-10° lines that NOAA's WMM charts carry; INTERMEDIATE (minor)
# contours sit between them at a finer spacing, the way a topographic
# map draws thin contours between its bold index contours. 2° minors
# give the textbook 5-interval ratio (every 5th line is an index line)
# and stay near the 1° grid's resolution limit. The frontend hides the
# minors below zoom 4 so the world view is not a hairball.
ISO_MAJOR_DEG = 10.0
ISO_MINOR_DEG = 2.0

# Isoporic lines: equal annual change of declination, in °/yr. The live
# WMM2025 Ddot field spans ±1.9 °/yr with 52 % of the globe inside
# ±0.1, so 0.25 °/yr minors give ~15 lines and majors every 1.0 mark
# the strong-change zones. The Ddot = 0 line — "no change" — is the
# neon-green centre of the wash and is flagged like the agonic line.
ISOPORIC_MINOR_DEG = 0.25
ISOPORIC_MAJOR_DEG = 1.0

# ── the published field set ────────────────────────────────────────────
# Four components × two modes. Each entry declares the plane's unit (the
# unit the browser's sampler returns), the Int16 scale that unit is
# quantized with, whether the blackout zone blanks it, and its ramp.
#
# SCALE (100) cannot serve every plane: F runs to 67,000 nT, and
# 67,000 × 100 is two orders of magnitude past Int16's 32,767. `scale`
# is therefore per field, and `meta.grid.scale` stays 100 for the four
# fields that shipped first so an older cached meta.json still decodes
# them. verify() asserts every plane fits its scale.
#
# `boz` is the interesting one. The blackout zone (H < 2000 nT) is where
# a compass needle stands vertical: DECLINATION is undefined there, and
# dD/dt divides by H² so its rate blows up with it. Everything else is
# fine — F is at its strongest, H is merely small and still real,
# inclination runs smoothly to ±90° — so masking all eight fields would
# blank the poles on the two charts that show them best. Per field.
#
# `label` is published into meta.json. The globe has no Leaflet and
# therefore no mag-layer.js to keep its own copy in, so it reads the
# component chips' text straight from meta — without it the four chips
# render EMPTY (magEsc(undefined) === ""), which is exactly how it
# shipped on 2026-10-30.
FIELDS_SPEC = {
    "d":    dict(label="Declination",     unit="deg",       scale=SCALE, boz=True,  mode="main"),
    "f":    dict(label="Total force",     unit="nT",        scale=0.25,  boz=False, mode="main"),
    "h":    dict(label="Horizontal force", unit="nT",       scale=0.5,   boz=False, mode="main"),
    "i":    dict(label="Inclination",     unit="deg",       scale=SCALE, boz=False, mode="main"),
    "ddot": dict(label="Δ declination",   unit="arcmin/yr", scale=SCALE, boz=True,  mode="sv"),
    "idot": dict(label="Δ inclination",   unit="arcmin/yr", scale=SCALE, boz=False, mode="sv"),
    "fdot": dict(label="Δ total force",   unit="nT/yr",     scale=SCALE, boz=False, mode="sv"),
    "hdot": dict(label="Δ horizontal",    unit="nT/yr",     scale=SCALE, boz=False, mode="sv"),
}

# The GRID KEY each field reads (the "component" it belongs to), so the
# browser can build "the four values of whichever mode is active".
COMPONENT_OF = {"d": "d", "ddot": "d", "i": "i", "idot": "i",
                "f": "f", "fdot": "f", "h": "h", "hdot": "h"}

# The order the components are offered in: D, F, H, I — the order the
# request named them in, and the order NCEI's own Miller charts tabulate
# them (minus X/Y/Z, the vector decomposition of D/F/H/I).
FIELD_ORDER = ("d", "f", "h", "i", "ddot", "fdot", "hdot", "idot")

# Which ramp each field takes, and its range IN THE PUBLISHED UNIT (the
# unit the browser's sampler returns — so the ramp stops, the wash and
# the probe all speak the same language).
#
#   diverging  signed fields where zero is the landmark (agonic,
#              aclinic, "not changing") → violet → cyan (zero) → gold
#   sequential one-sided magnitudes      → indigo → gold (see
#              SEQUENTIAL_STOPS, deliberately green-free)
#
# The spans are fixed, not adaptive: D and I are bounded by geometry,
# and F/H/SV by the model itself, which does not change under the 5-year
# life of the coefficient file. Measured WMM2025 at epoch+1.8 yr (the
# ramp must bracket the field for the whole life of the model, so each
# span is rounded OUTWARD past the observed extent):
#   F  22,026…66,932 nT  H  100…41,887 nT   ΔF −126…+104  ΔH −106…+77
#
# PLATEAU SIZES were narrowed on 2026-10-30 (D 10° → 6°, I 5° → 3°,
# ΔD 6′/yr → 4′/yr, ΔI 3′ → 2′, ΔF/ΔH 20 → 12 nT/yr). The flat band is
# half of what made the wash monotonous: a wide one spends half the map
# on one colour, so narrowing it lets the gradient — and therefore the
# colour — show.
RAMP_SPEC = {
    "d":    dict(kind="diverging", span=180.0, plateau=6.0),
    "i":    dict(kind="diverging", span=90.0,  plateau=3.0),
    "f":    dict(kind="sequential", lo=22000.0, hi=67000.0),
    "h":    dict(kind="sequential", lo=0.0,     hi=42000.0),
    "ddot": dict(kind="diverging", span=120.0, plateau=4.0),
    "idot": dict(kind="diverging", span=30.0,  plateau=2.0),
    # ±150 / ±120 nT/yr bracket the measured ΔF / ΔH with margin; the
    # green plateau of ±20 nT/yr used to cover 23 % of the globe for ΔF
    # and 52 % for ΔH — now ±12 shows far more of the drift.
    "fdot": dict(kind="diverging", span=150.0, plateau=12.0),
    "hdot": dict(kind="diverging", span=120.0, plateau=12.0),
}

# The (GeoJSON kind, label key) each field's line set is written with.
# `kind` is what the frontend's label fallback reads and what the
# specials table keys off; `label key` looks a label function up in
# _LABEL_FNS at WRITE time (the table is defined further down, after the
# contour machinery, so it cannot be referenced here). The ΔF and ΔH
# families need their own because their levels are nanoteslas a year and
# the default isoporic label prints degrees.
LINE_KINDS = {
    "d": ("isogonic", None),
    "i": ("isoclinic", None),
    "f": ("isodynamic", None),
    "h": ("isohorizontal", None),
    "ddot": ("isoporic", None),
    "idot": ("isoporic", None),
    "fdot": ("isoporic", "isoporic-nt"),
    "hdot": ("isoporic", "isoporic-nt"),
}

# One GeoJSON per field. The three that shipped first keep their NOAA
# chart names; the rest follow the same convention (isoporic = equal
# rate of change, so every SV family is an isoporic of its component).
LINE_FILES = {
    "d": "isogonics.geojson",
    "i": "isoclinics.geojson",
    "f": "isodynamics.geojson",
    "h": "isohorizontals.geojson",
    "ddot": "isoporics.geojson",
    "idot": "isoporics-i.geojson",
    "fdot": "isoporics-f.geojson",
    "hdot": "isoporics-h.geojson",
}

# Contour intervals, in the CONTOURING unit (angles in degrees, rates in
# °/yr — the rate planes are stored in arcmin/yr but the lines are
# contoured on the float field before encoding, which is how the
# existing isoporics already work).
#
# `span` is the range of levels actually contoured, so it must bracket
# the live field or the chart grows blank bands; the two angle families
# keep the fixed NOAA chart spacing, because a 10° index / 2°
# intermediate pair is a property of how declination charts are read,
# not of this particular model. The intensities and rates are stepped
# off the WMM2025 span measured at build time:
#
#   F  22,026 – 66,932 nT  → 1000 nT minor, 5000 nT major (45 lines)
#   H     100 – 41,887 nT  → 1000 nT minor, 5000 nT major
#   ΔI  −0.48 – +0.16 °/yr → 0.05 minor, 0.25 major
#   ΔF  −126 – +104 nT/yr  → 10 minor, 50 major
#   ΔH  −106 –  +77 nT/yr  → 10 minor, 50 major
#
# These are constants rather than a fit to the data because the model is
# static for five years; verify()'s range gate fails loudly if a future
# WMM ships a field they no longer bracket.
#
# `simplify_tol` / `min_length` default to the module constants; only
# the isoporics override them (Ddot's steeper gradients turn 0.03° into
# a visible value error, and a rate field's short loops are worth
# keeping where a main-field speck is not).
LINE_INTERVALS = {
    "d":    dict(minor=ISO_MINOR_DEG,      major=ISO_MAJOR_DEG, span=(-90.0, 90.0)),
    "i":    dict(minor=ISO_MINOR_DEG,      major=ISO_MAJOR_DEG, span=(-80.0, 80.0)),
    "f":    dict(minor=1000.0,             major=5000.0,        span=(23000.0, 67000.0)),
    "h":    dict(minor=1000.0,             major=5000.0,        span=(2000.0, 42000.0)),
    "ddot": dict(minor=ISOPORIC_MINOR_DEG, major=ISOPORIC_MAJOR_DEG, span=(-2.0, 2.0),
                 simplify_tol=0.01, min_length=1.0),
    "idot": dict(minor=0.05,               major=0.25,          span=(-0.5, 0.15),
                 simplify_tol=0.01, min_length=1.0),
    "fdot": dict(minor=10.0,               major=50.0,          span=(-130.0, 110.0),
                 simplify_tol=0.01, min_length=1.0),
    "hdot": dict(minor=10.0,               major=50.0,          span=(-110.0, 80.0),
                 simplify_tol=0.01, min_length=1.0),
}

# The below-zoom-5 label spacing for each field. The flat map only names
# a line whose level is a multiple of this when zoomed out to the world
# (plus the agonic / aclinic / no-change landmarks, always) — otherwise
# the viewport drowns in numbers. 30° reproduces the behaviour the angle
# fields shipped with (i.e. index parallels every 30°, nothing else);
# the intensity fields need their own step because 50,000 is not a
# multiple of 30 and would label NOTHING.
LABEL_STEP = {
    "d": 30.0, "i": 30.0, "ddot": 30.0, "idot": 30.0,
    "f": 5000.0, "h": 5000.0, "fdot": 50.0, "hdot": 50.0,
}

# The polar rows are dropped before contouring. Every longitude on a pole
# row shares one latitude, so a contour that lands there comes out as a
# perfectly straight line running along the pole. The magnetic dip poles
# sit near ±86°, well inside this limit, and their converging lines are
# clipped by the blackout mask anyway.
LAT_LIMIT_DEG = 85.0

# Contour post-processing. Same values as the isobar pipeline where the
# reasoning carries over; SIMPLIFY_TOL_DEG is looser (0.03 vs 0.01)
# because these lines are smooth on a global scale and the GeoJSON is a
# static file we would rather keep small. It stays BELOW the ~0.06°
# amplitude that Chaikin rounding leaves behind, or the simplification
# undoes the smoothing and the staircase comes back.
MIN_LINE_POINTS = 2
MIN_LINE_LENGTH_DEG = 2.0
BRIDGE_TOL_DEG = 0.35
MERGE_TOL_DEG = 0.25
SIMPLIFY_TOL_DEG = 0.03
SMOOTH_ITERATIONS = 2

# Guard rails on the verify() gate: a wrong answer that still looks like
# a magnetic field must fail loudly, so every check is a BOUND or a
# RELATIONSHIP, never a visual judgement.
TEST_D_TOL_DEG = 0.02  # the NOAA test file quotes D to 2 decimals
TEST_I_TOL_DEG = 0.02
TEST_XYZ_TOL_NT = 0.6  # the test file quotes X/Y/Z to 0.1 nT
TEST_SV_TOL_DEG_YR = 0.02
# dF/dt and dH/dt are quoted in nT/yr to six decimals and the synthesis
# agrees to 1e-6; 0.1 nT/yr is four orders of magnitude of slack on the
# 250 nT/yr of signal, and still fails any sign or unit slip (deg/yr
# instead of nT/yr would be off by ~60×).
TEST_SV_TOL_NT_YR = 0.1


# ═══════════════════════════════════════════════════════════════════════
# WMM coefficient file
# ═══════════════════════════════════════════════════════════════════════
def read_cof(path: str = COF_PATH):
    """Parse a WMM.COF file.

    Returns (epoch, model, release_date, coeffs) where coeffs is a list
    of (n, m, g, h, g_dot, h_dot) for n = 1..12, m = 0..n. The header
    line carries the epoch in decimal years; every data line carries the
    Schmidt-normalized Gauss coefficient AND its secular-variation rate.
    """
    with open(path) as fh:
        lines = fh.read().splitlines()
    if not lines:
        raise ValueError(f"{path} is empty")
    header = lines[0].split()
    if len(header) != 3:
        raise ValueError(f"invalid WMM.COF header: {lines[0]!r}")
    epoch = float(header[0])
    model = header[1]
    release = header[2]

    coeffs = []
    for line in lines[1:]:
        if line.startswith("9999"):
            break
        parts = line.split()
        if len(parts) != 6:
            raise ValueError(f"corrupt WMM.COF record: {line!r}")
        n = int(parts[0])
        m = int(parts[1])
        if m > n or m < 0:
            raise ValueError(f"corrupt WMM.COF degrees: {line!r}")
        coeffs.append(
            (n, m, float(parts[2]), float(parts[3]), float(parts[4]), float(parts[5]))
        )
    if not coeffs:
        raise ValueError(f"{path} carries no coefficients")
    return epoch, model, release, coeffs


class WMMModel:
    """A loaded WMM ready to evaluate the field on a lat/lon grid.

    Ported from NOAA's reference C implementation (via the pygeomag
    Python port) so the output matches their published test values to
    floating-point precision. The coefficients are converted from
    Schmidt-normalized to unnormalized form once at load time; the
    per-point work is then plain Legendre recurrences, vectorized over
    the whole grid with numpy.
    """

    def __init__(self, cof_path: str = COF_PATH):
        self.epoch, self.model, self.release, coeffs = read_cof(cof_path)
        self.maxord = max(n for n, _m, *_ in coeffs)
        size = self.maxord + 1
        self.size = size

        # g[n][m] / h[n][m] and their secular-variation rates, indexed by
        # degree then order. The C code packs these into one matrix with a
        # transposed index trick; two plain tables are far clearer and the
        # arithmetic is identical.
        self.g = [[0.0] * size for _ in range(size)]
        self.h = [[0.0] * size for _ in range(size)]
        self.gdot = [[0.0] * size for _ in range(size)]
        self.hdot = [[0.0] * size for _ in range(size)]
        for n, m, gnm, hnm, dgnm, dhnm in coeffs:
            if m > self.maxord:
                continue
            self.g[n][m] = gnm
            self.gdot[n][m] = dgnm
            if m != 0:
                self.h[n][m] = hnm
                self.hdot[n][m] = dhnm

        # Convert the Schmidt-normalized Gauss coefficients to
        # unnormalized form. This replicates MAG_LoadMagneticModel_Large
        # from NOAA's Geomagnetism Library: snorm accumulates the
        # normalization factors along the (n, m) diagonal, k[] holds the
        # recurrence constants for the associated Legendre functions.
        snorm = [0.0] * (size * size)
        k = [[0.0] * size for _ in range(size)]
        snorm[0] = 1.0
        for n in range(1, self.maxord + 1):
            snorm[n] = snorm[n - 1] * float(2 * n - 1) / float(n)
            j = 2
            for m in range(0, n + 1):
                k[m][n] = float(((n - 1) * (n - 1)) - (m * m)) / float(
                    (2 * n - 1) * (2 * n - 3)
                )
                if m > 0:
                    flnmj = float((n - m + 1) * j) / float(n + m)
                    snorm[n + m * size] = snorm[n + (m - 1) * size] * math.sqrt(flnmj)
                    j = 1
                    self.h[n][m] *= snorm[n + m * size]
                    self.hdot[n][m] *= snorm[n + m * size]
                self.g[n][m] *= snorm[n + m * size]
                self.gdot[n][m] *= snorm[n + m * size]
        k[1][1] = 0.0
        self._snorm = snorm
        self._k = k

        # Geodetic → spherical constants (WGS-84).
        self.a = 6378.137
        self.b = 6356.7523142
        self.re = 6371.2
        self.a2 = self.a * self.a
        self.b2 = self.b * self.b
        self.c2 = self.a2 - self.b2
        self.a4 = self.a2 * self.a2
        self.b4 = self.b2 * self.b2
        self.c4 = self.a4 - self.b4

    def field_xyz(
        self,
        lats: np.ndarray,
        lons: np.ndarray,
        dt: float,
        alt_km: float = 0.0,
        rate: bool = False,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Evaluate the geodetic field components X, Y, Z (nT).

        lats is (nrows,), lons is (ncols,), dt is years since the model
        epoch, alt_km is height above the WGS-84 ellipsoid in km. The
        overlay is evaluated at sea level; the NOAA test values include
        points up to 94 km, so the altitude has to be honoured there.

        rate=True synthesizes the SECULAR-VARIATION field instead: the
        time-derivative of X/Y/Z in nT/yr. WMM is linear in its
        coefficients and the ḡ/ḣ rates are constant, so the rate field
        is just the same synthesis with the (ġ, ḣ) tables in place of
        (g, h) — the dt term vanishes. Returns (X, Y, Z), each shaped
        (nrows, ncols). X is north, Y east, Z vertical (down positive).
        """
        maxord = self.maxord
        size = self.size
        nrows = len(lats)
        ncols = len(lons)

        # Time-adjust the coefficients: tc = c + dt · ċ. For the rate
        # field the coefficients ARE the rates and they are constant in
        # time (WMM ships no second derivative), so tc = ċ.
        if rate:
            tc_g = [[self.gdot[n][m] for m in range(size)] for n in range(size)]
            tc_h = [[self.hdot[n][m] for m in range(size)] for n in range(size)]
        else:
            tc_g = [
                [self.g[n][m] + dt * self.gdot[n][m] for m in range(size)]
                for n in range(size)
            ]
            tc_h = [
                [self.h[n][m] + dt * self.hdot[n][m] for m in range(size)]
                for n in range(size)
            ]

        # Geodetic → spherical, per latitude row (altitude = 0). Every
        # term depends only on latitude at sea level, so the 2-D grid
        # never enters these recurrences.
        rlat = np.radians(lats)
        srlat = np.sin(rlat)
        crlat = np.cos(rlat)
        srlat2 = srlat * srlat
        crlat2 = crlat * crlat
        q = np.sqrt(self.a2 - self.c2 * srlat2)
        q1 = alt_km * q
        q2 = ((q1 + self.a2) / (q1 + self.b2)) ** 2
        ct = srlat / np.sqrt(q2 * crlat2 + srlat2)
        st = np.sqrt(np.maximum(0.0, 1.0 - ct * ct))
        r2 = (alt_km * alt_km) + 2.0 * q1 + (self.a4 - self.c4 * srlat2) / (q * q)
        r = np.sqrt(r2)
        d = np.sqrt(self.a2 * crlat2 + self.b2 * srlat2)
        ca = (alt_km + d) / r
        sa = self.c2 * crlat * srlat / (r * d)
        aor = self.re / r

        # Longitude recursion: sp[m] = sin(m·λ), cp[m] = cos(m·λ).
        rlon = np.radians(lons)
        sp = np.zeros((maxord + 1, ncols))
        cp = np.zeros((maxord + 1, ncols))
        sp[0] = 0.0
        cp[0] = 1.0
        sp[1] = np.sin(rlon)
        cp[1] = np.cos(rlon)
        for m in range(2, maxord + 1):
            sp[m] = sp[1] * cp[m - 1] + cp[1] * sp[m - 1]
            cp[m] = cp[1] * cp[m - 1] - sp[1] * sp[m - 1]

        # Per-row Legendre polynomials and derivatives, then accumulate
        # the spherical-harmonic expansion over the whole grid. The
        # recurrence is sequential in (n, m) but each step is a vector
        # op over the latitude rows, and the longitude dependence is a
        # separable outer product — so the 65k-point grid costs 90 small
        # numpy operations rather than 90 × 65k Python iterations.
        p = np.zeros((size, size, nrows))  # p[n, m, row]
        dp = np.zeros((size, size, nrows))
        ar = np.empty((size, nrows))  # ar[n, row] = (re/r)^(n+2)
        ar[0] = aor * aor
        for n in range(1, maxord + 1):
            ar[n] = ar[n - 1] * aor

        p[0, 0] = 1.0
        for n in range(1, maxord + 1):
            for m in range(0, n + 1):
                if n == m:
                    p[n, m] = st * p[n - 1, m - 1]
                    dp[n, m] = st * dp[n - 1, m - 1] + ct * p[n - 1, m - 1]
                elif n == 1 and m == 0:
                    p[n, m] = ct * p[n - 1, m]
                    dp[n, m] = ct * dp[n - 1, m] - st * p[n - 1, m]
                elif n > 1 and n != m:
                    if m > n - 2:
                        p[n - 2, m] = 0.0
                        dp[n - 2, m] = 0.0
                    p[n, m] = ct * p[n - 1, m] - self._k[m][n] * p[n - 2, m]
                    dp[n, m] = (
                        ct * dp[n - 1, m] - st * p[n - 1, m] - self._k[m][n] * dp[n - 2, m]
                    )

        br = np.zeros((nrows, ncols))
        bt = np.zeros((nrows, ncols))
        bp = np.zeros((nrows, ncols))

        # Accumulate the spherical-harmonic expansion. NOAA's C code
        # packs g(n,m) at tc[m][n] and h(n,m) at tc[n][m-1] (a transposed
        # index trick inherited from the original Fortran); our tables are
        # degree-major — tc_g[n][m] is g(n,m) — so the reads here are
        # tc_g[n][m] / tc_h[n][m], NOT the [m][n] the C code uses. Reading
        # them order-major negates most of the field and turns every
        # declination into its opposite — a 180° error the test gate
        # catches as "worst error 179.5°".
        for n in range(1, maxord + 1):
            fn = float(n + 1)
            for m in range(0, n + 1):
                par = (ar[n] * p[n, m])[:, None]  # (nrows, 1)
                if m == 0:
                    t1 = tc_g[n][0] * cp[0][None, :]
                    t2 = tc_g[n][0] * sp[0][None, :]
                else:
                    t1 = tc_g[n][m] * cp[m][None, :] + tc_h[n][m] * sp[m][None, :]
                    t2 = tc_g[n][m] * sp[m][None, :] - tc_h[n][m] * cp[m][None, :]
                bt -= (ar[n][:, None]) * t1 * dp[n, m][:, None]
                bp += float(m) * t2 * par
                br += fn * t1 * par

        # Geographic poles: st = 0, so bp = bp / st would divide by zero.
        # NOAA's library accumulates a separate series there (the pp
        # recurrence, the m=1 term only) and uses it in place of bp.
        # Every other row is divided by st as usual — guarding the divide
        # with `where` rather than an if/else, or the non-pole rows would
        # keep the un-divided bp whenever a pole row exists (which it
        # always does on a grid that reaches ±90).
        pole_rows = np.where(st == 0.0)[0]
        bp = np.divide(
            bp, st[:, None], out=np.zeros_like(bp), where=st[:, None] != 0.0
        )
        if len(pole_rows):
            pp_prev2 = np.zeros(ncols)
            pp_prev1 = np.ones(ncols)  # pp[0]
            bpp = np.zeros((len(pole_rows), ncols))
            for n in range(1, maxord + 1):
                if n == 1:
                    pp = pp_prev1
                else:
                    pp = ct[pole_rows[0]] * pp_prev1 - self._k[1][n] * pp_prev2
                pp_prev2, pp_prev1 = pp_prev1, pp
                parp = (ar[n][pole_rows[0]]) * pp
                # m = 1: pygeomag's tc[1][n] is g(n,1) and tc[n][0] is
                # h(n,1) — degree-major, tc_g[n][1] / tc_h[n][1].
                t2 = tc_g[n][1] * sp[1][None, :] - tc_h[n][1] * cp[1][None, :]
                bpp += parp[None, :] * t2  # fm[1] = 1
            bp[pole_rows] = bpp

        # Rotate the geocentric vector into geodetic north/east/vertical.
        bx = -bt * ca[:, None] - br * sa[:, None]
        by = bp
        bz = bt * sa[:, None] - br * ca[:, None]
        return bx, by, bz

    def elements(
        self, lats: np.ndarray, lons: np.ndarray, dt: float, alt_km: float = 0.0
    ) -> dict[str, np.ndarray]:
        """D (deg), I (deg), H (nT), F (nT) and the analytic annual
        change of D, I, F and H on the grid.

        The annual change is the exact chain-rule derivative, not a
        finite difference: WMM is linear in its coefficients, so the
        time-derivative of the field vector is the synthesis of the
        (ġ, ḣ) rates, and dD/dt = (X·Ẏ − Y·Ẋ)/H² follows from
        D = atan2(Y, X). A one-year forward difference of D disagrees
        with this near the dip poles — where D curves fast and H is
        small — by up to 0.1°/yr, which is exactly the error the NOAA
        test gate catches.

        Ḟ and Ḣ come from the same product rule on F = sqrt(H²+Z²) and
        H = sqrt(X²+Y²): Ḟ = (X·Ẋ+Y·Ẏ+Z·Ż)/F and Ḣ = (X·Ẋ+Y·Ẏ)/H.
        Ḣ LOOKS singular where H → 0, but X = H·cos D and Y = H·sin D
        make the numerator proportional to H, so the H cancels and the
        rate stays bounded (measured 106 nT/yr worst case, inside the
        blackout zone). Both divides are guarded anyway — a surviving
        0/0 would poison a whole plane with NaN.
        """
        bx, by, bz = self.field_xyz(lats, lons, dt, alt_km)
        bh = np.sqrt(bx * bx + by * by)
        dec = np.degrees(np.arctan2(by, bx))
        inc = np.degrees(np.arctan2(bz, bh))

        # The rate field: Ẋ, Ẏ, Ż in nT/yr.
        bxd, byd, bzd = self.field_xyz(lats, lons, dt, alt_km, rate=True)

        # dD/dt = (X·Ẏ − Y·Ẋ) / H²  (radians/yr → deg/yr). Guard H→0:
        # inside the blackout zone declination is undefined and its rate
        # meaningless; 0 keeps the plane finite so the wash and the probe
        # have a number to show (the mask already flags it as no-data).
        with np.errstate(divide="ignore", invalid="ignore"):
            ddec = np.degrees((bx * byd - by * bxd) / (bh * bh))
        ddec = np.where(bh > 1e-6, ddec, 0.0)

        # dI/dt = (H·Ż − Z·Ḣ) / F²  where Ḣ = (X·Ẋ + Y·Ẏ)/H, from
        # I = atan2(Z, H) and F² = H² + Z².
        with np.errstate(divide="ignore", invalid="ignore"):
            dh = (bx * bxd + by * byd) / bh
            ff = bh * bh + bz * bz
            dinc = np.degrees((bh * bzd - bz * dh) / ff)
        dinc = np.where(ff > 1e-6, dinc, 0.0)

        # Ḟ = (X·Ẋ + Y·Ẏ + Z·Ż)/F and Ḣ = (X·Ẋ + Y·Ẏ)/H, in nT/yr.
        # F never comes near zero on Earth (22,000+ nT) and the H in
        # Ḣ cancels analytically; the guards are for the arithmetic
        # only, so a single degenerate cell cannot NaN a published plane.
        ff_sqrt = np.sqrt(ff)
        with np.errstate(divide="ignore", invalid="ignore"):
            fdot = (bx * bxd + by * byd + bz * bzd) / ff_sqrt
        fdot = np.where(ff_sqrt > 1e-6, fdot, 0.0)
        with np.errstate(divide="ignore", invalid="ignore"):
            hdot = (bx * bxd + by * byd) / bh
        hdot = np.where(bh > 1e-6, hdot, 0.0)

        return {
            "d": dec, "i": inc, "h": bh, "f": ff_sqrt,
            "x": bx, "y": by, "z": bz,
            "ddot": ddec, "idot": dinc,
            "fdot": fdot, "hdot": hdot,
        }


# ═══════════════════════════════════════════════════════════════════════
# Contour machinery (copied from worker/isobars.py — see module docstring)
# ═══════════════════════════════════════════════════════════════════════
# Corner order per cell: 0 = (row, col), 1 = (row, col+1),
# 2 = (row+1, col+1), 3 = (row+1, col).
#
# The case index is a 4-bit mask of "corner is above the level":
# bit0=corner0, bit1=corner1, bit2=corner2, bit3=corner3.
_CASES: dict[int, list[tuple[str, str]]] = {
    1: [("b", "l")], 2: [("b", "r")], 3: [("r", "l")], 4: [("r", "t")],
    6: [("b", "t")], 7: [("r", "l")], 8: [("l", "t")], 9: [("b", "t")],
    11: [("r", "t")], 12: [("l", "r")], 13: [("b", "r")], 14: [("b", "l")],
}

# The two SADDLE cases are ambiguous: the four corners straddle the
# level in a checkerboard pattern and there are two ways to pair the
# edges. Picking one blindly produces a line that crosses itself — a
# visible "lightning bolt" on the chart. The asymptotic decider resolves
# it with the value at the cell centre (for a bilinear field that is
# exactly the mean of the four corners).
_SADDLE = {
    5: ([("b", "r"), ("l", "t")], [("b", "l"), ("r", "t")]),
    10: ([("b", "l"), ("r", "t")], [("b", "r"), ("l", "t")]),
}


def _edge_point(va, vb, ax, ay, bx, by, level):
    """Interpolated crossing point on the edge between two corners."""
    with np.errstate(divide="ignore", invalid="ignore"):
        t = (level - va) / (vb - va)
    t = np.where(np.isfinite(t), t, 0.5)
    t = np.clip(t, 0.0, 1.0)
    return ax + (bx - ax) * t, ay + (by - ay) * t


def marching_squares(grid, lats, lons, level):
    """Contour one level out of a regular lat/lon grid.

    Returns an (n, 4) array of segments [x1, y1, x2, y2] in degrees.
    """
    v00 = grid[:-1, :-1]
    v10 = grid[:-1, 1:]
    v11 = grid[1:, 1:]
    v01 = grid[1:, :-1]

    case = (
        ((v00 > level).astype(np.uint8))
        | ((v10 > level).astype(np.uint8) << 1)
        | ((v11 > level).astype(np.uint8) << 2)
        | ((v01 > level).astype(np.uint8) << 3)
    )

    x0 = lons[:-1][None, :]
    x1 = lons[1:][None, :]
    y0 = lats[:-1][:, None]
    y1 = lats[1:][:, None]

    X = np.broadcast_to(x0, v00.shape)
    Y = np.broadcast_to(y0, v00.shape)
    dx = x1 - x0
    dy = y1 - y0

    edges = {
        # bottom edge, corner0 -> corner1
        "b": _edge_point(v00, v10, X, Y, X + dx, Y, level),
        # right edge, corner1 -> corner2
        "r": _edge_point(v10, v11, X + dx, Y, X + dx, Y + dy, level),
        # top edge, corner3 -> corner2
        "t": _edge_point(v01, v11, X, Y + dy, X + dx, Y + dy, level),
        # left edge, corner0 -> corner3
        "l": _edge_point(v00, v01, X, Y, X, Y + dy, level),
    }

    chunks = []
    for case_id, pairs in _CASES.items():
        mask = case == case_id
        if not mask.any():
            continue
        for edge_a, edge_b in pairs:
            (xa, ya), (xb, yb) = edges[edge_a], edges[edge_b]
            chunks.append(
                np.stack([xa[mask], ya[mask], xb[mask], yb[mask]], axis=1)
            )

    # Saddle cells: the pairing depends on the value at the centre.
    centre = (v00 + v10 + v11 + v01) / 4.0
    for case_id, (above_pairs, below_pairs) in _SADDLE.items():
        mask = case == case_id
        if not mask.any():
            continue
        for pairs, sub in ((above_pairs, centre > level), (below_pairs, centre <= level)):
            sel = mask & sub
            if not sel.any():
                continue
            for edge_a, edge_b in pairs:
                (xa, ya), (xb, yb) = edges[edge_a], edges[edge_b]
                chunks.append(
                    np.stack([xa[sel], ya[sel], xb[sel], yb[sel]], axis=1)
                )

    if not chunks:
        return np.empty((0, 4))
    return np.concatenate(chunks, axis=0)


def stitch_segments(segments, tol: float = 1e-6):
    """Join loose contour segments into continuous polylines.

    O(n): segments are indexed by their (rounded) endpoints, then chains
    are walked from the open ends first and the remaining closed rings
    are walked afterwards.

    At a branch point (four cells meeting at one corner, a saddle, the
    pole rows) several segments share a node. The walk has to pick the
    one that continues the line GEOMETRICALLY — taking any free segment
    teleports the line across the map.
    """
    if len(segments) == 0:
        return []

    node_id: dict[tuple[int, int], int] = {}
    coords: list[tuple[float, float]] = []

    def node(x: float, y: float) -> int:
        key = (int(round(x / tol)), int(round(y / tol)))
        idx = node_id.get(key)
        if idx is None:
            idx = len(coords)
            node_id[key] = idx
            coords.append((x, y))
        return idx

    adjacency: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for index, (ax, ay, bx, by) in enumerate(segments):
        a = node(ax, ay)
        b = node(bx, by)
        adjacency[a].append((b, index))
        adjacency[b].append((a, index))

    used = [False] * len(segments)
    lines: list[list[tuple[float, float]]] = []

    def walk(first_node: int, first_seg: int, first_next: int) -> list[int]:
        chain = [first_node, first_next]
        current = first_next
        prev_seg = first_seg
        prev_point = coords[first_node]
        while True:
            cur_x, cur_y = coords[current]
            in_x = cur_x - prev_point[0]
            in_y = cur_y - prev_point[1]
            in_len = math.hypot(in_x, in_y)

            best = None
            best_score = None
            for candidate, seg_index in adjacency[current]:
                if seg_index == prev_seg or used[seg_index]:
                    continue
                far_x, far_y = coords[candidate]
                out_x = far_x - cur_x
                out_y = far_y - cur_y
                out_len = math.hypot(out_x, out_y)
                if in_len == 0.0 or out_len == 0.0:
                    score = 0.0
                else:
                    # Cosine similarity: 1 means the line carries straight
                    # on, -1 means it doubles back.
                    score = (in_x * out_x + in_y * out_y) / (in_len * out_len)
                if best_score is None or score > best_score:
                    best_score = score
                    best = (candidate, seg_index)
            if best is None:
                break
            used[best[1]] = True
            chain.append(best[0])
            prev_point = coords[current]
            current, prev_seg = best
        return chain

    # Open chains first: start from the free ends so a ring that touches
    # another ring is not cut in half.
    for node_index, neighbours in adjacency.items():
        if len(neighbours) != 1:
            continue
        other, seg_index = neighbours[0]
        if used[seg_index]:
            continue
        used[seg_index] = True
        lines.append([coords[n] for n in walk(node_index, seg_index, other)])

    # Whatever is left is a closed ring.
    for index, (ax, ay, bx, by) in enumerate(segments):
        if used[index]:
            continue
        used[index] = True
        chain = walk(node(bx, by), index, node(ax, ay))
        if chain[-1] != chain[0]:
            chain.append(chain[0])
        lines.append([coords[n] for n in chain])

    return lines


def simplify(points: Sequence[tuple[float, float]], tolerance: float):
    """Douglas-Peucker simplification."""
    if len(points) < 3:
        return list(points)
    pts = np.asarray(points, dtype=float)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        p0 = pts[start]
        p1 = pts[end]
        d = p1 - p0
        length = math.hypot(d[0], d[1])
        segment = pts[start + 1 : end]
        if length < 1e-12:
            dist = np.hypot(segment[:, 0] - p0[0], segment[:, 1] - p0[1])
        else:
            dist = np.abs(
                d[0] * (p0[1] - segment[:, 1]) - (p0[0] - segment[:, 0]) * d[1]
            ) / length
        offset = int(np.argmax(dist))
        if dist[offset] > tolerance:
            middle = start + 1 + offset
            keep[middle] = True
            stack.append((start, middle))
            stack.append((middle, end))
    return pts[keep]


def chaikin_smooth(points, iterations: int | None = None):
    """Round the corners of a polyline with Chaikin corner-cutting.

    Marching squares returns a polyline whose vertices sit on the
    analysis grid, so the contour comes out visibly angular — the
    staircase you see on a 1° grid. Chaikin replaces every segment with
    two shorter ones at 1/4 and 3/4 of the way along it, which rounds
    the corners off. Unlike a spline it never overshoots, so the line
    stays on the side of the true contour it started on.
    """
    if iterations is None:
        iterations = SMOOTH_ITERATIONS
    pts = list(points)
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        rounded = [pts[0]]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            rounded.append((x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.25))
            rounded.append((x0 + (x1 - x0) * 0.75, y0 + (y1 - y0) * 0.75))
        rounded.append(pts[-1])
        pts = rounded
    return pts


def polyline_length(points) -> float:
    """Length of a polyline in degrees."""
    total = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        total += math.hypot(x1 - x0, y1 - y0)
    return total


def filter_short_chains(
    chains,
    min_length: float = MIN_LINE_LENGTH_DEG,
    tol: float = BRIDGE_TOL_DEG,
):
    """Drop short fragments — unless they are holding a line together.

    A contour arrives as several pieces wherever the field grazes a
    level, so a short piece is only dropped when it has fewer than two
    neighbouring chains of the same level. Two neighbours means it
    bridges a break and has to stay; one neighbour is a hair sticking
    off the line; zero is an isolated speck.
    """
    if not chains:
        return []
    parts = [list(c) for c in chains if len(c) >= 2]
    if not parts:
        return []

    def bucket_of(x, y):
        return (math.floor(x / tol), math.floor(y / tol))

    buckets: dict[tuple, list[int]] = {}
    ends: list[tuple[float, float, int]] = []
    for i, p in enumerate(parts):
        for pt in (p[0], p[-1]):
            ends.append((pt[0], pt[1], i))
            buckets.setdefault(bucket_of(pt[0], pt[1]), []).append(len(ends) - 1)

    neighbours: list[set[int]] = [set() for _ in parts]
    for x1, y1, i in ends:
        kx, ky = bucket_of(x1, y1)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ej in buckets.get((kx + dx, ky + dy), []):
                    x2, y2, j = ends[ej]
                    if j == i:
                        continue
                    if math.hypot(x2 - x1, y2 - y1) <= tol:
                        neighbours[i].add(j)

    kept = []
    for i, p in enumerate(parts):
        if polyline_length(p) >= min_length:
            kept.append(p)
        elif len(neighbours[i]) >= 2:
            kept.append(p)
    return kept


def _join_pieces(a, b, tol: float):
    """Append piece `b` to the end of piece `a`, cutting the overshoot.

    The two overlap: `b` starts back along `a`'s last segment, because
    the contour cut the same corner twice. Appending them as they are
    leaves a visible back-step, so `a`'s last segment is cut at the
    point where `b` begins.

    Returns None when the two are NOT overlapping — merely adjacent
    strands of the same line. Joining those produces a line that doubles
    back on itself, which is a visible staircase on the map.
    """
    if len(a) < 2:
        return None
    ea, sb = a[-1], b[0]
    if math.hypot(ea[0] - sb[0], ea[1] - sb[1]) > tol:
        return None
    dx = ea[0] - a[-2][0]
    dy = ea[1] - a[-2][1]
    length_sq = dx * dx + dy * dy
    if length_sq < 1e-12:
        return None
    t = ((sb[0] - a[-2][0]) * dx + (sb[1] - a[-2][1]) * dy) / length_sq
    if not (0.0 <= t <= 1.0):
        # `b` does not start on `a`'s last segment: they are two
        # neighbouring strands, not the same line. Leave them apart.
        return None
    cut = (a[-2][0] + dx * t, a[-2][1] + dy * t)
    merged = list(a[:-1]) + [cut] + list(b[1:])
    # Drop consecutive duplicates (the cut can land on an existing point).
    out = [merged[0]]
    for point in merged[1:]:
        if abs(point[0] - out[-1][0]) > 1e-12 or abs(point[1] - out[-1][1]) > 1e-12:
            out.append(point)
    return out


def merge_lines(lines, tol: float = MERGE_TOL_DEG):
    """Join the pieces of each level into continuous lines.

    A contour arrives as thousands of pieces: marching squares cuts the
    line wherever the field grazes the level, and the stitch cannot
    rejoin them because their ends do not coincide. Pieces whose ends
    come within `tol` of each other belong to the same line.

    Returns [(level, points), ...] with the pieces merged. The level key
    may be any hashable (this field uses floats).
    """
    by_level: dict[object, list[list[tuple[float, float]]]] = defaultdict(list)
    for level, points in lines:
        by_level[level].append(list(points))

    cell = max(tol, 1e-9)
    merged: list[tuple[object, list[tuple[float, float]]]] = []

    for level, pieces in by_level.items():
        n = len(pieces)
        if n < 2:
            merged.extend((level, p) for p in pieces)
            continue

        # Endpoints are indexed 2i = start of piece i, 2i+1 = end.
        ends: list[tuple[float, float]] = []
        for p in pieces:
            ends.append(p[0])
            ends.append(p[-1])

        buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i, e in enumerate(ends):
            buckets[(math.floor(e[0] / cell), math.floor(e[1] / cell))].append(i)

        def find_partner(idx: int):
            """Endpoint indices that could join onto ends[idx], nearest first."""
            e = ends[idx]
            kx = math.floor(e[0] / cell)
            ky = math.floor(e[1] / cell)
            found = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j in buckets.get((kx + dx, ky + dy), []):
                        if j // 2 == idx // 2:
                            continue
                        piece = j // 2
                        if used[piece]:
                            continue
                        o = ends[j]
                        d = math.hypot(e[0] - o[0], e[1] - o[1])
                        if d <= tol:
                            found.append((d, j))
            found.sort()
            return [j for _d, j in found]

        used = [False] * n
        for start in range(n):
            if used[start]:
                continue
            used[start] = True
            chain = list(pieces[start])
            # The endpoint indices of the two open ends of the chain.
            head = 2 * start
            tail = 2 * start + 1

            for _ in range(n):
                # Grow the tail first.
                grew = False
                for j in find_partner(tail):
                    piece = j // 2
                    p = pieces[piece]
                    if j % 2 == 1:
                        # Its END is the junction — flip it so it starts
                        # there.
                        p = p[::-1]
                    joined = _join_pieces(chain, p, tol)
                    if joined is None:
                        continue  # adjacent strand, not the same line
                    chain = joined
                    used[piece] = True
                    tail = 2 * piece + (1 if j % 2 == 0 else 0)
                    grew = True
                    break
                if grew:
                    continue
                # Then the head.
                grew = False
                for j in find_partner(head):
                    piece = j // 2
                    p = pieces[piece]
                    if j % 2 == 0:
                        # Its START is the junction — flip it so it ends
                        # there.
                        p = p[::-1]
                    joined = _join_pieces(p, chain, tol)
                    if joined is None:
                        continue
                    chain = joined
                    used[piece] = True
                    head = 2 * piece + (1 if j % 2 == 1 else 0)
                    grew = True
                    break
                if not grew:
                    break
            merged.append((level, chain))
    return merged


def clip_to_lon_range(points, west: float, east: float):
    """Split a polyline at the boundaries of [west, east], keeping the parts inside.

    A line that leaves the window and comes back is cut into the pieces
    that are actually visible; the cut points are interpolated onto the
    boundary so the line still ends exactly at the edge.
    """
    if len(points) == 0:
        return []
    out: list[list[tuple[float, float]]] = []
    current: list[list[tuple[float, float]]] = []

    for i, (lon, lat) in enumerate(points):
        inside = west <= lon <= east
        if inside:
            if not current and i > 0:
                # Entering: the previous point was outside, so it came in
                # through the side it was on.
                plon, plat = points[i - 1]
                bound = west if plon < west else east
                t = (bound - plon) / (lon - plon) if lon != plon else 0.0
                t = max(0.0, min(1.0, t))
                current.append((bound, plat + (lat - plat) * t))
            current.append((lon, lat))
        elif current:
            # Leaving: the boundary is the side the line went out of.
            plon, plat = points[i - 1]
            bound = west if lon < west else east
            t = (bound - plon) / (lon - plon) if lon != plon else 0.0
            t = max(0.0, min(1.0, t))
            current.append((bound, plat + (lat - plat) * t))
            out.append(current)
            current = []
    if current:
        out.append(current)
    return [seg for seg in out if len(seg) >= 2]


# ═══════════════════════════════════════════════════════════════════════
# Field construction
# ═══════════════════════════════════════════════════════════════════════
def decimal_year(when: datetime | None = None) -> float:
    """UTC decimal year, e.g. 2026.83 on 2026-10-28."""
    when = when or datetime.now(timezone.utc)
    start = datetime(when.year, 1, 1, tzinfo=timezone.utc)
    next_start = datetime(when.year + 1, 1, 1, tzinfo=timezone.utc)
    frac = (when - start).total_seconds() / (next_start - start).total_seconds()
    return when.year + frac


def grid_axes() -> tuple[np.ndarray, np.ndarray]:
    """The 1° global grid: lats ascending from -90, lons from 0.

    The longitude axis is endpoint-EXCLUSIVE (360 columns, 0..359) so it
    wraps cleanly: column 360 is column 0. It uses the GFS convention
    (0..359, not −180..179) because the torus-window arithmetic in
    `contour_scalar` — copied from the isobar pipeline — places the
    clipping window at [origin+180, origin+540] with shift origin+360.
    That formula puts the window EDGES on the antimeridian and the
    prime-meridian seam in the window's interior, which is what a flat
    map in [−180, 180] needs: a line crossing lon 0 continues, a line
    crossing ±180 is cut and reappears on the other edge. With an
    origin of −180 the same formula centres the window on the
    antimeridian instead and every contoured line comes out shifted
    by 180°. The latitude axis is inclusive at both poles (181 rows).
    """
    lats = np.arange(-90.0, 90.0 + GRID_STEP_DEG / 2, GRID_STEP_DEG)
    lons = np.arange(0.0, 360.0 - GRID_STEP_DEG / 2, GRID_STEP_DEG)
    return lats, lons


def build_grids(model: WMMModel, time: float) -> dict[str, np.ndarray]:
    """Evaluate the four components and their rates on the 1° global grid.

    Returns a dict of float arrays — degrees for D/I, nT for F/H, deg/yr
    for Ddot/Idot and nT/yr for Fdot/Hdot — plus `h` (nT), the raw
    components X/Y/Z (nT) which the isogonic contouring needs because
    declination cannot be contoured directly, `mask` (bool, True =
    blackout zone) and the axes.

    The annual change is the analytic chain-rule rate the model itself
    defines (see WMMModel.elements) — NOT a forward difference. A
    one-year D(t+1) − D(t) disagrees with NOAA's published dD/dt by up
    to 0.1°/yr near the dip poles, where D curves fast and H is small.
    """
    lats, lons = grid_axes()
    dt = time - model.epoch

    now = model.elements(lats, lons, dt)

    mask = now["h"] < BLACKOUT_NT
    return {
        "d": now["d"],
        "i": now["i"],
        "f": now["f"],
        "h": now["h"],
        "ddot": now["ddot"],
        "idot": now["idot"],
        "fdot": now["fdot"],
        "hdot": now["hdot"],
        "x": now["x"],
        "y": now["y"],
        "z": now["z"],
        "mask": mask,
        "lats": lats,
        "lons": lons,
    }


# Which float plane each published file holds, in the field's DECLARED
# unit — the one meta.json's `unit` names and the browser divides a
# field's `scale` into. Only the two angle rates need converting: NOAA
# charts them in arcminutes a year (the convention the original four
# planes shipped with), while the contour machinery above works in the
# natural °/yr of the model itself.
PUBLISHED_FROM = {
    "d": lambda g: g["d"],
    "i": lambda g: g["i"],
    "f": lambda g: g["f"],
    "h": lambda g: g["h"],
    "ddot": lambda g: g["ddot"] * 60.0,
    "idot": lambda g: g["idot"] * 60.0,
    "fdot": lambda g: g["fdot"],
    "hdot": lambda g: g["hdot"],
}


def published_planes(grids: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Every published plane, in its declared unit, ready to encode."""
    return {key: np.asarray(fn(grids), dtype=np.float64) for key, fn in PUBLISHED_FROM.items()}


def split_at_mask(points, is_masked):
    """Cut a polyline wherever it enters the blackout mask.

    Charts blank the blackout circle and the lines simply stop at its
    edge, so the polyline is broken into the runs of unmasked vertices
    rather than dropped wholesale — a long isogonic that merely clips
    the cap must survive. The cut lands on a real grid vertex, leaving a
    gap of at most one cell, which is exactly the "stops at the circle"
    look.
    """
    out = []
    current = []
    for lon, lat in points:
        if is_masked(lon, lat):
            if len(current) >= MIN_LINE_POINTS:
                out.append(current)
            current = []
        else:
            current.append((lon, lat))
    if len(current) >= MIN_LINE_POINTS:
        out.append(current)
    return out


def _bilinear(grid, lats, lons, lon, lat):
    """Bilinear sample with longitude wrap; None outside the latitude range."""
    rows = len(lats)
    cols = len(lons)
    step_lat = lats[1] - lats[0]
    step_lon = lons[1] - lons[0]
    row = (lat - lats[0]) / step_lat
    if row < -0.5 or row > rows - 0.5:
        return None
    row = min(max(row, 0.0), rows - 1.0)
    col = (lon - lons[0]) / step_lon
    col = ((col % cols) + cols) % cols
    r0 = min(int(row), rows - 2)
    c0 = min(int(col), cols - 1)
    c1 = (c0 + 1) % cols
    fr = row - r0
    fc = col - c0
    top = grid[r0, c0] * (1 - fc) + grid[r0, c1] * fc
    bot = grid[r0 + 1, c0] * (1 - fc) + grid[r0 + 1, c1] * fc
    return float(top * (1 - fr) + bot * fr)


def _mask_predicate(fields: dict[str, np.ndarray]):
    """A (lon, lat) → bool predicate for the blackout zone."""
    mask = fields["mask"]
    lats = fields["lats"]
    lons = fields["lons"]
    rows = len(lats)
    cols = len(lons)
    step_lat = lats[1] - lats[0]
    step_lon = lons[1] - lons[0]

    def is_masked(lon: float, lat: float) -> bool:
        r = int(round((lat - lats[0]) / step_lat))
        c = int(round((lon - lons[0]) / step_lon))
        if r < 0 or r >= rows:
            return False
        c %= cols
        return bool(mask[r, c])

    return is_masked


def contour_scalar(
    grid: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
    level: float,
    simplify_tol: float = SIMPLIFY_TOL_DEG,
) -> list[list[tuple[float, float]]]:
    """Contour one scalar field at one (float) level.

    Returns a list of polylines, each a list of (lon, lat) in degrees.
    This is the float-level driver the isobar pipeline lacks (its
    contour_isobars is hPa/integer-specific). The Gaussian smoothing
    step is omitted: the WMM is a degree-12 spherical harmonic and
    carries no grid-scale noise to remove — smoothing it would only
    blur real structure.

    The polar rows are dropped (LAT_LIMIT_DEG) and the contour is run on
    a longitude TORUS so an antimeridian crossing continues instead of
    stopping at the grid edge.

    `simplify_tol` is the Douglas-Peucker tolerance in degrees. The
    isoporics pass a tighter value (0.01°) because Ddot's steeper
    gradients turn the default 0.03° tolerance into a visible value
    error along the line.
    """
    keep = np.abs(lats) <= LAT_LIMIT_DEG
    work = grid[keep, :]
    wlats = lats[keep]

    # Contour on a TORUS: the field is periodic in longitude, so two
    # copies side by side make the antimeridian seamless.
    ext_grid = np.concatenate([work, work], axis=1)
    ext_lons = np.concatenate([lons, lons + 360.0])

    # The window we keep is the world's [-180, 180] expressed in the
    # extended grid. The seam sits inside it, so a line that wraps the
    # globe is drawn as one continuous curve.
    origin = float(lons[0])
    west, east = origin + 180.0, origin + 540.0
    shift = origin + 360.0

    segments = marching_squares(ext_grid, wlats, ext_lons, level)
    if len(segments) == 0:
        return []
    out: list[list[tuple[float, float]]] = []
    for line in stitch_segments(segments):
        if len(line) < MIN_LINE_POINTS:
            continue
        # Round the grid-aligned corners first, then decide which
        # vertices actually earn their place. The simplification
        # tolerance stays below the ~0.06° amplitude Chaikin leaves
        # behind, or it undoes the smoothing and the staircase returns.
        smoothed = chaikin_smooth(line)
        simplified = simplify(smoothed, simplify_tol)
        for part in clip_to_lon_range(simplified, west, east):
            shifted = [(lon - shift, lat) for lon, lat in part]
            if len(shifted) >= MIN_LINE_POINTS:
                out.append(shifted)
    return out


def contour_isogonics(
    fields: dict[str, np.ndarray],
) -> list[tuple[float, list[tuple[float, float]]]]:
    """Equal-declination contours, via the branch-cut-free S_L trick.

    Contouring D directly would draw a FALSE line wherever the field
    crosses the ±180 branch cut (a corner at +179° beside one at −179°
    straddles every level). Instead each level L is the zero set of the
    smooth scalar S_L = Y·cos L − X·sin L = H·sin(D−L), which has no
    branch cut. That zero set holds BOTH the D = L line and the
    D = L+180 line; the companion P_L = X·cos L + Y·sin L = H·cos(D−L)
    is positive on the first and negative on the second, so its sign
    tells the two apart.

    Only L ∈ [−90, 90) is contoured — L and L+180 share a zero set, so
    that covers the circle exactly once — and each component is then
    ASSIGNED the level it belongs to: L where P_L > 0, else L+180
    wrapped into [−180, 180). Dropping the P_L < 0 half instead would
    silently delete the entire ±100…±180 family, the lines that circle
    each magnetic pole where the compass points south of geographic
    north — half the chart around both poles.

    Contoured at the MINOR interval (2°); the caller tags every-10°
    levels as index contours via lines_to_geojson.

    Returns [(level_deg, polyline), ...].
    """
    x = fields["x"]
    y = fields["y"]
    lats = fields["lats"]
    lons = fields["lons"]
    is_masked = _mask_predicate(fields)

    levels = np.arange(-90.0, 90.0, ISO_MINOR_DEG)
    results: list[tuple[float, list[tuple[float, float]]]] = []
    for level in levels:
        rad = math.radians(level)
        cos_l = math.cos(rad)
        sin_l = math.sin(rad)
        s_field = y * cos_l - x * sin_l
        p_field = x * cos_l + y * sin_l
        for line in contour_scalar(s_field, lats, lons, 0.0):
            # The zero set of S_L contains BOTH the D = L and the
            # D = L+180 branches — they are sin(0) and sin(180) zeros of
            # the same field — and the two converge at the dip pole where
            # H → 0. The stitch walks straight through that meeting point
            # (the branches are nearly collinear there), so ONE polyline
            # can start on the −L branch and continue on the +L branch.
            # A single level for the whole polyline then mislabels one of
            # them — which is how the ±100…±180 family got stolen by the
            # mid-levels. P_L = ±H on the zero set, so its SIGN tells the
            # branches apart: cut the line wherever the sign flips and
            # assign each constant-sign run its own level. The cut lands
            # in the blackout zone (H → 0 is exactly where the branches
            # meet), which is masked out of the chart anyway.
            runs: list[tuple[bool, list[tuple[float, float]]]] = []
            current: list[tuple[float, float]] = []
            current_positive: bool | None = None
            for lon, lat in line:
                pv = _bilinear(p_field, lats, lons, lon, lat)
                if pv is None:
                    if current:
                        current.append((lon, lat))
                    continue
                positive = pv > 0.0
                if current_positive is None or positive == current_positive:
                    current.append((lon, lat))
                    current_positive = positive
                else:
                    if len(current) >= MIN_LINE_POINTS:
                        runs.append((current_positive, current))
                    # The transition vertex starts the new run; the old
                    # one ends just before it.
                    current = [(lon, lat)]
                    current_positive = positive
            if len(current) >= MIN_LINE_POINTS and current_positive is not None:
                runs.append((current_positive, current))
            for positive, run in runs:
                assigned = float(level) if positive else float(level) + 180.0
                if assigned >= 180.0:
                    assigned -= 360.0
                for piece in split_at_mask(run, is_masked):
                    results.append((assigned, piece))
    # Merge the fragments the mask split and the stitch left behind, so
    # the browser draws ~tens of paths, not thousands.
    merged = merge_lines(results)
    return [
        (lvl, pts) for lvl, pts in merged
        if len(pts) >= MIN_LINE_POINTS and polyline_length(pts) >= MIN_LINE_LENGTH_DEG
    ]


def _mask_off(_lon: float, _lat: float) -> bool:
    """A blackout predicate that never fires — for fields that are
    perfectly defined where a compass is not (F, H, I and three of the
    four rates)."""
    return False


def _levels_for(key: str) -> list[float]:
    """The contour levels of one family, on an EXACT step.

    Built by multiplying integers rather than by repeated float
    addition: 0.05 accumulated thirteen times drifts, and a level that
    lands at 0.1499999999999999 instead of 0.15 contours a hair beside
    the line it claims to be.
    """
    spec = LINE_INTERVALS[key]
    minor = spec["minor"]
    lo, hi = spec["span"]
    k0 = math.ceil(lo / minor - 1e-9)
    k1 = math.floor(hi / minor + 1e-9)
    return [round(k * minor, 9) for k in range(k0, k1 + 1)]


def contour_generic(
    fields: dict[str, np.ndarray],
    key: str,
) -> list[tuple[float, list[tuple[float, float]]]]:
    """Contour one plain-scalar field at its family's levels.

    Every field EXCEPT declination is a plain scalar with no ±180 branch
    cut: inclination lives in [−90, +90], F and H are magnitudes, and a
    secular-variation rate is not an angle at all — so those seven go
    straight through marching squares. (Declination needs the S_L/P_L
    trick in contour_isogonics, because a cell straddling the ±180 wrap
    would draw a false contour line wherever the field wraps.)

    The blackout zone is cut into the line ONLY for the fields whose
    FIELDS_SPEC entry says `boz` — see the note there: H and F are
    perfectly well defined where a compass is not, so blanking them
    would delete the poles from precisely the charts that show them.
    """
    spec = LINE_INTERVALS[key]
    grid = fields[key]
    lats = fields["lats"]
    lons = fields["lons"]
    is_masked = _mask_predicate(fields) if FIELDS_SPEC[key]["boz"] else _mask_off

    results: list[tuple[float, list[tuple[float, float]]]] = []
    for level in _levels_for(key):
        for line in contour_scalar(
            grid, lats, lons, level,
            simplify_tol=spec.get("simplify_tol", SIMPLIFY_TOL_DEG),
        ):
            for piece in split_at_mask(line, is_masked):
                results.append((float(level), piece))
    merged = merge_lines(results)
    min_len = spec.get("min_length", MIN_LINE_LENGTH_DEG)
    return [
        (lvl, pts) for lvl, pts in merged
        if len(pts) >= MIN_LINE_POINTS and polyline_length(pts) >= min_len
    ]


def contour_field(
    fields: dict[str, np.ndarray],
    key: str,
) -> list[tuple[float, list[tuple[float, float]]]]:
    """Contour one published field, dispatching to the right machinery.

    Declination is the only field that cannot go through the generic
    path (see contour_isogonics); everything else does.
    """
    if key == "d":
        return contour_isogonics(fields)
    if key not in LINE_INTERVALS:
        raise KeyError(f"no contour family for field {key!r}")
    return contour_generic(fields, key)


def contour_isoclinics(
    fields: dict[str, np.ndarray],
) -> list[tuple[float, list[tuple[float, float]]]]:
    """Equal-inclination contours — kept under its chart name.

    Inclination lives in [−90, +90] with no branch cut, so it is
    contoured directly; the ±90 levels are the dip poles themselves
    (points, not lines) and are never contoured — hence the ±80 span.
    """
    return contour_generic(fields, "i")


def contour_isoporics(
    fields: dict[str, np.ndarray],
) -> list[tuple[float, list[tuple[float, float]]]]:
    """Equal-annual-change contours of declination — the original
    isoporic family, kept under its name.

    Ddot is a plain rate in °/yr — no angle wrap, no branch cut — so it
    is contoured directly like inclination. These are the lines that
    show WHERE the compass reading is drifting and how fast: the
    Ddot = 0 line is "no change" (the neon-green centre of the wash),
    ±1 °/yr marks fast drift.
    """
    return contour_generic(fields, "ddot")


# ═══════════════════════════════════════════════════════════════════════
# Verify gate — NOAA's own published test values
# ═══════════════════════════════════════════════════════════════════════
def parse_test_values(path: str = TEST_VALUES_PATH) -> list[dict]:
    """Parse WMM2025_TestValues.txt, the table NCEI ships inside the
    coefficient zip.

    Columns (whitespace-separated, after a '#' header):
        date, alt_km, lat, lon, D, I, H, X, Y, Z, F,
        dD/dt, dI/dt, dH/dt, dX/dt, dY/dt, dZ/dt, dF/dt
    D and I are in degrees; the dots are per year (dD/dt and dI/dt in
    °/yr, dH/dt and dF/dt in nT/yr). H, F, dH/dt and dF/dt are read too
    — they are the only published numbers that check the four components
    this overlay gained on top of the original D/I pair.

    The altitudes reach 94 km, so the synthesis has to honour altitude —
    the overlay itself is evaluated at sea level.
    """
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 18:
                continue

            def num(s):
                try:
                    return float(s)
                except ValueError:
                    return float("nan")

            rows.append(
                {
                    "time": float(parts[0]),
                    "alt": float(parts[1]),
                    "lat": float(parts[2]),
                    "lon": float(parts[3]),
                    "d": num(parts[4]),
                    "i": num(parts[5]),
                    "h": num(parts[6]),
                    "x": num(parts[7]),
                    "y": num(parts[8]),
                    "z": num(parts[9]),
                    "f": num(parts[10]),
                    "ddot": num(parts[11]),
                    "idot": num(parts[12]),
                    "hdot": num(parts[13]),
                    "fdot": num(parts[17]),
                }
            )
    return rows


def _wrap_err(err: float, period: float = 360.0) -> float:
    """The smaller of err and period − err — for ANGULAR differences.

    An error of 359.9° on a quantity that lives on a circle is really an
    error of 0.1°; treating it as 359.9 would fail a correct model.
    """
    return min(err, period - err)


def verify(model: WMMModel | None = None, verbose: bool = False) -> None:
    """Check the model against NOAA's published test values, then check
    the computed grids against physical relationships.

    This is a GATE, not a checkpoint: it raises SystemExit on any
    failure. A sign-flipped or axis-swapped synthesis still produces a
    field that LOOKS like Earth's magnetic field — plausible swirls, a
    plausible equator, plausible polar caps — so only known-point
    probes against numbers computed by somebody else can catch it. The
    test values below are published by NCEI alongside the model itself.
    """
    if model is None:
        model = WMMModel()

    rows = parse_test_values()
    if not rows:
        raise SystemExit(f"[magmap] no test values in {TEST_VALUES_PATH}")

    # The test file spans several dates and altitudes; check every row
    # whose date falls inside the model's 5-year life span.
    worst_d = 0.0
    worst_i = 0.0
    worst_xyz = 0.0
    worst_fh = 0.0        # F and H, the two magnitudes
    worst_ddot = 0.0
    worst_idot = 0.0
    worst_fh_dot = 0.0    # dF/dt and dH/dt, in nT/yr
    checked = 0
    for row in rows:
        t = row["time"]
        if not (model.epoch - 1e-9 <= t <= model.epoch + 5.0 + 1e-9):
            continue
        dt = t - model.epoch
        lats = np.array([row["lat"]])
        lons = np.array([row["lon"]])
        els = model.elements(lats, lons, dt, alt_km=row["alt"])
        d_calc = float(els["d"][0, 0])
        i_calc = float(els["i"][0, 0])
        x_calc = float(els["x"][0, 0])
        y_calc = float(els["y"][0, 0])
        z_calc = float(els["z"][0, 0])
        # F and H come out of the same synthesis as X/Y/Z, and the test
        # file quotes both to six decimals — but they are DERIVED
        # quantities (magnitudes), so a bug in the geodetic rotation
        # could survive an X/Y/Z check only if it cancelled, and an
        # independent gate on them costs nothing.
        f_calc = float(els["f"][0, 0])
        h_calc = float(els["h"][0, 0])
        # Annual change: the same analytic rate the worker publishes.
        ddot_calc = float(els["ddot"][0, 0])
        idot_calc = float(els["idot"][0, 0])
        fdot_calc = float(els["fdot"][0, 0])
        hdot_calc = float(els["hdot"][0, 0])

        err_d = _wrap_err(abs(d_calc - row["d"]))
        err_i = abs(i_calc - row["i"])
        err_xyz = max(
            abs(x_calc - row["x"]), abs(y_calc - row["y"]), abs(z_calc - row["z"])
        )
        err_fh = max(abs(f_calc - row["f"]), abs(h_calc - row["h"]))
        # The rates are deg/yr — small numbers near zero, so a plain
        # absolute difference is right; wrapping them as angles would
        # mask a real disagreement as a tiny one.
        err_ddot = abs(ddot_calc - row["ddot"])
        err_idot = abs(idot_calc - row["idot"])
        err_fh_dot = max(
            abs(fdot_calc - row["fdot"]), abs(hdot_calc - row["hdot"])
        )

        worst_d = max(worst_d, err_d)
        worst_i = max(worst_i, err_i)
        worst_xyz = max(worst_xyz, err_xyz)
        worst_fh = max(worst_fh, err_fh)
        worst_ddot = max(worst_ddot, err_ddot)
        worst_idot = max(worst_idot, err_idot)
        worst_fh_dot = max(worst_fh_dot, err_fh_dot)
        checked += 1
        if verbose:
            log.info(
                "test %7.2f %7.2f t=%.1f  D err %.4f°  I err %.4f°  "
                "XYZ err %.2f nT  F/H err %.4f nT  Ddot err %.5f°/yr  "
                "Idot err %.5f°/yr  Fdot/Hdot err %.5f nT/yr",
                row["lat"], row["lon"], t, err_d, err_i, err_xyz, err_fh,
                err_ddot, err_idot, err_fh_dot,
            )

    if checked == 0:
        raise SystemExit(
            f"[magmap] no test values fall inside {model.model}'s life span"
        )
    if worst_d > TEST_D_TOL_DEG:
        raise SystemExit(
            f"[magmap] DECLINATION fails the NOAA test gate: worst error "
            f"{worst_d:.4f}° > {TEST_D_TOL_DEG}° over {checked} points"
        )
    if worst_i > TEST_I_TOL_DEG:
        raise SystemExit(
            f"[magmap] INCLINATION fails the NOAA test gate: worst error "
            f"{worst_i:.4f}° > {TEST_I_TOL_DEG}° over {checked} points"
        )
    if worst_xyz > TEST_XYZ_TOL_NT:
        raise SystemExit(
            f"[magmap] X/Y/Z fails the NOAA test gate: worst error "
            f"{worst_xyz:.2f} nT > {TEST_XYZ_TOL_NT} nT over {checked} points"
        )
    if worst_fh > TEST_XYZ_TOL_NT:
        raise SystemExit(
            f"[magmap] F/H fails the NOAA test gate: worst error "
            f"{worst_fh:.4f} nT > {TEST_XYZ_TOL_NT} nT over {checked} points"
        )
    if worst_ddot > TEST_SV_TOL_DEG_YR:
        raise SystemExit(
            f"[magmap] SECULAR VARIATION fails the NOAA test gate: worst "
            f"Ddot error {worst_ddot:.5f}°/yr > {TEST_SV_TOL_DEG_YR}°/yr"
        )
    if worst_idot > TEST_SV_TOL_DEG_YR:
        raise SystemExit(
            f"[magmap] SECULAR VARIATION fails the NOAA test gate: worst "
            f"Idot error {worst_idot:.5f}°/yr > {TEST_SV_TOL_DEG_YR}°/yr"
        )
    if worst_fh_dot > TEST_SV_TOL_NT_YR:
        raise SystemExit(
            f"[magmap] F/H SECULAR VARIATION fails the NOAA test gate: worst "
            f"error {worst_fh_dot:.5f} nT/yr > {TEST_SV_TOL_NT_YR} nT/yr"
        )
    log.info(
        "NOAA test gate passed: %d points, worst D %.4f°, I %.4f°, "
        "XYZ %.2f nT, F/H %.4f nT, Ddot %.5f°/yr, Idot %.5f°/yr, "
        "Fdot/Hdot %.5f nT/yr",
        checked, worst_d, worst_i, worst_xyz, worst_fh,
        worst_ddot, worst_idot, worst_fh_dot,
    )

    # ── Relationship checks on the whole computed grid ────────────────
    # These are bounds and relationships that MUST hold for Earth's
    # field. They catch a class of bug the sparse test points can miss
    # (a vectorization slip that is exact at the test latitudes but
    # wrong in between).
    grids = build_grids(model, model.epoch)
    d = grids["d"]
    inc = grids["i"]
    h = grids["h"]
    mask = grids["mask"]
    lats = grids["lats"]

    if not np.all(np.isfinite(d)) or not np.all(np.isfinite(inc)):
        raise SystemExit("[magmap] non-finite values in the computed D/I grid")

    # Declination is an angle; inclination is a dip in [−90, +90].
    if np.abs(d).max() > 180.0 + 1e-6:
        raise SystemExit(f"[magmap] declination out of range: {np.abs(d).max():.3f}°")
    if np.abs(inc).max() > 90.0 + 1e-6:
        raise SystemExit(f"[magmap] inclination out of range: {np.abs(inc).max():.3f}°")

    # Inclination must FLIP SIGN across the magnetic equator: positive
    # (downward, northern) in the far north, negative in the far south.
    # A field that forgot the sign of Z would be uniformly one-sided.
    north = inc[lats >= 70.0]
    south = inc[lats <= -70.0]
    if not (north.min() > 0.0):
        raise SystemExit(
            f"[magmap] inclination is not positive at the north pole "
            f"(min {north.min():.2f}°) — the vertical component's sign is wrong"
        )
    if not (south.max() < 0.0):
        raise SystemExit(
            f"[magmap] inclination is not negative at the south pole "
            f"(max {south.max():.2f}°) — the vertical component's sign is wrong"
        )

    # Horizontal intensity is positive-definite by construction and must
    # collapse near the dip poles (that is what a blackout zone IS).
    if h.min() < 0.0:
        raise SystemExit("[magmap] horizontal intensity went negative")
    if h.min() >= BLACKOUT_NT:
        raise SystemExit(
            f"[magmap] no blackout zone found: min H = {h.min():.0f} nT never "
            f"drops below {BLACKOUT_NT:.0f} nT, but the dip poles must"
        )
    if h.max() < 20000.0:
        raise SystemExit(
            f"[magmap] max horizontal intensity {h.max():.0f} nT is far too "
            "weak for Earth's field"
        )

    # The blackout mask must be two small polar caps, not a stripe or a
    # hemisphere. Bounding the FRACTION is the cheap way to see that.
    frac = float(mask.mean())
    if not (0.0005 < frac < 0.05):
        raise SystemExit(
            f"[magmap] blackout zone covers {frac * 100:.2f}% of the grid — "
            "expected well under 5% (two small caps)"
        )
    masked_lats = np.broadcast_to(lats[:, None], mask.shape)[mask]
    if len(masked_lats) and (masked_lats.min() > -60.0 or masked_lats.max() < 60.0):
        raise SystemExit(
            f"[magmap] the blackout zone is not polar: masked latitudes span "
            f"{masked_lats.min():.0f}°..{masked_lats.max():.0f}°"
        )

    # ── the four components, and their ramps ────────────────────────────
    # F, H and the four rates are checked the same way the angle fields
    # are: not for looking right, but for RELATIONSHIPS that hold only
    # if the planes are what they claim to be. `f >= h` follows from
    # F = sqrt(H² + Z²); a transposed pair, a wrong sign or a scale
    # applied twice breaks it instantly while still painting a
    # plausible-looking wash.
    planes = published_planes(grids)
    f = planes["f"]
    h = planes["h"]
    z = grids["z"]
    eps = 1e-6
    if not (f >= h - eps).all():
        bad = float((f < h - eps).sum())
        raise SystemExit(
            f"[magmap] F < H in {bad:.0f} cells — F = sqrt(H²+Z²) can never "
            "be smaller than H, so the two planes are swapped or one is wrong"
        )
    if not (f >= np.abs(z) - eps).all():
        raise SystemExit("[magmap] F < |Z| somewhere — F = sqrt(H²+Z²) violation")
    if not (h >= -eps).all():
        raise SystemExit("[magmap] horizontal intensity went negative")

    # Every field must be finite, its ramp must BRACKET every cell the
    # wash can paint, and the cell must survive the Int16 encode without
    # clipping. All three are checked over the VISIBLE cells only: the
    # angle rates legitimately blow up inside the blackout zone (dD/dt
    # divides by H²), where the wash is transparent and the probe says
    # so — clamping there is by design, and a ramp wide enough to
    # contain it would waste the whole colour budget on two caps.
    ramp_spec = RAMP_SPEC
    for key in FIELD_ORDER:
        plane = planes[key]
        visible = np.ones_like(plane, dtype=bool) if not FIELDS_SPEC[key]["boz"] else ~mask
        sub = plane[visible]
        if not np.isfinite(sub).all():
            raise SystemExit(f"[magmap] {key} has non-finite values in the visible field")
        spec = ramp_spec[key]
        lo, hi = (-spec["span"], spec["span"]) if spec["kind"] == "diverging" else (spec["lo"], spec["hi"])
        if sub.min() < lo - 1e-6 or sub.max() > hi + 1e-6:
            raise SystemExit(
                f"[magmap] the {key} ramp [{lo:g}, {hi:g}] does not bracket the "
                f"field [{sub.min():.3f}, {sub.max():.3f}] — the wash would "
                "saturate; widen RAMP_SPEC"
            )
        scale = FIELDS_SPEC[key]["scale"]
        peak = float(np.abs(sub).max()) * scale
        if peak > INT16_HEADROOM:
            raise SystemExit(
                f"[magmap] {key} reaches {peak:.0f} in Int16 at scale "
                f"{scale} > {INT16_HEADROOM:.0f} — encode_plane would clip it "
                "(raise the field's range, or give it a smaller scale)"
            )
    log.info(
        "relationship gate passed: blackout covers %.2f%% of the grid, "
        "latitudes %.0f°..%.0f°; F %.0f…%.0f nT, H %.0f…%.0f nT; "
        "all 8 planes bracketed by their ramps and inside Int16",
        frac * 100, masked_lats.min(), masked_lats.max(),
        float(planes["f"].min()), float(planes["f"].max()),
        float(planes["h"].min()), float(planes["h"].max()),
    )


# ═══════════════════════════════════════════════════════════════════════
# Outputs
# ═══════════════════════════════════════════════════════════════════════
def encode_plane(values: np.ndarray, scale: int = SCALE) -> bytes:
    """Quantize a float plane to little-endian Int16.

    Values are clamped to the int16 range after scaling. The wash and
    the probe both read this one buffer, so what you read IS the colour
    you are looking at.
    """
    quantized = np.round(np.asarray(values, dtype=np.float64) * scale)
    quantized = np.clip(quantized, np.iinfo(np.int16).min, np.iinfo(np.int16).max)
    return quantized.astype("<i2").tobytes()


def isogonic_label(level: float) -> str:
    """A short label for an isogonic line, e.g. '10°E', 'Agonic'."""
    if abs(level) < 1e-9:
        return "Agonic"
    direction = "E" if level > 0 else "W"
    return f"{abs(level):g}°{direction}"


def isoclinic_label(level: float) -> str:
    """A short label for an isoclinic line, e.g. '45°', 'Aclinic'."""
    if abs(level) < 1e-9:
        return "Aclinic"
    return f"{level:g}°"


def isoporic_label(level: float) -> str:
    """A short label for an isoporic line, e.g. '+0.5°/yr', 'No change'."""
    if abs(level) < 1e-9:
        return "No change"
    sign = "+" if level > 0 else "−"
    return f"{sign}{abs(level):g}°/yr"


def isodynamic_label(level: float) -> str:
    """A short label for an equal-FORCE line, e.g. '50,000 nT'.

    Used for both the total-force (isodynamics) and horizontal-force
    (isohorizontals) families: same unit, same job, and keeping the
    thousands separator is what makes a nT contour readable at a glance
    ("50,000" reads as a magnitude, "50000" as an index).
    """
    return f"{level:,.0f} nT"


def ntrate_label(level: float) -> str:
    """A short label for a rate line in nT/yr, e.g. '+12 nT/yr'.

    The ΔF and ΔH isoporics, which are NOT in degrees — isoporic_label
    would print '+12°/yr' on a line that means 12 nanotesla a year.
    """
    if abs(level) < 1e-9:
        return "No change"
    sign = "+" if level > 0 else "−"
    return f"{sign}{abs(level):g} nT/yr"


_LABEL_FNS = {
    "isogonic": isogonic_label,
    "isoclinic": isoclinic_label,
    "isoporic": isoporic_label,
    "isodynamic": isodynamic_label,
    "isohorizontal": isodynamic_label,
    # The ΔF / ΔH families are isoporic LINES carrying nT/yr values, so
    # they name their label function instead of relying on `kind`.
    "isoporic-nt": ntrate_label,
}

# The zero line of each family is the chart's landmark and gets a name.
# The force families have no landmark: F never reaches zero inside its
# range and an H = 0 contour sits under the polar rows the contourer
# drops, so .get() returns None for them rather than raising.
_SPECIALS = {
    "isogonic": "agonic",      # compass reads true north
    "isoclinic": "aclinic",    # magnetic equator
    "isoporic": "nochange",    # the value is not changing
}


def _is_index_level(level: float, major_interval: float) -> bool:
    """True when a level falls on an index (major, labelled) contour."""
    return abs(level / major_interval - round(level / major_interval)) < 1e-9


def lines_to_geojson(
    lines: list[tuple[float, list[tuple[float, float]]]],
    kind: str,
    major_interval: float,
    label_fn=None,
) -> dict:
    """Turn [(level, polyline)] into a GeoJSON FeatureCollection.

    Every feature is tagged `major: true|false`. Index (major) contours
    fall on multiples of `major_interval` and are the labelled, always-
    visible lines; intermediate (minor) contours fill in between and the
    frontend hides them below zoom 4 — the way a topographic map draws
    thin contours between its bold index contours.

    `label_fn` overrides the label function chosen by `kind`: the ΔF and
    ΔH families are isoporic lines whose values are in nT/yr, and the
    default isoporic label would print them as degrees. The three
    families that shipped first pass no override and behave exactly as
    before.

    Coordinates are rounded to 3 decimals (~100 m) to keep the static
    file small; that is far finer than the 0.03° simplification
    tolerance, so no visible detail is lost.
    """
    label_fn = label_fn or _LABEL_FNS[kind]
    features = []
    for level, polyline in lines:
        if len(polyline) < MIN_LINE_POINTS:
            continue
        coords = [[round(lon, 3), round(lat, 3)] for lon, lat in polyline]
        special = _SPECIALS.get(kind) if abs(level) < 1e-9 else None
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "level": round(level, 4),
                    "kind": kind,
                    "major": _is_index_level(level, major_interval),
                    "special": special,
                    "label": label_fn(level),
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def diverging_ramp(span: float, plateau: float) -> list[dict]:
    """A violet → azure → **vivid cyan (zero)** → gold → crimson ramp.

    The convention for diverging scales holds: cool colours negative,
    warm colours positive, a bright landmark at zero. Two things changed
    on 2026-10-30, both driven by looking at the rendered field rather
    than at swatches:

    1. **NO GREEN.** The old ramp was blue → green → red with a
       neon-green plateau flanked by a pale green and a yellow-green —
       "green on both sides of zero" — and since the ΔD plateau covers
       most of the globe, the map looked like a green ball. The centre is
       now CYAN (#00e5ff, hue 190° — blue side of cyan), the negative
       wing sweeps violet → azure and the positive wing gold → crimson,
       so the whole chart is a spectrum with no green stop on it.

    2. **SATURATED, not pastel.** The first attempt used an ice-white
       centre (#a8fbff). Half the map lands inside the plateau, and a
       pastel over half a map reads as *washed out* — the rendered D
       field came out pale cyan where the old green had at least been
       vivid. A fully saturated cyan still glows on a dark basemap (the
       whole reason zero does not simply go grey) while staying a
       colour. The wings are saturated too, so the step from wing to
       centre is a hue change, not a tint change.

    `plateau` is the half-width of the FLAT centre band: values inside
    ±plateau are all the same cyan, so it marks "effectively nothing
    happening". It was also narrowed in the same pass (D 10° → 6°,
    I 5° → 3°, ΔD 6′/yr → 4′/yr, …) because a wide flat band is the
    other half of what made the chart monotonous — a narrower one lets
    the gradient show.

    The "inner" stop (the shoulder either side of the plateau) is
    clamped to 15 % of the span. For a narrow field like Idot the old
    plateau·2.5 could land OUTSIDE the wing stop (span·0.2) and rely on
    the sort below to put it back — which silently swaps the two
    colours' positions. Clamping keeps the stops monotonic by
    construction; the sort stays as a safety net.

    Stops are absolute values; the frontend interpolates between them.
    """
    inner = min(plateau * 2.5, span * 0.15)
    stops = [
        (-span, "#4a00e6"),        # violet — the negative extreme
        (-span * 0.5, "#1a3cff"),  # blue
        (-span * 0.2, "#0072ff"),  # azure
        (-inner, "#00b8ff"),       # sky shoulder
        (-plateau, "#00e5ff"),     # VIVID CYAN — the zero plateau, both sides
        (plateau, "#00e5ff"),
        (inner, "#ffd21e"),        # gold shoulder
        (span * 0.2, "#ff9500"),   # amber
        (span * 0.5, "#ff4d1f"),   # orange
        (span, "#d50033"),         # crimson — the positive extreme
    ]
    stops.sort(key=lambda s: s[0])
    return [{"c": c, "rgb": rgb} for c, rgb in stops]


# The sequential ramp for the two MAGNITUDE fields (F and H). A
# diverging ramp is wrong for them: they are one-sided, so half the
# spectrum would be spent on values that never occur and the blue end
# would read as "negative" on a field that has no negative.
#
# Indigo → violet → rose → amber → pale yellow: a full sweep of warm
# colour with NO green anywhere (the previous teal → lime → orange ramp
# put green across the middle of every force chart). It reads as a
# modern scientific ramp rather than a rainbow, and the low end is a
# saturated indigo rather than near-black — a weak-field patch (the
# South Atlantic Anomaly) has to stay visible against a night-lights
# basemap instead of disappearing into it.
SEQUENTIAL_STOPS = [
    (0.00, "#2a1b7e"),
    (0.18, "#7e03a8"),
    (0.42, "#cc4778"),
    (0.65, "#f89540"),
    (0.85, "#ffd23a"),
    (1.00, "#fff07a"),
]


def sequential_ramp(lo: float, hi: float, stops=SEQUENTIAL_STOPS) -> list[dict]:
    """A blue → red ramp across [lo, hi] for a one-sided magnitude.

    Stops are given as FRACTIONS of the range and converted to absolute
    values here, for the reason the diverging ramp's plateau is fixed in
    absolute units: the frontend's rampColor() interpolates between
    absolute `c` values in the field's own units, so the ramp and the
    wash must agree without the browser doing arithmetic of its own.
    The fraction stops are already ascending, so the output is too.
    """
    lo = float(lo)
    hi = float(hi)
    if hi <= lo:
        hi = lo + 1.0
    return [{"c": lo + f * (hi - lo), "rgb": rgb} for f, rgb in stops]


def diverging_alpha(span: float, plateau: float) -> list[dict]:
    """Alpha stops for a diverging wash: TRANSPARENT at zero, opaque at
    the wings.

    The colour ramp answers "which colour"; this answers "how much of it
    you see". Zero means nothing is happening, so the basemap should
    show straight through it — and for ΔD the plateau covers ~52 % of
    the globe, so an opaque core paints a cyan ball over half the world
    (the exact complaint that produced the 2026-10-30 redesign of the
    COLOUR). The wings carry the real signal and stay saturated.

    Stops are keyed on t (the ramp position 0..1), the same contract the
    lightning layer publishes as `meta.alpha` — the client interpolates
    one table per LUT entry, never per pixel. The transparent band is
    derived from the SAME plateau the colour uses, so the see-through
    core and the flat cyan band are always the same width.
    """
    inner = min(plateau * 2.5, span * 0.15)

    def t(v: float) -> float:
        return (v + span) / (2.0 * span)

    stops = [
        (0.0, 240),
        (t(-span * 0.5), 226),
        (t(-span * 0.2), 198),
        (t(-inner), 132),
        (t(-plateau), 56),
        (0.5, 40),           # the zero core — nearly clear
        (t(plateau), 56),
        (t(inner), 132),
        (t(span * 0.2), 198),
        (t(span * 0.5), 226),
        (1.0, 240),
    ]
    stops.sort(key=lambda s: s[0])
    return [{"t": round(tt, 6), "a": a} for tt, a in stops]


def sequential_alpha() -> list[dict]:
    """Alpha stops for a one-sided magnitude (F, H).

    A weak field is as physically real as a strong one, but it is not
    as INTERESTING — so the wash thins out where the field is weak and
    solidifies where it is strong. The South Atlantic Anomaly therefore
    reads as a hole in the wash, which is exactly what it is.
    """
    return [
        {"t": 0.00, "a": 40},
        {"t": 0.18, "a": 96},
        {"t": 0.42, "a": 162},
        {"t": 0.65, "a": 208},
        {"t": 0.85, "a": 232},
        {"t": 1.00, "a": 244},
    ]


def check_alpha_tables(fields_meta: dict[str, dict]) -> None:
    """Gate the published alpha tables, the same way the ramps are gated.

    A transparent core is the POINT of the diverging tables; a client
    that receives none falls back to fully opaque (its own
    `alphaAt` returns 255), so a missing or inverted table is invisible
    in code review and only shows up as a painted-over basemap.
    """
    for key, fm in fields_meta.items():
        alpha = fm.get("alpha")
        if not alpha:
            raise SystemExit(f"[magmap] {key} publishes no alpha table")
        ts = [s["t"] for s in alpha]
        if ts != sorted(ts):
            raise SystemExit(f"[magmap] {key} alpha stops do not ascend: {ts}")
        if ts[0] < 0 or ts[-1] > 1:
            raise SystemExit(f"[magmap] {key} alpha t outside [0,1]: {ts}")
        for s in alpha:
            if not (0 <= s["a"] <= 255):
                raise SystemExit(f"[magmap] {key} alpha {s['a']} outside 0..255")
        if RAMP_SPEC[key]["kind"] == "diverging":
            core = min(alpha, key=lambda s: abs(s["t"] - 0.5))
            if core["a"] >= 80:
                raise SystemExit(
                    f"[magmap] {key} alpha at zero is {core['a']} — the "
                    "plateau must let the basemap through (< 80)")
            for edge in (alpha[0], alpha[-1]):
                if edge["a"] < 200:
                    raise SystemExit(
                        f"[magmap] {key} alpha {edge['a']} at the extreme — "
                        "the wings carry the signal and stay solid (>= 200)")
        else:
            if alpha[0]["a"] >= 80 or alpha[-1]["a"] < 200:
                raise SystemExit(
                    f"[magmap] {key} sequential alpha must rise from a "
                    "ghost to a solid wash")


def write_outputs(
    grids: dict[str, np.ndarray],
    lines: dict[str, list[tuple[float, list[tuple[float, float]]]]],
    model: WMMModel,
    time: float,
    out_dir: str = OUT_DIR,
) -> dict:
    """Write the EIGHT grid planes, the EIGHT GeoJSON line sets and
    meta.json.

    Deliberately NOT .png: Caddy serves every *.png under public_html
    `immutable` for a year, which would freeze a rebuilt overlay behind
    a stale version token — the exact bug that hid the Köppen layer on
    2026-10-22. grid.bin / meta.json / *.geojson are not in the
    immutable list, so they revalidate.

    meta.fields[k] carries EVERYTHING the browser needs to render that
    field on its own — the file, the unit, the Int16 scale, the ramp,
    its component/mode, whether the blackout zone blanks it, and which
    line set belongs to it — so the selector, the wash, the probe and
    the globe all read one table instead of four hardcoded ones.
    """
    os.makedirs(out_dir, exist_ok=True)

    lats = grids["lats"]
    lons = grids["lons"]
    mask = grids["mask"]
    planes = published_planes(grids)

    for key in FIELD_ORDER:
        with open(os.path.join(out_dir, f"grid_{key}.bin"), "wb") as fh:
            fh.write(encode_plane(planes[key], scale=FIELDS_SPEC[key]["scale"]))
    with open(os.path.join(out_dir, "mask.bin"), "wb") as fh:
        fh.write(mask.astype(np.uint8).tobytes())

    fields_meta: dict[str, dict] = {}
    contours_meta: dict[str, str] = {}
    for key in FIELD_ORDER:
        ramp_spec = RAMP_SPEC[key]
        if ramp_spec["kind"] == "diverging":
            lo, hi = -ramp_spec["span"], ramp_spec["span"]
            ramp = diverging_ramp(ramp_spec["span"], plateau=ramp_spec["plateau"])
        else:
            lo, hi = ramp_spec["lo"], ramp_spec["hi"]
            ramp = sequential_ramp(lo, hi)
        kind, label_key = LINE_KINDS[key]
        intervals = LINE_INTERVALS[key]

        with open(os.path.join(out_dir, LINE_FILES[key]), "w") as fh:
            json.dump(
                lines_to_geojson(
                    lines.get(key, []),
                    kind,
                    intervals["major"],
                    label_fn=_LABEL_FNS[label_key] if label_key else None,
                ),
                fh, separators=(",", ":"),
            )

        fields_meta[key] = {
            "file": f"grid_{key}.bin",
            # The human name, published so a client with no field table
            # of its own (the globe) can label its selector. Removing it
            # renders that client's chips empty.
            "label": FIELDS_SPEC[key]["label"],
            "unit": FIELDS_SPEC[key]["unit"],
            "scale": FIELDS_SPEC[key]["scale"],
            "range": [float(lo), float(hi)],
            "ramp": ramp,
            # How much of the colour to PAINT: transparent at "nothing
            # happening", solid where the signal is. Same {t, a} shape
            # the lightning meta publishes; a client that ignores it
            # just gets the old opaque wash.
            "alpha": (diverging_alpha(ramp_spec["span"], ramp_spec["plateau"])
                      if ramp_spec["kind"] == "diverging" else
                      sequential_alpha()),
            "component": COMPONENT_OF[key],
            "mode": FIELDS_SPEC[key]["mode"],
            # Whether the blackout zone blanks this field. Only D and
            # ΔD lose their meaning where H collapses — see FIELDS_SPEC.
            "boz": FIELDS_SPEC[key]["boz"],
            "lines": LINE_FILES[key],
            "line_kind": kind,
            "line_minor": intervals["minor"],
            "line_major": intervals["major"],
            # The below-zoom-5 label spacing the frontend applies.
            "label_step": LABEL_STEP[key],
        }
        contours_meta[LINE_FILES[key].replace(".geojson", "").replace("-", "_")] = LINE_FILES[key]

    # Gate the alpha tables before anything is written — a transparent
    # core is the whole point, and a client that receives a broken table
    # silently paints over the basemap.
    check_alpha_tables(fields_meta)

    meta = {
        "source": "NOAA NCEI / British Geological Survey World Magnetic Model",
        "attribution": "NOAA NCEI / BGS (WMM2025)",
        "license": "US Government work — public domain",
        "url": "https://www.ncei.noaa.gov/products/world-magnetic-model",
        # Where NOAA publishes the same field as ready-made contour
        # shapefiles (D/I/H/X/Y/Z/F and their rates). Those are LINES
        # only — no grids — so the wash and the probe would still have
        # to come from the coefficient file, and mixing the two would
        # make the colour and the line disagree. Recorded as the
        # upstream published product of this overlay.
        "shapefiles": "https://data.ngdc.noaa.gov/geomag/wmm/wmm2025/shapefiles/",
        "model": model.model,
        "epoch": model.epoch,
        "release_date": model.release,
        "evaluated_at": round(time, 4),
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grid": {
            "lat_min": float(lats[0]),
            "lat_step": float(lats[1] - lats[0]),
            "rows": int(len(lats)),
            "lon_min": float(lons[0]),
            "lon_step": float(lons[1] - lons[0]),
            "cols": int(len(lons)),
            # The DEFAULT scale, for the four fields that shipped first.
            # Per-field scales live in meta.fields[k].scale and are the
            # ones the browser divides by.
            "scale": SCALE,
        },
        "blackout_nt": BLACKOUT_NT,
        # The selector's two dimensions, so the frontend builds its chips
        # from the data rather than from a list that can drift from it.
        "components": [c for c in FIELD_ORDER if FIELDS_SPEC[c]["mode"] == "main"],
        "modes": {
            "main": [k for k in FIELD_ORDER if FIELDS_SPEC[k]["mode"] == "main"],
            "sv": [k for k in FIELD_ORDER if FIELDS_SPEC[k]["mode"] == "sv"],
        },
        "fields": fields_meta,
        "mask": "mask.bin",
        "contours": {
            # The three that shipped first keep their keys verbatim —
            # a browser holding an older meta.json looks these up.
            "isogonics": "isogonics.geojson",
            "isoclinics": "isoclinics.geojson",
            "isoporics": "isoporics.geojson",
            "isodynamics": "isodynamics.geojson",
            "isohorizontals": "isohorizontals.geojson",
            "isoporics_i": "isoporics-i.geojson",
            "isoporics_f": "isoporics-f.geojson",
            "isoporics_h": "isoporics-h.geojson",
            "major_interval_deg": ISO_MAJOR_DEG,
            "minor_interval_deg": ISO_MINOR_DEG,
            "isoporic_minor_interval": ISOPORIC_MINOR_DEG,
        },
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    return meta


# ═══════════════════════════════════════════════════════════════════════
# Vendored coefficient refresh (--fetch)
# ═══════════════════════════════════════════════════════════════════════
def fetch_cof(dest: str = COF_PATH) -> str:
    """Download the current WMM coefficient file from NCEI.

    NCEI is mid-cloud-migration and their downloads have been
    intermittently unavailable, so this is opt-in (--fetch) and the
    vendored copy is what builds actually use.
    """
    import io
    import zipfile

    import httpx

    log.info("fetching %s", WMM_COF_URL)
    with httpx.Client(timeout=60.0, follow_redirects=True) as client:
        resp = client.get(WMM_COF_URL)
        resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        # The zip holds WMM.COF (the generic name) and WMM2025.COF.
        name = "WMM.COF" if "WMM.COF" in zf.namelist() else zf.namelist()[0]
        data = zf.read(name)
    with open(dest, "wb") as fh:
        fh.write(data)
    log.info("wrote %s (%d bytes)", dest, len(data))
    return dest


# ═══════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════
def run(args) -> int:
    if args.fetch:
        fetch_cof()

    if not os.path.exists(COF_PATH):
        raise SystemExit(
            f"[magmap] {COF_PATH} is missing — run with --fetch to download it "
            "from NCEI"
        )

    model = WMMModel()
    log.info(
        "loaded %s (epoch %.1f, released %s, degree %d)",
        model.model, model.epoch, model.release, model.maxord,
    )

    # The verify gate runs on EVERY build, including --dry-run. A model
    # that does not reproduce NOAA's own published numbers must never
    # reach the map.
    verify(model, verbose=args.verbose)

    if args.verify_only:
        return 0

    time = args.time if args.time is not None else decimal_year()
    if not (model.epoch <= time <= model.epoch + 5.0):
        raise SystemExit(
            f"[magmap] time {time} is outside {model.model}'s life span "
            f"{model.epoch}..{model.epoch + 5.0}"
        )

    log.info("building grids at t=%.4f ...", time)
    grids = build_grids(model, time)
    log.info(
        "grids: D ∈ [%.2f, %.2f]°, I ∈ [%.2f, %.2f]°, "
        "F ∈ [%.0f, %.0f] nT, H ∈ [%.0f, %.0f] nT, blackout %.2f%%",
        grids["d"].min(), grids["d"].max(),
        grids["i"].min(), grids["i"].max(),
        grids["f"].min(), grids["f"].max(),
        grids["h"].min(), grids["h"].max(),
        100.0 * float(grids["mask"].mean()),
    )

    # One GeoJSON per published field. Declination takes the special
    # branch-cut-free path; the other seven share contour_generic.
    lines: dict[str, list[tuple[float, list[tuple[float, float]]]]] = {}
    for key in FIELD_ORDER:
        spec = LINE_INTERVALS[key]
        log.info(
            "contouring %s (%s, minor %g, major %g) ...",
            LINE_FILES[key], LINE_KINDS[key][0], spec["minor"], spec["major"],
        )
        lines[key] = contour_field(grids, key)
        log.info("  %d lines", len(lines[key]))

    if args.dry_run:
        log.info("--dry-run: writing nothing")
        return 0

    meta = write_outputs(grids, lines, model, time)
    log.info("wrote %s", OUT_DIR)
    log.info(
        "model %s epoch %.1f, evaluated at %.4f, generated %s",
        meta["model"], meta["epoch"], meta["evaluated_at"], meta["generated"],
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m worker.magmap",
        description="Build the magnetic-field overlay from the World Magnetic Model.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="verify + compute, but write nothing",
    )
    parser.add_argument(
        "--verify-only", action="store_true",
        help="run the NOAA test-value gate and exit",
    )
    parser.add_argument(
        "--fetch", action="store_true",
        help="refresh the vendored WMM.COF from NCEI before building",
    )
    parser.add_argument(
        "--time", type=float, default=None,
        help="evaluate at a specific decimal year (default: now)",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="log each NOAA test point's error",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    return run(args)


if __name__ == "__main__":
    sys_exit = main()
    raise SystemExit(sys_exit)
