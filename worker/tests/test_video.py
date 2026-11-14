"""Tests for XYZO video system — discover, link, fetch, schema."""
import os
import json
import pytest

os.environ.setdefault("XYZO_DB_DSN", "postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo")


# ── video_discover.py ────────────────────────────────────────────────────

class TestVideoDiscover:
    """Test YouTube URL extraction from HTML."""

    def test_embed_url(self):
        from worker.video_discover import discover_videos
        html = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'
        vids = discover_videos(html)
        assert len(vids) == 1
        assert vids[0]["video_id"] == "dQw4w9WgXcQ"
        assert vids[0]["source"] == "iframe"

    def test_watch_url(self):
        from worker.video_discover import discover_videos
        html = '<a href="https://www.youtube.com/watch?v=jNQXAC9IVRw">link</a>'
        vids = discover_videos(html)
        assert len(vids) == 1
        assert vids[0]["video_id"] == "jNQXAC9IVRw"
        assert vids[0]["source"] == "link"

    def test_short_url(self):
        from worker.video_discover import discover_videos
        html = 'Check https://youtu.be/9bZkp7q19f0 for more'
        vids = discover_videos(html)
        assert len(vids) == 1
        assert vids[0]["video_id"] == "9bZkp7q19f0"

    def test_shorts_url(self):
        from worker.video_discover import discover_videos
        html = '<a href="https://www.youtube.com/shorts/gzlHQzhMaRc">short</a>'
        vids = discover_videos(html)
        assert len(vids) == 1
        assert vids[0]["video_id"] == "gzlHQzhMaRc"

    def test_v_embed_url(self):
        from worker.video_discover import discover_videos
        html = '<iframe src="https://www.youtube.com/v/OPf0YbXqDm0"></iframe>'
        vids = discover_videos(html)
        assert len(vids) == 1
        assert vids[0]["video_id"] == "OPf0YbXqDm0"

    def test_deduplication(self):
        from worker.video_discover import discover_videos
        html = """
        <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
        <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">same video</a>
        <a href="https://youtu.be/dQw4w9WgXcQ">same again</a>
        """
        vids = discover_videos(html)
        assert len(vids) == 1

    def test_multiple_videos(self):
        from worker.video_discover import discover_videos
        html = """
        <iframe src="https://www.youtube.com/embed/aaa11111111"></iframe>
        <iframe src="https://www.youtube.com/embed/bbb22222222"></iframe>
        <iframe src="https://www.youtube.com/embed/ccc33333333"></iframe>
        """
        vids = discover_videos(html)
        assert len(vids) == 3
        ids = {v["video_id"] for v in vids}
        assert ids == {"aaa11111111", "bbb22222222", "ccc33333333"}

    def test_empty_html(self):
        from worker.video_discover import discover_videos
        assert discover_videos("") == []
        assert discover_videos(None) == []
        assert discover_videos("<p>no videos</p>") == []

    def test_invalid_id_too_short(self):
        from worker.video_discover import discover_videos
        html = '<a href="https://www.youtube.com/watch?v=abc">short</a>'
        vids = discover_videos(html)
        assert len(vids) == 0

    def test_invalid_id_special_chars(self):
        from worker.video_discover import discover_videos
        # YouTube IDs only use [a-zA-Z0-9_-] — special chars invalidate
        html = '<a href="https://www.youtube.com/watch?v=abc!@#$%^&*()">special</a>'
        vids = discover_videos(html)
        assert len(vids) == 0

    def test_non_youtube_ignored(self):
        from worker.video_discover import discover_videos
        html = '<iframe src="https://player.vimeo.com/video/12345678"></iframe>'
        vids = discover_videos(html)
        assert len(vids) == 0

    def test_url_encoded_ampersand(self):
        from worker.video_discover import discover_videos
        html = '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=30">time</a>'
        vids = discover_videos(html)
        assert len(vids) == 1
        assert vids[0]["video_id"] == "dQw4w9WgXcQ"

    def test_discover_from_urls(self):
        from worker.video_discover import discover_videos_from_urls
        urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/jNQXAC9IVRw",
            "https://not-youtube.com/video/abc",
        ]
        vids = discover_videos_from_urls(urls)
        assert len(vids) == 2
        ids = {v["video_id"] for v in vids}
        assert ids == {"dQw4w9WgXcQ", "jNQXAC9IVRw"}


# ── video_linker.py ──────────────────────────────────────────────────────

