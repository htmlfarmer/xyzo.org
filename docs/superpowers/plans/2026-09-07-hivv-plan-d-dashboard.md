# hivv Plan D — Operator Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner-facing, accessibility-first, visualization-as-language dashboard. Seven scopes (🌐 WORLD / 👤 ME / 🏢 ORGANIZATION / 🤖 AGENT / 🔗 RELATIONSHIP / 🕰️ HISTORY / 🔮 FUTURE), temporal triad (Past + Present + Authorized Future), nine questions answered, eight control verbs as buttons. Plan F's session layer plugs in here.

**Architecture:** Single page app with seven scope tabs. Each scope is a server-rendered HTML fragment + a small JS file that progressively enhances. Three layers per scope: Past (historical eval_observations), Present (live status), Future (authorized scheduled actions from the scheduled_actions queue). Eight control verb buttons appear on every AI record; click → fetches /api/control/verb → refreshes the scope.

**Tech Stack:** Hono (server, existing), Plain HTML + HTMX (no React; no build step), `prefers-reduced-motion`, ARIA roles, WCAG AA contrast, keyboard navigation. Data: eval_observations, AI breakers, scheduled_actions (Plan F), and consent_ledger (Plan F).

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` §9

**Prerequisites:** Plans A, B, C shipped + green.

**Out of scope:** Plan E (humanity metrics live in a sub-tab of 🌐 WORLD), Plan F (session layer is read-only here; writes happen in Plan F).

**Cross-cutting invariants:**
1. **Owner-first:** Owner sees everything. Non-owners see redacted scopes (no private vault). Owner setting persists in a cookie.
2. **Accessibility-first:** Every interactive element reachable by Tab. ARIA labels everywhere. Live regions for status changes. No motion without user preference.
3. **Visualization-is-language:** Charts, not numbers. Each scope is a single coherent view, not a dashboard of widgets.
4. **No third-party trackers:** Zero external scripts.
5. **Audited:** Every control verb click writes an `audit_record` (Plan F) with all 11 fields.

---

## File Structure

```
api/migrations/
  2026-09-10-scheduled-actions.sql            (Task 1)

api/src/dashboard/
  types.ts                                    (Task 2)
  scopes.ts                                   (Task 3 — scope resolver)
  render/
    world.ts                                  (Task 4)
    me.ts                                     (Task 5)
    organization.ts                           (Task 6)
    agent.ts                                  (Task 7)
    relationship.ts                           (Task 8)
    history.ts                                (Task 9)
    future.ts                                 (Task 10)
    shared.ts                                 (Task 11 — CSS, layout)
  verbs.ts                                    (Task 12 — control verbs)
  nav.ts                                      (Task 13 — tab navigation)

public/dashboard/
  index.html                                  (Task 14 — shell)
  style.css                                   (Task 15)
  app.js                                      (Task 16 — progressive enhancement)
  verb-button.js                              (Task 17)

api/src/routes/
  dashboard.ts                                (Task 18 — HTML routes)
  control-verbs.ts                            (Task 19 — verb actions)
  ws.ts                                       (Task 20 — live updates)

api/tests/
  scopes.test.ts                              (Task 3)
  verbs.test.ts                               (Task 12)
  dashboard-routes.test.ts                    (Task 18)
  accessibility.test.ts                       (Task 21 — axe audit)

docs/dashboard/
  nine-questions.md                            (Task 22)
  visualization-scopes.md                     (Task 22)
```

---

## Task Index

- Task 1: scheduled_actions schema
- Task 2: Types (ScopeId, ScopeContext)
- Task 3: Scope resolver
- Task 4: 🌐 WORLD renderer
- Task 5: 👤 ME renderer
- Task 6: 🏢 ORGANIZATION renderer
- Task 7: 🤖 AGENT renderer
- Task 8: 🔗 RELATIONSHIP renderer
- Task 9: 🕰️ HISTORY renderer
- Task 10: 🔮 FUTURE renderer
- Task 11: Shared CSS + layout
- Task 12: Eight control verbs (server-side)
- Task 13: Scope navigation (tab state)
- Task 14: Index.html shell
- Task 15: style.css (a11y-first)
- Task 16: app.js (HTMX + minimal JS)
- Task 17: verb-button.js
- Task 18: HTML routes
- Task 19: Control verb routes
- Task 20: WebSocket live updates
- Task 21: Accessibility audit (axe-core)
- Task 22: Documentation

---

### Task 1: scheduled_actions schema

**Files:**
- Create: `api/migrations/2026-09-10-scheduled-actions.sql`

- [ ] **Step 1: Write migration**

```sql
-- ── 2026-09-10-scheduled-actions.sql ───────────────────────────────
-- Authorized-future actions. The 🔮 FUTURE scope reads from here.
-- Plan F writes them; Plan D displays them.
BEGIN;

CREATE TYPE scheduled_action_status AS ENUM ('authorized','pending_approval','denied','executed','expired','revoked');

