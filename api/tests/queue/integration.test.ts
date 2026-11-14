import { describe, expect, test, afterAll, beforeEach } from 'bun:test';
import { getDb } from '../../src/db';
import { enqueue, getJob } from '../../src/queue/jobQueue';
import {
  startWorkerPool,
  stopWorkerPool,
  cancelJob,
  getPoolSnapshot,
} from '../../src/queue/workerPool';

const sql = getDb();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by = 'integration-test'`;
  await sql`UPDATE discovery_jobs SET cancel_requested = false WHERE enqueued_by = 'integration-test'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await stopWorkerPool({ maxWaitMs: 5_000 });
});

describe('worker pool integration', () => {
  test('startWorkerPool spawns N children that become ready', async () => {
    await startWorkerPool({ size: 2 });
    const snap = getPoolSnapshot();
    expect(snap.state).toBe('RUNNING');
    expect(snap.poolSize).toBe(2);
    expect(snap.activeWorkers).toBe(2);
  }, 30_000);

  test('enqueued test_noop job is dispatched and completes', async () => {
    await startWorkerPool({ size: 1 });
    const job = await enqueue(
      'test_noop',
      {
        sleep_ms: 200,
        progress_every_ms: 50,
        final_result: { hello: 'world' },
      },
      { enqueuedBy: 'integration-test' },
    );

    // Poll until terminal (DB is the source of truth).
    const deadline = Date.now() + 5000;
    let row;
    while (Date.now() < deadline) {
      row = await getJob(job.id);
      if (
        row?.status === 'completed' ||
        row?.status === 'failed' ||
        row?.status === 'cancelled'
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.status).toBe('completed');
    expect(row?.result).toEqual({ hello: 'world' });
  }, 15_000);

  test('cancelJob during execution marks the job as cancelled', async () => {
    await startWorkerPool({ size: 1 });
    const job = await enqueue(
      'test_noop',
      {
        sleep_ms: 3000,
        progress_every_ms: 50,
      },
      { enqueuedBy: 'integration-test' },
    );

    // Wait for the job to be claimed and started.
    let started = false;
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline) {
      const row = await getJob(job.id);
      if (row?.status === 'running') {
        started = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(started).toBe(true);

    // Cancel via the pool (sends IPC cancel to the slot).
    cancelJob(job.id);

    // Poll for terminal cancellation.
    const cancelDeadline = Date.now() + 2000;
    let row;
    while (Date.now() < cancelDeadline) {
      row = await getJob(job.id);
      if (
        row?.status === 'cancelled' ||
        row?.status === 'failed' ||
        row?.status === 'completed'
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.status).toBe('cancelled');
  }, 15_000);
});
