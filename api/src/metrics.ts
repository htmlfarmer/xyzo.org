/**
 * Performance metrics tracker — logs CPU/GPU time for operations.
 *
 * Tracks:
 *   - API endpoint response times
 *   - AI inference time (GPU)
 *   - Worker processing time (CPU)
 *   - Database query time
 *   - Memory usage
 *
 * Usage:
 *   import { metrics } from './metrics';
 *   metrics.track('ai_extract', { duration_ms: 1500, gpu_time_ms: 1200 });
 *   metrics.getStats('ai_extract', 24); // last 24 hours
 */
import { getDb } from './db';

interface MetricEntry {
  operation: string;
  endpoint?: string;
  duration_ms: number;
  cpu_time_ms?: number;
  gpu_time_ms?: number;
  memory_mb?: number;
  session_id?: string;
  metadata?: Record<string, any>;
}

class MetricsTracker {
  private buffer: MetricEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private readonly BUFFER_SIZE = 50;
  private readonly FLUSH_INTERVAL_MS = 30000; // 30 seconds

  constructor() {
    // Auto-flush every 30 seconds
    this.flushInterval = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
  }

  /** Track a metric entry */
  track(entry: MetricEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.BUFFER_SIZE) {
      this.flush();
    }
  }

  /** Track an API request */
  trackRequest(endpoint: string, duration_ms: number, session_id?: string): void {
    this.track({
      operation: 'api_request',
      endpoint,
      duration_ms,
      session_id,
    });
  }

  /** Track an AI operation (GPU) */
  trackAI(operation: string, duration_ms: number, gpu_time_ms?: number, metadata?: Record<string, any>): void {
    this.track({
      operation,
      duration_ms,
      gpu_time_ms: gpu_time_ms || duration_ms, // Assume GPU time = total if not specified
      metadata,
    });
  }

  /** Track a worker operation (CPU) */
  trackWorker(operation: string, duration_ms: number, metadata?: Record<string, any>): void {
    this.track({
      operation,
      duration_ms,
      cpu_time_ms: duration_ms,
      metadata,
    });
  }

  /** Track a database query */
  trackDB(query: string, duration_ms: number): void {
    this.track({
      operation: 'db_query',
      endpoint: query.slice(0, 200),
      duration_ms,
    });
  }

  /** Flush buffered metrics to database */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const entries = this.buffer.splice(0, this.BUFFER_SIZE);
    try {
      const sql = getDb();
      // Bulk insert all entries in a single query
      if (entries.length > 0) {
        await sql`
          INSERT INTO news_performance_metrics (
            operation, endpoint, duration_ms, cpu_time_ms, gpu_time_ms,
            memory_mb, session_id, metadata
          )
          SELECT * FROM unnest(
            ${entries.map(e => e.operation)}::text[],
            ${entries.map(e => e.endpoint || null)}::text[],
            ${entries.map(e => e.duration_ms)}::float8[],
            ${entries.map(e => e.cpu_time_ms || null)}::float8[],
            ${entries.map(e => e.gpu_time_ms || null)}::float8[],
            ${entries.map(e => e.memory_mb || null)}::float8[],
            ${entries.map(e => e.session_id || null)}::text[],
            ${entries.map(e => e.metadata ? JSON.stringify(e.metadata) : null)}::jsonb[]
          )
        `;
      }
    } catch (e) {
      console.warn('[metrics] Failed to flush:', e);
    }
  }

  /** Get stats for an operation over a time window */
  async getStats(operation: string, hours: number = 24): Promise<any> {
    const sql = getDb();
    const rows = await sql`
      SELECT
        COUNT(*) as total_calls,
        AVG(duration_ms) as avg_duration,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50_duration,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration,
        MAX(duration_ms) as max_duration,
        SUM(cpu_time_ms) as total_cpu_ms,
        SUM(gpu_time_ms) as total_gpu_ms
      FROM news_performance_metrics
      WHERE operation = ${operation}
        AND created_at > now() - (${hours} || ' hours')::interval
    `;
    // COUNT/SUM over int columns arrive as BigInt (postgres.js bigint
    // parser) — coerce everything so callers can JSON.stringify safely.
    const r: any = rows[0] || {};
    return {
      total_calls: Number(r.total_calls ?? 0),
      avg_duration: r.avg_duration != null ? Number(r.avg_duration) : null,
      p50_duration: r.p50_duration != null ? Number(r.p50_duration) : null,
      p95_duration: r.p95_duration != null ? Number(r.p95_duration) : null,
      max_duration: r.max_duration != null ? Number(r.max_duration) : null,
      total_cpu_ms: Number(r.total_cpu_ms ?? 0),
      total_gpu_ms: Number(r.total_gpu_ms ?? 0),
    };
  }

  /** Get overall performance summary */
  async getSummary(hours: number = 24): Promise<any> {
    const sql = getDb();

    const byOperation = await sql`
      SELECT operation,
        COUNT(*) as calls,
        AVG(duration_ms) as avg_ms,
        SUM(duration_ms) as total_ms,
        SUM(cpu_time_ms) as total_cpu_ms,
        SUM(gpu_time_ms) as total_gpu_ms
      FROM news_performance_metrics
      WHERE created_at > now() - (${hours} || ' hours')::interval
      GROUP BY operation
      ORDER BY total_ms DESC
    `;

    const byEndpoint = await sql`
      SELECT endpoint,
        COUNT(*) as calls,
        AVG(duration_ms) as avg_ms,
        MAX(duration_ms) as max_ms
      FROM news_performance_metrics
      WHERE endpoint IS NOT NULL
        AND created_at > now() - (${hours} || ' hours')::interval
      GROUP BY endpoint
      ORDER BY calls DESC
      LIMIT 20
    `;

    const totals = await sql`
      SELECT
        COUNT(*) as total_operations,
        SUM(duration_ms) as total_duration_ms,
        SUM(cpu_time_ms) as total_cpu_ms,
        SUM(gpu_time_ms) as total_gpu_ms,
        AVG(duration_ms) as avg_duration_ms
      FROM news_performance_metrics
      WHERE created_at > now() - (${hours} || ' hours')::interval
    `;

    return {
      totals: {
        total_operations: Number(totals[0]?.total_operations || 0),
        total_duration_ms: Number(totals[0]?.total_duration_ms || 0),
        total_cpu_ms: Number(totals[0]?.total_cpu_ms || 0),
        total_gpu_ms: Number(totals[0]?.total_gpu_ms || 0),
        avg_duration_ms: Number(totals[0]?.avg_duration_ms || 0),
      },
      by_operation: byOperation.map(r => ({
        operation: r.operation,
        calls: Number(r.calls),
        avg_ms: Math.round(Number(r.avg_ms)),
        total_ms: Math.round(Number(r.total_ms)),
        total_cpu_ms: Math.round(Number(r.total_cpu_ms || 0)),
        total_gpu_ms: Math.round(Number(r.total_gpu_ms || 0)),
      })),
      by_endpoint: byEndpoint.map(r => ({
        endpoint: r.endpoint,
        calls: Number(r.calls),
        avg_ms: Math.round(Number(r.avg_ms)),
        max_ms: Math.round(Number(r.max_ms)),
      })),
    };
  }

  /** Get slow operations (potential bottlenecks) */
  async getSlowOperations(limit: number = 20): Promise<any[]> {
    const sql = getDb();
    const rows = await sql`
      SELECT operation, endpoint, duration_ms, created_at, metadata
      FROM news_performance_metrics
      WHERE duration_ms > 5000
        AND created_at > now() - interval '24 hours'
      ORDER BY duration_ms DESC
      LIMIT ${limit}
    `;
    return rows.map(r => ({
      operation: r.operation,
      endpoint: r.endpoint,
      duration_ms: Math.round(Number(r.duration_ms)),
      created_at: r.created_at,
      metadata: r.metadata,
    }));
  }
}

export const metrics = new MetricsTracker();
