import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from worker.suburb_priority import (
    MIN_PARENT_POP,
    _candidates_from,
    refine,
    score_suburb,
    suburb_label,
)

CHICAGO = {"id": 1, "name": "Chicago", "ascii_name": "Chicago",
           "country_code": "US", "state_name": "Illinois",
           "lat": 41.85, "lng": -87.65, "population": 2_700_000}
NAPERVILLE = {"id": 2, "name": "Naperville", "ascii_name": "Naperville",
              "country_code": "US", "state_name": "Illinois",
              "lat": 41.79, "lng": -88.15, "population": 147_100,
              "_dist_km": 37.0}
AURORA_IL = {"id": 3, "name": "Aurora", "ascii_name": "Aurora",
             "country_code": "US", "state_name": "Illinois",
             "lat": 41.76, "lng": -88.32, "population": 180_500,
             "_dist_km": 58.0}
NEW_YORK = {"id": 10, "name": "New York", "ascii_name": "New York",
            "country_code": "US", "state_name": "New York",
            "lat": 40.71, "lng": -74.01, "population": 8_000_000}
BROOKLYN = {"id": 11, "name": "Brooklyn", "ascii_name": "Brooklyn",
            "country_code": "US", "state_name": "New York",
            "lat": 40.65, "lng": -73.95, "population": 2_736_074,
            "_dist_km": 8.0}
EVANSTON = {"id": 12, "name": "Evanston", "ascii_name": "Evanston",
            "country_code": "US", "state_name": "Illinois",
            "lat": 42.04, "lng": -87.69, "population": 75_988,
            "_dist_km": 21.0}
DELHI = {"id": 20, "name": "Delhi", "ascii_name": "Delhi",
         "country_code": "IN", "state_name": "Delhi",
         "lat": 28.62, "lng": 77.21, "population": 16_300_000}
NOIDA = {"id": 21, "name": "Noida", "ascii_name": "Noida",
         "country_code": "IN", "state_name": "Uttar Pradesh",
         "lat": 28.58, "lng": 77.33, "population": 642_381, "_dist_km": 14.0}
NEW_DELHI = {"id": 22, "name": "New Delhi", "ascii_name": "New Delhi",
             "country_code": "IN", "state_name": "Delhi",
             "lat": 28.61, "lng": 77.23, "population": 250_000, "_dist_km": 2.0}
GARY = {"id": 30, "name": "Gary", "ascii_name": "Gary",
        "country_code": "US", "state_name": "Indiana",
        "lat": 41.59, "lng": -87.34, "population": 69_000, "_dist_km": 40.0}


# ── score_suburb (pure) ──────────────────────────────────────────────

def test_suburb_in_title_pins_suburb():
    score, reason = score_suburb(
        CHICAGO, NAPERVILLE,
        "Naperville council bans new warehouse development",
        "The measure passed 7-2 Tuesday.")
    assert score >= 90
    assert "title-mention" in reason


def test_parent_leading_title_without_hint_keeps_parent():
    # "Killed in Chicago; Naperville family mourns" — parent first, no hint
    score, _ = score_suburb(
        CHICAGO, NAPERVILLE,
        "Man killed in Chicago bar shooting; Naperville family mourns",
        "Witnesses were interviewed.")
    assert score < 90


def test_suburb_context_phrase_pins():
    score, reason = score_suburb(
        CHICAGO, NAPERVILLE,
        "Illinois warehouse boom strains grid",
        "Developers raced to buy land in the Chicago suburb of Naperville "
        "this quarter. Naperville officials declined comment.")
    assert score >= 90
    assert "suburb-context" in reason


def test_single_body_mention_not_enough():
    score, _ = score_suburb(
        CHICAGO, NAPERVILLE,
        "Chicago mayor touts transit plan",
        "Commuters from Naperville will benefit eventually.")
    assert score == 0


def test_suburb_first_in_title_beats_parent_first_with_hint():
    score, _ = score_suburb(
        CHICAGO, NAPERVILLE,
        "Naperville, Chicago suburb, opens first fire station in a decade",
        "The city grew fast.")
    assert score >= 90


def test_word_boundary_no_partial_match():
    # "Aurora" inside "auroras" must not match
    score, _ = score_suburb(CHICAGO, AURORA_IL,
                            "Chicago lights show auroras over lakefront",
                            "Rare display.")
    assert score == 0


def test_brooklyn_pins_over_new_york():
    score, _ = score_suburb(
        NEW_YORK, BROOKLYN,
        "Brooklyn bridge bike lane to close for repairs",
        "Work starts Monday.")
    assert score >= 90


# ── refine() with injected candidates ────────────────────────────────

def test_refine_swaps_to_suburb():
    sub, why = refine(
        CHICAGO,
        "Naperville approves $4M park bond",
        "Voters go to the polls November.",
        candidates=[NAPERVILLE, AURORA_IL])
    assert sub is NAPERVILLE
    assert why


def test_refine_no_candidates_no_swap():
    sub, _ = refine(CHICAGO, "Weather statewide alert issued", "",
                    candidates=[])
    assert sub is None


def test_refine_skips_small_parent():
    town = {**CHICAGO, "population": 120_000}
    sub, _ = refine(town, "Naperville store robbed", "",
                    candidates=[NAPERVILLE])
    assert sub is None