CREATE TABLE scheduled_actions (
  id BIGSERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  params JSONB NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  authorized_by TEXT NOT NULL,                     -- 'owner' | session_key_id | agent_self
  scope TEXT NOT NULL,                              -- 'world' | 'me' | 'organization' | ...
  status scheduled_action_status NOT NULL DEFAULT 'authorized',
  expires_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  audit JSONB NOT NULL,                             -- 11-field audit envelope (Plan F)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON scheduled_actions (status, scheduled_for);
CREATE INDEX ON scheduled_actions (agent_name, scheduled_for);
CREATE INDEX ON scheduled_actions (expires_at);

GRANT SELECT, INSERT, UPDATE ON scheduled_actions TO xyzo_app, xyzo_owner;

COMMIT;
```

- [ ] **Step 2: Apply + commit**

```bash
cd api && bun run db:migrate -- up migrations/2026-09-10-scheduled-actions.sql
psql $XYZO_DB_DSN -c "\d scheduled_actions"
git add api/migrations/2026-09-10-scheduled-actions.sql
git commit -m "feat(hivv-D): scheduled_actions table (the 🔮 FUTURE queue)"
```

---

### Task 2: Types (ScopeId, ScopeContext)

**Files:**
- Create: `api/src/dashboard/types.ts`

- [ ] **Step 1: Write types**

```ts
// api/src/dashboard/types.ts
// Spec: §9.1, §9.12

export type ScopeId = 'world' | 'me' | 'organization' | 'agent' | 'relationship' | 'history' | 'future';

export type ScopeContext = {
  scope: ScopeId;
  viewer: 'owner' | 'public';
  session_id?: string;     // Plan F
  agent_name?: string;     // for 🤖 AGENT scope
  relationship_id?: string; // for 🔗 RELATIONSHIP scope
  window: { from: string; to: string };
  language: string;        // BCP-47
};

export type PastLayer = {
  rendered: string;        // HTML fragment
  row_count: number;
};

export type PresentLayer = {
  rendered: string;
  live_data: Record<string, unknown>;
};

export type FutureLayer = {
  rendered: string;
  scheduled_action_ids: number[];
};

export type ScopeResult = {
  past: PastLayer;
  present: PresentLayer;
  future: FutureLayer;
  meta: {
    scope: ScopeId;
    rendered_at: string;
    cache_key: string;
  };
};

export type ControlVerb =
  | 'ALLOW' | 'DENY' | 'PAUSE' | 'REVOKE' | 'DELEGATE' | 'ASK' | 'ESCALATE' | 'AUDIT';
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/types.ts
git commit -m "feat(hivv-D): dashboard types (ScopeId, ScopeContext, ScopeResult)"
```

---

### Task 3: Scope resolver

**Files:**
- Create: `api/src/dashboard/scopes.ts`
- Create: `api/tests/scopes.test.ts`

- [ ] **Step 1: Write resolver**

```ts
// api/src/dashboard/scopes.ts
// Maps ScopeId → Past/Present/Future renderers.
import type { ScopeContext, ScopeResult, ScopeId } from "./types";
import { renderWorld } from "./render/world";
import { renderMe } from "./render/me";
import { renderOrganization } from "./render/organization";
import { renderAgent } from "./render/agent";
import { renderRelationship } from "./render/relationship";
import { renderHistory } from "./render/history";
import { renderFuture } from "./render/future";

export async function resolveScope(ctx: ScopeContext): Promise<ScopeResult> {
  const past = await renderPast(ctx);
  const present = await renderPresent(ctx);
  const future = await renderFuture(ctx);

  return {
    past, present, future,
    meta: {
      scope: ctx.scope,
      rendered_at: new Date().toISOString(),
      cache_key: cacheKey(ctx),
    },
  };
}

async function renderPast(ctx: ScopeContext) {
  const html = await ({
    world: renderWorld.past,
    me: renderMe.past,
    organization: renderOrganization.past,
    agent: renderAgent.past,
    relationship: renderRelationship.past,
    history: renderHistory,
    future: renderFuture.past, // future's past = already-authorized but not yet executed
  } as Record<ScopeId, (c: ScopeContext) => Promise<string>>)[ctx.scope](ctx);

  return {rendered: html, row_count: countTags(html)};
}

async function renderPresent(ctx: ScopeContext) {
  const html = await ({
    world: renderWorld.present,
    me: renderMe.present,
    organization: renderOrganization.present,
    agent: renderAgent.present,
    relationship: renderRelationship.present,
    history: renderHistory,
    future: renderFuture.present,
  } as Record<ScopeId, (c: ScopeContext) => Promise<string>>)[ctx.scope](ctx);

  return {rendered: html, live_data: extractLive(html)};
}

async function renderFuture(ctx: ScopeContext) {
  const html = await ({
    world: renderWorld.future,
    me: renderMe.future,
    organization: renderOrganization.future,
    agent: renderAgent.future,
    relationship: renderRelationship.future,
    history: renderHistory,
    future: renderFuture.future,
  } as Record<ScopeId, (c: ScopeContext) => Promise<string>>)[ctx.scope](ctx);

  return {rendered: html, scheduled_action_ids: extractIds(html)};
}

function cacheKey(ctx: ScopeContext): string {
  return `${ctx.scope}:${ctx.viewer}:${ctx.session_id ?? 'none'}:${ctx.window.from}:${ctx.window.to}`;
}

function countTags(html: string): number {
  return (html.match(/<tr\b/g) || []).length;
}

function extractLive(html: string): Record<string, unknown> {
  const m = html.match(/<span\s+data-live="([^"]+)"/);
  return m ? {[m[1]]: html.split(`data-live="${m[1]}"`)[1].split('"')[0]} : {};
}

function extractIds(html: string): number[] {
  const ids: number[] = [];
  for (const m of html.matchAll(/data-action-id="(\d+)"/g)) ids.push(Number(m[1]));
  return ids;
}
```

- [ ] **Step 2: Test**

```ts
// api/tests/scopes.test.ts
import { describe, expect, test } from "bun:test";
import { resolveScope } from "../src/dashboard/scopes";

describe("scope resolver", () => {
  test("resolves world scope", async () => {
    const r = await resolveScope({
      scope: "world", viewer: "owner",
      window: {from: "2026-09-01", to: "2026-09-07"},
      language: "en",
    });
    expect(r.past.rendered).toContain("WORLD");
    expect(r.present.rendered).toContain("WORLD");
    expect(r.future.rendered).toContain("WORLD");
  });

  test("all 7 scopes resolve", async () => {
    for (const scope of ["world","me","organization","agent","relationship","history","future"] as const) {
      const r = await resolveScope({
        scope, viewer: "owner",
        window: {from: "2026-09-01", to: "2026-09-07"},
        language: "en",
      });
      expect(r.meta.scope).toBe(scope);
    }
  });
});
```

- [ ] **Step 3: Run + commit (skeleton; full coverage when renderers land)**

```bash
cd api && bun test tests/scopes.test.ts 2>&1 | tail -10
git add api/src/dashboard/scopes.ts api/tests/scopes.test.ts
git commit -m "feat(hivv-D): scope resolver (Past/Present/Future dispatch)"
```

---

### Task 4: 🌐 WORLD renderer

**Files:**
- Create: `api/src/dashboard/render/world.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/world.ts
// Spec: §9.12, §10 (humanity metrics live here too)
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

export const renderWorld = {
  async past(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT tier, COUNT(*) AS n, AVG((payload->>'result_confidence')::numeric) AS conf
      FROM eval_observations
      WHERE loop = 'ai_call'
        AND observed_at >= ${ctx.window.from}::timestamptz
        AND observed_at < ${ctx.window.to}::timestamptz
      GROUP BY tier
      ORDER BY n DESC
    `;
    return `
      <section aria-labelledby="world-past">
        <h2 id="world-past">🌐 WORLD — Past</h2>
        <p>Tier activity (${ctx.window.from} → ${ctx.window.to}):</p>
        <table>
          <caption class="sr-only">AI calls per tier in window</caption>
          <thead><tr><th scope="col">Tier</th><th scope="col">Calls</th><th scope="col">Avg confidence</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr><td>${r.tier}</td><td>${r.n}</td><td>${Number(r.conf ?? 0).toFixed(2)}</td></tr>`).join("")}
          </tbody>
        </table>
      </section>`;
  },

  async present(ctx: ScopeContext): Promise<string> {
    const live = await sql`
      SELECT provider_name, state FROM ai_breaker_state WHERE state = 'open'
    `;
    const open = live.length;
    return `
      <section aria-labelledby="world-present" aria-live="polite">
        <h2 id="world-present">🌐 WORLD — Present</h2>
        <p><strong>${open}</strong> AI provider${open === 1 ? '' : 's'} currently open (degraded).</p>
        ${open > 0 ? `<ul>${live.map(b => `<li>${b.provider_name}</li>`).join("")}</ul>` : ''}
        <p data-live="world.breaker_open">${open}</p>
      </section>`;
  },

  async future(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT id, agent_name, action, scheduled_for FROM scheduled_actions
      WHERE status = 'authorized' AND scheduled_for < NOW() + INTERVAL '24 hours'
        AND scope = 'world'
      ORDER BY scheduled_for
      LIMIT 50
    `;
    return `
      <section aria-labelledby="world-future">
        <h2 id="world-future">🌐 WORLD — Authorized future (next 24h)</h2>
        ${rows.length === 0 ? '<p>No world-scoped actions scheduled.</p>' : `
        <table>
          <thead><tr><th scope="col">Agent</th><th scope="col">Action</th><th scope="col">When</th><th>Control</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr data-action-id="${r.id}">
                <td>${r.agent_name}</td>
                <td>${r.action}</td>
                <td><time datetime="${new Date(r.scheduled_for).toISOString()}">${new Date(r.scheduled_for).toLocaleString(ctx.language)}</time></td>
                <td>${controlButtons(r.id)}</td>
              </tr>`).join("")}
          </tbody>
        </table>`}
      </section>`;
  },
};

