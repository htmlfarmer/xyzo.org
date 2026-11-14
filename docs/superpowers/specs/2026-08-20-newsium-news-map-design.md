# Xyzo — A Geographic News Database with a Map Interface

**Date:** 2026-08-20
**Status:** Revised after dragon-review — pending re-approval
**Author:** Brainstorming session

> **Principle:** store the event, its location, its time, and its provenance first. The map is one useful way to look at the dataset — not the dataset itself. Xyzo's long-run value is in being a queryable, geospatial, temporal, multi-source record of what is happening in the world.

## Goal

xyzo.org is a public-facing Leaflet map that displays news pins from a `newsium` PostgreSQL + PostGIS database. The map supports three toggleable tile layers (Carto Dark / ESRI World Imagery satellite / OpenTopoMap) and clustered pins colored by source type. The system accepts three kinds of news — editorial articles, community submissions with required name + private email, and RSS ingest — all auto-published in v1. The data model is built around a `pins` core plus per-source detail tables, with cursor pagination, deduplication on RSS, and a Markdown-sanitization pipeline ready for safe editorial rendering. Submissions auto-publish without a moderation queue in v1, but the schema and admin endpoints support hiding individual pins fast.

## Decisions captured in brainstorming

| Question | Answer |
|---|---|
| News source types | All three combined (editorial, community, RSS) |
| Moderation flow | Auto-publish, no moderation queue; pins can be `hidden` via admin |
| Map library | Leaflet |
| Backend stack | Bun + Hono |
| UI feature scope | Minimal reader + submitter form (no filter sidebar, search, or time slider in v1) |
| Submission identity | Required name + email (email kept private, used for spam follow-up) |
| Schema architecture | Hub-and-spoke (shared `pins` table + three per-source detail tables) |
| Backend API port | `:3008` (verified free) |

### Refinements from review

| Refinement | Decision |
|---|---|
| Pagination | Cursor-based (`before=<base64(cursor_ts:id)>`), no offset. Response has `next_cursor` + `has_more`, drops `total`. |
| Time semantics | Three timestamps on `pins`: `published_at` (when the news happened), `created_at` (when Xyzo received it), `updated_at` (last edit; auto-updated via trigger). |
| RSS dedup | `rss_details.source_url` is `UNIQUE`; ingest endpoint normalizes URL first (lowercase host, http→https, strip trailing slash, strip common trackers). |
| Markdown rendering | `marked` (parser) → `DOMPurify.sanitize` → DOM. Never `innerHTML` raw markdown. |
| Rate limiting | In-memory in the Hono app (single-instance, v1). DB has no rate-limit table. |
| Admin auth | Header `X-Admin-Key: nk_live_<keyid>.<secret>`. Server splits on `.`, looks up `key_id`, bcrypt-verifies the secret. Constant-time on the lookup path. |
| Coordinate constraint | `CHECK (ST_X(location::geometry) BETWEEN -180 AND 180)`. Lat is bounded by `GEOGRAPHY(POINT, 4326)` itself. |
| Sequence grants | `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO newsium_app`. |
| PostGIS bbox query | Cast `location::geometry` for `ST_MakeEnvelope(...)` overlap. |
| Map fetch hygiene | Debounce `moveend` by 300ms; cap client pin fetch at 1000 when bbox area > threshold. |
| Category | `pins.category TEXT` nullable. Free-text in v1; normalized taxonomy in v2. |
| IP retention | Rate-limit keys stored in process memory only; never persisted to disk. TTL 1 hour. No IP column in any table. |
| Admin hide endpoint | `PATCH /api/admin/pins/:id` with `{status: "hidden"}` — fast takedown for abusive pins. |

## Architecture

