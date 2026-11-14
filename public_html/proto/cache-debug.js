/**
 * CacheDebugger - Client-side cache debugging and visualization
 * 
 * Wraps cache operations with logging, provides:
 * - Visual debugger panel
 * - Request/response logging
 * - Version tracking
 * - One-click cache busting
 * - Stale data warnings
 * 
 * Usage:
 *   CacheDebugger.init();
 *   window.__cacheDebug.snapshot();  // DevTools access
 */

const CacheDebugger = (function() {
  let _enabled = false;
  let _bypass = false;
  let _panel = null;
  let _log = [];
  const MAX_LOG = 100;

  const _stores = {
    stories: { version: 0, updatedAt: null, size: 0 },
    entities: { version: 0, updatedAt: null, size: 0 },
    events: { version: 0, updatedAt: null, size: 0 },
    mapTiles: { version: 0, updatedAt: null, size: 0 },
    userPrefs: { version: 0, updatedAt: null, size: 0 }
  };

  function init() {
    _enabled = true;
    _log = [];
    log('info', 'CacheDebugger initialized');
    
    document.addEventListener('cache-operation', function(e) {
      log(e.detail.type, e.detail.message, e.detail.data);
    });
    
    window.__cacheDebug = {
      snapshot: snapshot,
      log: getLog,
      clear: clearCache,
      version: getVersion,
      bypass: setBypass,
      getStores: getStores,
      enablePanel: createPanel,
      disablePanel: removePanel
    };
    
    console.log('%c🧹 CacheDebugger ready', 'color: #00d4aa; font-weight: bold');
    console.log('  window.__cacheDebug for API');
  }

  function log(type, message, data = null) {
    const entry = {
      time: new Date().toISOString(),
      type,
      message,
      data
    };
    
    _log.unshift(entry);
    if (_log.length > MAX_LOG) _log.pop();
    
    const color = type === 'error' ? '#d44' :
                  type === 'warn' ? '#da0' :
                  type === 'hit' ? '#0a4' :
                  type === 'miss' ? '#a60' :
                  '#888';
    
    const prefix = type === 'hit' ? 'HIT' :
                   type === 'miss' ? 'MISS' :
                   type === 'put' ? 'PUT' :
                   type === 'clear' ? 'CLR' :
                   type === 'fetch' ? '→' :
                   '•';
    
    if (window.XYZO_DEBUG || type === 'error' || type === 'warn') {
      console.log(`%c[${prefix}] ${message}`, `color: ${color}`, data || '');
    }
    
    if (_panel) updatePanel();
  }

  function recordHit(store, key) {
    log('hit', `CACHE HIT: ${store}?${key}`);
  }

  function recordMiss(store, key, reason = 'not found') {
    log('miss', `CACHE MISS: ${store}?${key} (${reason})`);
  }

  function recordPut(store, key, itemCount = 1) {
    log('put', `CACHE PUT: ${store}?${key}`, `${itemCount} items`);
    _stores[store].version++;
    _stores[store].updatedAt = Date.now();
    _stores[store].size = itemCount;
  }

  function recordFetch(store, key, url) {
    log('fetch', `FETCHING: ${store}?${key}`, url);
  }

  function recordClear(store) {
    log('clear', `CACHE CLEAR: ${store}`);
    if (_stores[store]) {
      _stores[store].version = 0;
      _stores[store].updatedAt = null;
      _stores[store].size = 0;
    }
  }

  function getVersion(store) {
    return _stores[store]?.version || 0;
  }

  function getStores() {
    return { ..._stores };
  }

  function getLog() {
    return [..._log];
  }

  function clearCache(store = 'all') {
    if (store === 'all') {
      Object.keys(_stores).forEach(s => recordClear(s));
      log('info', 'All caches cleared');
    } else {
      recordClear(store);
    }
  }

  function setBypass(value) {
    _bypass = value;
    log('warn', `Cache BYPASS ${value ? 'ENABLED' : 'DISABLED'}`);
  }

  function isBypassed() {
    return _bypass;
  }

  function snapshot() {
    return {
      stores: getStores(),
      log: getLog(),
      bypass: _bypass,
      memory: performance.memory ? {
        used: (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2) + 'MB',
        total: (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(2) + 'MB'
      } : null,
      timing: performance.timing ? {
        load: performance.timing.loadEventEnd - performance.timing.navigationStart,
        dom: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart
      } : null
    };
  }

  function createPanel() {
    if (_panel) return;
    
    const panel = document.createElement('div');
    panel.id = 'cache-debug-panel';
    panel.innerHTML = getPanelHTML();
    document.body.appendChild(panel);
    _panel = panel;
    
    panel.querySelector('.cdb-close').addEventListener('click', removePanel);
    panel.querySelector('.cdb-clear-all').addEventListener('click', () => { clearCache('all'); updatePanel(); });
    panel.querySelector('.cdb-bypass').addEventListener('click', () => { setBypass(!_bypass); updatePanel(); });
    
    updatePanel();
    log('info', 'Debug panel opened');
  }

  function removePanel() {
    if (_panel) {
      _panel.remove();
      _panel = null;
    }
  }

  function updatePanel() {
    if (!_panel) return;
    
    const stores = getStores();
    const logEntries = getLog().slice(0, 20);
    
    let storesHTML = Object.entries(stores).map(([name, info]) => {
      const age = info.updatedAt ? ageString(Date.now() - info.updatedAt) : 'never';
      const status = info.updatedAt ? '●' : '○';
      const color = info.updatedAt ? '#0a4' : '#666';
      return `
        <div class="cdb-store">
          <span class="cdb-store-name">${name}</span>
          <span class="cdb-store-version" style="color: ${color}">${status} v${info.version}</span>
          <span class="cdb-store-age">${age}</span>
          <span class="cdb-store-size">${info.size || 0} items</span>
          <button class="cdb-btn-small" onclick="window.__cacheDebug.clear('${name}')">CLR</button>
        </div>
      `;
    }).join('');
    
    let logHTML = logEntries.map(entry => {
      const color = entry.type === 'error' ? '#d44' :
                    entry.type === 'warn' ? '#da0' :
                    entry.type === 'hit' ? '#0a4' :
                    entry.type === 'miss' ? '#a60' :
                    entry.type === 'put' ? '#00d4aa' :
                    entry.type === 'fetch' ? '#08f' :
                    '#888';
      return `<div class="cdb-log-entry" style="border-left: 2px solid ${color}">[${entry.type}] ${entry.message}</div>`;
    }).join('');
    
    _panel.querySelector('.cdb-stores').innerHTML = storesHTML;
    _panel.querySelector('.cdb-log').innerHTML = logHTML;
    _panel.querySelector('.cdb-bypass').textContent = _bypass ? 'ENABLE CACHE' : 'BYPASS CACHE';
    _panel.querySelector('.cdb-bypass').style.background = _bypass ? '#d44' : '#333';
  }

  function ageString(ms) {
    if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
    return Math.floor(ms / 86400000) + 'd ago';
  }

  function getPanelHTML() {
    return `
      <style>
        #cache-debug-panel {
          position: fixed;
          bottom: 10px;
          right: 10px;
          width: 380px;
          max-height: 500px;
          background: #0a0a0f;
          border: 1px solid #2a2a3a;
          border-radius: 8px;
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 11px;
          color: #e0e0e0;
          z-index: 99999;
          overflow: hidden;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }
        
        #cache-debug-panel * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        
        .cdb-header {
          background: #151520;
          padding: 8px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #2a2a3a;
        }
        
        .cdb-title {
          font-weight: 600;
          color: #00d4aa;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .cdb-controls {
          display: flex;
          gap: 6px;
        }
        
        .cdb-btn {
          background: #222;
          border: 1px solid #333;
          color: #888;
          padding: 3px 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 10px;
        }
        
        .cdb-btn:hover {
          background: #333;
          color: #fff;
        }
        
        .cdb-btn-small {
          background: #333;
          border: none;
          color: #888;
          padding: 1px 5px;
          border-radius: 2px;
          cursor: pointer;
          font-size: 9px;
        }
        
        .cdb-section {
          padding: 8px 12px;
          border-bottom: 1px solid #1a1a25;
        }
        
        .cdb-section-title {
          color: #666;
          text-transform: uppercase;
          font-size: 9px;
          letter-spacing: 1px;
          margin-bottom: 6px;
        }
        
        .cdb-store {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
          border-bottom: 1px solid #1a1a25;
        }
        
        .cdb-store:last-child {
          border-bottom: none;
        }
        
        .cdb-store-name {
          color: #fff;
          min-width: 70px;
        }
        
        .cdb-store-version {
          font-weight: 600;
        }
        
        .cdb-store-age {
          color: #666;
          font-size: 10px;
        }
        
        .cdb-store-size {
          color: #888;
          font-size: 10px;
          margin-left: auto;
        }
        
        .cdb-log {
          max-height: 150px;
          overflow-y: auto;
          background: #050508;
          border-radius: 4px;
          padding: 6px;
        }
        
        .cdb-log-entry {
          padding: 2px 4px;
          color: #888;
          font-size: 10px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        .cdb-footer {
          padding: 8px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #151520;
        }
        
        .cdb-bypass {
          background: #333;
        }
        
        .cdb-hint {
          color: #666;
          font-size: 9px;
        }
      </style>
      
      <div class="cdb-header">
        <div class="cdb-title">🧹 Cache Debugger</div>
        <div class="cdb-controls">
          <button class="cdb-btn cdb-clear-all">Clear All</button>
          <button class="cdb-btn cdb-bypass">Bypass Cache</button>
          <button class="cdb-btn cdb-close">×</button>
        </div>
      </div>
      
      <div class="cdb-section">
        <div class="cdb-section-title">Cache Stores</div>
        <div class="cdb-stores"></div>
      </div>
      
      <div class="cdb-section">
        <div class="cdb-section-title">Request Log</div>
        <div class="cdb-log"></div>
      </div>
      
      <div class="cdb-footer">
        <span class="cdb-hint">window.__cacheDebug for API</span>
      </div>
    `;
  }

  function showStaleWarning(dataAgeMs, refreshFn) {
    const existing = document.getElementById('cache-stale-warning');
    if (existing) existing.remove();
    
    const banner = document.createElement('div');
    banner.id = 'cache-stale-warning';
    banner.innerHTML = `
      <style>
        #cache-stale-warning {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          background: linear-gradient(90deg, #2a1a00, #3a2a00);
          border-bottom: 1px solid #da0;
          padding: 8px 16px;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 12px;
          z-index: 99998;
          font-family: -apple-system, sans-serif;
          font-size: 13px;
        }
        
        #cache-stale-warning button {
          background: #da0;
          border: none;
          color: #000;
          padding: 4px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 600;
        }
      </style>
      <span>⚠️ Showing cached data from ${ageString(dataAgeMs)} ago</span>
      <button onclick="window.__cacheDebug.refresh(); this.parentElement.remove()">Refresh</button>
      <button onclick="this.parentElement.remove()">Dismiss</button>
    `;
    
    document.body.appendChild(banner);
  }

  document.addEventListener('DOMContentLoaded', function() {
    if (window.XYZO_DEBUG) {
      setTimeout(createPanel, 1000);
    }
  });

  return {
    init,
    log,
    recordHit,
    recordMiss,
    recordPut,
    recordFetch,
    recordClear,
    recordVersion: getVersion,
    getStores,
    getLog,
    clearCache,
    setBypass,
    isBypassed,
    snapshot,
    createPanel,
    removePanel,
    showStaleWarning
  };
})();

window.CacheDebugger = CacheDebugger;
