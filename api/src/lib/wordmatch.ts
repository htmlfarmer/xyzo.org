// ── Word-boundary matching for text searches ────────────────────────────
//
// ONE implementation, shared by the two search routes (GET /api/pins and
// POST /api/events/search). A second copy of a matcher is a second
// source of truth, and these two had already drifted: the EVENT search
// matched whole words (\m…\M) while the PIN search matched bare
// substrings (ILIKE '%…%'). So the same query could answer with two
// different sets of stories depending on which route answered it.
//
// WHY A SHORT TERM IS SPECIAL.
//
// As a bare substring, "ai" is inside "said", "rain", "air", "detail",
// "campaign" and "again". Measured on the corpus (2.99 M articles,
// 2026-11-09): **558,168** titles contain the two letters "ai"
// somewhere, and only **59,100** contain the WORD — the other 499,582
// are noise. A reader who searched "ai" got a map of the weather.
//
// LONGER TERMS KEEP THE SUBSTRING MATCH ON PURPOSE: "coronavirus" must
// still find "coronaviruses", which a word boundary would miss.
//
// THE COST OF THE BOUNDARY: the dotted spelling of an acronym ("A.I.")
// is 578 titles and is not matched by \m…\M — 1 % of the AI corpus.

/** Escape a user-supplied term for use inside a PostgreSQL regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * A pattern that matches the term as a WHOLE WORD.
 * PostgreSQL's \m is a word start and \M is a word end — the same rule
 * the event search has always used.
 */
export function wordBoundaryPattern(term: string): string {
  return "\\m" + escapeRegex(term) + "\\M";
}

/**
 * The longest a term can be and still be matched as a bare substring.
 *
 * Three characters is the line. "ai", "eu", "us", "uk", "oil", "ram" all
 * hide inside ordinary words; "bank", "climate" and "coronavirus" do
 * not, and their substring match is worth keeping.
 */
export const SHORT_TERM_MAX_LEN = 3;

/** True when the term is short enough to need a word boundary. */
export function isShortTerm(term: string): boolean {
  return term.length <= SHORT_TERM_MAX_LEN;
}
