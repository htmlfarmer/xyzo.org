// collab.js — public dashboard logic
//
// Used by:
//   /collab/index.html   — landing + nodes table
//   /collab/nodes.html   — full nodes list
//   /collab/node.html    — single-node view
//
// Reads window.collabView ("index" | "list" | "node") to decide what to render.
// If unset, defaults to "index".

(function () {
  'use strict';

  const view = window.collabView || 'index';

  // ── tiny helpers ──────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  function ago(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return iso;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function freshnessClass(iso) {
    if (!iso) return 'dead';
    const ageMs = Date.now() - new Date(iso).getTime();
    if (ageMs < 60_000) return 'fresh';      // < 1min
    if (ageMs < 5 * 60_000) return 'fresh';  // < 5min
    if (ageMs < 30 * 60_000) return 'stale'; // < 30min
    return 'dead';
  }

  function renderRoles(roles) {
    if (!roles || !roles.length) return '<span class="role-pill">none</span>';
    return roles.map((r) => `<span class="role-pill">${esc(r)}</span>`).join('');
  }

  // ── nodes list (used by index + nodes views) ──────────────────────────
  async function renderNodes() {
    const body = $('nodes-body');
    if (!body) return;
    let data;
    try {
      const res = await fetch('/api/collab/nodes', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      body.innerHTML = `<tr><td colspan="7" class="loading">failed to load: ${esc(e.message)}</td></tr>`;
      return;
    }
    const nodes = data.nodes || [];
    if (nodes.length === 0) {
      body.innerHTML = `<tr><td colspan="7" class="loading">no nodes registered yet — be the first! <code>curl -sSL xyzo.org/install-collab.sh | bash</code></td></tr>`;
      return;
    }
    body.innerHTML = nodes
      .map((n) => {
        const cls = freshnessClass(n.last_heartbeat_at);
        const done = n.jobs_done || 0;
        const fail = n.jobs_failed || 0;
        const stats = fail > 0 ? `${done}✓ ${fail}✗` : `${done}✓`;
        return `<tr>
          <td><a href="/collab/node/${esc(n.node_id)}"><code>${esc(n.node_id)}</code></a><br/><small>${esc(n.name || '')}</small></td>
          <td>${esc(n.os || '—')}</td>
          <td>${renderRoles(n.roles)}</td>
          <td><small>${esc(n.collabd_version || '—')}</small></td>
          <td>${stats}</td>
          <td class="${cls}">${ago(n.last_heartbeat_at)}</td>
        </tr>`;
      })
      .join('');
  }

  // ── single node view ─────────────────────────────────────────────────
  async function renderNode() {
    const m = location.pathname.match(/\/collab\/node\/([a-z2-7]{12})/);
    if (!m) {
      const t = $('node-title');
      if (t) t.textContent = 'unknown node';
      return;
    }
    const id = m[1];
    let data;
    try {
      const res = await fetch(`/api/collab/node/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      $('node-title').textContent = 'failed to load';
      $('node-subtitle').textContent = e.message;
      return;
    }
    const n = data.node || {};
    const stats = data.stats_7d || {};
    const activity = data.activity || [];

    $('node-title').innerHTML = `<code>${esc(n.node_id)}</code>`;
    $('node-subtitle').textContent = n.name || '';

    const setText = (id, val) => {
      const el = $(id);
      if (el) el.textContent = val;
    };
    setText('p-node_id', n.node_id);
    setText('p-name', n.name || '—');
    setText('p-os', `${n.os || '—'} / ${n.arch || '—'}`);
    setText('p-version', n.collabd_version || '—');
    setText('p-registered', new Date(n.registered_at).toLocaleString());
    setText('p-heartbeat', ago(n.last_heartbeat_at));
    setText('p-status', n.status || '—');

    setText('s-done', stats.jobs_done ?? 0);
    setText('s-failed', stats.jobs_failed ?? 0);
    setText('s-claimed', stats.jobs_claimed ?? 0);
    setText('s-total', stats.total_events ?? 0);

    const tbody = $('activity-body');
    if (activity.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="loading">no activity yet</td></tr>';
    } else {
      tbody.innerHTML = activity
        .map((a) => {
          const detail = a.detail ? JSON.stringify(a.detail) : '';
          return `<tr>
            <td><small>${esc(new Date(a.created_at).toLocaleString())}</small></td>
            <td><code>${esc(a.action)}</code></td>
            <td><small>${esc(detail)}</small></td>
          </tr>`;
        })
        .join('');
    }
  }

  // ── copy install command ─────────────────────────────────────────────
  function bindCopy() {
    const btn = $('copy-cmd');
    const cmd = $('install-cmd');
    if (!btn || !cmd) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd.textContent.trim());
        btn.textContent = 'copied ✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'copy';
          btn.classList.remove('copied');
        }, 2000);
      } catch {
        // Fallback for non-clipboard browsers: select the text.
        const range = document.createRange();
        range.selectNode(cmd);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    });
  }

  // ── boot ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    bindCopy();
    if (view === 'list' || view === 'index') {
      renderNodes();
      setInterval(renderNodes, 30_000);
    }
    if (view === 'node') {
      renderNode();
      setInterval(renderNode, 30_000);
    }
  });
})();
