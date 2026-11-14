-- Newsium schema. Idempotent — safe to re-run during development.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION newsium_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS pins (
    id                BIGSERIAL PRIMARY KEY,
    source_type       TEXT NOT NULL CHECK (source_type IN ('editorial','community','rss')),
    title             TEXT NOT NULL,
    location          GEOGRAPHY(POINT, 4326) NOT NULL,
    location_precision TEXT NOT NULL DEFAULT 'exact'
        CHECK (location_precision IN ('exact','city','region','country')),
    confidence_score  FLOAT NOT NULL DEFAULT 1.0
        CHECK (confidence_score BETWEEN 0.0 AND 1.0),
    status            TEXT NOT NULL DEFAULT 'published'
        CHECK (status IN ('published','hidden')),
    category          TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('politics','business','crime','weather','science',
                            'technology','sports','culture','environment',
                            'conflict','health','other')),
    published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pins_lng_range CHECK (ST_X(location::geometry) BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS pins_location_gix     ON pins USING GIST (location);
CREATE INDEX IF NOT EXISTS pins_source_type_idx  ON pins (source_type);
CREATE INDEX IF NOT EXISTS pins_created_id_idx   ON pins (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pins_published_id_idx ON pins (published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pins_category_idx     ON pins (category);

DROP TRIGGER IF EXISTS pins_updated_at ON pins;
CREATE TRIGGER pins_updated_at BEFORE UPDATE ON pins
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

CREATE TABLE IF NOT EXISTS editorial_details (
    pin_id        BIGINT PRIMARY KEY REFERENCES pins(id) ON DELETE CASCADE,
    body_markdown TEXT NOT NULL,
    image_url     TEXT,
    author_name   TEXT NOT NULL,
    canonical_url TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS editorial_details_updated_at ON editorial_details;
CREATE TRIGGER editorial_details_updated_at BEFORE UPDATE ON editorial_details
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

CREATE TABLE IF NOT EXISTS community_details (
    pin_id          BIGINT PRIMARY KEY REFERENCES pins(id) ON DELETE CASCADE,
    submitter_name  TEXT NOT NULL,
    submitter_email TEXT NOT NULL,
    canonical_url   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS community_details_updated_at ON community_details;
CREATE TRIGGER community_details_updated_at BEFORE UPDATE ON community_details
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

CREATE TABLE IF NOT EXISTS rss_details (
    pin_id                BIGINT PRIMARY KEY REFERENCES pins(id) ON DELETE CASCADE,
    source_feed           TEXT NOT NULL,
    source_url            TEXT NOT NULL UNIQUE,
    original_published_at TIMESTAMPTZ,
    summary               TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS rss_details_updated_at ON rss_details;
CREATE TRIGGER rss_details_updated_at BEFORE UPDATE ON rss_details
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

CREATE TABLE IF NOT EXISTS admin_keys (
    id         BIGSERIAL PRIMARY KEY,
    key_id     TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    key_hash   TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('editorial','rss_ingest','super')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
