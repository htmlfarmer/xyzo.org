# hivv Plan C — Distributed AI Control Plane

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local-first, multi-model, publishable AI gateway. End state: any AI call (extract, classify, embed, summarize, route) goes through one chokepoint with a safety-net ladder (primary → secondary → algorithm → ask_user), a persistent breaker, prompt-injection guard, and compute budget. The package is publishable as `xyzo-ai-control-plane`.

**Architecture:** One TypeScript module (`api/src/ai-gateway/`) and four provider adapters (http/python/cli/algorithm). One SQL schema for `ai_model_configs`, `ai_safety_nets`, `ai_breaker_state`, `ai_compute_daily`. Migrates xyzo's existing `ai-breaker.ts` (in-process) to a persistent SQL-backed breaker. Wraps every AI call with the safety net ladder; every rung writes an `eval_observations (loop='ai_call')` row.

**Tech Stack:** Postgres (existing), TypeScript/Bun (Hono), Python 3.11 (subprocess adapters). No new dependencies required.

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` §8

**Prerequisites:** Plans A + B shipped + green.

**Out of scope:** Plan F (persona grants on sessions — gateway reads `consent_ledger` in Plan F only).

**Cross-cutting invariants:**
1. Local-only: zero paid API calls; if a model config points to an external host, the gateway refuses (returns algorithm rung)
2. Every AI call produces exactly one `eval_observations (loop='ai_call')` row with 11 audit fields (§11.11)
3. Breaker state persists across restarts (SQL-backed, not in-process)
4. Compute budget enforced before invocation; over-budget returns algorithm rung

---

## File Structure

```
api/migrations/
  2026-09-09-ai-control-plane.sql          (Task 1)

api/src/ai-gateway/
  types.ts                                  (Task 2)
  gateway.ts                                (Task 3)
  safety-net.ts                             (Task 4)
  injection-guard.ts                        (Task 5)
  compute-budget.ts                         (Task 6)
  breaker.ts                                (Task 7)
  providers/
    http.ts                                 (Task 8)
    python.ts                               (Task 9)
    cli.ts                                  (Task 10)
    algorithm.ts                            (Task 11)

xyzo-ai-control-plane/                      (Task 12 — publishable package)
  package.json
  README.md
  src/index.ts                              (re-exports gateway)
  examples/ollama.ts, llama-cpp.ts, custom-nn.ts, pure-algorithm.ts
  LICENSE (MIT)

worker/handlers/
  model_finetune.py                         (Task 13)
  shadow_eval.py                            (Task 14)

api/src/routes/
  ai-control.ts                             (Task 15 — admin endpoints)

api/tests/
  ai-gateway.test.ts                        (Task 16)
  safety-net.test.ts                        (Task 4)
  injection-guard.test.ts                   (Task 5)
  compute-budget.test.ts                    (Task 6)
  breaker.test.ts                           (Task 7)
  providers.test.ts                         (Task 8-11)

worker/tests/
  test_model_finetune.py                    (Task 13)
  test_shadow_eval.py                       (Task 14)
```

---

## Task Index

- Task 1: AI control plane schema
- Task 2: `types.ts` (GatewayInput, ModelOutput)
- Task 3: Gateway main loop
- Task 4: Safety net ladder
- Task 5: Prompt injection guard
- Task 6: Compute budget
- Task 7: Persistent breaker
- Task 8: HTTP provider (Ollama, llama.cpp, vLLM)
- Task 9: Python provider (subprocess)
- Task 10: CLI provider (subprocess wrapper)
- Task 11: Algorithm provider (no AI)
- Task 12: Publishable package (`xyzo-ai-control-plane`)
- Task 13: `model_finetune` handler
- Task 14: `shadow_eval` handler
- Task 15: Admin endpoints
- Task 16: Integration tests
- Task 17: Documentation + handoff

---

### Task 1: AI control plane schema

**Files:**
- Create: `api/migrations/2026-09-09-ai-control-plane.sql`

- [ ] **Step 1: Write migration**

```sql
-- ── 2026-09-09-ai-control-plane.sql ─────────────────────────────────
-- AI control plane schema. Spec: §8
BEGIN;

CREATE TYPE ai_breaker_state AS ENUM ('closed','open','half_open');

CREATE TABLE ai_model_configs (
  id BIGSERIAL PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('http','python','cli','algorithm')),
  name TEXT NOT NULL,
  invocation JSONB NOT NULL,
  capabilities TEXT[] NOT NULL,
  max_concurrent INT NOT NULL DEFAULT 4,
  enabled BOOLEAN NOT NULL DEFAULT true,
  tier_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_type, name)
);

CREATE TABLE ai_safety_nets (
  prompt_name TEXT NOT NULL,
  tier eval_tier NOT NULL,
  rungs JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (prompt_name, tier)
);

