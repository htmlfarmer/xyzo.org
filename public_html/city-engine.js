/**
 * Xyzo City Engine
 *
 * Lazily loads /data/cities.10k.json (3.9 MB) and builds an in-memory
 * index, then exposes a small API for fast text → cities, citiesNear,
 * and stats.
 *
 * Powers:
 *   - Pin detail "Cities" tab + inline highlighting
 *   - Submit-form sniff (suggest location before user clicks submit)
 *   - Source coverage map
 *   - Article pre-extraction (server uses the same algorithm via
 *     worker/cities_text.py)
 *
 * Detection rules (smart + flag):
 *   - SKIP_WORDS excluded: the, of, in, near, new (when standalone),
 *     months/days, common adjectives.
 *   - Multi-word names like "New York", "Buenos Aires" win over their
 *     single-word components (we try longest match first).
 *   - Population-weighted: ties broken by higher population.
 *   - Alias resolution: "Bombay" → Mumbai, "NYC" → New York City, etc.
 *     Aliases from /api/cities/search come from server; here we ship
 *     a small built-in alias map for the most common ones.
 *   - Low-confidence flag: matches with population < 200K are flagged
 *     so callers can choose to show "Dublin, Ireland (low confidence)".
 *
 * Self-contained, no build step. Loaded via <script src=...>.
 *
 * Performance: 3.9 MB JSON is NOT fetched on script init. Instead we
 * schedule the fetch during requestIdleCallback so it doesn't block
 * initial render, and the in-flight request piggybacks on browser
 * cache for subsequent calls. All public functions are still sync;
 * if the data isn't loaded yet they simply return empty results and
 * kick off a load() so the next call benefits.
 */

