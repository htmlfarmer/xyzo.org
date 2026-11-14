import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { getDb } from "../../src/db";
import { enqueue, claimNext, getJob } from "../../src/queue/jobQueue";
import { runSweep } from "../../src/queue/staleClaimSweeper";

const sql = getDb();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by = 'test'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
});

describe("staleClaimSweeper.runSweep", () => {
  test("resets claimed job with stale heartbeat", async () => {
    const j = await enqueue(
      "auto_categorize",
      { x: 1 },
      { enqueuedBy: "test", maxAttempts: 3 },
    );
    await claimNext("w1");
    // Backdate heartbeat to 60s ago.
    await sql`UPDATE discovery_jobs SET heartbeat_at = now() - INTERVAL '60 seconds' WHERE id = ${j.id}::uuid`;
    const reset = await runSweep();
    expect(reset.reset).toBe(1);
    const fetched = await getJob(j.id);
    expect(fetched?.status).toBe("queued");
    expect(fetched?.worker_id).toBeNull();
    expect(fetched?.heartbeat_at).toBeNull();
    expect(fetched?.attempts).toBe(1);
  });

  test("does not touch fresh claimed jobs", async () => {
    const j = await enqueue(
      "auto_categorize",
      { x: 1 },
      { enqueuedBy: "test" },
    );
    await claimNext("w1");
    const reset = await runSweep();
    expect(reset.reset).toBe(0);
    const fetched = await getJob(j.id);
    expect(fetched?.status).toBe("claimed");
  });

  test("marks failed when attempts >= max_attempts after reset", async () => {
    const j = await enqueue(
      "auto_categorize",
      { x: 1 },
      { enqueuedBy: "test", maxAttempts: 1 },
    );
    await claimNext("w1");
    await sql`UPDATE discovery_jobs SET heartbeat_at = now() - INTERVAL '60 seconds' WHERE id = ${j.id}::uuid`;
    await runSweep();
    const fetched = await getJob(j.id);
    expect(fetched?.status).toBe("failed");
    expect(fetched?.error).toMatch(/max attempts/);
  });

  test("does not touch completed jobs", async () => {
    const j = await enqueue(
      "auto_categorize",
      { x: 1 },
      { enqueuedBy: "test" },
    );
    await claimNext("w1");
    await sql`UPDATE discovery_jobs SET status = 'completed', finished_at = now() WHERE id = ${j.id}::uuid`;
    await sql`UPDATE discovery_jobs SET heartbeat_at = now() - INTERVAL '60 seconds' WHERE id = ${j.id}::uuid`;
    await runSweep();
    const fetched = await getJob(j.id);
    expect(fetched?.status).toBe("completed");
  });
});