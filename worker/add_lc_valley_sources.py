"""Add 3 RSS news sources for Lewis-Clark Valley region (ID/WA border).

Sources:
  1. Lewiston Tribune (https://www.lmtribune.com/search/?f=rss)
  2. KLEW-TV (https://klewtv.com/news/local/rss)
  3. Moscow-Pullman Daily News (https://dnews.com/search/?f=rss)
"""
import logging
from worker.db import connect

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("xyzo.add_lc_valley_sources")

SOURCES = [
    {
        "name": "Lewiston Tribune",
        "feed_url": "https://www.lmtribune.com/rss.xml",
        "homepage_url": "https://www.lmtribune.com",
        "country": "US",
        "region": "Idaho",
        "lat": 46.416557,
        "lng": -117.023062,
        "geocoded_location": "Lewiston, ID, US",
    },
    {
        "name": "KLEW-TV",
        "feed_url": "https://klewtv.com/news/local/rss",
        "homepage_url": "https://klewtv.com",
        "country": "US",
        "region": "Idaho",
        "lat": 46.416557,
        "lng": -117.023062,
        "geocoded_location": "Lewiston, ID, US",
    },
    {
        "name": "Moscow-Pullman Daily News",
        "feed_url": "https://www.dnews.com/rss.xml",
        "homepage_url": "https://dnews.com",
        "country": "US",
        "region": "Idaho",
        "lat": 46.7323875,
        "lng": -117.0001651,
        "geocoded_location": "Moscow, ID, US",
    },
]


def add_sources():
    with connect() as conn, conn.cursor() as cur:
        added = 0
        for src in SOURCES:
            cur.execute("""
                INSERT INTO news_sources (
                    name, feed_url, homepage_url, country, region,
                    source_type, active, lat, lng, geocoded_location
                )
                VALUES (%s, %s, %s, %s, %s, 'rss', true, %s, %s, %s)
                ON CONFLICT (feed_url) DO UPDATE
                    SET name = EXCLUDED.name,
                        active = true,
                        country = EXCLUDED.country,
                        region = EXCLUDED.region,
                        lat = EXCLUDED.lat,
                        lng = EXCLUDED.lng,
                        geocoded_location = EXCLUDED.geocoded_location
                RETURNING id
            """, (
                src["name"], src["feed_url"], src["homepage_url"],
                src["country"], src["region"], src["lat"], src["lng"],
                src["geocoded_location"]
            ))
            row = cur.fetchone()
            log.info("Source %s: ID %s", src["name"], row["id"])
            added += 1
        conn.commit()
        log.info("Successfully added/updated %d LC Valley sources", added)


if __name__ == "__main__":
    add_sources()
