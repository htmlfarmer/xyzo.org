/**
 * ProtoXYZ - Delta Sync Module
 * Tracks changes and fetches only what changed
 */

const DeltaSync = (function() {
  const CACHE_KEY_LAST_SYNC = 'last_sync';
  const CACHE_KEY_DATA_VERSION = 'data_version';

  let lastSyncTime = null;
  let dataVersion = 0;

  async function init() {
    lastSyncTime = await CacheDB.getMeta(CACHE_KEY_LAST_SYNC);
    dataVersion = await CacheDB.getMeta(CACHE_KEY_DATA_VERSION) || 0;
    return { lastSyncTime, dataVersion };
  }

  function getLastSync() {
    return lastSyncTime;
  }

  function getDataVersion() {
    return dataVersion;
  }

  async function updateLastSync() {
    lastSyncTime = new Date().toISOString();
    await CacheDB.setMeta(CACHE_KEY_LAST_SYNC, lastSyncTime);
  }

  async function incrementVersion() {
    dataVersion++;
    await CacheDB.setMeta(CACHE_KEY_DATA_VERSION, dataVersion);
    return dataVersion;
  }

  function buildDeltaUrl(baseUrl) {
    const url = new URL(baseUrl, window.location.origin);
    if (lastSyncTime) {
      url.searchParams.set('since', lastSyncTime);
    }
    url.searchParams.set('version', dataVersion);
    return url.toString();
  }

  function diffStories(localStories, remoteStories) {
    const localMap = new Map(localStories.map(s => [s.id, s]));
    const remoteMap = new Map(remoteStories.map(s => [s.id, s]));

    const added = remoteStories.filter(s => !localMap.has(s.id));
    const removed = localStories.filter(s => !remoteMap.has(s.id));
    const updated = remoteStories.filter(s => {
      const local = localMap.get(s.id);
      if (!local) return false;
      return new Date(s.updated_at) > new Date(local.updated_at);
    });

    return { added, removed, updated };
  }

  async function applyDelta(delta) {
    if (delta.added?.length) {
      await CacheDB.put('stories', delta.added);
    }
    
    if (delta.updated?.length) {
      for (const story of delta.updated) {
        await CacheDB.put('stories', story);
      }
    }
    
    if (delta.removed?.length) {
      for (const story of delta.removed) {
        await CacheDB.remove('stories', story.id);
      }
    }
    
    await updateLastSync();
    await incrementVersion();
    
    return {
      added: delta.added?.length || 0,
      updated: delta.updated?.length || 0,
      removed: delta.removed?.length || 0
    };
  }

  async function fullSync(stories) {
    await CacheDB.clear('stories');
    await CacheDB.put('stories', stories);
    await updateLastSync();
    await incrementVersion();
    return { count: stories.length };
  }

  function getSyncStatus() {
    return {
      lastSyncTime,
      dataVersion,
      needsSync: !lastSyncTime,
      syncAge: lastSyncTime ? 
        Date.now() - new Date(lastSyncTime).getTime() : null
    };
  }

  return {
    init,
    getLastSync,
    getDataVersion,
    updateLastSync,
    incrementVersion,
    buildDeltaUrl,
    diffStories,
    applyDelta,
    fullSync,
    getSyncStatus
  };
})();

// Export
window.DeltaSync = DeltaSync;