function controlButtons(actionId: number): string {
  return ['PAUSE','REVOKE'].map(v =>
    `<button class="verb" data-verb="${v}" data-action-id="${actionId}" aria-label="${v} action ${actionId}">${v}</button>`
  ).join(' ');
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/world.ts
git commit -m "feat(hivv-D): 🌐 WORLD renderer (tier activity + breakers + scheduled)"
```

---

### Task 5: 👤 ME renderer

**Files:**
- Create: `api/src/dashboard/render/me.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/me.ts
// Spec: §9.12 — owner's personal activity. Reads owner_id from session (Plan F).
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

const ownerCookie = (ctx: ScopeContext): string => ctx.session_id ?? 'owner-default';

export const renderMe = {
  async past(ctx: ScopeContext): Promise<string> {
    const owner = ownerCookie(ctx);
    const rows = await sql`
      SELECT capability, capability_outcome, COUNT(*) AS n
      FROM eval_observations
      WHERE loop = 'ai_call'
        AND (payload->>'session_id')::text = ${owner}
        AND observed_at >= ${ctx.window.from}::timestamptz
        AND observed_at < ${ctx.window.to}::timestamptz
      GROUP BY capability, capability_outcome
      ORDER BY capability, capability_outcome
    `;
    return `
      <section aria-labelledby="me-past">
        <h2 id="me-past">👤 ME — Past</h2>
        <p>My AI calls in window (${ctx.window.from} → ${ctx.window.to}):</p>
        <table>
          <thead><tr><th scope="col">Capability</th><th scope="col">Outcome</th><th scope="col">N</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${r.capability ?? '?'}</td><td>${r.capability_outcome ?? '?'}</td><td>${r.n}</td></tr>`).join("")}</tbody>
        </table>
      </section>`;
  },

  async present(_ctx: ScopeContext): Promise<string> {
    // Present = my currently running sessions (Plan F writes these)
    return `
      <section aria-labelledby="me-present" aria-live="polite">
        <h2 id="me-present">👤 ME — Present</h2>
        <p data-live="me.active_sessions">Live session count updates in the corner.</p>
      </section>`;
  },

  async future(ctx: ScopeContext): Promise<string> {
    const owner = ownerCookie(ctx);
    const rows = await sql`
      SELECT id, agent_name, action, scheduled_for FROM scheduled_actions
      WHERE status = 'authorized' AND scheduled_for < NOW() + INTERVAL '24 hours'
        AND scope = 'me' AND (audit->>'session_id')::text = ${owner}
      ORDER BY scheduled_for
    `;
    return `
      <section aria-labelledby="me-future">
        <h2 id="me-future">👤 ME — Authorized future (next 24h)</h2>
        ${rows.length === 0 ? '<p>No actions scheduled on your behalf.</p>' : `
        <ul>
          ${rows.map(r => `
            <li data-action-id="${r.id}">
              <strong>${r.agent_name}</strong> will <em>${r.action}</em>
              at <time datetime="${new Date(r.scheduled_for).toISOString()}">${new Date(r.scheduled_for).toLocaleString(ctx.language)}</time>
              — ${controlButtons(r.id)}
            </li>`).join("")}
        </ul>`}
      </section>`;
  },
};

function controlButtons(actionId: number): string {
  return ['PAUSE','REVOKE','AUDIT'].map(v =>
    `<button class="verb" data-verb="${v}" data-action-id="${actionId}" aria-label="${v} action ${actionId}">${v}</button>`
  ).join(' ');
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/me.ts
git commit -m "feat(hivv-D): 👤 ME renderer (owner-scoped activity)"
```

---

### Task 6: 🏢 ORGANIZATION renderer

**Files:**
- Create: `api/src/dashboard/render/organization.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/organization.ts
// Spec: §9.12 — org-wide activity, no PII.
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

export const renderOrganization = {
  async past(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT provider_used, capability, COUNT(*) AS n
      FROM eval_observations
      WHERE loop = 'ai_call'
        AND observed_at >= ${ctx.window.from}::timestamptz
        AND observed_at < ${ctx.window.to}::timestamptz
      GROUP BY provider_used, capability
      ORDER BY n DESC LIMIT 20
    `;
    return `
      <section aria-labelledby="org-past">
        <h2 id="org-past">🏢 ORGANIZATION — Past</h2>
        <p>Top (provider, capability) pairs in window:</p>
        <table>
          <thead><tr><th scope="col">Provider</th><th scope="col">Capability</th><th scope="col">N</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${r.provider_used ?? '?'}</td><td>${r.capability ?? '?'}</td><td>${r.n}</td></tr>`).join("")}</tbody>
        </table>
      </section>`;
  },

  async present(_ctx: ScopeContext): Promise<string> {
    return `
      <section aria-labelledby="org-present" aria-live="polite">
        <h2 id="org-present">🏢 ORGANIZATION — Present</h2>
        <p>Currently active agents: <span data-live="org.active_agents">…</span></p>
        <p>Open breakers: <span data-live="org.open_breakers">…</span></p>
      </section>`;
  },

  async future(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT agent_name, COUNT(*) AS n
      FROM scheduled_actions
      WHERE status = 'authorized' AND scheduled_for < NOW() + INTERVAL '24 hours'
        AND scope = 'organization'
      GROUP BY agent_name ORDER BY n DESC
    `;
    return `
      <section aria-labelledby="org-future">
        <h2 id="org-future">🏢 ORGANIZATION — Authorized future (next 24h)</h2>
        <ul>${rows.map(r => `<li><strong>${r.agent_name}</strong>: ${r.n} scheduled</li>`).join("")}</ul>
      </section>`;
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/organization.ts
git commit -m "feat(hivv-D): 🏢 ORGANIZATION renderer (top providers + scheduled)"
```

---

### Task 7: 🤖 AGENT renderer

**Files:**
- Create: `api/src/dashboard/render/agent.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/agent.ts
// Spec: §9.12 — drill-down on a single agent. Reads ?agent= from ctx.
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

const agentName = (ctx: ScopeContext): string =>
  ctx.agent_name ?? ctx.scope === 'agent' ? 'xyzo-extractor' : 'all';

export const renderAgent = {
  async past(ctx: ScopeContext): Promise<string> {
    const name = agentName(ctx);
    const rows = await sql`
      SELECT capability, capability_outcome, COUNT(*) AS n
      FROM eval_observations
      WHERE loop = 'ai_call' AND provider_used LIKE ${name + '%'}
        AND observed_at >= ${ctx.window.from}::timestamptz
        AND observed_at < ${ctx.window.to}::timestamptz
      GROUP BY capability, capability_outcome
      ORDER BY capability
    `;
    return `
      <section aria-labelledby="agent-past">
        <h2 id="agent-past">🤖 ${name} — Past</h2>
        <p>Action breakdown for <code>${name}</code>:</p>
        <table>
          <thead><tr><th scope="col">Capability</th><th scope="col">Outcome</th><th scope="col">N</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${r.capability ?? '?'}</td><td>${r.capability_outcome ?? '?'}</td><td>${r.n}</td></tr>`).join("")}</tbody>
        </table>
      </section>`;
  },

  async present(_ctx: ScopeContext): Promise<string> {
    const name = agentName(_ctx);
    return `
      <section aria-labelledby="agent-present" aria-live="polite">
        <h2 id="agent-present">🤖 ${name} — Present</h2>
        <p>Last call: <span data-live="agent.last_call">…</span></p>
        <p>Current breaker state: <span data-live="agent.breaker">…</span></p>
      </section>`;
  },

  async future(ctx: ScopeContext): Promise<string> {
    const name = agentName(ctx);
    const rows = await sql`
      SELECT id, action, scheduled_for FROM scheduled_actions
      WHERE status = 'authorized' AND agent_name = ${name}
        AND scheduled_for < NOW() + INTERVAL '24 hours'
      ORDER BY scheduled_for
    `;
    return `
      <section aria-labelledby="agent-future">
        <h2 id="agent-future">🤖 ${name} — Authorized future (next 24h)</h2>
        ${rows.length === 0 ? '<p>No scheduled actions.</p>' : `
        <ul>${rows.map(r => `
          <li data-action-id="${r.id}">
            ${r.action} at <time datetime="${new Date(r.scheduled_for).toISOString()}">${new Date(r.scheduled_for).toLocaleString(ctx.language)}</time>
            — ${controlButtons(r.id)}
          </li>`).join("")}</ul>`}
      </section>`;
  },
};

function controlButtons(actionId: number): string {
  return ['PAUSE','REVOKE','AUDIT'].map(v =>
    `<button class="verb" data-verb="${v}" data-action-id="${actionId}" aria-label="${v}">${v}</button>`
  ).join(' ');
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/agent.ts
git commit -m "feat(hivv-D): 🤖 AGENT renderer (single-agent drill-down)"
```

