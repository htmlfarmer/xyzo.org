import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { getDb } from "../../src/db";
import {
  enqueue,
  getJob,
  claimNext,
  markStarted,
  markProgress,
  markComplete,
  markFailed,
  markCancelled,
  requestCancel,
  listInFlight,
} from "../../src/queue/jobQueue";

const sql = getDb();

const TEST_PAYLOAD = { bbox: [0, 0, 1, 1], enqueuedBy: "test" };

async function cleanup(): Promise<void> {
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by = 'test'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
});

describe("jobQueue.enqueue", () => {
  test("inserts a row and returns its id + status", async () => {
    const job = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
      priority: 5,
    });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.status).toBe("queued");
    expect(job.kind).toBe("auto_categorize");
    expect(job.priority).toBe(5);
  });

  test("respects maxAttempts override", async () => {
    const job = await enqueue("explore_region", TEST_PAYLOAD, {
      enqueuedBy: "test",
      maxAttempts: 3,
    });
    const fetched = await getJob(job.id);
    expect(fetched?.max_attempts).toBe(3);
  });
});

describe("jobQueue.claimNext", () => {
  test("returns highest-priority queued job", async () => {
    const low = await enqueue("explore_region", TEST_PAYLOAD, {
      enqueuedBy: "test",
      priority: 0,
    });
    const high = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
      priority: 10,
    });
    const claimed = await claimNext("w1");
    expect(claimed?.id).toBe(high.id);
    expect(claimed?.status).toBe("claimed");
  });

  test("returns null when no queued jobs", async () => {
    const claimed = await claimNext("w1");
    expect(claimed).toBeNull();
  });

  test("skips cancelled jobs even when queued", async () => {
    const j = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
    });
    await requestCancel(j.id);
    const claimed = await claimNext("w1");
    expect(claimed).toBeNull();
  });
});

describe("jobQueue.markProgress", () => {
  test("updates state jsonb", async () => {
    const j = await enqueue("explore_region", TEST_PAYLOAD, {
      enqueuedBy: "test",
    });
    await claimNext("w1");
    await markStarted(j.id);
    await markProgress(j.id, { current_step: "geocoding", progress: 42 });
    const fetched = await getJob(j.id);
    expect(fetched?.state).toEqual({ current_step: "geocoding", progress: 42 });
  });
});

describe("jobQueue.markComplete", () => {
  test("sets status + result + finished_at", async () => {
    const j = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
    });
    await claimNext("w1");
    await markStarted(j.id);
    await markComplete(j.id, { category: "world" });
    const fetched = await getJob(j.id);
    expect(fetched?.status).toBe("completed");
    expect(fetched?.result).toEqual({ category: "world" });
    expect(fetched?.finished_at).toBeInstanceOf(Date);
  });
});

describe("jobQueue.markFailed", () => {
  test("records error and traceback", async () => {
    const j = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
    });
    await claimNext("w1");
    await markFailed(j.id, "boom", "Traceback...");
    const fetched = await getJob(j.id);
    expect(fetched?.status).toBe("failed");
    expect(fetched?.error).toBe("boom");
    expect(fetched?.traceback).toBe("Traceback...");
  });
});

describe("jobQueue.requestCancel", () => {
  test("sets cancel_requested=true on running job", async () => {
    const j = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
    });
    await claimNext("w1");
    await markStarted(j.id);
    const updated = await requestCancel(j.id);
    expect(updated).toBe(true);
    const fetched = await getJob(j.id);
    expect(fetched?.cancel_requested).toBe(true);
  });

  test("returns false for terminal jobs", async () => {
    const j = await enqueue("auto_categorize", TEST_PAYLOAD, {
      enqueuedBy: "test",
    });
    await claimNext("w1");
    await markStarted(j.id);
    await markComplete(j.id, { ok: 1 });
    const updated = await requestCancel(j.id);
    expect(updated).toBe(false);
  });
});

describe("jobQueue.listInFlight", () => {
  test("returns queued + claimed + running, grouped by status", async () => {
    await enqueue("auto_categorize", TEST_PAYLOAD, { enqueuedBy: "test" });
    await enqueue("auto_categorize", TEST_PAYLOAD, { enqueuedBy: "test" });
    const claimed = await claimNext("w1");
    await markStarted(claimed!.id);
    const inflight = await listInFlight();
    expect(inflight.queued["auto_categorize"]).toBe(1);
    expect(inflight.running["auto_categorize"]).toBe(1);
  });
});
