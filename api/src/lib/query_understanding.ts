/**
 * query_understanding.ts — Lightweight query parser (Phase 2)
 *
 * Extracts structured signals from raw search queries without calling Gemma.
 * This runs on EVERY search request, so it must be fast (< 1ms).
 *
 * Signals extracted:
 *   - entities:    company / person / product names
 *   - domain:     science, AI, finance, politics, sports, etc.
 *   - intent:     news, explain, track, compare, discover
 *   - time_signal: latest, recent, ongoing, historical, year
 *   - location:   country/city if explicitly mentioned
 *
 * Fallback: for complex/ambiguous queries, call Gemma-4 with a tiny prompt
 *           and cache the result in search_embeddings_cache.
 */

export interface QueryUnderstanding {
  original: string;
  normalized: string;
  entities:    string[];
  domain:     string | null;
  intent:     string | null;
  time_signal: string | null;
  explicit_location: string | null;
  is_entity_query: boolean;   // user is searching for a specific entity
  is_location_query: boolean; // user is searching for a place
  is_topic_query: boolean;    // user is searching for a topic/theme
  complexity_score: number;   // 0-10, how complex the query is
  should_use_semantic: boolean; // semantic search likely helpful
  should_expand: boolean;      // query expansion likely helpful
  expansion_terms: string[];  // suggested expansion terms
}

// ── Domain keywords ─────────────────────────────────────────────────────────
const DOMAIN_KEYWORDS: [string, string][] = [
  ['science',     ['science', 'research', 'study', 'scientist', 'laboratory', 'experiment', 'physics', 'biology', 'chemistry']],
  ['ai',          ['ai', 'artificial intelligence', 'machine learning', 'deep learning', 'llm', 'gpt', 'neural', 'chatbot', 'automation', 'generative', 'foundation model']],
  ['space',       ['space', 'astronomy', 'nasa', 'jwst', 'james webb', 'rocket', 'satellite', 'mars', 'moon', 'asteroid', 'galaxy', 'telescope', 'stars', 'black hole', 'universe', 'exoplanet']],
  ['climate',     ['climate', 'warming', 'greenhouse', 'carbon', 'emissions', 'temperature', 'arctic', 'ice cap', 'sea level', 'flood', 'drought', 'wildfire', 'wildfires']],
  ['health',      ['health', 'disease', 'outbreak', 'virus', 'pandemic', 'vaccine', 'cancer', 'treatment', 'drug', 'therapy', 'medical', 'hospital', 'patient', 'doctor', 'fda', 'who']],
  ['politics',    ['election', 'vote', 'parliament', 'congress', 'senate', 'president', 'prime minister', 'government', 'policy', 'law', 'vote', 'campaign', 'diplomacy', 'treaty', 'sanctions', 'un security council']],
  ['economy',     ['economy', 'gdp', 'inflation', 'recession', 'market', 'stock', 'bond', 'interest rate', 'federal reserve', 'ecb', 'trade war', 'tariff', 'export', 'import', 'supply chain', 'oil price', 'commodity']],
  ['technology',  ['tech', 'startup', 'software', 'app', 'cyber', 'hack', 'data breach', 'privacy', 'semiconductor', 'chip', '5g', '6g', 'quantum', 'robot', 'drone']],
  ['sports',      ['football', 'soccer', 'basketball', 'tennis', 'cricket', 'olympics', 'marathon', 'championship', 'league', 'player', 'coach', 'score', 'match', 'tournament']],
  ['culture',     ['film', 'movie', 'music', 'art', 'museum', 'theater', 'concert', 'festival', 'book', 'author', 'award', 'oscar', 'grammy', 'exhibition']],
  ['energy',      ['energy', 'solar', 'wind', 'nuclear', 'fusion', 'oil', 'gas', 'renewable', 'electric vehicle', 'ev', 'battery', 'lng', 'opec']],
  ['conflict',    ['war', 'military', 'army', 'troops', 'conflict', 'ceasefire', 'invasion', 'defense', 'security', 'terrorism', 'militant', 'gunfire', 'bombing', 'drone strike', 'ukraine', 'israel', 'gaza', 'taiwan', 'south china sea']],
  ['crime',       ['crime', 'murder', 'shooting', 'arrest', 'police', 'fraud', 'corruption', 'scam', 'kidnapping', 'theft', 'smuggling', ' cartel']],
];

