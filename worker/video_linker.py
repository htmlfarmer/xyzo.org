"""Video linker — discovers YouTube videos embedded in article bodies
and creates video_items entries for them. Also classifies video_type
from title/description keywords.

THE BIG INSIGHT:
  Most news articles don't contain video themselves, but many EMBED
  YouTube videos (interviews, footage, explainers). By scanning every
  fetched article for YouTube URLs, XYZO auto-discovers video news
  without needing separate video sources. This is how we found 114+
  videos from 163 articles in the initial run.

FLOW:
  After article fetch, scan each article body for YouTube URLs:
    → youtube.com/watch?v=VIDEO_ID, youtu.be/VIDEO_ID, /embed/, /shorts/
  For each discovered video:
    → Create video_items entry (or update if exists)
    → Link to source article via video_article_matches
    → Auto-classify video_type from title/description keywords
    → Auto-detect country from title/description keywords

KEYWORD CLASSIFICATION:
  We don't use AI for this (no GPU burn). Simple keyword matching
  classifies video_type (interview, explainer, breaking, etc.) and
  country detection from title text. It's fast, free, and 80% accurate.

WHY THIS MATTERS:
  A single article about "Ukraine ceasefire talks" might embed 3 YouTube
  videos: a BBC report, a Reuters interview, and a government briefing.
  Without this linker, those videos would be invisible to XYZO.
"""
import logging
import re

from .db import connect
from .video_discover import discover_videos

log = logging.getLogger("xyzo.video_linker")

VIDEO_TYPE_KEYWORDS = {
    "interview": ["interview", "talks to", "speaks with", "conversation with",
                   "sits down with", "q&a", "one-on-one"],
    "press_conference": ["press conference", "press briefing", "briefing",
                          "white house says", "spokesperson"],
    "documentary": ["documentary", "investigation", "investigates",
                     "inside the", "the story of", "how ", "why "],
    "explainer": ["explained", "explainer", "what is", "how does",
                   "in 60 seconds", "in 2 minutes", "understanding"],
    "breaking": ["breaking", "just in", "developing", "live:",
                  "happening now", "alerts"],
    "eyewitness": ["footage", "video shows", "caught on camera",
                    "witness", "cell phone", "dashcam"],
    "field_report": ["correspondent", "reports from", "on the ground",
                      "from the scene", "reporting live"],
    "live_news": ["live:", "live ", "streaming now", "watch live"],
    "sports_news": ["match", "game", "tournament", "championship",
                     "score", "goals", "win", "defeat", "cup", "league"],
    "weather": ["weather", "storm", "hurricane", "cyclone", "flood",
                 "earthquake", "tsunami", "wildfire", "temperature"],
    "disaster": ["disaster", "collapsed", "explosion", "crash",
                  "rescue", "casualties", "death toll", "devastation"],
    "science_video": ["researchers find", "study shows", "scientists",
                       "discovery", "nasa", "space", "climate"],
    "government_video": ["parliament", "congress", "senate",
                          "hearing", "committee", "vote", "legislation"],
}

