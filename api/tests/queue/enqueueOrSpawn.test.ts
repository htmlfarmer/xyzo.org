import { describe, expect, test, afterAll, beforeEach } from 'bun:test';
import { getDb } from '../../src/db';
import { enqueueOrSpawn } from '../../src/queue/enqueueOrSpawn';
import { startWorkerPool, stopWorkerPool } from '../../src/queue/workerPool';
import { JobTimeoutError } from '../../src/queue/errors';

const sql = getDb();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by = 'test'`;
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await stopWorkerPool({ maxWaitMs: 5_000 });
  // NOTE: do NOT call sql.end()/closeDb() here — the shared postgres-js
  // connection is reused across sibling queue test files.
});

describe('enqueueOrSpawn', () => {
  test('fire-and-forget returns requestId without waiting', async () => {
    await startWorkerPool({ size: 1 });
    const result = await enqueueOrSpawn(
      'test_noop',
      { sleep_ms: 100 },
      { waitMs: 0, enqueuedBy: 'test' },
    );
    expect(result.kind).toBe('async');
    if (result.kind === 'async') {
      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.statusUrl).toBe(`/api/discovery-status/${result.requestId}`);
    }
  }, 15_000);

  test('sync-wait resolves with result on completion', async () => {
    await startWorkerPool({ size: 1 });
    const result = await enqueueOrSpawn<{ hello: string }>(
      'test_noop',
      { sleep_ms: 100, final_result: { hello: 'world' } },
      { waitMs: 5000, enqueuedBy: 'test' },
    );
    expect(result.kind).toBe('sync');
    if (result.kind === 'sync') {
      expect(result.result).toEqual({ hello: 'world' });
    }
  }, 15_000);

  test('sync-wait respects timeout', async () => {
    await startWorkerPool({ size: 1 });
    await expect(
      enqueueOrSpawn(
        'test_noop',
        { sleep_ms: 5000 },
        { waitMs: 200, enqueuedBy: 'test' },
      ),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  }, 15_000);
});