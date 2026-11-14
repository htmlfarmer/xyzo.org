import { z } from "zod";

const CATEGORIES = [
  "politics", "business", "crime", "weather", "science",
  "technology", "sports", "culture", "environment",
  "conflict", "health", "other",
] as const;

const PRECISIONS = ["exact", "city", "region", "country"] as const;

const isoDate = z.string().refine((s) => !isNaN(new Date(s).getTime()), {
  message: "invalid ISO 8601 timestamp",
});

const httpUrl = z.string().url().refine(
  (s) => { try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } },
  { message: "must be http(s)" },
);

export const CategoryEnum = z.enum(CATEGORIES);
export const PrecisionEnum = z.enum(PRECISIONS);

// ── Community submission ───────────────────────────────────────────────
export const CommunitySubmissionSchema = z.object({
  title: z.string().min(1).max(200),
  // 2026-09-28: click-to-submit made attribution optional — anyone can
  // drop a story idea on the map anonymously. The route defaults the
  // display name to "Anonymous".
  submitter_name: z.string().max(100).optional(),
  submitter_email: z.string().email().max(254).optional(),
  story_note: z.string().max(2000).optional(),
  canonical_url: httpUrl.optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  published_at: isoDate.optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
  // FIX_NOTES 4.36: max(0) made any filled honeypot a zod 400 BEFORE the
  // handler's spam check could run — the spam_detected branch was
  // unreachable. Accept the value; the handler rejects it.
  hp_company: z.string().max(100).optional().default(""),
});
export type CommunitySubmission = z.infer<typeof CommunitySubmissionSchema>;

// ── Editorial ──────────────────────────────────────────────────────────
export const EditorialPinSchema = z.object({
  title: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  body_markdown: z.string().min(1).max(32_000),
  image_url: httpUrl.optional(),
  author_name: z.string().min(1).max(100),
  canonical_url: httpUrl.optional(),
  published_at: isoDate.optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
});
export type EditorialPin = z.infer<typeof EditorialPinSchema>;

// ── RSS ingest ─────────────────────────────────────────────────────────
export const RssIngestSchema = z.object({
  title: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  source_feed: httpUrl,
  source_url: httpUrl,
  original_published_at: isoDate.optional(),
  summary: z.string().max(2000).optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
});
export type RssIngest = z.infer<typeof RssIngestSchema>;

// ── Patch (hide/update) ────────────────────────────────────────────────
export const PatchPinSchema = z.object({
  status: z.enum(["published", "hidden"]).optional(),
  title: z.string().min(1).max(200).optional(),
  category: CategoryEnum.optional(),
  location_precision: PrecisionEnum.optional(),
  confidence_score: z.number().min(0).max(1).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: "no fields provided" });
export type PatchPin = z.infer<typeof PatchPinSchema>;

// ── List query params ──────────────────────────────────────────────────
export const GeocodeQuerySchema = z.object({
  q: z.string().min(2).max(500).transform((s) => s.replace(/[\x00-\x1f\x7f]/g, " ").trim()),
});
export type GeocodeQuery = z.infer<typeof GeocodeQuerySchema>;

export const EVENT_TYPES = [
  "politics", "business", "crime", "weather", "science", "technology",
  "sports", "culture", "environment", "conflict", "health", "disaster",
  "humanitarian", "other",
] as const;
export const EventTypeEnum = z.enum(EVENT_TYPES);

export const EventListQuerySchema = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  event_type: EventTypeEnum.optional(),
  since: isoDate.optional(),
  q: z.string().min(1).max(200).transform((s) => s.replace(/[%_\\]/g, (c) => "\\" + c).replace(/[\x00-\x1f\x7f]/g, " ").trim()).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  before: z.string().min(1).optional(),
});
export type EventListQuery = z.infer<typeof EventListQuerySchema>;

// Topic tag filter — matches against news_articles.topic_tags::text[].
// Names are dynamic (AI-extracted per article) — see /api/tags/top for the
// ranked list. Lowercased + trimmed so "Germany" and "germany" collapse.
const TagFilter = z.string().min(1).max(60).transform((s) => s.trim().toLowerCase()).optional();

// source_type filter — accepts a single value, a repeated-param array, or a
// comma-separated string ("rss,editorial"). The frontend layer toggles send
// the comma form because Hono's query parser flattens repeated keys.
const SourceTypeEnum = z.enum(["editorial", "community", "rss"]);
export const SourceTypeFilter = z.union([
  SourceTypeEnum,
  z.array(SourceTypeEnum),
  z.string()
    .transform((s) => s.split(",").map((t) => t.trim()).filter(Boolean))
    .pipe(z.array(SourceTypeEnum).min(1)),
]).optional();

