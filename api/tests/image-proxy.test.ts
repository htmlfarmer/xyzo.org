import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { imageProxyRoute } from "../src/routes/imageProxy";

const app = new Hono();
app.route("/api", imageProxyRoute);

// A host that cannot resolve — a dead publisher whose domain expired.
// It is the case that produced the owner's "image-proxy:1 Failed to
// load resource: the server responded with a status of 404 ()".
const DEAD_HOST = "https://no-such-host-xyzo-audit-9182.com/p.jpg";

// The point of the endpoint: a dead picture is gone AT THE PUBLISHER.
// The reader can neither silence that nor act on it, and a failed
// subresource is logged by the BROWSER — no JavaScript can suppress it.
// So the proxy answers HTTP 200 with a 1x1 transparent PNG.
const isPlaceholder = (res: Response, body: Uint8Array) =>
  res.headers.get("x-proxy-placeholder") === "1" &&
  res.headers.get("content-type") === "image/png" &&
  body[0] === 0x89 && body[1] === 0x50 &&
  body.length < 200;

describe("GET /api/image-proxy", () => {
  test("a missing url is a 400 — that is about the REQUEST", async () => {
    const res = await app.request("/api/image-proxy");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_url");
  });

  test("a malformed url is a 400", async () => {
    const res = await app.request("/api/image-proxy?url=not-a-url");
    expect(res.status).toBe(400);
  });

  test("a private address is a 400 — the SSRF guard, and it stays an error", async () => {
    const res = await app.request(
      "/api/image-proxy?url=" + encodeURIComponent("http://192.168.1.10/x.jpg"));
    expect(res.status).toBe(400);
  });

  test("a host that cannot resolve answers the PLACEHOLDER, not a 404", async () => {
    // THE BUG THIS PINS. This path used to answer
    // c.json({ error: "host_unreachable" }, 404) — with a comment
    // claiming that "404 keeps the browser console quiet". That is
    // BACKWARDS: a 404 on an <img> IS the console noise the endpoint
    // exists to remove, and the browser logs every failed subresource.
    const res = await app.request(
      "/api/image-proxy?url=" + encodeURIComponent(DEAD_HOST));
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(isPlaceholder(res, body)).toBe(true);
  });

  test("and the CACHED failure answers the placeholder too", async () => {
    // The negative cache remembers the dead URL for half an hour. The
    // cached branch used to hand back the upstream's own status (a 403
    // or a 429 for a dead picture) — which is the same console noise
    // one step later.
    const url = "/api/image-proxy?url=" + encodeURIComponent(DEAD_HOST);
    const first = await app.request(url);
    expect(first.status).toBe(200);
    const second = await app.request(url);
    expect(second.status).toBe(200);
    const body = new Uint8Array(await second.arrayBuffer());
    expect(isPlaceholder(second, body)).toBe(true);
  });

  test("the ONLY statuses the endpoint may answer are 200, 400 and 429", async () => {
    // Anything else is a failed subresource in the reader's console.
    //
    // The 429 is the ONE error that stays, and it is a deliberate
    // distinction: a rate-limited CLIENT can act on it (back off, ask
    // for less), while a dead PICTURE cannot be acted on at all. The
    // limit is 300/minute so that this branch is unreachable for an
    // ordinary reader — a page load asks for ~15 images, so a human
    // would have to reload twenty times a minute to get here.
    const cases = [
      "/api/image-proxy",
      "/api/image-proxy?url=not-a-url",
      "/api/image-proxy?url=" + encodeURIComponent("http://10.0.0.1/x.jpg"),
      "/api/image-proxy?url=" + encodeURIComponent(DEAD_HOST),
    ];
    for (const url of cases) {
      const res = await app.request(url);
      expect([200, 400, 429], url + " answered " + res.status).toContain(res.status);
    }
  });
});
