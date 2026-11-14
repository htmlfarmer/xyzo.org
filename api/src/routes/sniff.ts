import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { safeFetch, BlockedUrlError } from "../lib/ssrf";

export const sniffRoute = new Hono();

// 30 requests / hour / IP — the sniff does a HEAD + body fetch so
// it's not free.
const sniffLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

const SniffSchema = z.object({
  url: z.string().url().max(2000).optional(),
  text: z.string().min(3).max(10000).optional(),
}).refine(
  (o) => Boolean(o.url) || Boolean(o.text),
  { message: "url or text required", path: ["url"] },
);

const USER_AGENT = "xyzo-sniff/1.0 (https://xyzo.org; contact@xyzo.org)";

interface CityMatch {
  city_id: number;
  name: string;
  ascii_name: string;
  country_code: string;
  lat: number;
  lng: number;
  population: number;
  match_kind: "name" | "alias";
  confidence: "high" | "medium" | "low";
}

// ── Skip-words mirroring worker/cities_text.py ─────────────────────
const SKIP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "this", "that", "are", "was",
  "be", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall", "not", "no",
  "new", "old", "big", "small", "good", "bad", "first", "last",
  "long", "great", "little", "own", "other", "right", "high",
  "different", "large", "next", "early", "young", "important",
  "few", "public", "same", "able", "north", "south", "east", "west",
  "report", "news", "story", "article", "today", "yesterday",
  "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "january", "february", "march", "april",
  "may", "june", "july", "august", "september", "october", "november",
  "december", "us", "usa", "uk", "eu", "un",
  "man", "men", "most", "reading", "mobile", "deal", "nice", "bath",
  "best", "normal", "union", "central", "general", "van", "sur",
  "split", "splits", "sale", "sales", "independence", "surprise",
  "university", "college", "enterprise", "marathon", "liberty",
  "concord", "harmony", "metro", "overall", "worth", "vista", "plano",
  "xinhua", "sino", "centro", "san", "los", "las", "dos", "tres",
  "por", "sin", "mas", "algo", "nada", "casa", "como", "viven",
  "vida", "tierra", "hijos", "para", "aba", "toda", "todo", "todas",
  "todos", "ise", "lira", "kisi", "noma", "koka", "mura", "mora",
  "tema", "temas",
]);

const MULTI_WORD = [
  "tema, ghana", "tema, gh", "port of tema", "tema port", "tema motorway",
  "new york city", "new york", "nueva york", "nova york", "nova iorque",
  "nuova york", "neu-york", "neuyork", "нью-йорк", "нью йорк", "нью-йорка",
  "los angeles", "san francisco", "san diego", "san jose", "san antonio",
  "san salvador", "sao paulo", "são paulo", "buenos aires", "rio de janeiro",
  "mexico city", "ciudad de mexico", "ciudad de méxico", "cidade do mexico",
  "cidade do méxico", "città del messico", "kuala lumpur", "hong kong",
  "new orleans", "nueva orleans", "nova orleans", "nuova orleans",
  "la nouvelle-orléans", "la nouvelle orléans", "nouvelle orléans",
  "nouvelle orleans", "новый орлеан", "новом орлеане",
  "new delhi", "nueva delhi", "nova deli", "nuova delhi", "neu-delhi",
  "neu delhi", "нью-дели", "нью дели",
  "nuevo mexico", "nuevo méxico", "novo mexico", "novo méxico",
  "nouveau-mexique", "nouveau mexique", "neu-mexiko", "neu mexiko",
  "nueva jersey", "nova jersey", "нью-джерси", "нью джерси",
  "las vegas", "los altos", "cape town", "dar es salaam", "addis ababa",
  "abu dhabi", "tel aviv", "west bank", "gaza strip", "ho chi minh city",
  "phnom penh", "saint petersburg", "st petersburg", "st. petersburg",
  "saint louis", "st louis", "st. louis",
];

