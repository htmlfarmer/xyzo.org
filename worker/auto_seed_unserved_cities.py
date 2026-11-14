"""Auto-seed unserved major cities — overnight background job helper.

Identifies major cities (US population >= 80,000, Global population >= 200,000)
that currently have 0 active sources in news_sources within a 40km box. Automatically
inserts Google News RSS sources for them and fetches fresh news.
"""
import logging
import httpx
from .db import connect
from .fetch import parse_feed, insert_articles
from . import auto_categorize, geocode, cluster

log = logging.getLogger("xyzo.auto_seed_unserved")

def run(limit: int = 150) -> dict:
    sql = """
    SELECT c.id, c.name, c.state_name, c.country_code, c.population, c.lat, c.lng
    FROM world_cities c
    LEFT JOIN news_sources s ON s.lat BETWEEN c.lat - 0.35 AND c.lat + 0.35
                            AND s.lng BETWEEN c.lng - 0.35 AND c.lng + 0.35
                            AND s.active = true
    WHERE (c.population >= 80000 AND c.country_code = 'US')
       OR (c.population >= 180000)
    GROUP BY c.id, c.name, c.state_name, c.country_code, c.population, c.lat, c.lng
    HAVING COUNT(s.id) = 0
    ORDER BY c.population DESC
    LIMIT %s;
    """
    
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (limit,))
            cities = cur.fetchall()

    if not cities:
        log.info("auto_seed_unserved: no unserved cities found")
        return {"seeded": 0, "articles_fetched": 0}

    log.info("auto_seed_unserved: found %d unserved major cities", len(cities))
    
    new_sources = []
    with connect() as conn:
        with conn.cursor() as cur:
            for c in cities:
                name = c['name']
                state = c['state_name'] or ''
                cc = c['country_code']
                query = f"{name} news"
                gl_param = 'US' if cc == 'CN' else cc
                ceid_param = 'US:en' if cc == 'CN' else f'{cc}:en'
                feed_url = f"https://news.google.com/rss/search?q={query.replace(' ', '+')}&hl=en-US&gl={gl_param}&ceid={ceid_param}"
                src_name = f"Google News - {name}" + (f", {state}" if state and len(state) <= 3 else "")
                loc_label = f"{name}, {cc}"
                cur.execute("""
                    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, lat, lng, geocoded_location, active)
                    VALUES (%s, %s, %s, 'en', 'global', 'rss', %s, %s, %s, TRUE)
                    ON CONFLICT (feed_url) DO UPDATE SET active = TRUE, lat = EXCLUDED.lat, lng = EXCLUDED.lng
                    RETURNING id
                """, (src_name, feed_url, cc, float(c['lat']), float(c['lng']), loc_label))
                row = cur.fetchone()
                if row:
                    new_sources.append({
                        "id": row["id"], "name": src_name, "feed_url": feed_url,
                        "lat": float(c['lat']), "lng": float(c['lng']), "loc": loc_label
                    })
        conn.commit()

    log.info("auto_seed_unserved: inserted %d new regional sources into news_sources", len(new_sources))
    
    total_articles = 0
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        for s in new_sources:
            try:
                resp = client.get(s["feed_url"], headers={"User-Agent": "xyzo-fetcher/0.1"})
                if resp.status_code == 200:
                    arts = parse_feed(resp.content, "rss")
                    for a in arts:
                        a["extracted_lat"] = s["lat"]
                        a["extracted_lng"] = s["lng"]
                        a["extracted_location"] = s["loc"]
                    inserted = insert_articles(arts, s["id"])
                    total_articles += inserted
            except Exception as e:
                log.warning("auto_seed_unserved: failed to fetch %s: %s", s["name"], e)

    log.info("auto_seed_unserved: fetched %d new articles from %d sources", total_articles, len(new_sources))
    return {"seeded": len(new_sources), "articles_fetched": total_articles}

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(run())
