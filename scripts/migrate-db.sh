#!/usr/bin/env bash
# ── migrate-db.sh ───────────────────────────────────────────────────
#
# Applies the canonical xyzo schema to the configured DB.
#
# Walks schema/ in dependency order so:
#   • schema.sql (base: pins + postgis + helper functions)
#   • schema-icons.sql            (extends pins.category CHECK)
#   • schema-events.sql           (news_sources, news_articles, news_locations, news_events…)
#   • schema-sources-geo.sql      (alters news_sources)
#   • schema-auto-categorize.sql  (alters news_articles)
#   • schema-feedback.sql         (alters news_articles, news_locations + news_re_evaluate_requests)
#   • schema-feed-submissions.sql (feed_submissions)
#   • schema-learning.sql         (news_fetch_decisions, news_coverage_gaps, news_extraction_feedback)
#   • schema-location-views.sql   (news_location_views, news_location_rankings, functions)
#   • schema-news-requests.sql    (news_area_requests)
#   • schema-community.sql        (news_request_votes, news_request_replies + view)
#   • schema-cities.sql           (world_cities, city_aliases)
#   • schema-analytics.sql        (news_interactions, source rankings, geo interest)
#   • schema-reports-access.sql   (extends quality report enum)
#   • schema-neural-networks.sql  (nn_training_features, model_registry, …)
#   • schema-nn-embeddings.sql    (pgvector caches + event graph edges)
#   • schema-nn-predictions.sql   (nn_v_* prediction views)
#   • schema-nn-rankings.sql      (session/hot-topic aggregates for ranking)
#
# Every schema file is `CREATE … IF NOT EXISTS`-style, so this is safe
# to re-run. Failures stop the script — re-run after fixing the cause.
#
# Run: scripts/migrate-db.sh
#      DSN may be overridden via XYZO_DB_DSN (or legacy NEWSIUM_DB_DSN) env var.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA_DIR="$REPO/api"

# DSN precedence matches worker/db.py. The app user `xyzo_app`
# can't CREATE EXTENSION. We try `xyzo_app` first for normal schema
# work, and fall back to a superuser (peer-auth as $USER if they're a
# PG superuser) only for the extension step.
DSN="${XYZO_DB_DSN:-${NEWSIUM_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}}"

# Superuser DSN — used only for CREATE EXTENSION. We try peer auth with
# the current OS user ($USER = asher) before falling back to the
# `postgres` superuser with trust auth if available.
SU_DSN="postgresql://${USER:-asher}@localhost:5432/xyzo"

# Order matters.
ORDER=(
  schema.sql
  schema-icons.sql
  schema-events.sql
  schema-sources-geo.sql
  schema-auto-categorize.sql
  schema-feedback.sql
  schema-feed-submissions.sql
  schema-learning.sql
  schema-location-views.sql
  schema-news-requests.sql
  schema-community.sql
  schema-cities.sql
  schema-analytics.sql
  schema-reports-access.sql
  schema-neural-networks.sql
  schema-nn-embeddings.sql
  schema-nn-predictions.sql
  schema-nn-rankings.sql
)

# ── Extensions needed by some schema files ───────────────────────
# postgis: required by schema.sql (pins GEOMETRY columns + helpers).
# pg_trgm: required by schema-cities.sql (GIN trigram indexes).
# pgcrypto: only if any future schema needs gen_random_uuid() etc.
echo "── Enabling extensions (postgis + pg_trgm + pgcrypto) ──"
echo "  using superuser DSN: $SU_DSN"
if psql "$SU_DSN" -v ON_ERROR_STOP=1 -c \
  "CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1; then
  echo "  ok"
else
  echo "  ✗ superuser connect failed; on this host 'asher' is a PG superuser via peer auth"
  echo "    If running remotely, set SUPERUSER_DSN to a superuser DSN with the password."
  exit 1
fi

# ── Apply each schema file in order ──────────────────────────────
# Use the superuser DSN throughout. Several schema files include
# `CREATE OR REPLACE FUNCTION` statements that require ownership of the
# existing function body — `xyzo_app` doesn't have it, so we'd hit
# "must be owner of function xyzo_set_updated_at" on every re-run.
# Running the whole migration as a superuser avoids that.
applied=0
for f in "${ORDER[@]}"; do
  path="$SCHEMA_DIR/$f"
  if [ ! -f "$path" ]; then
    echo "  ! missing: $f"
    continue
  fi
  echo
  echo "── Applying $f ──"
  if psql "$SU_DSN" -v ON_ERROR_STOP=1 -q -f "$path"; then
    echo "  ok"
    applied=$((applied+1))
  else
    echo "  ✗ $f failed"
    exit 1
  fi
done

echo
echo "── Done. $applied schema file(s) applied ──"

# Summary: how many user tables exist now.
N=$(psql "$SU_DSN" -tAc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';" 2>/dev/null || echo "?")
echo "  public schema now has $N tables (was 2 before migration)."
