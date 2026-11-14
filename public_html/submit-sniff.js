/**
 * Submit-form live sniff.
 *
 * When the user pastes a URL or types a title in the community
 * submission form, fire /api/sniff and show the detected cities as
 * a pre-fill hint. They can accept it (one click moves the map to
 * that location) or ignore it and click the map manually.
 *
 * Latency: ~200ms for text, ~500ms-2s for URL (server fetches the URL).
 * Throttled to 1 request per 800ms to keep the API rate-limit happy.
 */

(function () {
  'use strict';

  const urlInput = document.getElementById('canonical-url-input');
  const titleInput = document.querySelector('input[name="title"]');
  const hintEl = document.getElementById('sniff-hint');
  const placeInput = document.getElementById('place-input');
  const latDisplay = document.getElementById('lat-display');
  const lngDisplay = document.getElementById('lng-display');
  const findBtn = document.getElementById('find-btn');

  if (!urlInput || !titleInput || !hintEl) return;

  let lastReq = 0;
  let timer = null;
  let currentSniff = null;

  function scheduleSniff() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runSniff, 800);
  }

  async function runSniff() {
    const url = urlInput.value.trim();
    const title = titleInput.value.trim();
    const body = { text: title };
    if (url) body.url = url;
    if (!body.text && !body.url) {
      hintEl.hidden = true;
      return;
    }
    const reqId = ++lastReq;
    hintEl.hidden = false;
    hintEl.textContent = 'Sniffing for cities…';
    hintEl.className = 'sniff-hint loading';
    try {
      const resp = await fetch('/api/sniff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (reqId !== lastReq) return; // newer sniff in flight
      if (!resp.ok) {
        hintEl.hidden = true;
        return;
      }
      const data = await resp.json();
      currentSniff = data;
      renderHint(data);
    } catch {
      if (reqId === lastReq) hintEl.hidden = true;
    }
  }

  function renderHint(data) {
    if (!data.primary && data.count === 0) {
      hintEl.innerHTML = '<span class="sniff-empty">No cities detected yet — paste a URL or add more detail to the title.</span>';
      hintEl.className = 'sniff-hint empty';
      return;
    }
    const cities = (data.cities || []).slice(0, 5);
    const primary = data.primary;
    const flag = (cc) => cc && cc.length === 2
      ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)))
      : '';
    const citiesHtml = cities.map(c =>
      `<span class="sniff-city" data-lat="${c.lat}" data-lng="${c.lng}" `
      + `data-cc="${c.country_code}" data-name="${escapeAttr(c.name)}">`
      + `<span class="sniff-flag">${flag(c.country_code)}</span>${escapeHtml(c.name)}`
      + (c.match_kind === 'alias' ? ' <span class="sniff-alias">alias</span>' : '')
      + '</span>'
    ).join('');
    const primaryLine = primary
      ? `<div class="sniff-primary">${flag(primary.country_code)} <strong>${escapeHtml(primary.name)}</strong>, ${primary.country_code}`
        + ` · pop ${formatPop(primary.population)}`
        + ` — <button type="button" class="sniff-use">use this location</button></div>`
      : '';
    hintEl.innerHTML = `
      <div class="sniff-detected">Detected ${data.count} ${data.count === 1 ? 'city' : 'cities'}</div>
      ${primaryLine}
      <div class="sniff-list">${citiesHtml}</div>
    `;
    hintEl.className = 'sniff-hint has-results' + (data.is_national ? ' national' : '');

    // Wire "use this location" button.
    const useBtn = hintEl.querySelector('.sniff-use');
    if (useBtn && primary && placeInput) {
      useBtn.addEventListener('click', () => {
        placeInput.value = `${primary.name}, ${primary.country_code}`;
        if (latDisplay) latDisplay.textContent = primary.lat.toFixed(4);
        if (lngDisplay) lngDisplay.textContent = primary.lng.toFixed(4);
        useBtn.textContent = 'applied ✓';
        useBtn.disabled = true;
        // Trigger the existing find-btn logic if the function exists.
        if (typeof findBtn !== 'undefined' && findBtn) {
          findBtn.click();
        }
      });
    }

    // Wire city chips.
    hintEl.querySelectorAll('.sniff-city').forEach((el) => {
      el.addEventListener('click', () => {
        const lat = Number(el.getAttribute('data-lat'));
        const lng = Number(el.getAttribute('data-lng'));
        const name = el.getAttribute('data-name');
        const cc = el.getAttribute('data-cc');
        if (placeInput) placeInput.value = `${name}, ${cc}`;
        if (latDisplay) latDisplay.textContent = lat.toFixed(4);
        if (lngDisplay) lngDisplay.textContent = lng.toFixed(4);
        if (findBtn) findBtn.click();
      });
    });
  }

  function formatPop(p) {
    if (!p) return '—';
    if (p >= 1_000_000) return (p / 1_000_000).toFixed(1) + 'M';
    if (p >= 1_000) return (p / 1_000).toFixed(0) + 'k';
    return String(p);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Wire inputs.
  urlInput.addEventListener('input', scheduleSniff);
  urlInput.addEventListener('paste', () => setTimeout(scheduleSniff, 50));
  titleInput.addEventListener('input', scheduleSniff);
  titleInput.addEventListener('paste', () => setTimeout(scheduleSniff, 50));
})();