```
Browser
 ├── Reader: Leaflet map + tile layer control + clustered pins + popups
 │   (debounced moveend 300ms; cursor pagination on overflow)
 └── Submitter: overlay form + mini-map (click-to-place pin)
     (Markdown parsed + sanitized only on editorial body render)

Caddy (:443 → :80)
 ├── /api/*  → reverse_proxy localhost:3008
 └── /*      → file_server (static SPA)

Xyzo API (Bun + Hono, port 3008)
 ├── GET    /api/pins            list pins (bbox + source_type, cursor-paginated)
 ├── GET    /api/pins/:id        pin detail + source-specific join
 ├── POST   /api/pins            community submission (in-memory IP rate limit, honeypot)
 ├── POST   /api/admin/pins      editorial create (X-Admin-Key)
 ├── POST   /api/admin/rss       RSS ingest (X-Admin-Key; URL-normalized, UNIQUE source_url)
 ├── PATCH  /api/admin/pins/:id  hide/update pin (X-Admin-Key, role-gated)
 └── GET    /api/health          liveness

PostgreSQL 15 + PostGIS 3.3 (already running)
 ├── pins (shared core: id, source_type, title, location, status, category, published_at, created_at, updated_at)
 ├── editorial_details     (FK → pins)
 ├── community_details     (FK → pins; submitter_email NEVER returned by GET)
 ├── rss_details           (FK → pins; source_url UNIQUE)
 └── admin_keys            (key_id + bcrypt(key_hash), role-based)
```

## Database schema (`schema.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION newsium_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Pins: shared core for all three sources ─────────────────────────────
CREATE TABLE pins (
    id           BIGSERIAL PRIMARY KEY,
    source_type  TEXT NOT NULL CHECK (source_type IN ('editorial','community','rss')),
    title        TEXT NOT NULL,
    location     GEOGRAPHY(POINT, 4326) NOT NULL,
    status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
    category     TEXT,  -- free-text in v1; normalized taxonomy in v2
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the news actually happened
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when Xyzo received it
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- last edit (auto)
    -- Lat is bounded by GEOGRAPHY(POINT, 4326) by type; lng defended here.
    CONSTRAINT pins_lng_range CHECK (ST_X(location::geometry) BETWEEN -180 AND 180)
);

CREATE INDEX pins_location_gix     ON pins USING GIST (location);
CREATE INDEX pins_source_type_idx  ON pins (source_type);
CREATE INDEX pins_created_id_idx   ON pins (created_at DESC, id DESC);
CREATE INDEX pins_published_id_idx ON pins (published_at DESC, id DESC);