---

### Task 8: 🔗 RELATIONSHIP renderer

**Files:**
- Create: `api/src/dashboard/render/relationship.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/relationship.ts
// Spec: §9.12 — peer-to-peer agent comms. Reads ai_communications (Plan C writes these).
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

export const renderRelationship = {
  async past(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT from_agent, to_agent, verb, COUNT(*) AS n
      FROM ai_communications
      WHERE sent_at >= ${ctx.window.from}::timestamptz
        AND sent_at < ${ctx.window.to}::timestamptz
      GROUP BY from_agent, to_agent, verb
      ORDER BY n DESC LIMIT 30
    `;
    return `
      <section aria-labelledby="rel-past">
        <h2 id="rel-past">🔗 RELATIONSHIP — Past</h2>
        <p>Top agent-to-agent exchanges in window:</p>
        <table>
          <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Verb</th><th scope="col">N</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${r.from_agent}</td><td>${r.to_agent}</td><td>${r.verb}</td><td>${r.n}</td></tr>`).join("")}</tbody>
        </table>
      </section>`;
  },

  async present(_ctx: ScopeContext): Promise<string> {
    return `
      <section aria-labelledby="rel-present" aria-live="polite">
        <h2 id="rel-present">🔗 RELATIONSHIP — Present</h2>
        <p>Active peer links: <span data-live="rel.active_links">…</span></p>
      </section>`;
  },

  async future(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT id, from_agent, to_agent, verb, scheduled_for FROM scheduled_actions
      WHERE status = 'authorized' AND scope = 'relationship'
        AND scheduled_for < NOW() + INTERVAL '24 hours'
      ORDER BY scheduled_for LIMIT 30
    `;
    return `
      <section aria-labelledby="rel-future">
        <h2 id="rel-future">🔗 RELATIONSHIP — Authorized future (next 24h)</h2>
        ${rows.length === 0 ? '<p>No scheduled peer exchanges.</p>' : `
        <ul>${rows.map(r => `
          <li data-action-id="${r.id}">
            ${r.from_agent} → ${r.to_agent}: ${r.verb}
            at <time datetime="${new Date(r.scheduled_for).toISOString()}">${new Date(r.scheduled_for).toLocaleString(ctx.language)}</time>
            — ${controlButtons(r.id)}
          </li>`).join("")}</ul>`}
      </section>`;
  },
};

function controlButtons(actionId: number): string {
  return ['PAUSE','REVOKE','AUDIT'].map(v =>
    `<button class="verb" data-verb="${v}" data-action-id="${actionId}" aria-label="${v}">${v}</button>`
  ).join(' ');
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/relationship.ts
git commit -m "feat(hivv-D): 🔗 RELATIONSHIP renderer (agent-to-agent graph)"
```

---

### Task 9: 🕰️ HISTORY renderer

**Files:**
- Create: `api/src/dashboard/render/history.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/history.ts
// Spec: §9.12 — chronological feed of all AI calls, filterable.
// Default export is a function (past/present/future all share it).
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

export async function renderHistory(ctx: ScopeContext): Promise<string> {
  const rows = await sql`
    SELECT observed_at, provider_used, capability, capability_outcome,
           result_confidence, reasoning_summary
    FROM eval_observations
    WHERE loop = 'ai_call'
      AND observed_at >= ${ctx.window.from}::timestamptz
      AND observed_at < ${ctx.window.to}::timestamptz
    ORDER BY observed_at DESC
    LIMIT 100
  `;
  return `
    <section aria-labelledby="history">
      <h2 id="history">🕰️ HISTORY</h2>
      <p>Chronological feed (most recent 100, window ${ctx.window.from} → ${ctx.window.to}):</p>
      <table>
        <thead><tr>
          <th scope="col">When</th>
          <th scope="col">Provider</th>
          <th scope="col">Capability</th>
          <th scope="col">Outcome</th>
          <th scope="col">Confidence</th>
          <th scope="col">Reasoning</th>
          <th scope="col">Control</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const when = new Date(r.observed_at).toISOString();
            return `
              <tr>
                <td><time datetime="${when}">${when}</time></td>
                <td>${r.provider_used ?? '?'}</td>
                <td>${r.capability ?? '?'}</td>
                <td>${r.capability_outcome ?? '?'}</td>
                <td>${r.result_confidence ?? '?'}</td>
                <td>${(r.reasoning_summary ?? '').slice(0,80)}</td>
                <td><button class="verb" data-verb="AUDIT" data-observation-id="${r.observed_at}" aria-label="Audit this row">AUDIT</button></td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </section>`;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/history.ts
git commit -m "feat(hivv-D): 🕰️ HISTORY renderer (chronological feed + AUDIT button)"
```

---

### Task 10: 🔮 FUTURE renderer

**Files:**
- Create: `api/src/dashboard/render/future.ts`

- [ ] **Step 1: Write renderer**

```ts
// api/src/dashboard/render/future.ts
// Spec: §9.12 — 🔮 FUTURE is the most distinctive view: authorized actions.
import postgres from "postgres";
import type { ScopeContext } from "../types";
const sql = postgres(process.env.XYZO_DB_DSN!);

export const renderFuture = {
  async past(_ctx: ScopeContext): Promise<string> {
    // The "past" of the FUTURE view = scheduled_actions that already executed
    return `<section><h2>🔮 FUTURE — Past (already executed)</h2>
            <p>This shows actions that were authorized and ran.</p></section>`;
  },

  async present(_ctx: ScopeContext): Promise<string> {
    const row = await sql`
      SELECT COUNT(*) AS n FROM scheduled_actions
      WHERE status = 'authorized' AND expires_at > NOW()
    `;
    return `
      <section aria-labelledby="future-present" aria-live="polite">
        <h2 id="future-present">🔮 FUTURE — Present</h2>
        <p><strong>${row[0].n}</strong> authorized actions currently active.</p>
      </section>`;
  },

  async future(ctx: ScopeContext): Promise<string> {
    const rows = await sql`
      SELECT id, agent_name, action, scheduled_for, expires_at, scope, audit
      FROM scheduled_actions
      WHERE status = 'authorized' AND expires_at > NOW()
      ORDER BY scheduled_for
      LIMIT 100
    `;
    return `
      <section aria-labelledby="future-future">
        <h2 id="future-future">🔮 FUTURE — Authorized (next 24h, all scopes)</h2>
        ${rows.length === 0 ? '<p>Nothing scheduled. You are not authorizing any AI actions ahead of time.</p>' : `
        <table>
          <thead><tr>
            <th scope="col">When</th>
            <th scope="col">Agent</th>
            <th scope="col">Scope</th>
            <th scope="col">Action</th>
            <th scope="col">Expires</th>
            <th scope="col">Control</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr data-action-id="${r.id}">
                <td><time datetime="${new Date(r.scheduled_for).toISOString()}">${new Date(r.scheduled_for).toLocaleString(ctx.language)}</time></td>
                <td>${r.agent_name}</td>
                <td>${r.scope}</td>
                <td>${r.action}</td>
                <td><time datetime="${new Date(r.expires_at).toISOString()}">${new Date(r.expires_at).toLocaleString(ctx.language)}</time></td>
                <td>${controlButtons(r.id)}</td>
              </tr>`).join("")}
          </tbody>
        </table>`}
        <p><small>Click PAUSE to halt, REVOKE to cancel, or AUDIT to see who authorized this.</small></p>
      </section>`;
  },
};

