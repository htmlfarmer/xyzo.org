#!/usr/bin/env python3
"""
Repair the stored image URLs that carry HTML entities.

WHAT BROKE
----------
An image URL lifted out of an RSS <img src> or an HTML <meta> tag still
carries its HTML entities:

    src="https://pbs.twimg.com/media/X?format=jpg&amp;name=large"

is stored VERBATIM, and the upstream answers 404 for it — the "&amp;"
is part of the path, not a separator. The browser then asks our own
image proxy for it, the proxy asks the publisher, the publisher says
404, and the console fills with:

    /api/image-proxy?url…amp%3Bstrip%3Dall:1
        Failed to load resource: the server responded with a status of 404 ()

There is a second, quieter fault: a URL whose hostname was mangled by
worker/fetch.py's _sanitize_image_url (it cut "www.infomoney.com.br"
at ".in" or ".info", because ".br" was not in its TLD table and the tie
was broken by set iteration order). Those hosts are "www.in" and
"www.info" and they never resolved.

WHAT THIS DOES
--------------
    * unescapes the entities in every stored image_url,
    * rewrites the two mangled hostnames back to their real domain,
    * leaves everything else alone.

It is idempotent and safe to run at any time. Run it with --dry-run
first to see how many rows it would touch.

Usage:
  python3 -m scripts.fix_image_urls --dry-run
  python3 -m scripts.fix_image_urls
"""
from __future__ import annotations

import argparse
import html
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

# The two hostnames _sanitize_image_url produced when it mangled a
# ".com.br" host: it cut the domain at ".in" / ".info" and turned the
# rest of the domain into a path. The real host is recoverable from the
# path's first segment.
MANGLED_HOSTS = {
    "www.in": "www.infomoney.com.br",
    "www.info": "www.infomoney.com.br",
}


def load_dsn() -> str:
    for path in (os.path.join(REPO, "api", ".env"), os.path.join(REPO, ".env")):
        if not os.path.exists(path):
            continue
        for line in open(path):
            line = line.strip()
            if line.startswith("XYZO_DB_DSN=") or line.startswith("XYZO_DB_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no XYZO_DB_DSN / XYZO_DB_URL found in api/.env")


def fix_url(url: str) -> str | None:
    """The repaired URL, or None when nothing needs changing."""
    if not url:
        return None
    out = html.unescape(url)
    m = re.match(r"^(https?://)([^/]+)(/.*)?$", out)
    if not m:
        return out if out != url else None
    scheme, host, path = m.group(1), m.group(2), m.group(3) or ""
    host_lower = host.lower()
    if host_lower in MANGLED_HOSTS:
        real = MANGLED_HOSTS[host_lower]
        # The path starts with the rest of the domain: /fomoney/wp-…
        for candidate in (real,):
            rest = path.lstrip("/")
            # The mangled host ate "<domain-rest><path>"; the domain
            # rest is the first path segment, so put it back.
            seg, _, tail = rest.partition("/")
            if seg and seg.lower() in ("fomoney", "money", "infomoney"):
                host = candidate
                path = "/" + tail
            else:
                host = candidate
        out = scheme + host + path
    return out if out != url else None


def main() -> int:
    ap = argparse.ArgumentParser(description="Repair stored image URLs")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    dsn = load_dsn()
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, image_url FROM news_articles "
                "WHERE image_url IS NOT NULL AND ("
                "  image_url LIKE '%%&amp;%%'"
                "  OR image_url LIKE 'https://www.in/%%'"
                "  OR image_url LIKE 'https://www.info/%%'"
                ")"
            )
            rows = cur.fetchall()
            print(f"[image-urls] {len(rows)} candidate rows")

            updates = []
            for r in rows:
                fixed = fix_url(r["image_url"])
                if fixed:
                    updates.append((fixed, r["id"]))
            print(f"[image-urls] {len(updates)} rows would change")

            if args.dry_run:
                for fixed, rid in updates[:10]:
                    print(f"    #{rid} -> {fixed[:130]}")
                return 0

            if updates:
                cur.executemany(
                    "UPDATE news_articles SET image_url = %s WHERE id = %s",
                    updates,
                )
                print(f"[image-urls] repaired {len(updates)} rows")
            conn.commit()
    return 0


if __name__ == "__main__":
    sys.exit(main())
