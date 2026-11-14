/**
 * XYZO User Presence Detection
 * 
 * Detects when the user is actively using the computer.
 * When active: throttle workers to keep system responsive.
 * When idle: allow workers to run freely (e.g., user took a walk).
 * 
 * This is the "polite computing" approach — XYZO works hard when
 * you're away, and stays quiet when you're at the keyboard.
 */

(function() {
  'use strict';

  const PRESENCE_KEY = 'xyzo.user_presence';
  const ACTIVE_THRESHOLD = 30 * 1000;  // 30 seconds of no activity = idle
  const CHECK_INTERVAL = 10 * 1000;     // Check every 10 seconds

  let _lastActivity = Date.now();
  let _isActive = true;
  let _checkTimer = null;

  // ── Activity Detection ──────────────────────────────────────────
  // Track mouse, keyboard, scroll, and touch events
  function recordActivity() {
    _lastActivity = Date.now();
    if (!_isActive) {
      _isActive = true;
      notifyPresenceChange(true);
    }
  }

  // Debounced activity recorder (don't flood with events)
  let _activityTimeout = null;
  function debouncedRecordActivity() {
    if (_activityTimeout) return;
    _activityTimeout = setTimeout(() => {
      recordActivity();
      _activityTimeout = null;
    }, 1000);
  }

  // ── Event Listeners ─────────────────────────────────────────────
  // Use passive listeners for performance
  document.addEventListener('mousemove', debouncedRecordActivity, { passive: true });
  document.addEventListener('keydown', recordActivity, { passive: true });
  document.addEventListener('scroll', debouncedRecordActivity, { passive: true });
  document.addEventListener('touchstart', recordActivity, { passive: true });
  document.addEventListener('click', recordActivity, { passive: true });

  // ── Idle Detection ──────────────────────────────────────────────
  function checkPresence() {
    const now = Date.now();
    const idleTime = now - _lastActivity;
    
    if (_isActive && idleTime > ACTIVE_THRESHOLD) {
      _isActive = false;
      notifyPresenceChange(false);
    }
  }

  // ── Notify API of Presence Change ───────────────────────────────
  // This tells the server whether to throttle workers
  function notifyPresenceChange(isActive) {
    try {
      // Store locally for quick access
      localStorage.setItem(PRESENCE_KEY, JSON.stringify({
        active: isActive,
        timestamp: Date.now()
      }));

      // Notify server (fire-and-forget, non-blocking)
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/analytics/presence', JSON.stringify({
          active: isActive,
          timestamp: Date.now()
        }));
      }
    } catch (e) {
      // Non-critical: don't break the app
    }
  }

  // ── Start Monitoring ────────────────────────────────────────────
  _checkTimer = setInterval(checkPresence, CHECK_INTERVAL);

  // ── Public API ──────────────────────────────────────────────────
  window.XyzoPresence = {
    isActive: () => _isActive,
    getLastActivity: () => _lastActivity,
    getIdleSeconds: () => Math.floor((Date.now() - _lastActivity) / 1000),
    
    // Force presence check (for testing)
    check: checkPresence,
    
    // Stop monitoring (for cleanup)
    stop: () => {
      if (_checkTimer) clearInterval(_checkTimer);
      document.removeEventListener('mousemove', debouncedRecordActivity);
      document.removeEventListener('keydown', recordActivity);
      document.removeEventListener('scroll', debouncedRecordActivity);
      document.removeEventListener('touchstart', recordActivity);
      document.removeEventListener('click', recordActivity);
    }
  };

  // Record initial activity
  recordActivity();
})();