(function () {
  'use strict';

  // ── Built-in aliases ──────────────────────────────────────────────
  // Common abbreviations + historical names. The full city_aliases
  // table in xyzo_cities has hundreds; this is just the small
  // fast-path for the most common ones that appear in headlines.
  const ALIASES = {
    'new york':   'New York City',
    'nueva york': 'New York City',
    'nova york':  'New York City',
    'nova iorque': 'New York City',
    'nuova york': 'New York City',
    'neu-york':   'New York City',
    'neuyork':    'New York City',
    'нью-йорк':   'New York City',
    'нью йорк':   'New York City',
    'нью-йорка':  'New York City',
    'nyc':        'New York City',
    'la':         'Los Angeles',
    'sf':         'San Francisco',
    'dc':         'Washington',
    'philly':     'Philadelphia',
    'vegas':      'Las Vegas',
    'kc':         'Kansas City',
    'nola':       'New Orleans',
    'cape cod':   'Cape Cod',
    'p-town':     'Provincetown',
    'pvst':       'Provincetown',
    'the vineyard': "Martha's Vineyard",
    'mv':         "Martha's Vineyard",
    'ack':        'Nantucket',
    'nueva orleans': 'New Orleans',
    'nova orleans':  'New Orleans',
    'nuova orleans': 'New Orleans',
    'la nouvelle-orléans': 'New Orleans',
    'la nouvelle orléans': 'New Orleans',
    'nouvelle orléans':    'New Orleans',
    'nouvelle orleans':    'New Orleans',
    'новый орлеан':        'New Orleans',
    'новом орлеане':       'New Orleans',
    'nuevo mexico': 'Albuquerque',
    'nuevo méxico': 'Albuquerque',
    'novo mexico':  'Albuquerque',
    'novo méxico':  'Albuquerque',
    'nouveau-mexique': 'Albuquerque',
    'nouveau mexique': 'Albuquerque',
    'neu-mexiko':   'Albuquerque',
    'neu mexiko':   'Albuquerque',
    'нью-мексико':  'New Mexico',
    'нью мексико':  'New Mexico',
    'nueva jersey': 'Newark',
    'nova jersey':  'Newark',
    'нью-джерси':   'New Jersey',
    'нью джерси':   'New Jersey',
    'delhi':        'New Delhi',
    'nueva delhi':  'New Delhi',
    'nova deli':    'New Delhi',
    'nuova delhi':  'New Delhi',
    'neu-delhi':    'New Delhi',
    'neu delhi':    'New Delhi',
    'нью-дели':     'New Delhi',
    'нью дели':     'New Delhi',
    'cdmx':         'Mexico City',
    'ciudad de mexico': 'Mexico City',
    'ciudad de méxico': 'Mexico City',
    'cidade do mexico': 'Mexico City',
    'cidade do méxico': 'Mexico City',
    'città del messico': 'Mexico City',
    'bombay':     'Mumbai',
    'madras':     'Chennai',
    'calcutta':   'Kolkata',
    'bangalore':  'Bengaluru',
    'peking':     'Beijing',
    'saigon':     'Ho Chi Minh City',
    'hcmc':       'Ho Chi Minh City',
    'hk':         'Hong Kong',
    'rio':        'Rio de Janeiro',
    'ba':         'Buenos Aires',
    'joburg':     'Johannesburg',
    'vatican':    'Vatican City',
    'london':     'London',
    'paris':      'Paris',
    'rome':       'Rome',
    'roma':       'Rome',
    'istanbul':   'Istanbul',
    'constantinople': 'Istanbul',
    'moscow':     'Moscow',
    'moskva':     'Moscow',
    'st petersburg': 'Saint Petersburg',
    'st. petersburg': 'Saint Petersburg',
    'leningrad':  'Saint Petersburg',
    'beijing':    'Beijing',
    'tokyo':      'Tokyo',
    'mumbai':     'Mumbai',
    'shanghai':   'Shanghai',
    'hong kong':  'Hong Kong',
    'seoul':      'Seoul',
    'lagos':      'Lagos',
    'cairo':      'Cairo',
    'karachi':    'Karachi',
    'mexico city': 'Mexico City',
    'são paulo':  'São Paulo',
    'sao paulo':  'São Paulo',
    'bali':       'Denpasar',
    'tema, ghana': 'Tema',
    'tema, gh':   'Tema',
    'port of tema': 'Tema',
    'tema port':  'Tema',
    'tema motorway': 'Tema',
    'tema newtown': 'Tema',
  };

  // ── Skip words ─────────────────────────────────────────────────────
  const SKIP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no',
    'new', 'old', 'big', 'small', 'good', 'bad', 'first', 'last',
    'long', 'great', 'little', 'own', 'other', 'right', 'high',
    'different', 'large', 'next', 'early', 'young', 'important',
    'few', 'public', 'same', 'able', 'north', 'south', 'east', 'west',
    'report', 'news', 'story', 'article', 'today', 'yesterday', 'tomorrow',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    // Don't treat these as cities when they appear standalone
    'us', 'usa', 'uk', 'eu', 'un',
    'man', 'men', 'most', 'reading', 'mobile', 'deal', 'nice', 'bath',
    'best', 'normal', 'union', 'central', 'general', 'van', 'sur',
    'split', 'splits', 'sale', 'sales', 'independence', 'surprise',
    'university', 'college', 'enterprise', 'marathon', 'liberty',
    'concord', 'harmony', 'metro', 'overall', 'worth', 'vista', 'plano',
    'xinhua', 'sino', 'centro', 'san', 'los', 'las', 'dos', 'tres',
    'por', 'sin', 'mas', 'algo', 'nada', 'casa', 'como', 'viven',
    'vida', 'tierra', 'hijos', 'para', 'aba', 'toda', 'todo', 'todas',
    'todos', 'ise', 'lira', 'kisi', 'noma', 'koka', 'mura', 'mora',
    'tema', 'temas',
    'hub', 'hubs', 'center', 'centre', 'station', 'port', 'gate',
    'summit', 'peak', 'ridge', 'corner', 'crossing', 'junction',
    'mill', 'park', 'grove', 'hills', 'springs', 'landing',
    'rosetta', 'java', 'python',
  ]);

  // Multi-word city names that should win over their components.
  // Drawn from xyzo_cities; included here so the longest-match
  // pass doesn't accidentally pick "York" out of "New York".
  const MULTI_WORD_CITIES = [
    'new york', 'new york city', 'nueva york', 'nova york', 'nova iorque',
    'nuova york', 'neu-york', 'neuyork', 'нью-йорк', 'нью йорк', 'нью-йорка',
    'los angeles', 'san francisco', 'san diego', 'san jose', 'san antonio',
    'san salvador', 'santo domingo', 'sao paulo', 'são paulo', 'buenos aires',
    'rio de janeiro', 'mexico city', 'ciudad de mexico', 'ciudad de méxico',
    'cidade do mexico', 'cidade do méxico', 'città del messico',
    'kuala lumpur', 'hong kong', 'macau', 'macao',
    'new orleans', 'nueva orleans', 'nova orleans', 'nuova orleans',
    'la nouvelle-orléans', 'la nouvelle orléans', 'nouvelle orléans',
    'nouvelle orleans', 'новый орлеан', 'новом орлеане',
    'new delhi', 'nueva delhi', 'nova deli', 'nuova delhi', 'neu-delhi',
    'neu delhi', 'нью-дели', 'нью дели',
    'tema, ghana', 'tema, gh', 'port of tema', 'tema port', 'tema motorway', 'tema newtown',
    'nuevo mexico', 'nuevo méxico', 'novo mexico', 'novo méxico',
    'nouveau-mexique', 'nouveau mexique', 'neu-mexiko', 'neu mexiko',
    'nueva jersey', 'nova jersey', 'нью-джерси', 'нью джерси',
    'new south wales', 'st. louis', 'saint louis', 'st louis', 'st. paul',
    'saint paul', 'st petersburg', 'st. petersburg', 'saint petersburg',
    'las vegas', 'los altos', 'el paso', 'la paz',
    'cape town', 'dar es salaam', 'addis ababa',
    'abu dhabi', 'tel aviv', 'west bank', 'gaza strip',
    'ho chi minh city', 'ho chi minh', 'phnom penh', 'kampala',
  ];

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    loaded: false,
    loading: null,
    citiesByName: new Map(),       // lower(name) → [cities]
    citiesByAscii: new Map(),      // lower(ascii_name) → [cities]
    multiWordIndex: new Map(),     // lower(multi-word name) → city
    allCities: [],                 // [{n,a,cc,s,la,ln,p}]
    aliases: { ...ALIASES },
    manifest: { count: 0, generated: null },
  };

  // ── Index builder ─────────────────────────────────────────────────
  function buildIndex(cities) {
    state.allCities = cities;
    state.citiesByName = new Map();
    state.citiesByAscii = new Map();
    state.multiWordIndex = new Map();

    for (const c of cities) {
      const nm = (c.n || '').toLowerCase();
      const as = (c.a || '').toLowerCase();
      if (!nm) continue;

      if (!state.citiesByName.has(nm)) state.citiesByName.set(nm, []);
      state.citiesByName.get(nm).push(c);

      if (as && as !== nm) {
        if (!state.citiesByAscii.has(as)) state.citiesByAscii.set(as, []);
        state.citiesByAscii.get(as).push(c);
      }
    }

    // Multi-word cities: pick the highest-population variant for each
    // name string so the trie lookup is unambiguous.
    for (const c of cities) {
      const nm = (c.n || '').toLowerCase().trim();
      if (nm.includes(' ') || nm.includes('-')) {
        if (!state.multiWordIndex.has(nm)) {
          state.multiWordIndex.set(nm, c);
        } else {
          const existing = state.multiWordIndex.get(nm);
          if ((c.p || 0) > (existing.p || 0)) {
            state.multiWordIndex.set(nm, c);
          }
        }
      }
    }

    // Also index the static MULTI_WORD_CITIES list that may not be in
    // the data (e.g., "são paulo" with diacritics).
    for (const phrase of MULTI_WORD_CITIES) {
      if (!state.multiWordIndex.has(phrase)) {
        const c = state.citiesByName.get(phrase) || state.citiesByAscii.get(phrase);
        if (c && c.length > 0) {
          state.multiWordIndex.set(phrase, c[0]);
        }
      }
    }
  }

  // ── Loader ───────────────────────────────────────────────────────
  async function load() {
    if (state.loaded) return state;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      try {
        const resp = await fetch('/data/cities.10k.json');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        buildIndex(data);
        state.manifest = { count: data.length, generated: null };
        state.loaded = true;
        XLog.debug('[city-engine] indexed', data.length, 'cities');
      } catch (e) {
        XLog.warn('[city-engine] load failed:', e);
      }
      return state;
    })();

    return state.loading;
  }

  // Ensure load() is in flight; safe to call from any sync function.
  // If data is already loaded, returns immediately. If not, kicks off
  // the fetch and returns the promise (callers that need to await
  // should use `load()` directly; sync callers just observe empty
  // results the first time and full results on the next call).
  function ensureLoaded() {
    if (state.loaded) return Promise.resolve(state);
    return load();
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function bestCity(matches) {
    if (!matches || matches.length === 0) return null;
    return matches.slice().sort((a, b) => (b.p || 0) - (a.p || 0))[0];
  }

  function asciiFold(s) {
    if (!s) return '';
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  // ── Core: find cities in text ─────────────────────────────────────
  /**
   * @param {string} text
   * @param {object} opts
   *   minPopulation   minimum city population (default 100000)
   *   includeAliases  include alias hits (default true)
   *   maxResults      cap on returned matches (default 50)
   *   dedupe          dedupe overlapping ranges (default true)
   * @returns {Array<{city, start, end, length, confidence, kind}>}
   *   city: {name, ascii_name, country_code, state, lat, lng, population}
   *   confidence: 'high' | 'medium' | 'low'
   *   kind: 'name' | 'alias'
   */
  function findCitiesInText(text, opts = {}) {
    if (!state.loaded || !text || text.length < 3) return [];
    const {
      minPopulation = 100000,
      includeAliases = true,
      maxResults = 50,
      dedupe = true,
    } = opts;

    const lc = text.toLowerCase();
    const matches = [];

    // 1. Multi-word cities first (longest match wins).
    //    Sort by length descending so "New York City" beats "New York".
    const phrases = [...state.multiWordIndex.keys()]
      .filter((p) => p.length >= 3)
      .sort((a, b) => b.length - a.length);

    for (const phrase of phrases) {
      if ((state.multiWordIndex.get(phrase).p || 0) < minPopulation) continue;
      let from = 0;
      while (true) {
        const idx = lc.indexOf(phrase, from);
        if (idx === -1) break;
        // Word boundary check on both sides.
        const before = idx === 0 ? ' ' : text[idx - 1];
        const afterIdx = idx + phrase.length;
        const after = afterIdx >= text.length ? ' ' : text[afterIdx];
        const isWord = (ch) => /[a-z0-9_]/i.test(ch);
        if (!isWord(before) && !isWord(after)) {
          const city = state.multiWordIndex.get(phrase);
          matches.push({
            city, start: idx, end: idx + phrase.length,
            length: phrase.length,
            confidence: confidenceFor(city.p),
            kind: 'name',
          });
        }
        from = idx + 1;
      }
    }

    // 2. Single-word cities. Use word boundaries so "Lima" doesn't
    //    match "climate" or "limestone".
    const words = [];
    const re = /[A-Za-zÀ-ÿ\u00C0-\u017F]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const w = m[0];
      const lower = w.toLowerCase();
      const folded = asciiFold(w);
      if (w.length < 3) continue;
      if (SKIP_WORDS.has(lower) || SKIP_WORDS.has(folded)) continue;
      // Don't try to match if a multi-word match already covers this position.
      const covered = matches.some(
        (prev) => prev.start <= m.index && m.index < prev.end,
      );
      if (covered) continue;
      words.push({ word: w, lower, folded, index: m.index });
    }

    for (const { word, lower, folded, index } of words) {
      // Alias match FIRST
      if (includeAliases && state.aliases[lower]) {
        const target = state.aliases[lower];
        const aliasHits = state.citiesByName.get(target.toLowerCase())
                       || state.citiesByAscii.get(asciiFold(target));
        const aliasBest = bestCity(aliasHits);
        if (aliasBest && (aliasBest.p || 0) >= minPopulation) {
          matches.push({
            city: aliasBest, start: index, end: index + word.length,
            length: word.length,
            confidence: 'high',  // user clearly meant the alias target
            kind: 'alias',
          });
          continue;
        }
      }

      const hits = state.citiesByName.get(lower)
                || state.citiesByName.get(folded)
                || state.citiesByAscii.get(lower)
                || state.citiesByAscii.get(folded)
                || [];
      const best = bestCity(hits);
      if (best && (best.p || 0) >= minPopulation) {
        matches.push({
          city: best, start: index, end: index + word.length,
          length: word.length,
          confidence: confidenceFor(best.p),
          kind: 'name',
        });
        continue;
      }
    }

    // 3. Dedupe overlapping ranges.
    let final = matches;
    if (dedupe) {
      final = dedupeMatches(matches);
    }

    return final.slice(0, maxResults);
  }

  function dedupeMatches(matches) {
    if (matches.length === 0) return matches;
    matches.sort((a, b) => a.start - b.start || b.length - a.length);
    const out = [];
    let lastEnd = -1;
    for (const m of matches) {
      if (m.start >= lastEnd) {
        out.push(m);
        lastEnd = m.end;
      }
    }
    return out;
  }

  function confidenceFor(population) {
    if (population >= 1_000_000) return 'high';
    if (population >= 250_000) return 'medium';
    return 'low';
  }

  // ── Cities near a point (haversine, client-side) ──────────────────
  function citiesNear(lat, lng, radiusKm = 100, limit = 20) {
    if (!state.loaded || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const results = [];
    for (const c of state.allCities) {
      const d = haversine(lat, lng, c.la, c.ln);
      if (d <= radiusKm) results.push({ ...c, distance_km: d });
    }
    results.sort((a, b) => a.distance_km - b.distance_km);
    return results.slice(0, limit);
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
            * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function toRad(d) { return (d * Math.PI) / 180; }

  // ── Aggregate stats for an article ────────────────────────────────
  /**
   * Returns a quick summary of what the city engine found in the text.
   * Useful for: "Mentioned cities: Mumbai, Delhi, Pune (3 cities,
   * primary: Mumbai, national coverage)".
   */
  function cityStats(text, opts = {}) {
    const matches = findCitiesInText(text, opts);
    if (matches.length === 0) {
      return {
        count: 0, primary: null, cities: [],
        is_national: false, is_local: false,
        diversity: 0, flagged: false,
      };
    }
    const cities = matches.map((m) => m.city);
    const byCountry = {};
    for (const c of cities) {
      byCountry[c.cc] = (byCountry[c.cc] || 0) + 1;
    }
    const countriesCount = Object.keys(byCountry).length;
    const primary = cities.slice().sort((a, b) => (b.p || 0) - (a.p || 0))[0];
    const flagged = matches.some((m) => m.confidence === 'low');
    return {
      count: matches.length,
      primary: primary,
      primary_label: primary ? `${primary.n}, ${primary.cc}` : null,
      cities: cities,
      countries: Object.keys(byCountry),
      is_national: countriesCount > 1,
      is_local: countriesCount === 1 && matches.length <= 2,
      diversity: countriesCount,
      flagged,
      high_confidence: matches.filter((m) => m.confidence === 'high').length,
      medium_confidence: matches.filter((m) => m.confidence === 'medium').length,
      low_confidence: matches.filter((m) => m.confidence === 'low').length,
    };
  }

  // ── Highlight HTML for a body of text ─────────────────────────────
  /**
   * Wraps detected city mentions in <span class="city-mention"
   * data-city-id="...">city</span>. The page CSS + JS hooks add a
   * tooltip on hover and a click handler that filters the map.
   */
  function highlightHTML(text, opts = {}) {
    if (!text || !state.loaded) return escapeHtml(text || '');
    const matches = findCitiesInText(text, opts);
    if (matches.length === 0) return escapeHtml(text);

    let out = '';
    let cursor = 0;
    for (const m of matches) {
      out += escapeHtml(text.slice(cursor, m.start));
      const cls = `city-mention conf-${m.confidence} kind-${m.kind}`;
      const tip = `${m.city.n}, ${m.city.cc} · pop ${formatPop(m.city.p)}`;
      out += `<span class="${cls}" data-city-name="${escapeAttr(m.city.n)}"`
           + ` data-city-country="${escapeAttr(m.city.cc)}"`
           + ` data-city-lat="${m.city.la}" data-city-lng="${m.city.ln}"`
           + ` data-city-pop="${m.city.p || 0}" title="${escapeAttr(tip)}">`
           + escapeHtml(text.slice(m.start, m.end))
           + '</span>';
      cursor = m.end;
    }
    out += escapeHtml(text.slice(cursor));
    return out;
  }

  function formatPop(p) {
    if (!p) return '—';
    if (p >= 1_000_000) return (p / 1_000_000).toFixed(1) + 'M';
    if (p >= 1_000) return (p / 1_000).toFixed(0) + 'k';
    return String(p);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  // ── Server-side helpers (used by coverage map UI) ─────────────────
  /** Fetch the top cities covered by a single source. */
  async function sourceCoverage(sourceId, opts = {}) {
    const limit = opts.limit ?? 25;
    const url = `/api/sources/${sourceId}/coverage?limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Fetch all events/pins for a specific city within a date window. */
  async function eventsForCity(name, country, opts = {}) {
    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (country) params.set('country', country);
    if (opts.limit) params.set('limit', String(opts.limit));
    const resp = await fetch(`/api/cities/events?${params}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  // ── Categorize (client-side mirror of worker/auto_categorize.py) ──
  //
  // Pure-JS port of worker/classify.py patterns + worker/cities_text.py
  // city resolution. Lets the browser auto-classify an article as it's
  // rendered so the user sees "Detected: Mumbai, IN — Apply?" without a
  // round-trip to the API. Mirrors the Python fast-path exactly so the
  // client-side suggestion always matches what the worker would have
  // decided if the article had been queued.

  // Pattern lists ported from worker/classify.py. Order matters: more
  // specific patterns first so "earthquake" wins over "disaster".
  const CATEGORIZE_PATTERNS = [
    // Politics sub-types
    ['elections',      /\b(elections?|ballot|poll|primary|campaign|voter|voted)\b/i],
    ['courts',         /\b(supreme court|verdict|sentenced|convicted|acquitted|ruling|appeals court|judge|lawsuit|indicted)\b/i],
    ['diplomacy',      /\b(diplomat|embassy|ambassador|summit|treaty|foreign minister|sanctions imposed|bilateral)\b/i],
    ['protest',        /\b(protest|protests|protesters|rally|march|demonstration|demonstrators|riot|civil unrest|uprising)\b/i],
    ['policy',         /\b(legislation|bill passed|law signed|executive order|regulation|reform)\b/i],
    ['politics',       /\b(government|president|minister|congress|parliament|senator|mayor|governor|administration)\b/i],

    // Business sub-types
    ['crypto',         /\b(bitcoin|ethereum|crypto|blockchain|cryptocurrency|stablecoin|web3|defi|nft)\b/i],
    ['markets',        /\b(stock market|shares|trading|s&p 500|dow jones|nasdaq|ipo|market cap|share price|wall street|plunge|rallied|surged)\b/i],
    ['banking',        /\b(bank|banks|lender|loan|mortgage|interest rate|inflation|cpi|rate hike|rate cut|central bank|fed funds|deposit|fed chair|powell)\b/i],
    ['realestate',     /\b(housing market|home prices|real estate|rent|mortgage rate|property|housing crisis)\b/i],
    ['labor',          /\b(workers|union|labor|wage|strike|layoff|workforce)\b/i],
    ['business',       /\b(company|corp|inc\.|ltd|earnings|revenue|profit|ceo|merger|acquisition)\b/i],

    // Crime
    ['shooting',       /\b(shooting|shot dead|gunman|gunfire|mass shooting|opened fire)\b/i],
    ['terrorism',      /\b(terror|terrorist|extremist|bombing|suicide bomb|isis|al-shabaab)\b/i],
    ['cybercrime',     /\b(ransomware|data breach|hacked|hacker|cyberattack|phishing|malware|leaked data)\b/i],
    ['missing',        /\b(missing person|missing|disappeared|vanished)\b/i],
    ['traffic',        /\b(car crash|plane crash|train crash|collision|derailment|traffic accident|road accident)\b/i],
    ['crime',          /\b(police|arrested|charged|crime|criminal|suspect|investigation|robbery|theft)\b/i],

    // Weather
    ['wildfire',       /\b(wildfire|forest fire|bush fire|brush fire|fire spreading|evacuated due to fire)\b/i],
    ['floods',         /\b(flood|floods|flooding|flooded|deluge|flash flood|inundat)\b/i],
    ['storm',          /\b(hurricane|typhoon|cyclone|tornado|thunderstorm|storm surge|tropical storm)\b/i],
    ['snow',           /\b(blizzard|snowstorm|avalanche|heavy snow|winter storm|freezing)\b/i],
    ['heatwave',       /\b(heat wave|heatwave|heat dome|record heat|extreme heat)\b/i],
    ['drought',        /\b(drought|dry spell|water shortage|reservoir)\b/i],
    ['weather',        /\b(weather|forecast|temperature|rainfall|meteorolog|atmospheric river|monsoon|heavy rain|hailstorm)\b/i],

    // Disaster / conflict
    ['earthquake',     /\b(earthquake|magnitude|tremor|seismic|richter|quake)\b/i],
    ['volcano',        /\b(volcano|volcanic|eruption|lava|ash cloud|magma)\b/i],
    ['military',       /\b(military|armed forces|soldier|troops|army|navy|air force|missile|pentagon|drone strike|fighter jet)\b/i],
    ['war',            /\b(war|invasion|airstrike|shelling|combat|battlefield|front line|ceasefire|occupied)\b/i],
    ['disaster',       /\b(disaster|catastrophe|emergency response|rescue operation)\b/i],

    // Technology sub-types
    ['ai',             /\b(ai|artificial intelligence|machine learning|llm|large language model|chatgpt|gpt-|neural network|deep learning|generative ai|openai|anthropic|deepmind|robot|humanoid|robotic)\b/i],
    ['cybersecurity',  /\b(cybersecurity|security flaw|vulnerability|cve-|zero-day|patch released|infosec)\b/i],
    ['gaming',         /\b(video game|gaming|playstation|xbox|nintendo|esports|gta|zelda)\b/i],
    ['telecom',        /\b(5g|broadband|telecom|mobile network|spectrum|fiber optic|carrier|verizon|at&t|t-mobile)\b/i],
    ['technology',     /\b(tech|software|app|startup|platform|google|apple|microsoft|meta|amazon)\b/i],

    // Science
    ['space',          /\b(nasa|spacex|rocket launch|satellite|space station|astronaut|mars|moon landing|space mission|orbit)\b/i],
    ['biology',        /\b(ecosystem|genome|dna|rna|crispr|evolution|vaccine)\b/i],
    ['physics',        /\b(physics|particle|quantum|atom|relativity|physicist)\b/i],
    ['research',       /\b(study finds|researchers|study published|peer-reviewed|scientists say|university study|research shows)\b/i],
    ['science',        /\b(science|scientific|discovery|laboratory)\b/i],

    // Sports
    ['soccer',         /\b(soccer|football|fifa|uefa|premier league|la liga|champions league|world cup)\b/i],
    ['basketball',     /\b(basketball|nba|lebron|lakers|warriors|celtics|wnba)\b/i],
    ['olympics',       /\b(olympics|olympic|paralympic|medal|torch relay)\b/i],
    ['racing',         /\b(formula 1|f1|nascar|indycar|grand prix|racing|motorsport)\b/i],
    ['sports',         /\b(tournament|championship|match|game|playoff|athlete|coach|team wins)\b/i],

    // Culture
    ['music',          /\b(album|song|tour|concert|grammy|spotify|music video|single|band|singer|rapper)\b/i],
    ['film',           /\b(movie|film|cinema|box office|director|actor|actress|oscar|premiere|sequel|trailer)\b/i],
    ['art',            /\b(exhibition|gallery|museum|painting|sculpture|artist|art fair|auction)\b/i],
    ['books',          /\b(novel|book|author|bestseller|publisher|literary|poetry|memoir)\b/i],
    ['culture',        /\b(cultural|tradition|heritage|festival|ceremony|pageant|beauty queen|fashion week|red carpet|celebrity)\b/i],

    // Environment
    ['climate',        /\b(climate change|global warming|carbon emission|greenhouse gas|paris agreement|cop|ipcc|carbon footprint|net zero)\b/i],
    ['wildlife',       /\b(endangered species|wildlife|biodiversity|poaching|habitat|extinction|migratory)\b/i],
    ['pollution',      /\b(pollution|contamination|spill|toxic|air quality|pm2\.5|microplastic)\b/i],
    ['energy',         /\b(solar|wind farm|renewable|fossil fuel|oil rig|pipeline|offshore wind|nuclear plant|coal)\b/i],
    ['environment',    /\b(environment|deforestation|ocean|coral reef|glacier)\b/i],

    // Health
    ['outbreak',       /\b(outbreak|epidemic|pandemic|infection|virus spread|case count|quarantine|covid|ebola|measles|mpox|monkeypox)\b/i],
    ['mental_health',  /\b(mental health|depression|anxiety|suicide|therapy|psychiatr|burnout)\b/i],
    ['medical',        /\b(hospital|patient|treatment|clinical trial|drug approval|fda|surgery|doctor|diagnosis|medication)\b/i],
    ['health',         /\b(health|disease|illness|symptom|vaccine|public health|who)\b/i],

    // Humanitarian
    ['refugees',       /\b(refugee|asylum|displaced|migrant|humanitarian crisis|evacuees)\b/i],
    ['aid',            /\b(humanitarian aid|relief|food aid|red cross)\b/i],
    ['humanitarian',   /\b(humanitarian|unhcr|wfp|aid worker|relief effort)\b/i],
  ];

  function categorizeText(title, body) {
    const text = ((title || '') + '  ' + (body || '')).slice(0, 3000);
    for (const [cat, re] of CATEGORIZE_PATTERNS) {
      if (re.test(text)) return cat;
    }
    return 'other';
  }

  /**
   * Suggest a city + category for an article, mirroring what
   * worker/auto_categorize.py would have decided. Useful when the
   * detail panel opens and the article hasn't been AI-processed yet.
   *
   * @param {string} title
   * @param {string} body
   * @returns {{
   *   city: object|null,         // {name, ascii_name, country_code, lat, lng, population} or null
   *   city_label: string|null,   // "Mumbai, IN" or null
   *   city_confidence: 'high'|'medium'|'low'|null,
   *   category: string,          // event_type from classify patterns
   *   can_apply: boolean,        // true if city+category are both present
   *   reason: string,
   * }}
   */
  function categorize(title, body) {
    const text = ((title || '') + '\n' + (body || '').slice(0, 1500)).trim();
    const stats = cityStats(text, { minPopulation: 100000 });
    const category = categorizeText(title, body);
    const primary = stats && stats.primary;
    const pop = primary ? (primary.p || 0) : 0;
    let cityConfidence = null;
    if (pop >= 1_000_000) cityConfidence = 'high';
    else if (pop >= 250_000) cityConfidence = 'medium';
    else if (pop > 0) cityConfidence = 'low';

    let reason;
    if (!primary && category === 'other') reason = 'No city, no category keywords';
    else if (!primary) reason = 'Category detected, no city';
    else if (category === 'other') reason = 'City detected, no category';
    else reason = `City + category match (${cityConfidence})`;

    const canApply = !!(primary && primary.la != null && primary.ln != null);

    return {
      city: primary,
      city_label: primary ? `${primary.n}, ${primary.cc}` : null,
      city_confidence: cityConfidence,
      category: category,
      category_confidence: category === 'other' ? null : 'medium',
      can_apply: canApply,
      reason: reason,
    };
  }

  // ── Simple city lookup (for search bar / command bar) ─────────────
  /**
   * Find cities matching a query string. Unlike findCitiesInText (which
   * scans prose), this does direct name + alias lookup — what the search
   * bar needs when the user types "nyc" or "chicago".
   *
   * @param {string} query  city name or abbreviation
   * @param {number} maxResults  cap (default 5)
   * @returns {Array<{name, ascii_name, country_code, state, lat, lng, population}>}
   */
  function findCities(query, maxResults = 5) {
    if (!state.loaded || !query || query.length < 2) return [];
    const q = query.toLowerCase().trim();
    const results = [];
    const seen = new Set();

    // 1. Alias match (nyc → New York City, bombay → Mumbai, etc.)
    const aliasTarget = state.aliases[q];
    if (aliasTarget) {
      const aliasCities = state.citiesByName.get(aliasTarget.toLowerCase());
      if (aliasCities) {
        for (const c of aliasCities) {
          if (!seen.has(c.n)) { results.push(c); seen.add(c.n); }
        }
      }
    }

    // 2. Exact name match
    const exact = state.citiesByName.get(q);
    if (exact) {
      for (const c of exact) {
        if (!seen.has(c.n)) { results.push(c); seen.add(c.n); }
      }
    }

    // 3. ASCII name match (handles diacritics: "sao paulo" → "São Paulo")
    const ascii = state.citiesByAscii.get(q);
    if (ascii) {
      for (const c of ascii) {
        if (!seen.has(c.n)) { results.push(c); seen.add(c.n); }
      }
    }

    // 4. Prefix match (starts with word boundary)
    if (results.length < maxResults) {
      for (const [name, cities] of state.citiesByName) {
        if (!seen.has(cities[0].n)) {
          const lowerName = name.toLowerCase();
          const lowerQ = q.toLowerCase();
          if (lowerName.startsWith(lowerQ) && (lowerName === lowerQ || lowerName.startsWith(lowerQ + ' ') || lowerName.startsWith(lowerQ + '('))) {
            results.push(cities[0]);
            seen.add(cities[0].n);
            if (results.length >= maxResults * 3) break;
          }
        }
      }
    }

    // 5. Substring match (word boundary - preceded by space or at start)
    if (results.length < maxResults) {
      for (const [name, cities] of state.citiesByName) {
        if (!seen.has(cities[0].n)) {
          const lowerName = name.toLowerCase();
          const lowerQ = q.toLowerCase();
          const idx = lowerName.indexOf(lowerQ);
          if (idx >= 0 && (idx === 0 || lowerName[idx - 1] === ' ')) {
            results.push(cities[0]);
            seen.add(cities[0].n);
            if (results.length >= maxResults * 3) break;
          }
        }
      }
    }

    // Sort by population descending, return top N
    return results
      .sort((a, b) => (b.p || 0) - (a.p || 0))
      .slice(0, maxResults)
      .map(c => ({
        name: c.n,
        ascii_name: c.a,
        country_code: c.cc,
        state: c.s,
        lat: c.la,
        lng: c.ln,
        population: c.p || 0,
      }));
  }

  // ── Public API ────────────────────────────────────────────────────
  // ── US state abbreviations ──────────────────────────────────────────
  //
  // People type two letters constantly ("TX", "CA", "NY") and nothing
  // resolved them. Both lookups are actively WRONG here, which is why
  // neither can be leaned on:
  //
  //   /api/locations/search?q=CA  -> "Careca", "Can", "Car"  (prefix-
  //                                   matched word beginnings)
  //   /api/geocode?q=CA           -> CANADA, not California
  //   /api/geocode?q=WA           -> WESTERN AUSTRALIA, not Washington
  //
  // Nominatim gets the unambiguous ones right (TX -> Texas) but has no
  // way to know a US news reader means California by "CA", so the
  // abbreviation is resolved HERE from an explicit table — offline,
  // instant, and with the state's own extent to frame it.
  //
  // bbox is [south, north, west, east] (Nominatim's order, so the
  // fitBounds path reads it directly). Alaska stops short of the
  // Aleutians rather than crossing the antimeridian: a box spanning 349
  // degrees of longitude would fitBounds straight back to the world.
  //
  // Lives in this module — the gazetteer — rather than app.js, because
  // app.js is under an explicit runaway-size ceiling (850 KB) whose own
  // comment says to extract rather than raise.
  const US_STATES = {
    AL: ["Alabama", 32.81, -86.79, [30.22, 35.00, -88.47, -84.89]],
    AK: ["Alaska", 61.37, -152.40, [54.09, 71.40, -168.00, -141.00]],
    AZ: ["Arizona", 33.73, -111.43, [31.33, 37.00, -114.82, -109.04]],
    AR: ["Arkansas", 34.97, -92.37, [33.00, 36.50, -94.62, -90.04]],
    CA: ["California", 36.12, -119.68, [32.53, 42.01, -124.48, -114.13]],
    CO: ["Colorado", 39.12, -105.31, [36.99, 41.00, -109.06, -102.04]],
    CT: ["Connecticut", 41.60, -72.76, [40.98, 42.05, -73.73, -71.79]],
    DE: ["Delaware", 39.32, -75.51, [38.45, 39.84, -75.80, -74.98]],
    DC: ["District of Columbia", 38.90, -77.03, [38.79, 39.00, -77.12, -76.91]],
    FL: ["Florida", 27.77, -81.69, [24.52, 31.00, -87.63, -80.03]],
    GA: ["Georgia", 33.04, -83.64, [30.36, 35.00, -85.61, -80.84]],
    HI: ["Hawaii", 21.09, -157.50, [18.91, 22.24, -160.25, -154.81]],
    ID: ["Idaho", 44.24, -114.48, [41.99, 49.00, -117.24, -111.04]],
    IL: ["Illinois", 40.35, -88.99, [36.97, 42.51, -91.51, -87.02]],
    IN: ["Indiana", 39.85, -86.26, [37.77, 41.76, -88.10, -84.78]],
    IA: ["Iowa", 42.01, -93.21, [40.38, 43.50, -96.64, -90.14]],
    KS: ["Kansas", 38.53, -96.73, [36.99, 40.01, -102.05, -94.59]],
    KY: ["Kentucky", 37.67, -84.67, [36.50, 39.15, -89.57, -81.96]],
    LA: ["Louisiana", 31.17, -91.87, [28.93, 33.02, -94.04, -88.76]],
    ME: ["Maine", 44.69, -69.38, [42.98, 47.46, -71.08, -66.95]],
    MD: ["Maryland", 39.06, -76.80, [37.91, 39.72, -79.49, -75.05]],
    MA: ["Massachusetts", 42.23, -71.53, [41.24, 42.89, -73.51, -69.93]],
    MI: ["Michigan", 43.33, -84.54, [41.69, 48.31, -90.42, -82.12]],
    MN: ["Minnesota", 45.69, -93.90, [43.50, 49.39, -97.24, -89.49]],
    MS: ["Mississippi", 32.74, -89.68, [30.17, 35.00, -91.66, -88.10]],
    MO: ["Missouri", 38.46, -92.29, [35.99, 40.61, -95.77, -89.10]],
    MT: ["Montana", 46.92, -110.45, [44.36, 49.00, -116.05, -104.04]],
    NE: ["Nebraska", 41.13, -98.27, [39.99, 43.00, -104.06, -95.31]],
    NV: ["Nevada", 38.31, -117.06, [35.00, 42.00, -120.01, -114.04]],
    NH: ["New Hampshire", 43.45, -71.56, [42.69, 45.31, -72.56, -70.61]],
    NJ: ["New Jersey", 40.30, -74.52, [38.93, 41.36, -75.56, -73.89]],
    NM: ["New Mexico", 34.84, -106.25, [31.33, 37.00, -109.05, -103.00]],
    NY: ["New York", 42.17, -74.95, [40.50, 45.02, -79.76, -71.86]],
    NC: ["North Carolina", 35.63, -79.81, [33.84, 36.59, -84.32, -75.46]],
    ND: ["North Dakota", 47.53, -99.78, [45.94, 49.00, -104.05, -96.55]],
    OH: ["Ohio", 40.39, -82.76, [38.40, 41.98, -84.82, -80.52]],
    OK: ["Oklahoma", 35.57, -96.93, [33.62, 37.00, -103.00, -94.43]],
    OR: ["Oregon", 44.57, -122.07, [41.99, 46.30, -124.70, -116.46]],
    PA: ["Pennsylvania", 40.59, -77.21, [39.72, 42.33, -80.52, -74.69]],
    RI: ["Rhode Island", 41.68, -71.51, [41.15, 42.02, -71.91, -71.12]],
    SC: ["South Carolina", 33.86, -80.95, [32.04, 35.22, -83.35, -78.54]],
    SD: ["South Dakota", 44.30, -99.44, [42.49, 45.95, -104.06, -96.44]],
    TN: ["Tennessee", 35.75, -86.69, [34.96, 36.69, -90.31, -81.65]],
    TX: ["Texas", 31.05, -97.56, [25.84, 36.50, -106.65, -93.51]],
    UT: ["Utah", 40.15, -111.86, [36.99, 42.00, -114.05, -109.04]],
    VT: ["Vermont", 44.05, -72.71, [42.73, 45.02, -73.44, -71.50]],
    VA: ["Virginia", 37.77, -78.17, [36.54, 39.47, -83.68, -75.24]],
    WA: ["Washington", 47.40, -121.49, [45.54, 49.00, -124.79, -116.92]],
    WV: ["West Virginia", 38.49, -80.95, [37.20, 40.64, -82.64, -77.72]],
    WI: ["Wisconsin", 44.27, -89.62, [42.49, 47.09, -92.89, -86.76]],
    WY: ["Wyoming", 42.76, -107.30, [40.99, 45.01, -111.06, -104.05]],
  };

  // A bare two-letter query that is a state abbreviation. EXACT and
  // case-insensitive: "tx"/"TX" are states, "tax" and "texas" are not
  // abbreviations and must fall through to the normal search. The high
  // population keeps the caller's cityZoom() at its widest setting — a
  // state wants the broadest view the branch offers.
  function findState(query) {
    if (!query || query.length !== 2) return null;
    const key = query.trim().toUpperCase();
    const s = US_STATES[key];
    if (!s) return null;
    return {
      name: s[0], state: key, country_code: "US", lat: s[1], lng: s[2],
      population: 30_000_000,
      _bbox: s[3],      // [south, north, west, east]
      _isState: true,
    };
  }

  // ── A query that NAMES a bigger place is never a city ────────────────
  //
  // MEASURED 2026-11-11. detectCitySearch() prefix-matches, so a query
  // that names a COUNTRY was won by whichever city's name starts with
  // those letters:
  //
  //     "china"   -> Chinandega, Nicaragua        (pop 126k)
  //     "india"   -> Indianapolis, Indiana        (pop 887k)
  //     "peru"    -> Perugia, Italy               (pop 161k)
  //     "florida" -> Florida, CUBA                (pop 63k)
  //     "maine"   -> Maine Township, Illinois     (pop 140k)
  //     "korea"   -> Koreatown, California        (pop 124k)
  //     "virginia"-> Virginia, SOUTH AFRICA       (pop 122k)
  //
  // The reader searched a country and the map flew to a city on another
  // continent; the status line then read "No news found near Chinandega,
  // Chinandega Department, NI". NO STRUCTURAL RULE CAN TELL THESE APART:
  // "china" -> Chinandega and "chica" -> Chicago are both mid-word
  // prefixes of a city name, and prefix matching must keep working while
  // the reader types ("new" -> New York City, "kansas c" -> Kansas
  // City). The difference is that one of them NAMES A COUNTRY — so the
  // gazetteer carries the list, which is the same argument the US state
  // table above makes for two-letter abbreviations: reference data is
  // answered offline from here, not guessed at from a string.
  //
  // The rule: a query that is exactly a country or a US state name is
  // NEVER answered by the city path. It falls through to the geocoder
  // (frameSearchRegion's country clause frames it by its extent) and to
  // /api/pins?q=, which returns the STORIES of that place.
  //
  // The names are the ISO 3166 English names plus the forms people
  // actually type ("usa", "ivory coast", "burma", "holland"). The 51 US
  // state NAMES come from US_STATES above — one table, not two.
  //
  // normPlace folds the accents and the punctuation, because a reader
  // types "cote d ivoire", "st lucia" and "timor-leste", not the forms
  // the table stores. The generated list was normalised with the SAME
  // function, so the two sides cannot drift apart.
  const normPlace = (s) => String(s || "").toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'\u2019]/g, " ").replace(/-/g, " ")
    .replace(/\s+/g, " ").trim();

  const BIG_PLACE_NAMES = new Set([
    "abkhazia", "afghanistan", "aland islands", "albania", "algeria", "america", "american samoa",
    "andorra", "angola", "anguilla", "antarctica", "antigua", "antigua and barbuda",
    "arab republic of egypt", "argentina", "argentine republic", "armenia", "aruba", "australia",
    "austria", "azerbaijan", "bahamas", "bahrain", "bangladesh", "barbados", "belarus", "belgium",
    "belize", "benin", "bermuda", "bhutan", "bolivarian republic of venezuela", "bolivia",
    "bolivia, plurinational state of", "bonaire", "bonaire, sint eustatius and saba", "bosnia",
    "bosnia and herzegovina", "botswana", "bouvet island", "brazil", "britain",
    "british indian ocean territory", "british virgin islands", "brunei darussalam", "bulgaria",
    "burkina faso", "burma", "burundi", "cabo verde", "cambodia", "cameroon", "canada",
    "cape verde", "cayman islands", "central african republic", "chad", "chile", "china",
    "christmas island", "cocos (keeling) islands", "colombia", "commonwealth of dominica",
    "commonwealth of the bahamas", "commonwealth of the northern mariana islands", "comoros",
    "congo", "congo brazzaville", "congo kinshasa", "congo, the democratic republic of the",
    "cook islands", "costa rica", "cote d ivoire", "croatia", "cuba", "curacao", "cyprus",
    "czech republic", "czechia", "democratic people s republic of korea",
    "democratic republic of sao tome and principe", "democratic republic of the congo",
    "democratic republic of timor leste", "democratic socialist republic of sri lanka", "denmark",
    "djibouti", "dominica", "dominican republic", "dprk", "dr congo", "drc", "east timor",
    "eastern republic of uruguay", "ecuador", "egypt", "el salvador", "england",
    "equatorial guinea", "eritrea", "estonia", "eswatini", "ethiopia",
    "falkland islands (malvinas)", "faroe islands", "federal democratic republic of ethiopia",
    "federal democratic republic of nepal", "federal republic of germany",
    "federal republic of nigeria", "federal republic of somalia",
    "federated states of micronesia", "federative republic of brazil", "fiji", "finland",
    "france", "french guiana", "french polynesia", "french republic",
    "french southern territories", "gabon", "gabonese republic", "gambia", "georgia", "germany",
    "ghana", "gibraltar", "grand duchy of luxembourg", "great britain", "greece", "greenland",
    "grenada", "guadeloupe", "guam", "guatemala", "guernsey", "guinea", "guinea bissau", "guyana",
    "haiti", "hashemite kingdom of jordan", "heard island and mcdonald islands",
    "hellenic republic", "herzegovina", "holland", "holy see (vatican city state)", "honduras",
    "hong kong", "hong kong special administrative region of china", "hungary", "iceland",
    "independent state of papua new guinea", "independent state of samoa", "india", "indonesia",
    "iran", "iran, islamic republic of", "iraq", "ireland", "islamic republic of afghanistan",
    "islamic republic of iran", "islamic republic of mauritania", "islamic republic of pakistan",
    "isle of man", "israel", "italian republic", "italy", "ivory coast", "jamaica", "japan",
    "jersey", "jordan", "kazakhstan", "kenya", "kingdom of bahrain", "kingdom of belgium",
    "kingdom of bhutan", "kingdom of cambodia", "kingdom of denmark", "kingdom of eswatini",
    "kingdom of lesotho", "kingdom of morocco", "kingdom of norway", "kingdom of saudi arabia",
    "kingdom of spain", "kingdom of sweden", "kingdom of thailand", "kingdom of the netherlands",
    "kingdom of tonga", "kiribati", "korea", "korea, democratic people s republic of",
    "korea, republic of", "kosovo", "kuwait", "kyrgyz republic", "kyrgyzstan",
    "lao people s democratic republic", "laos", "latvia", "lebanese republic", "lebanon",
    "lesotho", "liberia", "libya", "liechtenstein", "lithuania", "luxembourg", "macao",
    "macao special administrative region of china", "macau", "macedonia", "madagascar", "malawi",
    "malaysia", "maldives", "mali", "malta", "marshall islands", "martinique", "mauritania",
    "mauritius", "mayotte", "mexico", "micronesia, federated states of", "moldova",
    "moldova, republic of", "monaco", "mongolia", "montenegro", "montserrat", "morocco",
    "mozambique", "myanmar", "namibia", "nauru", "nepal", "netherlands", "new caledonia",
    "new zealand", "nicaragua", "niger", "nigeria", "niue", "norfolk island", "north korea",
    "north macedonia", "northern ireland", "northern mariana islands", "norway", "oman",
    "pakistan", "palau", "palestine", "palestine, state of", "panama", "papua new guinea",
    "paraguay", "people s democratic republic of algeria", "people s republic of bangladesh",
    "people s republic of china", "peru", "philippines", "pitcairn",
    "plurinational state of bolivia", "poland", "portugal", "portuguese republic",
    "principality of andorra", "principality of liechtenstein", "principality of monaco",
    "puerto rico", "qatar", "republic of albania", "republic of angola", "republic of armenia",
    "republic of austria", "republic of azerbaijan", "republic of belarus", "republic of benin",
    "republic of bosnia and herzegovina", "republic of botswana", "republic of bulgaria",
    "republic of burundi", "republic of cabo verde", "republic of cameroon", "republic of chad",
    "republic of chile", "republic of colombia", "republic of costa rica",
    "republic of cote d ivoire", "republic of croatia", "republic of cuba", "republic of cyprus",
    "republic of djibouti", "republic of ecuador", "republic of el salvador",
    "republic of equatorial guinea", "republic of estonia", "republic of fiji",
    "republic of finland", "republic of ghana", "republic of guatemala", "republic of guinea",
    "republic of guinea bissau", "republic of guyana", "republic of haiti",
    "republic of honduras", "republic of iceland", "republic of india", "republic of indonesia",
    "republic of iraq", "republic of kazakhstan", "republic of kenya", "republic of kiribati",
    "republic of korea", "republic of latvia", "republic of liberia", "republic of lithuania",
    "republic of madagascar", "republic of malawi", "republic of maldives", "republic of mali",
    "republic of malta", "republic of mauritius", "republic of moldova", "republic of mozambique",
    "republic of myanmar", "republic of namibia", "republic of nauru", "republic of nicaragua",
    "republic of north macedonia", "republic of palau", "republic of panama",
    "republic of paraguay", "republic of peru", "republic of poland", "republic of san marino",
    "republic of senegal", "republic of serbia", "republic of seychelles",
    "republic of sierra leone", "republic of singapore", "republic of slovenia",
    "republic of south africa", "republic of south sudan", "republic of suriname",
    "republic of tajikistan", "republic of the congo", "republic of the gambia",
    "republic of the marshall islands", "republic of the niger", "republic of the philippines",
    "republic of the sudan", "republic of trinidad and tobago", "republic of tunisia",
    "republic of turkiye", "republic of uganda", "republic of uzbekistan", "republic of vanuatu",
    "republic of yemen", "republic of zambia", "republic of zimbabwe", "reunion", "romania",
    "russia", "russian federation", "rwanda", "rwandese republic", "saint barthelemy",
    "saint helena", "saint helena, ascension and tristan da cunha", "saint kitts",
    "saint kitts and nevis", "saint lucia", "saint martin (french part)",
    "saint pierre and miquelon", "saint vincent", "saint vincent and the grenadines", "samoa",
    "san marino", "sao tome and principe", "saudi arabia", "scotland", "senegal", "serbia",
    "seychelles", "sierra leone", "singapore", "sint maarten (dutch part)", "slovak republic",
    "slovakia", "slovenia", "socialist republic of viet nam", "solomon islands", "somalia",
    "south africa", "south georgia and the south sandwich islands", "south korea",
    "south ossetia", "south sudan", "spain", "sri lanka", "srilanka", "st helena", "st kitts",
    "st lucia", "st vincent", "state of israel", "state of kuwait", "state of palestine",
    "state of qatar", "sudan", "sultanate of oman", "suriname", "svalbard and jan mayen",
    "swaziland", "sweden", "swiss confederation", "switzerland", "syria", "syrian arab republic",
    "taiwan", "taiwan, province of china", "tajikistan", "tanzania",
    "tanzania, united republic of", "thailand", "the netherlands", "the state of eritrea",
    "the state of palestine", "timor leste", "togo", "togolese republic", "tokelau", "tonga",
    "transnistria", "trinidad and tobago", "tunisia", "turkey", "turkiye", "turkmenistan",
    "turks and caicos islands", "tuvalu", "u k", "u s a", "uae", "uganda", "uk", "ukraine",
    "union of the comoros", "united arab emirates", "united kingdom",
    "united kingdom of great britain and northern ireland", "united mexican states",
    "united republic of tanzania", "united states", "united states minor outlying islands",
    "united states of america", "uruguay", "us", "usa", "uzbekistan", "vanuatu", "venezuela",
    "venezuela, bolivarian republic of", "viet nam", "vietnam", "virgin islands",
    "virgin islands of the united states", "virgin islands, british", "virgin islands, u s",
    "wales", "wallis and futuna", "western sahara", "yemen", "zambia", "zimbabwe",
  ]);
  for (const st of Object.values(US_STATES)) BIG_PLACE_NAMES.add(normPlace(st[0]));

  function isBiggerPlace(query) {
    const q = normPlace(query);
    return !!q && BIG_PLACE_NAMES.has(q);
  }

  // ── place lookup ────────────────────────────────────────────────────────
  // Moved out of app.js, which is under an explicit 850 KB runaway
  // ceiling whose comment says to extract rather than raise. These are
  // the same kind of thing as the state table above: "where is this
  // place?" geography, answered from what this module already holds.
  // detectCitySearch reads better in app.js's call sites, so it keeps
  // its name here as CityEngine.detectCity().
  function detectCitySearch(query) {
    if (!query || query.length < 2) return null;
    if (!state.loaded) return null;
    const q = query.trim().toLowerCase();
    // A query that NAMES a country or a state is never a city — see
    // BIG_PLACE_NAMES. "china" must not become Chinandega and "india"
    // must not become Indianapolis: the geocoder and /api/pins?q= are
    // the oracles that answer for a country.
    if (isBiggerPlace(q)) return null;
      const cities = findCities(q, 3);
    if (!cities || cities.length === 0) return null;
    const best = cities[0];
    if (!best || !best.population || best.population < 50000) return null;
    const cityNameLower = (best.name || "").toLowerCase();
    const asciiLower = (best.ascii_name || cityNameLower).toLowerCase();
    // Exact match: "rio" === "rio" or "rio" === "rio de janeiro" (alias case)
    if (q === cityNameLower || q === asciiLower) return best;
    if (state && state.aliases) {
      const aliasTarget = state.aliases[q];
      if (aliasTarget && aliasTarget.toLowerCase() === cityNameLower) return best;
    }
    // Prefix match: "rio" is prefix of "rio de janeiro"
    // This enables city search when user types just the city name without state/country
    //
    // NOT BELOW THREE CHARACTERS. A two-letter prefix matches almost
    // anything — "uk" is a prefix of "Ukyō Ward, Kyoto", so searching "uk"
    // (a country code) flew to a ward in Japan. Short queries are exactly
    // where people are trying abbreviations, so two letters must mean an
    // EXACT hit (a real city name, or a state via detectStateSearch) and
    // nothing looser. "rio" and "spring" still prefix-match; "uk" no longer
    // does.
    if (q.length >= 3 && (cityNameLower.startsWith(q) || asciiLower.startsWith(q))) return best;
    return null;
  }
  function cityToBbox(city, radiusKm) {
    // A state brings its own extent — fitting a 70 km circle around the
    // centroid of Texas would show a slice of Texas, not Texas.
    //
    // ORDER MATTERS AND THE TWO SIDES DISAGREE: a state stores Nominatim's
    // [south, north, west, east] (so the fitBounds path can use it
    // directly), but bbox= takes [minLng, minLat, maxLng, maxLat] — which
    // is what the fallback below returns and what /api/pins/map parses.
    // Returning the state's tuple unwritten read its latitude as a
    // longitude, produced an inverted box (W > E, S > N) and came back as
    // "No news found near Texas, TX, US" while the map framed Texas
    // perfectly.
    if (city && Array.isArray(city._bbox) && city._bbox.length === 4) {
      const [s, n, w, e] = city._bbox;
      return [w, s, e, n];
    }
    const lat = Math.max(-85, Math.min(85, city.lat));
    const lng = city.lng;
    const dLat = radiusKm / 111.32;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dLng = cosLat > 0.01 ? radiusKm / (111.32 * cosLat) : 180;
    return [
      Math.max(-180, lng - dLng),
      Math.max(-85, lat - dLat),
      Math.min(180, lng + dLng),
      Math.min(85, lat + dLat),
    ];
  }
  function citySearchRadius(city) {
    const pop = city.population || 0;
    if (pop >= 5_000_000) return 70;
    if (pop >= 1_000_000) return 55;
    if (pop >= 300_000) return 40;
    return 30;
  }

  window.CityEngine = {
    load,
    ensureLoaded,
    findCities,
    findState,
    isBiggerPlace,
    detectCity: detectCitySearch,
    cityToBbox,
    cityRadius: citySearchRadius,
    findCitiesInText,
    citiesNear,
    cityStats,
    highlightHTML,
    sourceCoverage,
    eventsForCity,
    categorize,
    categorizeText,
    // For tests / advanced use
    _state: () => state,
    isLoaded: () => state.loaded,
    manifest: () => state.manifest,
  };

  // Lazy-load: defer the JSON fetch to browser idle time so it doesn't
  // block the initial render. App code that needs data can call
  // `CityEngine.ensureLoaded()` to start the fetch earlier.
  //
  // THE TIMEOUT IS LONG, AND THAT IS THE POINT. `requestIdleCallback`
  // fires the callback even when the browser is BUSY once the timeout
  // expires — and during a map boot it is always busy. The timeout used
  // to be 2.5 s, so the biggest single download on the page (the city
  // index, 1.16 MB) started while app.js and the map's tiles were still
  // arriving and stole their bandwidth. Measured 2026-11-12: the markers
  // cannot start until app.js has arrived, and the city index was
  // downloading in parallel the whole time.
  //
  // The index is now ALSO warmed when the reader touches the search box
  // (app.js), which is the moment it actually matters.
  //
  // AND THERE IS NO BOOT-TIME FETCH AT ALL. `requestIdleCallback` fires
  // as soon as the browser has ANY idle time — which, during a map boot,
  // is the moment it is WAITING for app.js to arrive. So the "idle" warm
  // was not idle at all: measured 2026-11-12, the 1.16 MB city index was
  // requested at t=0.43 s, in parallel with app.js, and it competed with
  // the map's tiles for the whole boot. The index is fetched when it is
  // needed instead — when the reader touches the search box (app.js) and
  // when the first pins are painted (app.js).
  // (the scheduleIdle helper above is kept for callers that want an idle
  // hook; the BOOT no longer schedules the city fetch through it)
})();