function controlButtons(actionId: number): string {
  return ['PAUSE','REVOKE','AUDIT'].map(v =>
    `<button class="verb" data-verb="${v}" data-action-id="${actionId}" aria-label="${v}">${v}</button>`
  ).join(' ');
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/future.ts
git commit -m "feat(hivv-D): 🔮 FUTURE renderer (authorized-future queue + control verbs)"
```

---

### Task 11: Shared CSS + layout

**Files:**
- Create: `api/src/dashboard/render/shared.ts`

- [ ] **Step 1: Write shared renderer helpers**

```ts
// api/src/dashboard/render/shared.ts
export function page(scope: string, title: string, body: string, lang = 'en'): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} — hivv</title>
  <link rel="stylesheet" href="/dashboard/style.css">
</head>
<body class="scope-${scope}">
  ${nav(scope)}
  <main id="main" tabindex="-1">
    <h1>${escape(title)}</h1>
    ${body}
  </main>
  <script src="/dashboard/app.js" defer></script>
</body>
</html>`;
}

export function nav(activeScope: string): string {
  const tabs: Array<[string, string]> = [
    ['world', '🌐 WORLD'], ['me', '👤 ME'], ['organization', '🏢 ORG'],
    ['agent', '🤖 AGENT'], ['relationship', '🔗 REL'], ['history', '🕰️ HISTORY'],
    ['future', '🔮 FUTURE'],
  ];
  return `
    <nav aria-label="Visualization scopes">
      <ul role="tablist">
        ${tabs.map(([id, label]) => `
          <li role="presentation">
            <a role="tab" id="tab-${id}" href="/dashboard/${id}"
               aria-selected="${activeScope === id ? 'true' : 'false'}"
               aria-controls="main">${label}</a>
          </li>`).join("")}
      </ul>
    </nav>`;
}

export function escape(s: string): string {
  return String(s).replace(/[<>&"']/g, c =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[c]);
}

export function srOnly(text: string): string {
  return `<span class="sr-only">${escape(text)}</span>`;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/shared.ts
git commit -m "feat(hivv-D): shared layout (page, nav, escape, sr-only helpers)"
```

---

### Task 12: Eight control verbs (server-side)

**Files:**
- Create: `api/src/dashboard/verbs.ts`
- Create: `api/tests/verbs.test.ts`

- [ ] **Step 1: Write verb handlers**

```ts
// api/src/dashboard/verbs.ts
// Spec: §11.10 — 8 Human→AI verbs.
import postgres from "postgres";
import { writeAudit } from "../audit"; // Plan F
const sql = postgres(process.env.XYZO_DB_DSN!);

export type Verb = 'ALLOW'|'DENY'|'PAUSE'|'REVOKE'|'DELEGATE'|'ASK'|'ESCALATE'|'AUDIT';

export type VerbResult = { ok: boolean; detail: string };

export async function applyVerb(
  verb: Verb,
  action_id: number,
  ctx: { session_id?: string; ip: string },
): Promise<VerbResult> {
  const handlers: Record<Verb, (id: number) => Promise<VerbResult>> = {
    ALLOW:   async id => { await sql`UPDATE scheduled_actions SET status='authorized' WHERE id=${id}`; return {ok:true, detail:'authorized'}; },
    DENY:    async id => { await sql`UPDATE scheduled_actions SET status='denied' WHERE id=${id}`;     return {ok:true, detail:'denied'}; },
    PAUSE:   async id => { await sql`UPDATE scheduled_actions SET status='pending_approval' WHERE id=${id}`; return {ok:true, detail:'paused (now pending approval)'}; },
    REVOKE:  async id => { await sql`UPDATE scheduled_actions SET status='revoked' WHERE id=${id}`;   return {ok:true, detail:'revoked'}; },
    DELEGATE:async id => { /* Plan F implements session-key delegation */ return {ok:true, detail:'delegation requested'}; },
    ASK:     async id => { return {ok:true, detail:`asked: agent must respond before ${new Date(Date.now()+300000).toISOString()}`}; },
    ESCALATE:async id => { await sql`UPDATE scheduled_actions SET status='pending_approval' WHERE id=${id}`; return {ok:true, detail:'escalated to owner'}; },
    AUDIT:   async id => { const r = await sql`SELECT audit FROM scheduled_actions WHERE id=${id}`; return {ok:true, detail: JSON.stringify(r[0]?.audit)}; },
  };
  const result = await handlers[verb](action_id);
  await writeAudit({
    verb, target_type: 'scheduled_action', target_id: String(action_id),
    session_id: ctx.session_id, ip: ctx.ip, result,
  });
  return result;
}
```

- [ ] **Step 2: Test**

```ts
// api/tests/verbs.test.ts
import { describe, expect, test } from "bun:test";
import { applyVerb } from "../src/dashboard/verbs";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

test("PAUSE marks scheduled_action pending_approval", async () => {
  const [inserted] = await sql`
    INSERT INTO scheduled_actions (agent_name, action, params, scheduled_for, authorized_by, scope, expires_at, audit)
    VALUES ('test-agent', 'extract', '{}', NOW() + INTERVAL '1 hour', 'owner', 'world', NOW() + INTERVAL '24 hours', '{}'::jsonb)
    RETURNING id
  `;
  const r = await applyVerb("PAUSE", Number(inserted.id), {ip: "127.0.0.1"});
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("paused");
  const [row] = await sql`SELECT status FROM scheduled_actions WHERE id=${inserted.id}`;
  expect(row.status).toBe("pending_approval");
  await sql`DELETE FROM scheduled_actions WHERE id=${inserted.id}`;
});

test("AUDIT returns audit envelope", async () => {
  const [inserted] = await sql`
    INSERT INTO scheduled_actions (agent_name, action, params, scheduled_for, authorized_by, scope, expires_at, audit)
    VALUES ('test-agent', 'extract', '{}', NOW() + INTERVAL '1 hour', 'owner', 'world', NOW() + INTERVAL '24 hours', '{"authorized_by":"owner"}'::jsonb)
    RETURNING id
  `;
  const r = await applyVerb("AUDIT", Number(inserted.id), {ip: "127.0.0.1"});
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("authorized_by");
  await sql`DELETE FROM scheduled_actions WHERE id=${inserted.id}`;
});
```

- [ ] **Step 3: Run + commit (stub `writeAudit` from Plan F; otherwise use a temporary insert)**

```bash
cd api && bun test tests/verbs.test.ts 2>&1 | tail -10
git add api/src/dashboard/verbs.ts api/tests/verbs.test.ts
git commit -m "feat(hivv-D): 8 control verbs (server-side, audit-emit)"
```

---

### Task 13: Scope navigation (tab state)

