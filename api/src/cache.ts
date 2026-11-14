/**
 * High-performance in-memory LRU cache with TTL for API endpoints.
 * Prevents database query thundering herds on frequent bounding-box map queries.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  /** Approximate size in bytes — what the byte budget is measured against. */
  bytes: number;
}

export class SimpleLRUCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxEntries: number;
  private defaultTtlMs: number;
  private maxBytes: number;
  private bytes = 0;

  constructor(maxEntries = 200, defaultTtlMs = 15000, maxBytes = 0) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.maxBytes = maxBytes;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.bytes -= entry.bytes;
      return null;
    }

    // Refresh LRU order by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /**
   * `approxBytes` is the caller's estimate of the entry's size.
   *
   * An entry-count limit cannot express a MEMORY limit, and the entries
   * here are not interchangeable in size: a 1,000-pin search answer is
   * **1.5 MB** of JSON, so 200 of them is 300 MB of RAM in the API
   * process. With a byte budget the cache holds what it can afford and
   * no more.
   */
  set(key: string, value: T, ttlMs?: number, approxBytes = 0): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

    if (this.cache.has(key)) {
      const prev = this.cache.get(key)!;
      this.bytes -= prev.bytes;
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry (first key in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.cache.get(oldestKey);
        if (oldest) this.bytes -= oldest.bytes;
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { value, expiresAt, bytes: approxBytes });
    this.bytes += approxBytes;

    // Evict the oldest entries until the cache is back inside its byte
    // budget. One entry is always kept: a single answer that is over the
    // budget on its own is still better than none.
    while (this.maxBytes > 0 && this.bytes > this.maxBytes && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.cache.get(oldestKey);
      if (oldest) this.bytes -= oldest.bytes;
      this.cache.delete(oldestKey);
    }
  }

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
  }

  /** The cache's approximate size in bytes. */
  byteSize(): number {
    return this.bytes;
  }

  evictByPrefix(prefix: string): number {
    let evicted = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  evictByPredicate(predicate: (key: string) => boolean): number {
    let evicted = 0;
    for (const key of this.cache.keys()) {
      if (predicate(key)) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Active User Concurrency Tracker
 * Tracks unique client IPs / sessions active in the last 60 seconds.
 */
export class ActiveUserTracker {
  private users = new Map<string, number>();
  private ttlMs = 60000; // 60-second activity window

  recordActivity(clientId: string): void {
    if (!clientId) return;
    this.users.set(clientId, Date.now());
  }

  getActiveUserCount(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, ts] of this.users.entries()) {
      if (now - ts <= this.ttlMs) {
        count++;
      } else {
        this.users.delete(id);
      }
    }
    return Math.max(1, count);
  }
}

export const activeUserTracker = new ActiveUserTracker();
export const pinsCache = new SimpleLRUCache<any>(500, 60000);
// Longer-lived cache for text search queries (q= param). These are
// expensive (fuzzy trigram + UNION) and don't change often, so sharing
// across users and keeping for 5 minutes makes shared links fast.
//
// THE BYTE BUDGET IS THE POINT. A search answer is up to 1.5 MB of JSON
// (1,000 pins with their word_freq), so the old 200-entry limit was a
// 300 MB ceiling on the API process's memory — and an entry-count limit
// cannot express a memory limit anyway. 64 MB holds ~40 full answers,
// which is what the popular queries need.
//
// The TTL stays a hard 5 minutes: a cached answer older than that would
// be yesterday's news, and the reader must never be served yesterday's
// news as if it were this morning's.
export const searchCache = new SimpleLRUCache<any>(200, 5 * 60_000, 64 * 1024 * 1024);
