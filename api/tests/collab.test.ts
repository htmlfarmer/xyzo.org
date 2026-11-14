// Tests for the /api/collab/* routes.
//
// These run without a populated DB — they verify request shape, auth gates,
// and response codes. Production-data audits belong in
// `collab-data-validity.test.ts` (gated by XYO_RUN_DATA_VALIDITY=1).
//
// IMPORTANT: tests in this file use Hono's test request helper. They do NOT
// require a DB connection. The collab_nodes / collab_jobs / collab_activity
// tables are read/written via getDb(), so we mock that with a stub.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { collabRoute } from "../src/routes/collab";

// ── DB stub ──────────────────────────────────────────────────────────────
// The collab routes call getDb() once per request. We swap it for a fake
// that records SQL strings and returns rows we control. This lets us test
// auth gates and shapes without a Postgres.

type Row = Record<string, any>;

interface FakeDb {
  nodes: Row[];
  jobs: Row[];
  activity: Row[];
  sqlCalls: { sql: string; params: any[] }[];
}

function makeFakeDb(): FakeDb {
  return { nodes: [], jobs: [], activity: [], sqlCalls: [] };
}

function installFakeDb(db: FakeDb) {
  // Build a postgres-js-like function that supports tagged-template usage.
  // `sql<any[]>` is generic on a callable, so we use a callable proxy.
  const sqlFn: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    db.sqlCalls.push({ sql, params: values });
    return execSql(db, sql, values);
  };
  sqlFn.unsafe = () => {
    throw new Error("sql.unsafe not supported in test stub");
  };
  mock.module("../src/db.js", () => ({
    getDb: () => sqlFn,
  }));
}