def test_refine_picks_closest_on_tie():
    sub, _ = refine(
        CHICAGO,
        "Evanston and Naperville both weigh train fares",
        "",
        candidates=[NAPERVILLE, EVANSTON])
    assert sub is EVANSTON  # 21km < 37km


def test_refine_never_raises_on_bad_input():
    class Boom(dict):
        def get(self, k, default=None):
            raise RuntimeError("nope")
    sub, why = refine(CHICAGO, "x", "y", candidates=[Boom()])
    assert sub is None


def test_closest_on_tie_prefers_near_even_when_order_reversed():
    sub, _ = refine(
        CHICAGO,
        "Naperville and Evanston both weigh train fares",
        "",
        candidates=[NAPERVILLE, EVANSTON])
    assert sub is EVANSTON


# ── candidate filtering ──────────────────────────────────────────────

CALUMET_CA = {"id": 40, "name": "Calumet", "ascii_name": "Calumet",
              "country_code": "CA", "state_name": "Ontario",
              "lat": 41.9, "lng": -88.0, "population": 30_000}
# cells keyed as int(lat//1), int(lng//1) — mirrors _load_grid
GRID = {
    (41, -88): [CHICAGO],
    (41, -89): [NAPERVILLE, AURORA_IL, CALUMET_CA],
    (42, -88): [EVANSTON],
    (28, 77): [DELHI, NEW_DELHI, NOIDA],
    (40, -74): [BROOKLYN],
    (40, -75): [NEW_YORK],
}


def test_candidates_same_country_distance_and_size():
    cands = _candidates_from(grid=GRID, parent=CHICAGO)
    names = {c["name"] for c in cands}
    assert "Naperville" in names
    assert "Aurora" in names
    assert "Evanston" in names       # 75k pop, still >= 20k floor
    assert "Calumet" not in names    # wrong country
    assert "New Delhi" not in names  # far away
    assert "Chicago" not in names    # self excluded


def test_candidates_exclude_name_overlap_with_parent():
    cands = _candidates_from(grid=GRID, parent=DELHI)
    names = {c["name"] for c in cands}
    assert "Noida" in names
    assert "New Delhi" not in names  # substring overlap — same place


def test_candidates_require_big_parent():
    small = {**CHICAGO, "population": 100_000}
    assert _candidates_from(grid=GRID, parent=small) == []


def test_candidates_reject_too_close_to_parent_population_ratio():
    # a city 90% of parent's pop must be excluded (MAX_SUBURB_POP_RATIO)
    big_sat = {"id": 50, "name": "Bigsat", "ascii_name": "Bigsat",
               "country_code": "US", "state_name": "New York",
               "lat": 40.9, "lng": -74.2, "population": 7_500_000}
    cands = _candidates_from(grid={**GRID, (40, -75): [NEW_YORK, big_sat]},
                             parent=NEW_YORK)
    assert "Bigsat" not in {c["name"] for c in cands}


def test_min_parent_pop_guard_constant():
    assert MIN_PARENT_POP == 500_000


# ── label ────────────────────────────────────────────────────────────

def test_suburb_label_format():
    assert suburb_label(NAPERVILLE) == "Naperville, Illinois, US"
    assert suburb_label({"name": "X", "country_code": "US"}) == "X, US"


# ── false-positive guards ────────────────────────────────────────────

ALI = {"id": 60, "name": "Ali", "ascii_name": "Ali",
       "country_code": "IN", "state_name": "Uttar Pradesh",
       "lat": 28.5, "lng": 77.3, "population": 25_000, "_dist_km": 12.0}
TOWNSHIP = {"id": 61, "name": "Aurora Township", "ascii_name": "Aurora Township",
            "country_code": "US", "state_name": "Illinois",
            "lat": 41.76, "lng": -88.32, "population": 150_000, "_dist_km": 55.0}


def test_short_name_title_alone_does_not_repin():
    sub, _ = refine(DELHI, "Ali announces new metro depot", "",
                    candidates=[ALI])
    assert sub is None


def test_short_name_with_suburb_hint_does_repin():
    sub, why = refine(
        DELHI,
        "The Delhi suburb of Ali gets a new metro depot",
        "Officials in Ali celebrated the announcement.",
        candidates=[ALI])
    assert sub is ALI
    assert why


def test_admin_division_names_filtered_from_candidates():
    cands = _candidates_from(
        grid={(41, -89): [NAPERVILLE, TOWNSHIP], (41, -88): [CHICAGO]},
        parent=CHICAGO)
    assert "Aurora Township" not in {c["name"] for c in cands}
    assert "Naperville" in {c["name"] for c in cands}


def test_lowercase_mid_sentence_mention_does_not_repin():
    # "ali" lowercase in body must not count as the suburb "Ali"
    score, _ = score_suburb(
        DELHI, {"id": 60, "name": "Ali", "ascii_name": "Ali",
                "country_code": "IN", "state_name": "Uttar Pradesh",
                "lat": 28.5, "lng": 77.3, "population": 25_000},
        "Delhi traffic plan unveiled",
        "The commute ali-gns nothing useful for riders.")
    assert score == 0
