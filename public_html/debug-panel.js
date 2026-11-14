/**
 * Xyzo Debug Panel — toggleable overlay showing real-time system diagnostics.
 *
 * Press Ctrl+Shift+D or click the "Debug" button in the bottom bar to open.
 * Polls /api/debug?verbose=1 every 10 seconds while open.
 */
(function () {
  'use strict';

  let panel = null;
  let visible = false;
  let pollTimer = null;
  const POLL_INTERVAL = 10_000;

  function createPanel() {
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.innerHTML = `
      <style>
        #debug-panel {
          position: fixed; top: 0; right: 0; bottom: 0; width: 420px;
          background: rgba(11,15,20,0.97); border-left: 1px solid #1f2937;
          z-index: 9999; overflow-y: auto; font-family: ui-monospace, monospace;
          font-size: 12px; color: #e6edf3; padding: 16px;
          transform: translateX(100%); transition: transform 0.2s ease, visibility 0.2s ease;
          backdrop-filter: blur(12px);
          pointer-events: none;
          visibility: hidden;
        }
        #debug-panel.open { transform: translateX(0); pointer-events: auto; visibility: visible; }
        #debug-panel h3 { color: #5eead4; font-size: 14px; margin: 0 0 12px; display: flex; justify-content: space-between; align-items: center; }
        #debug-panel .close-btn { background: none; border: none; color: #64748b; cursor: pointer; font-size: 18px; padding: 0 4px; }
        #debug-panel .close-btn:hover { color: #e6edf3; }
        .dbg-section { margin-bottom: 16px; border: 1px solid #1f2937; border-radius: 6px; overflow: hidden; }
        .dbg-section-header {
          background: rgba(31,41,55,0.5); padding: 6px 10px; font-weight: 600;
          color: #5eead4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
          display: flex; align-items: center; gap: 6px;
        }
        .dbg-section-body { padding: 8px 10px; }
        .dbg-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid rgba(31,41,55,0.3); }
        .dbg-row:last-child { border-bottom: none; }
        .dbg-label { color: #64748b; }
        .dbg-value { font-weight: 600; text-align: right; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dbg-ok { color: #22c55e; }
        .dbg-warn { color: #f59e0b; }
        .dbg-error { color: #ef4444; }
        .dbg-info { color: #3b82f6; }
        .dbg-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .dbg-dot.green { background: #22c55e; }
        .dbg-dot.red { background: #ef4444; }
        .dbg-dot.yellow { background: #f59e0b; }
        .dbg-error-list { max-height: 120px; overflow-y: auto; margin-top: 4px; }
        .dbg-error-item { padding: 3px 0; border-bottom: 1px solid rgba(31,41,55,0.3); font-size: 11px; }
        .dbg-error-item:last-child { border-bottom: none; }
        .dbg-error-time { color: #64748b; margin-right: 6px; }
        .dbg-error-msg { color: #f59e0b; word-break: break-all; }
        .dbg-json { background: rgba(31,41,55,0.3); padding: 6px 8px; border-radius: 4px; font-size: 11px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: #94a3b8; }
        .dbg-timestamp { color: #64748b; font-size: 10px; text-align: right; margin-top: 8px; }
        .dbg-loading { color: #64748b; text-align: center; padding: 20px; }
      </style>

      <h3>
        <span>System Debug</span>
        <button class="close-btn" onclick="window.DebugPanel.toggle()">×</button>
      </h3>
      <div id="dbg-content"><div class="dbg-loading">Loading...</div></div>
    `;

    document.body.appendChild(panel);
    return panel;
  }

  function dot(ok) {
    return `<span class="dbg-dot ${ok ? 'green' : 'red'}"></span>`;
  }

  function val(text, cls) {
    return `<span class="dbg-value ${cls || ''}">${text}</span>`;
  }

  function row(label, value, cls) {
    return `<div class="dbg-row"><span class="dbg-label">${label}</span>${val(value, cls)}</div>`;
  }

  function section(title, icon, bodyHtml) {
    return `<div class="dbg-section">
      <div class="dbg-section-header">${icon} ${title}</div>
      <div class="dbg-section-body">${bodyHtml}</div>
    </div>`;
  }

  function formatMs(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  function render(data) {
    const content = document.getElementById('dbg-content');
    if (!content) return;

    let html = '';

    // ── Database ────────────────────────────────────────────────────
    const db = data.components?.database || {};
    html += section('Database', '🗄️',
      row('Status', db.ok ? 'Connected' : 'DOWN', db.ok ? 'dbg-ok' : 'dbg-error') +
      row('Latency', db.latency_ms >= 0 ? `${db.latency_ms}ms` : '—', db.latency_ms < 50 ? 'dbg-ok' : db.latency_ms < 200 ? 'dbg-warn' : 'dbg-error') +
      (db.error ? row('Error', db.error, 'dbg-error') : '') +
      (db.stats ? row('Articles', (db.stats.articles || 0).toLocaleString(), 'dbg-info') : '') +
      (db.stats ? row('Pending', (db.stats.pending || 0).toLocaleString(), db.stats.pending > 100 ? 'dbg-warn' : 'dbg-ok') : '') +
      (db.stats ? row('Events', (db.stats.events || 0).toLocaleString(), 'dbg-info') : '') +
      (db.stats ? row('Active Sources', (db.stats.active_sources || 0).toLocaleString(), 'dbg-info') : '') +
      (db.stats ? row('In-flight Jobs', (db.stats.in_flight_jobs || 0).toLocaleString(), 'dbg-info') : '')
    );

    // ── AI / Circuit Breaker ────────────────────────────────────────
    const ai = data.components?.ai || {};
    const breaker = ai.breaker || {};
    const stats = ai.stats || {};
    const errors = ai.recent_errors || [];
    html += section('AI Circuit Breaker', '🤖',
      row('Status', breaker.open ? 'OPEN (short-circuiting)' : 'CLOSED (healthy)', breaker.open ? 'dbg-error' : 'dbg-ok') +
      (breaker.open ? row('Opens in', formatMs(breaker.open_for_ms), 'dbg-warn') : '') +
      row('Recent Failures', `${breaker.recent_failures || 0} / ${breaker.fail_threshold || 3}`, breaker.recent_failures > 0 ? 'dbg-warn' : 'dbg-ok') +
      row('Success Rate', `${stats.success_rate_pct ?? 100}%`, (stats.success_rate_pct ?? 100) >= 95 ? 'dbg-ok' : (stats.success_rate_pct ?? 100) >= 80 ? 'dbg-warn' : 'dbg-error') +
      row('Total Calls', (stats.total_calls || 0).toLocaleString(), 'dbg-info') +
      row('Total Failures', (stats.total_failures || 0).toLocaleString(), stats.total_failures > 0 ? 'dbg-warn' : 'dbg-ok') +
      row('Short-circuits', (stats.total_short_circuits || 0).toLocaleString(), stats.total_short_circuits > 0 ? 'dbg-warn' : 'dbg-ok') +
      row('Last Success', stats.last_success_at ? new Date(stats.last_success_at).toLocaleTimeString() : 'never', 'dbg-info') +
      row('Last Failure', stats.last_failure_at ? new Date(stats.last_failure_at).toLocaleTimeString() : 'never', stats.last_failure_at ? 'dbg-warn' : 'dbg-ok') +
      row('Endpoint', ai.endpoint || '—', 'dbg-info') +
      (errors.length > 0
        ? '<div class="dbg-error-list">' + errors.slice(-5).reverse().map(e =>
            `<div class="dbg-error-item"><span class="dbg-error-time">${new Date(e.at).toLocaleTimeString()}</span><span class="dbg-error-msg">${e.msg}</span></div>`
          ).join('') + '</div>'
        : '')
    );

    // ── Queue ───────────────────────────────────────────────────────
    const q = data.components?.queue || {};
    const slots = q.slots || [];
    const jobsByKind = q.jobsByKind || {};
    html += section('Worker Queue', '⚙️',
      row('State', q.state || '—', q.ok ? 'dbg-ok' : 'dbg-error') +
      row('Pool Size', q.poolSize || 0, 'dbg-info') +
      row('Active Workers', q.activeWorkers || 0, 'dbg-info') +
      (q.degradedSince ? row('Degraded Since', new Date(q.degradedSince).toLocaleTimeString(), 'dbg-error') : '') +
      row('Slots', slots.map(s => `${s.id}:${s.ready ? '✓' : '✗'}`).join(' '), 'dbg-info') +
      (jobsByKind.queued && Object.keys(jobsByKind.queued).length > 0
        ? row('Queued', JSON.stringify(jobsByKind.queued), 'dbg-info') : '') +
      (jobsByKind.running && Object.keys(jobsByKind.running).length > 0
        ? row('Running', JSON.stringify(jobsByKind.running), 'dbg-info') : '')
    );

    // ── Extraction Stats ────────────────────────────────────────────
    const ext = data.extraction_stats;
    if (ext) {
      html += section('Extraction (1h window)', '📰',
        row('Extracted', (ext.extracted_1h || 0).toLocaleString(), 'dbg-ok') +
        row('Failed', (ext.failed_1h || 0).toLocaleString(), ext.failed_1h > 0 ? 'dbg-warn' : 'dbg-ok') +
        row('Unlocated', (ext.unlocated_1h || 0).toLocaleString(), ext.unlocated_1h > 0 ? 'dbg-warn' : 'dbg-ok') +
        row('Pending Now', (ext.pending_now || 0).toLocaleString(), ext.pending_now > 100 ? 'dbg-warn' : 'dbg-ok')
      );
    }

    // ── Recent Jobs ─────────────────────────────────────────────────
    const jobs = data.recent_jobs;
    if (jobs && jobs.length > 0) {
      html += section('Recent Jobs (1h)', '📋',
        jobs.map(j => `<div class="dbg-row">
          <span class="dbg-label">${j.kind} <span style="color:${j.status === 'completed' ? '#22c55e' : j.status === 'failed' ? '#ef4444' : j.status === 'running' ? '#3b82f6' : '#64748b'}">${j.status}</span></span>
          <span class="dbg-value dbg-info">${j.duration_s != null ? j.duration_s + 's' : '—'}</span>
        </div>`).join('')
      );
    }

    // ── Process ─────────────────────────────────────────────────────
    const proc = data.process || {};
    const mem = proc.memory || {};
    html += section('Process', '💻',
      row('PID', proc.pid || '—', 'dbg-info') +
      row('Bun Version', proc.bun_version || '—', 'dbg-info') +
      row('Heap Used', `${mem.heap_used_mb || 0} MB`, 'dbg-info') +
      row('Heap Total', `${mem.heap_total_mb || 0} MB`, 'dbg-info') +
      row('RSS', `${mem.rss_mb || 0} MB`, 'dbg-info') +
      row('Uptime', formatMs(data.uptime_ms || 0), 'dbg-info')
    );

    html += `<div class="dbg-timestamp">Updated ${new Date(data.timestamp).toLocaleTimeString()} · polls every 10s</div>`;

    content.innerHTML = html;
  }

  async function fetchAndRender() {
    try {
      const res = await fetch('/api/debug?verbose=1');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      render(data);
    } catch (e) {
      const content = document.getElementById('dbg-content');
      if (content) content.innerHTML = `<div class="dbg-loading" style="color:#ef4444">Failed to load: ${e.message}</div>`;
    }
  }

  function show() {
    createPanel();
    requestAnimationFrame(() => panel.classList.add('open'));
    visible = true;
    fetchAndRender();
    pollTimer = setInterval(fetchAndRender, POLL_INTERVAL);
  }

  function hide() {
    if (panel) panel.classList.remove('open');
    visible = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function toggle() {
    if (visible) hide(); else show();
  }

  // ── Keyboard shortcut: Ctrl+Shift+D ──────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      toggle();
    }
  });

  // ── Live Hover Inspector Utility ──────────────────────────────────
  let hoverInspectActive = false;
  let hoverHighlightEl = null;

  function onHoverInspect(e) {
    if (!hoverInspectActive) return;
    const target = e.target;
    if (!target || target === document.body || target === document.documentElement) return;

    if (!hoverHighlightEl) {
      hoverHighlightEl = document.createElement('div');
      hoverHighlightEl.id = 'xyzo-inspect-highlight';
      hoverHighlightEl.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;border:2px solid #5eead4;background:rgba(94,234,212,0.15);transition:all 0.05s ease;box-shadow:0 0 10px rgba(94,234,212,0.5);';
      document.body.appendChild(hoverHighlightEl);
    }

    const rect = target.getBoundingClientRect();
    hoverHighlightEl.style.left = `${rect.left}px`;
    hoverHighlightEl.style.top = `${rect.top}px`;
    hoverHighlightEl.style.width = `${rect.width}px`;
    hoverHighlightEl.style.height = `${rect.height}px`;

    const info = {
      tagName: target.tagName.toLowerCase(),
      id: target.id || null,
      className: target.className || null,
      dataset: Object.keys(target.dataset).length ? target.dataset : null,
      element: target
    };
    XLog.log('[XYZO Hover Inspector]', info);
  }

  function toggleHoverInspector(enable) {
    hoverInspectActive = typeof enable === 'boolean' ? enable : !hoverInspectActive;
    if (hoverInspectActive) {
      document.addEventListener('mouseover', onHoverInspect, true);
      XLog.log('🔍 [XYZO Hover Inspector] ENABLED — Move mouse over any element to highlight & inspect DOM metadata in DevTools console. Run XYZO_INSPECT(false) to stop.');
    } else {
      document.removeEventListener('mouseover', onHoverInspect, true);
      if (hoverHighlightEl) {
        hoverHighlightEl.remove();
        hoverHighlightEl = null;
      }
      XLog.log('🔍 [XYZO Hover Inspector] DISABLED.');
    }
    return hoverInspectActive;
  }

  window.XYZO_INSPECT = toggleHoverInspector;

  // ── Public API ────────────────────────────────────────────────────
  window.DebugPanel = { show, hide, toggle, inspect: toggleHoverInspector };
})();
