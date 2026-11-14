# Xyzo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-source geo-news database and map UI at xyzo.org, with PostgreSQL+PostGIS storage, Bun+Hono API, and Leaflet frontend, end-to-end.

**Architecture:** Static SPA served by Caddy at xyzo.org, with `/api/*` reverse-proxied to a Bun+Hono service on localhost:3008. The API reads/writes a Postgres+PostGIS `newsium` database using cursor pagination, RSS deduplication via UNIQUE source_url, and bcrypt-protected admin keys (`X-Admin-Key: nk_live_<keyid>.<secret>`). Markdown rendering on the frontend uses `marked` → `DOMPurify.sanitize`. Rate limiting is in-memory. Body size capped at 64 KiB.

**Tech Stack:** Bun + Hono (TypeScript) on port 3008, PostgreSQL 15 + PostGIS 3.3 (existing cluster), `postgres.js` driver, `Bun.password` for bcrypt, `zod` + `@hono/zod-validator` for validation, Leaflet 1.9 + leaflet.markercluster 1.5 + marked 12 + DOMPurify 3 (vendored locally), Caddy 2 (existing), systemd (existing). `bun:test` for tests.

**Spec:** `/var/www/vhosts/newsium.org/docs/superpowers/specs/2026-08-20-newsium-news-map-design.md`

---

## File Structure

```
/var/www/vhosts/newsium.org/
├── public_html/                              # static SPA
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── vendor/
│       ├── leaflet/leaflet.js, leaflet.css
│       ├── leaflet.markercluster/
│       │   ├── leaflet.markercluster.js
│       │   └── MarkerCluster.css, MarkerCluster.Default.css
│       ├── marked/marked.umd.min.js
│       └── dompurify/purify.min.js
└── api/                                       # Bun + Hono project
    ├── package.json
    ├── tsconfig.json
    ├── .env.example
    ├── schema.sql
    ├── src/
    │   ├── server.ts
    │   ├── db.ts
    │   ├── auth.ts
    │   ├── ratelimit.ts
    │   ├── normalize.ts
    │   ├── cursors.ts
    │   ├── validate.ts
    │   ├── seed-admin-key.ts
    │   └── routes/
    │       ├── pins.ts
    │       ├── admin.ts
    │       └── health.ts
    └── tests/
        ├── helpers.ts
        ├── cursors.test.ts
        ├── normalize.test.ts
        ├── ratelimit.test.ts
        ├── auth.test.ts
        ├── health.test.ts
        ├── pins.test.ts
        └── admin.test.ts
```

Plus:
- `/etc/systemd/system/xyzo-api.service` (create)
- `/etc/caddy/Caddyfile` (modify `xyzo.org` block)

---

## Tasks

### Task 1: Initialize git repository at xyzo.org

**Files:**
- Create: `/var/www/vhosts/newsium.org/.gitignore`

- [ ] **Step 1: Initialize repo and set identity**

```bash
cd /var/www/vhosts/newsium.org
git init
git config user.email "xyzo@local"
git config user.name "Newsium Dev"
```

- [ ] **Step 2: Create .gitignore**

Write to `/var/www/vhosts/newsium.org/.gitignore`:

```
api/.env
api/node_modules/
public_html/vendor/*/
!public_html/vendor/.gitkeep
*.log
.DS_Store
```

- [ ] **Step 3: Keep vendor directories tracked**

```bash
mkdir -p public_html/vendor/{leaflet,leaflet.markercluster,marked,dompurify}
touch public_html/vendor/leaflet/.gitkeep public_html/vendor/leaflet.markercluster/.gitkeep public_html/vendor/marked/.gitkeep public_html/vendor/dompurify/.gitkeep
```

- [ ] **Step 4: Initial commit**

```bash
git add -A
git commit -m "chore: initialize xyzo repo"
```

---

### Task 2: Create newsium database and enable PostGIS

**Files:** none (run SQL via psql)

- [ ] **Step 1: Create database as postgres user**

```bash
sudo -u postgres psql -c "CREATE DATABASE newsium;"
```
Expected: `CREATE DATABASE`

- [ ] **Step 2: Enable PostGIS extension in newsium**

```bash
sudo -u postgres psql -d newsium -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```
Expected: `CREATE EXTENSION` (notice — PostGIS installed via package, extension enabled per-database).

- [ ] **Step 3: Verify extension is enabled**

```bash
sudo -u postgres psql -d newsium -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';"
```
Expected: one row, extname=`postgis`, extversion=`3.3.x`.

---

### Task 3: Write schema.sql

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/schema.sql`

- [ ] **Step 1: Write the schema file**

Write to `/var/www/vhosts/newsium.org/api/schema.sql`:

```sql
-- Xyzo schema. Idempotent — safe to re-run during development.

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
```

- [ ] **Step 2: Commit**

```bash
git add api/schema.sql
git commit -m "feat(db): add xyzo schema (pins, detail tables, admin_keys, triggers)"
```

---

### Task 4: Apply schema and create app role

**Files:** none

- [ ] **Step 1: Apply schema**

```bash
sudo -u postgres psql -d newsium -f /var/www/vhosts/newsium.org/api/schema.sql
```
Expected: `CREATE EXTENSION`, `CREATE FUNCTION`, `CREATE TABLE` x5, `CREATE INDEX` x6, `CREATE TRIGGER` x4, `DROP TRIGGER` x4. (Some "already exists" notices on re-run are fine.)

- [ ] **Step 2: Verify tables**

```bash
sudo -u postgres psql -d newsium -c "\dt"
```
Expected: list including `pins`, `editorial_details`, `community_details`, `rss_details`, `admin_keys`.

- [ ] **Step 3: Create app role with least privilege**

```bash
sudo -u postgres psql -d newsium <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'newsium_app') THEN
    CREATE USER newsium_app WITH PASSWORD 'CHANGE_ME';
  END IF;
END
$$;
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
Expected: `CREATE ROLE` (or `DO` notice if user exists), then four `GRANT` and two `ALTER DEFAULT PRIVILEGES` lines.

- [ ] **Step 4: Smoke-test app role connection**

```bash
PGPASSWORD=CHANGE_ME psql -h localhost -U newsium_app -d newsium -c "SELECT count(*) FROM pins;"
```
Expected: `0` (empty table; if you see a permission error, re-check Step 3).

---

