#!/usr/bin/env python3
"""
scripts/remove_source.py — Remove or deactivate a news source, website domain, or article URL from XYZO database.

Usage examples:
  # Search and remove a source by domain or URL
  python3 scripts/remove_source.py --domain example.com
  python3 scripts/remove_source.py --url "https://example.com/rss.xml"
  python3 scripts/remove_source.py --id 42

  # Deactivate source without deleting records (soft-delete)
  python3 scripts/remove_source.py --domain example.com --deactivate

  # Remove specific articles matching a URL or domain without removing the source entry
  python3 scripts/remove_source.py --url "https://example.com/news/123" --articles-only

  # Dry run mode (preview matches without modifying database)
  python3 scripts/remove_source.py --domain example.com --dry-run
"""

import argparse
import sys
import os
import psycopg2
from psycopg2.extras import RealDictCursor

DSN = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo")

def get_db_conn():
    return psycopg2.connect(DSN)

def main():
    parser = argparse.ArgumentParser(description="Safely remove or deactivate news sources, websites, or article URLs.")
    parser.add_argument("--domain", "-d", help="Domain or website host to target (e.g., example.com)")
    parser.add_argument("--url", "-u", help="Exact feed URL or article URL to target")
    parser.add_argument("--id", "-i", type=int, help="Specific source ID (news_sources.id) to target")
    parser.add_argument("--deactivate", action="store_true", help="Set active = false instead of deleting from DB")
    parser.add_argument("--articles-only", action="store_true", help="Delete matching articles only, keeping the source entry")
    parser.add_argument("--dry-run", action="store_true", help="Preview matches without applying changes")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation prompt")

    args = parser.parse_args()

    if not args.domain and not args.url and not args.id:
        parser.print_help()
        sys.exit(1)

    conn = get_db_conn()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    try:
        # 1. Match sources
        sources = []
        if args.id:
            cur.execute("SELECT id, name, homepage_url, feed_url, active FROM news_sources WHERE id = %s", (args.id,))
            sources = cur.fetchall()
        elif args.url:
            cur.execute(
                "SELECT id, name, homepage_url, feed_url, active FROM news_sources WHERE feed_url = %s OR homepage_url = %s",
                (args.url, args.url)
            )
            sources = cur.fetchall()
        elif args.domain:
            domain_like = f"%{args.domain.strip()}%"
            cur.execute(
                "SELECT id, name, homepage_url, feed_url, active FROM news_sources WHERE homepage_url ILIKE %s OR feed_url ILIKE %s",
                (domain_like, domain_like)
            )
            sources = cur.fetchall()

        # 2. Match articles
        articles = []
        if args.url:
            cur.execute("SELECT id, source_id, title, url FROM news_articles WHERE url = %s", (args.url,))
            articles = cur.fetchall()
        elif args.domain:
            domain_like = f"%{args.domain.strip()}%"
            cur.execute("SELECT id, source_id, title, url FROM news_articles WHERE url ILIKE %s", (domain_like,))
            articles = cur.fetchall()
        elif sources and args.articles_only:
            source_ids = tuple(s['id'] for s in sources)
            cur.execute("SELECT id, source_id, title, url FROM news_articles WHERE source_id IN %s", (source_ids,))
            articles = cur.fetchall()

        print("=== MATCHED SOURCES ===")
        if sources:
            for s in sources:
                site = s.get('homepage_url') or s.get('feed_url')
                print(f"  [ID {s['id']}] {s['name']} — {site} (Feed: {s['feed_url']}) [Active: {s['active']}]")
        else:
            print("  None")

        print("\n=== MATCHED ARTICLES ===")
        if articles:
            print(f"  Found {len(articles)} matching articles.")
            for a in articles[:5]:
                print(f"  - [ID {a['id']}] {a['title'][:60] if a['title'] else 'Untitled'} ({a['url']})")
            if len(articles) > 5:
                print(f"  ... and {len(articles) - 5} more.")
        else:
            print("  None")

        if not sources and not articles:
            print("\nNo matching sources or articles found in database.")
            return

        if args.dry_run:
            print("\n[DRY RUN MODE] No changes were made.")
            return

        # Confirm unless --yes
        if not args.yes:
            action_desc = "deactivate" if args.deactivate else ("delete articles" if args.articles_only else "permanently DELETE")
            ans = input(f"\nAre you sure you want to {action_desc} the above matches? (y/N): ").strip().lower()
            if ans != 'y':
                print("Aborted.")
                return

        # 3. Perform action
        if args.deactivate and sources:
            source_ids = [s['id'] for s in sources]
            cur.execute("UPDATE news_sources SET active = false WHERE id = ANY(%s)", (source_ids,))
            print(f"✅ Successfully deactivated {cur.rowcount} sources.")

        elif args.articles_only and articles:
            article_ids = [a['id'] for a in articles]
            cur.execute("DELETE FROM news_articles WHERE id = ANY(%s)", (article_ids,))
            print(f"✅ Successfully deleted {cur.rowcount} articles.")

        elif sources:
            source_ids = [s['id'] for s in sources]
            # Delete sources (cascades to news_articles, pins, topics, cities, etc.)
            cur.execute("DELETE FROM news_sources WHERE id = ANY(%s)", (source_ids,))
            print(f"✅ Successfully deleted {cur.rowcount} sources and all associated articles.")

        elif articles:
            article_ids = [a['id'] for a in articles]
            cur.execute("DELETE FROM news_articles WHERE id = ANY(%s)", (article_ids,))
            print(f"✅ Successfully deleted {cur.rowcount} articles.")

        conn.commit()

    except Exception as e:
        conn.rollback()
        print(f"❌ Error removing source: {e}")
        sys.exit(1)
    finally:
        cur.close()
        conn.close()

if __name__ == "__main__":
    main()
