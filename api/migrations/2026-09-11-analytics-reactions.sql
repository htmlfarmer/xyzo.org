-- Heart/star reactions on news pins.
-- Clients store locally in localStorage and fire-and-forGET POST to
-- /api/analytics/reaction.  The table tracks aggregate counts + individual
-- reactions for analytics (most-loved sources, etc.).

CREATE TABLE IF NOT EXISTS analytics_reactions (
  id          BIGSERIAL PRIMARY KEY,
  pin_id      BIGINT NOT NULL,
  reaction    TEXT NOT NULL CHECK (reaction IN ('love', 'star')),
  session_ip  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookups: "how many hearts does pin X have?" + "did user Y heart this?"
CREATE INDEX IF NOT EXISTS idx_analytics_reactions_pin
  ON analytics_reactions (pin_id, reaction);

-- IP-based dedup (one reaction per IP per pin per type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_reactions_dedup
  ON analytics_reactions (pin_id, reaction, session_ip)
  WHERE session_ip IS NOT NULL;

-- Aggregate view for the popup: count per pin per reaction
CREATE OR REPLACE VIEW pin_reaction_counts AS
SELECT pin_id, reaction, COUNT(*) AS count
FROM analytics_reactions
GROUP BY pin_id, reaction;
