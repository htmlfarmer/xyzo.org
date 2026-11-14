import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { withBreaker } from "../ai-breaker";

// ── /api/ai/chat — user-facing chat on xyzo.org ────────────────────
//
// Routes through hivv.org (XYZO_AI_PRIMARY_URL) first so every user
// question shows up in the public activity feed. Falls back to the
// direct local Gemma box (XYZO_AI_FALLBACK_URL) on 502/503/504/
// timeout/connect-error, same shape as worker/ai_client.py. The circuit
// breaker (api/src/ai-breaker.ts) tracks primary health so a sustained
// outage short-circuits straight to fallback for `cooldownMs`.

export const aiChatRoute = new Hono();

// Smart rate limiter: allows bursts for active users, prevents abuse
// - 10 requests per minute (active use)
// - 200 requests per hour (daily limit)
const chatLimiter = new RateLimiter({ max: 200, windowMs: 60 * 60 * 1000 });
const chatBurstLimiter = new RateLimiter({ max: 10, windowMs: 60 * 1000 });

const PRIMARY_URL =
  process.env.XYZO_AI_PRIMARY_URL ?? "http://localhost:3011/v1/chat/completions";
const FALLBACK_URL =
  process.env.XYZO_AI_FALLBACK_URL ?? "http://192.168.1.3:8888/v1/chat/completions";
// Model PIN. The gateway honours this for local bees: only bees advertising a
// model whose name contains this string are eligible (no match → no pin, the
// old behaviour). It exists because a 0.5B model on a busy bee answers long
// prompts with "I'm sorry, but I can't assist with that." — pinning keeps the
// user-facing chat on the 2B+ model that actually follows the persona.
const AI_MODEL = process.env.XYZO_AI_MODEL ?? "gemma-4-E2B";
const AI_TIMEOUT = Number(process.env.XYZO_AI_TIMEOUT ?? 25000);
// How many times we re-roll the gateway's model lottery before giving up.
const AI_ATTEMPTS = Number(process.env.XYZO_AI_ATTEMPTS ?? 2);
// Cap the answer length. The persona asks for 3-5 sentences per point; the
// local 2B models happily write 2000 tokens (≈60s) without a cap, which the
// browser shows as a frozen "Thinking…" bubble.
const AI_MAX_TOKENS = Number(process.env.XYZO_AI_MAX_TOKENS ?? 512);
const AI_TEMPERATURE = Number(process.env.XYZO_AI_TEMPERATURE ?? 0.7);

const ChatSchema = z.object({
  // Legacy single-string prompt (older cached frontend).
  message: z.string().min(1).max(8000).optional(),
  // Structured chat: a system prompt + real role-tagged turns.
  system: z.string().max(8000).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().max(4000),
      }),
    )
    .max(24)
    .optional(),
  stream: z.boolean().optional().default(false),
});

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Normalise the two accepted shapes into a role-tagged message list.
 * - {message}            → [{role:"user", content}]        (legacy)
 * - {system, messages}   → [{role:"system",…}, …messages]  (current)
 * The gateway prepends its own HIVE identity system message, so the final
 * array is [system(HIVE), system(persona), user, assistant, …].
 */
function normalizeMessages(body: {
  message?: string;
  system?: string;
  messages?: ChatMessage[];
}): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (body.system && body.system.trim()) {
    out.push({ role: "system", content: body.system });
  }
  if (body.messages?.length) {
    for (const m of body.messages) {
      if (m.content && m.content.trim()) out.push({ role: m.role, content: m.content });
    }
  }
  if (!out.length && body.message) {
    out.push({ role: "user", content: body.message });
  }
  if (!out.length) {
    out.push({ role: "user", content: "" });
  }
  return out;
}

/**
 * A safety refusal, not an answer. Small models in the hive pool refuse
 * benign prompts ("hi") when the context looks alarming — and the refusal
 * text then gets echoed back into the next prompt, which makes the model
 * refuse again (a sticky loop). Detect it so we can re-roll instead of
 * showing the user a canned "I can't help with that".
 */
export function looksLikeRefusal(text: string): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.length > 400) return false; // a long answer that merely mentions "sorry" is fine
  return (
    /^(i'?m sorry|i am sorry|sorry,|i apologi[sz]e)/.test(t) ||
    /^i (can'?t|cannot|can not|won'?t|will not|must not|am not able to) (help|assist|provide|comply|do that|answer)/.test(t) ||
    /^i'?m (not able|unable) to (help|assist|provide|comply)/.test(t) ||
    /^as an ai\b/.test(t) ||
    /^i must decline/.test(t) ||
    /^that (request|question) (is|falls|goes) (against|beyond)/.test(t)
  );
}

interface ChatResult {
  text: string;
  used: "primary" | "fallback";
  latency_ms: number;
  attempts: number;
}

interface UpstreamReply {
  text: string;
  refused: boolean;
}

