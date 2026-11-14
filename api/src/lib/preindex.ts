/**
 * preindex.ts — the server-side pre-index of popular searches.
 *
 * THE SHAPE OF THE THING. A text search is the slowest thing on the
 * site: it ranks with ts_rank_cd over the whole corpus and (before the
 * index fixes of 2026-11-11) measured 24–75 s cold. The pre-index
 * answers the most-searched queries from a stored answer instead, and a
 * background job (worker/search_preindex.py) keeps that answer current.
 * The reader gets the answer in ~100 ms; the live query is still
 * running, and the stored answer says how old it is.
 *
 * WHAT IS STORED IS THE ANSWER, NOT THE STORIES. The payload holds the
 * pin list as the API serves it, slimmed of word_freq (the popup fetches
 * its keywords on demand from /api/pins/:id/words — the same slimming
 * the browser-side saved-searches store does). The ARTICLES are never
 * copied: a stored answer points at live rows, so titles, images and
 * timestamps are always current. Only the SELECTION is precomputed, and
 * the background job recomputes it.
 *
 * THE KEY CARRIES THE TIME WINDOW, NOT THE TIMESTAMP. The frontend asks
 * for "24h" as `since=<now - 24h, snapped to the minute>`, so a key
 * built from the timestamp would change every minute and the stored
 * answer would never be found again — the exact trap the browser-side
 * store documents ("which is exactly what happened when this was first
 * built: the saved copy was written and never read back"). The window
 * is derived from the AGE of `since`, and the key is `query | window |
 * tag`.
 */

import { encodeCursor } from "../cursors";

export const PREINDEX_DEFAULT_LIMIT = 1000;

/** The windows the site offers, plus the derived custom ones. */
export type SearchWindow = string;

/**
 * The window a `since` parameter means.
 *
 * The frontend sends an ISO timestamp, so the window has to be derived
 * from its age. The minute snap (getSinceDate snaps `now` to a 60-second
 * boundary) is why the tolerance is a twentieth of a day — an hour.
 * A `since` that is NOT near a whole day is a custom window, and it is
 * labelled by its rounded length so the key stays stable while the
 * reader keeps the same filter.
 */
export function windowKeyFor(since: string | undefined | null, nowMs: number = Date.now()): SearchWindow {
  if (!since) return "all";
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return "all";
  const days = (nowMs - t) / 86400000;
  if (days < 0) return "all";
  const nearest = Math.round(days);
  if (nearest >= 1 && Math.abs(days - nearest) < 0.02) {
    if (nearest === 1) return "24h";
    if (nearest === 365) return "365d";
    return `${nearest}d`;
  }
  return `custom:${Math.max(1, Math.round(days))}`;
}

/**
 * The normalised query. Fold the accents and the case, because "Sao
 * Paulo", "são paulo" and "SÃO PAULO" are one query to a reader and
 * three to a key.
 */
