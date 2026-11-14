"""Seed news for Mombasa and Kenya coastal region (-4.0343, 39.6382).

Fetches RSS sources for Mombasa, Malindi, Kilifi, Kwale, Likoni, Nyali, and Kenya Coast,
geocodes them, extracts doc_type & word_freq, and commits them to news_articles and pins.
"""
import os
import sys
import logging
import httpx
import psycopg2

from worker.db import connect
from worker.fetch import parse_feed, insert_articles
from worker.word_freq import extract_word_freq_extended

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MOMBASA_LAT = -4.05466
MOMBASA_LNG = 39.66359

SOURCES = [
    ('Google News - Mombasa', 'https://news.google.com/rss/search?q=Mombasa&hl=en-US&gl=KE&ceid=KE:en', 'KE', 'en'),
    ('Google News - Kenya Coast', 'https://news.google.com/rss/search?q=Mombasa+OR+Malindi+OR+Kilifi+OR+Likoni+OR+Nyali&hl=en-US&gl=KE&ceid=KE:en', 'KE', 'en'),
    ('Capital FM Kenya', 'https://www.capitalfm.co.ke/news/feed/', 'KE', 'en'),
    ('The Star Kenya', 'https://www.the-star.co.ke/rss', 'KE', 'en'),
    ('Standard Media Kenya', 'https://www.standardmedia.co.ke/rss/headlines.php', 'KE', 'en'),
    ('KBC Kenya', 'https://www.kbc.co.ke/feed/', 'KE', 'en'),
    ('Daily Nation Kenya', 'https://nation.africa/kenya/rss', 'KE', 'en'),
    ('Africa Eco News', 'https://africaeconews.co.ke/feed/', 'KE', 'en')
]

def run():
    logging.info("Starting Mombasa news seeding...")
    
    # 1. Ensure Mombasa exists in news_locations
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO news_locations (place_name, place_name_normalized, country, lat, lng, geom, confidence)
                VALUES ('Mombasa', 'mombasa', 'KE', %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 1.0)
                ON CONFLICT DO NOTHING;
            """, (MOMBASA_LAT, MOMBASA_LNG, MOMBASA_LNG, MOMBASA_LAT))
            
            cur.execute("SELECT id FROM news_locations WHERE place_name_normalized='mombasa' AND country='KE' LIMIT 1")
            row = cur.fetchone()
            loc_id = row['id'] if isinstance(row, dict) else row[0]
            logging.info("Mombasa location_id: %s", loc_id)
        conn.commit()

    # 2. Insert news sources and commit immediately so insert_articles can see them
    source_ids = {}
    with connect() as conn:
        with conn.cursor() as cur:
            for name, url, cc, lang in SOURCES:
                cur.execute("""
                    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, lat, lng, geocoded_location, active)
                    VALUES (%s, %s, %s, %s, 'east-africa', 'rss', %s, %s, 'Mombasa, KE', TRUE)
                    ON CONFLICT (feed_url) DO UPDATE SET active = TRUE
                    RETURNING id;
                """, (name, url, cc, lang, MOMBASA_LAT, MOMBASA_LNG))
                srow = cur.fetchone()
                sid = srow['id'] if isinstance(srow, dict) else srow[0]
                source_ids[name] = (sid, url)
        conn.commit()

    # 3. Fetch each feed and insert articles
    total_inserted = 0
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        for name, (sid, url) in source_ids.items():
            logging.info("Fetching feed: %s (%s)...", name, url)
            try:
                resp = client.get(url, headers={'User-Agent': 'xyzo-fetcher/0.1'})
                if resp.status_code == 200:
                    arts = parse_feed(resp.content, 'rss')
                    for a in arts:
                        a['extracted_lat'] = MOMBASA_LAT
                        a['extracted_lng'] = MOMBASA_LNG
                        a['extracted_location'] = 'Mombasa, KE'
                        a['location_id'] = loc_id
                        
                        # Add doc_type and word_freq
                        title = a.get('title', '')
                        body = a.get('summary', '') or a.get('content', '')
                        freq_info = extract_word_freq_extended(title, body)
                        a['word_freq'] = freq_info['top_words']
                        a['doc_type'] = freq_info['doc_type']
                        a['doc_type_confidence'] = freq_info['doc_type_confidence']
                        a['detected_lang'] = freq_info['detected_lang']

                    inserted = insert_articles(arts, sid)
                    total_inserted += inserted
                    logging.info("Ingested %d new articles for %s", inserted, name)
            except Exception as e:
                logging.error("Failed to fetch %s: %s", name, e)

    logging.info("Mombasa seeding complete! Total new articles ingested: %d", total_inserted)

if __name__ == "__main__":
    run()
