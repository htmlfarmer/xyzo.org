"""Tests for the URL scoring blend (page_priority + intelligence)."""
from worker.page_priority import score_url_with_intelligence, score_url


class TestScoreUrlWithIntelligence:
    def test_without_intelligence_returns_page_priority(self):
        score = score_url_with_intelligence("https://x.com/events", None)
        pp = score_url("https://x.com/events").score
        assert score == pp

    def test_intelligence_boost_adds_to_score(self):
        # A boost only reaches CrawlHints via structural_map at confidence
        # >= 0.8 -- parse_intelligence_to_hints has no top-level
        # "url_score_adjustments" key, so feeding one in would be silently
        # dropped and this test would pass for the wrong reason.
        intel = {"structural_map": [
            {"pattern": "/events", "kind": "listing",
             "confidence": 0.9, "examples": ["/events"]}
        ]}
        with_intel = score_url_with_intelligence(
            "https://x.com/events/some-event", intel)
        without = score_url_with_intelligence(
            "https://x.com/events/some-event", None)
        assert with_intel > without

    def test_avoided_url_gets_penalty(self):
        from worker.intelligence_consume import CrawlHints, parse_intelligence_to_hints
        intel = {"structural_map": [
            {"pattern": "/admin", "kind": "listing",
             "confidence": 0.3, "examples": ["/admin"]}
        ]}
        hints = parse_intelligence_to_hints(intel)
        with_intel = score_url_with_intelligence("https://x.com/admin", None,
                                                 hints=hints)
        without = score_url_with_intelligence("https://x.com/admin", None)
        assert with_intel < without

    def test_classifier_score_blends(self):
        # classifier_score > page_priority should pull the result up.
        # /blog/post-1 scores 0.6 on page_priority alone, so a classifier
        # score of 1.0 is genuinely higher. (/events scores 1.2, which is
        # *above* 1.0 -- using it here would assert the opposite of the
        # stated intent and only pass via a deflated baseline.)
        url = "https://x.com/blog/post-1"
        pp_only = score_url_with_intelligence(url, None)
        with_classifier = score_url_with_intelligence(
            url, None,
            classifier_score=1.0,
            classifier_weight=0.8,
            page_priority_weight=0.1,
            intelligence_weight=0.1,
        )
        assert pp_only == score_url(url).score
        assert with_classifier > pp_only

    def test_avoidance_does_not_double_count(self):
        # /admin is penalised by page_priority (-1.0) AND flagged by
        # intelligence (-2.0). The blend must not stack those into a trap
        # the URL can never climb out of.
        from worker.intelligence_consume import parse_intelligence_to_hints
        hints = parse_intelligence_to_hints({"structural_map": [
            {"pattern": "/admin", "kind": "listing", "confidence": 0.3,
             "examples": ["/admin"]}
        ]})
        blended = score_url_with_intelligence(
            "https://x.com/admin", None, hints=hints)
        raw_sum = score_url("https://x.com/admin").score - 2.0
        assert blended > raw_sum
        assert blended > -2.0
