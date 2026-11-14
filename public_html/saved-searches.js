/**
 * saved-searches.js — a small store of search results.
 *
 * WHY THIS EXISTS.
 *
 * A text search is the slowest thing on the site. The pin query ranks
 * with ts_rank_cd over the whole corpus and measures **3–50 s** cold
 * (README Q-N28), and the event search spawns a Python worker for
 * another **30–90 s**. The reader watched an empty map for a minute and
 * a half and then got an answer.
 *
 * So the previous answer is KEPT and shown at once, with a note that
 * the fresh one is on its way; when it lands it replaces the old one.
 * That is stale-while-revalidate, and it is what makes a repeat search
 * feel instant.
 *
 * WHERE IT LIVES — AND THE MEMORY ANSWER.
 *
 * **The QUERY is free: a key is a few dozen bytes. The RESULTS are
 * not.** Measured 2026-11-09: a 1,000-pin answer is **1.5 MB** of JSON
 * (1,620 B a pin), of which `word_freq` alone is **711 KB (45 %)**. So:
 *
 *   - The browser keeps the results in **IndexedDB — DISK, not RAM**.
 *     The copies are slimmed (no `word_freq`: the popup fetches its
 *     keywords on demand from /api/pins/:id/words) → **773 KB a
 *     search**, and the store holds the **12 most recent** searches, so
 *     ≈ **9 MB of disk**. Nothing is added to the tab's memory beyond
 *     what the live search already puts there.
 *   - The **server** keeps a copy too (the 5-minute search cache), and
 *     that one IS RAM — so it is byte-budgeted (api/src/cache.ts).
 *
 * WHAT IS SAVED: the pin list, the event list, and the two small
 * lookups the map framing needs (the geocode and the location match).
 * The framing is NOT saved as a decision — it is recomputed by the SAME
 * function that frames a live search (frameSearchRegion), so a saved
 * search cannot frame the map differently from a fresh one.
 *
 * WHAT IS NOT SAVED: the reader's search history is nobody else's
 * business — this is per-browser, on the reader's own disk.
 */
(function () {
  "use strict";

  const DB_NAME = "xyzo-saved-searches";
  const STORE = "searches";
  const DB_VERSION = 1;

  /** How many searches are kept. 12 × ≈0.8 MB ≈ 9 MB of disk. */
  const MAX_ENTRIES = 12;
  /** A saved answer older than this is not worth showing. */
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  let dbPromise = null;
  let broken = false;

  function openDb() {
    if (broken) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (_) {
        // Private mode, a disabled API, an old browser: the feature
        // simply does not work, and nothing else may break.
        broken = true;
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { broken = true; resolve(null); };
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function reqDone(request) {
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  /**
   * The key of a search. Everything that changes the ANSWER is in it:
   * the query, the time window and the active topic tag. The pin
   * DENSITY is a rendering setting, so it is not.
   */
  function keyFor(query, since, tag) {
    return `${String(query || "").trim().toLowerCase()}|${since || ""}|${tag || ""}`;
  }

  /** The saved answer for a key, or null (missing, too old, or broken). */
  async function get(key) {
    try {
      const db = await openDb();
      if (!db) return null;
      const row = await reqDone(tx(db, "readonly").get(key));
      if (!row || !row.payload) return null;
      const age = Date.now() - (row.at || 0);
      if (!(age >= 0) || age > MAX_AGE_MS) return null;
      return Object.assign({ at: row.at, ageMs: age }, row.payload);
    } catch (_) {
      return null;
    }
  }

  /** Save an answer, and keep the store to MAX_ENTRIES. */
  async function put(key, payload) {
    try {
      const db = await openDb();
      if (!db) return false;
      const at = Date.now();
      const store = tx(db, "readwrite");
      await reqDone(store.put({ key, at, payload }));
      await prune(db);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Drop the oldest answers beyond MAX_ENTRIES, and any that expired. */
  async function prune(db) {
    try {
      const store = tx(db, "readwrite");
      const all = (await reqDone(store.getAll())) || [];
      const now = Date.now();
      const live = all.filter((r) => now - (r.at || 0) <= MAX_AGE_MS);
      live.sort((a, b) => (b.at || 0) - (a.at || 0));
      const doomed = all.filter((r) => now - (r.at || 0) > MAX_AGE_MS)
        .concat(live.slice(MAX_ENTRIES));
      for (const r of doomed) await reqDone(store.delete(r.key));
    } catch (_) {}
  }

  /** Every saved answer, newest first. */
  async function list() {
    try {
      const db = await openDb();
      if (!db) return [];
      const all = (await reqDone(tx(db, "readonly").getAll())) || [];
      const now = Date.now();
      return all
        .filter((r) => now - (r.at || 0) <= MAX_AGE_MS)
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .map((r) => Object.assign({ at: r.at }, r.payload));
    } catch (_) {
      return [];
    }
  }

  /** Forget everything (the reader's own "clear saved searches"). */
  async function clear() {
    try {
      const db = await openDb();
      if (!db) return;
      await reqDone(tx(db, "readwrite").clear());
    } catch (_) {}
  }

  window.SavedSearches = {
    keyFor,
    get,
    put,
    list,
    clear,
    MAX_ENTRIES,
    MAX_AGE_MS,
  };
})();
