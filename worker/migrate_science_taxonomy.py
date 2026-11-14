"""Add science taxonomy columns to news_sources."""
import psycopg, os

DSN = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app@/xyzo?host=/var/run/postgresql")

SQL = """
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='news_sources' AND column_name='science_tier') THEN
        ALTER TABLE news_sources ADD COLUMN science_tier SMALLINT
            DEFAULT 4 CHECK (science_tier BETWEEN 0 AND 4);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='news_sources' AND column_name='science_focus') THEN
        ALTER TABLE news_sources ADD COLUMN science_focus TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='news_sources' AND column_name='science_subfocus') THEN
        ALTER TABLE news_sources ADD COLUMN science_subfocus TEXT[];
    END IF;
END
$$;
"""
with psycopg.connect(DSN) as conn:
    with conn.cursor() as cur:
        cur.execute(SQL)
    conn.commit()
print("Done: science_tier, science_focus, science_subfocus columns added to news_sources")
