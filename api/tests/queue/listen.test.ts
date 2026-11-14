import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { getDb } from "../../src/db";
import { waitForJobTerminal, shutdownListenPool } from "../../src/queue/listenClientPool";
import { enqueue, claimNext, markComplete, markFailed, markCancelled } from "../../src/queue/jobQueue";

const sql = getDb();

// Long enough for sql.listen() handshake to complete before NOTIFY fires.
const NOTIFY_DELAY_MS = 50;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by = 'test'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await shutdownListenPool();
});

describe("waitForJobTerminal", () => {
  test("resolves immediately when job is already terminal (fast path)", async () => {
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    await markComplete(j.id, { answer: 42 });
    const result = await waitForJobTerminal(j.id, 5000);
    expect(result.id).toBe(j.id);
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ answer: 42 });
  });

  test("waits for NOTIFY and resolves when terminal arrives", async () => {
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    // Start waiting first (no fast path; status is 'claimed').
    const promise = waitForJobTerminal(j.id, 5000);
    // Trigger NOTIFY after a short delay.
    setTimeout(() => {
      markComplete(j.id, { result: "ok" })
        .then(() =>
          sql`SELECT pg_notify('job_status_changed', ${JSON.stringify({ ids: [j.id] })}::text)`,
        )
        .catch(console.error);
    }, NOTIFY_DELAY_MS);
    const result = await promise;
    expect(result.id).toBe(j.id);
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ result: "ok" });
  });

  test("rejects with timeout if NOTIFY never arrives", async () => {
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    // Don't fire NOTIFY. Expect timeout.
    await expect(waitForJobTerminal(j.id, 100)).rejects.toThrow(/did not complete within/i);
  });

  test("rejects with error message when terminal status is failed", async () => {
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    const promise = waitForJobTerminal(j.id, 5000);
    setTimeout(() => {
      markFailed(j.id, "synthetic error", "traceback\n  at line 1")
        .then(() =>
          sql`SELECT pg_notify('job_status_changed', ${JSON.stringify({ ids: [j.id] })}::text)`,
        )
        .catch(console.error);
    }, NOTIFY_DELAY_MS);
    await expect(promise).rejects.toThrow(/synthetic error/);
  });

  test("rejects with cancellation message when status is cancelled", async () => {
    const j = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    await claimNext("w1");
    const promise = waitForJobTerminal(j.id, 5000);
    setTimeout(() => {
      markCancelled(j.id)
        .then(() =>
          sql`SELECT pg_notify('job_status_changed', ${JSON.stringify({ ids: [j.id] })}::text)`,
        )
        .catch(console.error);
    }, NOTIFY_DELAY_MS);
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  test("ignores NOTIFY for other job ids", async () => {
    const a = await enqueue("auto_categorize", { x: 1 }, { enqueuedBy: "test" });
    const b = await enqueue("auto_categorize", { y: 2 }, { enqueuedBy: "test" });
    await claimNext("w1");
    await claimNext("w2");
    // Wait for job A.
    const promiseA = waitForJobTerminal(a.id, 2000);
    // Complete B first; A's waiter should ignore this NOTIFY.
    setTimeout(() => {
      markComplete(b.id, { who: "b" })
        .then(() =>
          sql`SELECT pg_notify('job_status_changed', ${JSON.stringify({ ids: [b.id] })}::text)`,
        )
        .then(() => markComplete(a.id, { who: "a" }))
        .then(() =>
          sql`SELECT pg_notify('job_status_changed', ${JSON.stringify({ ids: [a.id] })}::text)`,
        )
        .catch(console.error);
    }, NOTIFY_DELAY_MS);
    const result = await promiseA;
    expect(result.id).toBe(a.id);
    expect(result.result).toEqual({ who: "a" });
  });
});
