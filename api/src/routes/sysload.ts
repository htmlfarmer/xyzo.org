import { Hono } from "hono";

export const sysloadRoute = new Hono();

// ── GET /api/sysload ─────────────────────────────────────────────────
// Returns CPU and GPU utilization. Frontend uses this for the
// "Live status" footer. Lightweight — cached for 15s server-side.

interface CpuStats {
  idle_pct: number;
  user_pct: number;
  sys_pct: number;
  iowait_pct: number;
}

interface GpuStats {
  available: boolean;
  name: string;
  util_pct: number;
  mem_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  temp_c: number;
  busy: boolean;
}

interface SysloadSnapshot {
  cpu: CpuStats;
  gpu: GpuStats;
  timestamp: number;
}

let _cache: SysloadSnapshot | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 15_000;

function readCpuStats(): { total: number; idle: number; iowait: number; user: number; sys: number } | null {
  try {
    const proc = Bun.spawnSync(["cat", "/proc/stat"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const line = proc.stdout.toString().split("\n")[0];
    const parts = line.split(/\s+/);
    if (parts.length < 5) return null;
    const vals = parts.slice(1, 9).map(Number);
    const total = vals.reduce((a, b) => a + b, 0);
    const idle = vals[3] + (vals[4] ?? 0);
    const iowait = vals[4] ?? 0;
    const user = vals[0] + vals[1];
    const sys = vals[2];
    return { total, idle, iowait, user, sys };
  } catch {
    return null;
  }
}

function getCpuSnapshot(): CpuStats {
  // Read /proc/stat twice with a short async delay to get a delta.
  // We use a cached value if it's recent enough to avoid blocking.
  const s1 = readCpuStats();
  if (!s1) return { idle_pct: 100, user_pct: 0, sys_pct: 0, iowait_pct: 0 };

  // Use cached CPU stats if they're less than 5 seconds old
  if (_cpuCache && Date.now() - _cpuCacheAt < 5000) {
    return _cpuCache;
  }

  // For a quick response, just return the instantaneous values
  // (less accurate but non-blocking)
  const total = s1.total || 1;
  return {
    idle_pct: Math.round((100 * s1.idle) / total * 10) / 10,
    user_pct: Math.round((100 * s1.user) / total * 10) / 10,
    sys_pct: Math.round((100 * s1.sys) / total * 10) / 10,
    iowait_pct: Math.round((100 * s1.iowait) / total * 10) / 10,
  };
}

let _cpuCache: CpuStats | null = null;
let _cpuCacheAt = 0;

function getGpuStats(): GpuStats {
  const empty: GpuStats = {
    available: false, name: "", util_pct: 0, mem_pct: 0,
    mem_used_mb: 0, mem_total_mb: 0, temp_c: 0, busy: false,
  };
  try {
    const proc = Bun.spawnSync([
      "nvidia-smi",
      "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (proc.exitCode !== 0) return empty;
    const line = proc.stdout.toString().trim().split("\n")[0];
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 6) return empty;
    const utilPct = parseFloat(parts[1]);
    const memPct = parseFloat(parts[2]);
    return {
      available: true,
      name: parts[0],
      util_pct: utilPct,
      mem_pct: memPct,
      mem_used_mb: parseFloat(parts[3]),
      mem_total_mb: parseFloat(parts[4]),
      temp_c: parseFloat(parts[5]),
      busy: utilPct >= 80 || memPct >= 85,
    };
  } catch {
    return empty;
  }
}

sysloadRoute.get("/sysload", async (c) => {
  // Public — returns only CPU% + GPU% + timestamp. No PII, no DB state,
  // no internal endpoints. The debug panel renders this in the "Live
  // status" footer; locking it behind admin auth broke that panel for
  // every user (caught 2026-09-06 via "401 /api/sysload" in browser
  // network log). Compare with /api/debug, which IS auth-gated because
  // it returns DB connection state, AI breaker internals, and the
  // internal AI endpoint URL.
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) {
    return c.json(_cache);
  }

  const cpu = getCpuSnapshot();
  const gpu = getGpuStats();

  _cache = { cpu, gpu, timestamp: now / 1000 };
  _cacheAt = now;
  return c.json(_cache);
});
