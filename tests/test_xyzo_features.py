"""Tests for xyzo_features: flag + config reader used by worker subprocesses."""
import pytest
from unittest.mock import patch

from api.src.xyzo_features import (
    is_enabled, get_config, get_all_flags,
    _stable_hash, _resolve_pct,
    invalidate_cache,
)


@pytest.fixture(autouse=True)
def _clear_xyzo_cache():
    """Each test starts with an empty cache so mocks are always exercised."""
    invalidate_cache()
    yield
    invalidate_cache()


class TestStableHash:
    def test_deterministic(self):
        assert _stable_hash("foo:bar.com") == _stable_hash("foo:bar.com")

    def test_different_inputs_differ(self):
        assert _stable_hash("a:x") != _stable_hash("b:x")
        assert _stable_hash("a:x") != _stable_hash("a:y")

    def test_range_zero_to_99(self):
        for i in range(20):
            assert 0 <= _stable_hash(f"k:{i}") < 2**31


class TestResolvePct:
    def test_host_override_takes_precedence(self):
        flag = {
            "rollout_pct": 100, "tier_overrides": {},
            "host_overrides": {"bad.com": False}
        }
        assert _resolve_pct(flag, "bad.com", "commercial") is False
        assert _resolve_pct(flag, "good.com", "commercial") is True

    def test_tier_override_beats_rollout(self):
        flag = {
            "rollout_pct": 100, "tier_overrides": {"gov": 0},
            "host_overrides": {}
        }
        assert _resolve_pct(flag, "whitehouse.gov", "gov") is False
        assert _resolve_pct(flag, "eventbrite.com", "commercial") is True

    def test_falls_back_to_rollout(self):
        flag = {
            "rollout_pct": 0, "tier_overrides": {},
            "host_overrides": {}
        }
        assert _resolve_pct(flag, "anything.com", "anything") is False


class TestIsEnabled:
    def test_emergency_kill_switch_overrides_everything(self):
        flags = {
            "emergency_disable_intelligence": {"enabled": True},
            "ai_intelligence_scan": {"enabled": True, "rollout_pct": 100,
                                     "tier_overrides": {}, "host_overrides": {}},
        }
        assert is_enabled("ai_intelligence_scan", "x.com", "commercial",
                          flags=flags) is False

    def test_disabled_flag_returns_false(self):
        flags = {"ai_intelligence_scan": {"enabled": False, "rollout_pct": 0,
                                          "tier_overrides": {}, "host_overrides": {}},
                 "emergency_disable_intelligence": {"enabled": False}}
        assert is_enabled("ai_intelligence_scan", "x.com", "commercial",
                          flags=flags) is False

    def test_enabled_with_full_rollout(self):
        flags = {"ai_intelligence_scan": {"enabled": True, "rollout_pct": 100,
                                          "tier_overrides": {}, "host_overrides": {}},
                 "emergency_disable_intelligence": {"enabled": False}}
        assert is_enabled("ai_intelligence_scan", "x.com", "commercial",
                          flags=flags) is True


class TestGetConfig:
    def test_returns_value_when_present(self):
        with patch("api.src.xyzo_features._fetch_config") as m:
            m.return_value = {"classifier.weight": "0.4"}
            assert get_config("classifier.weight") == "0.4"

    def test_returns_default_when_missing(self):
        with patch("api.src.xyzo_features._fetch_config") as m:
            m.return_value = {}
            assert get_config("classifier.weight", default="0.5") == "0.5"

    def test_handles_db_failure(self):
        with patch("api.src.xyzo_features._fetch_config") as m:
            m.side_effect = Exception("db down")
            assert get_config("classifier.weight", default="0.5") == "0.5"


class TestGetAllFlags:
    def test_returns_dict_from_db(self):
        with patch("api.src.xyzo_features._fetch_all_flags") as m:
            m.return_value = {"foo": {"enabled": True, "rollout_pct": 0,
                                       "tier_overrides": {}, "host_overrides": {}}}
            result = get_all_flags()
            assert "foo" in result
            assert result["foo"]["enabled"] is True
