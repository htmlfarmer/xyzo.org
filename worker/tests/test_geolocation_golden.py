"""Geolocation golden set — the misassignment classes from
docs/GEOLOCATION_MISASSIGNMENTS_2026-09-21.md, docs/VIRGINIA_ZA_BUG_FIX.md
and docs/CODEBASE_REVIEW_2026-09-26.md §1.4/§3.5, pinned as executable cases.

These were "manually verified 13/13" on Sep 21 but NEVER codified — which is
exactly how a retrain or watchlist edit silently reintroduces them (the review's
"layer drift" class). Every case here is pure-function (no DB, no network).

Contract being pinned:
  disambiguate(location_text, context, source_country) -> (keep, reason)
  keep=False ⇒ the city candidate is DROPPED (pipeline falls through to a
  safer path); keep=True ⇒ placement proceeds. Erring toward drop is safe;
  erring toward KEEP with the wrong country is the 15k-article incident.
"""
from __future__ import annotations

import pytest

from worker.place_disambiguation import disambiguate, is_qualified


class TestSep21GoldenBatch:
    """The Sep-21 evening watchlist batch (valencia, fargo, negara, victoria,
    el paso, jos) — verified manually then untested for 4 days."""

    @pytest.mark.parametrize("loc,context,src", [
        # 1. Common word / company name ≠ city (3,889 Fargo articles)
        ("Fargo", "Wells Fargo reported record quarterly earnings today.", "US"),
        ("Fargo", "Wells Fargo analysts raised the price target.", "US"),
        # 2. Spanish phrase ≠ Texas city (1,606 El Paso articles)
        ("El Paso", "El paso del norte trajo tormentas a la frontera.", None),
        ("El Paso", "El jugador dio un paso al frente en la final.", None),
        # 3. Indonesian common word "negara" = country (1,409 articles)
        ("Negara", "Pemerintah negara mengumumkan subsidi energi baru.", "ID"),
        ("Negara", "Negara-negara ASEAN bertemu minggu depan.", "ID"),
        # 4. Subword match in Croatian (3,462 Jos articles)
        ("Jos", "Vojska je krenula prema granici nakon projekta.", "HR"),
        ("Jos", "Tko je vidio od koga je traženo dopuštenje?", "HR"),
        # 5. Football club ambiguity ES vs VE (816 Valencia articles)
        ("Valencia", "Valencia CF i Mestalla spremni za derbi u La Ligi.", "ES"),
        ("Valencia", "Barcelona i Valencia odigrali su neriješeno.", "ES"),
        # 6. Person/brand-name Victoria (1,509 Victoria articles)
        ("Victoria", "Victoria Beckham lansira novi miris.", "GB"),
        ("Victoria", "The Victoria's Secret annual show aired Friday.", "US"),
        ("Victoria", "Victoria Justice stars in the new teen sitcom.", "US"),
    ])
    def test_wrong_context_rejected(self, loc, context, src):
        keep, reason = disambiguate(loc, context, source_country=src)
        assert keep is False, f"{loc!r} in {context[:40]!r}… must DROP, got {reason}"

    @pytest.mark.parametrize("loc,context,src", [
        # Same names, genuine city contexts — must be KEPT (over-rejection
        # pushed these to source-capital fallback, the other half of the bug).
        ("Fargo", "Storm flooding closed highways around Fargo, North Dakota.", "US"),
        ("Fargo", "Cass County officials met in Fargo about the new shelter.", "US"),
        ("El Paso", "Border agents in El Paso, TX seized the shipment.", "US"),
        ("Jos", "Attacks near Jos in Plateau State displaced hundreds.", "NG"),
        ("Valencia", "Farmers in Valencia, Spain protest water cuts.", "ES"),
        ("Victoria", "Victoria, British Columbia hosts the climate summit.", "CA"),
        ("Victoria", "Melbourne suburb of Victoria saw record heat in Australia.", "AU"),
        ("Negara", "Ferry accident off Negara, Bali, jembrana regency.", "ID"),
    ])
    def test_true_context_kept(self, loc, context, src):
        keep, reason = disambiguate(loc, context, source_country=src)
        assert keep is True, f"{loc!r} in {context[:40]!r}… must KEEP, got {reason}"

    def test_jos_no_longer_self_rejected(self):
        """Regression (2026-09-26): the jos reject pattern \\bjo(?:s|...)\\b
        matched the city name 'Jos' inside its OWN context, so no Jos story
        could ever be kept. Bare 'jos' must not be a reject pattern; the
        PERSON names Joseph/Josh/Joshua still must be."""
        # With real country context → kept (was impossible before the fix).
        keep, reason = disambiguate("Jos", "Governor visited Jos in Nigeria after the church bombings", "NG")
        assert keep is True, reason
        # A bare mention with no confirmers: conservative DROP is fine, but
        # the reason must NOT be rejected_by_pattern (the self-match bug).
        keep, reason = disambiguate("Jos", "church bombings", "NG")
        assert keep is False and "rejected_by_pattern" not in reason, reason
        keep, _ = disambiguate("Jos", "Joshua Joseph released a country album", "US")
        assert keep is False

    def test_victoria_qualified_forms_no_longer_self_rejected(self):
        """Regression (2026-09-26): 'victoria, bc/au/hk' reject patterns
        contradicted the same entry's accept patterns; qualified spellings of
        the three legit Victorias now keep."""
        for ctx, src in [("Victoria, Canada declared a state of emergency", "CA"),
                         ("Victoria Australia recorded its hottest week", "AU"),
                         ("Victoria in Hong Kong harbour was reclaimed", None)]:
            keep, reason = disambiguate("Victoria", ctx, source_country=src)
            assert keep is True, f"must keep: {ctx} → {reason}"