// ── Intent patterns ─────────────────────────────────────────────────────────
const INTENT_PATTERNS: [string, RegExp[]] = [
  ['news',        [/\b(news|latest|recent|breaking|update|today|this week|this month)\b/i]],
  ['explain',     [/\b(why|how|what is|what are|explain|understand|learn|explain|meaning|reason)\b/i]],
  ['track',       [/\b(track|monitor|follow|ongoing|latest on|update on|status)\b/i]],
  ['compare',     [/\b(compare|vs|versus|difference|comparison|better|worse|advantage|disadvantage)\b/i]],
  ['discover',    [/\b(discover|find|search|looking for|any|about|information)\b/i]],
  ['invest',      [/\b(invest|stock|price|share|fund|etf|bond|portfolio|return|buy|sell)\b/i]],
];

// ── Time signals ────────────────────────────────────────────────────────────
const TIME_PATTERNS: [string, RegExp[]] = [
  ['latest',      [/\b(latest|recent|new|just|now|right now|current|breaking)\b/i]],
  ['this week',   [/\b(this week|past week|last week|over week|week)\b/i]],
  ['this month',  [/\b(this month|this month|past month|last month|month)\b/i]],
  ['this year',   [/\b(this year|this year|past year|last year|year so far|ytd)\b/i]],
  ['historical',  [/\b(history|historical|past|ancient|old|legacy|archive|decade)\b/i]],
  ['ongoing',     [/\b(ongoing|continuing|still|still happening|developing)\b/i]],
];

// ── Company/entity suffixes ────────────────────────────────────────────────
const COMPANY_SUFFIXES = /\b(inc\.?|corp\.?|ltd\.?|llc|plc|co\.?|holdings?|group|se|ag|nv|ab|oy|sa\.?|s\.a\.?|gmbh|corp|incorporated|enterprises?|technologies?|systems?|solutions?|semiconductors?)\b/i;
export const KNOWN_COMPANIES: Map<string, { domain: string; location?: string }> = new Map([
  ['nxp semiconductors', { domain: 'technology', location: 'Eindhoven, NL' }],
  ['asml', { domain: 'technology', location: 'Veldhoven, NL' }],
  ['tsmc', { domain: 'technology', location: 'Hsinchu, TW' }],
  ['samsung', { domain: 'technology', location: 'Seoul, KR' }],
  ['intel', { domain: 'technology', location: 'Santa Clara, US' }],
  ['nvidia', { domain: 'ai', location: 'Santa Clara, US' }],
  ['openai', { domain: 'ai', location: 'San Francisco, US' }],
  ['google', { domain: 'ai', location: 'Mountain View, US' }],
  ['deepmind', { domain: 'ai', location: 'London, UK' }],
  ['anthropic', { domain: 'ai', location: 'San Francisco, US' }],
  ['spacex', { domain: 'space', location: 'Hawthorne, US' }],
  ['blue origin', { domain: 'space', location: 'Kent, US' }],
  ['esa', { domain: 'space', location: 'Paris, FR' }],
  ['jpl', { domain: 'space', location: 'Pasadena, US' }],
  ['noaa', { domain: 'climate', location: 'Washington, US' }],
  ['who', { domain: 'health', location: 'Geneva, CH' }],
  ['fda', { domain: 'health', location: 'Silver Spring, US' }],
]);

/**
 * Main entry point: understand a search query.
 * Sub-1ms for typical queries, <5ms for complex ones.
 */
