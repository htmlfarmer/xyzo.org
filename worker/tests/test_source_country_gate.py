"""The source-based placement gate (2026-10-22 "103 Stories in Bamako" incident).

`auto_categorize._source_fallback()` places every article the fast path
could not locate onto a single city of the source's country. That is only
defensible when the source really publishes from that country. When it
does not, the source's ENTIRE output collapses onto one capital and the
map lies:

  * "DEV Community" (dev.to, a global programming blog) was seeded with
    country=ML → 12,368 articles on Bamako, Mali. The map showed
    "103 Stories in Bamako, ML" for the default 24 h window.
  * 141 pan-Arab sources were tagged country="ME" ("Middle East"), but ME
    is ISO **Montenegro** → 41,106 articles on Podgorica.
  * "ReliefWeb" (UN) landed on New York (UN HQ).

`_source_geo_is_country_specific()` is the gate. These tests pin its
rules so a later edit cannot quietly re-open the pileup class.

Pure: the source cache and the geography profile cache are monkeypatched
— no database, no network.
"""
from __future__ import annotations

import pytest

from worker import auto_categorize as ac


def _patch(monkeypatch, sources: dict, profiles: dict):
    """sources: {id: {country, region}}, profiles: {id: profile dict}."""
    monkeypatch.setattr(ac, "_load_source_cache", lambda: dict(sources))
    monkeypatch.setattr(ac, "_load_source_geo_cache", lambda: dict(profiles))


def _profile(top_countries, content_total, total=None):
    return {
        "top_cities": [],
        "top_countries": [
            {"country_code": cc, "article_count": n, "rank": i}
            for i, (cc, n) in enumerate(top_countries, start=1)
        ],
        "primary_city_id": None,
        "secondary_city_id": None,
        "article_count_30d": total if total is not None else content_total,
        "content_article_count_30d": content_total,
    }


class TestCountrySpecificGate:
    def test_source_without_country_is_refused(self, monkeypatch):
        """dev.to after the metadata fix: a global platform, no home city."""
        _patch(monkeypatch,
               {1: {"country": None, "region": "global"}},
               {1: _profile([("US", 228), ("IN", 89)], 1336)})
        ok, why = ac._source_geo_is_country_specific(1, None, "global")
        assert ok is False
        assert "no country" in why

    def test_pseudo_country_code_is_refused(self, monkeypatch):
        """'UN' is an organisation, not a country to pin stories to."""
        _patch(monkeypatch,
               {1: {"country": "UN", "region": "global"}},
               {1: _profile([("US", 369)], 788)})
        ok, why = ac._source_geo_is_country_specific(1, "UN", "global")
        assert ok is False
        assert "not a country" in why

    def test_middle_east_me_is_not_montenegro(self, monkeypatch):
        """country='ME' + region MENA means the Middle East, not ISO ME."""
        _patch(monkeypatch,
               {1: {"country": "ME", "region": "MENA"}},
               {1: _profile([("IR", 224)], 607)})
        ok, why = ac._source_geo_is_country_specific(1, "ME", "MENA")
        assert ok is False
        assert "Middle East" in why

    def test_montenegrin_source_with_region_eastern_europe_is_kept(self, monkeypatch):
        """The same code, a real Montenegrin paper → allowed."""
        _patch(monkeypatch,
               {1: {"country": "ME", "region": "EASTERN_EUROPE"}},
               {1: _profile([("ME", 180)], 190)})
        ok, _why = ac._source_geo_is_country_specific(1, "ME", "EASTERN_EUROPE")
        assert ok is True

    def test_mistagged_country_is_refused(self, monkeypatch):
        """A source whose own-text stories are ~none in its tagged country."""
        _patch(monkeypatch,
               {1: {"country": "AF", "region": "AFRICA"}},
               {1: _profile([("ML", 97)], 186)})
        ok, why = ac._source_geo_is_country_specific(1, "AF", "AFRICA")
        assert ok is False
        assert "centre of gravity" in why

    def test_national_paper_with_world_coverage_is_kept(self, monkeypatch):
        """Infobae Argentina: 29% Argentine, the rest international → kept."""
        _patch(monkeypatch,
               {1: {"country": "AR", "region": "south-america"}},
               {1: _profile([("ES", 6079), ("AR", 4460), ("US", 3031)], 24772)})
        ok, _why = ac._source_geo_is_country_specific(1, "AR", "south-america")
        assert ok is True

    def test_national_paper_is_kept(self, monkeypatch):
        _patch(monkeypatch,
               {1: {"country": "KR", "region": "East Asia"}},
               {1: _profile([("KR", 13150)], 13307)})
        ok, _why = ac._source_geo_is_country_specific(1, "KR", "East Asia")
        assert ok is True

    def test_source_without_profile_is_kept(self, monkeypatch):
        """Brand new sources keep the old behaviour until we have data."""
        _patch(monkeypatch, {1: {"country": "FR", "region": "europe"}}, {})
        ok, _why = ac._source_geo_is_country_specific(1, "FR", "europe")
        assert ok is True

    def test_share_uses_the_content_denominator(self, monkeypatch):
        """A source that pins 90% of its output to one capital must not
        look well-spread: the denominator is the CONTENT count."""
        profile = _profile([("US", 90)], content_total=100, total=1000)
        profile["content_article_count_30d"] = 100
        _patch(monkeypatch,
               {1: {"country": "US", "region": "americas"}},
               {1: profile})
        # 90% of its own-text articles are in the US → allowed …
        ok, _why = ac._source_geo_is_country_specific(1, "US", "americas")
        assert ok is True

        # … but if only 5 of its 100 own-text articles are American, the
        # country tag is not believable.
        profile2 = _profile([("US", 5)], content_total=100, total=1000)
        _patch(monkeypatch,
               {1: {"country": "US", "region": "americas"}},
               {1: profile2})
        ok, why = ac._source_geo_is_country_specific(1, "US", "americas")
        assert ok is False
        assert "centre of gravity" in why


