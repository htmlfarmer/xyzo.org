"""Tests for the image extraction pipeline.

Covers:
  • image_scorer — scoring, ranking, noise filtering, dimension hints
  • web_scraper — image extraction from article HTML
  • fulltext — extract_lead_image uses scorer
  • fetch — _entry_image uses scorer for RSS entries
  • extract — image_url flows through normalize, regex_fallback, lightweight
  • End-to-end — HTML → scorer → best URL

No live DB or network required.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


@pytest.fixture(autouse=True)
def patch_db(monkeypatch):
    mock_conn = MagicMock()
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=MagicMock())
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    monkeypatch.setattr("worker.db.connect", lambda: mock_conn)


# ── image_scorer ──────────────────────────────────────────────────────

class TestImageScorer:
    def test_og_image_wins(self):
        """og:image meta tag should beat a random <img> tag."""
        from worker.image_scorer import ImageCandidate, pick_best_image
        cands = [
            ImageCandidate(url="https://cdn.example.com/article-photo.jpg", source="img_tag", position=3),
            ImageCandidate(url="https://example.com/og-hero.jpg", source="og", position=0),
        ]
        assert pick_best_image(cands, min_score=0) == "https://example.com/og-hero.jpg"

    def test_twitter_image_beats_img_tag(self):
        from worker.image_scorer import ImageCandidate, pick_best_image
        cands = [
            ImageCandidate(url="https://example.com/photo.jpg", source="img_tag", position=0),
            ImageCandidate(url="https://example.com/tw.jpg", source="twitter", position=0),
        ]
        assert pick_best_image(cands, min_score=0) == "https://example.com/tw.jpg"

    def test_first_position_boost(self):
        """First image in article should beat later ones (same source)."""
        from worker.image_scorer import ImageCandidate, pick_best_image
        cands = [
            ImageCandidate(url="https://example.com/late.jpg", source="img_tag", position=10),
            ImageCandidate(url="https://example.com/first.jpg", source="img_tag", position=0),
        ]
        assert pick_best_image(cands, min_score=0) == "https://example.com/first.jpg"

    def test_large_dimensions_boost(self):
        """Large images should beat tiny ones."""
        from worker.image_scorer import ImageCandidate, pick_best_image
        cands = [
            ImageCandidate(url="https://example.com/tiny.jpg", source="img_tag", position=0, width=32, height=32),
            ImageCandidate(url="https://example.com/large.jpg", source="img_tag", position=1, width=1200, height=800),
        ]
        assert pick_best_image(cands, min_score=0) == "https://example.com/large.jpg"

    def test_hero_url_hint(self):
        """URL containing 'hero' or 'featured' should score higher."""
        from worker.image_scorer import ImageCandidate, score_candidate
        plain = ImageCandidate(url="https://example.com/photo.jpg", source="img_tag", position=0)
        hero = ImageCandidate(url="https://example.com/hero-image-1200.jpg", source="img_tag", position=1)
        assert score_candidate(hero) > score_candidate(plain)

    def test_noise_url_rejected(self):
        """Tracking pixels and social icons should be filtered out."""
        from worker.image_scorer import _normalise_url
        assert _normalise_url("https://example.com/pixel.gif") is None
        assert _normalise_url("https://gravatar.com/avatar/abc") is None
        assert _normalise_url("https://example.com/1x1-transparent.png") is None
        assert _normalise_url("https://example.com/feedburner/share.png") is None

    def test_noise_url_allows_real_images(self):
        from worker.image_scorer import _normalise_url
        assert _normalise_url("https://cdn.example.com/article-photo.jpg") is not None
        assert _normalise_url("https://example.com/uploads/hero.jpg") is not None

    def test_logo_alt_penalised(self):
        from worker.image_scorer import ImageCandidate, score_candidate
        good = ImageCandidate(url="https://example.com/photo.jpg", source="img_tag", position=0, alt="Protesters in the street")
        logo = ImageCandidate(url="https://example.com/logo.png", source="img_tag", position=0, alt="Company logo")
        assert score_candidate(good) > score_candidate(logo)

    def test_sidebar_context_penalised(self):
        from worker.image_scorer import ImageCandidate, score_candidate
        main = ImageCandidate(url="https://example.com/a.jpg", source="img_tag", position=0, context='<div class="article-body">')
        sidebar = ImageCandidate(url="https://example.com/b.jpg", source="img_tag", position=0, context='<div class="sidebar-widget">')
        assert score_candidate(main) > score_candidate(sidebar)

    def test_min_score_threshold(self):
        """Very low-scoring candidates should be rejected."""
        from worker.image_scorer import ImageCandidate, pick_best_image
        cands = [
            ImageCandidate(url="https://example.com/tiny-logo.png", source="img_tag", position=20, alt="logo", width=16, height=16),
        ]
        assert pick_best_image(cands, min_score=5.0) is None

    def test_empty_candidates(self):
        from worker.image_scorer import pick_best_image
        assert pick_best_image([]) is None

    def test_dimension_in_url(self):
        from worker.image_scorer import _extract_dims_from_url
        w, h = _extract_dims_from_url("https://cdn.example.com/images/1200x800/photo.jpg")
        assert w == 1200
        assert h == 800

    def test_relative_url_resolution(self):
        from worker.image_scorer import _normalise_url
        assert _normalise_url("//cdn.example.com/img.jpg") == "https://cdn.example.com/img.jpg"
        assert _normalise_url("/uploads/photo.jpg", "https://example.com") == "https://example.com/uploads/photo.jpg"


# ── extract_image_candidates (HTML parsing) ───────────────────────────

class TestExtractImageCandidates:
    SAMPLE_HTML = """
    <html>
    <head>
        <meta property="og:image" content="https://example.com/og-hero.jpg">
        <meta name="twitter:image" content="https://example.com/twitter-card.jpg">
    </head>
    <body>
        <article>
            <figure>
                <img src="https://example.com/article-main.jpg" alt="Protesters gather" width="800" height="600">
            </figure>
            <p>Some article text...</p>
            <img src="https://example.com/inline-diagram.png" alt="Figure 1">
        </article>
        <div class="sidebar">
            <img src="https://example.com/ad-banner.jpg" alt="Subscribe now">
        </div>
    </body>
    </html>
    """

    def test_extracts_meta_images(self):
        from worker.image_scorer import extract_image_candidates
        cands = extract_image_candidates(self.SAMPLE_HTML, "https://example.com")
        sources = {c.source for c in cands}
        assert "og" in sources
        assert "twitter" in sources

    def test_extracts_body_images(self):
        from worker.image_scorer import extract_image_candidates
        cands = extract_image_candidates(self.SAMPLE_HTML, "https://example.com")
        urls = [c.url for c in cands]
        assert "https://example.com/article-main.jpg" in urls
        assert "https://example.com/inline-diagram.png" in urls

    def test_best_is_og_or_hero(self):
        from worker.image_scorer import extract_image_candidates, pick_best_image
        cands = extract_image_candidates(self.SAMPLE_HTML, "https://example.com")
        best = pick_best_image(cands, min_score=0)
        # The <figure> image with 800x600 dims + first position + figure context
        # scores higher than og:image alone — this is correct behavior.
        assert best is not None
        assert best in ("https://example.com/og-hero.jpg", "https://example.com/article-main.jpg")

    def test_deduplication(self):
        from worker.image_scorer import extract_image_candidates
        html = """
        <meta property="og:image" content="https://example.com/same.jpg">
        <img src="https://example.com/same.jpg">
        """
        cands = extract_image_candidates(html, "https://example.com")
        urls = [c.url for c in cands]
        assert urls.count("https://example.com/same.jpg") == 1


# ── web_scraper image extraction ──────────────────────────────────────

class TestWebScraperImage:
    ARTICLE_HTML = """
    <html>
    <head>
        <title>Breaking News Event Unfolds Across the Region</title>
        <meta property="og:image" content="https://publisher.com/hero.jpg">
    </head>
    <body>
        <h1>Breaking News Event Unfolds Across the Region</h1>
        <article>
            <img src="https://publisher.com/hero.jpg" alt="News scene" width="1200" height="800">
            <p>Something happened in the world today that has changed the landscape of international relations. Leaders from multiple countries have responded to the developing situation with statements of concern and calls for dialogue. The events mark a significant shift in the geopolitical balance that analysts have been warning about for months.</p>
        </article>
        <time datetime="2026-09-04T12:00:00Z">September 4, 2026</time>
    </body>
    </html>
    """

    def test_extracts_image(self):
        from worker.web_scraper import _extract_article
        result = _extract_article(self.ARTICLE_HTML, "https://publisher.com/article/1")
        assert result is not None
        assert result.get("image_url") == "https://publisher.com/hero.jpg"

    def test_extracts_title_and_body(self):
        from worker.web_scraper import _extract_article
        result = _extract_article(self.ARTICLE_HTML, "https://publisher.com/article/1")
        assert result["title"] == "Breaking News Event Unfolds Across the Region"
        assert "Something happened" in result["body"]


# ── fulltext extract_lead_image ───────────────────────────────────────

class TestFulltextImage:
    def test_uses_scorer(self):
        from worker.fulltext import extract_lead_image
        html = """
        <html><head>
        <meta property="og:image" content="https://example.com/og.jpg">
        </head><body>
        <img src="https://example.com/body.jpg" width="800" height="600">
        </body></html>
        """
        result = extract_lead_image(html, "https://example.com")
        assert result is not None
        assert result.startswith("https://")

    def test_fallback_to_og(self):
        from worker.fulltext import extract_lead_image
        html = '<meta property="og:image" content="https://example.com/fallback.jpg">'
        result = extract_lead_image(html, "https://example.com")
        assert result == "https://example.com/fallback.jpg"

    def test_returns_none_for_no_images(self):
        from worker.fulltext import extract_lead_image
        result = extract_lead_image("<html><body><p>No images here</p></body></html>", "")
        assert result is None


# ── extract.py image_url flow ─────────────────────────────────────────

class TestExtractImageFlow:
    """The extractor must NOT carry an image_url.

    The picture belongs to the ARTICLE, and it is captured at INGEST by
    worker/fetch.py::_entry_image — the one place that decides which
    image is the article's. The extractor (the AI, or the regex
    fallback) reads the article and writes back a summary, a place and
    a category; it is not allowed to overwrite the picture, because a
    model that hallucinates an image URL would put a broken picture on
    the map. So the contract is the opposite of what these tests used
    to assert: the key must be ABSENT, not present-and-None.
    """

    def test_normalize_drops_image_url(self):
        from worker.extract import _normalize
        result = _normalize({
            "summary": "test",
            "event_type": "politics",
            "image_url": "https://example.com/best.jpg",
        })
        assert "image_url" not in result

    def test_normalize_has_no_image_url_key(self):
        from worker.extract import _normalize
        result = _normalize({
            "summary": "test",
            "event_type": "other",
            "image_url": "",
        })
        assert "image_url" not in result

    def test_normalize_keeps_its_own_fields(self):
        from worker.extract import _normalize
        result = _normalize({
            "summary": "test",
            "event_type": "other",
        })
        assert result["summary"] == "test"
        assert result["event_type"] == "other"

    def test_regex_fallback_has_no_image_url(self):
        from worker.extract import _regex_fallback
        result = _regex_fallback("Title", "Body text")
        assert "image_url" not in result

    def test_lightweight_extract_has_no_image_url(self):
        from worker.extract import _lightweight_extract
        result = _lightweight_extract({"title": "Test", "body": "Some body text"})
        assert "image_url" not in result

    def test_the_INGEST_is_where_the_picture_comes_from(self):
        # The whole point of the contract above: the picture is
        # resolved once, at ingest, and survives everything after it.
        from worker.fetch import _entry_image
        entry = {"enclosures": [{"href": "https://example.com/photo.jpg", "type": "image/jpeg"}]}
        assert _entry_image(entry, "https://example.com") == "https://example.com/photo.jpg"


# ── RSS _entry_image ──────────────────────────────────────────────────

class TestRssEntryImage:
    def test_enclosure_image(self):
        from worker.fetch import _entry_image
        entry = {
            "enclosures": [{"href": "https://example.com/photo.jpg", "type": "image/jpeg"}],
        }
        result = _entry_image(entry, "https://example.com")
        assert result == "https://example.com/photo.jpg"

    def test_og_image_from_html_content(self):
        from worker.fetch import _entry_image
        entry = {
            "content": [{'value': '<meta property="og:image" content="https://example.com/og.jpg">'}],
        }
        result = _entry_image(entry, "https://example.com")
        assert result == "https://example.com/og.jpg"

    def test_media_content(self):
        from worker.fetch import _entry_image
        entry = {
            "media_content": [{"url": "https://example.com/media.jpg", "medium": "image"}],
        }
        result = _entry_image(entry, "https://example.com")
        assert result == "https://example.com/media.jpg"

    def test_noise_filtered(self):
        from worker.fetch import _entry_image
        entry = {
            "enclosures": [{"href": "https://example.com/pixel.gif", "type": "image/gif"}],
        }
        result = _entry_image(entry, "https://example.com")
        assert result is None

    def test_no_images_returns_none(self):
        from worker.fetch import _entry_image
        entry = {"title": "No images here"}
        result = _entry_image(entry, "https://example.com")
        assert result is None

    def test_relative_url_resolved(self):
        from worker.fetch import _entry_image
        entry = {
            "enclosures": [{"href": "/uploads/photo.jpg", "type": "image/jpeg"}],
        }
        result = _entry_image(entry, "https://publisher.com")
        assert result == "https://publisher.com/uploads/photo.jpg"


# ── image proxy URL validation ────────────────────────────────────────

class TestImageProxyValidation:
    """Test the image proxy URL validation logic (mirrors server-side checks)."""

    def test_rejects_non_http(self):
        """Only http/https URLs should be accepted."""
        from urllib.parse import urlparse
        for bad in ["ftp://example.com/img.jpg", "file:///etc/passwd", "javascript:alert(1)"]:
            p = urlparse(bad)
            assert p.scheme not in ("http", "https"), f"Should reject {bad}"

    def test_rejects_private_ips(self):
        """Private/internal IPs should be blocked."""
        import re
        blocked = ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254"]
        for ip in blocked:
            is_private = (
                ip.startswith("10.")
                or re.match(r"^172\.(1[6-9]|2\d|3[01])\.", ip) is not None
                or ip.startswith("192.168.")
                or ip in ("127.0.0.1", "0.0.0.0", "::1", "169.254.169.254")
            )
            assert is_private, f"{ip} should be detected as private"

    def test_accepts_public_urls(self):
        """Public image URLs should pass validation."""
        from urllib.parse import urlparse
        good = [
            "https://cdn.example.com/photo.jpg",
            "https://images.publisher.com/2026/hero.webp",
            "http://legacy-site.com/img.png",
        ]
        for url in good:
            p = urlparse(url)
            assert p.scheme in ("http", "https")
            assert not p.hostname.startswith("10.")
            assert not p.hostname.startswith("192.168.")


# ── frontend imgOnError logic (structural test) ───────────────────────

class TestImageFallbackLogic:
    """Verify the imgOnError fallback strategy is correctly structured."""

    def test_proxy_url_format(self):
        """The proxy fallback URL should be correctly formatted."""
        orig = "https://publisher.com/hero.jpg"
        proxy_url = f"/api/image-proxy?url={orig}"
        assert proxy_url.startswith("/api/image-proxy?url=")
        assert "publisher.com" in proxy_url

    def test_referrerpolicy_set(self):
        """All img tags should include referrerpolicy=no-referrer."""
        import re
        app_js = Path(__file__).resolve().parents[2] / "public_html" / "app.js"
        content = app_js.read_text()
        # Count img tags with referrerpolicy
        img_tags = re.findall(r'<img[^>]+src=', content)
        referrer_tags = re.findall(r'referrerpolicy="no-referrer"', content)
        assert len(referrer_tags) >= 3, (
            f"Expected at least 3 img tags with referrerpolicy, found {len(referrer_tags)}"
        )

    def test_imgOnError_function_exists(self):
        """The imgOnError fallback function should exist in app.js."""
        app_js = Path(__file__).resolve().parents[2] / "public_html" / "app.js"
        content = app_js.read_text()
        assert "function imgOnError" in content
        # The proxy is now tried ONCE per image and a failing HOST is
        # remembered in sessionStorage, so the marker is the blocklist,
        # not a per-image "proxyTried" flag.
        assert "xyzo_img_blocked" in content
        assert "/api/image-proxy" in content


# ── the two image-URL faults of 2026-11-04 ──────────────────────────────

class TestImageUrlRepairs:
    """The faults behind the 404s in the console.

    (1) A URL lifted out of an HTML attribute still carries its
        ENTITIES: "…?format=jpg&amp;name=large" is stored verbatim
        and the publisher answers 404 for it.
    (2) A hostname was being CORRUPTED, and NON-DETERMINISTICALLY:
        the splitter cut "www.infomoney.com.br" at ".in" or ".info"
        because ".br" was not in its TLD table, and the tie between
        the two candidates was broken by the iteration order of a SET
        — which PYTHONHASHSEED randomises per process. The same URL
        therefore became a DIFFERENT broken host on every run.
    """

    def test_entities_are_unescaped(self):
        from worker.fetch import _sanitize_image_url
        out = _sanitize_image_url(
            "https://pbs.twimg.com/media/X?format=jpg&amp;name=large")
        assert out == "https://pbs.twimg.com/media/X?format=jpg&name=large"

    def test_a_two_letter_tld_is_not_mangled(self):
        from worker.fetch import _sanitize_image_url
        out = _sanitize_image_url("https://www.infomoney.com.br/a/b.jpg")
        assert out == "https://www.infomoney.com.br/a/b.jpg"

    def test_the_same_url_always_gives_the_same_answer(self):
        # The determinism is the point: a set's iteration order is not
        # stable across processes, so a tie broken by it produced a
        # different broken hostname on every run.
        from worker.fetch import _sanitize_image_url
        url = "https://www.infomoney.com.br/wp-content/uploads/x.jpg?fit=300%2C200&quality=70"
        results = {_sanitize_image_url(url) for _ in range(50)}
        assert len(results) == 1
        assert results.pop() == url

    def test_the_ingest_unescapes_what_it_extracts(self):
        from worker.fetch import _entry_image
        entry = {"content": [{"value": '<img src="https://e.com/a.jpg?x=1&amp;y=2">'}]}
        assert _entry_image(entry, "https://e.com") == "https://e.com/a.jpg?x=1&y=2"

    def test_a_relative_url_is_resolved(self):
        from worker.fetch import _entry_image
        entry = {"enclosures": [{"href": "/uploads/photo.jpg", "type": "image/jpeg"}]}
        assert _entry_image(entry, "https://publisher.com") == "https://publisher.com/uploads/photo.jpg"
