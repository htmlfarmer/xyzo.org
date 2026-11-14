"""Timestamp regression suite — the +7/8h TZ skew class (FIX_NOTES 1.1 / BUG-1).

feedparser's `*_parsed` is a UTC struct_time. `time.mktime()` interprets it in
SERVER LOCAL time — this box runs America/Los_Angeles, so every timestamp that
went through mktime was stamped 7–8 hours in the FUTURE:
11,435 future-dated articles in one 24h window, inverted freshness ranking,
cluster ±6h windows splitting syndicated copies, poisoned `since` filters.

fetch.py was fixed to `calendar.timegm`. The identical bug survived in
audio_fetch.py, video_fetch.py and immediate_discover.py until this suite was
written. These tests run under the PRODUCTION server TZ (America/Los_Angeles)
so any reintroduction of mktime anywhere in the ingestion chain fails loudly.
"""
from __future__ import annotations

import calendar
import os
import time as _time_module
from datetime import datetime, timezone

import pytest

SERVER_TZ = "America/Los_Angeles"

# 2026-09-22 (Tue) 21:00:00 UTC == 14:00 PDT — an mktime() conversion would
# yield 04:00 UTC the next day (+7h), so the hour check is discriminating.
UTC_STRUCT = (2026, 9, 22, 21, 0, 0, 1, 265, 0)  # (Y, M, D, h, m, s, wday, yday, isdst=0)
EXPECTED_ISO = "2026-09-22T21:00:00+00:00"


@pytest.fixture(scope="module", autouse=True)
def production_timezone():
    """Pin TZ to the live server's timezone for the whole module."""
    old = os.environ.get("TZ")
    os.environ["TZ"] = SERVER_TZ
    _time_module.tzset()
    yield
    if old is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = old
    _time_module.tzset()


def test_timezone_fixture_is_effective():
    """Guard against the fixture silently not applying (tzset missing etc.)."""
    t = calendar.timegm(UTC_STRUCT)
    local_h = datetime.fromtimestamp(t).hour  # naive → local
    utc_h = datetime.fromtimestamp(t, tz=timezone.utc).hour
    assert utc_h == 21
    # In LA, 21:00 UTC is 14:00 local — mktime would treat the struct as 14:00
    # and skew. If these ever match, TZ is UTC and this suite loses power.
    assert local_h != utc_h or SERVER_TZ == "UTC"


class TestFeedPublishedConversion:
    def test_fetch_entry_published_is_utc(self):
        from worker.fetch import _entry_published

        entry = {"published_parsed": UTC_STRUCT}
        dt = _entry_published(entry)
        assert dt is not None
        assert dt == datetime(2026, 9, 22, 21, 0, tzinfo=timezone.utc), (
            f"fetch._entry_published returned {dt.isoformat()} — expected 21:00 UTC. "
            "This is the BUG-1 +7/8h mktime signature."
        )

    def test_immediate_discover_parse_date_is_utc(self):
        from worker.immediate_discover import _parse_date

        entry = {"published_parsed": UTC_STRUCT}
        iso = _parse_date(entry)
        assert iso == EXPECTED_ISO, (
            f"immediate_discover._parse_date returned {iso!r} — expected {EXPECTED_ISO}"
        )

    def test_audio_feed_published_is_utc(self):
        from worker.audio_fetch import parse_podcast_feed

        rss = f"""<?xml version="1.0"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
<channel>
  <title>Test Pod</title><link>https://example.com</link>
  <description>fixture</description>
  <item>
    <title>Episode One</title>
    <guid>ep-1</guid>
    <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Tue, 22 Sep 2026 21:00:00 GMT</pubDate>
    <description>Some show notes about a thing that happened today.</description>
  </item>
</channel></rss>"""
        _channel, episodes = parse_podcast_feed(rss.encode("utf-8"))
        assert episodes, "fixture feed parsed to zero episodes — test itself broken"
        ep = episodes[0]
        pub = ep.get("published_at")
        assert pub is not None
        if isinstance(pub, str):
            pub = datetime.fromisoformat(pub)
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        assert pub.astimezone(timezone.utc).hour == 21, (
            f"audio published_at={pub.isoformat()} — mktime skew (+7h) reintroduced"
        )

    def test_video_rss_published_is_utc(self):
        from worker.video_fetch import _parse_video_rss

        rss = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <id>channel:test</id>
  <entry>
    <id>video:abc123</id>
    <title>Video One</title>
    <published>2026-09-22T21:00:00+00:00</published>
    <media:group xmlns:media="http://search.yahoo.com/mrss/">
      <media:title>Video One</media:title>
    </media:group>
    <yt:videoId xmlns:yt="http://www.youtube.com/xml/schemas/2015">abc123</yt:videoId>
  </entry>
</feed>"""
        videos = _parse_video_rss(rss.encode("utf-8"))
        assert videos, "fixture video feed parsed to zero entries — test itself broken"
        pub = videos[0].get("published_at")
        assert pub is not None
        if isinstance(pub, str):
            pub = datetime.fromisoformat(pub)
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        assert pub.astimezone(timezone.utc).hour == 21, (
            f"video published_at={pub.isoformat()} — mktime skew reintroduced"
        )


class TestNoMktimeAnywhere:
    """Structural guard: no ingestion module may use time.mktime for
    feedparser structs again. (mktime has legitimate uses, but zero in worker/.
    If one is ever needed outside timestamps, add it to ALLOWLIST with a comment.)"""

    ALLOWLIST: set[str] = set()  # currently zero tolerated uses

    def test_worker_tree_has_no_time_mktime(self):
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[1]  # worker/
        offenders = []
        pat = re.compile(r"(?<![\w.])((?:_time|time)\.mktime\s*\()")
        for py in sorted(root.glob("*.py")):
            if py.name in self.ALLOWLIST:
                continue
            for i, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                if pat.search(line):
                    offenders.append(f"{py.name}:{i}: {stripped}")
        assert not offenders, (
            "time.mktime() interprets feedparser's UTC struct in server-local "
            "TZ — use calendar.timegm() (see BUG-1). Offenders:\n"
            + "\n".join(offenders)
        )


class TestTimegmSemantics:
    """Positive control that the fixture struct + timegm really mean 21:00 UTC."""

    def test_timegm_matches_expected(self):
        assert calendar.timegm(UTC_STRUCT) == calendar.timegm(
            datetime(2026, 9, 22, 21, 0, tzinfo=timezone.utc).timetuple()
        )