# Country detection from title + description text
COUNTRY_KEYWORDS = {
    "US": ["united states", "america", "washington", "white house", "capitol",
           "congress", "senate", "pentagon", "fbi", "cnn", "fox news"],
    "GB": ["britain", "british", "london", "uk ", "united kingdom",
           "parliament", "westminster", "bbc"],
    "FR": ["france", "french", "paris", "elysee", "macron"],
    "DE": ["germany", "german", "berlin", "bundestag", "scholz"],
    "IN": ["india", "indian", "delhi", "mumbai", "modi", "hindu", "bollywood"],
    "PK": ["pakistan", "pakistani", "islamabad", "karachi", "lahore"],
    "BD": ["bangladesh", "bangladeshi", "dhaka"],
    "AU": ["australia", "australian", "sydney", "melbourne", "canberra"],
    "JP": ["japan", "japanese", "tokyo", "kyoto", "osaka"],
    "CN": ["china", "chinese", "beijing", "shanghai", "xi jinping"],
    "RU": ["russia", "russian", "moscow", "kremlin", "putin"],
    "UA": ["ukraine", "ukrainian", "kyiv", "zelenskyy", "kharkiv"],
    "BR": ["brazil", "brazilian", "brasilia", "lula", "bolsonaro"],
    "NG": ["nigeria", "nigerian", "lagos", "abuja"],
    "KE": ["kenya", "kenyan", "nairobi"],
    "ZA": ["south africa", "south african", "johannesburg", "cape town"],
    "EG": ["egypt", "egyptian", "cairo", "sisi"],
    "SA": ["saudi", "riyadh", "mbs", "jeddah"],
    "IL": ["israel", "israeli", "tel aviv", "jerusalem", "netanyahu"],
    "PS": ["palestine", "palestinian", "gaza", "west bank", "hamas"],
    "IR": ["iran", "iranian", "tehran", "khamenei"],
    "IQ": ["iraq", "iraqi", "baghdad"],
    "SY": ["syria", "syrian", "damascus"],
    "YE": ["yemen", "yemeni", "sanaa", "houthi"],
    "AF": ["afghanistan", "afghan", "kabul", "taliban"],
    "MM": ["myanmar", "burma", "burmese", "yangon"],
    "TH": ["thailand", "thai", "bangkok"],
    "PH": ["philippines", "philippine", "manila"],
    "ID": ["indonesia", "indonesian", "jakarta"],
    "KR": ["south korea", "korean", "seoul", "pyongyang", "north korea"],
    "TW": ["taiwan", "taiwanese", "taipei"],
    "MX": ["mexico", "mexican", "mexico city"],
    "AR": ["argentina", "argentinian", "buenos aires"],
    "CO": ["colombia", "colombian", "bogota"],
    "CL": ["chile", "chilean", "santiago"],
    "PE": ["peru", "peruvian", "lima"],
    "TR": ["turkey", "turkish", "ankara", "istanbul", "erdogan"],
    "PL": ["poland", "polish", "warsaw"],
    "IT": ["italy", "italian", "rome", "vatican"],
    "ES": ["spain", "spanish", "madrid", "barcelona"],
    "SE": ["sweden", "swedish", "stockholm"],
    "NO": ["norway", "norwegian", "oslo"],
    "FI": ["finland", "finnish", "helsinki"],
    "DK": ["denmark", "danish", "copenhagen"],
    "NL": ["netherlands", "dutch", "amsterdam"],
    "BE": ["belgium", "belgian", "brussels"],
    "AT": ["austria", "austrian", "vienna"],
    "CH": ["switzerland", "swiss", "bern", "zurich"],
    "PT": ["portugal", "portuguese", "lisbon"],
    "GR": ["greece", "greek", "athens"],
    "RO": ["romania", "romanian", "bucharest"],
    "UA": ["ukraine", "ukrainian", "kyiv"],
    "GE": ["georgia", "georgian", "tbilisi"],
    "KZ": ["kazakhstan", "kazakh", "astana"],
}


def _classify_video_type(title: str, description: str) -> str:
    """Classify video_type from title and description keywords."""
    text = f"{title} {description}".lower()
    for video_type, keywords in VIDEO_TYPE_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                return video_type
    return "news_report"


def _detect_country(title: str, description: str) -> str | None:
    """Detect country from title and description keywords."""
    text = f"{title} {description}".lower()
    for country, keywords in COUNTRY_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                return country
    return None