function execSql(db: FakeDb, sql: string, params: any[]): any[] {
  // Normalize: collapse all whitespace so newlines between tokens don't
  // break startsWith checks.
  const flat = sql.replace(/\s+/g, " ").trim();
  const upper = flat.toUpperCase();

  // INSERT INTO collab_nodes RETURNING
  if (upper.startsWith("INSERT INTO COLLAB_NODES")) {
    const node_id = params[0];
    const name = params[1];
    const token = params[7];
    db.nodes.push({
      node_id,
      name,
      roles: params[4],
      status: "active",
      dashboard_token: token,
    });
    return [{ node_id }];
  }

  // SELECT id, node_id, name, roles, status, dashboard_token FROM collab_nodes WHERE node_id=...
  if (upper.includes("FROM COLLAB_NODES") && upper.includes("DASHBOARD_TOKEN") && upper.includes("WHERE NODE_ID")) {
    const nodeId = params[0];
    return db.nodes.filter((n) => n.node_id === nodeId);
  }

  // UPDATE collab_nodes SET last_heartbeat_at = ...
  if (upper.startsWith("UPDATE COLLAB_NODES SET LAST_HEARTBEAT_AT")) {
    const nodeId = params[params.length - 1];
    const n = db.nodes.find((x) => x.node_id === nodeId);
    if (n) n.last_heartbeat_at = new Date().toISOString();
    return [];
  }

  // SELECT COUNT(*) FROM collab_activity WHERE ...
  if (upper.startsWith("SELECT COUNT(*)::INT AS N FROM COLLAB_ACTIVITY")) {
    return [{ n: 0 }];
  }

  // INSERT INTO collab_activity
  if (upper.startsWith("INSERT INTO COLLAB_ACTIVITY")) {
    db.activity.push({ node_id: params[0], action: params[1] });
    return [];
  }

  // SELECT ... FROM collab_jobs WHERE status='queued'
  if (upper.includes("FROM COLLAB_JOBS") && upper.includes("STATUS = 'QUEUED'")) {
    const limit = params.find((p) => typeof p === "number" && p < 1000) || 10;
    return db.jobs.filter((j) => j.status === "queued").slice(0, limit);
  }

  // UPDATE collab_jobs SET status='claimed', claimed_by=?, claimed_at=now() WHERE id=? AND status='queued' RETURNING
  // params[0] = nodeId, params[1] = jobId (because nodeId appears first in the SQL).
  if (upper.startsWith("UPDATE COLLAB_JOBS SET STATUS = 'CLAIMED'")) {
    const claimedBy = params[0];
    const jobId = params[1];
    const j = db.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== "queued") return [];
    j.status = "claimed";
    j.claimed_by = claimedBy;
    return [j];
  }

  // SELECT status, claimed_by FROM collab_jobs WHERE id = ?
  if (upper.includes("FROM COLLAB_JOBS") && upper.includes("CLAIMED_BY") && !upper.includes("COUNT")) {
    const jobId = params[0];
    const j = db.jobs.find((x) => x.id === jobId);
    return j ? [{ status: j.status, claimed_by: j.claimed_by }] : [];
  }

  // UPDATE collab_jobs SET status = ?
  if (upper.startsWith("UPDATE COLLAB_JOBS SET STATUS =")) {
    const status = params[0];
    const jobId = params[params.length - 1];
    const j = db.jobs.find((x) => x.id === jobId);
    if (j) j.status = status;
    return [];
  }

  // INSERT INTO collab_jobs RETURNING id
  if (upper.startsWith("INSERT INTO COLLAB_JOBS")) {
    const job = {
      id: db.jobs.length + 1,
      kind: params[0],
      payload: params[1],
      priority: params[2],
      source: params[3],
      timeout_seconds: params[4],
      status: "queued",
    };
    db.jobs.push(job);
    return [{ id: job.id }];
  }

  // SELECT ... FROM collab_nodes n LEFT JOIN ... (list query)
  if (upper.includes("FROM COLLAB_NODES N")) {
    return db.nodes.map((n) => ({
      node_id: n.node_id,
      name: n.name,
      roles: n.roles,
      os: n.os,
      arch: n.arch,
      collabd_version: n.collabd_version,
      registered_at: n.registered_at,
      last_heartbeat_at: n.last_heartbeat_at,
      jobs_done: 0,
      jobs_failed: 0,
    }));
  }

  // SELECT node_id, name, roles, os, arch, collabd_version FROM collab_nodes WHERE node_id = ?
  if (upper.includes("FROM COLLAB_NODES") && upper.includes("COLLABD_VERSION")) {
    const nodeId = params[0];
    return db.nodes.filter((n) => n.node_id === nodeId);
  }

  // SELECT action, detail, created_at FROM collab_activity WHERE node_id = ?
  if (upper.startsWith("SELECT ACTION, DETAIL, CREATED_AT FROM COLLAB_ACTIVITY")) {
    return db.activity.slice(0, 50);
  }

  // SELECT COUNT(*) FILTER ... FROM collab_activity
  if (upper.includes("FROM COLLAB_ACTIVITY") && upper.includes("FILTER")) {
    return [{ jobs_done: 0, jobs_failed: 0, jobs_claimed: 0, total_events: db.activity.length }];
  }

  // Default: return empty so the route can branch on .length.
  return [];
}

// ── Test helpers ─────────────────────────────────────────────────────────

const PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtnTestKeyForUnitTestingPurposesOnlyDoNotUse1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ==
-----END PUBLIC KEY-----`;

function makeApp() {
  const app = new Hono();
  app.route("/api", collabRoute);
  return app;
}

let db: FakeDb;
beforeEach(() => {
  db = makeFakeDb();
  installFakeDb(db);
});
afterEach(() => {
  mock.restore();
});

// ── /api/collab/register ─────────────────────────────────────────────────

// Per-test IP counter so the rate limiter doesn't bleed across tests.
let testIpCounter = 0;
function setTestIp(headers: Record<string, string> = {}): Record<string, string> {
  testIpCounter++;
  return { ...headers, "x-forwarded-for": `10.0.0.${testIpCounter}` };
}

describe("POST /api/collab/register", () => {
  test("rejects non-PEM public_key", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/register", {
      method: "POST",
      headers: setTestIp({ "content-type": "application/json" }),
      body: JSON.stringify({
        public_key: "not a pem",
        os: "linux",
        arch: "x86_64",
      }),
    });
    // zValidator (min(100)) fires first; the route's PEM check is a backup.
    // Either way the response should be 400.
    expect(res.status).toBe(400);
  });

  test("rejects missing os", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/register", {
      method: "POST",
      headers: setTestIp({ "content-type": "application/json" }),
      body: JSON.stringify({
        public_key: PEM,
        arch: "x86_64",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("creates a node and returns a 12-char node_id + token", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/register", {
      method: "POST",
      headers: setTestIp({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "test-box",
        public_key: PEM,
        os: "linux",
        arch: "x86_64",
        python_version: "3.11.4",
        collabd_version: "0.1.0",
        roles: ["scripts"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.node_id).toMatch(/^[a-z2-7]{12}$/);
    expect(typeof body.dashboard_token).toBe("string");
    expect(body.dashboard_token.length).toBeGreaterThan(20);
    expect(body.roles).toEqual(["scripts"]);
    expect(body.dashboard_url).toBe(`/collab/node/${body.node_id}`);
  });

  test("rejects malformed PEM (right length, no header/footer)", async () => {
    const app = makeApp();
    const garbage = "x".repeat(300); // passes min(100), fails the PEM regex
    const res = await app.request("/api/collab/register", {
      method: "POST",
      headers: setTestIp({ "content-type": "application/json" }),
      body: JSON.stringify({
        public_key: garbage,
        os: "linux",
        arch: "x86_64",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("public_key_must_be_pem");
  });

  test("rate-limits a 6th registration from the same IP within an hour", async () => {
    const app = makeApp();
    const ip = `10.99.99.${++testIpCounter}`;
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/api/collab/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ public_key: PEM, os: "linux", arch: "x86_64" }),
      });
      expect(r.status).toBe(201);
    }
    const r = await app.request("/api/collab/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ public_key: PEM, os: "linux", arch: "x86_64" }),
    });
    expect(r.status).toBe(429);
  });
});

// ── /api/collab/:node_id/heartbeat ────────────────────────────────────────

describe("POST /api/collab/:node_id/heartbeat", () => {
  test("rejects missing bearer token", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/abc234def567/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uptime_s: 30 }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects bad node_id format", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/NOT_VALID/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("rejects unknown node", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/abc234def567/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ uptime_s: 30 }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects bad bearer token", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "right-token", roles: ["scripts"], status: "active" });
    const app = makeApp();
    const res = await app.request("/api/collab/abc234def567/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ uptime_s: 30 }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts a valid heartbeat with the right token", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "good-token", roles: ["scripts"], status: "active" });
    const app = makeApp();
    const res = await app.request("/api/collab/abc234def567/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({ uptime_s: 42, jobs_done: 3, jobs_failed: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.next_heartbeat_s).toBe(30);
  });
});

// ── /api/collab/jobs ─────────────────────────────────────────────────────

describe("GET /api/collab/jobs", () => {
  test("returns empty list when no queued jobs", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/jobs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toEqual([]);
  });

  test("returns up to limit queued jobs", async () => {
    db.jobs.push({ id: 1, kind: "shell", payload: {}, priority: 100, timeout_seconds: 60, status: "queued", created_at: new Date() });
    db.jobs.push({ id: 2, kind: "shell", payload: {}, priority: 100, timeout_seconds: 60, status: "queued", created_at: new Date() });
    const app = makeApp();
    const res = await app.request("/api/collab/jobs?limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(2);
  });
});

// ── /api/collab/jobs/:id/claim ────────────────────────────────────────────

describe("POST /api/collab/jobs/:id/claim", () => {
  test("rejects missing node_id query param", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/jobs/1/claim", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("claims a queued job atomically", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "good-token", roles: ["scripts"], status: "active" });
    db.jobs.push({ id: 99, kind: "shell", payload: { command: "echo hi" }, priority: 100, timeout_seconds: 30, status: "queued" });
    const app = makeApp();
    const res = await app.request("/api/collab/jobs/99/claim?node_id=abc234def567", {
      method: "POST",
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.id).toBe(99);
    expect(db.jobs[0].status).toBe("claimed");
    expect(db.jobs[0].claimed_by).toBe("abc234def567");
  });

  test("returns 409 when another node already claimed it", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "good-token", roles: ["scripts"], status: "active" });
    db.jobs.push({ id: 99, kind: "shell", payload: {}, priority: 100, status: "running", claimed_by: "othernode1" });
    const app = makeApp();
    const res = await app.request("/api/collab/jobs/99/claim?node_id=abc234def567", {
      method: "POST",
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(409);
  });
});

// ── /api/collab/jobs/:id/result ───────────────────────────────────────────

describe("POST /api/collab/jobs/:id/result", () => {
  test("rejects result from a different node than the claimer", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "good-token", roles: ["scripts"], status: "active" });
    db.jobs.push({ id: 99, kind: "shell", payload: {}, status: "claimed", claimed_by: "othernode1" });
    const app = makeApp();
    const res = await app.request("/api/collab/jobs/99/result", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({ node_id: "abc234def567", exit_code: 0, duration_ms: 50 }),
    });
    expect(res.status).toBe(403);
  });

  test("records a successful result as 'done'", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "good-token", roles: ["scripts"], status: "active" });
    db.jobs.push({ id: 99, kind: "shell", payload: {}, status: "claimed", claimed_by: "abc234def567" });
    const app = makeApp();
    const res = await app.request("/api/collab/jobs/99/result", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({
        node_id: "abc234def567",
        exit_code: 0,
        stdout: "hello\n",
        stderr: "",
        duration_ms: 123,
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("done");
    expect(db.jobs[0].status).toBe("done");
  });

  test("records a non-zero exit as 'failed'", async () => {
    db.nodes.push({ node_id: "abc234def567", dashboard_token: "good-token", roles: ["scripts"], status: "active" });
    db.jobs.push({ id: 99, kind: "shell", payload: {}, status: "claimed", claimed_by: "abc234def567" });
    const app = makeApp();
    const res = await app.request("/api/collab/jobs/99/result", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({
        node_id: "abc234def567",
        exit_code: 7,
        duration_ms: 50,
        error_message: "boom",
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("failed");
  });
});

// ── /api/collab/jobs (admin submit) ──────────────────────────────────────

describe("POST /api/collab/jobs (admin)", () => {
  // Admin auth is gated; we stub it out for these tests.
  beforeEach(() => {
    mock.module("../src/auth", () => ({
      adminAuth: async () => ({ ok: true }),
    }));
  });

  test("enqueues a job for a node to claim", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "shell",
        payload: { command: "echo hi" },
        priority: 50,
        source: "blnq",
        timeout_seconds: 60,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.job_id).toBe("number");
    expect(db.jobs.length).toBe(1);
    expect(db.jobs[0].source).toBe("blnq");
  });
});

// ── /api/collab/nodes + /api/collab/node/:id ─────────────────────────────

describe("GET /api/collab/nodes", () => {
  test("lists active nodes", async () => {
    db.nodes.push({ node_id: "abc234def567", name: "box-a", roles: ["scripts"], status: "active" });
    db.nodes.push({ node_id: "xyz234def567", name: "box-b", roles: ["scripts", "gateway"], status: "active" });
    const app = makeApp();
    const res = await app.request("/api/collab/nodes");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.length).toBe(2);
  });
});

describe("GET /api/collab/node/:id", () => {
  test("404s on unknown node", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/node/abc234def567");
    expect(res.status).toBe(404);
  });

  test("rejects bad node_id format", async () => {
    const app = makeApp();
    const res = await app.request("/api/collab/node/BAD!");
    expect(res.status).toBe(400);
  });

  test("returns node + activity + stats", async () => {
    db.nodes.push({
      node_id: "abc234def567",
      name: "box-a",
      roles: ["scripts"],
      os: "linux",
      arch: "x86_64",
      collabd_version: "0.1.0",
      registered_at: new Date(),
      status: "active",
    });
    db.activity.push({ node_id: "abc234def567", action: "register" });
    const app = makeApp();
    const res = await app.request("/api/collab/node/abc234def567");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.node.node_id).toBe("abc234def567");
    expect(body.activity.length).toBe(1);
    expect(body.stats_7d.total_events).toBe(1);
  });
});
