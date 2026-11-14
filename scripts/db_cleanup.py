"""Database Cleanup and Full Backfill Utility.

Performs:
  1. Deletion of empty/corrupted articles (blank title)
  2. Deduplication of duplicate URLs and duplicate titles per source
  3. Full backfill of doc_type, doc_type_confidence, detected_lang, and word_freq
"""
import logging
from worker.db import connect
from worker.word_freq import extract_word_freq_extended, word_freq_to_json

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("xyzo.db_cleanup")

def cleanup_and_backfill():
    with connect() as conn:
        with conn.cursor() as cur:
            # 1. Remove empty/corrupted titles
            cur.execute("DELETE FROM news_articles WHERE title IS NULL OR trim(title) = '';")
            log.info("Deleted %d corrupted articles with empty titles.", cur.rowcount)

            # 2. Deduplicate URLs keeping the lowest id (earliest)
            cur.execute("""
                DELETE FROM news_articles a
                USING news_articles b
                WHERE a.url = b.url AND a.source_id = b.source_id AND a.id > b.id;
            """)
            log.info("Deleted %d duplicate URL article entries.", cur.rowcount)

            # 3. Deduplicate identical title + source_id keeping lowest id
            cur.execute("""
                DELETE FROM news_articles a
                USING news_articles b
                WHERE a.title = b.title AND a.source_id = b.source_id AND a.id > b.id;
            """)
            log.info("Deleted %d duplicate title article entries.", cur.rowcount)

        conn.commit()

    # 4. Backfill doc_type, detected_lang, and word_freq in batches
    batch_size = 5000
    total_processed = 0

    while True:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, title, body FROM news_articles
                    WHERE doc_type IS NULL OR word_freq IS NULL OR word_freq = '{}'::jsonb
                    LIMIT %s;
                """, (batch_size,))
                rows = cur.fetchall()

                if not rows:
                    log.info("All articles successfully processed and backfilled!")
                    break

                log.info("Processing batch of %d articles for doc_type & word_freq...", len(rows))
                data = []
                for r in rows:
                    ext = extract_word_freq_extended(r['title'] or '', r['body'] or '')
                    wf_json = word_freq_to_json(ext['top_words'])
                    data.append((wf_json, ext['doc_type'], ext['doc_type_confidence'], ext['detected_lang'], r['id']))

                cur.executemany("""
                    UPDATE news_articles
                    SET word_freq = %s::jsonb,
                        doc_type = %s,
                        doc_type_confidence = %s,
                        detected_lang = %s
                    WHERE id = %s
                """, data)

                conn.commit()
                total_processed += len(rows)
                log.info("Updated %d articles (total backfilled: %d).", len(rows), total_processed)

if __name__ == "__main__":
    cleanup_and_backfill()
