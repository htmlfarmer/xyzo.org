/**
 * ProtoXYZ - Performance Timing Harness
 * Uses performance.now() for precise measurements
 */

const Timing = (function() {
  const marks = new Map();
  const measures = [];

  function mark(name) {
    marks.set(name, performance.now());
  }

  function measure(name, startMark, endMark) {
    const start = startMark ? marks.get(startMark) : undefined;
    const end = endMark ? marks.get(endMark) : performance.now();
    
    if (start === undefined) {
      console.warn(`Timing.measure: start mark "${startMark}" not found`);
      return null;
    }
    
    const duration = end - start;
    measures.push({ name, start, end, duration, timestamp: Date.now() });
    return duration;
  }

  function getMeasures() {
    return [...measures];
  }

  function clear() {
    marks.clear();
    measures.length = 0;
  }

  function summary() {
    const total = measures.reduce((sum, m) => sum + m.duration, 0);
    const lines = [
      '─'.repeat(60),
      'TIMING SUMMARY',
      '─'.repeat(60),
      ...measures.map(m => `${m.name.padEnd(20)} ${m.duration.toFixed(3).padStart(10)} ms`),
      '─'.repeat(60),
      `${'TOTAL'.padEnd(20)} ${total.toFixed(3).padStart(10)} ms`,
      '─'.repeat(60)
    ];
    return lines.join('\n');
  }

  function toJSON() {
    return {
      marks: Object.fromEntries(marks),
      measures: measures.map(m => ({ name: m.name, duration_ms: parseFloat(m.duration.toFixed(3)) })),
      total_ms: parseFloat(measures.reduce((sum, m) => sum + m.duration, 0).toFixed(3))
    };
  }

  return { mark, measure, getMeasures, clear, summary, toJSON };
})();

// Export for use in other modules
window.Timing = Timing;