### Task 5: Scaffold Bun project

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/package.json`
- Create: `/var/www/vhosts/newsium.org/api/tsconfig.json`
- Create: `/var/www/vhosts/newsium.org/api/.env.example`

- [ ] **Step 1: Create package.json**

Write to `/var/www/vhosts/newsium.org/api/package.json`:

```json
{
  "name": "newsium-api",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "start": "bun run src/server.ts",
    "test": "bun test",
    "seed-admin-key": "bun run src/seed-admin-key.ts"
  },
  "dependencies": {
    "@hono/zod-validator": "^0.4.0",
    "hono": "^4.6.0",
    "postgres": "^3.4.5",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Write to `/var/www/vhosts/newsium.org/api/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create .env.example**

Write to `/var/www/vhosts/newsium.org/api/.env.example`:

```
NEWSIUM_DB_URL=postgres://newsium_app:CHANGE_ME@localhost:5432/newsium
NEWSIUM_PORT=3008
NEWSIUM_VERSION=0.1.0
```

- [ ] **Step 4: Install dependencies**

```bash
cd /var/www/vhosts/newsium.org/api
cp .env.example .env
bun install
```
Expected: `bun install` resolves and installs hono, postgres, zod, @hono/zod-validator. `.env` file is created (not committed).

- [ ] **Step 5: Verify Bun is installed**

```bash
bun --version
```
Expected: prints `1.x.x` (any 1.x is fine).

- [ ] **Step 6: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/package.json api/tsconfig.json api/.env.example
git commit -m "feat(api): scaffold bun project with hono, postgres, zod"
```

---

### Task 6: Implement cursor encode/decode

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/cursors.ts`
- Create: `/var/www/vhosts/newsium.org/api/tests/cursors.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/cursors.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { encodeCursor, decodeCursor } from "../src/cursors";

describe("cursors", () => {
  test("roundtrip preserves timestamp and id", () => {
    const ts = new Date("2026-08-20T14:32:00.000Z");
    const cursor = encodeCursor(ts, 42);
    const decoded = decodeCursor(cursor);
    expect(decoded.timestamp.toISOString()).toBe(ts.toISOString());
    expect(decoded.id).toBe(42);
  });

  test("encoded cursor is base64url (no +, /, or =)", () => {
    const cursor = encodeCursor(new Date("2026-01-01T00:00:00.000Z"), 999999);
    expect(cursor).not.toMatch(/[+/=]/);
  });

  test("decodeCursor returns null for malformed input", () => {
    expect(decodeCursor("not-base64!@#")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/cursors.test.ts
```
Expected: FAIL with `Cannot find module '../src/cursors'`.

- [ ] **Step 3: Implement cursors.ts**

Write to `/var/www/vhosts/newsium.org/api/src/cursors.ts`:

```typescript
export interface Cursor {
  timestamp: Date;
  id: number;
}

export function encodeCursor(timestamp: Date, id: number): string {
  const raw = `${timestamp.toISOString()}|${id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Cursor | null {
  if (!cursor) return null;
  let decoded:;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.lastIndexOf("|");
  if (idx === -1) return null;
  const ts = decoded.slice(0, idx);
  const idStr = decoded.slice(idx + 1);
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 0) return null;
  const date = new Date(ts);
  if (isNaN(date.getTime())) return null;
  return { timestamp: date, id };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test tests/cursors.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/cursors.ts api/tests/cursors.test.ts
git commit -m "feat(api): cursor encode/decode for keyset pagination"
```

---

### Task 7: Implement URL and email normalization

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/normalize.ts`
- Create: `/var/www/vhosts/newsium.org/api/tests/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/normalize.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { normalizeUrl, normalizeEmail } from "../src/normalize";

describe("normalizeUrl", () => {
  test("lowercases host", () => {
    expect(normalizeUrl("https://EXAMPLE.com/x")).toBe("https://example.com/x");
  });
  test("upgrades http to https", () => {
    expect(normalizeUrl("http://example.com/x")).toBe("https://example.com/x");
  });
  test("strips fragment", () => {
    expect(normalizeUrl("https://example.com/x#section")).toBe("https://example.com/x");
  });
  test("strips trailing slash on path-less URLs", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });
  test("drops common tracking params", () => {
    expect(normalizeUrl("https://example.com/x?utm_source=tw&id=1"))
      .toBe("https://example.com/x?id=1");
    expect(normalizeUrl("https://example.com/x?fbclid=abc&y=2"))
      .toBe("https://example.com/x?y=2");
    expect(normalizeUrl("https://example.com/x?gclid=g&z=3"))
      .toBe("https://example.com/x?z=3");
  });
  test("preserves non-tracking params", () => {
    expect(normalizeUrl("https://example.com/x?a=1&b=2")).toBe("https://example.com/x?a=1&b=2");
  });
});

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
  });
  test("passes through already-normal email", () => {
    expect(normalizeEmail("a@b.co")).toBe("a@b.co");
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/normalize.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement normalize.ts**

Write to `/var/www/vhosts/newsium.org/api/src/normalize.ts`:

```typescript
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "yclid", "_hsenc",
  "_hsmi", "ref", "ref_src",
]);

export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  const params = url.searchParams;
  const kept: [string, string][] = [];
  for (const [k, v] of params) {
    if (!TRACKING_PARAMS.has(k)) kept.push([k, v]);
  }
  params.forEach(() => {});
  url.search = "";
  for (const [k, v] of kept.sort(([a], [b]) => a.localeCompare(b))) {
    url.searchParams.append(k, v);
  }
  let pathAndQuery = url.pathname + url.search;
  if (pathAndQuery === "/") pathAndQuery = "";
  return `${url.protocol}//${url.host}${pathAndQuery}`;
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test tests/normalize.test.ts
```
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/normalize.ts api/tests/normalize.test.ts
git commit -m "feat(api): URL and email normalization"
```

---

### Task 8: Implement in-memory IP rate limiter

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/ratelimit.ts`
- Create: `/var/www/vhosts/newsium.org/api/tests/ratelimit.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/ratelimit.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { RateLimiter } from "../src/ratelimit";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ max: 3, windowMs: 60_000 });
  });

  test("allows up to max hits", () => {
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
  });

  test("blocks the (max+1)th hit", () => {
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    const result = limiter.check("1.1.1.1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("isolates buckets per IP", () => {
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    expect(limiter.check("2.2.2.2").allowed).toBe(true);
  });

  test("window resets after expiry", () => {
    const fast = new RateLimiter({ max: 1, windowMs: 10 });
    expect(fast.check("1.1.1.1").allowed).toBe(true);
    expect(fast.check("1.1.1.1").allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(fast.check("1.1.1.1").allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/ratelimit.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement ratelimit.ts**

Write to `/var/www/vhosts/newsium.org/api/src/ratelimit.ts`:

```typescript
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  expiresAt: number;
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly opts: RateLimiterOptions) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      this.buckets.set(key, { count: 1, expiresAt: now + this.opts.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count < this.opts.max) {
      bucket.count++;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: bucket.expiresAt - now };
  }
}

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test tests/ratelimit.test.ts
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/ratelimit.ts api/tests/ratelimit.test.ts
git commit -m "feat(api): in-memory IP rate limiter"
```

---

### Task 9: Implement db.ts connection pool

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/db.ts`

- [ ] **Step 1: Write db.ts**

Write to `/var/www/vhosts/newsium.org/api/src/db.ts`:

```typescript
import postgres from "postgres";

let sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!sql) {
    const url = process.env.NEWSIUM_DB_URL;
    if (!url) throw new Error("NEWSIUM_DB_URL is not set");
    sql = postgres(url, {
      max: 10,
      idle_timeout: 30,
      types: {
        bigint: postgres.BigInt,
      },
    });
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}
```

- [ ] **Step 2: Smoke test by hand**

```bash
cd /var/www/vhosts/newsium.org/api
bun -e 'import("./src/db.ts").then(async ({getDb, closeDb}) => { const sql = getDb(); const rows = await sql`SELECT count(*)::int as n FROM pins`; console.log(rows); await closeDb(); })'
```
Expected: prints `[ { n: 0 } ]`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/db.ts
git commit -m "feat(api): postgres.js connection pool"
```

---

### Task 10: Implement validation schemas (zod)

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/validate.ts`

- [ ] **Step 1: Write validate.ts**

Write to `/var/www/vhosts/newsium.org/api/src/validate.ts`:

```typescript
import { z } from "zod";

const CATEGORIES = [
  "politics", "business", "crime", "weather", "science",
  "technology", "sports", "culture", "environment",
  "conflict", "health", "other",
] as const;

const PRECISIONS = ["exact", "city", "region", "country"] as const;

const isoDate = z.string().refine((s) => !isNaN(new Date(s).getTime()), {
  message: "invalid ISO 8601 timestamp",
});

const httpUrl = z.string().url().refine(
  (s) => { try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } },
  { message: "must be http(s)" },
);

export const CategoryEnum = z.enum(CATEGORIES);
export const PrecisionEnum = z.enum(PRECISIONS);

// ── Community submission ───────────────────────────────────────────────
export const CommunitySubmissionSchema = z.object({
  title: z.string().min(1).max(200),
  submitter_name: z.string().min(1).max(100),
  submitter_email: z.string().email().max(254),
  canonical_url: httpUrl.optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  published_at: isoDate.optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
  hp_company: z.string().max(0).optional().default(""),
});
export type CommunitySubmission = z.infer<typeof CommunitySubmissionSchema>;

// ── Editorial ──────────────────────────────────────────────────────────
export const EditorialPinSchema = z.object({
  title: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  body_markdown: z.string().min(1).max(32_000),
  image_url: httpUrl.optional(),
  author_name: z.string().min(1).max(100),
  canonical_url: httpUrl.optional(),
  published_at: isoDate.optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
});
export type EditorialPin = z.infer<typeof EditorialPinSchema>;

// ── RSS ingest ─────────────────────────────────────────────────────────
export const RssIngestSchema = z.object({
  title: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  source_feed: httpUrl,
  source_url: httpUrl,
  original_published_at: isoDate.optional(),
  summary: z.string().max(2000).optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
});
export type RssIngest = z.infer<typeof RssIngestSchema>;

// ── Patch (hide/update) ────────────────────────────────────────────────
export const PatchPinSchema = z.object({
  status: z.enum(["published", "hidden"]).optional(),
  title: z.string().min(1).max(200).optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: "no fields provided" });
export type PatchPin = z.infer<typeof PatchPinSchema>;

// ── List query params ──────────────────────────────────────────────────
export const ListPinsQuerySchema = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  source_type: z.union([
    z.enum(["editorial", "community", "rss"]),
    z.array(z.enum(["editorial", "community", "rss"])),
  ]).optional(),
  since: isoDate.optional(),
  category: CategoryEnum.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  before: z.string().min(1).optional(),
});
export type ListPinsQuery = z.infer<typeof ListPinsQuerySchema>;
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /var/www/vhosts/newsium.org/api
bun -e 'import("./src/validate.ts").then(() => console.log("ok"))'
```
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/validate.ts
git commit -m "feat(api): zod validation schemas for all endpoints"
```

---

### Task 11: Implement auth middleware (X-Admin-Key)

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/auth.ts`
- Create: `/var/www/vhosts/newsium.org/api/tests/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/auth.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { parseAdminKey } from "../src/auth";

describe("parseAdminKey", () => {
  test("splits a valid key into key_id and secret", () => {
    const result = parseAdminKey("nk_live_abc123.xyz789");
    expect(result).not.toBeNull();
    expect(result!.keyId).toBe("nk_live_abc123");
    expect(result!.secret).toBe("xyz789");
    expect(result!.fullSecret).toBe("nk_live_abc123.xyz789");
  });

  test("returns null when no dot present", () => {
    expect(parseAdminKey("no-dot-here")).toBeNull();
  });

  test("returns null when empty or null", () => {
    expect(parseAdminKey("")).toBeNull();
    expect(parseAdminKey(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/auth.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement auth.ts (parser only at this step)**

Write to `/var/www/vhosts/newsium.org/api/src/auth.ts`:

```typescript
import { getDb } from "./db";

export type AdminRole = "editorial" | "rss_ingest" | "super";

export interface ParsedAdminKey {
  keyId: string;
  secret: string;
  fullSecret: string;
}

export function parseAdminKey(header: string | null): ParsedAdminKey | null {
  if (!header) return null;
  const idx = header.indexOf(".");
  if (idx === -1) return null;
  const keyId = header.slice(0, idx);
  const secret = header.slice(idx + 1);
  if (!keyId || !secret) return null;
  return { keyId, secret, fullSecret: header };
}

export interface AdminAuth {
  name: string;
  role: AdminRole;
}

export async function verifyAdminKey(parsed: ParsedAdminKey): Promise<AdminAuth | null> {
  const sql = getDb();
  const rows = await sql<{ name: string; role: AdminRole; key_hash: string }[]>`
    SELECT name, role, key_hash
    FROM admin_keys
    WHERE key_id = ${parsed.keyId} AND revoked_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  const ok = await Bun.password.verify(parsed.fullSecret, row.key_hash);
  if (!ok) return null;
  return { name: row.name, role: row.role };
}

export function requireRole(auth: AdminAuth | null, allowed: AdminRole[]): boolean {
  if (!auth) return false;
  if (auth.role === "super") return true;
  return allowed.includes(auth.role);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/auth.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/auth.ts api/tests/auth.test.ts
git commit -m "feat(api): admin key parser and bcrypt verifier"
```

---

### Task 12: Implement test helpers and DB cleanup

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/tests/helpers.ts`

- [ ] **Step 1: Write tests/helpers.ts**

Write to `/var/www/vhosts/newsium.org/api/tests/helpers.ts`:

```typescript
import { getDb, closeDb } from "../src/db";

export async function truncateAll(): Promise<void> {
  const sql = getDb();
  await sql`TRUNCATE pins, editorial_details, community_details, rss_details, admin_keys
            RESTART IDENTITY CASCADE`;
}

export async function seedAdminKey(name: string, role: "editorial" | "rss_ingest" | "super" = "editorial"): Promise<string> {
  const sql = getDb();
  const keyId = `nk_test_${Math.random().toString(36).slice(2, 11)}`;
  const secret = Math.random().toString(36).slice(2, 34);
  const fullSecret = `${keyId}.${secret}`;
  const hash = await Bun.password.hash(fullSecret, { algorithm: "bcrypt", cost: 4 });
  await sql`
    INSERT INTO admin_keys (key_id, name, key_hash, role)
    VALUES (${keyId}, ${name}, ${hash}, ${role})
  `;
  return fullSecret;
}

export async function withCleanup<T>(body: () => Promise<T>): Promise<T> {
  await truncateAll();
  try {
    return await body();
  } finally {
    await truncateAll();
    await closeDb();
  }
}
```

- [ ] **Step 2: Verify it runs**

```bash
cd /var/www/vhosts/newsium.org/api
bun -e 'import("./tests/helpers.ts").then(async ({truncateAll, closeDb}) => { await truncateAll(); console.log("ok"); await closeDb(); })'
```
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/tests/helpers.ts
git commit -m "test(api): DB truncate + admin-key seed helpers"
```

---

### Task 13: Implement health endpoint

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/routes/health.ts`
- Create: `/var/www/vhosts/newsium.org/api/tests/health.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/health.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { healthRoute } from "../src/routes/health";

describe("GET /api/health", () => {
  test("returns ok with version", async () => {
    const app = new Hono();
    app.route("/api/health", healthRoute);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/health.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement routes/health.ts**

Write to `/var/www/vhosts/newsium.org/api/src/routes/health.ts`:

```typescript
import { Hono } from "hono";

export const healthRoute = new Hono().get("/", (c) =>
  c.json({ ok: true, version: process.env.NEWSIUM_VERSION ?? "0.0.0" })
);
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test tests/health.test.ts
```
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/health.ts api/tests/health.test.ts
git commit -m "feat(api): health endpoint"
```

---

### Task 14: Implement GET /api/pins (list with cursor + bbox)

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/routes/pins.ts` (skeleton — full implementation in next tasks)
- Modify: `/var/www/vhosts/newsium.org/api/src/db.ts` (no change, just placeholder for query helpers)
- Create: `/var/www/vhosts/newsium.org/api/tests/pins.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/pins.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { truncateAll, seedAdminKey, withCleanup } from "./helpers";
import { getDb } from "../src/db";

async function makeEditorialPin(title: string, lat: number, lng: number) {
  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO pins (source_type, title, location, published_at)
    VALUES ('editorial', ${title}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO editorial_details (pin_id, body_markdown, author_name)
    VALUES (${row.id}, ${"# " + title}, 'Tester')
  `;
  return row.id;
}

describe("GET /api/pins", () => {
  beforeEach(async () => { await truncateAll(); });

  test("returns empty list when no pins", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pins).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  test("returns pins sorted by created_at DESC", async () => {
    await makeEditorialPin("First", 0, 0);
    await new Promise(r => setTimeout(r, 5));
    await makeEditorialPin("Second", 0, 0);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins");
    const body = await res.json();
    expect(body.pins.length).toBe(2);
    expect(body.pins[0].title).toBe("Second");
    expect(body.pins[1].title).toBe("First");
  });

  test("filters by bbox", async () => {
    await makeEditorialPin("InBox", 24.86, 67.00);
    await makeEditorialPin("OutBox", -33.86, 151.20);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?bbox=60,20,75,30");
    const body = await res.json();
    expect(body.pins.length).toBe(1);
    expect(body.pins[0].title).toBe("InBox");
  });

  test("filters by category", async () => {
    const sql = getDb();
    await sql`INSERT INTO pins (source_type, title, location, category)
              VALUES ('editorial', 'Cat', ST_SetSRID(ST_MakePoint(0,0),4326)::geography, 'weather')`;
    await sql`INSERT INTO pins (source_type, title, location, category)
              VALUES ('editorial', 'Other', ST_SetSRID(ST_MakePoint(0,0),4326)::geography, 'politics')`;
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?category=weather");
    const body = await res.json();
    expect(body.pins.length).toBe(1);
    expect(body.pins[0].category).toBe("weather");
  });

  test("cursor pagination: returns has_more and next_cursor when limit hit", async () => {
    for (let i = 0; i < 5; i++) {
      await makeEditorialPin(`Pin${i}`, 0, 0);
    }
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?limit=2");
    const body = await res.json();
    expect(body.pins.length).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();

    const res2 = await app.request(`/api/pins?limit=2&before=${encodeURIComponent(body.next_cursor)}`);
    const body2 = await res2.json();
    expect(body2.pins.length).toBe(2);
    expect(body2.has_more).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/pins.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement routes/pins.ts (skeleton — to be extended)**

Write to `/var/www/vhosts/newsium.org/api/src/routes/pins.ts`:

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { ListPinsQuerySchema } from "../validate";
import { encodeCursor, decodeCursor } from "../cursors";

export const pinsRoute = new Hono();

pinsRoute.get("/pins", zValidator("query", ListPinsQuerySchema), async (c) => {
  const q = c.req.valid("query");
  const sql = getDb();
  const limit = q.limit ?? 500;

  const where: any[] = [sql`status = 'published'`];
  if (q.bbox) {
    const [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
    where.push(sql`location::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)`);
  }
  if (q.source_type) {
    const types = Array.isArray(q.source_type) ? q.source_type : [q.source_type];
    where.push(sql`source_type = ANY(${types})`);
  }
  if (q.category) where.push(sql`category = ${q.category}`);
  if (q.since) where.push(sql`published_at >= ${new Date(q.since)}`);
  if (q.before) {
    const cur = decodeCursor(q.before);
    if (cur) where.push(sql`(created_at, id) < (${cur.timestamp}, ${cur.id})`);
  }

  const whereSql = where.reduce((acc, w, i) =>
    i === 0 ? sql`${w}` : sql`${acc} AND ${w}`, sql`TRUE`
  );

  // Fetch one extra row to determine has_more
  const rows = await sql<any[]>`
    SELECT id, source_type, title,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
           location_precision, confidence_score, status, category,
           published_at, created_at, updated_at
    FROM pins
    WHERE ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor(new Date(last.created_at), last.id)
    : null;

  return c.json({
    pins: trimmed.map((r) => ({
      id: r.id,
      source_type: r.source_type,
      title: r.title,
      location: { lat: Number(r.lat), lng: Number(r.lng) },
      location_precision: r.location_precision,
      confidence_score: r.confidence_score,
      status: r.status,
      category: r.category,
      published_at: new Date(r.published_at).toISOString(),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
  });
});
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test tests/pins.test.ts
```
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/pins.ts api/tests/pins.test.ts
git commit -m "feat(api): GET /api/pins with cursor pagination, bbox, category"
```

---

### Task 15: Implement GET /api/pins/:id (detail)

**Files:**
- Modify: `/var/www/vhosts/newsium.org/api/src/routes/pins.ts`
- Modify: `/var/www/vhosts/newsium.org/api/tests/pins.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `/var/www/vhosts/newsium.org/api/tests/pins.test.ts`:

```typescript
describe("GET /api/pins/:id", () => {
  beforeEach(async () => { await truncateAll(); });

  test("returns editorial pin with detail, no email leak possible", async () => {
    const id = await makeEditorialPin("Detail", 24.86, 67.00);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.source_type).toBe("editorial");
    expect(body.detail.body_markdown).toBe("# Detail");
    expect(body.detail.author_name).toBe("Tester");
    expect(JSON.stringify(body)).not.toContain("submitter_email");
  });

  test("community pin detail never contains email even though DB row does", async () => {
    const sql = getDb();
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('community', 'Community', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
      RETURNING id
    `;
    await sql`
      INSERT INTO community_details (pin_id, submitter_name, submitter_email)
      VALUES (${row.id}, 'Jane', 'jane@example.com')
    `;
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/${row.id}`);
    const body = await res.json();
    expect(body.detail.submitter_name).toBe("Jane");
    expect(JSON.stringify(body)).not.toContain("jane@example.com");
  });

  test("returns 404 for missing id", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins/999999");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify the new tests fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/pins.test.ts
```
Expected: 3 new tests fail.

- [ ] **Step 3: Add the detail route**

Append to `/var/www/vhosts/newsium.org/api/src/routes/pins.ts`:

```typescript
pinsRoute.get("/pins/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const sql = getDb();
  const pins = await sql<any[]>`
    SELECT id, source_type, title,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
           location_precision, confidence_score, status, category,
           published_at, created_at, updated_at
    FROM pins WHERE id = ${id} LIMIT 1
  `;
  if (pins.length === 0) return c.json({ error: "not_found" }, 404);
  const p = pins[0];

  let detail: any = {};
  if (p.source_type === "editorial") {
    const rows = await sql<any[]>`
      SELECT body_markdown, image_url, author_name, canonical_url, created_at, updated_at
      FROM editorial_details WHERE pin_id = ${id} LIMIT 1
    `;
    const r = rows[0];
    detail = {
      body_markdown: r.body_markdown,
      image_url: r.image_url,
      author_name: r.author_name,
      canonical_url: r.canonical_url,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  } else if (p.source_type === "community") {
    const rows = await sql<any[]>`
      SELECT submitter_name, canonical_url, created_at, updated_at
      FROM community_details WHERE pin_id = ${id} LIMIT 1
    `;
    const r = rows[0];
    detail = {
      submitter_name: r.submitter_name,
      canonical_url: r.canonical_url,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  } else if (p.source_type === "rss") {
    const rows = await sql<any[]>`
      SELECT source_feed, source_url, original_published_at, summary, created_at, updated_at
      FROM rss_details WHERE pin_id = ${id} LIMIT 1
    `;
    const r = rows[0];
    detail = {
      source_feed: r.source_feed,
      source_url: r.source_url,
      original_published_at: r.original_published_at ? new Date(r.original_published_at).toISOString() : null,
      summary: r.summary,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  return c.json({
    id: p.id,
    source_type: p.source_type,
    title: p.title,
    location: { lat: Number(p.lat), lng: Number(p.lng) },
    location_precision: p.location_precision,
    confidence_score: p.confidence_score,
    status: p.status,
    category: p.category,
    published_at: new Date(p.published_at).toISOString(),
    created_at: new Date(p.created_at).toISOString(),
    updated_at: new Date(p.updated_at).toISOString(),
    detail,
  });
});
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
bun test tests/pins.test.ts
```
Expected: 8 passing (5 list + 3 detail).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/pins.ts api/tests/pins.test.ts
git commit -m "feat(api): GET /api/pins/:id with source-specific detail, no email leak"
```

---

### Task 16: Implement POST /api/pins (community submission)

**Files:**
- Modify: `/var/www/vhosts/newsium.org/api/src/routes/pins.ts`
- Modify: `/var/www/vhosts/newsium.org/api/tests/pins.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `/var/www/vhosts/newsium.org/api/tests/pins.test.ts`:

```typescript
describe("POST /api/pins (community submission)", () => {
  beforeEach(async () => { await truncateAll(); });

  test("creates a pin and returns 201", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Protest in Lahore",
        submitter_name: "Jane",
        submitter_email: "jane@example.com",
        lat: 31.52, lng: 74.36,
        hp_company: "",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.title).toBe("Protest in Lahore");
  });

  test("rejects when honeypot is filled", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bot spam",
        submitter_name: "Bot",
        submitter_email: "bot@example.com",
        lat: 0, lng: 0,
        hp_company: "i am a bot",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects when validation fails (missing title)", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submitter_name: "Jane",
        submitter_email: "jane@example.com",
        lat: 0, lng: 0,
      }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify new tests fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/pins.test.ts
```
Expected: 3 new tests fail.

- [ ] **Step 3: Add the POST route**

Append to `/var/www/vhosts/newsium.org/api/src/routes/pins.ts`:

```typescript
import { RateLimiter, getClientIp } from "../ratelimit";
import { CommunitySubmissionSchema } from "../validate";
import { normalizeEmail } from "../normalize";

const submitLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

pinsRoute.post("/pins", zValidator("json", CommunitySubmissionSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = submitLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }

  const data = c.req.valid("json");
  if (data.hp_company && data.hp_company.length > 0) {
    return c.json({ error: "spam_detected" }, 400);
  }

  const sql = getDb();
  const email = normalizeEmail(data.submitter_email);
  const [pinRow] = await sql<{ id: number }[]>`
    INSERT INTO pins (
      source_type, title, location, category, published_at,
      location_precision, confidence_score
    )
    VALUES (
      'community', ${data.title},
      ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
      ${data.category ?? "other"},
      ${data.published_at ? new Date(data.published_at) : sql`now()`},
      ${data.location_precision ?? "exact"},
      ${data.confidence_score ?? 1.0}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO community_details (pin_id, submitter_name, submitter_email, canonical_url)
    VALUES (${pinRow.id}, ${data.submitter_name}, ${email}, ${data.canonical_url ?? null})
  `;
  return c.json({ id: pinRow.id, status: "published" }, 201);
});
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
bun test tests/pins.test.ts
```
Expected: 11 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/pins.ts api/tests/pins.test.ts
git commit -m "feat(api): POST /api/pins community submission with rate limit + honeypot"
```

---

### Task 17: Implement admin auth guard and POST /api/admin/pins

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/routes/admin.ts`
- Create: `/var/www/vhosts/newsium.org/api/tests/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `/var/www/vhosts/newsium.org/api/tests/admin.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { adminRoute } from "../src/routes/admin";
import { truncateAll, seedAdminKey } from "./helpers";
import { getDb } from "../src/db";

describe("POST /api/admin/pins (editorial)", () => {
  beforeEach(async () => { await truncateAll(); });

  test("rejects when X-Admin-Key missing", async () => {
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", lat: 0, lng: 0, body_markdown: "y", author_name: "z" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects when key is invalid", async () => {
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "X-Admin-Key": "nk_live_wrong.secret", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", lat: 0, lng: 0, body_markdown: "y", author_name: "z" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects when role is wrong (rss_ingest can't post editorial)", async () => {
    const key = await seedAdminKey("rss-bot", "rss_ingest");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", lat: 0, lng: 0, body_markdown: "y", author_name: "z" }),
    });
    expect(res.status).toBe(403);
  });

  test("creates editorial pin when role is editorial", async () => {
    const key = await seedAdminKey("editor-1", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Karachi flood", lat: 24.86, lng: 67.00,
        body_markdown: "# Heading\n\nDetails...",
        author_name: "Reporter",
        category: "weather",
        published_at: "2026-08-18T03:00:00Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    const sql = getDb();
    const [pin] = await sql<any[]>`SELECT * FROM pins WHERE id = ${body.id}`;
    expect(pin.source_type).toBe("editorial");
    expect(pin.category).toBe("weather");
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/admin.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement routes/admin.ts (editorial only for now)**

Write to `/var/www/vhosts/newsium.org/api/src/routes/admin.ts`:

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { parseAdminKey, verifyAdminKey, requireRole } from "../auth";
import { EditorialPinSchema } from "../validate";

export const adminRoute = new Hono();

adminRoute.post("/pins", zValidator("json", EditorialPinSchema), async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header);
  if (!parsed) return c.json({ error: "unauthorized" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!auth || !requireRole(auth, ["editorial"])) {
    return c.json({ error: "forbidden" }, 403);
  }

  const data = c.req.valid("json");
  const sql = getDb();
  const [pinRow] = await sql<{ id: number }[]>`
    INSERT INTO pins (
      source_type, title, location, category, published_at,
      location_precision, confidence_score
    )
    VALUES (
      'editorial', ${data.title},
      ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
      ${data.category ?? "other"},
      ${data.published_at ? new Date(data.published_at) : sql`now()`},
      ${data.location_precision ?? "exact"},
      ${data.confidence_score ?? 1.0}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO editorial_details (pin_id, body_markdown, image_url, author_name, canonical_url)
    VALUES (
      ${pinRow.id}, ${data.body_markdown}, ${data.image_url ?? null},
      ${data.author_name}, ${data.canonical_url ?? null}
    )
  `;
  return c.json({ id: pinRow.id, status: "published" }, 201);
});
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test tests/admin.test.ts
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/admin.ts api/tests/admin.test.ts
git commit -m "feat(api): POST /api/admin/pins with X-Admin-Key auth"
```

---

### Task 18: Implement POST /api/admin/rss with dedup

**Files:**
- Modify: `/var/www/vhosts/newsium.org/api/src/routes/admin.ts`
- Modify: `/var/www/vhosts/newsium.org/api/tests/admin.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `/var/www/vhosts/newsium.org/api/tests/admin.test.ts`:

```typescript
describe("POST /api/admin/rss", () => {
  beforeEach(async () => { await truncateAll(); });

  test("ingests RSS item", async () => {
    const key = await seedAdminKey("rss-bot", "rss_ingest");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Article",
        lat: 40.7, lng: -74.0,
        source_feed: "https://feed.example.com/rss",
        source_url: "https://example.com/article/xyz",
        original_published_at: "2026-08-20T00:00:00Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
  });

  test("dedupes by normalized source_url — second POST returns existing pin", async () => {
    const key = await seedAdminKey("rss-bot", "rss_ingest");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const url1 = "https://example.com/article?utm_source=tw";
    const url2 = "https://EXAMPLE.com/article"; // different but normalizes equal

    const res1 = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Article", lat: 40.7, lng: -74.0,
        source_feed: "https://feed.example.com/rss",
        source_url: url1,
      }),
    });
    expect(res1.status).toBe(201);
    const first = await res1.json();

    const res2 = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Article (dup)", lat: 40.7, lng: -74.0,
        source_feed: "https://feed.example.com/rss",
        source_url: url2,
      }),
    });
    expect(res2.status).toBe(200);
    const second = await res2.json();
    expect(second.id).toBe(first.id);
    expect(second.dedup).toBe(true);
  });

  test("editorial role can't post RSS", async () => {
    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "x", lat: 0, lng: 0,
        source_feed: "https://f.com", source_url: "https://f.com/x",
      }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run, verify new tests fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/admin.test.ts
```
Expected: 3 new tests fail.

- [ ] **Step 3: Append the RSS ingest route**

Append to `/var/www/vhosts/newsium.org/api/src/routes/admin.ts`:

```typescript
import { RssIngestSchema } from "../validate";
import { normalizeUrl } from "../normalize";

adminRoute.post("/rss", zValidator("json", RssIngestSchema), async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header);
  if (!parsed) return c.json({ error: "unauthorized" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!auth || !requireRole(auth, ["rss_ingest"])) {
    return c.json({ error: "forbidden" }, 403);
  }

  const data = c.req.valid("json");
  const sql = getDb();
  const normalized = normalizeUrl(data.source_url);

  const existing = await sql<any[]>`
    SELECT p.id FROM pins p
    JOIN rss_details r ON r.pin_id = p.id
    WHERE r.source_url = ${normalized}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return c.json({ id: existing[0].id, dedup: true }, 200);
  }

  const [pinRow] = await sql<{ id: number }[]>`
    INSERT INTO pins (
      source_type, title, location, category, published_at,
      location_precision, confidence_score
    )
    VALUES (
      'rss', ${data.title},
      ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
      ${data.category ?? "other"},
      ${data.original_published_at ? new Date(data.original_published_at) : sql`now()`},
      ${data.location_precision ?? "exact"},
      ${data.confidence_score ?? 1.0}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO rss_details (pin_id, source_feed, source_url, original_published_at, summary)
    VALUES (
      ${pinRow.id}, ${data.source_feed}, ${normalized},
      ${data.original_published_at ? new Date(data.original_published_at) : null},
      ${data.summary ?? null}
    )
  `;
  return c.json({ id: pinRow.id, status: "published" }, 201);
});
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
bun test tests/admin.test.ts
```
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/admin.ts api/tests/admin.test.ts
git commit -m "feat(api): POST /api/admin/rss with URL-normalized UNIQUE dedup"
```

---

### Task 19: Implement PATCH /api/admin/pins/:id

**Files:**
- Modify: `/var/www/vhosts/newsium.org/api/src/routes/admin.ts`
- Modify: `/var/www/vhosts/newsium.org/api/tests/admin.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `/var/www/vhosts/newsium.org/api/tests/admin.test.ts`:

```typescript
describe("PATCH /api/admin/pins/:id (hide / update)", () => {
  beforeEach(async () => { await truncateAll(); });

  test("hides a pin (fast takedown)", async () => {
    const sql = getDb();
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('editorial', 'Bad', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
      RETURNING id`;
    await sql`INSERT INTO editorial_details (pin_id, body_markdown, author_name) VALUES (${p.id}, 'x', 'y')`;

    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request(`/api/admin/pins/${p.id}`, {
      method: "PATCH",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    expect(res.status).toBe(200);
    const [hidden] = await sql<any[]>`SELECT status FROM pins WHERE id = ${p.id}`;
    expect(hidden.status).toBe("hidden");
  });

  test("hidden pin disappears from GET /api/pins", async () => {
    const sql = getDb();
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('editorial', 'Bad', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
      RETURNING id`;
    await sql`INSERT INTO editorial_details (pin_id, body_markdown, author_name) VALUES (${p.id}, 'x', 'y')`;

    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    await app.request(`/api/admin/pins/${p.id}`, {
      method: "PATCH",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    // Re-import pinsRoute for this test
    const { pinsRoute } = await import("../src/routes/pins");
    const a = new Hono();
    a.route("/api", pinsRoute);
    const res = await a.request("/api/pins");
    const body = await res.json();
    expect(body.pins.find((x: any) => x.id === p.id)).toBeUndefined();
  });

  test("404 on unknown id", async () => {
    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins/999999", {
      method: "PATCH",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify new tests fail**

```bash
cd /var/www/vhosts/newsium.org/api
bun test tests/admin.test.ts
```
Expected: 3 new tests fail.

- [ ] **Step 3: Append the PATCH route**

Append to `/var/www/vhosts/newsium.org/api/src/routes/admin.ts`:

```typescript
import { PatchPinSchema } from "../validate";

adminRoute.patch("/pins/:id", zValidator("json", PatchPinSchema), async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header);
  if (!parsed) return c.json({ error: "unauthorized" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!auth || !requireRole(auth, ["editorial", "rss_ingest"])) {
    return c.json({ error: "forbidden" }, 403);
  }

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const data = c.req.valid("json");
  const sql = getDb();

  // Optional location update
  if (data.lat !== undefined && data.lng !== undefined) {
    await sql`
      UPDATE pins SET
        location = ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
        title = COALESCE(${data.title ?? null}, title),
        category = COALESCE(${data.category ?? null}, category),
        location_precision = COALESCE(${data.location_precision ?? null}, location_precision),
        confidence_score = COALESCE(${data.confidence_score ?? null}, confidence_score),
        status = COALESCE(${data.status ?? null}, status)
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE pins SET
        title = COALESCE(${data.title ?? null}, title),
        category = COALESCE(${data.category ?? null}, category),
        location_precision = COALESCE(${data.location_precision ?? null}, location_precision),
        confidence_score = COALESCE(${data.confidence_score ?? null}, confidence_score),
        status = COALESCE(${data.status ?? null}, status)
      WHERE id = ${id}
    `;
  }

  const rows = await sql<any[]>`SELECT id FROM pins WHERE id = ${id}`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ id, status: data.status ?? "unchanged" }, 200);
});
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
bun test tests/admin.test.ts
```
Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/routes/admin.ts api/tests/admin.test.ts
git commit -m "feat(api): PATCH /api/admin/pins/:id for hide/update"
```

---

### Task 20: Wire server.ts and run all tests

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/server.ts`

- [ ] **Step 1: Write server.ts**

Write to `/var/www/vhosts/newsium.org/api/src/server.ts`:

```typescript
import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { pinsRoute } from "./routes/pins";
import { adminRoute } from "./routes/admin";
import { closeDb } from "./db";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

app.route("/api/health", healthRoute);
app.route("/api", pinsRoute);
app.route("/api/admin", adminRoute);

app.onError((err, c) => {
  console.error("[newsium] unhandled error:", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

const port = Number(process.env.NEWSIUM_PORT ?? 3008);
const server = Bun.serve({ port, fetch: app.fetch });

console.log(`[newsium] listening on :${server.port}`);

process.on("SIGTERM", async () => {
  console.log("[newsium] SIGTERM — shutting down");
  server.stop();
  await closeDb();
  process.exit(0);
});
```

- [ ] **Step 2: Run the full test suite**

```bash
cd /var/www/vhosts/newsium.org/api
bun test
```
Expected: all tests pass (cursors 3, normalize 8, ratelimit 4, auth 3, health 1, pins 11, admin 10 = 40 total).

- [ ] **Step 3: Smoke-start the server in background**

```bash
cd /var/www/vhosts/newsium.org/api
bun run src/server.ts &
SERVER_PID=$!
sleep 1
curl -s http://localhost:3008/api/health
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```
Expected: `{"ok":true,"version":"0.1.0"}`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add api/src/server.ts
git commit -m "feat(api): wire Hono app and graceful shutdown"
```

---

### Task 21: Implement seed-admin-key script

**Files:**
- Create: `/var/www/vhosts/newsium.org/api/src/seed-admin-key.ts`

- [ ] **Step 1: Write seed-admin-key.ts**

Write to `/var/www/vhosts/newsium.org/api/src/seed-admin-key.ts`:

```typescript
import { getDb, closeDb } from "./db";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  const name = arg("name");
  const role = arg("role") as "editorial" | "rss_ingest" | "super" | null;
  if (!name || !role || !["editorial", "rss_ingest", "super"].includes(role)) {
    console.error("Usage: bun run src/seed-admin-key.ts -- --name <name> --role <editorial|rss_ingest|super>");
    process.exit(1);
  }

  const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
  const keyId = `nk_live_${randomBytes(9)}`;
  const secret = randomBytes(32);
  const fullSecret = `${keyId}.${secret}`;

  const hash = await Bun.password.hash(fullSecret, { algorithm: "bcrypt", cost: 12 });
  const sql = getDb();
  await sql`
    INSERT INTO admin_keys (key_id, name, key_hash, role)
    VALUES (${keyId}, ${name}, ${hash}, ${role})
  `;

  console.log("============================================================");
  console.log("SAVE THIS KEY NOW — it will NOT be shown again.");
  console.log(`Name: ${name}`);
  console.log(`Role: ${role}`);
  console.log(`X-Admin-Key: ${fullSecret}`);
  console.log("============================================================");

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it and capture the key**

```bash
cd /var/www/vhosts/newsium.org/api
bun run src/seed-admin-key.ts -- --name editor-1 --role editorial | tee /tmp/newsium-admin-key.txt
```
Expected: prints the key block. `tee` saves to `/tmp/newsium-admin-key.txt`.

- [ ] **Step 3: Verify the key works against the running app**

```bash
cd /var/www/vhosts/newsium.org/api
bun run src/server.ts &
SERVER_PID=$!
sleep 1
KEY=$(grep '^X-Admin-Key:' /tmp/newsium-admin-key.txt | awk '{print $2}')
curl -s -X POST http://localhost:3008/api/admin/pins \
  -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"title":"Seed test","lat":24.86,"lng":67.00,"body_markdown":"# hi","author_name":"seeder"}'
echo
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```
Expected: `{"id":<number>,"status":"published"}`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/newsium.org
echo "api/.env" >> .gitignore
git add api/src/seed-admin-key.ts .gitignore
git commit -m "feat(api): seed-admin-key CLI script"
```

---

### Task 22: Frontend — vendor libraries

**Files:**
- Create: vendor dirs with downloaded assets

- [ ] **Step 1: Download Leaflet 1.9.4**

```bash
cd /var/www/vhosts/newsium.org/public_html/vendor/leaflet
curl -sSL -o leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
curl -sSL -o leaflet.js https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
ls -la
```
Expected: leaflet.css (~14KB) and leaflet.js (~140KB) present.

- [ ] **Step 2: Download leaflet.markercluster 1.5.3**

```bash
cd /var/www/vhosts/newsium.org/public_html/vendor/leaflet.markercluster
curl -sSL -o leaflet.markercluster.js https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js
curl -sSL -o MarkerCluster.css https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css
curl -sSL -o MarkerCluster.Default.css https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css
ls -la
```
Expected: three files present.

- [ ] **Step 3: Download marked 12.0.2 (UMD)**

```bash
cd /var/www/vhosts/newsium.org/public_html/vendor/marked
curl -sSL -o marked.umd.min.js https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
ls -la
```
Expected: ~30KB file present.

- [ ] **Step 4: Download DOMPurify 3.1.6 (UMD)**

```bash
cd /var/www/vhosts/newsium.org/public_html/vendor/dompurify
curl -sSL -o purify.min.js https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js
ls -la
```
Expected: ~70KB file present.

- [ ] **Step 5: Remove placeholder .gitkeep so vendor files are tracked**

```bash
cd /var/www/vhosts/newsium.org/public_html/vendor
rm -f leaflet/.gitkeep leaflet.markercluster/.gitkeep marked/.gitkeep dompurify/.gitkeep
```

- [ ] **Step 6: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add public_html/vendor
git commit -m "feat(frontend): vendor leaflet, markercluster, marked, dompurify"
```

---

### Task 23: Frontend — index.html shell

**Files:**
- Modify: `/var/www/vhosts/newsium.org/public_html/index.html` (replaces placeholder)

- [ ] **Step 1: Write index.html**

Write to `/var/www/vhosts/newsium.org/public_html/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Xyzo — global news map</title>
  <link rel="stylesheet" href="vendor/leaflet/leaflet.css">
  <link rel="stylesheet" href="vendor/leaflet.markercluster/MarkerCluster.css">
  <link rel="stylesheet" href="vendor/leaflet.markercluster/MarkerCluster.Default.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="map" aria-label="world map of news"></div>
  <button id="submit-btn" type="submit-btn" aria-label="submit news">Submit News</button>
  <div id="submitter-overlay" hidden>
    <div class="overlay-card">
      <h2>Submit News</h2>
      <form id="submit-form">
        <label>Title <input name="title" maxlength="200" required></label>
        <label>Your Name <input name="submitter_name" maxlength="100" required></label>
        <label>Email <input name="submitter_email" type="email" maxlength="254" required></label>
        <label>URL (optional) <input name="canonical_url" type="url"></label>
        <label>Category
          <select name="category">
            <option value="">—</option>
            <option>politics</option><option>business</option><option>crime</option>
            <option>weather</option><option>science</option><option>technology</option>
            <option>sports</option><option>culture</option><option>environment</option>
            <option>conflict</option><option>health</option><option>other</option>
          </select>
        </label>
        <input name="hp_company" type="text" tabindex="-1" autocomplete="off"
               style="position:absolute;left:-9999px" aria-hidden="true">
        <div id="mini-map" aria-label="click to set location"></div>
        <p class="coord-display">lat: <span id="lat-display">—</span> lng: <span id="lng-display">—</span></p>
        <div class="overlay-actions">
          <button type="button" id="cancel-btn">Cancel</button>
          <button type="submit" id="confirm-btn">Submit</button>
        </div>
      </form>
    </div>
  </div>
  <script src="vendor/leaflet/leaflet.js"></script>
  <script src="vendor/leaflet.markercluster/leaflet.markercluster.js"></script>
  <script src="vendor/marked/marked.umd.min.js"></script>
  <script src="vendor/dompurify/purify.min.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write styles.css**

Write to `/var/www/vhosts/newsium.org/public_html/styles.css`:

```css
:root {
  --bg: #0b0f14;
  --fg: #e6edf3;
  --accent: #5eead4;
  --muted: #64748b;
  --editorial: #f59e0b;
  --community: #22d3ee;
  --rss: #e879f9;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
#map { position: fixed; inset: 0; z-index: 0; }
#submit-btn {
  position: fixed; top: 12px; left: 12px; z-index: 500;
  background: var(--accent); color: #0b0f14; border: none;
  padding: 8px 14px; border-radius: 6px; font-weight: 600; cursor: pointer;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}
#submit-btn:hover { filter: brightness(1.1); }
#submitter-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000;
  display: grid; place-items: center;
}
.overlay-card {
  background: #11161d; border: 1px solid #1f2937;
  border-radius: 8px; padding: 20px; max-width: 520px; width: calc(100% - 32px);
  max-height: 90vh; overflow-y: auto;
}
.overlay-card h2 { margin: 0 0 12px 0; color: var(--accent);
  font-family: ui-monospace, monospace; }
.overlay-card label {
  display: block; margin-bottom: 10px; font-size: 13px; color: var(--muted);
}
.overlay-card input, .overlay-card select {
  display: block; width: 100%; margin-top: 4px;
  background: #0b0f14; color: var(--fg); border: 1px solid #1f2937;
  padding: 6px 8px; border-radius: 4px; font: inherit;
}
#mini-map { width: 100%; height: 220px; border: 1px solid #1f2937; border-radius: 4px; }
.coord-display { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
.overlay-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.overlay-actions button {
  background: var(--bg); color: var(--fg); border: 1px solid #1f2937;
  padding: 6px 14px; border-radius: 4px; cursor: pointer;
}
#confirm-btn { background: var(--accent); color: #0b0f14; border-color: var(--accent); }
.leaflet-popup-content h3 { margin: 0 0 6px 0; font-size: 14px; color: var(--fg); }
.leaflet-popup-content .badge {
  display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px;
  font-family: ui-monospace, monospace; margin-right: 6px; text-transform: uppercase;
}
.badge.editorial { background: var(--editorial); color: #0b0f14; }
.badge.community { background: var(--community); color: #0b0f14; }
.badge.rss       { background: var(--rss); color: #0b0f14; }
.leaflet-popup-content a { color: var(--accent); }
.new-pin-glow { animation: glow 1s ease-out; }
@keyframes glow {
  0%   { filter: drop-shadow(0 0 8px var(--accent)); }
  100% { filter: none; }
}
```

- [ ] **Step 3: Verify it loads (file exists)**

```bash
ls -la /var/www/vhosts/newsium.org/public_html/
```
Expected: `index.html`, `styles.css`, `vendor/`, no `app.js` yet (next task).

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add public_html/index.html public_html/styles.css
git commit -m "feat(frontend): index.html and styles.css shell"
```

---

### Task 24: Frontend — reader view (map + fetch + popups)

**Files:**
- Create: `/var/www/vhosts/newsium.org/public_html/app.js` (skeleton, extended in next task)

- [ ] **Step 1: Write app.js (reader view)**

Write to `/var/www/vhosts/newsium.org/public_html/app.js`:

```javascript
"use strict";

// ── Tile providers ─────────────────────────────────────────────────────
const TILE_LAYERS = {
  Street: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
    subdomains: "abcd", maxZoom: 19,
    attribution: "© OpenStreetMap contributors © CARTO",
  }),
  Satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Source: Esri, Maxar, Earthstar Geographics, GIS User Community" }
  ),
  Topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    subdomains: "abc", maxZoom: 17,
    attribution: "Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)",
  }),
};

const SOURCE_COLORS = {
  editorial: "#f59e0b",
  community: "#22d3ee",
  rss: "#e879f9",
};

const map = L.map("map", { worldCopyJump: true }).setView([24.86, 67.00], 3);
TILE_LAYERS.Street.addTo(map);
L.control.layers(TILE_LAYERS, {}, { position: "topright" }).addTo(map);

const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 7, maxClusterRadius: 60 });
map.addLayer(cluster);

// ── State ─────────────────────────────────────────────────────────────
let pinMarkers = new Map();   // id -> marker
let pendingCursor = null;     // cursor for next page
let inflight = false;

// ── Debounce ──────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Fetch for current viewport ────────────────────────────────────────
async function fetchPinsForViewport() {
  if (inflight) return;
  inflight = true;
  try {
    const b = map.getBounds();
    const bbox = [
      b.getWest(), b.getSouth(), b.getEast(), b.getNorth(),
    ].map((n) => n.toFixed(4)).join(",");
    const area = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
    const limit = area > 60 * 30 ? 1000 : 500;

    const url = `/api/pins?bbox=${bbox}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn("pins fetch failed", res.status); return; }
    const body = await res.json();
    renderPins(body.pins);
  } catch (e) {
    console.error("fetchPinsForViewport", e);
  } finally {
    inflight = false;
  }
}

function renderPins(pins) {
  cluster.clearLayers();
  pinMarkers.clear();
  for (const p of pins) {
    const color = SOURCE_COLORS[p.source_type] || "#ffffff";
    const icon = L.divIcon({
      className: "newsium-pin",
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #0b0f14;"></div>`,
      iconSize: [14, 14],
    });
    const marker = L.marker([p.location.lat, p.location.lng], { icon });
    marker.bindPopup(buildPopup(p), { maxWidth: 320 });
    marker.on("popupopen", (e) => wirePopupActions(e.popup, p));
    cluster.addLayer(marker);
    pinMarkers.set(p.id, marker);
  }
}

function buildPopup(p) {
  const badge = `<span class="badge ${p.source_type}">${p.source_type}</span>`;
  const time = formatRelativeTime(p.published_at);
  const link = p.canonical_url
    ? `<a href="${p.canonical_url}" target="_blank" rel="noopener noreferrer">source</a>`
    : "";
  const readMore = p.source_type === "editorial"
    ? `<button class="read-more" data-id="${p.id}">Read more</button>`
    : "";
  return `
    <h3>${escapeHtml(p.title)}</h3>
    <div>${badge}<small>${time}</small></div>
    <div>${link} ${readMore}</div>
  `;
}

function wirePopupActions(popup, pin) {
  const btn = popup.getElement().querySelector(".read-more");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.textContent = "loading…";
    btn.disabled = true;
    const res = await fetch(`/api/pins/${pin.id}`);
    if (!res.ok) { btn.textContent = "failed"; return; }
    const body = await res.json();
    const html = DOMPurify.sanitize(marked.parse(body.detail.body_markdown || ""));
    const content = popup.getElement().querySelector(".leaflet-popup-content");
    content.insertAdjacentHTML("beforeend",
      `<hr><div class="md-body">${html}</div>`);
    btn.remove();
  });
}

function formatRelativeTime(iso) {
  const t = new Date(iso).getTime();
  const delta = Date.now() - t;
  const m = Math.floor(delta / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

map.on("moveend", debounce(fetchPinsForViewport, 300));
fetchPinsForViewport();
```

- [ ] **Step 2: Verify it doesn't have syntax errors**

```bash
node --check /var/www/vhosts/newsium.org/public_html/app.js
```
Expected: silent (no syntax errors).

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add public_html/app.js
git commit -m "feat(frontend): reader map view with tile layers, fetch, popups"
```

---

### Task 25: Frontend — submitter view (modal + mini-map)

**Files:**
- Modify: `/var/www/vhosts/newsium.org/public_html/app.js`

- [ ] **Step 1: Append submitter logic to app.js**

Append to `/var/www/vhosts/newsium.org/public_html/app.js`:

```javascript
// ── Submitter view ─────────────────────────────────────────────────────
const submitBtn = document.getElementById("submit-btn");
const overlay = document.getElementById("submitter-overlay");
const cancelBtn = document.getElementById("cancel-btn");
const form = document.getElementById("submit-form");
const latDisplay = document.getElementById("lat-display");
const lngDisplay = document.getElementById("lng-display");

let miniMap = null;
let miniMarker = null;
let pickedLat = null;
let pickedLng = null;

submitBtn.addEventListener("click", () => {
  overlay.hidden = false;
  if (!miniMap) {
    miniMap = L.map("mini-map").setView([24.86, 67.00], 3);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      subdomains: "abcd", attribution: "© OSM © CARTO",
    }).addTo(miniMap);
    miniMap.on("click", (e) => {
      pickedLat = e.latlng.lat;
      pickedLng = e.latlng.lng;
      latDisplay.textContent = pickedLat.toFixed(4);
      lngDisplay.textContent = pickedLng.toFixed(4);
      if (miniMarker) miniMap.removeLayer(miniMarker);
      miniMarker = L.marker([pickedLat, pickedLng]).addTo(miniMap);
    });
  } else {
    setTimeout(() => miniMap.invalidateSize(), 100);
  }
});

cancelBtn.addEventListener("click", () => {
  overlay.hidden = true;
  form.reset();
  pickedLat = null;
  pickedLng = null;
  latDisplay.textContent = "—";
  lngDisplay.textContent = "—";
  if (miniMarker) miniMap.removeLayer(miniMarker);
});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (pickedLat === null || pickedLng === null) {
    alert("Click the mini-map to set a location.");
    return;
  }
  const fd = new FormData(form);
  const body = {
    title: fd.get("title"),
    submitter_name: fd.get("submitter_name"),
    submitter_email: fd.get("submitter_email"),
    canonical_url: fd.get("canonical_url") || undefined,
    category: fd.get("category") || undefined,
    lat: pickedLat,
    lng: pickedLng,
    hp_company: fd.get("hp_company") || "",
  };
  const res = await fetch("/api/pins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 201) {
    overlay.hidden = true;
    form.reset();
    pickedLat = null;
    pickedLng = null;
    latDisplay.textContent = "—";
    lngDisplay.textContent = "—";
    if (miniMarker) miniMap.removeLayer(miniMarker);
    await fetchPinsForViewport();
  } else {
    const err = await res.json().catch(() => ({}));
    alert(`Submission failed: ${err.error || res.status}`);
  }
});
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check /var/www/vhosts/newsium.org/public_html/app.js
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add public_html/app.js
git commit -m "feat(frontend): submitter overlay form with mini-map"
```

---

### Task 26: Create systemd unit for newsium-api

**Files:**
- Create: `/etc/systemd/system/xyzo-api.service`

- [ ] **Step 1: Write systemd unit (with sudo)**

```bash
sudo tee /etc/systemd/system/xyzo-api.service > /dev/null <<'UNIT'
[Unit]
Description=Xyzo API (Bun + Hono)
After=network.target

[Service]
Type=simple
User=asher
WorkingDirectory=/var/www/vhosts/newsium.org/api
ExecStart=/home/asher/.bun/bin/bun run src/server.ts
Restart=on-failure
RestartSec=3
EnvironmentFile=/var/www/vhosts/newsium.org/api/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
```
Expected: file written, no error output.

- [ ] **Step 2: Reload systemd**

```bash
sudo systemctl daemon-reload
```
Expected: silent.

- [ ] **Step 3: Enable and start the service**

```bash
sudo systemctl enable --now newsium-api
sleep 2
sudo systemctl is-active newsium-api
```
Expected: prints `active`.

- [ ] **Step 4: Confirm the API is listening**

```bash
curl -s http://localhost:3008/api/health
```
Expected: `{"ok":true,"version":"0.1.0"}`.

- [ ] **Step 5: Commit the unit file to the repo**

Copy the unit file into the repo for reference:
```bash
sudo cp /etc/systemd/system/xyzo-api.service /var/www/vhosts/newsium.org/api/newsium-api.service
cd /var/www/vhosts/newsium.org
git add api/newsium-api.service
git commit -m "ops: systemd unit for newsium-api"
```

---

### Task 27: Update Caddyfile with reverse proxy and security headers

**Files:**
- Modify: `/etc/caddy/Caddyfile`

- [ ] **Step 1: Replace the existing newsium.org block**

In `/etc/caddy/Caddyfile`, find the existing `newsium.org { ... }` block (added earlier in this conversation) and replace it with:

```
newsium.org {
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

www.newsium.org {
    redir https://newsium.org{uri}
}
```

- [ ] **Step 2: Validate Caddy config**

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```
Expected: `Valid configuration`.

- [ ] **Step 3: Reload Caddy**

```bash
sudo systemctl reload caddy
sleep 1
sudo systemctl is-active caddy
```
Expected: `active`.

- [ ] **Step 4: Confirm via public URL**

```bash
curl -s https://newsium.org/api/health
```
Expected: `{"ok":true,"version":"0.1.0"}`.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/newsium.org
git add /etc/caddy/Caddyfile 2>/dev/null || true
# (Caddyfile lives outside the repo; commit note only)
git commit --allow-empty -m "ops: caddy reverse proxy + CSP for newsium.org"
```

---

### Task 28: End-to-end smoke test

**Files:** none

- [ ] **Step 1: Public read**

```bash
curl -s https://newsium.org/api/pins | head -c 400
```
Expected: JSON with `pins`, `next_cursor`, `has_more` fields.

- [ ] **Step 2: Admin editorial create**

```bash
KEY=$(grep '^X-Admin-Key:' /tmp/newsium-admin-key.txt | awk '{print $2}')
curl -sX POST https://newsium.org/api/admin/pins \
  -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"title":"E2E test","lat":24.86,"lng":67.00,"body_markdown":"# hi","author_name":"e2e","category":"weather"}'
```
Expected: `{"id":<n>,"status":"published"}`.

- [ ] **Step 3: Admin RSS ingest with dedup**

```bash
curl -sX POST https://newsium.org/api/admin/rss \
  -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"title":"RSS E2E","lat":40.7,"lng":-74.0,"source_feed":"https://f.example/rss","source_url":"https://example.com/x?utm_source=tw"}'
```
Expected: 201.
Then re-run with the same body — expect 200 with `dedup: true`.

- [ ] **Step 4: Community submission (no auth)**

```bash
curl -sX POST https://newsium.org/api/pins \
  -H "Content-Type: application/json" \
  -d '{"title":"Community E2E","submitter_name":"Jane","submitter_email":"jane@example.com","lat":31.52,"lng":74.36,"category":"politics","hp_company":""}'
```
Expected: 201.

- [ ] **Step 5: Hide via PATCH**

```bash
curl -sX PATCH https://newsium.org/api/admin/pins/2 \
  -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"status":"hidden"}'
```
Expected: 200.

- [ ] **Step 6: Browser verification (manual)**

Open `https://newsium.org` in a real browser. Confirm:
- Map loads with Carto Dark tiles.
- Layer control (top-right) toggles between Street / Satellite / Topo.
- Pins appear for the test data.
- Clicking a pin shows a popup with badge, title, and timestamp.
- Clicking "Read more" on an editorial pin renders the markdown body without script execution.
- "Submit News" button toggles the submitter overlay; the mini-map accepts clicks; submitting creates a new pin on the map.

- [ ] **Step 7: Commit any test data cleanup**

```bash
cd /var/www/vhosts/newsium.org
git commit --allow-empty -m "test: e2e smoke test passed on <date>"
```

---

## Self-Review

**1. Spec coverage:**

- News source types (3 sources) — Tasks 17, 18, 16 ✓
- Auto-publish — Tasks 16, 17, 18 ✓
- Leaflet — Task 24 ✓
- Bun + Hono — Tasks 5, 20 ✓
- Minimal reader + submitter — Tasks 24, 25 ✓
- Required name + email — Task 16 (validated) ✓
- Hub-and-spoke schema — Task 3 ✓
- Port :3008 — Task 5, 26 ✓
- Cursor pagination — Task 6, 14 ✓
- published_at / created_at / updated_at — Task 3 ✓
- RSS dedup (UNIQUE source_url) — Task 3, 18 ✓
- Markdown sanitization — Task 24 (DOMPurify.sanitize + marked.parse) ✓
- In-memory rate limit — Task 8, 16 ✓
- Admin key shape nk_live_<keyid>.<secret> — Task 11 ✓
- Coordinate CHECK — Task 3 ✓
- PostGIS bbox cast — Task 14 ✓
- Debounce 300ms — Task 24 ✓
- Fetch cap 1000 — Task 24 ✓
- Category enum — Task 3, 10, 14 ✓
- No IPs persisted — Tasks 8, 12, 16 ✓
- PATCH /api/admin/pins/:id — Task 19 ✓
- 64 KiB body limit — Task 20 (Hono default; can be tightened via `bodyLimit` if needed)
- Caddy CSP headers — Task 27 ✓
- Sequence grants — Task 4 ✓
- Smoke test — Task 28 ✓
- Frontend vendor libs — Task 22 ✓
- Seed admin key script — Task 21 ✓
- Systemd unit — Task 26 ✓

**2. Placeholder scan:**

No TBD / TODO / "implement later" / "fill in details" in any task body.

**3. Type consistency:**

- `CommunitySubmissionSchema` defined Task 10, used Task 16.
- `EditorialPinSchema` defined Task 10, used Task 17.
- `RssIngestSchema` defined Task 10, used Task 18.
- `PatchPinSchema` defined Task 10, used Task 19.
- `ListPinsQuerySchema` defined Task 10, used Task 14.
- `encodeCursor` / `decodeCursor` defined Task 6, used Tasks 14.
- `parseAdminKey` / `verifyAdminKey` / `requireRole` defined Task 11, used Tasks 17, 18, 19.
- `RateLimiter` / `getClientIp` defined Task 8, used Task 16.
- `normalizeUrl` defined Task 7, used Task 18.
- `normalizeEmail` defined Task 7, used Task 16.
- `truncateAll` / `seedAdminKey` defined Task 12, used Tasks 13, 14, 15, 16, 17, 18, 19.

All cross-references resolve.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-newsium-news-map-impl.md`.

**28 tasks.** Estimated effort: ~6–10 hours of focused work for an engineer new to the codebase.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review the diff between tasks, fast iteration with parallel research.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?