const ALIASES: Record<string, string> = {
  nyc: "New York City",
  "new york": "New York City",
  "nueva york": "New York City",
  "nova york": "New York City",
  "nuova york": "New York City",
  "neu-york": "New York City",
  "нью-йорк": "New York City",
  "nueva orleans": "New Orleans",
  "nouvelle orleans": "New Orleans",
  "nuevo mexico": "Albuquerque",
  "nueva delhi": "New Delhi",
  delhi: "New Delhi",
  la: "Los Angeles", sf: "San Francisco", dc: "Washington",
  philly: "Philadelphia", vegas: "Las Vegas", bombay: "Mumbai",
  madras: "Chennai", calcutta: "Kolkata", bangalore: "Bengaluru",
  peking: "Beijing", saigon: "Ho Chi Minh City", hcmc: "Ho Chi Minh City",
  hk: "Hong Kong", cdmx: "Mexico City", rio: "Rio de Janeiro",
  ba: "Buenos Aires", joburg: "Johannesburg",
};

function asciiFold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function confidenceFor(p: number): "high" | "medium" | "low" {
  if (p >= 1_000_000) return "high";
  if (p >= 250_000) return "medium";
  return "low";
}

// ── DB-backed city lookup (loads index once per request) ─────────────
async function loadCityIndex(sql: ReturnType<typeof getDb>) {
  const rows = await sql<Array<{
    id: number;
    name: string;
    ascii_name: string;
    country_code: string;
    lat: number;
    lng: number;
    population: number;
  }>>`
    SELECT id, name, ascii_name, country_code, lat, lng, population
    FROM world_cities
    WHERE population >= 100000
  `;
  const byName = new Map<string, typeof rows>();
  const multiWord = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const nm = (r.name || "").toLowerCase();
    if (!nm) continue;
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm)!.push(r);
    const phrase = nm.trim();
    if (phrase.includes(" ")) {
      const existing = multiWord.get(phrase);
      if (!existing || r.population > existing.population) {
        multiWord.set(phrase, r);
      }
    }
  }
  return { byName, multiWord };
}

function bestMatch(matches: Array<{ population: number }>) {
  if (matches.length === 0) return null;
  return matches.slice().sort((a, b) => b.population - a.population)[0];
}

function detectCities(text: string, idx: Awaited<ReturnType<typeof loadCityIndex>>): CityMatch[] {
  if (!text || text.length < 3) return [];
  const lc = text.toLowerCase();
  const out: CityMatch[] = [];

  // Multi-word first.
  const phrases = [...idx.multiWord.keys()]
    .filter((p) => p.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    let from = 0;
    while (true) {
      const idx_ = lc.indexOf(phrase, from);
      if (idx_ === -1) break;
      const before = idx_ === 0 ? " " : text[idx_ - 1];
      const afterIdx = idx_ + phrase.length;
      const after = afterIdx >= text.length ? " " : text[afterIdx];
      if (!/[a-z0-9_]/i.test(before) && !/[a-z0-9_]/i.test(after)) {
        const city = idx.multiWord.get(phrase)!;
        out.push({
          city_id: Number(city.id),
          name: city.name,
          ascii_name: city.ascii_name,
          country_code: city.country_code,
          lat: Number(city.lat),
          lng: Number(city.lng),
          population: Number(city.population),
          match_kind: "name",
          confidence: confidenceFor(city.population),
        });
      }
      from = idx_ + 1;
    }
  }

  // Single-word.
  const wordRe = /[A-Za-zÀ-ÿ\u00C0-\u017F]+/g;
  let m;
  while ((m = wordRe.exec(text)) !== null) {
    const w = m[0];
    const lower = w.toLowerCase();
    const folded = asciiFold(w);
    if (w.length < 3) continue;
    if (SKIP_WORDS.has(lower) || SKIP_WORDS.has(folded)) continue;

    const hits = idx.byName.get(lower) || idx.byName.get(folded) || [];
    const best = bestMatch(hits);
    if (best) {
      out.push({
        city_id: Number(best.id),
        name: best.name,
        ascii_name: best.ascii_name,
        country_code: best.country_code,
        lat: Number(best.lat),
        lng: Number(best.lng),
        population: Number(best.population),
        match_kind: "name",
        confidence: confidenceFor(best.population),
      });
      continue;
    }
    if (ALIASES[lower]) {
      const aliasHits = idx.byName.get(ALIASES[lower].toLowerCase()) || [];
      const aliasBest = bestMatch(aliasHits);
      if (aliasBest) {
        out.push({
          city_id: Number(aliasBest.id),
          name: aliasBest.name,
          ascii_name: aliasBest.ascii_name,
          country_code: aliasBest.country_code,
          lat: Number(aliasBest.lat),
          lng: Number(aliasBest.lng),
          population: Number(aliasBest.population),
          match_kind: "alias",
          confidence: "high",
        });
      }
    }
  }
  return out;
}

