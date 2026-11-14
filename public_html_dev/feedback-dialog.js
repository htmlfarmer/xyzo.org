// ── Combined Feedback Dialog ──────────────────────────────────────────
// Single dialog for reporting issues and fixing locations.
// Replaces the separate "Report" and "Fix" buttons.
let _feedbackDialog = null;
let _feedbackMapClick = null;

function showFeedbackDialog(pin) {
  if (_feedbackDialog) closeFeedbackDialog();
  map.closePopup();

  const dialog = document.createElement("div");
  dialog.className = "feedback-dialog";
  dialog.innerHTML = `
    <div class="feedback-dialog-content">
      <div class="feedback-dialog-header">
        <strong>💬 Feedback</strong>
        <button class="feedback-dialog-close">×</button>
      </div>
      <div class="feedback-dialog-title">${escapeHtml(pin.title.slice(0, 100))}${pin.title.length > 100 ? "…" : ""}</div>

      <div class="feedback-tabs">
        <button class="feedback-tab active" data-tab="report">Report Issue</button>
        <button class="feedback-tab" data-tab="fix">Fix Location</button>
      </div>

      <!-- Report tab -->
      <div class="feedback-tab-content" id="feedback-tab-report">
        <div class="feedback-options">
          <label class="feedback-option"><input type="radio" name="feedback-type" value="misleading"><span>Misleading title or content</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="false_info"><span>False or inaccurate information</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="wrong_location"><span>Wrong location on map</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="spam"><span>Spam or promotional content</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="outdated"><span>Outdated or no longer relevant</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="duplicate"><span>Duplicate of another story</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="paywall"><span>🔒 Paywall — requires subscription</span></label>
          <label class="feedback-option"><input type="radio" name="feedback-type" value="other"><span>Other issue</span></label>
        </div>
        <textarea class="feedback-reason" placeholder="Optional: explain the issue…" maxlength="500" rows="2"></textarea>
      </div>

      <!-- Fix Location tab -->
      <div class="feedback-tab-content" id="feedback-tab-fix" hidden>
        <div class="feedback-fix-intro">
          <p>Is this story pinned in the wrong place? Tell us where it should be.</p>
        </div>
        <div class="feedback-fix-search">
          <input type="text" class="feedback-place-input" placeholder="Type a city or place name…" maxlength="200" autocomplete="off">
          <div class="feedback-place-results" hidden></div>
        </div>
        <div class="feedback-fix-coords">
          <span class="feedback-fix-hint">Or click the map to set the correct location</span>
          <div class="feedback-fix-latlng" hidden>
            📍 <span class="feedback-fix-coord-text"></span>
            <button class="feedback-fix-clear-coord" title="Clear">×</button>
          </div>
        </div>
        <textarea class="feedback-fix-reason" placeholder="Optional: describe what's wrong with the current location…" maxlength="500" rows="2"></textarea>
      </div>

      <div class="feedback-dialog-actions">
        <button class="feedback-cancel">Cancel</button>
        <button class="feedback-submit" disabled>Submit</button>
      </div>
      <div class="feedback-result" hidden></div>
    </div>
  `;

  document.body.appendChild(dialog);
  _feedbackDialog = dialog;

  // Wire up tabs
  const tabs = dialog.querySelectorAll(".feedback-tab");
  const tabContents = dialog.querySelectorAll(".feedback-tab-content");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      tabContents.forEach(tc => tc.hidden = true);
      const target = dialog.querySelector(`#feedback-tab-${tab.dataset.tab}`);
      if (target) target.hidden = false;
      updateSubmitEnabled();
    });
  });

  // Wire up events
  const closeBtn = dialog.querySelector(".feedback-dialog-close");
  const cancelBtn = dialog.querySelector(".feedback-cancel");
  const submitBtn = dialog.querySelector(".feedback-submit");
  const reasonEl = dialog.querySelector(".feedback-reason");
  const fixReasonEl = dialog.querySelector(".feedback-fix-reason");
  const resultEl = dialog.querySelector(".feedback-result");
  const options = dialog.querySelectorAll('input[name="feedback-type"]');
  const placeInput = dialog.querySelector(".feedback-place-input");
  const placeResults = dialog.querySelector(".feedback-place-results");
  const latlngDiv = dialog.querySelector(".feedback-fix-latlng");
  const coordText = dialog.querySelector(".feedback-fix-coord-text");
  const clearCoordBtn = dialog.querySelector(".feedback-fix-clear-coord");

  let selectedLat = null;
  let selectedLng = null;
  let activeTab = "report";

  function updateSubmitEnabled() {
    const activeTabBtn = dialog.querySelector(".feedback-tab.active");
    activeTab = activeTabBtn?.dataset.tab || "report";
    if (activeTab === "report") {
      const selected = dialog.querySelector('input[name="feedback-type"]:checked');
      submitBtn.disabled = !selected;
    } else {
      // Fix tab: enabled if we have coords or a place name
      submitBtn.disabled = selectedLat === null && !placeInput.value.trim();
    }
  }

  options.forEach(opt => opt.addEventListener("change", updateSubmitEnabled));
  placeInput.addEventListener("input", updateSubmitEnabled);

  closeBtn.addEventListener("click", closeFeedbackDialog);
  cancelBtn.addEventListener("click", closeFeedbackDialog);

  // Place search with debounce
  let searchTimeout = null;
  placeInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = placeInput.value.trim();
    if (q.length < 2) { placeResults.hidden = true; return; }
    searchTimeout = setTimeout(() => searchPlace(q), 300);
  });

  async function searchPlace(q) {
    try {
      const res = await fetch(`/api/cities/search?q=${encodeURIComponent(q)}&limit=5&min_population=0`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.cities?.length) { placeResults.hidden = true; return; }
      placeResults.innerHTML = data.cities.map(c =>
        `<div class="feedback-place-result" data-lat="${c.lat}" data-lng="${c.lng}" data-name="${escapeAttr(c.name)}, ${c.country_code}">
          ${escapeHtml(c.name)}, ${escapeHtml(c.country_code)} <span class="feedback-place-pop">${formatPopulation(c.population)}</span>
        </div>`
      ).join("");
      placeResults.hidden = false;
      placeResults.querySelectorAll(".feedback-place-result").forEach(el => {
        el.addEventListener("click", () => {
          selectedLat = Number(el.dataset.lat);
          selectedLng = Number(el.dataset.lng);
          placeInput.value = el.dataset.name;
          placeResults.hidden = true;
          coordText.textContent = `${selectedLat.toFixed(4)}, ${selectedLng.toFixed(4)}`;
          latlngDiv.hidden = false;
          updateSubmitEnabled();
        });
      });
    } catch (_) {}
  }

  // Map click to set location
  function onMapClick(e) {
    selectedLat = e.latlng.lat;
    selectedLng = e.latlng.lng;
    coordText.textContent = `${selectedLat.toFixed(4)}, ${selectedLng.toFixed(4)}`;
    latlngDiv.hidden = false;
    placeInput.value = "";
    updateSubmitEnabled();
  }
  map.on("click", onMapClick);
  _feedbackMapClick = onMapClick;

  clearCoordBtn.addEventListener("click", () => {
    selectedLat = null;
    selectedLng = null;
    latlngDiv.hidden = true;
    updateSubmitEnabled();
  });

  // Submit
  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";

    const activeTabBtn = dialog.querySelector(".feedback-tab.active");
    activeTab = activeTabBtn?.dataset.tab || "report";

    try {
      const sessionId = typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null;

      if (activeTab === "report") {
        const selected = dialog.querySelector('input[name="feedback-type"]:checked');
        if (!selected) return;
        const reportType = selected.value;
        const reason = reasonEl.value.trim();

        const res = await fetch(`/api/pins/${pin.id}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ report_type: reportType, reason, session_id: sessionId }),
        });
        if (!res.ok) throw new Error("Failed");
        resultEl.innerHTML = `<span style="color:var(--success)">✓ Thank you! Your report has been submitted.</span>`;
      } else {
        // Fix location
        const reason = fixReasonEl.value.trim();
        const payload = { reason: reason || undefined, session_id: sessionId };
        if (selectedLat !== null && selectedLng !== null) {
          payload.lat = selectedLat;
          payload.lng = selectedLng;
        }
        if (placeInput.value.trim()) {
          payload.place_name = placeInput.value.trim();
        }

        const res = await fetch(`/api/pins/${pin.id}/suggest-coords`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Failed");
        resultEl.innerHTML = `<span style="color:var(--success)">✓ Thank you! Your location suggestion has been submitted for review.</span>`;
      }

      resultEl.hidden = false;
      dialog.querySelector(".feedback-dialog-actions").hidden = true;
      dialog.querySelector(".feedback-tab-content:not([hidden])").style.opacity = "0.5";
      setTimeout(closeFeedbackDialog, 3000);
    } catch (e) {
      resultEl.innerHTML = `<span style="color:var(--error)">✗ Something went wrong. Please try again.</span>`;
      resultEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit";
    }
  });
}

function closeFeedbackDialog() {
  if (!_feedbackDialog) return;
  if (_feedbackMapClick) {
    map.off("click", _feedbackMapClick);
    _feedbackMapClick = null;
  }
  _feedbackDialog.remove();
  _feedbackDialog = null;
}

function formatPopulation(p) {
  if (!p) return "";
  if (p >= 1_000_000) return (p / 1_000_000).toFixed(1) + "M";
  if (p >= 1_000) return Math.round(p / 1_000) + "k";
  return "";
}
