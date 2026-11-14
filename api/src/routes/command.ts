import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";

export const commandRoute = new Hono();

// Quick wins: /api/command calls an external AI model — cap to prevent
// runaway queries from a single client (AI cost + latency amplification).
const commandLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

const CommandSchema = z.object({
  query: z.string().max(500).optional().default(""),
  bbox: z.string().optional(),
  zoom: z.number().optional(),
  center_lat: z.number().min(-90).max(90).optional(),
  center_lng: z.number().min(-180).max(180).optional(),
  pin_count: z.number().int().min(0).optional().default(0),
});

// ── POST /api/command ────────────────────────────────────────────────
// Unified AI-powered command endpoint. Interprets user intent from
// natural language + map context, returns structured actions.
commandRoute.post("/", zValidator("json", CommandSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = commandLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }
  const data = c.req.valid("json");
  const query = data.query.trim();
  const sql = getDb();

  // Build map context for the AI prompt
  let mapContext = "";
  if (data.bbox && data.center_lat != null && data.center_lng != null) {
    const [minLng, minLat, maxLng, maxLat] = data.bbox.split(",").map(Number);

    // Get viewport stats
    const [stats] = await sql<Array<{
      pin_count: number;
      country_count: number;
      top_countries: string;
      source_count: number;
    }>>`
      SELECT
        count(*) AS pin_count,
        count(DISTINCT l.country) AS country_count,
        string_agg(DISTINCT l.country, ', ') AS top_countries,
        count(DISTINCT a.source_id) AS source_count
      FROM news_articles a
      JOIN news_locations l ON l.id = a.location_id
      WHERE l.geom IS NOT NULL
        AND ST_Within(l.geom::geometry, ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326))
        AND a.status IN ('extracted', 'clustered')
    `;

    const pinCount = Number(stats?.pin_count || 0);
    const countryCount = Number(stats?.country_count || 0);
    const sourceCount = Number(stats?.source_count || 0);

    mapContext = `
Map viewport: zoom ${data.zoom || "?"}, center ${data.center_lat?.toFixed(2)},${data.center_lng?.toFixed(2)}
Stories in view: ${pinCount}
Countries visible: ${countryCount} (${stats?.top_countries || "none"})
Sources contributing: ${sourceCount}
User's reported pin count: ${data.pin_count}
`;

    // Determine coverage level
    if (pinCount === 0) {
      mapContext += "\nCoverage: EMPTY — no stories in this area.\n";
    } else if (pinCount < 5) {
      mapContext += "\nCoverage: VERY LOW — only a few stories.\n";
    } else if (pinCount < 20) {
      mapContext += "\nCoverage: LOW — some stories but could use more sources.\n";
    } else {
      mapContext += "\nCoverage: GOOD — active news coverage.\n";
    }
  }

  // Detect intent from query (fast path)
  const intent = detectIntent(query);

  // For chat intent or ambiguous queries, use AI
  if (intent === "chat" || (!intent && query.length > 0)) {
    const aiResponse = await queryAI(query, mapContext);
    return c.json({
      intent: "chat",
      response_text: aiResponse,
      actions: parseActionsFromAI(aiResponse),
      data: null,
    });
  }

  // For structured intents, return actions directly
  const actions: Array<{ type: string; payload: Record<string, unknown> }> = [];

  switch (intent) {
    case "study":
      actions.push({ type: "study", payload: { bbox: data.bbox } });
      break;
    case "explore":
      actions.push({
        type: "explore",
        payload: {
          bbox: data.bbox,
          center_lat: data.center_lat,
          center_lng: data.center_lng,
          map_zoom: data.zoom,
          auto_add: true,
        },
      });
      break;
    case "request":
      actions.push({
        type: "request",
        payload: {
          bbox: data.bbox,
          center_lat: data.center_lat,
          center_lng: data.center_lng,
          map_zoom: data.zoom,
          message: query,
        },
      });
      break;
    case "fly": {
      // Extract city name from query
      const cityMatch = query.replace(/^(go to|fly to|show me|take me to|navigate to)\s+/i, "").trim();
      if (cityMatch) {
        // Search for the city
        const cities = await sql<Array<{
          id: number;
          name: string;
          country_code: string;
          lat: number;
          lng: number;
          population: number;
        }>>`
          SELECT id, name, country_code, lat, lng, population
          FROM world_cities
          WHERE lower(ascii_name) LIKE ${"%" + cityMatch.toLowerCase() + "%"}
          ORDER BY population DESC LIMIT 1
        `;
        if (cities.length > 0) {
          const city = cities[0];
          actions.push({
            type: "fly",
            payload: {
              lat: Number(city.lat),
              lng: Number(city.lng),
              zoom: 10,
              name: city.name,
              country: city.country_code,
            },
          });
        }
      }
      break;
    }
    default:
      // No intent detected — if query is empty, suggest based on context
      if (!query) {
        if (data.pin_count === 0 && (data.zoom || 0) >= 5) {
          actions.push({ type: "suggest", payload: { suggestion: "explore", message: "No stories here — explore for sources?" } });
        } else if ((data.pin_count || 0) > 0) {
          actions.push({ type: "suggest", payload: { suggestion: "study", message: `${data.pin_count} stories in view — study this area?` } });
        }
      }
      break;
  }

  return c.json({
    intent: intent || "none",
    response_text: generateResponseText(intent, data),
    actions,
    data: null,
  });
});

