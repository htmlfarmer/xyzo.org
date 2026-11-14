// api/src/queue/ipcProtocol.ts
// JSON-lines codec for Node ↔ Python worker communication.
// One JSON object per line. NEVER use a different format on stdout — Python's
// print() must be redirected to stderr by the dispatcher.

import type { JobKind } from './kindConfig';

export type NodeToWorker =
  | { type: 'job'; id: string; kind: JobKind; payload: unknown }
  | { type: 'cancel'; id: string }
  | { type: 'heartbeat_check' }
  | { type: 'shutdown' };

export type WorkerToNode =
  | { type: 'ready'; worker_id: string }
  | { type: 'started'; id: string; ts: number }
  | { type: 'progress'; id: string; ts: number; step?: string; pct?: number; message?: string; meta?: Record<string, unknown>; state?: Record<string, unknown> }
  | { type: 'log'; id: string; level: 'info' | 'warn' | 'error'; message: string; fields?: Record<string, unknown> }
  | { type: 'complete'; id: string; ts: number; result: unknown }
  | { type: 'fail'; id: string; ts: number; error: string; traceback: string | null }
  | { type: 'cancelled'; id: string }
  | { type: 'heartbeat'; id: string };

export class IpcParseError extends Error {
  constructor(
    public readonly line: string,
    public readonly cause: unknown,
  ) {
    super(`Failed to parse worker IPC line: ${line.slice(0, 200)}`);
    this.name = 'IpcParseError';
  }
}

// Encode: object → single line JSON + newline
export function encode(msg: NodeToWorker | WorkerToNode): string {
  return JSON.stringify(msg) + '\n';
}

// Minimal runtime guard. Discriminator + presence checks only — does not
// validate every field shape. Workers that emit unknown shapes get logged
// via onError rather than crashing the consumer.
const KNOWN_TYPES = new Set([
  'ready', 'started', 'progress', 'log', 'complete',
  'fail', 'cancelled', 'heartbeat',
]);

export function isWorkerMessage(obj: unknown): obj is WorkerToNode {
  if (typeof obj !== 'object' || obj === null) return false;
  const m = obj as Record<string, unknown>;
  if (typeof m.type !== 'string') return false;
  return KNOWN_TYPES.has(m.type);
}

// Streaming parser: feed chunks, get messages back via callback.
// Handles partial lines across chunks.
export class IpcParser {
  private buffer = '';
  private readonly maxBufferBytes: number;

  constructor(opts: { maxBufferBytes?: number } = {}) {
    this.maxBufferBytes = opts.maxBufferBytes ?? 16 * 1024 * 1024;
  }

  feed(chunk: string, onMessage: (msg: WorkerToNode) => void, onError: (err: IpcParseError) => void): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBufferBytes) {
      this.buffer = '';
      onError(new IpcParseError('<buffer exceeded max>', null));
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        onError(new IpcParseError(line, e));
        continue;
      }
      if (!isWorkerMessage(parsed)) {
        onError(new IpcParseError(line, new Error('unknown or malformed message')));
        continue;
      }
      onMessage(parsed);
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