CREATE TRIGGER pins_updated_at BEFORE UPDATE ON pins
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ── Editorial: rich body, author, hero image ─────────────────────────────
CREATE TABLE editorial_details (
    pin_id        BIGINT PRIMARY KEY REFERENCES pins(id) ON DELETE CASCADE,
    body_markdown TEXT NOT NULL,
    image_url     TEXT,
    author_name   TEXT NOT NULL,
    canonical_url TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER editorial_details_updated_at BEFORE UPDATE ON editorial_details
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ── Community: light, with private email ─────────────────────────────────
CREATE TABLE community_details (
    pin_id          BIGINT PRIMARY KEY REFERENCES pins(id) ON DELETE CASCADE,
    submitter_name  TEXT NOT NULL,
    submitter_email TEXT NOT NULL,  -- NEVER returned by any GET endpoint
    canonical_url   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER community_details_updated_at BEFORE UPDATE ON community_details
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ── RSS: deduped by normalized source_url ────────────────────────────────
CREATE TABLE rss_details (
    pin_id                BIGINT PRIMARY KEY REFERENCES pins(id) ON DELETE CASCADE,
    source_feed           TEXT NOT NULL,
    source_url            TEXT NOT NULL UNIQUE,  -- normalized by API before insert
    original_published_at TIMESTAMPTZ,
    summary               TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER rss_details_updated_at BEFORE UPDATE ON rss_details
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ── Admin keys: key_id + bcrypt-verified secret ──────────────────────────
CREATE TABLE admin_keys (
    id         BIGSERIAL PRIMARY KEY,
    key_id     TEXT NOT NULL UNIQUE,                  -- public identifier, e.g. "nk_live_abc123"
    name       TEXT NOT NULL,                         -- human label, e.g. "editor-1"
    key_hash   TEXT NOT NULL,                         -- bcrypt(full_secret)
    role       TEXT NOT NULL CHECK (role IN ('editorial','rss_ingest','super')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
```

**Privacy invariants (enforced in API layer, documented here):**
- `community_details.submitter_email` is **never** returned by `GET /api/pins`, `GET /api/pins/:id`, or any other public endpoint. It exists solely for spam follow-up.
- No IP addresses are persisted anywhere. Rate-limit state lives in process memory and is dropped on restart.

**Pin responses always include:**
`id, source_type, title, location, status, category, published_at, created_at, updated_at`.

## API surface

All endpoints return JSON. Errors: `{"error":"code","message":"..."}`. Body size limit: **64 KiB** on all POST endpoints (rejected with 413 above that).

### `GET /api/health`
- No auth. Returns `{"ok":true,"version":"0.1.0"}`.

### `GET /api/pins`

Cursor-paginated list of pins. The map uses `bbox` to constrain results to the viewport; `before` is only needed when a single viewport returns more than `limit` results.

Query parameters:
- `bbox=minLng,minLat,maxLng,maxLat` — viewport-bounded; uses `location::geometry && ST_MakeEnvelope(...)`.
- `source_type=editorial|community|rss` — repeatable.
- `since=ISO8601` — `published_at >= since` (note: by *publication*, not ingest).
- `limit` — default 500, max 1000.
- `before=<cursor>` — opaque base64url of `created_at|id`; returns rows strictly older than the cursor. First page omits this.

Response:
```json
{
  "pins": [{
    "id": 42,
    "source_type": "editorial",
    "title": "Flooding in Karachi",
    "location": {"lat": 24.86, "lng": 67.00},
    "status": "published",
    "category": "weather",
    "published_at": "2026-08-18T03:00:00Z",
    "created_at": "2026-08-20T14:32:00Z",
    "updated_at": "2026-08-20T14:32:00Z"
  }],
  "next_cursor": "<base64url of '<ISO8601>|<id>'>",
  "has_more": true
}
```
`total` is intentionally omitted — computing it on large spatial queries is expensive and the map doesn't need it.

**Cursor encoding:** `base64url("<ISO8601>|<id>")`. Server decodes and uses row-value comparison `(created_at, id) < ($ts, $id)`, exploiting `pins_created_id_idx`.

### `GET /api/pins/:id`

Single pin + source-specific detail. Email **never** present. `detail` shape:
- `editorial`: `{body_markdown, image_url?, author_name, canonical_url?, created_at, updated_at}`
- `community`: `{submitter_name, canonical_url?, created_at, updated_at}` (no email)
- `rss`: `{source_feed, source_url, original_published_at?, summary?, created_at, updated_at}`

### `POST /api/pins` (community submission, no auth)

Headers: `Content-Type: application/json`, `Content-Length ≤ 65536`.

Request:
```json
{
  "title": "Local protest in Lahore",
  "submitter_name": "Jane",
  "submitter_email": "jane@example.com",
  "canonical_url": "https://example.com/article",
  "lat": 31.52, "lng": 74.36,
  "published_at": "2026-08-20T15:00:00Z",
  "category": "politics",
  "hp_company": ""
}
```
- `hp_company` is a honeypot — must be empty (bots typically fill all visible inputs).
- **In-memory rate limit:** 10 requests per IP per hour, TTL 1 hour, dropped on process restart. Returns 429 when exceeded.
- **Validation:** title 1–200 chars, submitter_name 1–100, submitter_email RFC 5322 + normalized (lowercase local-part is OK; domain must resolve at lookup time), lat ∈ [-90, 90], lng ∈ [-180, 180], canonical_url must parse and use http/https scheme, `published_at` if provided must be ≤ now+5min.
- **Normalization:** email lowercased + trimmed; canonical_url normalized (lowercase host, strip fragment, drop common trackers `utm_*`, `fbclid`, `gclid`).
- 201 with new pin row on success; 413 on body size; 400 on validation; 429 on rate limit.

### `POST /api/admin/pins` (editorial)

Header: `X-Admin-Key: nk_live_<keyid>.<secret>` (role `editorial` or `super`).

Request:
```json
{
  "title": "Flooding in Karachi",
  "lat": 24.86, "lng": 67.00,
  "body_markdown": "# Heading\n\n...",
  "image_url": "https://...",
  "author_name": "Reporter",
  "canonical_url": "https://...",
  "published_at": "2026-08-18T03:00:00Z",
  "category": "weather"
}
```
201 with new pin; 401 if key missing/malformed; 403 if role insufficient.

### `POST /api/admin/rss` (RSS ingest)

Header: `X-Admin-Key: nk_live_<keyid>.<secret>` (role `rss_ingest` or `super`).

Request:
```json
{
  "title": "...",
  "lat": ..., "lng": ...,
  "source_feed": "https://reuters.com/world/feed",
  "source_url": "https://reuters.com/article/xyz?utm_source=tw",
  "original_published_at": "2026-08-20T10:00:00Z",
  "summary": "..."
}
```
- `source_url` is **normalized** server-side before insert: lowercase host, http→https, strip fragment, drop trailing `/`, drop `utm_*` / `fbclid` / `gclid` query params. If, after normalization, an existing row matches, the response is **200 with the existing pin id** (idempotent dedup, not an error).
- 201 with new pin; 200 with existing pin on dedup hit; same auth responses.

### `PATCH /api/admin/pins/:id` (hide / update)

Header: `X-Admin-Key: nk_live_<keyid>.<secret>` (role `editorial`, `rss_ingest` for own source, or `super`).

Request:
```json
{ "status": "hidden" }
```
Or:
```json
{ "title": "...", "lat": ..., "lng": ..., "category": "..." }
```
- Setting `status="hidden"` is the **fast takedown** path. Set `status="published"` to restore.
- 200 with updated pin; 401/403 as above; 404 if not found.

### Admin key seeding

`bun run src/seed-admin-key.ts -- --name editor-1 --role editorial`

Generates two parts:
- `key_id`: 9 random bytes, base64url, prefixed `nk_live_`. Stored in `admin_keys.key_id`. Public.
- `secret`: 32 random bytes, base64url. **Not** stored directly.

Stores `bcrypt("<key_id>.<secret>")` in `admin_keys.key_hash`. Prints the full key **once** to stdout: `nk_live_<keyid>.<secret>`. Operator saves it in a password manager; only the hash is on disk.

**Auth path:**
1. Read header, split on first `.` to get `key_id` and `secret`.
2. Lookup `admin_keys` by `key_id`. Use `timingSafeEqual` for any string compare.
3. If found and not revoked, verify `bcrypt.compare("<key_id>.<secret>", key_hash)`.
4. Check role for the route.

## Security & abuse protection

| Concern | Mitigation |
|---|---|
| Spam bots | Honeypot field `hp_company` on community form (must be empty) |
| Per-IP flooding | In-memory rate limit in Hono: 10 POST `/api/pins` per IP per hour, TTL 1 hour, dropped on restart |
| Clickjacking | `Content-Security-Policy: frame-ancestors 'none'` set in Caddy response headers |
| XSS via Markdown | Frontend pipeline: `marked` → `DOMPurify.sanitize` → DOM. Never `innerHTML` raw markdown. Community submissions never render Markdown in v1 (only editorial does) |
| XSS via canonical_url | URL validation on insert (http/https only, parses cleanly). On render, `<a>` tags always get `rel="noopener noreferrer"` and `target="_blank"` |
| RSS duplication | `UNIQUE` on `source_url` + URL normalization before insert |
| Malicious admin | `bcrypt` hashing, constant-time compare on lookup, role-gated routes, key revocation via `revoked_at` |
| Submitter PII | Email stored, **never** returned. No IPs persisted. |
| Geo precision drift | `CHECK` constraint on longitude; lat bounded by `GEOGRAPHY(POINT, 4326)` |
| Body size DoS | 64 KiB max body on all POST endpoints (413 above) |
| Bad data injection | Strict input validation: types, ranges, RFC 5322 email, http/https URL only |
| IP leakage in logs | Caddy's default access log captures client IPs. For v1 this is acceptable (IPs aren't tied to pins). v2 follow-up: Caddy `redact` directive to strip client IPs from logs. |

**Out of scope for v1, deliberate deferrals to v2:** CAPTCHA/Turnstile (only if honeypot + rate limit prove insufficient in production traffic); hashed IP for rate limit (rotating secret); duplicate-title-near-location detection algorithm.

## Frontend

Static SPA in `/var/www/vhosts/newsium.org/public_html/`. No build step.

**Files:**
- `index.html` — entry, includes vendored Leaflet CSS/JS, app.js, styles.css
- `app.js` — view router, map init, submitter form, popup rendering, marker cluster, debounced fetch
- `styles.css` — dark theme, layout, popup/overlay styling
- `vendor/leaflet/` — Leaflet 1.9.x (CSS + JS, UMD build)
- `vendor/leaflet.markercluster/` — Leaflet.markercluster 1.5.x
- `vendor/marked/` — `marked` 12.x (UMD)
- `vendor/dompurify/` — `DOMPurify` 3.x (UMD)

**Reader view (default):**
- Full-viewport Leaflet map.
- Top-left "Submit News" button → toggles submitter overlay.
- Top-right Leaflet layer control: **Street** (Carto Dark Matter), **Satellite** (ESRI World Imagery), **Topo** (OpenTopoMap).
- Bottom-right: zoom controls + Leaflet attribution.
- Markers cluster via `leaflet.markercluster` at zoom ≤ 6; individual pins at zoom > 6.
- Pin color by `source_type`: editorial = amber `#f59e0b`, community = cyan `#22d3ee`, RSS = magenta `#e879f9`.
- **Debounced fetch:** `map.on('moveend', debounce(fetchPinsForViewport, 300))` — fast pans don't spam `/api/pins`.
- **Fetch cap:** when bbox area exceeds 60°×30° (essentially the whole world), the client request sets `limit=1000` and the server clamps any larger client value to 1000.
- Click pin → popup with title, source-type badge, relative time (`published_at`), canonical URL (if any), "Read more" button.
- **Read more on editorial pins** fetches `/api/pins/:id`, then renders the body via:
  ```js
  const html = DOMPurify.sanitize(marked.parse(detail.body_markdown));
  popupBody.innerHTML = html;
  ```
  Never the reverse. Never `innerHTML = marked.parse(...)` alone.

**Submitter view (overlay):**
- Modal overlay with form.
- Fields: Title, Submitter Name, Email, URL (optional), Published-at (optional, defaults to now), Category (optional free-text), honeypot (`hp_company`).
- Mini Leaflet map (300×200) for click-to-place. Single click sets `lat`/`lng` and drops a marker.
- Submit → POST /api/pins → on 201, overlay closes and the new pin is added to the main map with a 1-second glow animation.

**Visual style:**
- Body: `#0b0f14`, text `#e6edf3`, accent `#5eead4`.
- Inter (system fallback) font; monospace for title typography.
- Matches the existing green-on-black placeholder vibe but grown-up.

**Tile providers (free, no API key, attribution shown via Leaflet attribution control):**
- **Street:** `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` — "© OpenStreetMap contributors © CARTO"
- **Satellite:** `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` — "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
- **Topo:** `https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png` — "Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)"

## Deployment

**File layout under `/var/www/vhosts/newsium.org/`:**
```
├── public_html/             # static SPA
└── api/                     # Bun + Hono project
    ├── package.json
    ├── tsconfig.json
    ├── .env                  # NEWSIUM_DB_URL, NEWSIUM_PORT
    └── src/
        ├── server.ts         # Hono app entry
        ├── db.ts             # postgres.js pool
        ├── schema.sql        # migrations (committed)
        ├── auth.ts           # X-Admin-Key middleware (split + bcrypt + timingSafeEqual)
        ├── ratelimit.ts      # in-memory IP rate limiter (Map<ip, {count, expiresAt}>)
        ├── normalize.ts      # URL/email normalization helpers
        ├── cursors.ts        # base64url encode/decode for keyset pagination
        └── routes/
            ├── pins.ts       # public reads + community submission
            ├── admin.ts      # editorial, RSS, hide/update
            └── health.ts
```

**Database setup:**
```bash
sudo -u postgres psql -c "CREATE DATABASE newsium;"
sudo -u postgres psql -d newsium -c "CREATE EXTENSION postgis;"
sudo -u postgres psql -d newsium -f /var/www/vhosts/newsium.org/api/src/schema.sql

# App role — least privilege
sudo -u postgres psql -c "CREATE USER newsium_app WITH PASSWORD '<generated>';"
sudo -u postgres psql -d newsium <<'SQL'
GRANT CONNECT ON DATABASE newsium TO newsium_app;
GRANT USAGE ON SCHEMA public TO newsium_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO newsium_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO newsium_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO newsium_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO newsium_app;
SQL
```

**Bun service (systemd):** `/etc/systemd/system/newsium-api.service`
```ini
[Unit]
Description=Xyzo API (Bun + Hono)
After=network.target

[Service]
Type=simple
User=asher
WorkingDirectory=/var/www/vhosts/newsium.org/api
ExecStart=/home/asher/.bun/bin/bun run src/server.ts
Restart=on-failure
EnvironmentFile=/var/www/vhosts/newsium.org/api/.env

[Install]
WantedBy=multi-user.target
```
`sudo systemctl daemon-reload && sudo systemctl enable --now newsium-api`.

**Caddyfile update** (replace existing `xyzo.org` block):
```
xyzo.org {
    root * /var/www/vhosts/newsium.org/public_html
    encode zstd gzip
    file_server
    reverse_proxy /api/* localhost:3008
    header {
        Content-Security-Policy "frame-ancestors 'none'"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```
`sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

**Smoke test:**
```bash
curl -s https://xyzo.org/api/health
curl -s https://xyzo.org/api/pins
ADMIN_KEY=$(cat /tmp/newsium-admin-key)
curl -sX POST https://xyzo.org/api/admin/pins \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test pin","lat":24.86,"lng":67.00,"body_markdown":"# hi","author_name":"Tester"}'

# Cursor pagination
curl -s "https://xyzo.org/api/pins?limit=10" | jq .next_cursor
curl -s "https://xyzo.org/api/pins?limit=10&before=<next_cursor>" | jq .has_more

# RSS dedup
curl -sX POST https://xyzo.org/api/admin/rss \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"X","lat":40.7,"lng":-74.0,"source_feed":"https://feed.example","source_url":"https://example.com/x?utm_source=tw","original_published_at":"2026-08-20T00:00:00Z"}'
# Run again with same source_url → 200 with existing pin (idempotent)
```
Then open `https://xyzo.org` in a real browser; the test pins should appear on the map. Click an editorial pin's "Read more" and confirm Markdown renders cleanly without script execution.

## Out of scope (v2 candidates)

- Background RSS fetcher / cron job (v1 has the ingest endpoint; cron to follow)
- Geocoding (v1 must supply lat/lng; auto-geocoding from a place string is v2)
- Real user accounts / RBAC (v1 uses admin keys only)
- Moderation queue / drafts / scheduled publish
- Filter sidebar (by source type, date range, region)
- Search box (full-text on title)
- Time slider / cluster animation over time
- Country/region stats panel
- Server-side spatial clustering (`ST_ClusterDBSCAN`) and MVT vector tiles (`ST_AsMVT`) for very large viewports
- Region associations via polygon joins (city → country → continent)
- Normalized category taxonomy + UI
- IP hashing with rotating secret for rate-limit (replacing the per-process Map)
- CAPTCHA / Turnstile if honeypot+rate limit prove insufficient
- Duplicate-title-near-location detection algorithm
- Source-type extensions: `social_details`, `video_details`, `podcast_details`, `official_alert_details`, `government_details`, `press_release_details`
- i18n
- Mobile-specific UI optimization
- Analytics

## Open questions

- **RSS feed sources.** v1 ships with the ingest endpoint; the operator hasn't picked feeds yet. Decide in a follow-up brainstorming.
- **Captcha threshold.** Add Turnstile if honeypot+IP rate limit ever lets through clear bot traffic. Monitor for two weeks post-launch before deciding.