export function understandQuery(raw: string): QueryUnderstanding {
  const original = raw.trim();
  const normalized = normalizeQuery(original);

  // Extract signals
  const entities    = extractEntities(original);
  const domain      = detectDomain(original, entities);
  const intent      = detectIntent(original);
  const time_signal = detectTimeSignal(original);
  const explicit_location = extractLocation(original);

  const is_entity_query    = entities.length > 0;
  const is_location_query  = !!explicit_location || isKnownLocation(original);
  const is_topic_query     = !is_entity_query && !is_location_query;
  const complexity_score   = calcComplexity(original, entities);
  const should_use_semantic = complexity_score >= 6 || is_entity_query;
  const should_expand       = is_topic_query || (domain !== null && complexity_score >= 4);
  const expansion_terms     = buildExpansionTerms(original, domain, entities);

  return {
    original,
    normalized,
    entities,
    domain,
    intent,
    time_signal,
    explicit_location,
    is_entity_query,
    is_location_query,
    is_topic_query,
    complexity_score,
    should_use_semantic,
    should_expand,
    expansion_terms,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeQuery(q: string): string {
  return q.toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""⁋""]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEntities(q: string): string[] {
  const entities: string[] = [];
  const lower = q.toLowerCase();

  // Known company matches
  for (const [name, info] of KNOWN_COMPANIES) {
    if (lower.includes(name)) {
      entities.push(name);
    }
  }

  // Company suffixes
  const suffixMatches = q.match(COMPANY_SUFFIXES);
  if (suffixMatches) {
    for (const m of suffixMatches) {
      const clean = m.replace(COMPANY_SUFFIXES, '').trim();
      if (clean.length > 2 && !entities.includes(clean)) {
        entities.push(clean);
      }
    }
  }

  // Capitalized multi-word phrases (likely proper nouns)
  const capitalPhrase = q.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
  if (capitalPhrase) {
    for (const phrase of capitalPhrase) {
      if (!entities.some(e => e.toLowerCase() === phrase.toLowerCase())) {
        entities.push(phrase);
      }
    }
  }

  return entities;
}

function detectDomain(q: string, entities: string[]): string | null {
  const lower = q.toLowerCase();

  // Check entities for domain signal
  for (const entity of entities) {
    const info = KNOWN_COMPANIES.get(entity.toLowerCase());
    if (info?.domain) return info.domain;
  }

  // Keyword matching
  let bestDomain: string | null = null;
  let bestScore = 0;
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore >= 1 ? bestDomain : null;
}

function detectIntent(q: string): string | null {
  const lower = q.toLowerCase();
  let bestIntent: string | null = null;
  let bestScore = 0;
  for (const [intent, patterns] of INTENT_PATTERNS) {
    for (const pat of patterns) {
      if (pat.test(lower)) {
        bestIntent = intent;
        bestScore++;
      }
    }
  }
  return bestIntent;
}

function detectTimeSignal(q: string): string | null {
  const lower = q.toLowerCase();
  for (const [signal, patterns] of TIME_PATTERNS) {
    for (const pat of patterns) {
      if (pat.test(lower)) return signal;
    }
  }
  // Year detection: "2025", "2024"
  const yearMatch = q.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) return `year_${yearMatch[0]}`;
  return null;
}

function extractLocation(q: string): string | null {
  // Look for country/city names followed by common patterns
  // Simple heuristic: "in X", "of X", "near X"
  const locationPatterns = [
    /in\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    /of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    /near\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  ];
  for (const pat of locationPatterns) {
    const m = q.match(pat);
    if (m) return m[1];
  }
  return null;
}

function isKnownLocation(q: string): boolean {
  const cities = ['tokyo', 'paris', 'london', 'new york', 'beijing', 'delhi', 'mumbai', 'singapore', 'dubai', 'sydney', 'toronto', 'berlin', 'moscow', 'rio', 'cairo', 'johannesburg', 'mexico city', 'bangkok', 'seoul', 'hong kong', 'amsterdam', 'eindhoven', 'veldhoven', 'houston', 'austin', 'san francisco'];
  const lower = q.toLowerCase();
  return cities.some(c => lower.includes(c));
}

function calcComplexity(q: string, entities: string[]): number {
  let score = 0;
  // Longer queries tend to be more specific
  if (q.split(/\s+/).length >= 4) score += 2;
  if (q.split(/\s+/).length >= 6) score += 2;
  // Entities add specificity
  score += entities.length * 2;
  // Multi-word proper nouns
  if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(q)) score += 2;
  // Technical terms
  if (/ai|ml|llm|gpt|quantum|nuclear|fusion|crispr|gene/i.test(q)) score += 1;
  return Math.min(score, 10);
}

function buildExpansionTerms(q: string, domain: string | null, entities: string[]): string[] {
  const terms: string[] = [];
  const lower = q.toLowerCase();

  if (domain === 'ai') {
    terms.push('artificial intelligence', 'machine learning', 'neural network', 'deep learning');
  } else if (domain === 'space') {
    terms.push('astronomy', 'space mission', 'satellite', 'rocket launch');
  } else if (domain === 'science') {
    terms.push('research', 'study', 'scientific discovery', 'laboratory');
  } else if (domain === 'technology') {
    terms.push('tech', 'innovation', 'startup', 'semiconductor', 'chip');
  } else if (domain === 'health') {
    terms.push('medical', 'treatment', 'drug development', 'clinical trial');
  } else if (domain === 'climate') {
    terms.push('climate change', 'global warming', 'environment', 'emissions');
  }

  // Remove terms already in query
  return terms.filter(t => !lower.includes(t)).slice(0, 5);
}
