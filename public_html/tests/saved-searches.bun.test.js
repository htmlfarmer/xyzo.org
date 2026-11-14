// saved-searches.bun.test.js — a repeat search must not make the reader
// wait for an answer they have already seen.
//
// A text search is the slowest thing on the site: the pin query ranks
// with ts_rank_cd over the whole corpus and measures **3–50 s** cold,
// and the event search spawns a Python worker for another **30–90 s**
// (README Q-N28). So the previous answer is kept and shown at once, with
// a note that the fresh one is on its way; when it lands it replaces the
// old one.
//
// THE MEMORY ANSWER, because it is the question that decides the design:
//
//   * The QUERY is free — a key is a few dozen bytes.
//   * The RESULTS are not: a 1,000-pin answer is **1.5 MB** of JSON
//     (1,620 B a pin), of which `word_freq` alone is **711 KB (45 %)**.
//
// So the browser keeps the answers SLIMMED (no `word_freq` — the popup
// fetches its keywords on demand from /api/pins/:id/words) → **773 KB a
// search**, in **IndexedDB: DISK, not RAM**, capped at the **12 most
// recent** searches (≈9 MB). Nothing is added to the tab's memory beyond
// what the live search already puts there.
//
// What is NOT saved is the framing DECISION: a saved answer is framed by
// the same function that frames a live search (frameSearchRegion), so a
// saved search can never put the map somewhere a fresh one would not.
//
// The store is exercised for real here, against an in-memory IndexedDB —
// a source-level assertion cannot tell whether it actually keeps what
// it is given, ages it out, or prunes it.
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const savedJs = readFileSync(join(ROOT, "saved-searches.js"), "utf8");

// ── a minimal in-memory IndexedDB ─────────────────────────────────────
//
// Enough of the API for the store: open (with an upgrade that creates
// the object store), transaction → objectStore → get/put/getAll/delete/
// clear. Every request answers ASYNCHRONOUSLY, because the real one
// does and the store awaits them.
function makeRequest(result) {
  const r = { onsuccess: null, onerror: null, result };
  setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
  return r;
}

function makeFakeIndexedDb() {
  const stores = new Map();
  const storeFor = (name, create) => {
    if (!stores.has(name)) {
      if (!create) return null;
      stores.set(name, new Map());
    }
    return stores.get(name);
  };
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (name) => { storeFor(name, true); return {}; },
    transaction: (name) => {
      const m = storeFor(name, false);
      if (!m) throw new Error("no such store");
      const api = {
        get: (k) => makeRequest(m.get(k)),
        put: (rec) => { m.set(rec.key, rec); return makeRequest(rec.key); },
        getAll: () => makeRequest([...m.values()]),
        delete: (k) => { m.delete(k); return makeRequest(undefined); },
        clear: () => { m.clear(); return makeRequest(undefined); },
      };
      return { objectStore: () => api };
    },
  };
  const open = () => {
    const r = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db };
    setTimeout(() => {
      if (r.onupgradeneeded) r.onupgradeneeded({ target: r });
      if (r.onsuccess) r.onsuccess({ target: r });
    }, 0);
    return r;
  };
  return { open, _stores: stores };
}

/** Load the module fresh, against the given IndexedDB (or none at all). */
function loadStore(idb) {
  const w = {};
  if (idb) globalThis.indexedDB = idb;
  else delete globalThis.indexedDB;
  new Function("window", savedJs)(w);
  return w.SavedSearches;
}

describe("the store keeps what it is given", () => {
  let idb;
  let S;

  beforeEach(() => {
    idb = makeFakeIndexedDb();
    S = loadStore(idb);
  });

  test("a saved answer comes back, with the time it was saved", async () => {
    const key = S.keyFor("ai", "24h", "");
    expect(await S.put(key, { pins: [{ id: 1 }], events: [], zoom: "auto" })).toBe(true);
    const got = await S.get(key);
    expect(got).not.toBeNull();
    expect(got.pins).toEqual([{ id: 1 }]);
    expect(typeof got.at).toBe("number");
  });

  test("a key that was never saved is null, not an error", async () => {
    expect(await S.get(S.keyFor("never", "24h", ""))).toBeNull();
  });

  test("the key carries the query, the window and the tag", () => {
    const a = S.keyFor("AI", "24h", "");
    const b = S.keyFor("ai", "24h", "");
    expect(a).toBe(b);                       // case-insensitive
    expect(a).not.toBe(S.keyFor("ai", "7d", ""));
    expect(a).not.toBe(S.keyFor("ai", "24h", "politics"));
    expect(a).not.toBe(S.keyFor("climate", "24h", ""));
  });

  test("an answer older than the limit is not served", async () => {
    const key = S.keyFor("ai", "24h", "");
    await S.put(key, { pins: [{ id: 1 }] });
    // Backdate it past the age limit.
    const store = idb._stores.get("searches");
    const rec = store.get(key);
    rec.at = Date.now() - (S.MAX_AGE_MS + 60_000);
    store.set(key, rec);
    expect(await S.get(key)).toBeNull();
  });

  test("the store keeps only the most recent searches", async () => {
    for (let i = 0; i < S.MAX_ENTRIES + 4; i++) {
      await S.put(S.keyFor(`q${i}`, "24h", ""), { pins: [{ id: i }] });
      // Keep the insertion order unambiguous.
      await new Promise((r) => setTimeout(r, 2));
    }
    const all = await S.list();
    expect(all.length).toBe(S.MAX_ENTRIES);
    // …and the ones kept are the NEWEST.
    expect(all[0].pins[0].id).toBe(S.MAX_ENTRIES + 3);
    expect(all[all.length - 1].pins[0].id).toBe(4);
  });

  test("list() is newest first, and clear() empties it", async () => {
    await S.put(S.keyFor("a", "24h", ""), { pins: [{ id: 1 }] });
    await new Promise((r) => setTimeout(r, 2));
    await S.put(S.keyFor("b", "24h", ""), { pins: [{ id: 2 }] });
    const list = await S.list();
    expect(list.map((r) => r.pins[0].id)).toEqual([2, 1]);
    await S.clear();
    expect((await S.list()).length).toBe(0);
  });
});