class TestFallbackRefusesNonCountrySpecificSources:
    """The gate must stop the placement, not just report it."""

    def test_source_fallback_returns_none_for_global_source(self, monkeypatch):
        _patch(monkeypatch,
               {1: {"country": None, "region": "global", "name": "DEV Community"}},
               {1: _profile([("US", 228)], 1336)})
        # No city in the text, no wiki_geo hit → the gate is what stops it.
        monkeypatch.setattr("worker.wiki_geo.geolocate_article",
                            lambda *a, **k: None, raising=True)
        monkeypatch.setattr("worker.cities_text.stats",
                            lambda *a, **k: {"primary": None, "cities": []},
                            raising=True)
        art = {"id": 1, "title": "How to write a Rust macro", "body": "no place here",
               "source_id": 1, "detected_lang": "en", "word_freq": {}}
        assert ac._source_fallback(art) is None

    def test_source_fallback_still_places_country_specific_source(self, monkeypatch):
        _patch(monkeypatch,
               {1: {"country": "KR", "region": "East Asia", "name": "Yonhap"}},
               {1: _profile([("KR", 13150)], 13307)})
        monkeypatch.setattr("worker.wiki_geo.geolocate_article",
                            lambda *a, **k: None, raising=True)
        monkeypatch.setattr("worker.cities_text.stats",
                            lambda *a, **k: {"primary": None, "cities": []},
                            raising=True)
        monkeypatch.setattr(ac, "_get_source_profile_city",
                            lambda sid, cc: {"id": 1, "name": "Seoul", "country_code": "KR",
                                             "lat": 37.5665, "lng": 126.9780, "population": 1},
                            raising=True)
        art = {"id": 1, "title": "no place here", "body": "no place here",
               "source_id": 1, "detected_lang": "en", "word_freq": {}}
        result = ac._source_fallback(art)
        assert result is not None
        assert result["city"]["name"] == "Seoul"
