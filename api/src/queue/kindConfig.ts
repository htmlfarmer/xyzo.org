// Per-job-kind tuning. Hardcoded for v1; can move to DB / config file later
// once we have production data to inform caps and timeouts.

export type JobKind =
  | 'explore_region'
  | 'sources_audit'
  | 'links_generate'
  | 'auto_categorize'
  | 'analytics_inline'
  | 'community_triage'
  | 'feedback_suggest'
  // Synthetic kinds reserved for the queue integration test harness. They
  // back Python handlers registered in `worker.dispatcher` as `test_noop`
  // and `test_sleep` and must also exist in the Postgres `job_kind` enum
  // (see api/migrations/2026-08-27-job-queue-test-kinds.sql).
  | 'test_noop'
  | 'test_sleep';

export interface KindConfig {
  defaultPriority: number;
  softCap: { queued: number; running: number };
  defaultMaxAttempts: number;
  defaultTimeoutMs: number;
  // Suggested handler-side timeout (NOT a hard kill; handler checks ctx)
  handlerTimeoutMs: number;
}

export const KIND_CONFIG: Record<JobKind, KindConfig> = {
  explore_region: {
    defaultPriority: 0,
    softCap: { queued: 5, running: 2 },
    defaultMaxAttempts: 2,
    defaultTimeoutMs: 120_000,
    handlerTimeoutMs: 110_000,
  },
  sources_audit: {
    defaultPriority: 0,
    softCap: { queued: 5, running: 2 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 120_000,
    handlerTimeoutMs: 110_000,
  },
  links_generate: {
    defaultPriority: 0,
    softCap: { queued: 10, running: 3 },
    defaultMaxAttempts: 2,
    defaultTimeoutMs: 60_000,
    handlerTimeoutMs: 55_000,
  },
  auto_categorize: {
    defaultPriority: 5,
    softCap: { queued: 50, running: 4 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 5_000,
    handlerTimeoutMs: 4_500,
  },
  analytics_inline: {
    defaultPriority: 5,
    softCap: { queued: 50, running: 4 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 3_000,
    handlerTimeoutMs: 2_500,
  },
  community_triage: {
    defaultPriority: 0,
    softCap: { queued: 5, running: 2 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 60_000,
    handlerTimeoutMs: 55_000,
  },
  feedback_suggest: {
    defaultPriority: 5,
    softCap: { queued: 20, running: 3 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 5_000,
    handlerTimeoutMs: 4_500,
  },
  // Synthetic kinds reserved for the queue integration test harness. They
  // back Python handlers registered in `worker.dispatcher` as `test_noop`
  // and `test_sleep`. The numbers are intentionally large so a stuck
  // synthetic job never races with production soft caps.
  test_noop: {
    defaultPriority: 0,
    softCap: { queued: 100, running: 100 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 60_000,
    handlerTimeoutMs: 55_000,
  },
  test_sleep: {
    defaultPriority: 0,
    softCap: { queued: 100, running: 100 },
    defaultMaxAttempts: 1,
    defaultTimeoutMs: 60_000,
    handlerTimeoutMs: 55_000,
  },
};

export const ALL_KINDS: JobKind[] = Object.keys(KIND_CONFIG) as JobKind[];

export function isJobKind(s: string): s is JobKind {
  return (ALL_KINDS as string[]).includes(s);
}