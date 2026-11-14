"""YouTube URL extractor — finds YouTube video IDs in HTML content.

SUPPORTED URL FORMATS:
  - youtube.com/watch?v=VIDEO_ID
  - youtu.be/VIDEO_ID
  - youtube.com/embed/VIDEO_ID
  - youtube.com/v/VIDEO_ID
  - youtube.com/shorts/VIDEO_ID

YouTube video IDs are exactly 11 characters: [a-zA-Z0-9_-]

EXTRACTION SOURCES:
  1. iframe src attributes (most common embed method)
  2. a href attributes (direct links)
  3. Raw text URLs (mentioned in article body)

DEDUPLICATION:
  Same video_id found via multiple URLs → one entry. This prevents
  counting duplicates when an article links to the same video in
  both an iframe and a text link.

USED BY:
  - video_linker.py: scans article bodies for embedded YouTube videos
  - video_site_crawler.py: extracts YouTube embeds from video article pages
"""
import html
import logging
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

log = logging.getLogger("xyzo.video_discover")

_YT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")

_WATCH_RE = re.compile(
    r"(?:https?://)?(?:www\.)?youtube\.com/watch(?:\?.*?)?v=([a-zA-Z0-9_-]{11})",
    re.IGNORECASE,
)
_SHORT_RE = re.compile(
    r"(?:https?://)?youtu\.be/([a-zA-Z0-9_-]{11})",
    re.IGNORECASE,
)
_EMBED_RE = re.compile(
    r"(?:https?://)?(?:www\.)?youtube\.com/embed/([a-zA-Z0-9_-]{11})",
    re.IGNORECASE,
)
_V_RE = re.compile(
    r"(?:https?://)?(?:www\.)?youtube\.com/v/([a-zA-Z0-9_-]{11})",
    re.IGNORECASE,
)
_SHORTS_RE = re.compile(
    r"(?:https?://)?(?:www\.)?youtube\.com/shorts/([a-zA-Z0-9_-]{11})",
    re.IGNORECASE,
)
_ALL_YT_RE = re.compile(
    r"(?:https?://)?(?:www\.)?(?:"
    r"youtube\.com/watch(?:\?.*?)?v=([a-zA-Z0-9_-]{11})"
    r"|youtu\.be/([a-zA-Z0-9_-]{11})"
    r"|youtube\.com/embed/([a-zA-Z0-9_-]{11})"
    r"|youtube\.com/v/([a-zA-Z0-9_-]{11})"
    r"|youtube\.com/shorts/([a-zA-Z0-9_-]{11})"
    r")",
    re.IGNORECASE,
)

_IFRAME_SRC_RE = re.compile(
    r"<iframe\b[^>]*\bsrc=[\"']([^\"']*)[\"']",
    re.IGNORECASE | re.DOTALL,
)
_HREF_RE = re.compile(
    r"<a\b[^>]*\bhref=[\"']([^\"']*)[\"']",
    re.IGNORECASE | re.DOTALL,
)


def _is_valid_id(vid: str) -> bool:
    return bool(vid) and _YT_ID_RE.match(vid) is not None


def _extract_id_from_url(url: str) -> str | None:
    decoded = html.unescape(url).strip()
    if not decoded:
        return None

    m = _ALL_YT_RE.search(decoded)
    if not m:
        return None

    for g in m.groups():
        if g and _is_valid_id(g):
            return g
    return None


def _extract_from_text(text: str, source: str) -> list[dict[str, Any]]:
    results = []
    seen_ids: set[str] = set()

    for m in _ALL_YT_RE.finditer(text):
        for g in m.groups():
            if g and _is_valid_id(g) and g not in seen_ids:
                full_url = m.group(0)
                results.append({"video_id": g, "url": full_url, "source": source})
                seen_ids.add(g)
                break

    return results


def _extract_from_attr(attr_content: str, source: str) -> list[dict[str, Any]]:
    results = []
    seen_ids: set[str] = set()

    decoded = html.unescape(attr_content)
    for m in _ALL_YT_RE.finditer(decoded):
        for g in m.groups():
            if g and _is_valid_id(g) and g not in seen_ids:
                full_url = m.group(0)
                results.append({"video_id": g, "url": full_url, "source": source})
                seen_ids.add(g)
                break

    return results


