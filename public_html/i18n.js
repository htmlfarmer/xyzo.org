/**
 * Xyzo i18n — lightweight internationalization for the frontend.
 *
 * Loads JSON translation dictionaries from /i18n/<lang>.json, applies
 * them to DOM elements with data-i18n="key" attributes, and handles
 * RTL layout switching for Arabic/Urdu/Persian/Hebrew.
 *
 * Usage:
 *   <span data-i18n="search.placeholder">Search city or news…</span>
 *   <button data-i18n="buttons.search">Search</button>
 *
 * Language selection:
 *   1. URL param: ?lang=es
 *   2. localStorage: xyzo.lang
 *   3. navigator.language
 *   4. Fallback: en
 *
 * No build step, no framework. Vanilla JS.
 */
(function () {
  'use strict';

  // RTL languages
  const RTL_LANGS = new Set(['ar', 'ur', 'fa', 'he', 'yi', 'ps', 'sd']);

  // Supported languages (must have a JSON file in /i18n/)
  const SUPPORTED = [
    { code: 'en', name: 'English', dir: 'ltr' },
    { code: 'es', name: 'Español', dir: 'ltr' },
    { code: 'fr', name: 'Français', dir: 'ltr' },
    { code: 'de', name: 'Deutsch', dir: 'ltr' },
    { code: 'pt', name: 'Português', dir: 'ltr' },
    { code: 'ru', name: 'Русский', dir: 'ltr' },
    { code: 'ar', name: 'العربية', dir: 'rtl' },
    { code: 'ur', name: 'اردو', dir: 'rtl' },
    { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
    { code: 'bn', name: 'বাংলা', dir: 'ltr' },
    { code: 'zh', name: '中文', dir: 'ltr' },
    { code: 'ja', name: '日本語', dir: 'ltr' },
    { code: 'ko', name: '한국어', dir: 'ltr' },
    { code: 'tr', name: 'Türkçe', dir: 'ltr' },
    { code: 'fa', name: 'فارسی', dir: 'rtl' },
    { code: 'pl', name: 'Polski', dir: 'ltr' },
    { code: 'it', name: 'Italiano', dir: 'ltr' },
    { code: 'nl', name: 'Nederlands', dir: 'ltr' },
    { code: 'sv', name: 'Svenska', dir: 'ltr' },
    { code: 'uk', name: 'Українська', dir: 'ltr' },
  ];

  const state = {
    lang: 'en',
    strings: {},
    loaded: false,
    loading: null,
  };

  // ── Language detection ────────────────────────────────────────────
  function detectLanguage() {
    // 1. URL param
    const params = new URLSearchParams(window.location.search);
    const urlLang = params.get('lang');
    if (urlLang && SUPPORTED.some(l => l.code === urlLang)) return urlLang;

    // 2. localStorage
    const stored = localStorage.getItem('xyzo.lang');
    if (stored && SUPPORTED.some(l => l.code === stored)) return stored;

    // 3. Browser language
    const browserLang = (navigator.language || 'en').split('-')[0].toLowerCase();
    if (SUPPORTED.some(l => l.code === browserLang)) return browserLang;

    // 4. Fallback
    return 'en';
  }

  // ── Load translations ────────────────────────────────────────────
  async function load(lang) {
    if (state.loaded && state.lang === lang) return;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      try {
        const resp = await fetch(`/i18n/${lang}.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state.strings = await resp.json();
        state.lang = lang;
        state.loaded = true;
        localStorage.setItem('xyzo.lang', lang);
        applyTranslations();
        applyDirection(lang);
        XLog.debug(`[i18n] loaded ${lang}: ${Object.keys(state.strings).length} keys`);
      } catch (e) {
        XLog.warn(`[i18n] failed to load ${lang}:`, e);
        // Fall back to English
        if (lang !== 'en') {
          state.lang = 'en';
          state.loaded = true;
        }
      }
      state.loading = null;
    })();

    return state.loading;
  }

  // ── Apply translations to DOM ─────────────────────────────────────
  function applyTranslations() {
    const elements = document.querySelectorAll('[data-i18n]');
    for (const el of elements) {
      const key = el.getAttribute('data-i18n');
      const text = t(key);
      if (text && text !== key) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.placeholder = text;
        } else {
          el.textContent = text;
        }
      }
    }
    // Also handle data-i18n-title for title attributes
    const titleEls = document.querySelectorAll('[data-i18n-title]');
    for (const el of titleEls) {
      const key = el.getAttribute('data-i18n-title');
      const text = t(key);
      if (text && text !== key) {
        el.title = text;
      }
    }
    // Handle data-i18n-aria for aria-labels
    const ariaEls = document.querySelectorAll('[data-i18n-aria]');
    for (const el of ariaEls) {
      const key = el.getAttribute('data-i18n-aria');
      const text = t(key);
      if (text && text !== key) {
        el.setAttribute('aria-label', text);
      }
    }
  }

  // ── RTL/LTR direction ─────────────────────────────────────────────
  function applyDirection(lang) {
    const isRtl = RTL_LANGS.has(lang);
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }

  // ── Translation function ──────────────────────────────────────────
  function t(key) {
    if (state.strings[key] !== undefined) return state.strings[key];
    // Try dotted path: "buttons.search" → strings.buttons.search
    const parts = key.split('.');
    let obj = state.strings;
    for (const part of parts) {
      if (obj && typeof obj === 'object' && part in obj) {
        obj = obj[part];
      } else {
        return key; // Return key as fallback
      }
    }
    return typeof obj === 'string' ? obj : key;
  }

  // ── Language switcher ─────────────────────────────────────────────
  function createSwitcher(container) {
    if (!container) return;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'lang-switcher-wrapper';

    const globe = document.createElement('span');
    globe.className = 'lang-globe-icon';
    globe.innerHTML = '🌐';
    globe.title = 'Select Language';

    const select = document.createElement('select');
    select.id = 'lang-switcher';
    select.className = 'lang-switcher';
    select.setAttribute('aria-label', 'Select Language');

    for (const lang of SUPPORTED) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.name} (${lang.code.toUpperCase()})`;
      if (lang.code === state.lang) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', (e) => {
      const newLang = e.target.value;
      load(newLang).then(() => {
        window.location.reload();
      });
    });

    wrapper.appendChild(globe);
    wrapper.appendChild(select);
    container.appendChild(wrapper);
  }

  // ── Public API ────────────────────────────────────────────────────
  window.XyzoI18n = {
    t,
    load,
    detectLanguage,
    createSwitcher,
    getLang: () => state.lang,
    isRtl: () => RTL_LANGS.has(state.lang),
    supported: SUPPORTED,
  };

  // ── Auto-init ─────────────────────────────────────────────────────
  // Load translations on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const lang = detectLanguage();
    load(lang).then(() => {
      const container = document.getElementById('lang-container') ||
                        document.getElementById('top-bar') ||
                        document.getElementById('map-controls');
      if (container) {
        createSwitcher(container);
      }
    });
  }
})();
