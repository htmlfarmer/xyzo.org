// /api/health — liveness + queue state for ops dashboards.
//
// `ok` is true unless the pool enters DEGRADED state (recovery budget
// exhausted on respawn). During STARTING (workers still booting), ok
// is true so the client-side health check doesn't show the error banner.
import { Hono } from "hono";
import { getPoolSnapshot } from "../queue/workerPool";
import { listInFlight } from "../queue/jobQueue";

export const healthRoute = new Hono().get("/", async (c) => {
  const inflight = await listInFlight().catch(
    () => ({ queued: {}, claimed: {}, running: {} }),
  );
  const snapshot = getPoolSnapshot();
  return c.json({
    ok: snapshot.state !== "DEGRADED",
    version: process.env.NEWSIUM_VERSION ?? "0.0.0",
    queue: {
      state: snapshot.state,
      poolSize: snapshot.poolSize,
      activeWorkers: snapshot.activeWorkers,
      degradedSince: snapshot.degradedSince?.toISOString() ?? null,
      slots: snapshot.slots,
      jobsByKind: inflight,
    },
  });
});