export function normaliseQuery(q: string): string {
  return String(q || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * The key: `query | window | tag`.
 *
 * The pin DENSITY is a rendering setting, so it is not in the key; the
 * LIMIT is, because a 500-pin answer and a 1,000-pin answer are
 * different answers.
 */
export function queryKeyFor(query: string, window: SearchWindow, tag: string | null | undefined, limit: number): string {
  return `${normaliseQuery(query)}|${window}|${normaliseQuery(tag || "")}|${limit}`;
}

/**
 * The age at which a stored answer stops being offered.
 *
 * The builder refreshes the list continuously, so an hour-old entry is
 * being rewritten as you read this. The server's own RAM cache keeps a
 * hard 5-minute TTL ("a cached answer older than that would be
 * yesterday's news served as if it were this morning's") — but that
 * cache is rebuilt on demand, whereas the pre-index is refreshed in the
 * background, and the reader is told the age of what they got. Six
 * hours is the point at which the background refresh has clearly
 * failed, and the answer is then not served at all.
 */
export const PREINDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface PreindexRow {
  payload: any;
  built_at: string;
  pin_count: number;
  query: string;
  window: string;
}

/**
 * Slice a stored answer down to a SMALLER limit.
 *
 * WHY THIS IS HONEST. The stored answer is the RANKED list — the same
 * rows, in the same order, that the live query returns (the ORDER BY
 * does not depend on the limit). So the first N of a 1,000-pin stored
 * answer is exactly what the live query would have answered for N. The
 * only thing that has to be recomputed is the pagination: `has_more`
 * and the cursor, which point at the last row that was kept.
 *
 * WITHOUT IT, a reader who asks for 100 pins of a query stored at 1,000
 * pays the whole live query — and the site has a 500-pin answer for
 * the same query sitting right there.
 */
function sliceToLimit(payload: any, limit: number): any {
  const pins = Array.isArray(payload?.pins) ? payload.pins : [];
  if (pins.length <= limit) return payload;
  const kept = pins.slice(0, limit);
  const last = kept[kept.length - 1];
  const more = pins.length > limit || Boolean(payload?.has_more);
  let next_cursor: string | null = null;
  if (more && last && last.created_at && last.id != null) {
    try {
      next_cursor = encodeCursor(new Date(last.created_at), Number(last.id));
    } catch {
      next_cursor = null;
    }
  }
  return { ...payload, pins: kept, has_more: more, next_cursor };
}

/**
 * Read a stored answer, if there is one that is fresh enough to serve.
 *
 * Returns null when there is no entry, when the entry has expired, or
 * when the query is not one the pre-index covers (a bbox, a cursor, a
 * category or a tag filter — those are different answers and the
 * pre-index does not hold them).
 *
 * THE LIMIT IS NOT A REASON TO MISS. The exact key is tried first; if
 * there is no answer at exactly that limit, the SMALLEST stored answer
 * that is at least as large is used and sliced — the ranking is the
 * same, so the answer is the same (see sliceToLimit above). A limit
 * LARGER than anything stored cannot be sliced, and falls through to
 * the live query.
 */
export async function lookupPreindex(
  sql: any,
  opts: { query: string; window: SearchWindow; tag?: string | null; limit: number; nowMs?: number },
): Promise<PreindexRow | null> {
  const now = opts.nowMs ?? Date.now();
  const key = queryKeyFor(opts.query, opts.window, opts.tag, opts.limit);
  let rows: any[] = [];
  try {
    rows = await sql`
      SELECT payload, built_at, pin_count, query, time_window, limit_n
      FROM search_preindex
      WHERE query_key = ${key} AND time_window = ${opts.window} AND tag = ${normaliseQuery(opts.tag || "")}
        AND limit_n = ${opts.limit}
        AND built_at > now() - (${PREINDEX_MAX_AGE_MS}::bigint * interval '1 millisecond')
      LIMIT 1`;

    // NO EXACT ANSWER → LOOK FOR A BIGGER ONE TO SLICE. The smallest
    // stored answer that covers the requested limit is the right one:
    // a bigger answer costs more to slice, not less.
    //
    // The stored key is `query | window | tag | limit`, so the rows for
    // the same query are a PREFIX of that key. The prefix is matched
    // with LIKE rather than a range: the collation's idea of where
    // U+FFFF sorts is not the byte order, so a `>= prefix AND <
    // prefix || U+FFFF` range MISSES the rows (measured). The table is
    // a few thousand rows, and the equality columns carry an index.
    if (!rows || rows.length === 0) {
      const prefix = `${normaliseQuery(opts.query)}|${opts.window}|${normaliseQuery(opts.tag || "")}|`;
      rows = await sql`
        SELECT payload, built_at, pin_count, query, time_window, limit_n
        FROM search_preindex
        WHERE query_key LIKE ${prefix + "%"}
          AND time_window = ${opts.window} AND tag = ${normaliseQuery(opts.tag || "")}
          AND limit_n >= ${opts.limit}
          AND built_at > now() - (${PREINDEX_MAX_AGE_MS}::bigint * interval '1 millisecond')
        ORDER BY limit_n ASC
        LIMIT 1`;
    }
  } catch (e) {
    // A missing table (a deployment that has not run the migration) must
    // never FAIL a search — the live query is right there. But it must
    // not fail SILENTLY either: a swallowed error here looks exactly
    // like "the pre-index never hits", which is what happened once
    // already (the SELECT listed `window`, a reserved word, and the
    // catch turned the syntax error into a permanent miss with nothing
    // in the log).
    console.warn("[preindex] lookup failed:", (e as Error).message);
    return null;
  }
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  const payload = sliceToLimit(r.payload, opts.limit);
  return {
    payload,
    built_at: r.built_at instanceof Date ? r.built_at.toISOString() : String(r.built_at),
    pin_count: Number(r.pin_count || 0),
    query: String(r.query),
    window: String(r.window),
  };
}

/**
 * Record that a query was asked for. This is what makes the pre-index's
 * candidate list the REAL demand instead of a guess: the table
 * (search_query_stats) was designed for exactly this and had one row in
 * it, because only /api/searches/save wrote to it.
 */
export async function recordQueryUse(sql: any, query: string): Promise<void> {
  const q = normaliseQuery(query);
  if (!q || q.length < 2) return;
  try {
    await sql`
      INSERT INTO search_query_stats (query, kind, use_count, last_used_at)
      VALUES (${q}, 'news', 1, now())
      ON CONFLICT (query) DO UPDATE
        SET use_count = search_query_stats.use_count + 1,
            last_used_at = now()`;
  } catch {
    // Telemetry must never fail a search.
  }
}
