"""Tests for the AI scan prompt template."""
from worker.prompts.intelligence_scan import (
    build_prompt, prompt_hash, PROMPT_VERSION,
)


class TestPromptVersion:
    def test_version_is_set(self):
        assert isinstance(PROMPT_VERSION, str)
        assert len(PROMPT_VERSION) > 0


class TestPromptHash:
    def test_deterministic(self):
        ctx = {"seed_url": "https://x.com", "feeds": [], "pages": []}
        h1 = prompt_hash(build_prompt(ctx))
        h2 = prompt_hash(build_prompt(ctx))
        assert h1 == h2

    def test_changes_when_prompt_changes(self):
        ctx = {"seed_url": "https://x.com", "feeds": [], "pages": []}
        p1 = build_prompt(ctx) + "extra"
        assert prompt_hash(p1) != prompt_hash(build_prompt(ctx))


class TestBuildPrompt:
    def test_includes_schema_spec(self):
        prompt = build_prompt({"seed_url": "https://x.com",
                               "feeds": [], "pages": []})
        assert "feeds" in prompt
        assert "structural_map" in prompt
        assert "sd_fingerprint" in prompt
        assert "politics" in prompt

    def test_includes_seed_url(self):
        prompt = build_prompt({"seed_url": "https://example.com",
                               "feeds": [], "pages": []})
        assert "https://example.com" in prompt

    def test_includes_pages(self):
        ctx = {"seed_url": "https://x.com", "feeds": [],
               "pages": [{"url": "https://x.com/events", "text": "lots of events"}]}
        prompt = build_prompt(ctx)
        assert "https://x.com/events" in prompt
        assert "lots of events" in prompt

    def test_includes_discovered_feeds(self):
        ctx = {"seed_url": "https://x.com",
               "feeds": [{"href": "https://x.com/feed", "type": "rss"}],
               "pages": []}
        prompt = build_prompt(ctx)
        assert "https://x.com/feed" in prompt

    def test_requires_json_array_response(self):
        prompt = build_prompt({"seed_url": "https://x.com",
                               "feeds": [], "pages": []})
        assert "JSON" in prompt or "json" in prompt

    def test_gov_tier_includes_conservative_preamble(self):
        ctx = {"seed_url": "https://city.gov", "tier": "gov",
               "feeds": [], "pages": []}
        prompt = build_prompt(ctx)
        assert "POLITENESS RULES" in prompt
        assert "robots.txt" in prompt

    def test_university_tier_includes_conservative_preamble(self):
        ctx = {"seed_url": "https://example.edu", "tier": "university",
               "feeds": [], "pages": []}
        prompt = build_prompt(ctx)
        assert "POLITENESS RULES" in prompt

    def test_commercial_tier_has_no_preamble(self):
        ctx = {"seed_url": "https://x.com", "tier": "commercial",
               "feeds": [], "pages": []}
        prompt = build_prompt(ctx)
        assert "POLITENESS RULES" not in prompt