class TestVirginiaPrecedence:
    """docs/VIRGINIA_ZA_BUG_FIX.md precedence rules."""

    def test_us_context_rejects_za_default(self):
        keep, _ = disambiguate("Virginia", "Residents of Virginia Beach brace for the hurricane", "US")
        assert keep is False  # bare Virginia + US context → don't place ZA blindly

    def test_explicit_za_qualifier_keeps(self):
        keep, _ = disambiguate("Virginia", "Virginia, ZA — small town floods", "US")
        assert keep is True

    def test_explicit_context_beats_source_prior(self):
        """US source + Free State (South Africa) context → keep (SA), not USA."""
        keep, _ = disambiguate("Virginia", "In the Free State province, Virginia residents voted", "US")
        assert keep is True


class TestIsQualifiedFalsePositives:
    """FIX_NOTES 1.4: comma-less qualifier detection must not fire on ordinary
    phrases containing state-abbrev-similar words."""

    @pytest.mark.parametrize("text", [
        "Alexandria in Egypt",     # "in" was matching as Indiana abbrev
        "Ciudad de Mexico",        # "de" as Delaware
        "Sur in Oman",
    ])
    def test_not_qualified(self, text):
        assert is_qualified(text) is False, (
            f"{text!r} must NOT qualify (bypasses watchlist) — end-anchored abbrev rule"
        )

    @pytest.mark.parametrize("text", [
        "Springfield IL", "Memphis TN", "City of Richmond", "Town of Sudbury",
    ])
    def test_genuine_qualifiers(self, text):
        assert is_qualified(text) is True


class TestKnownOpenFalsePositives:
    """Documented-but-still-open watchlist bypasses (FIX_NOTES 1.4). Each is an
    xfail so it can't be silently forgotten — un-xfail when fixed."""

    @pytest.mark.xfail(reason="FIX_NOTES 1.4: 'Man city' qualifies → watchlist bypassed",
                       strict=False)
    def test_man_city_should_not_qualify(self):
        assert is_qualified("Man city") is False

    @pytest.mark.xfail(reason="GEOLOCATION_MISASSIGNMENTS known-unfixed: publication names "
                              "(Silicon Republic / 36Kr) leak into location_text", strict=False)
    def test_publication_name_leak_uncaught(self):
        from worker.cities_text import SKIP_WORDS  # existence check only
        assert "silicon republic" in {w.lower() for w in SKIP_WORDS}


class TestSkipWordsBehavior:
    """cities_text must never match the Sep-21 SKIP_WORDS as cities.
    Pure-text check via find_cities_in_text if importable offline, else the
    SKIP_WORDS set itself (guard against typo'd set edits)."""

    def test_skip_words_present(self):
        from worker.cities_text import SKIP_WORDS
        lowered = {w.lower() for w in SKIP_WORDS}
        for word in ("fargo", "negara", "jos"):
            assert word in lowered, f"{word!r} missing from cities_text SKIP_WORDS"

    def test_wells_fargo_not_matched_as_city(self):
        from worker import cities_text
        hits = cities_text.find_cities_in_text("Wells Fargo and City National reports")
        names = {(h.get("name") or "").lower() for h in hits}
        assert "fargo" not in names, (
            f"Fargo matched from 'Wells Fargo' — SKIP_WORDS regression: {names}"
        )
