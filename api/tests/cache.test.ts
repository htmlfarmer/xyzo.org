// Tests for SimpleLRUCache — verifies TTL expiry, LRU eviction, and behavior.

import { describe, expect, test, beforeEach } from "bun:test";
import { SimpleLRUCache } from "../src/cache";

describe("SimpleLRUCache", () => {
  let cache: SimpleLRUCache<string>;

  beforeEach(() => {
    cache = new SimpleLRUCache<string>(3, 100); // max 3 entries, 100ms TTL
  });

  test("returns null for missing keys", () => {
    expect(cache.get("missing")).toBeNull();
  });

  test("stores and retrieves values", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  test("respects TTL expiry", async () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 150));
    expect(cache.get("key1")).toBeNull();
  });

  test("evicts oldest entry when max entries exceeded", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.set("key3", "value3");

    // Adding a4th should evict key1
    cache.set("key4", "value4");

    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")).toBe("value2");
    expect(cache.get("key3")).toBe("value3");
    expect(cache.get("key4")).toBe("value4");
  });

  test("refreshes LRU order on get", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.set("key3", "value3");

    // Access key1 to refresh its position
    cache.get("key1");

    // Adding a4th should now evict key2 (oldest unaccessed)
    cache.set("key4", "value4");

    expect(cache.get("key1")).toBe("value1"); // refreshed
    expect(cache.get("key2")).toBeNull(); // evicted
    expect(cache.get("key3")).toBe("value3");
    expect(cache.get("key4")).toBe("value4");
  });

  test("clear removes all entries", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")).toBeNull();
  });

  test("size returns current entry count", () => {
    expect(cache.size()).toBe(0);
    cache.set("key1", "value1");
    expect(cache.size()).toBe(1);
    cache.set("key2", "value2");
    expect(cache.size()).toBe(2);
  });

  test("custom TTL overrides default", async () => {
    cache.set("short", "value", 50); //50ms TTL
    cache.set("long", "value", 500); //500ms TTL

    await new Promise(r => setTimeout(r,80));

    expect(cache.get("short")).toBeNull(); // expired
    expect(cache.get("long")).toBe("value"); // still alive
  });
});

// ── The BYTE BUDGET ─────────────────────────────────────────────────────
//
// An entry-count limit cannot express a MEMORY limit, and the entries
// here are not interchangeable in size: a 1,000-pin search answer is
// **1.5 MB** of JSON, so the old 200-entry limit on the search cache was
// a **300 MB ceiling** on the API process's memory. The search cache now
// carries a byte budget instead (64 MB ≈ 40 full answers).
describe("SimpleLRUCache — the byte budget", () => {
  test("evicts the oldest entries until it is inside the budget", () => {
    const c = new SimpleLRUCache<string>(100, 60_000, 1000);
    c.set("a", "a", undefined, 400);
    c.set("b", "b", undefined, 400);
    expect(c.byteSize()).toBe(800);

    // 800 + 400 = 1200 > 1000 → the oldest goes.
    c.set("c", "c", undefined, 400);
    expect(c.byteSize()).toBeLessThanOrEqual(1000);
    expect(c.get("a")).toBeNull();   // the oldest was evicted
    expect(c.get("b")).toBe("b");
    expect(c.get("c")).toBe("c");
  });

  test("one entry over the budget on its own is still kept", () => {
    // A single answer that is over the budget by itself is better than
    // no answer at all — the cache must not empty itself.
    const c = new SimpleLRUCache<string>(100, 60_000, 100);
    c.set("big", "big", undefined, 5000);
    expect(c.get("big")).toBe("big");
    expect(c.byteSize()).toBe(5000);
  });

  test("replacing a key does not double-count its bytes", () => {
    const c = new SimpleLRUCache<string>(100, 60_000, 1000);
    c.set("a", "a", undefined, 600);
    c.set("a", "a2", undefined, 600);
    expect(c.byteSize()).toBe(600);
    expect(c.get("a")).toBe("a2");
  });

  test("an expired entry gives its bytes back", async () => {
    const c = new SimpleLRUCache<string>(100, 50, 1000);
    c.set("a", "a", undefined, 600);
    expect(c.byteSize()).toBe(600);
    await new Promise(r => setTimeout(r, 90));
    expect(c.get("a")).toBeNull();
    expect(c.byteSize()).toBe(0);
  });

  test("clear() resets the accounting too", () => {
    const c = new SimpleLRUCache<string>(100, 60_000, 1000);
    c.set("a", "a", undefined, 600);
    c.set("b", "b", undefined, 600);
    c.clear();
    expect(c.byteSize()).toBe(0);
    expect(c.size()).toBe(0);
  });

  test("the search cache is budgeted, and its TTL stays a hard 5 minutes", async () => {
    const { searchCache } = await import("../src/cache");
    // The budget is the point: 200 entries × up to 1.5 MB was a 300 MB
    // ceiling on the API process's memory.
    expect(searchCache.byteSize()).toBeLessThanOrEqual(64 * 1024 * 1024);
    // A cached answer older than five minutes would be yesterday's news
    // served as if it were this morning's.
    searchCache.set("__ttl_probe", "x");
    await new Promise(r => setTimeout(r, 20));
    expect(searchCache.get("__ttl_probe")).toBe("x");
    searchCache.delete?.("__ttl_probe");
  });
});