def _detect_location_text(title: str, description: str) -> str | None:
    """Try to extract a location phrase from the title."""
    # Common patterns: "in City", "at Place", "from Location"
    patterns = [
        r"\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
        r"\bat\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
        r"\bfrom\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    ]
    for pattern in patterns:
        m = re.search(pattern, title)
        if m:
            return m.group(1)
    return None


def discover_and_index(article_id: int, article_url: str, title: str,
                       body: str, source_country: str | None) -> dict:
    """Scan article body for YouTube videos, index them as video_items.

    Returns summary of actions taken.
    """
    summary = {"discovered": 0, "inserted": 0, "linked": 0}

    videos = discover_videos(body)
    if not videos:
        return summary

    summary["discovered"] = len(videos)

    # Classify the article for video metadata
    video_type = _classify_video_type(title, body)
    country = _detect_country(title, body) or source_country
    location_text = _detect_location_text(title, body)

    with connect() as conn, conn.cursor() as cur:
        for vid in videos:
            video_id = vid["video_id"]
            url = f"https://www.youtube.com/watch?v={video_id}"
            embed_url = f"https://www.youtube.com/embed/{video_id}"
            rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={video_id}"

            # Upsert video channel (YouTube auto-discovery)
            cur.execute("""
                INSERT INTO video_channels (name, platform, channel_id, channel_url,
                                            feed_url, country, region, languages,
                                            categories, source_type, active)
                VALUES (%s, 'youtube', %s, %s, %s, %s, 'global', '{en}',
                        '{news}', 'creator', TRUE)
                ON CONFLICT (channel_id, platform) WHERE channel_id IS NOT NULL DO NOTHING
                RETURNING id
            """, (f"YouTube:{video_id}", video_id, f"https://www.youtube.com/channel/{video_id}",
                  rss_url, country))
            row = cur.fetchone()
            if row:
                channel_db_id = row["id"]
            else:
                # Channel already exists — get its id
                cur.execute("SELECT id FROM video_channels WHERE channel_id = %s AND platform = 'youtube'",
                           (video_id,))
                existing = cur.fetchone()
                if not existing:
                    continue
                channel_db_id = existing["id"]

            # Insert video item
            cur.execute("""
                INSERT INTO video_items (
                    channel_id, video_id, platform, url, title, description,
                    embed_url, video_type, status
                )
                VALUES (%s, %s, 'youtube', %s, %s, %s, %s, %s, 'pending')
                ON CONFLICT (url) DO NOTHING
                RETURNING id
            """, (channel_db_id, video_id, url, title[:500], body[:2000],
                  embed_url, video_type))

            video_row = cur.fetchone()
            if video_row:
                summary["inserted"] += 1
                video_db_id = video_row["id"]

                # Link video to article
                cur.execute("""
                    INSERT INTO video_article_matches (video_id, article_id, similarity,
                                                       same_event, same_location)
                    VALUES (%s, %s, 1.0, TRUE, TRUE)
                    ON CONFLICT (video_id, article_id) DO NOTHING
                """, (video_db_id, article_id))
                summary["linked"] += 1
            else:
                # Video already exists — still link it
                cur.execute("SELECT id FROM video_items WHERE url = %s", (url,))
                existing_vid = cur.fetchone()
                if existing_vid:
                    cur.execute("""
                        INSERT INTO video_article_matches (video_id, article_id, similarity,
                                                           same_event, same_location)
                        VALUES (%s, %s, 0.8, TRUE, TRUE)
                        ON CONFLICT (video_id, article_id) DO NOTHING
                    """, (existing_vid["id"], article_id))

        conn.commit()

    return summary


def run_batch(batch_size: int = 500) -> dict:
    """Scan recent articles for YouTube embeds and index them.

    Processes articles that haven't been scanned yet (no entry in
    video_article_matches).
    """
    summary = {"articles_scanned": 0, "videos_discovered": 0,
               "videos_inserted": 0, "links_created": 0}

    with connect() as conn, conn.cursor() as cur:
        # Find articles with YouTube URLs in body that haven't been scanned
        cur.execute("""
            SELECT a.id, a.url, a.title, a.body, s.country as source_country
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.body ILIKE %(pat1)s OR a.body ILIKE %(pat2)s
            ORDER BY a.fetched_at DESC
            LIMIT %(lim)s
        """, {"pat1": "%youtube.com%", "pat2": "%youtu.be%", "lim": batch_size})
        articles = cur.fetchall()

    if not articles:
        return summary

    log.info("video_linker: scanning %d articles for YouTube embeds", len(articles))

    for article in articles:
        result = discover_and_index(
            article_id=article["id"],
            article_url=article["url"],
            title=article["title"] or "",
            body=article["body"] or "",
            source_country=article.get("source_country"),
        )
        summary["articles_scanned"] += 1
        summary["videos_discovered"] += result["discovered"]
        summary["videos_inserted"] += result["inserted"]
        summary["links_created"] += result["linked"]

    return summary


if __name__ == "__main__":
    import json, sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run_batch()
    print(json.dumps(result, indent=2, default=str))
