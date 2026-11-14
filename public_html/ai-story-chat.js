/**
 * Xyzo AI Story Chat chunk (lazy-loaded).
 *
 * Opens a small chat window seeded with article context (headline,
 * source, location, summary, URL) so the AI can answer questions about
 * the specific pin without the user re-typing the story. Talks to the
 * existing /api/ai/chat endpoint; the AI gets the article context as a
 * system prefix so it has the story in memory.
 *
 * Loaded on demand by app.js when the user clicks the per-pin "Ask AI"
 * button in a pin popup.
 *
 * Self-contained: references window.escapeHtml, which is guaranteed to
 * be defined by the time the user clicks the trigger (app.js has
 * finished executing).
 *
 * Exposes:
 *   window.XyzoAiStoryChat.open(pin)
 *   window.XyzoAiStoryChat.close()
 */

(function () {
  'use strict';

  let _pinAiChatEl = null;

  function openPinAiChat(pin) {
    if (_pinAiChatEl) { _pinAiChatEl.remove(); _pinAiChatEl = null; }

    const location = pin.location || {};
    const placeText = location.place_name || pin.source_country || "";
    const source = pin.source_name || pin.canonical_url || "Unknown source";
    const summary = pin.summary || pin.title || "";

    const el = document.createElement("div");
    el.className = "pin-ai-chat";
    el.innerHTML = `
      <div class="pin-ai-chat-header">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:var(--accent);font-size:13px;">🤖 Ask AI about this story</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${escapeHtml(pin.title.slice(0, 70))}${pin.title.length > 70 ? "…" : ""}
          </div>
        </div>
        <button class="pin-ai-chat-close" aria-label="Close" style="background:transparent;border:0;color:var(--fg);font-size:20px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
      </div>
      <div class="pin-ai-chat-context" style="font-size:11px;color:var(--muted);padding:6px 12px;border-bottom:1px solid var(--border);background:rgba(94,234,212,0.05);">
        <strong>${escapeHtml(source)}</strong>
        ${placeText ? ` · ${escapeHtml(placeText)}` : ""}
        ${pin.canonical_url ? ` · <a href="${escapeHtml(pin.canonical_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">source ↗</a>` : ""}
      </div>
      <div class="pin-ai-chat-log" data-empty="true">
        <div class="pin-ai-chat-empty" style="padding:16px;color:var(--muted);font-size:12px;">
          Try: <em>What's the gist of this story?</em>
          · <em>Is this source credible?</em>
          · <em>What other angles should I look at?</em>
          · <em>Summarize in 3 sentences</em>
        </div>
      </div>
      <form class="pin-ai-chat-form" style="display:flex;border-top:1px solid var(--border);">
        <input type="text" class="pin-ai-chat-input"
               placeholder="Ask about this story…"
               maxlength="500" autocomplete="off"
               style="flex:1;background:transparent;border:0;color:var(--fg);padding:10px 12px;font-size:13px;outline:none;" />
        <button type="submit" class="pin-ai-chat-send" aria-label="Send"
                style="background:var(--accent);color:#000;border:0;padding:0 16px;font-weight:600;cursor:pointer;font-size:12px;">Ask</button>
      </form>
    `;
    document.body.appendChild(el);
    _pinAiChatEl = el;

    const log = el.querySelector(".pin-ai-chat-log");
    const form = el.querySelector(".pin-ai-chat-form");
    const input = el.querySelector(".pin-ai-chat-input");
    const sendBtn = el.querySelector(".pin-ai-chat-send");
    const closeBtn = el.querySelector(".pin-ai-chat-close");
    const transcript = []; // [{role, content}]

    // Pre-seeded system context for the AI. Sent with every turn so the
    // model doesn't lose the article details between user messages.
    const sysContext =
      `You are answering questions about a specific news story on xyzo.org. ` +
      `Here is the article context:\n` +
      `- Headline: ${pin.title}\n` +
      `- Source: ${source}\n` +
      (placeText ? `- Location: ${placeText}\n` : "") +
      (summary ? `- Summary: ${summary.slice(0, 400)}\n` : "") +
      (pin.canonical_url ? `- URL: ${pin.canonical_url}\n` : "") +
      `\nAnswer the user's follow-up questions about this story. Be concise. ` +
      `If you don't know, say so.`;

    function appendBubble(role, text, opts = {}) {
      const bubble = document.createElement("div");
      bubble.className = `pin-ai-bubble ${role}${opts.pending ? " pending" : ""}${opts.error ? " error" : ""}`;
      bubble.style.cssText = role === "user"
        ? "align-self:flex-end;max-width:85%;background:rgba(94,234,212,0.15);padding:8px 12px;border-radius:10px;margin:6px 10px;font-size:13px;color:var(--fg);"
        : "align-self:flex-start;max-width:85%;background:rgba(0,0,0,0.25);padding:8px 12px;border-radius:10px;margin:6px 10px;font-size:13px;color:var(--fg);white-space:pre-wrap;";
      if (opts.pending) bubble.textContent = "Thinking…";
      else if (opts.error) bubble.textContent = text;
      else bubble.textContent = text;
      log.appendChild(bubble);
      log.scrollTop = log.scrollHeight;
      return bubble;
    }

    async function sendQuestion(text) {
      const q = (text || "").trim();
      if (!q) return;
      sendBtn.disabled = true;
      input.disabled = true;
      if (log.dataset.empty === "true") {
        log.dataset.empty = "false";
        log.innerHTML = "";
      }
      appendBubble("user", q);
      transcript.push({ role: "user", content: q });
      const pending = appendBubble("assistant", "", { pending: true });
      try {
        // Build a single prompt with system context + transcript so the
        // model has the article context for every turn without us having
        // to extend /api/ai/chat to accept system messages.
        const transcriptStr = transcript.map(t =>
          `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`
        ).join("\n");
        const fullPrompt = `${sysContext}\n\n${transcriptStr}\nAssistant:`;
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: fullPrompt, stream: false }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ? `${errBody.error}: ${errBody.message || ""}` : `HTTP ${res.status}`);
        }
        const data = await res.json();
        const reply = (data.response || data.message || "I don't have an answer for that.").trim();
        pending.remove();
        appendBubble("assistant", reply);
        transcript.push({ role: "assistant", content: reply });
      } catch (e) {
        pending.remove();
        appendBubble("assistant", `⚠ ${e.message}`, { error: true });
      } finally {
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value;
      input.value = "";
      sendQuestion(v);
    });
    closeBtn.addEventListener("click", () => { el.remove(); _pinAiChatEl = null; });
    const onKey = (e) => { if (e.key === "Escape" && _pinAiChatEl === el) { el.remove(); _pinAiChatEl = null; document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    setTimeout(() => input.focus(), 50);
  }

  function closePinAiChat() {
    if (!_pinAiChatEl) return;
    _pinAiChatEl.remove();
    _pinAiChatEl = null;
  }

  // ── Public API ────────────────────────────────────────────────────
  window.XyzoAiStoryChat = {
    open: openPinAiChat,
    close: closePinAiChat,
  };
})();
