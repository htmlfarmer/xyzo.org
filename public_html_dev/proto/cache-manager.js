/**
 * ProtoXYZ - IndexedDB Cache Manager
 * Stores stories, events, and metadata locally
 */

const CacheDB = (function() {
  const DB_NAME = 'protoxyzo';
  const DB_VERSION = 1;
  const STORES = {
    stories: 'id',
    events: 'id',
    metadata: 'key',
    deltas: 'since'
  };

  let db = null;

  async function open() {
    if (db) return db;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };
      
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        
        if (!database.objectStoreNames.contains('stories')) {
          database.createObjectStore('stories', { keyPath: 'id' });
        }
        
        if (!database.objectStoreNames.contains('events')) {
          database.createObjectStore('events', { keyPath: 'id' });
        }
        
        if (!database.objectStoreNames.contains('metadata')) {
          database.createObjectStore('metadata', { keyPath: 'key' });
        }
        
        if (!database.objectStoreNames.contains('deltas')) {
          database.createObjectStore('deltas', { keyPath: 'since' });
        }
      };
    });
  }

  async function put(storeName, data) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      
      if (Array.isArray(data)) {
        for (const item of data) {
          store.put(item);
        }
      } else {
        store.put(data);
      }
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function get(storeName, key) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAll(storeName) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllKeys(storeName) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAllKeys();
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function remove(storeName, key) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(key);
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clear(storeName) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function count(storeName) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.count();
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function setMeta(key, value) {
    return put('metadata', { key, value, updatedAt: Date.now() });
  }

  async function getMeta(key) {
    const record = await get('metadata', key);
    return record?.value;
  }

  async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage,
        quota: estimate.quota,
        percentUsed: ((estimate.usage / estimate.quota) * 100).toFixed(2)
      };
    }
    return null;
  }

  async function close() {
    if (db) {
      db.close();
      db = null;
    }
  }

  return {
    open,
    put,
    get,
    getAll,
    getAllKeys,
    remove,
    clear,
    count,
    setMeta,
    getMeta,
    getStorageEstimate,
    close,
    STORES
  };
})();

// Export
window.CacheDB = CacheDB;
