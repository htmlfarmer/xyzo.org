/**
 * Xyzo Command Bar — enhances the existing search bar with AI commands.
 *
 * Instead of a separate overlay, this upgrades #search-bar to support:
 * - Normal city/news search (existing behavior)
 * - Commands: type "explore", "study", "fly to Kampala", or ask questions
 * - Contextual suggestions appear below the search bar
 * - ⌘K focuses the search bar from anywhere
 */
(function () {
  'use strict';

  let searchInput, searchBar, dropdown;

  // ── Intent patterns ───────────────────────────────────────────────
  const INTENT_PATTERNS = [
    { intent: 'study', patterns: [/^\/?stud(y|ying)/i, /\/?analy[sz]e/i, /what.s here/i, /\/overview/i] },
    { intent: 'explore', patterns: [/^\/?explor(e|ing)/i, /\/?find sources/i, /\/?discover/i, /\/?scan/i] },
    { intent: 'request', patterns: [/^\/?request/i, /\/?more (news|coverage)/i, /why.*(empty|no news|no coverage)/i] },
    { intent: 'fly', patterns: [/^\/?(go to|fly to|show me|take me to)\s+/i] },
    { intent: 'chat', patterns: [/^\/(ask|chat|help)\s+/i, /^(what|why|how|who|when|where)\s+/i] },
  ];

  function detectIntent(query) {
    const q = query.trim();
    if (!q) return null;
    for (const { intent, patterns } of INTENT_PATTERNS) {
      for (const p of patterns) {
        if (p.test(q)) return intent;
      }
    }
    return null;
  }

  // ── Map context ───────────────────────────────────────────────────
  function getMapContext() {
    if (typeof map === 'undefined' || !map) return {};
    const bounds = map.getBounds();
    const center = map.getCenter();
    return {
      bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
      zoom: Math.round(map.getZoom()),
      center_lat: center.lat,
      center_lng: center.lng,
      pin_count: typeof pinMarkers !== 'undefined' ? pinMarkers.size : 0,
    };
  }

  // ── Topic taxonomy map for instant topic search in search bar ─────
  const TOPIC_SUGGESTIONS_MAP = [
    { key: 'ai', label: 'Artificial Intelligence & AI', icon: '🤖', category: 'technology', keywords: ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'deep learning', 'neural', 'openai', 'anthropic', 'claude'] },
    { key: 'cybersecurity', label: 'Cybersecurity & Hacks', icon: '🛡️', category: 'technology', keywords: ['cyber', 'security', 'hack', 'hacker', 'malware', 'ransomware', 'breach', 'vulnerability', 'infosec'] },
    { key: 'robotics', label: 'Robotics & Automation', icon: '🦾', category: 'technology', keywords: ['robot', 'robotics', 'automation', 'drone', 'humanoid', 'bipedal', 'bostondynamics'] },
    { key: 'semiconductors', label: 'Semiconductors & Chips', icon: '⚡', category: 'technology', keywords: ['chip', 'semiconductor', 'nvidia', 'intel', 'tsmc', 'amd', 'microchip', 'wafer', 'hardware'] },
    { key: 'conferences', label: 'Conferences & Keynotes', icon: '🎤', category: 'technology', keywords: ['conference', 'ces', 'keynote', 'summit', 'expo', 'mwc', 'devcon', 'symposium', 'forum'] },
    { key: 'technology', label: 'Technology & IT', icon: '💻', category: 'technology', keywords: ['tech', 'technology', 'software', 'app', 'computing', 'cloud', 'gadget', 'open source'] },
    { key: 'gaming', label: 'Gaming & Esports', icon: '🎮', category: 'technology', keywords: ['gaming', 'game', 'esports', 'steam', 'playstation', 'xbox', 'nintendo'] },
    { key: 'telecom', label: 'Telecom & 5G', icon: '📡', category: 'technology', keywords: ['telecom', '5g', 'network', 'satellite', 'broadband', 'starlink'] },
    { key: 'markets', label: 'Stock Markets & Finance', icon: '📊', category: 'business', keywords: ['market', 'stock', 'markets', 'wall street', 'trading', 'shares', 'equity', 'nasdaq', 's&p', 'dow', 'investing'] },
    { key: 'crypto', label: 'Crypto & Web3', icon: '🪙', category: 'business', keywords: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'blockchain', 'solana', 'token', 'web3', 'defi'] },
    { key: 'banking', label: 'Banking & Central Banks', icon: '🏦', category: 'business', keywords: ['bank', 'banking', 'finance', 'fintech', 'fed', 'interest rate', 'central bank', 'loan', 'credit'] },
    { key: 'realestate', label: 'Real Estate & Housing', icon: '🏢', category: 'business', keywords: ['real estate', 'housing', 'mortgage', 'property', 'rent', 'construction'] },
    { key: 'labor', label: 'Labor & Strikes', icon: '👔', category: 'business', keywords: ['labor', 'work', 'job', 'jobs', 'strike', 'union', 'layoff', 'employment', 'hiring', 'workforce'] },
    { key: 'business', label: 'Business & Economy', icon: '💼', category: 'business', keywords: ['business', 'company', 'startup', 'vc', 'economy', 'ceo', 'earnings', 'revenue'] },
    { key: 'elections', label: 'Elections & Voting', icon: '🗳️', category: 'politics', keywords: ['election', 'elections', 'vote', 'voting', 'ballot', 'campaign', 'poll', 'president', 'senate', 'parliament'] },
    { key: 'policy', label: 'Policy & Government', icon: '📜', category: 'politics', keywords: ['policy', 'law', 'bill', 'congress', 'government', 'regulation', 'sanction', 'reform', 'legislation'] },
    { key: 'courts', label: 'Courts & Judiciary', icon: '⚖️', category: 'politics', keywords: ['court', 'judge', 'supreme court', 'trial', 'verdict', 'lawsuit', 'justice', 'prosecutor'] },
    { key: 'diplomacy', label: 'Diplomacy & Foreign Policy', icon: '🌐', category: 'politics', keywords: ['diplomacy', 'foreign policy', 'ambassador', 'treaty', 'un', 'geopolitics', 'white house'] },
    { key: 'protest', label: 'Protests & Activism', icon: '🪧', category: 'politics', keywords: ['protest', 'demonstration', 'rally', 'activist', 'march'] },
    { key: 'politics', label: 'Politics', icon: '🏛️', category: 'politics', keywords: ['politics', 'political', 'government', 'leader', 'minister', 'state'] },
    { key: 'space', label: 'Space & Astronomy', icon: '🚀', category: 'science', keywords: ['space', 'nasa', 'rocket', 'astronomy', 'mars', 'moon', 'orbit', 'satellite', 'telescope', 'spacex', 'jwst'] },
    { key: 'physics', label: 'Physics & Quantum', icon: '⚛️', category: 'science', keywords: ['physics', 'quantum', 'fusion', 'particle', 'cern', 'laser', 'atom', 'superconductor'] },
    { key: 'biology', label: 'Biology & Genetics', icon: '🧬', category: 'science', keywords: ['biology', 'dna', 'genetics', 'crispr', 'gene', 'evolution', 'organism'] },
    { key: 'research', label: 'Academic & Science News', icon: '🔬', category: 'science', keywords: ['academic', 'research', 'paper', 'journal', 'study', 'discovery', 'university', 'nature', 'science', 'sciencedaily'] },
    { key: 'climate', label: 'Climate Change', icon: '🌍', category: 'environment', keywords: ['climate', 'global warming', 'emissions', 'carbon', 'cop', 'glacier', 'temperature'] },
    { key: 'energy', label: 'Energy & Renewables', icon: '⚡', category: 'environment', keywords: ['energy', 'solar', 'wind', 'nuclear', 'renewable', 'oil', 'gas', 'power grid', 'battery'] },
    { key: 'wildlife', label: 'Wildlife & Biodiversity', icon: '🐾', category: 'environment', keywords: ['wildlife', 'animal', 'species', 'extinction', 'biodiversity', 'forest', 'ocean', 'marine'] },
    { key: 'pollution', label: 'Pollution & Waste', icon: '♻️', category: 'environment', keywords: ['pollution', 'plastic', 'recycle', 'waste', 'smog', 'air quality'] },
    { key: 'storm', label: 'Storms & Extreme Weather', icon: '🌀', category: 'weather', keywords: ['storm', 'hurricane', 'typhoon', 'tornado', 'cyclone', 'gale', 'blizzard'] },
    { key: 'floods', label: 'Floods & Heavy Rain', icon: '🌊', category: 'weather', keywords: ['flood', 'flooding', 'heavy rain', 'deluge', 'inundation'] },
    { key: 'wildfire', label: 'Wildfires & Forest Fires', icon: '🔥', category: 'weather', keywords: ['wildfire', 'bushfire', 'forest fire', 'blaze'] },
    { key: 'earthquake', label: 'Earthquakes & Seismic', icon: '🌋', category: 'disaster', keywords: ['earthquake', 'seismic', 'tremor', 'quake', 'tsunami', 'volcano'] },
    { key: 'war', label: 'War & Defense', icon: '⚔️', category: 'conflict', keywords: ['war', 'military', 'conflict', 'army', 'missile', 'strike', 'defense', 'weapon', 'invasion', 'ceasefire'] },
    { key: 'refugees', label: 'Refugees & Migration', icon: '⛺', category: 'humanitarian', keywords: ['refugee', 'migration', 'asylum', 'displacement', 'migrant'] },
    { key: 'aid', label: 'Humanitarian Aid', icon: '🤝', category: 'humanitarian', keywords: ['aid', 'relief', 'humanitarian', 'red cross', 'shelter'] },
    { key: 'outbreak', label: 'Outbreaks & Pandemics', icon: '🦠', category: 'health', keywords: ['outbreak', 'virus', 'epidemic', 'pandemic', 'infection', 'disease', 'flu', 'covid'] },
    { key: 'medical', label: 'Medical & Healthcare', icon: '🏥', category: 'health', keywords: ['medical', 'health', 'hospital', 'doctor', 'treatment', 'cancer', 'pharma', 'vaccine'] },
    { key: 'shooting', label: 'Crime & Incidents', icon: '🚨', category: 'crime', keywords: ['shooting', 'crime', 'police', 'investigation', 'arrest'] },
    { key: 'cybercrime', label: 'Cybercrime & Fraud', icon: '💻', category: 'crime', keywords: ['cybercrime', 'scam', 'fraud', 'phishing'] },
    { key: 'sports', label: 'Sports & Leagues', icon: '⚽', category: 'sports', keywords: ['sports', 'soccer', 'football', 'basketball', 'nba', 'olympics', 'racing', 'f1', 'tennis'] },
    { key: 'culture', label: 'Culture & Entertainment', icon: '🎭', category: 'culture', keywords: ['culture', 'music', 'film', 'movie', 'art', 'book', 'festival'] },
  ];

  // Search topic suggestions matching query
  function findTopicSuggestions(query) {
    const q = query.toLowerCase().trim();
    if (!q || q.length < 2) return [];
    const matches = [];
    for (const t of TOPIC_SUGGESTIONS_MAP) {
      if (t.key.toLowerCase() === q || t.label.toLowerCase().includes(q)) {
        matches.push(t);
        continue;
      }
      for (const kw of t.keywords) {
        if (kw.toLowerCase().startsWith(q) || (q.length >= 3 && kw.toLowerCase().includes(q))) {
          matches.push(t);
          break;
        }
      }
    }
    return matches;
  }

  // ── Build suggestions ─────────────────────────────────────────────
  function buildSuggestions(query) {
    const suggestions = [];
    const q = query.trim();
    if (!q) return suggestions;

    // 1. Topic search suggestions (fast instant topic filter)
    const topicMatches = findTopicSuggestions(q);
    for (const t of topicMatches.slice(0, 3)) {
      suggestions.push({
        type: 'topic_filter',
        label: `${t.icon} Topic: ${t.label}`,
        sublabel: `Filter map to ${t.category} / ${t.key} stories`,
        topic_key: t.key,
        topic_label: t.label,
        category: t.category,
      });
    }

    // Check if query contains a recognized city or country
    const placeName = detectPlaceInQuery(q);

    // City suggestions from CityEngine
    if (q.length >= 2 && window.CityEngine) {
      try {
        const cities = CityEngine.findCities(q, 3);
        for (const c of cities) {
          suggestions.push({
            type: 'fly',
            label: `📍 ${c.name}, ${c.country}`,
            sublabel: `pop ${(c.population / 1e6).toFixed(1)}M`,
            data: c,
          });
        }
      } catch (e) { /* CityEngine not ready */ }
    }

    // If a place name was detected (e.g. country or region) and not in city suggestions
    if (placeName && !suggestions.some(s => s.label.includes(placeName))) {
      suggestions.unshift({
        type: 'place_search',
        label: `📍 Fly to ${placeName}`,
        sublabel: `Move map to ${placeName}`,
        query_override: placeName,
      });
    }

    // Command suggestions based on query
    const intent = detectIntent(q);
    const cleanQuery = q.replace(/^\//, '');

    if (intent === 'fly') {
      // Already handled by city suggestions above
    } else if (!placeName && topicMatches.length === 0) {
      // Only show command suggestions if no place or topic was detected
      if (intent === 'study') {
        suggestions.push({ type: 'study', label: '📊 Study this map', sublabel: 'Analyze density, sources, coverage', query_override: cleanQuery });
      } else if (intent === 'explore') {
        suggestions.push({ type: 'explore', label: '🔍 Explore for sources', sublabel: 'Discover RSS feeds in this area', query_override: cleanQuery });
      } else if (intent === 'request') {
        suggestions.push({ type: 'request', label: '📬 Request more coverage', sublabel: 'Ask AI to prioritize this area', query_override: cleanQuery });
      } else if (intent === 'chat') {
        suggestions.push({ type: 'chat', label: `🤖 Ask AI: "${cleanQuery}"`, sublabel: 'Get an AI-powered answer', query_override: cleanQuery });
      } else if (q.length >= 2) {
        const ctx = getMapContext();
        suggestions.push({ type: 'chat', label: `🤖 Ask AI: "${q}"`, sublabel: 'Get insights about this area' });
      }
    }

    // Add Wiki option at the bottom if place was detected
    if (placeName) {
      suggestions.push({
        type: 'wiki',
        label: `📖 Wikipedia: ${placeName}`,
        sublabel: 'Search Wikipedia for this place',
        query_override: placeName,
      });
    }

    return suggestions.slice(0, 6);
  }

  // Detect a city or country name in the query text
  function detectPlaceInQuery(q) {
    if (!q || q.length < 2) return null;
    const lower = q.toLowerCase();

    // Check CityEngine for city matches
    if (window.CityEngine) {
      try {
        const cities = CityEngine.findCities(q, 5);
        if (cities && cities.length > 0) {
          for (const c of cities) {
            const nameLower = (c.name || '').toLowerCase();
            if (nameLower.length >= 2 && lower.includes(nameLower)) {
              return c.name;
            }
          }
        }
      } catch (e) { /* CityEngine not ready */ }
    }

    // Check for country names
    const countryNames = [
      'china', 'india', 'usa', 'america', 'russia', 'brazil', 'japan',
      'germany', 'france', 'england', 'canada', 'australia',
      'korea', 'mexico', 'indonesia', 'turkey', 'argentina',
      'south africa', 'nigeria', 'egypt', 'pakistan', 'bangladesh',
      'vietnam', 'thailand', 'myanmar', 'philippines', 'ethiopia',
      'kenya', 'tanzania', 'uganda', 'colombia', 'spain', 'italy',
      'poland', 'ukraine', 'israel', 'iran', 'iraq', 'saudi arabia',
      'sweden', 'norway', 'switzerland', 'portugal', 'greece',
      'new zealand', 'chile', 'peru', 'nepal', 'afghanistan',
    ];
    for (const country of countryNames) {
      if (lower === country || lower.startsWith(country + ' ') || lower.endsWith(' ' + country) || lower.includes(' ' + country + ' ')) {
        return country.charAt(0).toUpperCase() + country.slice(1);
      }
    }

    return null;
  }

  // ── Execute a command ─────────────────────────────────────────────
  async function executeCommand(suggestion) {
    if (!suggestion) return;
    hideDropdown();
    searchInput.value = '';

    const ctx = getMapContext();

    switch (suggestion.type) {
      case 'topic_filter': {
        const key = suggestion.topic_key;
        if (typeof toggleCategoryFilter === 'function') {
          toggleCategoryFilter(key);
          showResult(`Filtered map to topic: ${suggestion.topic_label || key}`);
        } else {
          showResult(`Filtering by topic ${suggestion.topic_label || key}...`);
        }
        // Open legend panel if closed so user sees the active filter
        const panel = document.getElementById('legend');
        if (panel && panel.hidden) {
          const btn = document.getElementById('legend-btn');
          if (btn) btn.click();
        }
        break;
      }
      case 'fly': {
        const c = suggestion.data;
        if (c && c.lat != null && c.lng != null) {
          if (typeof map !== 'undefined' && map) {
            map.flyTo([c.lat, c.lng], 10, { duration: 1.5 });
          }
          showResult(`Flying to ${c.name}, ${c.country}...`);
        }
        break;
      }
      case 'study': {
        // Trigger existing Study This Map
        const btn = document.getElementById('help-study-btn');
        const panel = document.getElementById('help-panel');
        const helpBtn = document.getElementById('help-btn');
        if (panel) panel.hidden = false;
        if (helpBtn) helpBtn.classList.add('active');
        if (btn) setTimeout(() => btn.click(), 100);
        showResult('Studying map...');
        break;
      }
      case 'explore': {
        try {
          showResult('Discovering news sources...');
          const res = await fetch('/api/explore-region', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bbox: ctx.bbox,
              center_lat: ctx.center_lat,
              center_lng: ctx.center_lng,
              map_zoom: ctx.zoom,
              auto_add: true,
            }),
          });
          const data = await res.json();
          showResult(data.summary || `Found ${data.validated_sources?.length || 0} sources`);
        } catch (e) {
          showResult(`Explore failed: ${e.message}`);
        }
        break;
      }
      case 'request': {
        try {
          showResult('Submitting coverage request...');
          const res = await fetch('/api/recommend-news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bbox: ctx.bbox,
              center_lat: ctx.center_lat,
              center_lng: ctx.center_lng,
              map_zoom: ctx.zoom,
              message: suggestion.query_override || undefined,
            }),
          });
          const data = await res.json();
          showResult(data.duplicate ? 'Already requested for this area.' : 'Coverage request submitted!');
        } catch (e) {
          showResult(`Request failed: ${e.message}`);
        }
        break;
      }
      case 'chat': {
        try {
          showResult('Thinking...');
          const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: suggestion.query_override || suggestion.label || 'Tell me about this area',
              stream: false,
            }),
          });
          const data = await res.json();
          showResult(data.response || data.message || 'AI response received', { persistent: true });
        } catch (e) {
          showResult(`AI unavailable: ${e.message}`, { persistent: true });
        }
        break;
      }
      case 'place_search': {
        const place = suggestion.query_override || searchInput.value.trim();
        if (place) {
          searchInput.value = place;
          hideDropdown();
          if (typeof runTextSearch === 'function') {
            runTextSearch();
          } else if (typeof runSearch === 'function') {
            runSearch();
          }
        }
        break;
      }

      case 'wiki': {
        // Trigger wiki search for the place name
        const placeName = suggestion.query_override || '';
        if (placeName && typeof fetchWikiSearch === 'function') {
          fetchWikiSearch(placeName);
          showResult(`Searching Wikipedia for "${placeName}"...`);
        } else {
          showResult(`Wiki search for "${placeName}" — open the wiki panel to see results.`);
        }
        break;
      }

      case 'news': {
        // Trigger a normal news search for the place name
        const place = suggestion.query_override || '';
        if (place) {
          searchInput.value = place;
          // Let the normal search handler pick it up
          if (typeof runSearch === 'function') {
            runSearch();
          }
          showResult(`Searching news for "${place}"...`);
        }
        break;
      }
    }
  }

  // ── Dropdown UI ───────────────────────────────────────────────────
  function showDropdown(suggestions) {
    if (!dropdown) return;
    dropdown.innerHTML = '';
    if (suggestions.length === 0) {
      dropdown.hidden = true;
      return;
    }
    for (const s of suggestions) {
      const div = document.createElement('div');
      div.className = 'cmd-dropdown-item';
      div.innerHTML = `
        <span class="cmd-dropdown-label">${escapeHtml(s.label)}</span>
        ${s.sublabel ? `<span class="cmd-dropdown-sub">${escapeHtml(s.sublabel)}</span>` : ''}
      `;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        executeCommand(s);
      });
      dropdown.appendChild(div);
    }
    dropdown.hidden = false;
  }

  function hideDropdown() {
    if (dropdown) dropdown.hidden = true;
  }

  function showResult(message, { persistent = false } = {}) {
    if (!dropdown) return;
    const closeBtn = persistent
      ? `<button class="cmd-dropdown-close" aria-label="Close" onclick="document.getElementById('cmd-dropdown').hidden=true">×</button>`
      : '';
    dropdown.innerHTML = `<div class="cmd-dropdown-result">${escapeHtml(message)}${closeBtn}</div>`;
    dropdown.hidden = false;
    if (!persistent) {
      setTimeout(() => { dropdown.hidden = true; }, 8000);
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ── Input handling ────────────────────────────────────────────────
  let debounceTimer;
  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const q = searchInput.value.trim();
      if (!q) {
        hideDropdown();
        return;
      }
      const suggestions = buildSuggestions(q);
      showDropdown(suggestions);
    }, 150);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      hideDropdown();
      searchInput.blur();
    } else if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      if (!q) return;

      // Only auto-execute explicit slash commands (e.g. /study, /explore, /ask)
      if (q.startsWith('/')) {
        e.preventDefault();
        const suggestions = buildSuggestions(q);
        if (suggestions.length > 0) {
          executeCommand(suggestions[0]);
          return;
        }
      }

      // For all regular text/city/country queries, hide dropdown and let main map search run
      hideDropdown();
    }
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    searchInput = document.getElementById('search-input');
    searchBar = document.getElementById('search-bar');
    if (!searchInput || !searchBar) {
      XLog.warn('[command-bar] search bar not found');
      return;
    }

    // Create dropdown below search bar
    dropdown = document.createElement('div');
    dropdown.id = 'cmd-dropdown';
    dropdown.className = 'cmd-dropdown';
    dropdown.hidden = true;
    searchBar.style.position = 'relative';
    searchBar.appendChild(dropdown);

    // Attach listeners
    searchInput.addEventListener('input', onInput);
    searchInput.addEventListener('keydown', onKeydown);
    searchInput.addEventListener('focus', () => {
      const q = searchInput.value.trim();
      if (q) {
        const suggestions = buildSuggestions(q);
        showDropdown(suggestions);
      }
    });
    searchInput.addEventListener('blur', () => {
      setTimeout(hideDropdown, 200);
    });

    // Global ⌘K shortcut to focus search
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });

    // Remove the old command bar button from toolbar if it exists
    const oldBtn = document.getElementById('command-bar-btn');
    if (oldBtn) oldBtn.remove();

    XLog.log('[command-bar] integrated with search bar');
  }

  // ── Public API ────────────────────────────────────────────────────
  window.XyzoCommand = {
    open: () => { if (searchInput) { searchInput.focus(); searchInput.select(); } },
    close: () => { hideDropdown(); if (searchInput) searchInput.blur(); },
    execute: executeCommand,
    getContext: getMapContext,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
