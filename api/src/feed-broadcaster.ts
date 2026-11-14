// In-process pub/sub for the /api/feed/live SSE feed.
//
// Server-Sent Events replace the old 10s polling. When a new article is
// inserted (worker posts to /api/internal/article-created), we fan it out
// to every connected SSE writer. A periodic snapshot is also broadcast
// as a safety net — if a single article-create notification is lost
// (worker crash mid-POST, server restarted mid-broadcast, etc.), clients
// still get fresh data within ~60s.
//
// Limitations:
//   - In-memory: only works for a single API instance. Multi-instance
//     deployments would need LISTEN/NOTIFY or Redis. xyzo.org runs on
//     Bun as a single instance, so this is fine for now.
//   - No backpressure: if a writer is slow, we silently drop the event
//     for that client (the next snapshot catches them up).

import type { SSEStreamingApi } from "hono/streaming";

// Active SSE streams. A Set is fine because each stream is its own
// identity; we iterate on broadcast and prune dead ones by reference.
const clients = new Set<SSEStreamingApi>();

// Tracks the last broadcast id so we can number SSE events for clients
// that want to dedupe or seek to a particular position (Last-Event-ID).
let lastEventId = 0;

export function addClient(stream: SSEStreamingApi): void {
  clients.add(stream);
}

export function removeClient(stream: SSEStreamingApi): void {
  clients.delete(stream);
}

// Returns the number of clients currently subscribed. Used by the
// health endpoint and by tests.
export function clientCount(): number {
  return clients.size;
}

// Graceful shutdown: send every open stream a final `bye` event and end
// it normally. A clean EOF makes the browser's EventSource reconnect
// silently on its own — without this, process.exit() resets the HTTP/2
// stream mid-flight and every open tab logs
// "Failed to load resource: net::ERR_HTTP2_PROTOCOL_ERROR".
export async function closeStream(
  stream: SSEStreamingApi,
  reason = "shutdown",
): Promise<void> {
  try {
    await stream.writeSSE({
      event: "bye",
      data: JSON.stringify({ reason, at: new Date().toISOString() }),
    });
  } catch {
    // Client already gone — nothing to flush.
  }
  try {
    await stream.close();
  } catch {
    // Already closed underneath us.
  }
}

export async function closeAllClients(reason = "shutdown"): Promise<void> {
  const streams = [...clients];
  clients.clear();
  await Promise.all(streams.map((stream) => closeStream(stream, reason)));
}

// Fan out an `article` event to every connected client. We catch
// individual write errors and drop the dead client — a single slow or
// disconnected subscriber must not poison the broadcast.
export async function broadcastNewArticle(article: unknown): Promise<void> {
  lastEventId += 1;
  const payload = JSON.stringify(article);
  const dead: SSEStreamingApi[] = [];
  for (const stream of clients) {
    try {
      await stream.writeSSE({
        id: String(lastEventId),
        event: "article",
        data: payload,
      });
    } catch {
      dead.push(stream);
    }
  }
  for (const s of dead) removeClient(s);
}

// Same fan-out, but with `event: snapshot` and the full payload shape.
// Used by the periodic safety-net resync.
export async function broadcastSnapshot(payload: unknown): Promise<void> {
  lastEventId += 1;
  const body = JSON.stringify(payload);
  const dead: SSEStreamingApi[] = [];
  for (const stream of clients) {
    try {
      await stream.writeSSE({
        id: String(lastEventId),
        event: "snapshot",
        data: body,
      });
    } catch {
      dead.push(stream);
    }
  }
  for (const s of dead) removeClient(s);
}