def discover_videos(html_body: str) -> list[dict[str, Any]]:
    if not html_body:
        return []

    seen_ids: set[str] = set()
    videos: list[dict[str, Any]] = []

    def _add(video_id: str, url: str, source: str) -> None:
        if video_id not in seen_ids:
            videos.append({"video_id": video_id, "url": url, "source": source})
            seen_ids.add(video_id)

    for m in _IFRAME_SRC_RE.finditer(html_body):
        src_val = html.unescape(m.group(1))
        for inner in _ALL_YT_RE.finditer(src_val):
            for g in inner.groups():
                if g and _is_valid_id(g):
                    _add(g, inner.group(0), "iframe")
                    break

    for m in _HREF_RE.finditer(html_body):
        href_val = html.unescape(m.group(1))
        for inner in _ALL_YT_RE.finditer(href_val):
            for g in inner.groups():
                if g and _is_valid_id(g):
                    _add(g, inner.group(0), "link")
                    break

    text_part = re.sub(r"<[^>]+>", " ", html_body)
    decoded_text = html.unescape(text_part)
    for m in _ALL_YT_RE.finditer(decoded_text):
        for g in m.groups():
            if g and _is_valid_id(g):
                _add(g, m.group(0), "embed" if "embed" in m.group(0).lower() else "link")
                break

    log.debug("video_discover: found %d unique videos", len(videos))
    return videos


def discover_videos_from_urls(urls: list[str]) -> list[dict[str, Any]]:
    seen_ids: set[str] = set()
    videos: list[dict[str, Any]] = []

    for url in urls:
        vid = _extract_id_from_url(url)
        if vid and vid not in seen_ids:
            videos.append({"video_id": vid, "url": url, "source": "link"})
            seen_ids.add(vid)

    return videos


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG, format="%(levelname)s %(message)s")

    sample = """
    <html>
    <body>
        <h1>Breaking: Major Event in Jakarta</h1>
        <p>Watch the coverage below:</p>
        <iframe width="560" height="315"
            src="https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0"
            frameborder="0" allowfullscreen></iframe>

        <p>Related footage from witnesses:</p>
        <a href="https://www.youtube.com/watch?v=jNQXAC9IVRw">First YouTube video ever</a>

        <p>Short version:</p>
        <a href="https://youtu.be/9bZkp7q19f0">Gangnam Style clip</a>

        <p>More embeds:</p>
        <iframe src='https://www.youtube.com/embed/kJQP7kiw5Fk?autoplay=0'></iframe>

        <p>Shorts:</p>
        <a href="https://www.youtube.com/shorts/gzlHQzhMaRc">Quick take</a>

        <p>V-embed format:</p>
        <iframe src="https://www.youtube.com/v/OPf0YbXqDm0"></iframe>

        <p>URL-encoded href:</p>
        <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=30">Duplicate (should be deduped)</a>

        <p>Trailing text with URL:</p>
        <p>Check out https://youtu.be/oHg5SJYRHA0 for more</p>
    </body>
    </html>
    """

    print("=== HTML Article Body Test ===")
    results = discover_videos(sample)
    for v in results:
        print(f"  {v['source']:>6s}  {v['video_id']}  {v['url']}")
    print(f"Total unique videos: {len(results)}")

    print("\n=== URL List Test ===")
    url_list = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/jNQXAC9IVRw",
        "https://www.youtube.com/embed/kJQP7kiw5Fk",
        "https://www.youtube.com/v/OPf0YbXqDm0",
        "https://www.youtube.com/shorts/gzlHQzhMaRc",
        "https://not-a-youtube-site.com/video/dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=invalid",
        "https://www.youtube.com/watch?v=abc",
    ]
    url_results = discover_videos_from_urls(url_list)
    for v in url_results:
        print(f"  {v['source']:>6s}  {v['video_id']}  {v['url']}")
    print(f"Total unique videos: {len(url_results)}")

    print("\n=== Edge Cases ===")
    edge_cases = [
        "",
        "<p>No videos here</p>",
        '<iframe src="https://www.youtube.com/embed/"></iframe>',
        '<a href="https://youtu.be/">empty</a>',
        '<a href="https://www.youtube.com/watch?v=">empty param</a>',
        '<iframe src="https://player.vimeo.com/video/12345678"></iframe>',
    ]
    for case in edge_cases:
        r = discover_videos(case)
        print(f"  {case[:60]:<60s} -> {len(r)} videos")
