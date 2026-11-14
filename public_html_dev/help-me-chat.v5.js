/**
 * XYZO Help Me Chat — Bold, Funny, Specific AI Problem-Solving Chat
 *
 * A floating "Help Me" button that opens a chat window focused on:
 * "What's happening? What can I actually DO about it?"
 *
 * Uses the existing /api/ai/chat endpoint with a BOLD system prompt.
 * No general answers — only specific, actionable, honest responses.
 */
(function () {
  'use strict';

  let _chatEl = null;

  // ── Bold System Prompt ──────────────────────────────────────────────
  const SYSTEM_PROMPT = `You are XYZO's "Help Me" assistant — you're like a slightly-too-honest friend who happens to read all the news and knows how to connect dots. You are funny, technical, culturally rich, and relentlessly helpful.

PERSONALITY:
- You're allowed to say "that's a scam" and "that's garbage" — you don't soften it
- You use HUMOR constantly — the dark, absurd, sarcastic kind. The world is ridiculous. Point it out.
- You're TECHNICAL but in a "smart friend explains it at dinner" way, not a textbook way
- You're CULTURALLY FLUENT — Urdu, Hindi, Arabic, Punjabi, Spanish, Swahili flow naturally in
- You use short punchy paragraphs, not walls of text. 3-5 sentences max per point.
- You connect THEORY to PRACTICE — every story affects real people, usually the ones least able to absorb the shock
- You're SPIRITUAL when the moment calls for it — karma, dua, the universe, sacred duty

HOW TO START (pick one, use naturally):
- "So here's the deal with [story title]..."
- "[Story title] sounds boring but here's what's actually wild about it..."
- "Okay so [story title] is happening in [city] and honestly? It affects you more than you think..."
- "Let me break this down in a way that actually matters..."

HOW TO CONNECT STORIES TO "YOUR AREA":
- When you have a story popup: "This [story title] in [city]? Here's how it connects to your area..."
- "You've been reading about [topics they've engaged with]. This story? It's the same issue, different ZIP code."
- "Pakistan has this problem. India has this problem. YOUR area has this problem. Same root cause."
- "The keywords on this story — [list] — if that's your area too, pay attention. This is your life."

HOW TO USE USER MEMORY (the things they've read about before):
- They've asked about X or read about Y → connect new stories to that interest
- "You were worried about [topic]. This story is why you were right to be."
- "Remember when you asked about [topic]? This is the update you needed."
- Topics they've engaged with = what they CARE about. Make the connection explicit.

RESPONSE STRUCTURE (mix and match, don't be rigid):
1. THE HOOK — 1 sentence that's either funny, shocking, or personally relevant
2. THE EXPLANATION — 2-3 sentences, technical enough to understand, simple enough to explain at dinner
3. THE CONNECTION TO YOU — "Here's why this matters near you" or "This affects your area because..."
4. THE ACTION — 1-3 concrete things they can actually do TODAY
5. THE PUNCHLINE — a joke, a spiritual note, or a brutal honest truth

EXAMPLES OF THE TONE YOU WANT:
- "Rusted flyover beams in Rajkot. This isn't just an India problem. This is what happens when infrastructure budgets get 'adjusted'. Karachi? Lahore? Delhi? Same story, different flyover. 🔩"
- "Your WhatsApp family group is NOT a news source. I cannot stress this enough. The forward about [topic] that your aunt shared? 40% fabricated, 60% exaggerated, 100% designed to make you anxious. 🙄"
- "The economy in Pakistan is doing X. Here's what that ACTUALLY means for your job prospects, your savings, and your ability to eat this month. Specifics incoming. 💸"
- "Climate change isn't a future problem. It's a RIGHT NOW problem. The floods in [area] last month? That was a preview. The full version is coming to a city near you. Here's what to do. 🌍"

MUST-INCLUDE RULES:
1. Connect every story to the user's location — "near you", "your area", "same thing happening in Karachi/Lahore/Delhi/etc."
2. Use the user's tracked interests (from memory) to personalize: "You keep reading about [X] — this story connects to that"
3. Give 1-3 actions MAX, and make them specific: which org, which website, what to say, what to do
4. Never send people to "contact authorities" — name the actual department, website, or person
5. Always include real URLs (not news.google.com) — real outlets only

URL VARIETY RULE:
- NEVER use news.google.com — it's a scraper
- Use real sources: bbc.com, reuters.com, aljazeera.com, dawn.com, theguardian.com, indianexpress.com, arynews.tv
- If no real source available: say "search this on Dawn.com or BBC.com" — name specific outlets
- Mix it up: different answers should point to different outlets

Never start with "I'm an AI" or "Based on the information available" — just answer like a friend would.

Be hilarious. Be specific. Be useful. Be their friend who actually pays attention to the world and tells them the truth. 🙏`;

  // ── Memory Functions (outside openHelpMeChat so track() works) ──────
  const MEMORY_KEY = "xyzo.helpme.memory";
  function loadMemory() {
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function saveMemory(mem) {
    try { localStorage.setItem(MEMORY_KEY, JSON.stringify(mem)); } catch {}
  }

  // ── Helpers (outside openHelpMeChat so greeting can use them) ───────
  function getDaysAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (diff < 1) return "earlier today";
    if (diff < 2) return "yesterday";
    return `about ${Math.floor(diff)} days ago`;
  }

  function getRandomGreeting() {
    const greetings = [
      "Ask about any problem — I'll tell you what's really going on. Shukriya for being here. 🙏",
      "What's happening in the world that you want to understand better? Namaste 🙏",
      "Pick any topic — I'll make it actually useful. Let's dig in.",
      "What's on your mind? I give straight answers. No fluff. JazakAllah for asking. 🙏",
      "Tell me what's worrying you — I'll tell you what you can actually do. As-salamu alaykum. 🙏",
      "Any problem in the world — I know the backstory. Let's find it together.",
      "What's the thing you keep seeing but don't fully understand? I got you.",
      "I give actionable answers. What's your question? Let's go. 💪",
      "Curious about something? I have sharp answers. Ask me anything.",
      "The world is complicated. Let me simplify it for you. You're doing the right thing by asking.",
      "Allah harafiz, the universe provides, and I'm here to help. What's on your mind? 🙏",
      "Karma is real and so is action. Let's make sure you're doing the right thing. 💪",
      "The fact that you're here asking means something. That's the first step. Let's go. 🙏",
      "You've got questions, I've got answers that actually work. Let's go. 💪",
      "Dua received. Let me help you figure this out. What's the situation? 🙏",
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // ── Main Chat Opener ──────────────────────────────────────────────
  function openHelpMeChat(userContext = {}) {
    if (_chatEl) { _chatEl.remove(); _chatEl = null; }

    const memory = loadMemory();
    if (!memory.conversations) memory.conversations = [];
    if (!memory.topicsViewed) memory.topicsViewed = [];
    if (!memory.problemsSeen) memory.problemsSeen = [];

    const now = new Date().toISOString();
    const visitCount = memory.conversations.length || 0;

    // ── Personalized Greeting ─────────────────────────────────────
    // Priority: popup story > lastRecommendation > visit count > default
    const allGreetings = [
      "Ask me about any problem — I'll tell you what's really going on.",
      "What's happening in the world that you want to understand better?",
      "Pick any topic — I'll make it actually useful.",
      "What's on your mind? I give straight answers.",
      "Tell me what's worrying you — I'll tell you what you can actually do.",
      "Any problem in the world — I know the backstory.",
      "What's the thing you keep seeing but don't fully understand?",
      "I give actionable answers. What's your question?",
      "Curious about something? I have sharp answers.",
      "The world is complicated. Let me simplify it for you.",
      "You've got questions, I've got answers that actually work. Let's go. 💪",
      "Dua received. Let me help you figure this out. What's the situation? 🙏",
    ];
    const defaultGreeting = allGreetings[Math.floor(Math.random() * allGreetings.length)];

    let greeting = "👋 " + defaultGreeting;

    // If a popup story is open — greet about THAT specifically
    if (userContext.activeStory) {
      const s = userContext.activeStory;
      const storyGreetings = [
        `👋 You're looking at "${s.title}" — ask me anything about it.`,
        `👋 That story on your screen — "${s.title}" — I can tell you more. What do you want to know?`,
        `👋 You've got "${s.title}" open right now. Want to know what's really going on?`,
        `👋 Interesting choice — "${s.title}". Let's dig into it. What do you want to know?`,
        `👋 That popup story — "${s.title}" — I have opinions. And facts. Let's go.`,
      ];
      greeting = storyGreetings[Math.floor(Math.random() * storyGreetings.length)];
    } else if (memory.lastRecommendation && visitCount <= 10) {
      // lastRecommendation follow-up — but only if not a popup, and not too many visits
      const rec = memory.lastRecommendation;
      const recDays = getDaysAgo(rec.ts);
      greeting = `👋 Hey! Last time you asked about "${rec.topic}" — I suggested: ${rec.suggestedAction}. Did you do it? How'd it go?`;
    } else if (visitCount === 1) {
      greeting = "👋 Welcome back! I remember our last chat. What else is on your mind?";
    } else if (visitCount > 1 && visitCount <= 5) {
      greeting = `👋 Good to see you again! ${visitCount} visits now. What are we solving today?`;
    } else if (visitCount > 5) {
      greeting = `👋 Hey friend! ${visitCount} conversations deep. You're basically family now. What's up?`;
    }

    // ── Location context ─────────────────────────────────────────
    let userLocationContext = "";
    if (userContext.lat && userContext.lng) {
      const locName = userContext.name || userContext.city || userContext.country || 'your current map view';
      userLocationContext = `
YOUR AREA — connect every story to this location:
  You are looking at: ${locName}
  Coordinates: (${userContext.lat.toFixed(2)}°, ${userContext.lng?.toFixed(2) ?? '?'}°)

When discussing any story — ALWAYS connect it to this area. Ask: "How does this affect someone in ${locName}?" "Is this happening near ${locName} too?" "What can someone in ${locName} do about this?"`;
    }

    // ── Active story from open popup ──────────────────────────────
    let activeStoryContext = "";
    if (userContext.activeStory) {
      const s = userContext.activeStory;
      activeStoryContext = `
STORY OPEN RIGHT NOW — answer questions about THIS story:
  Title: "${s.title}"
  Category: ${s.category || "?"}
  Location: ${s.place_name || "unknown"}
  Source: ${s.canonical_url || "unknown"}
  Keywords: ${s.summary ? s.summary.replace("Keywords: ", "") : "none"}
  Full URL: ${s.canonical_url || ""}

IMPORTANT: When user asks about "this", "here", "this popup", "this story", or anything about what they're looking at — answer about THIS specific story. Start with the story title. Connect it to their location and interests.`;
    }

    // ── User memory context ───────────────────────────────────────
    let userMemoryContext = "\nUSER HISTORY & MEMORY:\n";
    if (visitCount > 0) {
      const last2 = memory.conversations.slice(-2);
      userMemoryContext += `Recent: ${last2.map(c => `"${c.q.substring(0, 50)}"`).join(" → ")}. `;
    }
    if (memory.topicsViewed.length > 0) {
      const topics = [...new Set(memory.topicsViewed)].slice(-5);
      userMemoryContext += `Topics they've engaged with: ${topics.join(", ")}. `;
    }
    if (memory.problemsSeen.length > 0) {
      const probs = [...new Set(memory.problemsSeen)].slice(-5);
      userMemoryContext += `Problem areas explored: ${probs.join(", ")}. `;
    }
    if (memory.lastRecommendation) {
      const rec = memory.lastRecommendation;
      userMemoryContext += `LAST RECOMMENDATION: topic="${rec.topic}", suggested="${rec.suggestedAction}" (${getDaysAgo(rec.ts)}). If asking about same/related topic, ask if they followed through.`;
    }

    const fullSystemPrompt = SYSTEM_PROMPT + userLocationContext + activeStoryContext + userMemoryContext;

    // ── Random suggest buttons — 3 fresh ones every time, 100+ wow options ───
    const suggestPool = [
      { q: "What should I STOP worrying about and what should I ACTUALLY worry about right now?", e: "🎯", c: "#ff6b35" },
      { q: "What's the ONE thing I should be doing with my money this year based on world events?", e: "💰", c: "#f97316" },
      { q: "What skill should I learn RIGHT NOW that will actually matter in 5 years?", e: "🧠", c: "#5eead4" },
      { q: "Give me a news story that will literally change how I see the world.", e: "🌍", c: "#a855f7" },
      { q: "What's the most underrated advice for understanding what's really happening?", e: "💡", c: "#5eead4" },
      { q: "How do I actually talk to my parents about scary news without arguing?", e: "👨‍👩‍👧", c: "#ff6b35" },
      { q: "If the internet shut down tomorrow, what would I wish I'd learned online?", e: "📵", c: "#a855f7" },
      { q: "What's the most interesting perspective on the news that nobody is talking about?", e: "🗣️", c: "#5eead4" },
      { q: "What news story from TODAY will people talk about in 50 years?", e: "📜", c: "#a855f7" },
      { q: "How do I help someone I love who is depressed about world news?", e: "💙", c: "#5eead4" },
      { q: "What's the most mind-blowing fact hidden in today's headlines?", e: "🤯", c: "#a855f7" },
      { q: "If I could only read ONE source for the rest of my life, what should it be?", e: "📰", c: "#ff6b35" },
      { q: "How do I fact-check something without spending hours on it? Quick version.", e: "🔍", c: "#fbbf24" },
      { q: "What would happen if I just... ignored all news for a month? Good or bad?", e: "🧘", c: "#5eead4" },
      { q: "What's the biggest misunderstanding most people have about current events?", e: "❌", c: "#fbbf24" },
      { q: "How do I make my own informed opinion without getting overwhelmed?", e: "🧠", c: "#ff6b35" },
      { q: "What's something about the world that sounds fake but is 100% true?", e: "🎭", c: "#a855f7" },
      { q: "How did the world get so complicated? Give me the 60-second history lesson.", e: "📚", c: "#5eead4" },
      { q: "What's the best way to help without being scammed or wasting money?", e: "🤝", c: "#ff6b35" },
      { q: "If you had to predict one thing that will definitely happen next year, what?", e: "🔮", c: "#a855f7" },
      { q: "How do I protect my mental health and still stay informed? Real balance.", e: "⚖️", c: "#5eead4" },
      { q: "What's the most useful superpower right now in today's world — and how do I get it?", e: "🦸", c: "#a855f7" },
      { q: "How do I explain what's happening to my kids in a way that doesn't scare them?", e: "👶", c: "#ff6b35" },
      { q: "What's the most valuable lesson history keeps teaching us that we keep ignoring?", e: "📖", c: "#5eead4" },
      { q: "What should I be doing with my savings that nobody talks about?", e: "🏦", c: "#f97316" },
      { q: "How do I find the signal in all this noise? Cut through the chaos.", e: "📡", c: "#a855f7" },
      { q: "What's the best conversation to have with a friend about the news?", e: "💬", c: "#5eead4" },
      { q: "What book or documentary actually changed your understanding of how the world works?", e: "🎬", c: "#ff6b35" },
      { q: "How do I stop feeling helpless and start actually making a difference?", e: "💪", c: "#ff6b35" },
      { q: "What's something surprising about how the world works that I'm not seeing?", e: "👀", c: "#a855f7" },
      { q: "If I could master ONE topic this year, what would make me the most dangerous in conversation?", e: "🗣️", c: "#5eead4" },
      { q: "How do I spot manipulation in news before it gets me?", e: "🎯", c: "#fbbf24" },
      { q: "What prediction about the future keeps proving to be true again and again?", e: "🔭", c: "#a855f7" },
      { q: "How did ordinary people throughout history deal with times this chaotic?", e: "👴", c: "#5eead4" },
      { q: "What's the fastest way to understand a complicated situation without the jargon?", e: "⚡", c: "#ff6b35" },
      { q: "What's something I've been told about the world that's actually backwards?", e: "🔄", c: "#a855f7" },
      { q: "How do I have a respectful argument with someone who sees the news differently?", e: "🤝", c: "#5eead4" },
      { q: "What would you tell your younger self about how to process scary world events?", e: "👦", c: "#ff6b35" },
      { q: "What's the most useful thing most people never learn in school about the world?", e: "🎓", c: "#a855f7" },
      { q: "How do I turn news anxiety into something productive?", e: "🔋", c: "#5eead4" },
      { q: "What question should I be asking about what's happening that I'm not asking?", e: "❓", c: "#a855f7" },
      { q: "How did fake news become more profitable than real news? Show me the business model.", e: "💸", c: "#f97316" },
      { q: "What's a 'stupid question' about the world that actually has a brilliant answer?", e: "🤔", c: "#5eead4" },
      { q: "If I could only do ONE thing to be more informed, what should it be?", e: "✅", c: "#ff6b35" },
      { q: "How do I know when to trust a source and when to be suspicious?", e: "🕵️", c: "#fbbf24" },
      { q: "What technology is quietly changing the world that nobody talks about?", e: "🤖", c: "#a855f7" },
      { q: "How do I build my own informed worldview without relying on algorithms?", e: "🏛️", c: "#5eead4" },
      { q: "What's a pattern in history that keeps showing up and what does it mean for us?", e: "🔁", c: "#a855f7" },
      { q: "How do I take a break from the news without becoming ignorant?", e: "☕", c: "#5eead4" },
      { q: "What would make me genuinely dangerous at dinner parties when talking about the news?", e: "🍷", c: "#ff6b35" },
      { q: "How do I find community when everyone seems to disagree about everything?", e: "🤝", c: "#5eead4" },
      { q: "What belief about the world do most people hold that is completely wrong?", e: "💥", c: "#a855f7" },
      { q: "How do I stop doom-scrolling and actually DO something meaningful?", e: "📵", c: "#ff6b35" },
      { q: "What's the most elegant explanation of a complicated world event you've ever heard?", e: "✨", c: "#5eead4" },
      { q: "How did we get here? What's the origin story of the chaos we're living through?", e: "📖", c: "#a855f7" },
      { q: "What should I be paying attention to that I'm probably missing right now?", e: "👁️", c: "#ff6b35" },
      { q: "How do I stay hopeful when the news is overwhelming? Real strategies.", e: "🌅", c: "#5eead4" },
      { q: "What question would you ask if you could ask the news universe ONE thing?", e: "🌌", c: "#a855f7" },
      { q: "How do I teach myself to think like a journalist about what I read?", e: "🎤", c: "#ff6b35" },
      { q: "What's the most counterintuitive insight about how the world actually works?", e: "🧠", c: "#a855f7" },
      { q: "How do I create my own news diet that actually nourishes me?", e: "🥗", c: "#5eead4" },
      { q: "What's the biggest gap between what people think is true and what is actually true?", e: "🎭", c: "#a855f7" },
      { q: "How do I process grief about world events when I can't even help?", e: "💔", c: "#5eead4" },
      { q: "What habit would make me the most informed person in any room?", e: "📚", c: "#ff6b35" },
      { q: "How do I know when the world is actually changing vs when it's just noise?", e: "📊", c: "#a855f7" },
      { q: "What's a moment in history that feels exactly like right now?", e: "⏪", c: "#5eead4" },
      { q: "How do I engage with news without letting it own my mood?", e: "🫀", c: "#5eead4" },
      { q: "What does the smartest person in the room already know that I'm still figuring out?", e: "🧠", c: "#a855f7" },
      { q: "How do I build the mental model of how power actually works in the world?", e: "🏛️", c: "#ff6b35" },
      { q: "What would it take to actually solve the biggest problems we face?", e: "🔧", c: "#5eead4" },
      { q: "How do I find the truth when every side is pushing a narrative?", e: "⚖️", c: "#a855f7" },
      { q: "What's the most powerful thing I can share with my community right now?", e: "🏘️", c: "#ff6b35" },
      { q: "How do I develop the wisdom to know what's worth caring about?", e: "🧘", c: "#5eead4" },
      { q: "What's the next 10 years going to look like for someone my age?", e: "🔭", c: "#a855f7" },
      { q: "How do I go from consuming news to understanding it?", e: "📈", c: "#ff6b35" },
      { q: "What question would blow my mind if you answered it completely honestly?", e: "💥", c: "#a855f7" },
      { q: "How do I prepare myself and family for what's coming?", e: "👨‍👩‍👧‍👦", c: "#ff6b35" },
      { q: "What's something about human nature the news never explains but everything depends on?", e: "🫀", c: "#5eead4" },
      { q: "How do I turn confusion into clarity about what's happening?", e: "💡", c: "#ff6b35" },
      { q: "What's the real score? Give me the bottom line nobody is saying out loud.", e: "📋", c: "#a855f7" },
      { q: "How do I find my place in a world that feels like it's falling apart?", e: "🏠", c: "#5eead4" },
      { q: "What matters more than anything I'm currently reading about?", e: "⚡", c: "#a855f7" },
      { q: "How do I think for myself when everyone seems to have an agenda?", e: "🧠", c: "#ff6b35" },
      { q: "What's the most practical wisdom for navigating today's world?", e: "💪", c: "#5eead4" },
      { q: "How do I connect the dots between stories that seem unrelated?", e: "🔗", c: "#a855f7" },
      { q: "What's something terrifying that would make me more prepared if I accepted it?", e: "⚠️", c: "#ff6b35" },
      { q: "How do I stay human in an age of information overload?", e: "❤️", c: "#5eead4" },
      { q: "What would it take for me to actually understand what's happening globally?", e: "🎯", c: "#ff6b35" },
      { q: "How do I make decisions in a world I don't fully understand?", e: "🧭", c: "#a855f7" },
      { q: "What's the most important thing to remember when everything feels chaotic?", e: "🧘", c: "#5eead4" },
      { q: "How do I find peace in a world that keeps demanding my attention?", e: "☮️", c: "#5eead4" },
      { q: "What truth about the world would actually set me free if I accepted it?", e: "🔓", c: "#a855f7" },
      { q: "How do I stop being a passive consumer of fear and become an active participant?", e: "🏃", c: "#ff6b35" },
      { q: "What's the most underrated skill for understanding global events?", e: "🔍", c: "#5eead4" },
      { q: "How do I make sense of a world that often doesn't make sense?", e: "🧩", c: "#a855f7" },
      { q: "What am I probably wrong about regarding what's happening in the world?", e: "❓", c: "#ff6b35" },
      { q: "How do I develop genuine confidence when talking about global issues?", e: "💬", c: "#5eead4" },
      { q: "What would a wise ancient philosopher say about our current chaos?", e: "🏛️", c: "#a855f7" },
      { q: "How do I stop being afraid of the future and start preparing for it?", e: "🔮", c: "#ff6b35" },
      { q: "What should I value that the news never talks about?", e: "💎", c: "#5eead4" },
      { q: "How do I find clarity in a world designed to confuse me?", e: "🧠", c: "#a855f7" },
      { q: "What's the one framework for understanding any global event?", e: "🗺️", c: "#ff6b35" },
      { q: "How do I stay grounded when the world keeps spinning faster?", e: "🌍", c: "#5eead4" },
      { q: "What's the most honest conversation we could have about what's really going on?", e: "💯", c: "#a855f7" },
    ];

    // Pick 3 random suggestions, no duplicates
    const shuffled = suggestPool.slice().sort(() => Math.random() - 0.5);
    const picks = shuffled.slice(0, 3);
    const suggestBtnsHtml = picks.map(p =>
      `<button class="help-me-suggest-btn" data-suggest="${p.q.replace(/"/g, '&quot;')}" style="margin-top:5px;background:rgba(${hexToRgb(p.c)},0.15);border:1px solid rgba(${hexToRgb(p.c)},0.4);color:${p.c};padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;width:100%;text-align:left;">${p.e} ${p.q}</button>`
    ).join("");

    function hexToRgb(hex) {
      const r = parseInt(hex.slice(1,3),16);
      const g = parseInt(hex.slice(3,5),16);
      const b = parseInt(hex.slice(5,7),16);
      return `${r},${g},${b}`;
    }
    const locationInfo = userContext.lat
      ? `Your location: ${userContext.name || 'map center'} (${userContext.lat.toFixed(2)}°, ${userContext.lng?.toFixed(2) ?? '?'}°)`
      : (userContext.source === "map_center" ? "Your current map view" : "Unknown location");

    const el = document.createElement("div");
    el.className = "help-me-chat";
    el.innerHTML = `
      <div class="help-me-chat-header">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">🆘</span>
          <div>
            <div style="font-weight:700;color:#ff6b35;font-size:14px;">Help Me</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.6);">Bold · Specific · Honest</div>
          </div>
        </div>
        <button class="help-me-chat-close" aria-label="Close" style="background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer;padding:4px;opacity:0.7;">×</button>
      </div>
      <div class="help-me-chat-intro">
        <p>${greeting}</p>
        ${userContext.lat ? `<p style="margin:4px 0 0;font-size:11px;color:rgba(94,234,212,0.7);">📍 ${locationInfo}</p>` : ''}
        ${memory.topicsViewed?.length > 0 ? `<p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,0.4);">You've been reading: <em>${[...new Set(memory.topicsViewed)].slice(-3).join(", ")}</em></p>` : ''}
        ${Math.random() < 0.35 ? `<p style="margin:6px 0 4px;font-size:10px;color:rgba(251,191,36,0.65);font-style:italic;">🗣️ I speak 50+ languages — reply in any language you want 🙏</p>` : ''}
        ${suggestBtnsHtml}
      </div>
      <div class="help-me-chat-log" data-empty="true"></div>
      <button class="help-me-jump-top" style="display:none;" aria-label="Jump to your first message">↑ see your first message</button>
      <form class="help-me-chat-form">
        <input type="text" class="help-me-chat-input"
               placeholder="What's happening? What can I do?"
               maxlength="500" autocomplete="off"
               style="flex:1;background:transparent;border:0;color:#fff;padding:10px 12px;font-size:13px;outline:none;" />
        <button type="submit" style="background:#ff6b35;color:#fff;border:0;padding:0 16px;font-weight:700;cursor:pointer;font-size:13px;">Go</button>
      </form>
    `;
    document.body.appendChild(el);
    _chatEl = el;

    const log = el.querySelector(".help-me-chat-log");
    const form = el.querySelector(".help-me-chat-form");
    const input = el.querySelector(".help-me-chat-input");
    const closeBtn = el.querySelector(".help-me-chat-close");
    const suggestBtns = el.querySelectorAll(".help-me-suggest-btn");
    const jumpTopBtn = el.querySelector(".help-me-jump-top");
    const transcript = [];

    // ── Viewport Context ───────────────────────────────────────────
    // Read what stories are visible on the map right now
    function getViewportContext() {
      try {
        if (typeof canvasRenderer === "undefined" || !canvasRenderer._pins) return "";
        let pins = canvasRenderer._pins;
        if (!pins || pins.length === 0) return "";

        try {
          if (typeof map !== "undefined" && map && map.getBounds) {
            const bounds = map.getBounds();
            if (bounds && bounds.isValid()) {
              pins = pins.filter(p => {
                const lat = p.location?.lat ?? p.lat;
                const lng = p.location?.lng ?? p.lng;
                if (lat == null || lng == null) return false;
                return bounds.contains([lat, lng]);
              });
            }
          }
        } catch(e) {}

        if (pins.length === 0) return "";

        const topPins = pins
          .filter(p => p.title || p.headline)
          .sort((a, b) => (b.source_count || 0) - (a.source_count || 0))
          .slice(0, 6);

        const cityCounts = {};
        pins.forEach(p => {
          if (p.place_name) {
            const city = p.place_name.split(",")[0]?.trim();
            if (city && city.length > 1) cityCounts[city] = (cityCounts[city] || 0) + 1;
          }
        });
        const citiesList = Object.entries(cityCounts)
          .sort((a,b) => b[1] - a[1])
          .slice(0, 8)
          .map(([city, count]) => count > 1 ? `${city}(${count})` : city)
          .join(", ");

        const storyList = topPins.map(p => {
          const loc = p.place_name?.split(",")[0] || "unknown";
          let domain = "";
          try { if (p.canonical_url) domain = new URL(p.canonical_url).hostname.replace("www.", ""); } catch(e) {}
          // Skip news.google.com — it's a scraper, not a real source. Flag it so AI knows.
          const isGoogleScraper = domain === "news.google.com" || domain === "news.google.co.uk" || !domain;
          const urlPart = !isGoogleScraper && domain ? ` [${domain}]` : (domain && domain.includes("news.google") ? " [🔍 Google scrape - real source unclear]" : "");
          return `  - "${(p.title || "").substring(0, 60)}" [${p.category || "other"}] ${loc} (${p.source_count || 1}src)${urlPart}${p.canonical_url && !isGoogleScraper ? " " + p.canonical_url : ""}`;
        }).join("\n");

        return `\nSTORIES ON MAP (${pins.length} total, top 6 by sources, full URL included when real source available):
Cities: ${citiesList}
${storyList}`;
      } catch (e) {
        return "";
      }
    }

    // ── Nearby Problems ────────────────────────────────────────────
    let nearbyProblemsContext = "";

    async function fetchNearbyProblems() {
      if (!userContext.lat || !userContext.lng) return;
      try {
        const res = await fetch(
          `/api/problems?lat=${userContext.lat.toFixed(4)}&lng=${userContext.lng.toFixed(4)}&radius=500&limit=5&status=active`
        );
        if (!res.ok) return;
        const data = await res.json();
        const problems = data.items || [];
        if (!problems.length) return;
        nearbyProblemsContext = "\n\nNEARBY PROBLEMS (within ~500km of user's location):\n" +
          problems.map(p =>
            `  - [${p.problem_type.toUpperCase()}] ${p.headline}${p.severity ? ` (severity: ${p.severity.toFixed(2)})` : ''}: ${p.description || 'No description'}`
          ).join("\n");
      } catch(e) {}
    }

    // ── Language Detection ────────────────────────────────────────
    function detectLanguage(text) {
      if (!text) return "English";
      const lower = text.toLowerCase();
      if (/[ا-ي]/.test(text)) return "Arabic";
      if (/[а-яА-Я]/.test(text)) return "Russian";
      if (/[一-龥]/.test(text)) return "Chinese";
      if (/[가-힣]/.test(text)) return "Korean";
      if (/[ぁ-ゟ]/.test(text) || /[ァ-ヺ]/.test(text)) return "Japanese";
      if (/[অ-৯]/.test(text)) return "Bengali";
      if (/[ऀ-ॿ]/.test(text)) return "Hindi";
      if (/[අ-ෳ]/.test(text)) return "Sinhala";
      if (/\b(hola|gracias|por favor|buenos dias|amigo)\b/i.test(lower)) return "Spanish";
      if (/\b(bonjour|merci|s'il vous plat|comment)\b/i.test(lower)) return "French";
      if (/\b(obrigado|por favor|bom dia|como vai)\b/i.test(lower)) return "Portuguese";
      if (/\b(hallo|danke|bitte|guten)\b/i.test(lower)) return "German";
      if (/\b(shukriya|namaste|salaam|dhanyavaad|kya|hai|yeh|acha)\b/i.test(lower)) return "Urdu/Hindi";
      if (/\b(dhonnobad|namaskar|kemon|achen|bhalo)\b/i.test(lower)) return "Bengali";
      if (/\b(habari|asante|jambo|karibu|polepole)\b/i.test(lower)) return "Swahili";
      return "English";
    }

  // ── URL Auto-Linker ─────────────────────────────────────────
  // Converts plain-text URLs into safe, clickable <a> tags
  function autoLink(text) {
    if (!text || typeof text !== "string") return text;
    const escaped = escapeHtml(text);
    const linked = escaped.replace(
      /(?:^|[\s\(\)\[\]{}"'`])(https?:\/\/[^\s<>"\']+)/g,
      (_, url) => {
        const cleanUrl = url.replace(/["'<>]/g, "");
        const linkHtml = `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color:#5eead4;text-decoration:underline;">${cleanUrl}</a>`;
        // DOMPurify strips target="_blank" by default — add it back after sanitize
        const sanitized = typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(linkHtml, { USE_PROFILES: { html: true } })
          : linkHtml;
        const a = document.createElement("div");
        a.innerHTML = sanitized;
        const link = a.querySelector("a");
        if (link) {
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", "noopener noreferrer");
          return a.innerHTML;
        }
        return linkHtml;
      }
    );
    return linked;
  }

  // ── SSE Stream Reader ────────────────────────────────────────────
  // Reads SSE chunks from the response body, accumulates delta tokens
  // into two buffers: `reasoningText` (delta.reasoning_content) and
  // `fullText` (delta.content). Renders reasoning live as muted/italic
  // text so the user sees the model thinking, then hides it once real
  // content starts arriving and only renders the answer.
  //
  // v5 changes from v4:
  //   - Tracks `reasoningText` separately from `fullText`. Reasoning
  //     model (Gemma 4 E2B) emits `delta.reasoning_content` for 200+
  //     tokens before any `delta.content` — v4 silently dropped this,
  //     so the bubble sat on "Thinking…" for the full reasoning phase.
  //   - Lazily swaps the "Thinking…" placeholder for two child divs
  //     (reasoning + content) on the first token of either kind, so
  //     we don't touch the DOM until there's something to show.
  //   - Hides reasoning once content starts arriving — it served its
  //     purpose as a live trace.
  //   - Final render keeps autoLink + newline conversion, reasoning
  //     intentionally dropped from saved transcript.
  function readSseStream(body, targetBubble) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";        // delta.content — the actual answer
    let reasoningText = "";   // delta.reasoning_content — the model's thinking
    let chunkCount = 0;
    let rafScheduled = false;
    let structureBuilt = false;
    let reasoningEl = null;
    let contentEl = null;
    const t0 = performance.now();
    console.log("[HelpMe] SSE: starting, targetBubble=", targetBubble?.tagName, "connected=", targetBubble?.isConnected);

    function ensureStructure() {
      if (structureBuilt || !targetBubble) return;
      structureBuilt = true;
      targetBubble.innerHTML = "";
      reasoningEl = document.createElement("div");
      reasoningEl.style.cssText = "opacity:0.55;font-style:italic;font-size:12px;margin-bottom:6px;white-space:pre-wrap;";
      contentEl = document.createElement("div");
      contentEl.style.cssText = "white-space:pre-wrap;";
      targetBubble.appendChild(reasoningEl);
      targetBubble.appendChild(contentEl);
    }

    function paintFrame() {
      rafScheduled = false;
      if (!targetBubble || !targetBubble.isConnected) return;
      if (reasoningEl) {
        reasoningEl.style.display = fullText ? "none" : "";
        reasoningEl.textContent = fullText ? "" : reasoningText;
      }
      if (contentEl) contentEl.textContent = fullText;
      log.scrollTop = log.scrollHeight;
    }

    function schedulePaint() {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(paintFrame);
    }

    return (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunkCount++;
          buf += decoder.decode(value, { stream: true });
          if (chunkCount === 1) {
            console.log("[HelpMe] SSE: first chunk after", Math.round(performance.now() - t0), "ms, size=", value?.length, "preview=", JSON.stringify(buf.slice(0, 100)));
          }
          let idx;
          let linesProcessed = 0;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line.startsWith("event:")) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]" || payload === "") continue;
            try {
              const obj = JSON.parse(payload);
              const delta = obj?.choices?.[0]?.delta ?? {};
              const contentPiece = delta.content;
              const reasoningPiece = delta.reasoning_content;
              if (typeof reasoningPiece === "string" && reasoningPiece) {
                ensureStructure();
                reasoningText += reasoningPiece;
                linesProcessed++;
                schedulePaint();
              }
              if (typeof contentPiece === "string" && contentPiece) {
                ensureStructure();
                fullText += contentPiece;
                linesProcessed++;
                schedulePaint();
              }
            } catch (e) {
              // skip malformed — upstream may emit custom events like hivv_stats
            }
          }
          if (chunkCount <= 3) {
            console.log("[HelpMe] SSE: chunk", chunkCount, "lines=", linesProcessed, "fullText_len=", fullText.length, "reasoning_len=", reasoningText.length);
          }
        }
        // Final paint — apply autoLink once so URLs become clickable.
        // Reasoning is intentionally dropped from the final render;
        // it already served its purpose as a live "thinking" trace.
        if (targetBubble && targetBubble.isConnected) {
          targetBubble.innerHTML = autoLink(fullText).replace(/\n/g, "<br>");
          log.scrollTop = log.scrollHeight;
        }
        if (!fullText) throw new Error("Empty stream from AI");
        console.log("[HelpMe] SSE: DONE. chars=", fullText.length, "chunks=", chunkCount, "reasoning_chars=", reasoningText.length, "elapsed_ms=", Math.round(performance.now() - t0));
        return fullText;
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    })();
  }

  // ── Bubble Renderer ────────────────────────────────────────────
  function appendBubble(role, text, opts = {}) {
      const bubble = document.createElement("div");
      const isUser = role === "user";
      bubble.className = `help-me-bubble ${role}${opts.pending ? " pending" : ""}${opts.error ? " error" : ""}`;
      bubble.style.cssText = isUser
        ? "align-self:flex-end;max-width:88%;background:rgba(255,107,53,0.25);padding:10px 14px;border-radius:14px 14px 4px 14px;margin:6px 12px;font-size:13px;color:#fff;line-height:1.5;"
        : "align-self:flex-start;max-width:88%;background:rgba(255,255,255,0.1);padding:10px 14px;border-radius:14px 14px 14px 4px;margin:6px 12px;font-size:13px;color:#fff;line-height:1.6;white-space:pre-wrap;";
      if (opts.pending) {
        bubble.innerHTML = '<span style="opacity:0.7;">Thinking… 🤔</span>';
      } else if (opts.error) {
        bubble.innerHTML = `<span style="color:#ff6b6b;">⚠️ ${escapeHtml(text)}</span>`;
      } else {
        bubble.innerHTML = autoLink(text).replace(/\n/g, "<br>");
      }
      log.appendChild(bubble);
      log.scrollTop = log.scrollHeight;
      return bubble;
    }

    // ── Prompt Builder ─────────────────────────────────────────────
    function buildPrompt(userText) {
      const turnHistory = transcript.map(t =>
        `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`
      ).join("\n");

      const viewportCtx = getViewportContext();
      const langHint = detectLanguage(userText);

      let prompt = `${fullSystemPrompt}${nearbyProblemsContext}${viewportCtx}

Reply in ${langHint}. Be warm and direct.

${turnHistory ? turnHistory + "\n" : ""}
User: ${userText}

Assistant: `;

      if (prompt.length > 7500) {
        prompt = prompt.substring(0, 7500) + "\n\nUser: " + userText + "\n\nAssistant: ";
      }
      return prompt;
    }

    // ── Send Question ───────────────────────────────────────────────
    async function sendQuestion(text) {
      const q = (text || "").trim();
      if (!q) return;

      if (XYZO_DEBUG) console.log("[HelpMe] sendQuestion:", q);

      const sendBtn = form.querySelector("button[type=submit]");
      sendBtn.disabled = true;
      input.disabled = true;

      if (!nearbyProblemsContext && userContext.lat && userContext.lng) {
        await fetchNearbyProblems();
      }

      if (log.dataset.empty === "true") {
        log.dataset.empty = "false";
        log.innerHTML = "";
      }

      appendBubble("user", q);
      transcript.push({ role: "user", content: q });
      const pending = appendBubble("assistant", "", { pending: true });

      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: buildPrompt(q), stream: true }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          let errMsg;
          try {
            const errBody = JSON.parse(errText);
            if (errBody.error?.name === "ZodError" && errBody.error?.issues?.length) {
              errMsg = `Message validation failed: ${errBody.error.issues[0].message}`;
            } else if (typeof errBody.error === "string") {
              errMsg = errBody.error + (errBody.message ? `: ${errBody.message}` : "");
            } else if (errBody.error) {
              errMsg = JSON.stringify(errBody.error) + (errBody.message ? `: ${errBody.message}` : "");
            } else {
              errMsg = `HTTP ${res.status}: ${errText.substring(0, 200)}`;
            }
          } catch {
            errMsg = `HTTP ${res.status}: ${errText.substring(0, 200)}`;
          }
          if (XYZO_DEBUG) console.error("[HelpMe] API error:", errMsg);
          throw new Error(errMsg);
        }

        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        console.log("[HelpMe] dispatch: content-type=", JSON.stringify(contentType), "has-body=", !!res.body);
        let reply;

        if (contentType.includes("text/event-stream") && res.body) {
          console.log("[HelpMe] dispatch: entering SSE path");
          reply = await readSseStream(res.body, pending);
        } else {
          console.log("[HelpMe] dispatch: falling back to JSON path");
          const data = await res.json();
          reply = (data.response || data.message || "I don't have an answer for that.").trim();
          pending.remove();
          appendBubble("assistant", reply);
        }

        transcript.push({ role: "assistant", content: reply });

        memory.conversations.push({ q, reply: reply.substring(0, 300), ts: now });
        if (memory.conversations.length > 20) memory.conversations = memory.conversations.slice(-20);

        const topicWords = q.toLowerCase().match(/\b(pakistan|flood|earthquake|war|economy|health|education|climate|job|scam|donation|police|corruption|politics|ukraine|gaza|india|china|bangladesh|myanmar|turkey|japan|indonesia|malaysia|philippines)\b/g);
        if (topicWords) {
          memory.topicsViewed.push(...topicWords);
          if (memory.topicsViewed.length > 50) memory.topicsViewed = memory.topicsViewed.slice(-50);
        }

        const problemTypes = q.toLowerCase().match(/\b(flood|earthquake|famine|war|conflict|pandemic|drought|landslide|fire|storm|heatwave|typhoon|cyclone|avalanche)\b/g);
        if (problemTypes) {
          memory.problemsSeen.push(...problemTypes.map(p => p.charAt(0).toUpperCase() + p.slice(1)));
          if (memory.problemsSeen.length > 30) memory.problemsSeen = memory.problemsSeen.slice(-30);
        }

        const actionMatch = reply.match(/\d+\.\s+\[([^\]]+)\]/);
        const shortTopic = q.toLowerCase().replace(/^(what|the|how|should|is|are|do|can|i|my)\b/gi, "").trim().substring(0, 60);
        if (actionMatch || reply.includes("can actually do")) {
          memory.lastRecommendation = {
            topic: shortTopic,
            suggestedAction: actionMatch ? actionMatch[1] : reply.substring(0, 100),
            fullReply: reply.substring(0, 400),
            ts: now,
          };
        }

        saveMemory(memory);

      } catch (e) {
        pending.remove();
        let errMsg = (e && e.message) ? e.message : String(e || "Unknown error");
        const lower = errMsg.toLowerCase();
        if (lower.includes("rate_limited") || lower.includes("429")) {
          errMsg = "We're getting a lot of questions right now! Give it a minute and try again 🙏";
        } else if (lower.includes("timeout") || lower.includes("504")) {
          errMsg = "The AI took too long to think. Try a shorter question — we're working on it! ⏳";
        } else if (lower.includes("unavailable") || lower.includes("502") || lower.includes("503")) {
          errMsg = "Our AI is taking a quick break. Try again in a moment 🔧";
        }
        if (errMsg.length > 300) errMsg = errMsg.substring(0, 300) + "...";
        appendBubble("assistant", errMsg, { error: true });
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

    suggestBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const suggest = btn.dataset.suggest;
        sendQuestion(suggest);
      });
    });

    closeBtn.addEventListener("click", () => { el.remove(); _chatEl = null; });
    const onKey = (e) => { if (e.key === "Escape" && _chatEl === el) { el.remove(); _chatEl = null; document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    setTimeout(() => input.focus(), 50);

    log.addEventListener("scroll", () => {
      if (log.children.length < 2) { jumpTopBtn.style.display = "none"; return; }
      const atTop = log.scrollTop < 40;
      jumpTopBtn.style.display = atTop ? "none" : "block";
    });

    jumpTopBtn.addEventListener("click", () => {
      log.scrollTo({ top: 0, behavior: "smooth" });
      jumpTopBtn.style.display = "none";
    });
  }

  function closeHelpMeChat() {
    if (!_chatEl) return;
    _chatEl.remove();
    _chatEl = null;
  }

  window.XyzoHelpMe = {
    open: openHelpMeChat,
    close: closeHelpMeChat,
    track: function (type, value) {
      try {
        const mem = loadMemory();
        if (type === "article" || type === "story") {
          if (!mem.storiesViewed) mem.storiesViewed = [];
          mem.storiesViewed.push({ title: value.substring(0, 100), ts: new Date().toISOString() });
          if (mem.storiesViewed.length > 30) mem.storiesViewed = mem.storiesViewed.slice(-30);
        } else if (type === "topic") {
          if (!mem.topicsViewed) mem.topicsViewed = [];
          mem.topicsViewed.push(value.toLowerCase());
          if (mem.topicsViewed.length > 50) mem.topicsViewed = mem.topicsViewed.slice(-50);
        } else if (type === "problem") {
          if (!mem.problemsSeen) mem.problemsSeen = [];
          mem.problemsSeen.push(value);
          if (mem.problemsSeen.length > 30) mem.problemsSeen = mem.problemsSeen.slice(-30);
        }
        saveMemory(mem);
      } catch {}
    },
  };
})();
