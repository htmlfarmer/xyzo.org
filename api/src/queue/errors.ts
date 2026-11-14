// Typed errors thrown by the queue subsystem. Routes catch these and translate
// to HTTP status codes / JSON shapes.

export class JobTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly waitedMs: number,
  ) {
    super(`Job ${jobId} did not complete within ${waitedMs}ms`);
    this.name = 'JobTimeoutError';
  }
}

export class JobFailedError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly originalError: string,
    public readonly traceback: string | null,
    public readonly attempts: number,
  ) {
    super(`Job ${jobId} failed after ${attempts} attempt(s): ${originalError}`);
    this.name = 'JobFailedError';
  }
}

export class JobCancelledError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = 'JobCancelledError';
  }
}

export class JobQueueUnavailableError extends Error {
  constructor(public readonly reason: 'pool-degraded' | 'db-unreachable' | 'soft-cap') {
    super(`Job queue unavailable: ${reason}`);
    this.name = 'JobQueueUnavailableError';
  }
}

export class JobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = 'JobNotFoundError';
  }
}