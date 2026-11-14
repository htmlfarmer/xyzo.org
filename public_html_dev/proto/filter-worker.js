/**
 * ProtoXYZ - Filter/Sort Web Worker
 * Handles filtering, sorting, and statistics off the main thread
 */

self.onmessage = function(e) {
  const { id, action, payload } = e.data;
  
  let result;
  
  try {
    switch (action) {
      case 'filter':
        result = handleFilter(payload);
        break;
      case 'sort':
        result = handleSort(payload);
        break;
      case 'stats':
        result = handleStats(payload);
        break;
      case 'distance':
        result = handleDistance(payload);
        break;
      case 'aggregate':
        result = handleAggregate(payload);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};

function handleFilter({ stories, filters }) {
  return stories.filter(story => {
    if (filters.category && story.category !== filters.category) return false;
    if (filters.country && story.country !== filters.country) return false;
    if (filters.minSources && (story.source_count || 0) < filters.minSources) return false;
    if (filters.maxSources && (story.source_count || 0) > filters.maxSources) return false;
    if (filters.minNovelty && (story.novelty || 0) < filters.minNovelty) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const text = `${story.title} ${story.place_name || ''}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    if (filters.bbox) {
      const { minLat, maxLat, minLng, maxLng } = filters.bbox;
      const lat = story.lat || story.location?.lat;
      const lng = story.lng || story.location?.lng;
      if (lat === undefined || lng === undefined) return false;
      if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) return false;
    }
    return true;
  });
}

function handleSort({ stories, sortBy, order = 'desc' }) {
  const sorted = [...stories];
  
  sorted.sort((a, b) => {
    let aVal, bVal;
    
    switch (sortBy) {
      case 'recency':
        aVal = new Date(a.published_at || 0).getTime();
        bVal = new Date(b.published_at || 0).getTime();
        break;
      case 'source_count':
        aVal = a.source_count || 0;
        bVal = b.source_count || 0;
        break;
      case 'novelty':
        aVal = a.novelty || 0;
        bVal = b.novelty || 0;
        break;
      case 'distance':
        aVal = a._distance || 0;
        bVal = b._distance || 0;
        break;
      case 'confidence':
        aVal = a.confidence_score || 0;
        bVal = b.confidence_score || 0;
        break;
      default:
        aVal = new Date(a.published_at || 0).getTime();
        bVal = new Date(b.published_at || 0).getTime();
    }
    
    return order === 'desc' ? bVal - aVal : aVal - bVal;
  });
  
  return sorted;
}

function handleStats({ stories }) {
  if (!stories.length) {
    return { count: 0 };
  }
  
  const sourceCounts = stories.map(s => s.source_count || 0);
  const novelties = stories.map(s => s.novelty || 0);
  const confidences = stories.map(s => s.confidence_score || 0);
  
  return {
    count: stories.length,
    sourceStats: {
      min: Math.min(...sourceCounts),
      max: Math.max(...sourceCounts),
      avg: sourceCounts.reduce((a, b) => a + b, 0) / sourceCounts.length
    },
    noveltyStats: {
      min: Math.min(...novelties),
      max: Math.max(...novelties),
      avg: novelties.reduce((a, b) => a + b, 0) / novelties.length
    },
    confidenceStats: {
      min: Math.min(...confidences),
      max: Math.max(...confidences),
      avg: confidences.reduce((a, b) => a + b, 0) / confidences.length
    }
  };
}

function handleDistance({ stories, centerLat, centerLng }) {
  const toRad = deg => deg * Math.PI / 180;
  const R = 6371; // Earth radius in km
  
  return stories.map(story => {
    const lat = story.lat || story.location?.lat;
    const lng = story.lng || story.location?.lng;
    
    if (lat === undefined || lng === undefined) {
      story._distance = Infinity;
      return story;
    }
    
    const dLat = toRad(lat - centerLat);
    const dLng = toRad(lng - centerLng);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(centerLat)) * Math.cos(toRad(lat)) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    story._distance = R * c;
    
    return story;
  });
}

function handleAggregate({ stories, groupBy }) {
  const groups = new Map();
  
  for (const story of stories) {
    let key;
    switch (groupBy) {
      case 'category':
        key = story.category || 'unknown';
        break;
      case 'country':
        key = story.country || story.location?.country || 'unknown';
        break;
      case 'day':
        key = (story.published_at || '').split('T')[0];
        break;
      case 'source_count_bin':
        const sc = story.source_count || 0;
        if (sc <= 1) key = '1';
        else if (sc <= 5) key = '2-5';
        else if (sc <= 10) key = '6-10';
        else if (sc <= 50) key = '11-50';
        else key = '51+';
        break;
      default:
        key = 'all';
    }
    
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(story);
  }
  
  const result = {};
  for (const [key, items] of groups) {
    result[key] = {
      count: items.length,
      avgNovelty: items.reduce((s, i) => s + (i.novelty || 0), 0) / items.length,
      avgConfidence: items.reduce((s, i) => s + (i.confidence_score || 0), 0) / items.length
    };
  }
  
  return result;
}