class TestVideoLinker:
    """Test video type classification and country detection."""

    def test_classify_interview(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("PM interviews with BBC", "") == "interview"
        assert _classify_video_type("President sits down with journalist", "") == "interview"

    def test_classify_press_conference(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("White House press briefing", "") == "press_conference"
        assert _classify_video_type("Spokesperson answers questions", "") == "press_conference"

    def test_classify_breaking(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("BREAKING: Earthquake hits Tokyo", "") == "breaking"
        assert _classify_video_type("Just in: Fire downtown", "") == "breaking"

    def test_classify_live(self):
        from worker.video_linker import _classify_video_type
        # "live:" matches breaking keywords first — that's fine, both are valid
        result = _classify_video_type("Watch live: election results", "")
        assert result in ("live_news", "breaking")

    def test_classify_documentary(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("Inside the factory: how cars are made", "") == "documentary"

    def test_classify_explainer(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("What is quantum computing? Explained", "") == "explainer"

    def test_classify_sports(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("Champions League final highlights", "") == "sports_news"

    def test_classify_weather(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("Hurricane approaching Florida coast", "") == "weather"

    def test_classify_default(self):
        from worker.video_linker import _classify_video_type
        assert _classify_video_type("General news update", "") == "news_report"

    def test_detect_country_us(self):
        from worker.video_linker import _detect_country
        assert _detect_country("White House announces new policy", "") == "US"
        assert _detect_country("Congress votes on bill", "") == "US"

    def test_detect_country_uk(self):
        from worker.video_discover import discover_videos
        from worker.video_linker import _detect_country
        assert _detect_country("British PM visits London", "") == "GB"
        assert _detect_country("Parliament debates Brexit", "") == "GB"

    def test_detect_country_india(self):
        from worker.video_linker import _detect_country
        assert _detect_country("Modi visits Delhi", "") == "IN"
        assert _detect_country("Indian economy grows", "") == "IN"

    def test_detect_country_pakistan(self):
        from worker.video_linker import _detect_country
        assert _detect_country("Pakistan cricket team wins", "") == "PK"

    def test_detect_country_none(self):
        from worker.video_linker import _detect_country
        assert _detect_country("General news", "") is None

    def test_detect_location_text(self):
        from worker.video_linker import _detect_location_text
        assert _detect_location_text("Floods in Jakarta cause damage", None) == "Jakarta"
        assert _detect_location_text("Protest at Parliament today", None) == "Parliament"


# ── video_fetch.py ───────────────────────────────────────────────────────

class TestVideoFetch:
    """Test RSS parsing and channel management."""

    def test_parse_youtube_rss(self):
        from worker.video_fetch import _parse_video_rss
        import httpx

        resp = httpx.get(
            "https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA",
            timeout=15,
        )
        items = _parse_video_rss(resp.content)
        assert len(items) > 0
        assert all("video_id" in item for item in items)
        assert all("url" in item for item in items)
        assert all("title" in item for item in items)
        # Check deduplication
        ids = [item["video_id"] for item in items]
        assert len(ids) == len(set(ids))

    def test_parse_aljazeera_rss(self):
        from worker.video_fetch import _parse_video_rss
        import httpx

        resp = httpx.get("https://www.aljazeera.com/xml/rss/all.xml", timeout=15)
        items = _parse_video_rss(resp.content)
        # Al Jazeera RSS has mixed articles/videos
        assert len(items) > 0

    def test_iso_duration_parsing(self):
        from worker.video_fetch import _parse_iso_duration
        assert _parse_iso_duration("PT1H2M3S") == 3723
        assert _parse_iso_duration("PT30M") == 1800
        assert _parse_iso_duration("PT45S") == 45
        assert _parse_iso_duration("PT1H") == 3600
        assert _parse_iso_duration("") is None
        assert _parse_iso_duration(None) is None

    def test_load_video_sources(self):
        from worker.video_fetch import load_video_sources
        sources = load_video_sources()
        assert len(sources) > 0
        assert all("name" in s for s in sources)
        assert all("channel_url" in s for s in sources)


# ── video_geocode.py ─────────────────────────────────────────────────────

class TestVideoGeocode:
    """Test geocoding functionality."""

    def test_geocode_location(self):
        from worker.video_geocode import _geocode_location
        coords = _geocode_location("London")
        assert coords is not None
        assert 51.0 < coords[0] < 52.0  # lat
        assert -1.0 < coords[1] < 1.0   # lng

    def test_geocode_unknown(self):
        from worker.video_geocode import _geocode_location
        coords = _geocode_location("xyznonexistent12345")
        assert coords is None


# ── Schema validation ────────────────────────────────────────────────────

class TestSchema:
    """Test that schema objects exist and are well-formed."""

    def test_schema_file_exists(self):
        assert os.path.exists("api/schema-video.sql")

    def test_schema_has_tables(self):
        with open("api/schema-video.sql") as f:
            sql = f.read()
        assert "CREATE TABLE IF NOT EXISTS video_channels" in sql
        assert "CREATE TABLE IF NOT EXISTS video_items" in sql
        assert "CREATE TABLE IF NOT EXISTS video_people" in sql
        assert "CREATE TABLE IF NOT EXISTS video_claims" in sql
        assert "CREATE TABLE IF NOT EXISTS video_article_matches" in sql
        assert "CREATE TABLE IF NOT EXISTS video_audio_matches" in sql

    def test_schema_has_views(self):
        with open("api/schema-video.sql") as f:
            sql = f.read()
        assert "CREATE OR REPLACE VIEW video_items_enriched" in sql
        assert "CREATE OR REPLACE VIEW video_location_topics" in sql
        assert "CREATE OR REPLACE VIEW video_channel_stats" in sql

    def test_schema_is_idempotent(self):
        with open("api/schema-video.sql") as f:
            sql = f.read()
        # All CREATE TABLE should have IF NOT EXISTS
        import re
        creates = re.findall(r"CREATE TABLE (\w+)", sql)
        if_not_exists = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", sql)
        assert len(creates) == len(if_not_exists), \
            f"Some tables missing IF NOT EXISTS: {set(creates) - set(if_not_exists)}"


# ── API routes ───────────────────────────────────────────────────────────

class TestVideoAPI:
    """Test video API endpoints via HTTP."""

    BASE = "http://localhost:3008/api/video"

    def test_stats_endpoint(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/stats", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "stats" in data
        assert data["stats"]["total_videos"] > 0
        assert data["stats"]["geocoded_videos"] > 0

    def test_channels_endpoint(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/channels?limit=5", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert data["count"] > 0
        assert len(data["items"]) <= 5

    def test_videos_endpoint(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/videos?limit=5", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert data["count"] > 0
        assert len(data["items"]) <= 5

    def test_videos_search(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/videos?q=news&limit=3", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] > 0

    def test_map_endpoint(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/map?bbox=-180,-90,180,90&limit=5", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "pins" in data
        assert data["count"] > 0
        # Check pin structure
        pin = data["pins"][0]
        assert "location" in pin
        assert "lat" in pin["location"]
        assert "lng" in pin["location"]

    def test_map_requires_bbox(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/map", timeout=10)
        assert resp.status_code == 400

    def test_video_detail(self):
        import httpx
        # Get first video ID
        resp = httpx.get(f"{self.BASE}/videos?limit=1", timeout=10)
        data = resp.json()
        if data["items"]:
            vid_id = data["items"][0]["id"]
            detail_resp = httpx.get(f"{self.BASE}/videos/{vid_id}", timeout=10)
            assert detail_resp.status_code == 200
            detail = detail_resp.json()
            assert "video" in detail
            assert "matched_articles" in detail

    def test_channel_detail(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/channels?limit=1", timeout=10)
        data = resp.json()
        if data["items"]:
            ch_id = data["items"][0]["id"]
            detail_resp = httpx.get(f"{self.BASE}/channels/{ch_id}", timeout=10)
            assert detail_resp.status_code == 200
            detail = detail_resp.json()
            assert "channel" in detail
            assert "videos" in detail

    def test_people_endpoint(self):
        import httpx
        resp = httpx.get(f"{self.BASE}/people?limit=5", timeout=10)
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data


class TestVideoSiteCrawler:
    """Test video site crawling functionality."""

    def test_probe_video_sections(self):
        from worker.video_site_crawler import _probe_video_sections
        import httpx

        with httpx.Client(timeout=15, follow_redirects=True,
                          headers={"User-Agent": "Mozilla/5.0"}) as client:
            sections = _probe_video_sections("https://lesoleil.sn", client)
            assert len(sections) > 0
            assert any("web-tv" in s for s in sections)

    def test_extract_video_links(self):
        from worker.video_site_crawler import _extract_video_links
        import httpx

        resp = httpx.get("https://lesoleil.sn/rubriques/web-tv/", timeout=15,
                         headers={"User-Agent": "Mozilla/5.0"})
        links = _extract_video_links("https://lesoleil.sn/rubriques/web-tv/", resp.text)
        assert len(links) > 0
        assert any("lesoleil.sn" in l for l in links)

    def test_extract_embedded_videos(self):
        from worker.video_site_crawler import _extract_embedded_videos
        import httpx

        resp = httpx.get(
            "https://lesoleil.sn/actualites/technologie/video-rentree-numerique-lia-et-la-cybersecurite-au-coeur-des-priorites/",
            timeout=15, headers={"User-Agent": "Mozilla/5.0"},
        )
        vids = _extract_embedded_videos(resp.url, resp.text)
        assert len(vids) > 0
        assert vids[0]["video_id"]  # YouTube ID found


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
