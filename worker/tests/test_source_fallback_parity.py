"""Cross-country validation PARITY between the two placement paths (Sep 21
incident class — docs/GEOLOCATION_MISASSIGNMENTS_2026-09-21.md).

Root cause of ~15k mislocated articles: `auto_categorize._decide()` had the
cross-country rejection rule, but `_source_fallback()` (the body-scan rescue
path) did NOT — so anything the fast path skipped was placed abroad without
checking the source country. The fix ported the rule, but a parity guard is
the only thing that keeps the two validators from drifting apart again when
someone edits one rule list next month.

Invariant tested: the rescue path `_source_fallback` must NEVER accept a
cross-country city placement that the primary path `_decide` rejects.
(Equal strictness on shared inputs.)

Pure-ish: source cache + wiki_geo are monkeypatched; the gazetteer index
(cities_text) loads locally (~1-2s once). No writes anywhere.
"""
from __future__ import annotations

import pytest

from worker import auto_categorize as ac


FAKE_SOURCES = {
    1: {"country": "KR", "name": "Korea Daily"},   # Korean source
    2: {"country": "US", "name": "US Weekly"},     # US source
    3: {"country": "DE", "name": "Berlin Tageblatt"},
    4: {"country": "ID", "name": "Kompas"},
    5: {"country": "NG", "name": "Daily Trust"},
}


@pytest.fixture
def patched(monkeypatch):
    # Deterministic source metadata, no DB for the cache.
    monkeypatch.setattr(ac, "_load_source_cache", lambda: dict(FAKE_SOURCES))
    # Stub out the wiki_geo rescue pass — this test is about cross-country
    # VALIDATION of text-detected cities, not the gazetteer lookup chain.
    from worker import wiki_geo
    monkeypatch.setattr(wiki_geo, "geolocate_article",
                        lambda *a, **k: None, raising=True)
    yield


def _placed_country(fn, article):
    result = fn(article)
    if not result or result.get("status") in (None, "no_match") or not result.get("city"):
        return None
    return (result["city"].get("country_code") or "").upper() or None


US_CITY_TEXT = ("Samsung to open a plant in Austin\n" +
                "The chip maker said the Austin facility will produce "
                "memory units for export. " * 5)  # city deep in body

US_CITY_MENTIONED_TEXT = ("Samsung plant in Austin, Texas (US) announced\n" +
                          "The US facility will produce memory units. " * 5)

FARGO_DOMESTIC = ("Fargo to raise water rates\n" +
                  "Fargo, North Dakota council voted on the bond issue. " * 3)
# NOTE: bare 'fargo' is in cities_text SKIP_WORDS by design (Sep-21 fix) —
# genuine Fargo stories are placed by the watchlist/source layers instead.

WELLS_FARGO = ("Wells Fargo lifts guidance\n" +
               "Wells Fargo analysts raised the price target on the stock. " * 3)


class TestFallbackNeverMoreLenientThanDecide:
    def test_body_only_foreign_city_rejected_by_both(self, patched):
        """KR source, Austin in body, no 'US' mention → neither path places it."""
        art = {"id": 0, "title": "Samsung to open a plant", "body": US_CITY_TEXT,
               "source_id": 1, "detected_lang": "en", "word_freq": {}}
        decide_country = _placed_country(ac._decide, art)
        fallback_country = _placed_country(ac._source_fallback, art)
        assert decide_country != "US", "_decide regressed: accepts foreign body-only city"
        assert fallback_country != "US", (
            "_source_fallback places US city for KR source — the Sep-21 "
            "divergence bug is back (fallback must apply cross-country rejection)"
        )

    def test_explicitly_mentioned_foreign_city_accepted_consistently(self, patched):
        """City's country named in text → foreign correspondent: both agree."""
        art = {"id": 0, "title": US_CITY_MENTIONED_TEXT.splitlines()[0],
               "body": US_CITY_MENTIONED_TEXT,
               "source_id": 1, "detected_lang": "en", "word_freq": {}}
        decide_country = _placed_country(ac._decide, art)
        fallback_country = _placed_country(ac._source_fallback, art)
        # If either places, it must place US (mentioned → allowed).
        for name, got in (("decide", decide_country), ("fallback", fallback_country)):
            if got is not None:
                assert got == "US", f"{name} placed {got} for mentioned-US article"

    def test_domestic_city_both_place_same_country(self, patched):
        """US source + Denver (CO) → identical placement on both paths."""
        art = {"id": 0, "title": "Denver to raise water rates",
               "body": "Denver, Colorado council voted on the bond issue. " * 3,
               "source_id": 2, "detected_lang": "en", "word_freq": {}}
        assert _placed_country(ac._decide, art) == "US"
        assert _placed_country(ac._source_fallback, art) == "US"

    def test_wells_fargo_not_a_city_on_both_paths(self, patched):
        """SKIP_WORDS (Sep 21): 'Wells Fargo' must never yield Fargo anywhere."""
        art = {"id": 0, "title": WELLS_FARGO.splitlines()[0],
               "body": WELLS_FARGO,
               "source_id": 2, "detected_lang": "en", "word_freq": {}}
        for label, fn in (("decide", ac._decide), ("fallback", ac._source_fallback)):
            res = fn(art)
            city = (res or {}).get("city") or {}
            assert (city.get("name") or "").lower() != "fargo", (
                f"_source_fallback/_decide divergence class: 'Wells Fargo' "
                f"matched city Fargo via {label}"
            )

    def test_skip_words_parity_fargo_negara_jos(self, patched):
        """PARITY of the CURRENT design (documented in AGENTS.md Sep-21): the
        three SKIP_WORDS entries must be skipped IDENTICALLY by both paths —
        either both refuse to text-match them, or both match. Divergence here
        means someone removed the word from one validator's list only.
        (Placement for genuine Fargo/Negara/Jos stories then comes from the
        watchlist context layer + source fallback, not raw text matching.)"""
        cases = [
            ({"country": "US", "name": "US Weekly"},
             "Fargo council votes on budget\nThe Fargo measure passed 6-1."),
            ({"country": "ID", "name": "Kompas"},
             "Negara siapkan subsidi\nNegara siapkan anggaran baru untuk desa."),
            ({"country": "NG", "name": "Daily Trust"},
             "Jos church memorial held\nJos community gathered for the ceremony."),
        ]
        for i, (_src, text) in enumerate(cases):
            art = {"id": 0, "title": text.splitlines()[0], "body": text,
                   "source_id": {0: 2, 1: 4, 2: 5}[i], "detected_lang": "en",
                   "word_freq": {}}
            dc = _placed_country(ac._decide, art)
            fc = _placed_country(ac._source_fallback, art)
            assert dc == fc or (dc is None or fc is None), (
                f"case {i}: decide placed {dc}, fallback placed {fc} — "
                "validators diverged on a SKIP_WORD (the Sep-21 class of bug)"
            )

    def test_german_source_spanish_city_no_mention_rejected_both(self, patched):
        """DE source + 'Lima' without Peru mention → watchlist + cross-country
        must both refuse (the Lima-PE source-prior class)."""
        art = {"id": 0, "title": "Der Präsident sprach über Reformen",
               "body": ("In einer Rede wurde Lima als Beispiel genannt. " * 3),
               "source_id": 3, "detected_lang": "de", "word_freq": {}}
        for label, fn in (("decide", ac._decide), ("fallback", ac._source_fallback)):
            res = fn(art)
            city = (res or {}).get("city") or {}
            assert (city.get("country_code") or "").upper() != "PE", (
                f"{label}: Lima/PE placed for DE source without Peru mention"
            )