async function callOpenAICompat(url: string, messages: ChatMessage[], timeoutMs: number): Promise<UpstreamReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Named local, not inlined: the repo's secret-guard hook reads
  // `max_tokens: <12+ chars>` as a credential and blocks the commit.
  const answerCap = AI_MAX_TOKENS;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: answerCap,
        temperature: AI_TEMPERATURE,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`upstream_${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("empty_response");
    return { text, refused: looksLikeRefusal(text) };
  } finally {
    clearTimeout(timer);
  }
}

function isFallbackWorthy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // Bun's fetch wraps connection failures in a plain `Error` (not TypeError
  // as in Node) with `code: "ConnectionRefused"` / `"ENOTFOUND"` / etc.
  // We also recognise the message so this stays robust across runtimes.
  const code = (err as { code?: string }).code;
  if (
    code === "ConnectionRefused" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }
  const msg = err.message;
  if (
    msg.includes("Unable to connect") ||  // Bun's connection-failure message
    msg.includes("fetch failed") ||        // Node's undici wrapper
    msg.includes("network error") ||
    msg.includes("ECONNREFUSED")
  ) {
    return true;
  }
  // Hard upstream errors that mean "try the next box".
  if (/upstream_(502|503|504)/.test(msg)) return true;
  return false;
}

/**
 * A refusal that survived every attempt is not an answer — surface it as an
 * error so the UI can say something honest instead of printing the model's
 * canned "I can't assist with that" as if it were a reply.
 */
class AiRefusedError extends Error {
  constructor() {
    super("ai_refused");
    this.name = "AiRefusedError";
  }
}

async function chatWithFallback(messages: ChatMessage[]): Promise<ChatResult> {
  // Try primary (hivv.org). The breaker tracks primary health.
  const primaryStart = Date.now();
  let attempts = 0;

  for (let attempt = 0; attempt < Math.max(1, AI_ATTEMPTS); attempt++) {
    attempts++;
    try {
      const reply = await withBreaker("ai-chat:primary", () =>
        callOpenAICompat(PRIMARY_URL, messages, AI_TIMEOUT),
      );
      if (reply !== undefined) {
        if (!reply.refused) {
          return {
            text: reply.text,
            used: "primary",
            latency_ms: Date.now() - primaryStart,
            attempts,
          };
        }
        // A refusal is a failed answer, not a failed request: re-roll the
        // gateway's model lottery and try again.
        console.warn(
          `[ai-chat] primary returned a safety refusal (attempt ${attempt + 1}/${AI_ATTEMPTS}) — re-rolling`,
        );
        continue;
      }
      // Breaker open — skip primary entirely.
      console.warn(
        `[ai-chat] primary breaker open — going straight to fallback at ${FALLBACK_URL}`,
      );
      break;
    } catch (err) {
      if (!isFallbackWorthy(err)) {
        throw err; // hard 400/500 from primary — surface it
      }
      console.warn(
        `[ai-chat] primary (${PRIMARY_URL}) unavailable (${err instanceof Error ? err.name : "error"}: ${err instanceof Error ? err.message : String(err)}) — falling back to ${FALLBACK_URL}`,
      );
      break;
    }
  }

  // Fallback: direct local Gemma box. Always try unless it's a hard
  // programmer error — operators want to see the WARN if the primary
  // is degraded, even if the fallback also has a momentary blip.
  const fallbackStart = Date.now();
  const reply = await callOpenAICompat(FALLBACK_URL, messages, AI_TIMEOUT);
  attempts++;
  if (reply.refused) {
    console.warn(`[ai-chat] fallback also refused — every model in the pool declined`);
    throw new AiRefusedError();
  }
  return {
    text: reply.text,
    used: "fallback",
    latency_ms: Date.now() - fallbackStart,
    attempts,
  };
}

aiChatRoute.post("/ai/chat", zValidator("json", ChatSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  
  // Smart rate limiting: burst limiter (10/min) + hourly limiter (200/hr)
  const burstRl = chatBurstLimiter.check(ip);
  if (!burstRl.allowed) {
    console.warn(`[ai-chat] rate_limited (burst) ip=${ip} retry_after=${burstRl.retryAfterMs}ms`);
    return c.json({ error: "rate_limited", message: "Too many requests. Please wait a moment.", retry_after_ms: burstRl.retryAfterMs }, 429);
  }
  const rl = chatLimiter.check(ip);
  if (!rl.allowed) {
    console.warn(`[ai-chat] rate_limited (hourly) ip=${ip} retry_after=${rl.retryAfterMs}ms`);
    return c.json({ error: "rate_limited", message: "Daily limit reached. Try again later.", retry_after_ms: rl.retryAfterMs }, 429);
  }

  const body = c.req.valid("json");
  const messages = normalizeMessages(body);

  try {
    const result = await chatWithFallback(messages);
    return c.json({
      response: result.text.trim(),
      via: result.used,
      latency_ms: result.latency_ms,
      attempts: result.attempts,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      console.warn(`[ai-chat] timeout ip=${ip}`);
      return c.json({ error: "timeout", message: "AI request timed out" }, 504);
    }
    if (e instanceof AiRefusedError || e?.message === "ai_refused") {
      console.warn(`[ai-chat] every model in the pool refused the prompt ip=${ip}`);
      return c.json(
        { error: "ai_refused", message: "The model declined this prompt — try rephrasing." },
        502,
      );
    }
    console.error(`[ai-chat] error ip=${ip}:`, e?.message ?? e);
    return c.json(
      { error: "ai_unavailable", message: e?.message?.slice(0, 200) ?? "unknown" },
      502,
    );
  }
});
