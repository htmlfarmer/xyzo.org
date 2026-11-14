/**
 * Xyzo Flag Quality chunk (lazy-loaded).
 *
 * Contains:
 *   - Quick Flag dialog (top-bar Flag button → user pastes a URL/id,
 *     we resolve to a pin via /api/analytics/quick-flag/lookup, then
 *     submit a flag with a reason).
 *   - Report Story Quality dialog (per-pin "Report" button → POSTs to
 *     /api/analytics/report-quality).
 *
 * Loaded on demand by app.js when:
 *   - the user clicks the top-bar Flag button, OR
 *   - the user clicks the per-pin "Report" button in a pin popup.
 *
 * Self-contained: references window.escapeHtml, window.escapeAttr,
 * window.closeActivePopup, window.XLog, window.XyzoAnalytics, and the
 * Leaflet `map` instance, all of which are guaranteed to be defined by
 * the time the user clicks the trigger (app.js has finished executing).
 *
 * Exposes:
 *   window.XyzoFlagQuality.showQuickFlagDialog(prefill?)
 *   window.XyzoFlagQuality.showReportDialog(pin)
 *   window.XyzoFlagQuality.closeQuickFlagDialog()
 *   window.XyzoFlagQuality.closeReportDialog()
 */

(function () {
  'use strict';

  // ── Quick Flag ────────────────────────────────────────────────────
  //
  // Top-bar Flag button → modal that lets users report any pin/article
  // without having to find it on the map. The user pastes one of:
  //   - a numeric pin/article ID                  ("12345")
  //   - a xyzo.org URL containing a pin param ("https://xyzo.org/?pin=12345")
  //   - the source article's URL                  (matched against news_articles.url)
  //   - any shortener that wraps that URL         (rnkd.org, bit.ly, …)
  //
  // We hit /api/analytics/quick-flag which resolves the input to a
  // news_articles row and submits the report in one shot. The dialog stays
  // open with a success message (and a link to the flagged article) so the
  // user has feedback that something happened.
  //
  // `prefill` lets callers seed the input — e.g. when the user pastes a
  // URL via the share button, the Flag dialog can pick it up.
  let _quickFlagDialog = null;
  let _quickFlagResolveAbort = null;

  const QUICK_FLAG_REASONS = [
    { value: "wrong_location", label: "📍 Wrong location" },
    { value: "misleading",      label: "⚠ Misleading" },
    { value: "false_info",      label: "❌ False info" },
    { value: "spam",            label: "🚫 Spam / promo" },
    { value: "outdated",        label: "⏰ Outdated" },
    { value: "duplicate",       label: "📑 Duplicate" },
    { value: "paywall",         label: "🔒 Paywall" },
    { value: "offensive",       label: "🤬 Offensive" },
    { value: "low_quality",     label: "📉 Low quality" },
    { value: "other",           label: "❓ Other" },
  ];

  function showQuickFlagDialog(prefill) {
    if (_quickFlagDialog) closeQuickFlagDialog();

    const overlay = document.createElement("div");
    overlay.className = "quick-flag-overlay";
    overlay.innerHTML = `
      <div class="quick-flag-dialog" role="dialog" aria-labelledby="quick-flag-title">
        <div class="quick-flag-header">
          <strong id="quick-flag-title">🚩 Quick flag</strong>
          <button type="button" class="quick-flag-close" aria-label="Close">×</button>
        </div>
        <div class="quick-flag-body">
          <div class="quick-flag-intro">
            <strong>Step 1:</strong> Paste a pin/article ID, URL, or source link below. We'll look it up.<br>
            <strong>Step 2:</strong> Select a flag reason, then submit.
          </div>
          <div class="quick-flag-input-row">
            <input type="text" class="quick-flag-input"
                   placeholder="URL or pin ID (e.g. 12345 or https://…)"
                   maxlength="2000" autocomplete="off" />
            <button type="button" class="quick-flag-resolve">Find</button>
          </div>
          <div class="quick-flag-resolved" hidden></div>
          <div class="quick-flag-options">
            ${QUICK_FLAG_REASONS.map(r => `
              <label class="quick-flag-option" data-value="${r.value}">
                <input type="radio" name="quick-flag-type" value="${r.value}">
                <span>${escapeHtml(r.label)}</span>
              </label>
            `).join("")}
          </div>
          <textarea class="quick-flag-reason"
                    placeholder="Optional: describe the problem or area issue…"
                    maxlength="500" rows="2"></textarea>
          <div class="quick-flag-ai-toggle">
            <label class="quick-flag-ai-option">
              <input type="checkbox" class="quick-flag-ai-check" checked>
              <span>🤖 Analyze with AI and auto-fix if possible</span>
            </label>
          </div>
        </div>
        <div class="quick-flag-actions">
          <button type="button" class="quick-flag-cancel">Cancel</button>
          <button type="button" class="quick-flag-submit primary" disabled>Submit flag</button>
        </div>
        <div class="quick-flag-result" hidden></div>
        <div class="quick-flag-ai-result" hidden></div>
      </div>
    `;
    document.body.appendChild(overlay);
    _quickFlagDialog = overlay;

    const input = overlay.querySelector(".quick-flag-input");
    const resolveBtn = overlay.querySelector(".quick-flag-resolve");
    const resolved = overlay.querySelector(".quick-flag-resolved");
    const cancelBtn = overlay.querySelector(".quick-flag-cancel");
    const closeBtn = overlay.querySelector(".quick-flag-close");
    const submitBtn = overlay.querySelector(".quick-flag-submit");
    const reasonEl = overlay.querySelector(".quick-flag-reason");
    const resultEl = overlay.querySelector(".quick-flag-result");
    const aiResultEl = overlay.querySelector(".quick-flag-ai-result");
    const aiCheckEl = overlay.querySelector(".quick-flag-ai-check");
    const options = overlay.querySelectorAll(".quick-flag-option");

    let resolvedArticle = null; // {id, title, url}

    function setResolved(article) {
      resolvedArticle = article;
      if (article) {
        resolved.classList.remove("error");
        resolved.innerHTML = `
          <span class="quick-flag-resolved-icon">✓</span>
          <div class="quick-flag-resolved-text">
            <div class="quick-flag-resolved-title">${escapeHtml(article.title || "(untitled)")}</div>
            <div class="quick-flag-resolved-meta">
              Pin #${article.id}${article.url ? ` • ${escapeHtml(article.url)}` : ""}
            </div>
          </div>
        `;
        resolved.hidden = false;
      } else {
        resolvedArticle = null;
        resolved.hidden = true;
      }
      updateSubmitEnabled();
    }

    function setResolvedError(msg) {
      resolvedArticle = null;
      resolved.classList.add("error");
      resolved.innerHTML = `
        <span class="quick-flag-resolved-icon">⚠</span>
        <div class="quick-flag-resolved-text">
          <div class="quick-flag-resolved-title" style="color:#f87171;">${escapeHtml(msg)}</div>
          <div class="quick-flag-resolved-meta">Try a different URL, or paste just the pin ID.</div>
        </div>
      `;
      resolved.hidden = false;
      updateSubmitEnabled();
    }

    function updateSubmitEnabled() {
      const selected = overlay.querySelector('input[name="quick-flag-type"]:checked');
      submitBtn.disabled = !resolvedArticle || !selected;
    }

    // Highlight the chosen option card.
    options.forEach(opt => {
      opt.addEventListener("change", () => {
        options.forEach(o => o.classList.toggle("selected", o === opt));
        updateSubmitEnabled();
      });
    });

    // Click anywhere on the option card to select it (better UX than
    // having to hit the small radio dot).
    options.forEach(opt => {
      opt.addEventListener("click", (e) => {
        if (e.target.tagName !== "INPUT") {
          const radio = opt.querySelector('input[type="radio"]');
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    });

    // ── Resolve the input to a pin ─────────────────────────────────
    // Pure lookup endpoint — returns the resolved article's id/title/url
    // without inserting a report, so the user can confirm before
    // committing. If the lookup fails, we surface the backend's error
    // message verbatim.
    async function probe() {
      const v = input.value.trim();
      if (!v) {
        setResolvedError("Paste a URL or pin ID first.");
        return;
      }
      if (_quickFlagResolveAbort) _quickFlagResolveAbort.abort();
      _quickFlagResolveAbort = new AbortController();
      resolveBtn.disabled = true;
      resolveBtn.textContent = "Looking up…";
      try {
        const res = await fetch("/api/analytics/quick-flag/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: v }),
          signal: _quickFlagResolveAbort.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setResolvedError("You're doing that too fast — try again in a minute.");
          return;
        }
        if (res.ok && data.ok && data.article_id) {
          setResolved({
            id: data.article_id,
            title: data.article_title || "",
            url: data.article_url || "",
          });
        } else {
          setResolvedError(data.message || data.error || "Couldn't find that pin.");
        }
      } catch (e) {
        if (e.name !== "AbortError") setResolvedError("Lookup failed — check your connection.");
      } finally {
        resolveBtn.disabled = false;
        resolveBtn.textContent = "Find";
        // Drop the controller reference once the call settles. Without this,
        // the most recent AbortController lingers in module scope until the
        // next probe — small but pure overhead, and on a busy dashboard
        // session the controllers accumulate visibly.
        _quickFlagResolveAbort = null;
      }
    }

    resolveBtn.addEventListener("click", probe);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); probe(); }
    });

    // Auto-resolve when the user pastes (clipboard paste fires `input`
    // events; we debounce so we don't hammer the API while they paste).
    let pasteTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        const v = input.value.trim();
        // Only auto-probe when the input looks complete (URL or numeric).
        if (/^\d{4,}$/.test(v) || /^https?:\/\//i.test(v) || v.includes("/")) probe();
      }, 400);
    });

    // ── Submit the actual flag ─────────────────────────────────────
    submitBtn.addEventListener("click", async () => {
      if (!resolvedArticle) return;
      const selected = overlay.querySelector('input[name="quick-flag-type"]:checked');
      if (!selected) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      try {
        const sessionId = typeof XyzoAnalytics !== 'undefined'
          ? XyzoAnalytics.sessionId
          : `anon_${crypto.randomUUID()}`;
        const res = await fetch("/api/analytics/quick-flag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: input.value.trim(),
            report_type: selected.value,
            reason: reasonEl.value.trim() || undefined,
            session_id: sessionId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          resultEl.className = "quick-flag-result success";
          const link = data.article_url
            ? ` <a href="${escapeAttr(data.article_url)}" target="_blank" rel="noopener noreferrer">open source</a>`
            : "";
          resultEl.innerHTML = `
            <strong>✓ Flag submitted</strong>
            <div style="margin-top:4px;">
              Pin <strong>#${data.article_id}</strong> — ${escapeHtml(data.article_title || "")}${link}
            </div>
            <div style="margin-top:4px;font-size:10px;color:var(--muted);">
              Report count: ${data.report_count} • Quality: ${Math.round((data.quality_score || 1) * 100)}%
              ${data.hidden ? " • Story auto-hidden (5+ reports)." : ""}
            </div>
          `;
          resultEl.hidden = false;
          // Lock the form so the user doesn't double-submit.
          overlay.querySelector(".quick-flag-body").style.opacity = "0.6";
          overlay.querySelector(".quick-flag-body").style.pointerEvents = "none";
          cancelBtn.textContent = "Done";

          // ── AI Analysis (runs after flag submission) ───────────────────
          if (aiCheckEl?.checked) {
            try {
              const mapCenter = map.getCenter();
              const mapZoom = map.getZoom();
              const aiPayload = {
                report_type: selected.value,
                user_reason: reasonEl.value.trim() || undefined,
                session_id: sessionId,
                article_id: resolvedArticle?.id || undefined,
                article_title: resolvedArticle?.title || undefined,
                article_url: resolvedArticle?.url || undefined,
                viewport_lat: mapCenter.lat,
                viewport_lng: mapCenter.lng,
                viewport_zoom: Math.round(mapZoom),
              };
              const aiRes = await fetch("/api/ai/quick-flag", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(aiPayload),
              });
              const aiData = await aiRes.json().catch(() => ({}));
              if (aiRes.ok && aiData.ok) {
                let aiHtml = `<div class="quick-flag-ai-header">🤖 AI Analysis</div>`;
                if (aiData.action === "auto_fixed") {
                  aiHtml += `<div class="quick-flag-ai-action" style="color:#22c55e;">✓ Auto-fixed: ${escapeHtml(aiData.message || "Issue resolved")}</div>`;
                } else if (aiData.action === "needs_review") {
                  aiHtml += `<div class="quick-flag-ai-action" style="color:#f59e0b;">⚠ ${escapeHtml(aiData.message || "Flagged for review")}</div>`;
                } else {
                  aiHtml += `<div class="quick-flag-ai-action">${escapeHtml(aiData.message || "Analyzed")}</div>`;
                }
                aiResultEl.innerHTML = aiHtml;
                aiResultEl.hidden = false;
              }
            } catch (e) {
              // AI analysis failed silently - flag was still submitted
              XLog.warn("AI analysis failed:", e);
            }
          }
        } else if (res.status === 409) {
          resultEl.className = "quick-flag-result error";
          resultEl.innerHTML = `<strong>Already reported</strong><div style="margin-top:4px;">${escapeHtml(data.message || "")}</div>`;
          resultEl.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit flag";
        } else if (res.status === 429) {
          resultEl.className = "quick-flag-result error";
          resultEl.innerHTML = `<strong>Rate limited</strong><div style="margin-top:4px;">${escapeHtml(data.message || "Try again in a few minutes.")}</div>`;
          resultEl.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit flag";
        } else if (res.status === 404) {
          // Pin was resolvable at probe-time but isn't now (rare race) —
          // re-enable so they can re-resolve.
          setResolvedError(data.message || "Couldn't find that pin.");
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit flag";
        } else {
          resultEl.className = "quick-flag-result error";
          resultEl.innerHTML = `<strong>Submission failed</strong><div style="margin-top:4px;">${escapeHtml(data.message || data.error || "Unknown error")}</div>`;
          resultEl.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit flag";
        }
      } catch (e) {
        resultEl.className = "quick-flag-result error";
        resultEl.innerHTML = `<strong>Network error</strong><div style="margin-top:4px;">${escapeHtml(e.message)}</div>`;
        resultEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit flag";
      }
    });

    cancelBtn.addEventListener("click", closeQuickFlagDialog);
    closeBtn.addEventListener("click", closeQuickFlagDialog);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeQuickFlagDialog();
    });

    // Escape closes; ⌘/Ctrl+Enter submits once both fields are filled.
    const keyHandler = (e) => {
      if (!_quickFlagDialog) return;
      if (e.key === "Escape") { e.preventDefault(); closeQuickFlagDialog(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !submitBtn.disabled) {
        e.preventDefault(); submitBtn.click();
      }
    };
    document.addEventListener("keydown", keyHandler);
    overlay._keyHandler = keyHandler;

    // Prefill if a caller passed a URL (e.g. from the share menu) and
    // auto-resolve so the user just sees the resolved title.
    if (prefill) {
      input.value = String(prefill);
      setTimeout(probe, 50);
    } else {
      setTimeout(() => input.focus(), 50);
    }
  }

  function closeQuickFlagDialog() {
    if (!_quickFlagDialog) return;
    if (_quickFlagResolveAbort) _quickFlagResolveAbort.abort();
    const kh = _quickFlagDialog._keyHandler;
    if (kh) document.removeEventListener("keydown", kh);
    _quickFlagDialog.remove();
    _quickFlagDialog = null;
  }

  // ── Report Story Quality ───────────────────────────────────────
  let _reportDialog = null;

  function showReportDialog(pin) {
    if (_reportDialog) closeReportDialog();
    if (typeof window.closeActivePopup === "function") {
      window.closeActivePopup();
    }

    const dialog = document.createElement("div");
    dialog.className = "report-dialog";
    dialog.innerHTML = `
      <div class="report-dialog-content">
        <div class="report-dialog-header">
          <strong>⚠️ Report Story</strong>
          <button class="report-dialog-close">×</button>
        </div>
        <div class="report-dialog-title">${escapeHtml(pin.title.slice(0, 80))}${pin.title.length > 80 ? "…" : ""}</div>
        <div class="report-dialog-options">
          <label class="report-option">
            <input type="radio" name="report-type" value="misleading">
            <span>Misleading title or content</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="false_info">
            <span>False or inaccurate information</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="spam">
            <span>Spam or promotional content</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="outdated">
            <span>Outdated or no longer relevant</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="low_quality">
            <span>Low quality journalism</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="offensive">
            <span>Offensive or inappropriate</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="duplicate">
            <span>Duplicate of another story</span>
          </label>
          <label class="report-option report-option-access">
            <input type="radio" name="report-type" value="paywall">
            <span>🔒 Paywall — full article requires subscription</span>
          </label>
          <label class="report-option report-option-access">
            <input type="radio" name="report-type" value="login_required">
            <span>🔑 Login required — can't read without an account</span>
          </label>
          <label class="report-option">
            <input type="radio" name="report-type" value="other">
            <span>Other issue</span>
          </label>
        </div>
        <textarea class="report-reason" placeholder="Optional: explain the issue…" maxlength="500" rows="2"></textarea>
        <div class="report-dialog-actions">
          <button class="report-cancel">Cancel</button>
          <button class="report-submit" disabled>Submit Report</button>
        </div>
        <div class="report-result" hidden></div>
      </div>
    `;

    document.body.appendChild(dialog);
    _reportDialog = dialog;

    // Wire up events
    const closeBtn = dialog.querySelector(".report-dialog-close");
    const cancelBtn = dialog.querySelector(".report-cancel");
    const submitBtn = dialog.querySelector(".report-submit");
    const reasonEl = dialog.querySelector(".report-reason");
    const resultEl = dialog.querySelector(".report-result");
    const options = dialog.querySelectorAll('input[name="report-type"]');

    function updateSubmitEnabled() {
      const selected = dialog.querySelector('input[name="report-type"]:checked');
      submitBtn.disabled = !selected;
    }

    options.forEach(opt => {
      opt.addEventListener("change", updateSubmitEnabled);
    });

    closeBtn.addEventListener("click", closeReportDialog);
    cancelBtn.addEventListener("click", closeReportDialog);

    submitBtn.addEventListener("click", async () => {
      const selected = dialog.querySelector('input[name="report-type"]:checked');
      if (!selected) return;

      const reportType = selected.value;
      const reason = reasonEl.value.trim();

      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";

      try {
        const sessionId = typeof XyzoAnalytics !== 'undefined'
          ? XyzoAnalytics.sessionId
          : 'anon_' + crypto.randomUUID();

        const res = await fetch("/api/analytics/quick-flag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: String(pin.id),
            session_id: sessionId,
            report_type: reportType,
            reason: reason || undefined,
          }),
        });

        const data = await res.json();

        if (res.ok) {
          resultEl.innerHTML = `
            <div style="color: #22c55e; margin-bottom: 4px;">
              <strong>✓ Report submitted</strong>
            </div>
            <div style="font-size: 11px; color: var(--muted);">
              ${data.hidden
                ? "This story has been hidden due to multiple reports."
                : `Report #${data.report_count} for this story. Quality score: ${Math.round(data.quality_score * 100)}%`
              }
            </div>
          `;
          resultEl.hidden = false;
          dialog.querySelector(".report-dialog-options").hidden = true;
          reasonEl.hidden = true;
          dialog.querySelector(".report-dialog-actions").hidden = true;
          setTimeout(closeReportDialog, 3000);
        } else if (res.status === 409) {
          resultEl.innerHTML = `<div style="color: #f59e0b;">You've already reported this story for this reason.</div>`;
          resultEl.hidden = false;
          submitBtn.textContent = "Submit Report";
          submitBtn.disabled = false;
        } else if (res.status === 429) {
          resultEl.innerHTML = `<div style="color: #ef4444;">Rate limited — try again later.</div>`;
          resultEl.hidden = false;
          submitBtn.textContent = "Submit Report";
          submitBtn.disabled = false;
        } else {
          resultEl.innerHTML = `<div style="color: #ef4444;">Error: ${data.error || "Unknown"}</div>`;
          resultEl.hidden = false;
          submitBtn.textContent = "Submit Report";
          submitBtn.disabled = false;
        }
      } catch (e) {
        resultEl.innerHTML = `<div style="color: #ef4444;">Network error — try again.</div>`;
        resultEl.hidden = false;
        submitBtn.textContent = "Submit Report";
        submitBtn.disabled = false;
      }
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === "Escape") closeReportDialog();
    };
    document.addEventListener("keydown", onKey);
    dialog._onKey = onKey;
  }

  function closeReportDialog() {
    if (!_reportDialog) return;
    if (_reportDialog._onKey) {
      document.removeEventListener("keydown", _reportDialog._onKey);
    }
    if (_reportDialog.parentNode) {
      _reportDialog.parentNode.removeChild(_reportDialog);
    }
    _reportDialog = null;
  }

  // ── Public API ────────────────────────────────────────────────────
  window.XyzoFlagQuality = {
    showQuickFlagDialog,
    closeQuickFlagDialog,
    showReportDialog,
    closeReportDialog,
  };
})();