// ── Intent detection ─────────────────────────────────────────────────
function detectIntent(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const patterns: Array<[string, RegExp[]]> = [
    ["study", [/stud(y|ying)/, /analy[sz]e/, /what.s here/, /overview/, /summary/, /density/]],
    ["explore", [/explor(e|ing)/, /find sources/, /discover/, /scan/, /search for (news|sources)/]],
    ["request", [/request/, /more (news|coverage)/, /need (news|coverage)/, /priorit/, /empty/, /no (news|sources|coverage)/]],
    ["fly", [/^(go to|fly to|show me|take me to|navigate to)\s+/]],
    ["chat", [/^(what|why|how|who|when|where|can you|tell me)/]],
  ];

  for (const [intent, regs] of patterns) {
    for (const r of regs) {
      if (r.test(q)) return intent;
    }
  }
  return null;
}

// ── AI query ─────────────────────────────────────────────────────────
async function queryAI(query: string, mapContext: string): Promise<string> {
  const AI_ENDPOINT = process.env.XYZO_AI_CHAT_URL || "http://192.168.1.3:8888/chat/stream";

  const systemPrompt = `You are Xyzo's AI assistant for a global news map. You help users understand news coverage, discover sources, and explore areas.

Current map context:
${mapContext}

Be concise (2-3 sentences max). If the area has no coverage, suggest exploring. If it has good coverage, highlight interesting stories. Always be helpful and actionable.`;

  try {
    const resp = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MCP-Safe": "true" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return "I'm having trouble thinking right now. Try again?";

    const data = await resp.json() as { response?: string };
    return data.response || "I couldn't find an answer for that.";
  } catch {
    return "AI is unavailable right now. Try exploring or studying the map directly.";
  }
}

// ── Parse AI actions from response ───────────────────────────────────
function parseActionsFromAI(response: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const actions: Array<{ type: string; payload: Record<string, unknown> }> = [];

  // Look for action hints in AI response
  if (/explor|discover|find sources/i.test(response)) {
    actions.push({ type: "suggest", payload: { suggestion: "explore", message: "Want me to explore this area for sources?" } });
  }
  if (/request|coverage|prioritize/i.test(response)) {
    actions.push({ type: "suggest", payload: { suggestion: "request", message: "Want to request more coverage here?" } });
  }

  return actions;
}

// ── Generate response text for structured intents ────────────────────
function generateResponseText(intent: string | null, data: z.infer<typeof CommandSchema>): string {
  switch (intent) {
    case "study":
      return "Analyzing this area's news coverage...";
    case "explore":
      return "Discovering news sources in this region...";
    case "request":
      return "Submitting your coverage request...";
    case "fly":
      return "Flying to location...";
    default:
      return "";
  }
}