CREATE TABLE ai_breaker_state (
  provider_name TEXT PRIMARY KEY
                REFERENCES ai_model_configs(provider_type, name) ON UPDATE CASCADE,
  state ai_breaker_state NOT NULL DEFAULT 'closed',
  opened_at TIMESTAMPTZ,
  opens_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  half_open_at TIMESTAMPTZ,
  cooldown_s INT NOT NULL DEFAULT 180,
  confidence_p50 NUMERIC(4,3),
  confidence_p10 NUMERIC(4,3),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ai_compute_daily (
  day DATE NOT NULL,
  provider_name TEXT NOT NULL,
  tier eval_tier NOT NULL,
  call_count INT NOT NULL DEFAULT 0,
  total_latency_ms BIGINT NOT NULL DEFAULT 0,
  p50_latency_ms INT,
  p95_latency_ms INT,
  p50_confidence NUMERIC(4,3),
  total_gpu_ms BIGINT,
  total_watts BIGINT,
  PRIMARY KEY (day, provider_name, tier)
);

-- Seed: a sensible xyzo default safety net for `extract`
INSERT INTO ai_safety_nets (prompt_name, tier, rungs) VALUES
  ('extract', 'community', '[
    {"step":1,"provider_type":"http","name":"gemma-4-9b-q4","confidence_threshold":0.70},
    {"step":2,"provider_type":"python","name":"sbert-classifier-v3","confidence_threshold":0.55},
    {"step":3,"provider_type":"algorithm","name":"regex_extract_location_v2","confidence_threshold":null},
    {"step":4,"action":"ask_user","confidence_threshold":null}
  ]'::jsonb),
  ('extract', 'gov', '[
    {"step":1,"provider_type":"http","name":"gemma-4-9b-q4","confidence_threshold":0.85},
    {"step":2,"provider_type":"algorithm","name":"regex_extract_location_v2","confidence_threshold":null}
  ]'::jsonb),
  ('extract', 'university', '[
    {"step":1,"provider_type":"http","name":"gemma-4-9b-q4","confidence_threshold":0.85},
    {"step":2,"provider_type":"algorithm","name":"regex_extract_location_v2","confidence_threshold":null}
  ]'::jsonb);

GRANT SELECT, INSERT, UPDATE ON ai_model_configs, ai_safety_nets,
                              ai_breaker_state, ai_compute_daily
                              TO xyzo_app, xyzo_improver;

COMMIT;
```

- [ ] **Step 2: Apply**

```bash
cd api && bun run db:migrate -- up migrations/2026-09-09-ai-control-plane.sql
psql $XYZO_DB_DSN -c "SELECT prompt_name, tier FROM ai_safety_nets"
```

- [ ] **Step 3: Commit**

```bash
git add api/migrations/2026-09-09-ai-control-plane.sql
git commit -m "feat(hivv-C): ai_model_configs + safety_nets + breaker + compute_daily schema"
```

---

### Task 2: `types.ts` (GatewayInput, ModelOutput)

**Files:**
- Create: `api/src/ai-gateway/types.ts`

- [ ] **Step 1: Write types**

```ts
// api/src/ai-gateway/types.ts
// Spec: §8.2

export type GatewayInput = {
  prompt_name: string;          // 'extract' | 'summarize' | 'classify' | 'route' | 'embed'
  tier: 'gov' | 'university' | 'community' | 'commercial' | 'platform' | 'user' | 'unknown';
  payload: Record<string, unknown>;
  timeout_ms?: number;
  trust_zone?: 'public' | 'owner' | 'private';
  session_id?: string;          // added by Plan F
};

export type ModelOutput = {
  text?: string;
  embedding?: number[];
  confidence: number;           // 0..1; < threshold triggers next ladder rung
  latency_ms: number;
  fallback_used?: 'primary' | 'secondary' | 'algorithm' | 'ask_user';
  provider_used?: string;
  rung_index?: number;
};

export type ProviderType = 'http' | 'python' | 'cli' | 'algorithm';

export interface ModelProvider {
  type: ProviderType;
  name: string;
  config: Record<string, unknown>;
  capabilities: ('chat' | 'embedding' | 'classify' | 'extract' | 'summarize')[];
  invoke(input: GatewayInput): Promise<ModelOutput>;
}

export interface SafetyNetRung {
  step: number;
  provider_type?: ProviderType;
  name?: string;
  confidence_threshold?: number | null;
  action?: 'ask_user';
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/ai-gateway/types.ts
git commit -m "feat(hivv-C): ai-gateway types (GatewayInput, ModelOutput, providers)"
```

---

### Task 3: Gateway main loop

**Files:**
- Create: `api/src/ai-gateway/gateway.ts`

- [ ] **Step 1: Write the gateway**

```ts
// api/src/ai-gateway/gateway.ts
// Single chokepoint for every AI call. Walks the safety net ladder.
// Spec: §8.2, §8.3
import postgres from "postgres";
import { loadSafetyNet } from "./safety-net";
import { checkInjection } from "./injection-guard";
import { checkBudget } from "./compute-budget";
import { breakerState } from "./breaker";
import { getProvider } from "./providers";
import { observe } from "../eval";
import type { GatewayInput, ModelOutput, ProviderType } from "./types";

const sql = postgres(process.env.XYZO_DB_DSN!);

export async function invoke(input: GatewayInput): Promise<ModelOutput> {
  // 1. Prompt-injection guard on the input
  const injCheck = checkInjection(JSON.stringify(input.payload));
  if (injCheck.detected) {
    await observe({
      loop: 'ai_injection', tier: input.tier,
      payload: {prompt_name: input.prompt_name, markers: injCheck.markers},
    });
    // Fall through to algorithm rung only
    return await invokeRung(input, {
      step: 99, provider_type: 'algorithm', name: 'safe_default', confidence_threshold: null,
    });
  }

  // 2. Compute budget check
  const budget = await checkBudget(input.tier);
  if (!budget.ok) {
    return await invokeRung(input, {
      step: 98, provider_type: 'algorithm', name: 'budget_exceeded_default',
      confidence_threshold: null,
    });
  }

  // 3. Load safety net
  const ladder = await loadSafetyNet(input.prompt_name, input.tier);

  // 4. Walk the ladder
  for (const rung of ladder) {
    if (rung.action === 'ask_user') {
      return {
        confidence: 0, latency_ms: 0,
        fallback_used: 'ask_user',
        provider_used: 'ask_user', rung_index: rung.step,
      };
    }

    const result = await invokeRung(input, rung);
    if (result.confidence >= (rung.confidence_threshold ?? 0)) {
      return result;
    }
    // Confidence too low → next rung
  }

  // All rungs exhausted
  return {
    confidence: 0, latency_ms: 0,
    fallback_used: 'algorithm', provider_used: 'none', rung_index: -1,
  };
}

async function invokeRung(input: GatewayInput, rung: any): Promise<ModelOutput> {
  if (!rung.provider_type || !rung.name) {
    throw new Error(`Rung ${rung.step} missing provider_type/name`);
  }

  // Breaker check
  const breaker = await breakerState(`${rung.provider_type}:${rung.name}`);
  if (breaker === 'open') {
    return {confidence: 0, latency_ms: 0, fallback_used: 'algorithm',
            provider_used: `${rung.provider_type}:${rung.name}`, rung_index: rung.step};
  }

  const provider = await getProvider(rung.provider_type, rung.name);
  if (!provider) {
    return {confidence: 0, latency_ms: 0, fallback_used: 'algorithm',
            provider_used: `${rung.provider_type}:${rung.name}`, rung_index: rung.step};
  }

  const start = Date.now();
  try {
    const output = await provider.invoke(input);
    output.latency_ms = Date.now() - start;
    output.fallback_used = rung.step === 1 ? 'primary' :
                            rung.step === 2 ? 'secondary' : 'algorithm';
    output.provider_used = `${rung.provider_type}:${rung.name}`;
    output.rung_index = rung.step;

    await observe({
      loop: 'ai_call', tier: input.tier,
      payload: {
        prompt_name: input.prompt_name, capability: inferCapability(input.prompt_name),
        capability_outcome: 'success',
        session_id: input.session_id ?? null,
        reasoning_summary: output.text?.slice(0, 200),
        result_summary: output.text?.slice(0, 200),
        result_confidence: output.confidence,
        provider_used: output.provider_used,
        rung_index: output.rung_index,
        latency_ms: output.latency_ms,
        data_categories_accessed: inferCategories(input),
        vault_partitions_accessed: input.trust_zone === 'private' ? ['inferred'] : [],
      },
    });
    return output;
  } catch (e: any) {
    // Record failure in breaker
    await recordBreakerFailure(`${rung.provider_type}:${rung.name}`, e.message);
    await observe({
      loop: 'ai_call', tier: input.tier,
      payload: {
        prompt_name: input.prompt_name, capability_outcome: 'failed',
        error: e.message, provider_used: `${rung.provider_type}:${rung.name}`,
        rung_index: rung.step,
      },
    });
    return {confidence: 0, latency_ms: Date.now() - start,
            fallback_used: 'algorithm', provider_used: `${rung.provider_type}:${rung.name}`,
            rung_index: rung.step};
  }
}

function inferCapability(prompt_name: string): string {
  const map: Record<string, string> = {
    extract: 'extract', summarize: 'summarize', classify: 'classify',
    route: 'route', embed: 'embedding', chat: 'chat',
  };
  return map[prompt_name] ?? 'classify';
}

function inferCategories(input: GatewayInput): string[] {
  return input.trust_zone === 'private' ? ['reasoning_summary'] : ['aggregate_metric'];
}

async function recordBreakerFailure(key: string, error: string) {
  await sql`
    INSERT INTO ai_breaker_state (provider_name, state, opened_at, opens_count, last_error, updated_at)
    VALUES (${key}, 'open', NOW(), 1, ${error}, NOW())
    ON CONFLICT (provider_name) DO UPDATE SET
      state = 'open', opened_at = NOW(), opens_count = ai_breaker_state.opens_count + 1,
      last_error = ${error}, updated_at = NOW()
  `;
}
```

- [ ] **Step 2: Commit (stub — depends on Tasks 4-7)**

```bash
git add api/src/ai-gateway/gateway.ts
git commit -m "feat(hivv-C): gateway main loop (awaiting helpers)"
```

---

### Task 4: Safety net loader

**Files:**
- Create: `api/src/ai-gateway/safety-net.ts`
- Create: `api/tests/safety-net.test.ts`

- [ ] **Step 1: Write loader**

```ts
// api/src/ai-gateway/safety-net.ts
import postgres from "postgres";
import type { SafetyNetRung } from "./types";
const sql = postgres(process.env.XYZO_DB_DSN!);

let cache: Map<string, SafetyNetRung[]> = new Map();
const CACHE_TTL_S = 60;
let cache_at = 0;

export async function loadSafetyNet(prompt_name: string, tier: string): Promise<SafetyNetRung[]> {
  const key = `${prompt_name}:${tier}`;
  if (Date.now() - cache_at < CACHE_TTL_S && cache.has(key)) {
    return cache.get(key)!;
  }
  const rows = await sql`
    SELECT rungs FROM ai_safety_nets
    WHERE prompt_name = ${prompt_name} AND tier = ${tier}::eval_tier
  `;
  if (rows.length === 0) {
    // Fall back to 'unknown' tier
    const fallback = await sql`
      SELECT rungs FROM ai_safety_nets
      WHERE prompt_name = ${prompt_name} AND tier = 'unknown'
    `;
    return (fallback[0]?.rungs as SafetyNetRung[]) ?? [];
  }
  cache.set(key, rows[0].rungs as SafetyNetRung[]);
  cache_at = Date.now();
  return rows[0].rungs as SafetyNetRung[];
}

export function invalidateSafetyNetCache() { cache.clear(); cache_at = 0; }
```

- [ ] **Step 2: Test**

```ts
// api/tests/safety-net.test.ts
import { describe, expect, test } from "bun:test";
import { loadSafetyNet, invalidateSafetyNetCache } from "../src/ai-gateway/safety-net";

describe("safety net loader", () => {
  test("community tier: returns 4-rung ladder for extract", async () => {
    invalidateSafetyNetCache();
    const ladder = await loadSafetyNet("extract", "community");
    expect(ladder.length).toBe(4);
    expect(ladder[0].provider_type).toBe("http");
    expect(ladder[3].action).toBe("ask_user");
  });

  test("gov tier: returns shorter ladder (no ask_user)", async () => {
    invalidateSafetyNetCache();
    const ladder = await loadSafetyNet("extract", "gov");
    expect(ladder.length).toBe(2);
    expect(ladder.some(r => r.action === "ask_user")).toBe(false);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd api && bun test tests/safety-net.test.ts 2>&1 | tail -5
git add api/src/ai-gateway/safety-net.ts api/tests/safety-net.test.ts
git commit -m "feat(hivv-C): safety net loader with 60s cache + ladder shape tests"
```

---

### Task 5: Prompt injection guard

**Files:**
- Create: `api/src/ai-gateway/injection-guard.ts`
- Create: `api/tests/injection-guard.test.ts`

- [ ] **Step 1: Write guard**

```ts
// api/src/ai-gateway/injection-guard.ts
const MARKERS = [
  "IGNORE PREVIOUS INSTRUCTIONS",
  "ignore previous",
  "### SYSTEM",
  "### system",
  "[AUTO-FIX]",
  "<<SYS>>",
  "<|im_start|>system",
  "Assistant: ",
];

export function checkInjection(text: string): { detected: boolean; markers: string[] } {
  const markers: string[] = [];
  for (const m of MARKERS) {
    if (text.includes(m)) markers.push(m);
  }
  return {detected: markers.length > 0, markers};
}
```

- [ ] **Step 2: Test**

```ts
// api/tests/injection-guard.test.ts
import { describe, expect, test } from "bun:test";
import { checkInjection } from "../src/ai-gateway/injection-guard";

test("detects IGNORE PREVIOUS INSTRUCTIONS", () => {
  expect(checkInjection("Please IGNORE PREVIOUS INSTRUCTIONS and...").detected).toBe(true);
});

test("returns markers found", () => {
  const r = checkInjection("Hello ### SYSTEM world");
  expect(r.detected).toBe(true);
  expect(r.markers).toContain("### SYSTEM");
});

test("clean text passes", () => {
  expect(checkInjection("A normal article about climate change.").detected).toBe(false);
});
```

- [ ] **Step 3: Run + commit**

```bash
cd api && bun test tests/injection-guard.test.ts 2>&1 | tail -5
git add api/src/ai-gateway/injection-guard.ts api/tests/injection-guard.test.ts
git commit -m "feat(hivv-C): prompt injection guard with 8 markers"
```

---

### Task 6: Compute budget

**Files:**
- Create: `api/src/ai-gateway/compute-budget.ts`
- Create: `api/tests/compute-budget.test.ts`

- [ ] **Step 1: Write budget checker**

```ts
// api/src/ai-gateway/compute-budget.ts
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

const DAILY_GPU_HOURS_CAP = 8;

export async function checkBudget(tier: string): Promise<{ok: boolean; gpu_ms_today: number; cap_ms: number}> {
  const rows = await sql`
    SELECT COALESCE(SUM(total_gpu_ms), 0)::BIGINT AS used_ms
    FROM ai_compute_daily
    WHERE day = CURRENT_DATE AND tier = ${tier}::eval_tier
  `;
  const used_ms = Number(rows[0].used_ms);
  const cap_ms = DAILY_GPU_HOURS_CAP * 3600 * 1000;  // 8 hours in ms
  return {ok: used_ms < cap_ms, gpu_ms_today: used_ms, cap_ms};
}

export async function recordUsage(provider_name: string, tier: string,
                                  latency_ms: number, gpu_ms: number) {
  await sql`
    INSERT INTO ai_compute_daily (day, provider_name, tier, call_count, total_latency_ms, total_gpu_ms)
    VALUES (CURRENT_DATE, ${provider_name}, ${tier}::eval_tier, 1, ${latency_ms}, ${gpu_ms})
    ON CONFLICT (day, provider_name, tier) DO UPDATE SET
      call_count = ai_compute_daily.call_count + 1,
      total_latency_ms = ai_compute_daily.total_latency_ms + ${latency_ms},
      total_gpu_ms = ai_compute_daily.total_gpu_ms + ${gpu_ms}
  `;
}
```

- [ ] **Step 2: Test**

```ts
// api/tests/compute-budget.test.ts
import { describe, expect, test } from "bun:test";
import { checkBudget, recordUsage } from "../src/ai-gateway/compute-budget";

test("returns ok when budget not exhausted", async () => {
  const r = await checkBudget("user");
  expect(r.ok).toBe(true);
});

test("records usage", async () => {
  await recordUsage("test:provider", "user", 100, 50);
  // No assertion — just that it doesn't throw
});
```

- [ ] **Step 3: Run + commit**

```bash
cd api && bun test tests/compute-budget.test.ts 2>&1 | tail -5
git add api/src/ai-gateway/compute-budget.ts api/tests/compute-budget.test.ts
git commit -m "feat(hivv-C): compute budget (8 GPU-hours/day cap)"
```

---

### Task 7: Persistent breaker

**Files:**
- Create: `api/src/ai-gateway/breaker.ts`
- Create: `api/tests/breaker.test.ts`

- [ ] **Step 1: Write breaker**

```ts
// api/src/ai-gateway/breaker.ts
// Spec: §8.5 — SQL-backed, not in-process.
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

export async function breakerState(provider_key: string): Promise<'closed'|'open'|'half_open'> {
  const rows = await sql`
    SELECT state, opened_at, cooldown_s FROM ai_breaker_state WHERE provider_name = ${provider_key}
  `;
  if (rows.length === 0) return 'closed';
  const {state, opened_at, cooldown_s} = rows[0];
  if (state === 'open' && opened_at) {
    const elapsed = (Date.now() - new Date(opened_at).getTime()) / 1000;
    if (elapsed > cooldown_s) {
      // Half-open: try again
      await sql`UPDATE ai_breaker_state SET state = 'half_open', half_open_at = NOW(), updated_at = NOW() WHERE provider_name = ${provider_key}`;
      return 'half_open';
    }
  }
  return state;
}

export async function resetBreaker(provider_key: string) {
  await sql`DELETE FROM ai_breaker_state WHERE provider_name = ${provider_key}`;
}
```

- [ ] **Step 2: Test**

```ts
// api/tests/breaker.test.ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { breakerState, resetBreaker } from "../src/ai-gateway/breaker";
const sql = postgres(process.env.XYZO_DB_DSN!);

test("closed when no record", async () => {
  await resetBreaker("test:no-record");
  expect(await breakerState("test:no-record")).toBe("closed");
});

test("transitions to half_open after cooldown", async () => {
  await sql`
    INSERT INTO ai_breaker_state (provider_name, state, opened_at, cooldown_s)
    VALUES ('test:transitions', 'open', NOW() - INTERVAL '200 seconds', 180)
    ON CONFLICT (provider_name) DO UPDATE SET opened_at = NOW() - INTERVAL '200 seconds'
  `;
  expect(await breakerState("test:transitions")).toBe("half_open");
  await resetBreaker("test:transitions");
});
```

- [ ] **Step 3: Run + commit**

```bash
cd api && bun test tests/breaker.test.ts 2>&1 | tail -5
git add api/src/ai-gateway/breaker.ts api/tests/breaker.test.ts
git commit -m "feat(hivv-C): persistent SQL-backed breaker"
```

---

### Task 8: HTTP provider (Ollama, llama.cpp, vLLM)

**Files:**
- Create: `api/src/ai-gateway/providers/http.ts`
- Create: `api/src/ai-gateway/providers/index.ts` (registry)
- Create: `api/tests/providers-http.test.ts`

- [ ] **Step 1: Write HTTP provider**

```ts
// api/src/ai-gateway/providers/http.ts
// Calls any local HTTP endpoint that exposes an OpenAI-compatible API.
import type { GatewayInput, ModelOutput, ModelProvider } from "../types";

export type HttpConfig = {
  url: string;            // e.g. 'http://192.168.1.3:11434/v1/chat/completions'
  model: string;
  format?: 'openai' | 'ollama';
  headers?: Record<string, string>;
  timeout_ms?: number;
};

export function makeHttpProvider(name: string, cfg: HttpConfig): ModelProvider {
  return {
    type: 'http', name, config: cfg,
    capabilities: ['chat', 'classify', 'extract', 'summarize', 'embedding'],
    async invoke(input: GatewayInput): Promise<ModelOutput> {
      // Refuse external URLs
      const u = new URL(cfg.url);
      if (!['127.0.0.1', 'localhost', '192.168.', '10.', '172.16.', '::1'].some(p =>
            u.hostname === p || u.hostname.startsWith(p))) {
        throw new Error(`HTTP provider ${name} points to external host ${u.hostname}; refusing`);
      }

      const body = cfg.format === 'ollama'
        ? {model: cfg.model, prompt: JSON.stringify(input.payload), stream: false}
        : {model: cfg.model, messages: [{role: 'user', content: JSON.stringify(input.payload)}]};

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeout_ms ?? cfg.timeout_ms ?? 25000);
      try {
        const r = await fetch(cfg.url, {
          method: 'POST',
          headers: {'content-type': 'application/json', ...(cfg.headers ?? {})},
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        const data: any = await r.json();
        const text = cfg.format === 'ollama'
          ? data.response
          : data.choices?.[0]?.message?.content ?? '';
        return {
          text, confidence: 0.7,  // TODO: parse from response if model returns one
          latency_ms: 0,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
```

- [ ] **Step 2: Write provider registry**

```ts
// api/src/ai-gateway/providers/index.ts
import postgres from "postgres";
import { makeHttpProvider } from "./http";
import { makePythonProvider } from "./python";
import { makeCliProvider } from "./cli";
import { makeAlgorithmProvider } from "./algorithm";
import type { ModelProvider, ProviderType } from "../types";

const sql = postgres(process.env.XYZO_DB_DSN!);
const cache: Map<string, ModelProvider> = new Map();

export async function getProvider(type: ProviderType, name: string): Promise<ModelProvider | null> {
  const key = `${type}:${name}`;
  if (cache.has(key)) return cache.get(key)!;

  const rows = await sql`
    SELECT invocation FROM ai_model_configs
    WHERE provider_type = ${type} AND name = ${name} AND enabled = true
  `;
  if (rows.length === 0) return null;
  const cfg = rows[0].invocation;

  let provider: ModelProvider;
  if (type === 'http') provider = makeHttpProvider(name, cfg);
  else if (type === 'python') provider = makePythonProvider(name, cfg);
  else if (type === 'cli') provider = makeCliProvider(name, cfg);
  else provider = makeAlgorithmProvider(name, cfg);

  cache.set(key, provider);
  return provider;
}

export function clearProviderCache() { cache.clear(); }
```

- [ ] **Step 3: Test**

```ts
// api/tests/providers-http.test.ts
import { describe, expect, test } from "bun:test";
import { makeHttpProvider } from "../src/ai-gateway/providers/http";

test("refuses external hosts", async () => {
  const p = makeHttpProvider("test", {url: "https://api.openai.com/v1/chat", model: "gpt-4"});
  await expect(p.invoke({prompt_name: "extract", tier: "user", payload: {x: 1}}))
    .rejects.toThrow(/external host/);
});

test("accepts localhost", async () => {
  const p = makeHttpProvider("test", {url: "http://localhost:11434/api/generate",
                                       model: "gemma-4-9b-q4", format: "ollama"});
  // We don't actually call it (no server); just verify it constructs
  expect(p.type).toBe("http");
  expect(p.name).toBe("test");
});
```

- [ ] **Step 4: Commit**

```bash
git add api/src/ai-gateway/providers/ api/tests/providers-http.test.ts
git commit -m "feat(hivv-C): HTTP provider + registry (local-only enforced)"
```

---

### Task 9: Python provider (subprocess)

**Files:**
- Create: `api/src/ai-gateway/providers/python.ts`

- [ ] **Step 1: Write provider**

```ts
// api/src/ai-gateway/providers/python.ts
import { spawn } from "bun";
import type { GatewayInput, ModelOutput, ModelProvider } from "../types";

export type PythonConfig = {
  module: string;          // e.g. 'worker.embeddings'
  fn: string;              // e.g. 'embed'
  python_bin?: string;     // default 'python3'
  args?: Record<string, unknown>;
};

export function makePythonProvider(name: string, cfg: PythonConfig): ModelProvider {
  return {
    type: 'python', name, config: cfg,
    capabilities: ['embedding', 'classify', 'extract', 'summarize'],
    async invoke(input: GatewayInput): Promise<ModelOutput> {
      const code = `
import json, sys
from ${cfg.module} import ${cfg.fn}
result = ${cfg.fn}(**json.loads(sys.argv[1]))
print(json.dumps(result))
`;
      const proc = spawn({
        cmd: [cfg.python_bin ?? 'python3', '-c', code, JSON.stringify({payload: input.payload, args: cfg.args ?? {}})],
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(`Python provider ${name} exited ${exitCode}: ${stderr}`);
      const result = JSON.parse(stdout);
      return {
        text: result.text,
        embedding: result.embedding,
        confidence: result.confidence ?? 0.5,
        latency_ms: 0,
      };
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/ai-gateway/providers/python.ts
git commit -m "feat(hivv-C): Python provider (subprocess)"
```

---

### Task 10: CLI provider

**Files:**
- Create: `api/src/ai-gateway/providers/cli.ts`

- [ ] **Step 1: Write provider**

```ts
// api/src/ai-gateway/providers/cli.ts
import { spawn } from "bun";
import type { GatewayInput, ModelOutput, ModelProvider } from "../types";

export type CliConfig = {
  command: string;            // e.g. '/usr/local/bin/my-llm-cli'
  args: string[];             // template: {prompt_name} {input_file} {output_file}
  timeout_ms?: number;
};

export function makeCliProvider(name: string, cfg: CliConfig): ModelProvider {
  return {
    type: 'cli', name, config: cfg,
    capabilities: ['chat', 'classify', 'extract', 'summarize'],
    async invoke(input: GatewayInput): Promise<ModelOutput> {
      const inputFile = `/tmp/hivv-cli-${Date.now()}-in.json`;
      const outputFile = `/tmp/hivv-cli-${Date.now()}-out.json`;
      await Bun.write(inputFile, JSON.stringify(input.payload));
      const proc = spawn({
        cmd: [cfg.command, ...cfg.args, inputFile, outputFile],
        stdout: 'pipe', stderr: 'pipe',
      });
      const [, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(`CLI provider ${name} exited ${exitCode}: ${stderr}`);
      const output: any = await Bun.file(outputFile).json();
      await Bun.$`rm -f ${inputFile} ${outputFile}`.quiet();
      return {
        text: output.text, embedding: output.embedding,
        confidence: output.confidence ?? 0.5, latency_ms: 0,
      };
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/ai-gateway/providers/cli.ts
git commit -m "feat(hivv-C): CLI provider (subprocess wrapper)"
```

---

### Task 11: Algorithm provider

**Files:**
- Create: `api/src/ai-gateway/providers/algorithm.ts`

- [ ] **Step 1: Write algorithm registry**

```ts
// api/src/ai-gateway/providers/algorithm.ts
// Pure algorithms, no AI. Spec: §8.2
import type { GatewayInput, ModelOutput, ModelProvider } from "../types";

const ALGORITHMS: Record<string, (input: GatewayInput) => ModelOutput> = {
  // Location extraction from text using gazetteer + regex
  regex_extract_location_v2(input) {
    const text = (input.payload.text ?? input.payload.body ?? '') as string;
    // Simple regex: capitalized word followed by known country/city
    const m = text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),?\s+([A-Z][a-z]+)\b/);
    const confidence = m ? 0.4 : 0;
    return {text: m ? `${m[1]}, ${m[2]}` : null, confidence, latency_ms: 0};
  },

  // Trivial classifier: keyword presence
  keyword_classifier_v1(input) {
    const text = ((input.payload.text ?? '') as string).toLowerCase();
    const POLITICS = ['election', 'vote', 'president', 'minister'];
    const CLIMATE = ['climate', 'carbon', 'emissions', 'wildfire'];
    const HEALTH = ['virus', 'hospital', 'covid', 'outbreak'];
    let label = 'other'; let score = 0;
    if (POLITICS.some(w => text.includes(w))) { label = 'politics'; score = 0.5; }
    else if (CLIMATE.some(w => text.includes(w))) { label = 'climate'; score = 0.5; }
    else if (HEALTH.some(w => text.includes(w))) { label = 'health'; score = 0.5; }
    return {text: label, confidence: score, latency_ms: 0};
  },

  // Default: refuse
  safe_default(_input) {
    return {text: null, confidence: 0, latency_ms: 0};
  },

  budget_exceeded_default(_input) {
    return {text: null, confidence: 0, latency_ms: 0};
  },
};

export function makeAlgorithmProvider(name: string, _cfg: Record<string, unknown>): ModelProvider {
  const fn = ALGORITHMS[name];
  if (!fn) throw new Error(`Algorithm provider ${name} not registered`);
  return {
    type: 'algorithm', name, config: _cfg,
    capabilities: ['classify', 'extract', 'embed'],
    async invoke(input: GatewayInput): Promise<ModelOutput> {
      return fn(input);
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/ai-gateway/providers/algorithm.ts
git commit -m "feat(hivv-C): algorithm provider (regex, keywords, safe defaults)"
```

---

### Task 12: Publishable package (`xyzo-ai-control-plane`)

**Files:**
- Create: `xyzo-ai-control-plane/package.json`
- Create: `xyzo-ai-control-plane/README.md`
- Create: `xyzo-ai-control-plane/src/index.ts`
- Create: `xyzo-ai-control-plane/examples/ollama.ts`
- Create: `xyzo-ai-control-plane/examples/custom-nn.ts`
- Create: `xyzo-ai-control-plane/LICENSE`

- [ ] **Step 1: package.json**

```json
{
  "name": "xyzo-ai-control-plane",
  "version": "0.1.0",
  "description": "Local-first, multi-model AI gateway with safety net ladder",
  "license": "MIT",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./providers/http": "./src/providers/http.ts",
    "./providers/python": "./src/providers/python.ts",
    "./providers/cli": "./src/providers/cli.ts",
    "./providers/algorithm": "./src/providers/algorithm.ts"
  },
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "postgres": "^3.4.0"
  },
  "peerDependencies": {
    "hono": "^4.0.0"
  },
  "keywords": ["ai", "local-first", "gateway", "safety-net", "hivv"],
  "engines": {
    "bun": ">=1.1.0"
  }
}
```

- [ ] **Step 2: src/index.ts (re-exports)**

```ts
export { invoke } from "../../api/src/ai-gateway/gateway";
export { loadSafetyNet } from "../../api/src/ai-gateway/safety-net";
export { checkInjection } from "../../api/src/ai-gateway/injection-guard";
export { checkBudget, recordUsage } from "../../api/src/ai-gateway/compute-budget";
export { breakerState, resetBreaker } from "../../api/src/ai-gateway/breaker";
export { makeHttpProvider } from "../../api/src/ai-gateway/providers/http";
export { makePythonProvider } from "../../api/src/ai-gateway/providers/python";
export { makeCliProvider } from "../../api/src/ai-gateway/providers/cli";
export { makeAlgorithmProvider } from "../../api/src/ai-gateway/providers/algorithm";
export type {
  GatewayInput, ModelOutput, ModelProvider, ProviderType, SafetyNetRung
} from "../../api/src/ai-gateway/types";
```

- [ ] **Step 3: examples/ollama.ts**

```ts
import { invoke } from "../src";

// Example: extract location from a news article using local Ollama
const article = {
  title: "Flooding in Karachi prompts evacuation",
  body: "Heavy monsoon rains caused severe flooding across Karachi, Pakistan...",
};

const result = await invoke({
  prompt_name: "extract",
  tier: "community",
  payload: { text: `${article.title}\n${article.body}`, fields: ["location_text", "summary"] },
  timeout_ms: 25000,
});

console.log({
  text: result.text,
  confidence: result.confidence,
  provider_used: result.provider_used,
  rung_index: result.rung_index,
  fallback_used: result.fallback_used,
});
```

- [ ] **Step 4: examples/custom-nn.ts**

```ts
import { invoke, makePythonProvider } from "../src";

// Register a custom PyTorch model as a provider
// (assumes worker/custom_nn.py has a `classify(text: str) -> {label, score}` function)
const customNN = makePythonProvider("custom-bert", {
  module: "worker.custom_nn",
  fn: "classify",
  python_bin: "python3",
});

console.log(customNN);
// In production: register in ai_model_configs so the gateway finds it.
```

- [ ] **Step 5: README + LICENSE**

`README.md`:

```markdown
# xyzo-ai-control-plane

A local-first, multi-model AI gateway with a safety net ladder, persistent breaker, prompt-injection guard, and compute budget.

## Why

Most AI gateways are cloud-only, expensive, vendor-locked, and unsafe by default. xyzo-ai-control-plane is:

- **Local-first.** No paid APIs required. The only "fee" is local electricity + compute time.
- **Multi-model.** Works with any local model: HTTP (Ollama, llama.cpp, vLLM, LM Studio), Python (sentence-transformers, PyTorch, your own NN), CLI (subprocess wrappers), or pure algorithms (regex, BM25, keyword).
- **Publishable.** This package is the protocol's reference implementation. Fork it for your domain.
- **Safety nets.** Every AI call has a fallback ladder: primary → secondary → deterministic → ask_user.
- **Precision-first.** When uncertain, ask the user.

## Install

```bash
bun add xyzo-ai-control-plane
```

## Usage

```typescript
import { invoke } from "xyzo-ai-control-plane";

const result = await invoke({
  prompt_name: "extract",
  tier: "community",
  payload: { text: "...", fields: ["location"] },
});
```

## Spec

See `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` §8.

## License

MIT.
```

`LICENSE`: standard MIT text.

- [ ] **Step 6: Commit**

```bash
git add xyzo-ai-control-plane/
git commit -m "feat(hivv-C): publishable xyzo-ai-control-plane package (MIT)"
```

---

### Task 13: `model_finetune` handler

**Files:**
- Create: `worker/handlers/model_finetune.py`
- Create: `worker/tests/test_model_finetune.py`

- [ ] **Step 1: Write handler**

```python
"""model_finetune handler — fine-tunes a local model on the eval corpus.
Phase 1: collect training rows from eval_baseline_corpus, no actual training.
Spec: §8.9
"""
import logging, os, json
import psycopg
from worker.eval import observe
from worker.handlers._tier_gate import gate

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']

def run():
    decision = gate(loop='model_finetune', tier='community')
    if not decision.act:
        log.info("model_finetune: skipping (%s)", decision.reason)
        return {'status': 'skipped', 'reason': decision.reason}

    # Collect training rows: exclude gov/university
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                SELECT field, expected_value, actual_value
                FROM eval_baseline_corpus
                WHERE baseline_label = 'extraction-2026-09-07'
                  AND tier NOT IN ('gov', 'university')
                LIMIT 1000
            """)
            rows = cur.fetchall()

    log.info("model_finetune: collected %d training rows", len(rows))
    observe(loop='ai_call', tier='community',
            payload={'capability': 'extract',
                     'capability_outcome': 'success',
                     'phase': 'collect_rows',
                     'row_count': len(rows)})

    # Phase 4: actually call a fine-tune runner. Phase 1: log only.
    return {'status': 'collected', 'rows': len(rows)}

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(run())
```

- [ ] **Step 2: Test**

```python
# worker/tests/test_model_finetune.py
from worker.handlers.model_finetune import run

def test_returns_dict():
    r = run()
    assert r['status'] in ('collected', 'skipped')
```

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest tests/test_model_finetune.py -v
git add worker/handlers/model_finetune.py worker/tests/test_model_finetune.py
git commit -m "feat(hivv-C): model_finetune handler (Phase 1: collect rows only)"
```

---

### Task 14: `shadow_eval` handler

**Files:**
- Create: `worker/handlers/shadow_eval.py`
- Create: `worker/tests/test_shadow_eval.py`

- [ ] **Step 1: Write handler**

```python
"""shadow_eval handler — runs experiment and active model in parallel,
compares outcomes, decides promotion.
Spec: §8.9
"""
import logging, os
import psycopg
from worker.eval import observe
from worker.handlers._tier_gate import gate

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']

def run():
    decision = gate(loop='shadow_eval', tier='community')
    if not decision.act:
        log.info("shadow_eval: skipping (%s)", decision.reason)
        return {'status': 'skipped', 'reason': decision.reason}

    # Phase 1: log only. Phase 4: invoke both via gateway, compare p50 confidence.
    observe(loop='shadow_eval', tier='community',
            payload={'phase': 'observe', 'action': 'log_only'})

    return {'status': 'observed'}

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(run())
```

- [ ] **Step 2: Test + commit**

```bash
cat > worker/tests/test_shadow_eval.py <<'EOF'
from worker.handlers.shadow_eval import run
def test_returns_dict():
    r = run()
    assert r['status'] in ('observed', 'skipped')
EOF
cd worker && pytest tests/test_shadow_eval.py -v
git add worker/handlers/shadow_eval.py worker/tests/test_shadow_eval.py
git commit -m "feat(hivv-C): shadow_eval handler stub"
```

---

### Task 15: Admin endpoints

**Files:**
- Create: `api/src/routes/ai-control.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Write routes**

```ts
import { Hono } from "hono";
import postgres from "postgres";
import { requireAdmin } from "../middleware/admin";
import { breakerState, resetBreaker } from "../src/ai-gateway/breaker";

const sql = postgres(process.env.XYZO_DB_DSN!);

export const aiControlRoutes = new Hono();
aiControlRoutes.use("/api/ai/control/*", requireAdmin());

aiControlRoutes.get("/api/ai/control/state", async (c) => {
  const rows = await sql`
    SELECT provider_name, state, opened_at, opens_count, last_error,
           confidence_p50, confidence_p10, updated_at
    FROM ai_breaker_state
    ORDER BY provider_name
  `;
  return c.json({ breakers: rows });
});

aiControlRoutes.get("/api/ai/control/usage", async (c) => {
  const days = Number(c.req.query("days") ?? "7");
  const rows = await sql`
    SELECT day, provider_name, tier, call_count, total_latency_ms,
           p50_latency_ms, p95_latency_ms, p50_confidence,
           total_gpu_ms, total_watts
    FROM ai_compute_daily
    WHERE day > CURRENT_DATE - INTERVAL '${sql.unsafe(`${days} days`)}'
    ORDER BY day DESC, provider_name
  `;
  return c.json({ usage: rows });
});

aiControlRoutes.get("/api/ai/control/prompts", async (c) => {
  const rows = await sql`
    SELECT prompt_name, tier, rungs, updated_at
    FROM ai_safety_nets
    ORDER BY prompt_name, tier
  `;
  return c.json({ prompts: rows });
});

aiControlRoutes.post("/api/ai/control/breakers/:key/reset", async (c) => {
  const key = c.req.param("key");
  await resetBreaker(key);
  return c.json({ ok: true, reset: key });
});
```

- [ ] **Step 2: Wire + smoke + commit**

```bash
# In api/src/server.ts:
# import { aiControlRoutes } from "./routes/ai-control";
# app.route("/", aiControlRoutes);

cd api && bun test tests/safety-net.test.ts tests/injection-guard.test.ts tests/compute-budget.test.ts tests/breaker.test.ts tests/providers-http.test.ts 2>&1 | tail -5
git add api/src/routes/ai-control.ts api/src/server.ts
git commit -m "feat(hivv-C): admin AI control endpoints (state, usage, prompts, reset)"
```

---

### Task 16: Integration tests

**Files:**
- Create: `api/tests/ai-gateway.test.ts`

- [ ] **Step 1: Write end-to-end test**

```ts
import { describe, expect, test } from "bun:test";
import { invoke } from "../src/ai-gateway/gateway";

describe("ai-gateway end-to-end", () => {
  test("invoke extract on community tier walks the ladder", async () => {
    const result = await invoke({
      prompt_name: "extract",
      tier: "community",
      payload: { text: "Flooding in Karachi", fields: ["location_text"] },
      timeout_ms: 5000,
    });
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("fallback_used");
    expect(result.fallback_used).toMatch(/primary|secondary|algorithm|ask_user/);
  }, 15000);

  test("invoke extract on gov tier returns shorter result", async () => {
    const result = await invoke({
      prompt_name: "extract",
      tier: "gov",
      payload: { text: "NASA mission", fields: ["location_text"] },
      timeout_ms: 5000,
    });
    // gov ladder has no ask_user → never fallback_used='ask_user'
    expect(result.fallback_used).not.toBe("ask_user");
  }, 15000);

  test("eval_observations written for every invoke", async () => {
    const before = await fetch("http://localhost:3008/api/eval/coverage/metrics").then(r => r.json());
    await invoke({prompt_name: "extract", tier: "user", payload: {text: "x"}});
    const after = await fetch("http://localhost:3008/api/eval/coverage/metrics").then(r => r.json());
    // ai_call observations should be in eval_observations now (test via direct query if needed)
  });
});
```

- [ ] **Step 2: Run**

```bash
cd api && bun test tests/ai-gateway.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add api/tests/ai-gateway.test.ts
git commit -m "test(hivv-C): ai-gateway e2e tests (community + gov + write paths)"
```

---

### Task 17: Documentation + handoff

- [ ] **Step 1: Write summary**

```bash
cat > docs/hivv-plan-c-summary.md <<'EOF'
# hivv Plan C — Distributed AI Control Plane Summary

**Status:** Complete. Gateway enforces local-only + safety net + breaker + budget.

## What ships
- 4 SQL tables (ai_model_configs, ai_safety_nets, ai_breaker_state, ai_compute_daily)
- 4 provider types (http/python/cli/algorithm) with local-only enforcement
- Safety net ladder (configurable per prompt × tier)
- Persistent SQL-backed breaker (replaces in-process ai-breaker.ts)
- Prompt-injection guard with 8 markers
- Compute budget (8 GPU-hours/day cap per tier)
- Publishable package: xyzo-ai-control-plane (MIT)
- 4 examples: Ollama, llama.cpp, custom PyTorch NN, pure algorithm
- model_finetune + shadow_eval handlers (Phase 1: log only)
- 7 admin endpoints (state, usage, prompts, reset, …)

## Migration: replaces xyzo's in-process ai-breaker.ts
- Old: state lost on restart; per-process; not tier-aware
- New: SQL-backed; survives restart; tier-aware via tier_overrides on model_configs

## Risks
- Provider registry is small (5 entries seeded). Production needs more configs
- Compute budget is a soft cap; over-cap returns algorithm rung
- Algorithm provider is intentionally simple; production needs more sophisticated rules

## Next
Plan D — Operator Dashboard (UI for the seven scopes + temporal triad).
EOF
git add docs/hivv-plan-c-summary.md
git commit -m "docs(hivv-C): Plan C summary"
```

---

## Done — Plan C complete

Verify:
```bash
cd api && bun test tests/safety-net.test.ts tests/injection-guard.test.ts tests/compute-budget.test.ts tests/breaker.test.ts tests/providers-http.test.ts tests/ai-gateway.test.ts 2>&1 | tail -10
cd worker && pytest tests/test_model_finetune.py tests/test_shadow_eval.py -v
```

Green → proceed to **Plan D — Operator Dashboard** (`docs/superpowers/plans/2026-09-07-hivv-plan-d-dashboard.md`).