export const ListPinsQuerySchema = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  source_type: SourceTypeFilter,
  since: isoDate.optional(),
  // The other end of the window — "the news of that day".
  until: isoDate.optional(),
  category: CategoryEnum.optional(),
  tag: TagFilter,
  min_confidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  before: z.string().min(1).optional(),
  q: z.string().min(2).max(200).transform((s) => s.replace(/[%_\\]/g, (c) => "\\" + c).replace(/[\x00-\x1f\x7f]/g, " ").trim()).optional(),
});

// Map view variant — same filters as ListPinsQuerySchema but with a
// higher limit cap (up to 2000). The map canvas wants every visible
// pin in a single response so it can render clusters without paginating.
export const MapPinsQuerySchema = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  source_type: SourceTypeFilter,
  since: isoDate.optional(),
  // The other end of the window — "the news of that day" (the archive's
  // time machine sets both ends).
  until: isoDate.optional(),
  category: CategoryEnum.optional(),
  tag: TagFilter,
  limit: z.coerce.number().int().min(1).max(2000).optional().default(1500),
  q: z.string().min(2).max(200).transform((s) => s.replace(/[%_\\]/g, (c) => "\\" + c).replace(/[\x00-\x1f\x7f]/g, " ").trim()).optional(),
  light: z.enum(["0", "1"]).transform((s) => s === "1").optional(),
});
export type ListPinsQuery = z.infer<typeof ListPinsQuerySchema>;

// ── Place search (re-fetch + filter) ───────────────────────────────────
export const PlaceSearchSchema = z.object({
  q: z.string().min(1).max(100).transform((s) => s.replace(/[\x00-\x1f\x7f]/g, " ").trim()),
  limit: z.coerce.number().int().min(1).max(60).optional().default(30),
});
export type PlaceSearch = z.infer<typeof PlaceSearchSchema>;

// ── City search ───────────────────────────────────────────────────────
export const CitiesSearchSchema = z.object({
  q: z.string().min(1).max(200).transform((s) => s.replace(/[\x00-\x1f\x7f]/g, " ").trim()),
  country: z.string().length(2).optional(),
  min_population: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(60).optional().default(30),
});
export type CitiesSearch = z.infer<typeof CitiesSearchSchema>;

// ── Suggest location (feedback) ───────────────────────────────────────
export const SuggestLocationSchema = z.object({
  place_text: z.string().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radius_km: z.number().min(1).max(1000).optional(),
  // Optional map view state captured at submit time. Lets /requests.html
  // re-open the map at the requester's exact center/zoom later. All
  // three are best-effort — missing/garbage values are silently coerced
  // to NULL by the route handler so existing callers keep working.
  map_center_lat: z.number().min(-90).max(90).optional(),
  map_center_lng: z.number().min(-180).max(180).optional(),
  map_zoom: z.number().min(0).max(22).optional(),
}).refine((o) => o.place_text || (o.lat != null && o.lng != null), {
  message: "place_text or lat+lng required",
});
export type SuggestLocation = z.infer<typeof SuggestLocationSchema>;

// ── Suggest coords (feedback) ─────────────────────────────────────────
export const SuggestCoordsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_km: z.number().min(1).max(1000).optional(),
  place_text: z.string().max(500).optional(),
  // Optional map view state captured at submit time. Lets /requests.html
  // re-open the map at the requester's exact center/zoom later. All
  // three are best-effort — missing/garbage values are silently coerced
  // to NULL by the route handler so existing callers keep working.
  map_center_lat: z.number().min(-90).max(90).optional(),
  map_center_lng: z.number().min(-180).max(180).optional(),
  map_zoom: z.number().min(0).max(22).optional(),
});
export type SuggestCoords = z.infer<typeof SuggestCoordsSchema>;

// ── POST /api/pins/:id/report ───────────────────────────────────────────
// The "Report Issue" tab of the combined feedback dialog
// (public_html/feedback-dialog.js). The report_type values are the
// dialog's own radio buttons; `reason` is its free-text box. The report
// is a moderation SIGNAL, not a verdict — nothing here edits or hides a
// pin. Rows land in news_quality_reports, the table the migration
// 2026-09-05-missing-tables-and-indexes.sql created for exactly this.
export const PinReportSchema = z.object({
  report_type: z.enum([
    "misleading",
    "false_info",
    "wrong_location",
    "spam",
    "outdated",
    "duplicate",
    "paywall",
    "other",
  ]),
  reason: z.string().max(500).optional(),
  session_id: z.string().max(100).optional(),
});
export type PinReport = z.infer<typeof PinReportSchema>;
