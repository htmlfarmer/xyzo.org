/**
 * ProtoXYZ - Client Intelligence Prototype
 * Web Worker pool + Cache + Delta Sync orchestration
 */

const ProtoXYZ = (function() {
  let worker = null;
  let messageId = 0;
  let pendingCalls = new Map();
  let stories = [];
  let initialized = false;

  function init() {
    if (initialized) return Promise.resolve();
    
    worker = new Worker('proto/filter-worker.js');
    
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const resolve = pendingCalls.get(id);
      if (resolve) {
        pendingCalls.delete(id);
        if (ok) {
          resolve(result);
        } else {
          reject(new Error(error));
        }
      }
    };
    
    worker.onerror = (e) => {
      console.error('Worker error:', e);
    };

    return Promise.all([
      CacheDB.open(),
      DeltaSync.init()
    ]).then(() => {
      initialized = true;
    });
  }

  function callWorker(action, payload) {
    return new Promise((resolve, reject) => {
      const id = ++messageId;
      pendingCalls.set(id, resolve);
      worker.postMessage({ id, action, payload });
      
      setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          reject(new Error(`Worker call timeout: ${action}`));
        }
      }, 10000);
    });
  }

  async function loadStories(limit = 5000) {
    Timing.mark('fetch:start');
    
    const url = `https://nova.xyzo.org/api/pins/map?bbox=-180,-90,180,90&limit=${limit}`;
    const response = await fetch(url);
    const data = await response.json();
    
    Timing.mark('fetch:end');
    
    stories = data.pins || [];
    await CacheDB.put('stories', stories);
    
    Timing.mark('cache:end');
    Timing.measure('network', 'fetch:start', 'fetch:end');
    Timing.measure('total', 'fetch:start', 'cache:end');
    
    return stories;
  }

  async function filterStories(filters) {
    Timing.mark('filter:start');
    const result = await callWorker('filter', { stories, filters });
    Timing.mark('filter:end');
    Timing.measure('filter', 'filter:start', 'filter:end');
    return result;
  }

  async function sortStories(sortedStories, sortBy, order = 'desc') {
    Timing.mark('sort:start');
    const result = await callWorker('sort', { stories: sortedStories, sortBy, order });
    Timing.mark('sort:end');
    Timing.measure('sort', 'sort:start', 'sort:end');
    return result;
  }

  async function getStats(filteredStories) {
    return callWorker('stats', { stories: filteredStories || stories });
  }

  async function calculateDistances(centerLat, centerLng) {
    return callWorker('distance', { stories, centerLat, centerLng });
  }

  async function aggregate(groupBy) {
    return callWorker('aggregate', { stories, groupBy });
  }

  async function runBenchmark(iterations = 3) {
    const results = [];
    
    for (let i = 0; i < iterations; i++) {
      Timing.clear();
      
      await loadStories(2000);
      const filtered = await filterStories({ minSources: 2 });
      const sorted = await sortStories(filtered, 'recency');
      const stats = await getStats(sorted);
      
      results.push(Timing.toJSON());
    }
    
    return results;
  }

  function getStories() {
    return stories;
  }

  function getStorageInfo() {
    return CacheDB.getStorageEstimate();
  }

  function getSyncStatus() {
    return DeltaSync.getSyncStatus();
  }

  return {
    init,
    loadStories,
    filterStories,
    sortStories,
    getStats,
    calculateDistances,
    aggregate,
    runBenchmark,
    getStories,
    getStorageInfo,
    getSyncStatus,
    CacheDB,
    DeltaSync
  };
})();

// Export
window.ProtoXYZ = ProtoXYZ;
