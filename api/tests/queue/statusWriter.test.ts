import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { getDb } from "../../src/db";
import { StatusWriter } from "../../src/queue/statusWriter";
import { enqueue, claimNext } from "../../src/queue/jobQueue";

const sql = getDb();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by = 'test'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  // DO NOT call closeDb() — shared cached connection stays alive for sibling tests.
});

describe("StatusWriter", () => {
  test("flushes after the configured timer fires", async () => {
    const sw = new StatusWriter({ flushIntervalMs: 50 });
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    sw.enqueue({ id: j.id, state: { step: "a", progress: 10 } });
    sw.enqueue({ id: j.id, state: { step: "b", progress: 50 } });
    expect(sw.pendingSize).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(sw.pendingSize).toBe(0);
    // DB should reflect last-write-wins
    const [row] = await sql`SELECT state FROM discovery_jobs WHERE id = ${j.id}::uuid`;
    expect(row.state).toEqual({ step: "b", progress: 50 });
  });

  test("flushes immediately when 10 events queue up", async () => {
    const sw = new StatusWriter({ flushIntervalMs: 10_000 });
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    for (let i = 0; i < 10; i++) {
      sw.enqueue({ id: j.id, state: { pct: i } });
    }
    // Should have flushed by now (10-event threshold)
    await new Promise((r) => setTimeout(r, 50));
    expect(sw.pendingSize).toBe(0);
  });

  test("terminal events bypass timer and emit NOTIFY", async () => {
    const sw = new StatusWriter({ flushIntervalMs: 10_000 });
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    let notified: string[] = [];
    sw.onTerminalFlush((ids) => {
      notified = ids;
    });
    await sw.enqueueTerminal(j.id, { status: "completed", result: { ok: 1 } });
    expect(notified).toContain(j.id);
  });
});