// ── Strip HTML + truncate for sniffer display ───────────────────────
function htmlToText(html: string, maxLen = 5000): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/\s+/g, " ").trim()
    .slice(0, maxLen);
}

// ── POST /api/sniff ─────────────────────────────────────────────────
//
// Body: { url?: string, text?: string }
// Returns: { cities: [...], primary, is_national, source }
//
// Powers:
//   - Submit-form location prefill ("looks like a Mumbai story —
//     place pin here?")
//   - Admin tools: paste a URL, see where the source covers
//   - "Flag a story" workflow: if a user flags a story, we sniff
//     it and surface cities for the admin's triage queue.
sniffRoute.post(
  "/sniff",
  zValidator("json", SniffSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = sniffLimiter.check(ip);
    if (!rl.allowed) {
      const sec = Math.ceil(rl.retryAfterMs / 1000);
      return c.json({ error: "rate_limited", retry_after_s: sec }, 429);
    }
    const { url, text } = c.req.valid("json");

    let source: { kind: "url" | "text"; preview?: string; bytes?: number } = { kind: "text" };
    let body = text || "";
    if (url) {
      try {
        // FIX_NOTES 2.2: this endpoint used to fetch ANY user URL with
        // redirects followed and echo the first 500 chars of the response
        // — a full internal-network read oracle (metadata service,
        // localhost API, the LAN AI box). Now: resolve-then-validate,
        // https/http only, every hop re-checked.
        const { res: resp } = await safeFetch(url, {
          headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
        });
        if (!resp.ok) {
          return c.json({
            error: "fetch_failed",
            status: resp.status,
            url,
          }, 502);
        }
        const html = await resp.text();
        body = htmlToText(html, 8000);
        source = { kind: "url", preview: body.slice(0, 500), bytes: html.length };
      } catch (e: any) {
        if (e instanceof BlockedUrlError) {
          return c.json({ error: "url_blocked", message: "Target resolves to a private or disallowed address" }, 400);
        }
        return c.json({ error: "fetch_error", message: e.message }, 502);
      }
    }

    if (!body || body.length < 3) {
      return c.json({ cities: [], primary: null, source, is_national: false });
    }

    const sql = getDb();
    const idx = await loadCityIndex(sql);
    const cities = detectCities(body, idx);

    const dedup = new Map<number, CityMatch>();
    for (const c of cities) dedup.set(c.city_id, c);
    const unique = [...dedup.values()];
    const primary = bestMatch(unique) ?? null;
    const countries = new Set(unique.map((c) => c.country_code));

    return c.json({
      source,
      cities: unique.slice(0, 25),
      primary: primary && {
        city_id: primary.city_id,
        name: primary.name,
        country_code: primary.country_code,
        lat: primary.lat,
        lng: primary.lng,
        population: primary.population,
      },
      is_national: countries.size > 1,
      countries: [...countries],
      count: unique.length,
    });
  },
);