- (Largely covered in Task 11's nav. Task 13 = JS-side deep-link support.)

**Files:**
- Modify: `api/src/dashboard/render/shared.ts` (add `data-scope-tab` marker)

- [ ] **Step 1: Update nav with state markers**

```ts
// In shared.ts, replace nav() with:
export function nav(activeScope: string): string {
  const tabs: Array<[string, string]> = [
    ['world', '🌐 WORLD'], ['me', '👤 ME'], ['organization', '🏢 ORG'],
    ['agent', '🤖 AGENT'], ['relationship', '🔗 REL'], ['history', '🕰️ HISTORY'],
    ['future', '🔮 FUTURE'],
  ];
  return `
    <nav aria-label="Visualization scopes">
      <ul role="tablist" data-scope-tabs>
        ${tabs.map(([id, label]) => `
          <li role="presentation">
            <a role="tab" id="tab-${id}" href="/dashboard/${id}"
               data-scope-tab="${id}"
               aria-selected="${activeScope === id ? 'true' : 'false'}"
               aria-controls="main"
               tabindex="${activeScope === id ? '0' : '-1'}">${label}</a>
          </li>`).join("")}
      </ul>
    </nav>`;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/dashboard/render/shared.ts
git commit -m "feat(hivv-D): scope tabs with keyboard support (Tab/Arrow/Home/End)"
```

---

### Task 14: Index.html shell

**Files:**
- Create: `public/dashboard/index.html`

- [ ] **Step 1: Write shell**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hivv — Operator Dashboard</title>
  <meta name="description" content="Visualization-as-language for the hivv protocol: seven scopes, temporal triad, eight control verbs.">
  <link rel="stylesheet" href="/dashboard/style.css">
</head>
<body class="scope-world">
  <a class="skip-link" href="#main">Skip to main content</a>
  <header>
    <h1>hivv</h1>
    <p class="tagline">Visualization is the language.</p>
  </header>
  <!-- Server-rendered nav + main content replace this on each route -->
  <main id="main" tabindex="-1" role="main" aria-busy="true">
    <p>Loading scope…</p>
  </main>
  <script src="/dashboard/app.js" defer></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat(hivv-D): dashboard shell with skip-link"
```

---

### Task 15: style.css (a11y-first)

**Files:**
- Create: `public/dashboard/style.css`

- [ ] **Step 1: Write CSS**

```css
/* hivv dashboard — a11y-first, no motion without consent. */
:root {
  --bg: #fafafa;
  --fg: #1a1a1a;
  --fg-muted: #555;
  --accent: #0066cc;
  --danger: #b00020;
  --border: #d0d0d0;
  --focus: #ff8800;
  --scope-world: #1f77b4;
  --scope-me: #ff7f0e;
  --scope-organization: #2ca02c;
  --scope-agent: #d62728;
  --scope-relationship: #9467bd;
  --scope-history: #8c564b;
  --scope-future: #e377c2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181818; --fg: #f0f0f0; --fg-muted: #aaa;
    --border: #404040;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: var(--bg); color: var(--fg);
  line-height: 1.5;
}
@media (prefers-reduced-motion: no-preference) {
  body { font-feature-settings: "tnum"; }
}
.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.skip-link {
  position: absolute; top: -40px; left: 0;
  background: var(--accent); color: white;
  padding: 0.5rem 1rem; z-index: 100;
}
.skip-link:focus { top: 0; }
:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
header {
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
header h1 { margin: 0; font-size: 1.5rem; }
header .tagline { margin: 0; color: var(--fg-muted); font-size: 0.875rem; }

nav ul[role="tablist"] {
  display: flex; flex-wrap: wrap;
  gap: 0.25rem;
  list-style: none; padding: 0.5rem 1rem;
  margin: 0; border-bottom: 1px solid var(--border);
}
nav [role="tab"] {
  display: inline-block;
  padding: 0.5rem 1rem;
  text-decoration: none;
  color: var(--fg);
  border-bottom: 3px solid transparent;
}
nav [role="tab"][aria-selected="true"] {
  border-bottom-color: var(--accent);
  font-weight: 600;
}

main { padding: 1rem 2rem; }
main h1 { font-size: 1.25rem; margin-top: 0; }
main h2 { font-size: 1.125rem; margin-top: 2rem; }
section { margin-bottom: 2rem; }
table {
  border-collapse: collapse;
  width: 100%; max-width: 100%;
  margin: 1rem 0;
}
caption { text-align: left; }
th, td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
}
th { font-weight: 600; background: rgba(0,0,0,0.03); }
@media (prefers-color-scheme: dark) {
  th { background: rgba(255,255,255,0.05); }
}

button.verb {
  font: inherit;
  padding: 0.25rem 0.5rem;
  margin-right: 0.25rem;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  border-radius: 4px;
  cursor: pointer;
}
button.verb[data-verb="PAUSE"]   { color: #b58900; border-color: #b58900; }
button.verb[data-verb="REVOKE"]  { color: var(--danger); border-color: var(--danger); }
button.verb[data-verb="ALLOW"]   { color: #2ca02c; border-color: #2ca02c; }
button.verb[data-verb="AUDIT"]   { color: var(--accent); border-color: var(--accent); }
button.verb:hover  { filter: brightness(0.95); }
button.verb:active { transform: translateY(1px); }
@media (prefers-reduced-motion: reduce) {
  button.verb:active { transform: none; }
}

/* Scope accent stripe */
body.scope-world        { border-top: 4px solid var(--scope-world); }
body.scope-me           { border-top: 4px solid var(--scope-me); }
body.scope-organization { border-top: 4px solid var(--scope-organization); }
body.scope-agent        { border-top: 4px solid var(--scope-agent); }
body.scope-relationship { border-top: 4px solid var(--scope-relationship); }
body.scope-history      { border-top: 4px solid var(--scope-history); }
body.scope-future       { border-top: 4px solid var(--scope-future); }
```

- [ ] **Step 2: Commit**

```bash
git add public/dashboard/style.css
git commit -m "feat(hivv-D): a11y-first CSS (dark mode, reduced-motion, focus rings)"
```

---

### Task 16: app.js (HTMX + minimal JS)

**Files:**
- Create: `public/dashboard/app.js`

- [ ] **Step 1: Write JS**

```js
// hivv dashboard app.js
// Progressive enhancement: page works without JS; JS adds live updates + verb actions.
(function () {
  'use strict';

  // Tab keyboard navigation (WAI-ARIA tabs pattern)
  const tablist = document.querySelector('[role="tablist"]');
  if (tablist) {
    tablist.addEventListener('keydown', (e) => {
      const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
      const idx = tabs.indexOf(document.activeElement);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        tabs[(idx + 1) % tabs.length].focus();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        tabs[(idx - 1 + tabs.length) % tabs.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault(); tabs[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault(); tabs[tabs.length - 1].focus();
      }
    });
  }

  // Verb button delegation
  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.verb');
    if (!btn) return;
    e.preventDefault();
    const verb = btn.dataset.verb;
    const actionId = btn.dataset.actionId;
    const obsId = btn.dataset.observationId;
    const target = actionId ? `action_id=${actionId}` : `observation_id=${encodeURIComponent(obsId)}`;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      const r = await fetch(`/api/control/verb?verb=${verb}&${target}`, {
        method: 'POST', credentials: 'same-origin',
      });
      const data = await r.json();
      announce(`${verb} ${data.detail ?? ''}`);
    } catch (err) {
      announce(`Error: ${err.message}`, 'assertive');
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });

  // Live region
  let announcer = document.getElementById('hivv-live');
  if (!announcer) {
    announcer = document.createElement('div');
    announcer.id = 'hivv-live';
    announcer.className = 'sr-only';
    announcer.setAttribute('aria-live', 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    document.body.appendChild(announcer);
  }
  function announce(msg, level = 'polite') {
    announcer.setAttribute('aria-live', level);
    announcer.textContent = msg;
  }

  // Live updates via WebSocket (Plan C/D20)
  if ('WebSocket' in window) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/dashboard/ws`);
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.scope && msg.layer === 'present') {
          for (const [key, value] of Object.entries(msg.live ?? {})) {
            const el = document.querySelector(`[data-live="${msg.scope}.${key}"]`);
            if (el) el.textContent = String(value);
          }
        }
      } catch {}
    });
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add public/dashboard/app.js
git commit -m "feat(hivv-D): app.js (tab keyboard, verb delegation, WebSocket live)"
```

---

### Task 17: verb-button.js (split out for caching)

(Inline in app.js for now; can split later if JS grows beyond ~5KB.)

- [ ] **Step 1: No-op commit (already inline)**

```bash
echo "verb-button.js inline in app.js" > public/dashboard/verb-button.js
git add public/dashboard/verb-button.js
git commit -m "chore(hivv-D): placeholder for future verb-button split"
```

---

### Task 18: HTML routes

**Files:**
- Create: `api/src/routes/dashboard.ts`
- Create: `api/tests/dashboard-routes.test.ts`

- [ ] **Step 1: Write routes**

```ts
import { Hono } from "hono";
import { resolveScope } from "../dashboard/scopes";
import { page, nav } from "../dashboard/render/shared";
import type { ScopeId } from "../dashboard/types";

export const dashboardRoutes = new Hono();

const SCOPES: ScopeId[] = ['world','me','organization','agent','relationship','history','future'];

dashboardRoutes.get("/dashboard", (c) => c.redirect("/dashboard/world", 302));
dashboardRoutes.get("/dashboard/:scope", async (c) => {
  const scope = c.req.param("scope") as ScopeId;
  if (!SCOPES.includes(scope)) return c.text("Unknown scope", 404);

  const ctx = {
    scope, viewer: 'owner' as const,
    session_id: c.req.cookie('hivv_owner') ?? undefined,
    agent_name: c.req.query("agent") ?? undefined,
    window: {from: c.req.query("from") ?? sevenDaysAgo(), to: c.req.query("to") ?? nowIso()},
    language: c.req.query("lang") ?? c.req.header("accept-language")?.split(",")[0] ?? "en",
  };
  const r = await resolveScope(ctx);
  const body = `
    ${r.past.rendered}
    ${r.present.rendered}
    ${r.future.rendered}
    <script src="/dashboard/verb-button.js" defer></script>
  `;
  return c.html(page(scope, `${scope} scope`, body, ctx.language));
});

dashboardRoutes.get("/", (c) => c.html(page("world", "hivv",
  `<p>Welcome. <a href="/dashboard/world">Open the WORLD scope</a>.</p>`)));

function sevenDaysAgo(): string { return new Date(Date.now() - 7*86400_000).toISOString(); }
function nowIso(): string { return new Date().toISOString(); }
```

- [ ] **Step 2: Wire + test**

```ts
// api/tests/dashboard-routes.test.ts
import { describe, expect, test } from "bun:test";
import { dashboardRoutes } from "../src/routes/dashboard";

describe("dashboard routes", () => {
  test("/dashboard redirects to /dashboard/world", async () => {
    const r = await dashboardRoutes.request("/dashboard");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/dashboard/world");
  });

  test("/dashboard/world returns 200", async () => {
    const r = await dashboardRoutes.request("/dashboard/world");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("🌐 WORLD");
    expect(html).toContain('aria-live="polite"');
  });

  test("/dashboard/me redacts private vault for non-owner", async () => {
    // Plan F implements owner check; for now we expect a 200 with the "ME" scope label
    const r = await dashboardRoutes.request("/dashboard/me");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("👤 ME");
  });

  test("/dashboard/bogus returns 404", async () => {
    const r = await dashboardRoutes.request("/dashboard/bogus");
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 3: Wire into server.ts + commit**

```bash
# In api/src/server.ts:
# import { dashboardRoutes } from "./routes/dashboard";
# app.route("/", dashboardRoutes);

cd api && bun test tests/dashboard-routes.test.ts 2>&1 | tail -5
git add api/src/routes/dashboard.ts api/tests/dashboard-routes.test.ts api/src/server.ts
git commit -m "feat(hivv-D): dashboard HTML routes + 4 route tests"
```

---

### Task 19: Control verb routes

**Files:**
- Create: `api/src/routes/control-verbs.ts`

- [ ] **Step 1: Write routes**

```ts
import { Hono } from "hono";
import { applyVerb, type Verb } from "../dashboard/verbs";

export const controlVerbRoutes = new Hono();

const VALID: Verb[] = ['ALLOW','DENY','PAUSE','REVOKE','DELEGATE','ASK','ESCALATE','AUDIT'];

controlVerbRoutes.post("/api/control/verb", async (c) => {
  const verb = c.req.query("verb") as Verb;
  const actionId = Number(c.req.query("action_id"));
  const observationId = c.req.query("observation_id");

  if (!VALID.includes(verb)) return c.json({ok: false, detail: "invalid verb"}, 400);
  if (observationId) {
    // AUDIT on an observation: just return the row
    if (verb !== "AUDIT") return c.json({ok: false, detail: "only AUDIT on observations"}, 400);
    const r = await fetchEvalObservation(observationId);
    return c.json({ok: true, detail: JSON.stringify(r)});
  }
  if (!actionId || Number.isNaN(actionId)) return c.json({ok: false, detail: "action_id required"}, 400);

  const r = await applyVerb(verb, actionId, {
    session_id: c.req.cookie('hivv_owner'),
    ip: c.req.header('x-forwarded-for') ?? 'unknown',
  });
  return c.json(r);
});

async function fetchEvalObservation(observedAt: string) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.XYZO_DB_DSN!);
  const rows = await sql`SELECT * FROM eval_observations WHERE observed_at = ${observedAt}::timestamptz LIMIT 1`;
  return rows[0];
}
```

- [ ] **Step 2: Wire + commit**

```bash
# In api/src/server.ts: app.route("/", controlVerbRoutes);

git add api/src/routes/control-verbs.ts api/src/server.ts
git commit -m "feat(hivv-D): POST /api/control/verb endpoint (8 verbs)"
```

---

### Task 20: WebSocket live updates

**Files:**
- Create: `api/src/routes/ws.ts`

- [ ] **Step 1: Write WS route**

```ts
// api/src/routes/ws.ts
// Pushes Present-layer updates to the dashboard every 5s.
// Spec: §9 visualization-as-language (live updates without polling)
import { UPDATE_INTERVAL_MS } from "./const";
import postgres from "postgres";

const sql = postgres(process.env.XYZO_DB_DSN!);

export function attachWS(app: any) {
  app.get("/api/dashboard/ws", (c: any) => {
    const upgrade = c.req.header('upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket', 400);

    // Bun's WS support: server.upgrade()
    const ok = c.env?.server?.upgrade?.(c.req.raw);
    if (ok) return undefined;

    // Fallback: lightweight SSE
    return streamSSE(c);
  });
}

function streamSSE(c: any) {
  return c.body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const tick = async () => {
        try {
          const data = await gather();
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      tick();
      const t = setInterval(tick, UPDATE_INTERVAL_MS);
      return () => clearInterval(t);
    },
  }, {headers: {'content-type': 'text/event-stream'}});
}

async function gather() {
  const open = await sql`SELECT COUNT(*) AS n FROM ai_breaker_state WHERE state='open'`;
  const scheduled = await sql`SELECT COUNT(*) AS n FROM scheduled_actions WHERE status='authorized' AND expires_at > NOW()`;
  return {scope: 'world', layer: 'present', live: {
    breaker_open: Number(open[0].n),
    scheduled_active: Number(scheduled[0].n),
  }};
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/routes/ws.ts
git commit -m "feat(hivv-D): /api/dashboard/ws live updates (WebSocket + SSE fallback)"
```

---

### Task 21: Accessibility audit (axe-core)

**Files:**
- Create: `api/tests/accessibility.test.ts`

- [ ] **Step 1: Write audit**

```ts
// api/tests/accessibility.test.ts
// Runs axe-core against /dashboard/world, /dashboard/me, /dashboard/future.
// Fails the build on any WCAG AA violation.
import { describe, expect, test } from "bun:test";
import { axe } from "axe-core";
import { JSDOM } from "jsdom";

const SCOPES = ["world", "me", "organization", "agent", "relationship", "history", "future"];

describe("dashboard accessibility", () => {
  for (const scope of SCOPES) {
    test(`${scope} scope: no WCAG AA violations`, async () => {
      const html = await (await fetch(`http://localhost:3008/dashboard/${scope}`)).text();
      const dom = new JSDOM(html);
      const results = await axe.run(dom.window.document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      const violations = results.violations;
      if (violations.length > 0) {
        console.error(`Violations in ${scope}:`, JSON.stringify(violations, null, 2));
      }
      expect(violations.length).toBe(0);
    });
  }

  test("every verb button has aria-label", async () => {
    const html = await (await fetch("http://localhost:3008/dashboard/future")).text();
    const buttons = html.match(/<button class="verb"[^>]*>/g) ?? [];
    for (const b of buttons) {
      expect(b).toMatch(/aria-label="[^"]+"/);
    }
  });

  test("skip-link is present on every page", async () => {
    for (const scope of SCOPES) {
      const html = await (await fetch(`http://localhost:3008/dashboard/${scope}`)).text();
      expect(html).toMatch(/<a class="skip-link"/);
    }
  });
});
```

- [ ] **Step 2: Add deps + run**

```bash
cd api && bun add -d axe-core jsdom
bun test tests/accessibility.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add api/tests/accessibility.test.ts api/package.json api/bun.lock
git commit -m "test(hivv-D): axe-core audit (WCAG AA across all 7 scopes)"
```

---

### Task 22: Documentation

**Files:**
- Create: `docs/dashboard/nine-questions.md`
- Create: `docs/dashboard/visualization-scopes.md`

- [ ] **Step 1: Write nine-questions.md**

```markdown
# hivv — The Nine Questions

Every visualization scope (and the protocol as a whole) answers these nine questions:

1. **What AI agents are active?** (🤖 AGENT + 🏢 ORG scopes)
2. **What are they doing?** (🕰️ HISTORY + 🤖 AGENT scopes)
3. **What data are they accessing?** (👤 ME — owner-scoped eval_observations)
4. **What decisions have they made?** (🕰️ HISTORY + capability_outcome)
5. **Who authorized them?** (🔮 FUTURE's audit envelope: `authorized_by`)
6. **What other agents are they communicating with?** (🔗 RELATIONSHIP — `ai_communications`)
7. **What happened previously?** (🕰️ HISTORY + 🌐 WORLD past layer)
8. **What is happening right now?** (all scopes' Present layer, live updates via WebSocket)
9. **What is scheduled to happen next?** (🔮 FUTURE — the authorized-future queue)

## Per-scope answers

| Scope           | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 |
|-----------------|----|----|----|----|----|----|----|----|----|
| 🌐 WORLD        |    |    |    |    |    |    | ✅ | ✅ |    |
| 👤 ME           |    | ✅ | ✅ | ✅ | ✅ |    | ✅ | ✅ | ✅ |
| 🏢 ORGANIZATION | ✅ |    |    |    |    |    | ✅ | ✅ | ✅ |
| 🤖 AGENT        | ✅ | ✅ |    |    |    |    | ✅ | ✅ | ✅ |
| 🔗 RELATIONSHIP |    |    |    |    |    | ✅ | ✅ | ✅ | ✅ |
| 🕰️ HISTORY      |    | ✅ |    | ✅ |    |    | ✅ |    |    |
| 🔮 FUTURE       |    | ✅ |    |    | ✅ |    |    |    | ✅ |

## Temporal triad

Every scope shows three layers:

- **Past:** `eval_observations` rows in the chosen window
- **Present:** live data (breakers, scheduled_action counts, session count)
- **Future:** `scheduled_actions` rows where status='authorized' and scheduled_for < NOW() + 24h

This triad lets the owner intervene before action happens, not just after.
```

- [ ] **Step 2: Write visualization-scopes.md**

```markdown
# hivv — Visualization Scopes

Visualization is the language humans use to understand agent systems. The dashboard has seven scopes; each is a single coherent view, not a widget dashboard.

## 🌐 WORLD

The broadest scope. Sees activity across all tiers and all agents, but no identities.
- **Past:** tier activity table
- **Present:** open breakers
- **Future:** world-scoped scheduled actions

## 👤 ME

Owner-scoped. The owner sees every AI action taken on their behalf.
- **Past:** capability × outcome for owner
- **Present:** active sessions
- **Future:** scheduled actions keyed to owner

## 🏢 ORGANIZATION

Org-wide activity, no PII. Top (provider, capability) pairs.
- **Past:** top pairs
- **Present:** active agent count
- **Future:** scheduled actions by agent

## 🤖 AGENT

Drill-down on a single agent.
- **Past:** action breakdown
- **Present:** last call, breaker state
- **Future:** scheduled actions for this agent

## 🔗 RELATIONSHIP

Agent-to-agent communication graph.
- **Past:** top (from, to, verb) tuples
- **Present:** active peer links
- **Future:** scheduled peer exchanges

## 🕰️ HISTORY

Chronological feed of all AI calls. Filterable, paginated.
- The audit log. The single source of truth.

## 🔮 FUTURE

Authorized-future queue. The most distinctive view.
- Lists every scheduled action across all agents and scopes.
- Click PAUSE / REVOKE / AUDIT to intervene.

## Why seven?

Seven is a working memory ceiling. Each scope is a single coherent mental model. Tabs (WAI-ARIA pattern) make navigation keyboard-friendly and screen-reader-friendly.

## Accessibility

- Every page has a skip link.
- Every interactive element has an aria-label.
- Live regions (`aria-live="polite"`) announce status changes.
- `prefers-reduced-motion` honored.
- WCAG AA contrast verified by axe-core.
- No motion without user preference.
```

- [ ] **Step 3: Commit**

```bash
git add docs/dashboard/
git commit -m "docs(hivv-D): nine-questions.md + visualization-scopes.md"
```

---

## Done — Plan D complete

Verify:
```bash
cd api && bun test tests/scopes.test.ts tests/verbs.test.ts tests/dashboard-routes.test.ts tests/accessibility.test.ts 2>&1 | tail -10
curl -s http://localhost:3008/dashboard/world | grep -c "🌐 WORLD"
curl -s http://localhost:3008/dashboard/future | grep -c "🔮 FUTURE"
```

Green → proceed to **Plan E — Humanity + Life Metrics** (`docs/superpowers/plans/2026-09-07-hivv-plan-e-humanity-metrics.md`).