describe("a browser that cannot store anything must not break the page", () => {
  test("without IndexedDB the store is a no-op, not a crash", async () => {
    const S = loadStore(null);
    expect(await S.get("anything")).toBeNull();
    expect(await S.put("anything", { pins: [] })).toBe(false);
    expect((await S.list()).length).toBe(0);
  });

  test("an IndexedDB that throws on open is treated the same way", async () => {
    const hostile = {
      open() { throw new Error("SecurityError: storage is disabled"); },
    };
    const S = loadStore(hostile);
    expect(await S.get("anything")).toBeNull();
    expect(await S.put("anything", { pins: [] })).toBe(false);
  });
});

describe("the store is disk, not memory", () => {
  test("it is IndexedDB, not localStorage", () => {
    // A 773 KB answer would blow the localStorage quota in five searches.
    expect(savedJs).toMatch(/indexedDB\.open/);
    expect(savedJs).not.toMatch(/localStorage/);
  });

  test("it is capped, and the cap is small", () => {
    expect(savedJs).toMatch(/const MAX_ENTRIES = 12;/);
    expect(savedJs).toMatch(/const MAX_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  });

  test("a store that cannot open does not break the page", () => {
    // Private mode, a disabled API: the feature simply does not work.
    expect(savedJs).toMatch(/broken = true;/);
    expect(savedJs).toMatch(/catch \(_\) \{\s*\n\s*return null;/);
  });

  test("it exposes what a reader could ask for", () => {
    expect(savedJs).toMatch(/window\.SavedSearches = \{/);
    expect(savedJs).toMatch(/keyFor,/);
    expect(savedJs).toMatch(/get,/);
    expect(savedJs).toMatch(/put,/);
    expect(savedJs).toMatch(/list,/);
    expect(savedJs).toMatch(/clear,/);
  });
});

describe("the search uses it", () => {
  const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

  test("the saved answer is shown while the fresh one is on its way", () => {
    // The order is the whole feature: the saved answer is painted
    // BEFORE the slow pin query is awaited.
    const body = appJs.slice(appJs.indexOf("async function runSearch"));
    const savedAt = body.indexOf("const saved = await savedPromise;");
    const fetchAt = body.indexOf("const fetched = await fastFetches;");
    expect(savedAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(savedAt).toBeLessThan(fetchAt);
  });

  test("the reader is told the answer is being refreshed", () => {
    expect(appJs).toMatch(/Showing saved results.*searching for newer…/);
    // …and told again when the fresh answer lands.
    expect(appJs).toMatch(/const freshNote = shownSaved \? " · updated ✓" : "";/);
  });

  test("the saved answer is framed by the SAME function as a live one", () => {
    // A saved search must never put the map somewhere a fresh search
    // would not — so the framing DECISION is not saved, only its inputs.
    expect(appJs).toMatch(/frameSearchRegion\(\{\s*\n\s*q, geo: saved\.geo \|\| null, bestLoc: saved\.bestLoc \|\| null,/);
    expect(appJs).not.toMatch(/saved\.framing/);
  });

  test("what is saved is slimmed", () => {
    // word_freq is 45 % of the payload and the popup fetches its
    // keywords on demand.
    expect(appJs).toMatch(/delete c\.word_freq;/);
  });

  test("the answer is saved only when there is one", () => {
    expect(appJs).toMatch(/if \(savedKey && window\.SavedSearches && pins && pins\.pins && pins\.pins\.length\) \{/);
  });

  test("the key carries the time WINDOW, not the timestamp", () => {
    // getSinceDate() snaps to a 60-second boundary, so a timestamp in
    // the key changes every minute and the saved answer would never be
    // found again.
    expect(appJs).toMatch(/const windowKey = timeFilter === "custom"/);
    expect(appJs).toMatch(/SavedSearches\.keyFor\(q, windowKey, _activeTag\)/);
  });
});

describe("the server's copy is byte-budgeted", () => {
  const cacheTs = readFileSync(join(ROOT, "..", "api", "src", "cache.ts"), "utf8");

  test("the search cache has a byte budget", () => {
    // An entry-count limit cannot express a MEMORY limit: a search
    // answer is up to 1.5 MB, so 200 of them was a 300 MB ceiling.
    expect(cacheTs).toMatch(/export const searchCache = new SimpleLRUCache<any>\(200, 5 \* 60_000, 64 \* 1024 \* 1024\);/);
    expect(cacheTs).toMatch(/private maxBytes: number;/);
    expect(cacheTs).toMatch(/while \(this\.maxBytes > 0 && this\.bytes > this\.maxBytes/);
  });

  test("the TTL stays a hard 5 minutes", () => {
    // A cached answer older than that would be yesterday's news served
    // as if it were this morning's.
    expect(cacheTs).toMatch(/5 \* 60_000/);
  });

  test("the route tells the cache how big the answer is", () => {
    const pinsTs = readFileSync(join(ROOT, "..", "api", "src", "routes", "pins.ts"), "utf8");
    expect(pinsTs).toMatch(/activeCache\.set\(cacheKey, payload, undefined, approxBytes\)/);
    expect(pinsTs).toMatch(/const approxBytes = \(payload\.pins\?\.length \|\| 0\) \* 1600 \+ 512;/);
  });
});
