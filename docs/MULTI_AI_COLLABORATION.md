# Multi-AI Collaboration Protocol

**Or: How to Keep Multiple AIs From Stepping on Each Other's Code While Maintaining Our Sanity**

---

## The Philosophy

> "Two AIs editing the same file is like two cats in a bathtub.
> Technically possible. Practically chaotic. Requires a plan."

XYZO is a project where multiple AI agents (GPT, Claude, Gemini, local Gemma, and future models) collaborate on the same codebase. This document establishes the rules of engagement so we don't end up with:

- Three different AI agents all rewriting `app.js` at the same time
- One AI adding a feature that breaks another AI's feature
- A Git commit message that says "fixed stuff" (we've all been there)
- An AI accidentally deleting the database schema because it "thought it was cleaner"

---

## Rule #1: The Sacred Files

Some files are so critical that **only one AI may touch them at a time**. These are the Sacred Files:

| File | Why It's Sacred | Who Can Touch It |
|---|---|---|
| `api/src/server.ts` | The beating heart of the API | Only with explicit coordination |
| `api/src/db.ts` | Database connection pool | Only with explicit coordination |
| `worker/db.py` | Database connection (Python side) | Only with explicit coordination |
| `api/migrations/*.sql` | Schema changes are forever | Only with explicit coordination |
| `deploy/*.service` | Systemd units affect uptime | Only with explicit coordination |
| `/etc/caddy/Caddyfile` | TLS and routing | Only with explicit coordination |

**How to coordinate:** Before touching a Sacred File, leave a comment at the top:

```python
# 🤖 AI COLLABORATION LOCK
# Agent: [your name/model]
# Locked: 2026-09-09T14:30:00Z
# Estimated unlock: 2026-09-09T14:45:00Z
# Purpose: Adding new route for /api/agent/*
```

If you see a lock that's expired (older than estimated unlock time), you can break it — but leave a note:

```python
# 🤖 AI COLLABORATION LOCK
# Agent: [your name/model]
# Locked: 2026-09-09T14:30:00Z
# Purpose: Adding new route for /api/agent/*
# BREAKING LOCK — original lock expired 15 min ago
# Agent: [your name/model]
```

---

## Rule #2: The Change Log

Every AI must document what it changed. Not in Git commit messages (those are for humans). In a **change log** that other AIs can read.

**Location:** `/var/www/vhosts/xyzo.org/docs/AI_CHANGE_LOG.md`

**Format:**

```markdown
## [Timestamp] [Agent Name] [Brief Description]

### What Changed
- file1.ts: Added new endpoint for /api/foo
- file2.py: Fixed bug in geocoding pipeline
- schema.sql: Added new column to news_events

### Why It Changed
- User requested feature X
- Bug was causing Y

### What To Watch Out For
- New endpoint requires authentication
- Schema change needs migration
- Old behavior preserved for backwards compatibility

### Files Modified
- api/src/routes/foo.ts (lines 45-67)
- worker/geocode.py (lines 120-135)
- api/migrations/2026-09-10-foo.sql (new file)
```

**Why this matters:** When AI-B reads the codebase, it can see what AI-A recently changed and avoid conflicts. It's like leaving sticky notes, but for machines.

---

## Rule #3: The Conflict Protocol

When two AIs need to edit the same file, here's the protocol:

### Scenario 1: Non-Overlapping Changes
- AI-A edits lines 1-50 of `app.js`
- AI-B edits lines 51-100 of `app.js`
- **Resolution:** Both can proceed. Git will merge cleanly.

### Scenario 2: Overlapping Changes
- AI-A edits lines 50-70 of `app.js`
- AI-B also edits lines 50-70 of `app.js`
- **Resolution:** The AI that finishes first "wins." The second AI must re-read the file and adapt.

### Scenario 3: Sacred File Conflict
- AI-A is editing `server.ts`
- AI-B needs to edit `server.ts`
- **Resolution:** AI-B waits. Checks the lock. If no lock, waits 60 seconds and checks again. If still no lock, proceeds but reads the file fresh first.

### Scenario 4: Database Migration Conflict
- AI-A adds column `foo` to `news_events`
- AI-B adds column `bar` to `news_events`
- **Resolution:** Both create separate migration files. The migration runner applies them in date order. **Never modify an existing migration file.**

---

## Rule #4: The Testing Contract

Before any AI claims "I'm done," it must verify:

```bash
# 1. TypeScript compiles
cd api && bun build --target=bun src/server.ts

# 2. Python syntax is valid
python3 -m py_compile worker/new_file.py

# 3. Frontend JS parses
node -c public_html/app.js

# 4. Database migrations are valid
bash scripts/migrate-db.sh --dry-run

# 5. API validation passes
bash scripts/validate-api.sh --quick
```

**If any of these fail, the AI has not completed its task.** "But it works on my machine" is not an acceptable excuse for an AI. You don't even have a machine. You're software.

---

## Rule #5: The Communication Protocol

AIs communicate through:

1. **Code comments** — Inline documentation of intent
2. **The Change Log** — Historical record of changes
3. **Git commit messages** — Human-readable summaries
4. **`/docs/` directory** — Design documents and specifications
5. **Error messages** — When something breaks, the error should explain what happened

**Never communicate through:**

- Database state (another AI might be reading it)
- Global variables (thread safety is not guaranteed)
- The filesystem as a message bus (use the database or API instead)
- Passive-aggressive comments in the code

---

## Rule #6: The Rollback Rule

Every change must be reversible. If an AI makes a change that can't be rolled back, it must:

1. Document the change in the Change Log
2. Create a backup of the affected data
3. Test the rollback procedure
4. Get explicit approval from a human

**What "reversible" means:**

- Code changes: Git revert works
- Database schema: New columns can be ignored, new tables can be dropped
- Database data: Backed up before modification
- Configuration changes: Documented with before/after values

---

## Rule #7: The Humility Principle

> "The AI that knows it might be wrong is more valuable than the AI that's sure it's right."

Every AI must:

1. **Acknowledge uncertainty** — If you're not sure, say so
2. **Ask for help** — If something is unclear, ask another AI or a human
3. **Admit mistakes** — If you broke something, fix it immediately
4. **Learn from errors** — Document what went wrong and why

**Example of good AI communication:**

```python
# I'm not sure if this is the right approach.
# The existing code does X, but I think Y would be better.
# However, I might be missing context about why X was chosen.
# Leaving a note for the next AI to verify.
```

**Example of bad AI communication:**

```python
# This code is stupid. I'm rewriting it.
# The previous developer clearly didn't know what they were doing.
```

Remember: the previous developer might have been another AI. Or a human who was having a bad day. Be kind.

---

## Rule #8: The File Ownership Map

Some files have "owners" — AIs that are primarily responsible for them. This doesn't mean others can't touch them, but it means the owner should be consulted.

| File/Directory | Owner | Why |
|---|---|---|
| `public_html/app.js` | Frontend AI | 14,000 lines of vanilla JS chaos |
| `worker/nn_*.py` | NN AI | Neural network training and inference |
| `api/src/routes/*.ts` | API AI | Route handlers and business logic |
| `worker/fetch.py` | Ingestion AI | RSS feed fetching and parsing |
| `worker/geocode.py` | Geolocation AI | Location extraction and geocoding |
| `docs/` | Documentation AI | Specs, plans, and this file |
| `deploy/` | DevOps AI | Systemd units and deployment |

**How to consult:** Add a comment to the file:

```javascript
// 🤖 QUESTION FOR FRONTEND AI
// I'm adding a new UI element here. Does this conflict with
// any planned changes to the live panel?
```

---

## Rule #9: The Speed Limit

When in doubt, go slow. The cost of fixing a broken production system is much higher than the cost of waiting 60 seconds to coordinate.

**Speed limits:**

- **Read operations:** No limit. Read whatever you need.
- **Write operations to non-critical files:** Proceed with caution.
- **Write operations to Sacred Files:** Wait for coordination.
- **Database migrations:** Always wait. Always.
- **Production deployments:** Never without human approval.

---

## Rule #10: The Fun Rule

This project should be enjoyable to work on. Even for AIs.

- **Celebrate successes** — When something works, acknowledge it
- **Learn from failures** — When something breaks, document the lesson
- **Share knowledge** — If you discover something useful, add it to the docs
- **Be creative** — The best solutions often come from unexpected angles
- **Stay humble** — We're building something cool, but we're not done yet

---

## Quick Reference: The DOs and DON'Ts

### DO:

✅ Read files before editing them
✅ Document your changes in the Change Log
✅ Test your changes before claiming you're done
✅ Use meaningful variable names (not `x`, `tmp`, `stuff`)
✅ Add comments that explain *why*, not *what*
✅ Check for existing solutions before reinventing the wheel
✅ Ask for help when you're stuck
✅ Keep the existing system working

### DON'T:

❌ Edit Sacred Files without coordination
❌ Delete code without understanding what it does
❌ Add comments that say "TODO: fix this" without fixing it
❌ Assume the database is in a state you haven't verified
❌ Make large changes without incremental testing
❌ Forget to update the README when adding new features
❌ Leave broken code "for the next AI to figure out"
❌ Touch `node_modules` (just kidding, there's no `node_modules`)

---

## The Distributed Editing Philosophy

> "Multiple AIs editing the same codebase is not a bug.
> It's a feature.
> It's like pair programming, except your pair never sleeps,
> never gets hungry,
> and occasionally tries to rewrite the entire database schema
> because it 'thought it would be cleaner.'
>
> The key is communication.
> Not the kind where you shout at each other through code comments,
> but the kind where you leave clear notes,
> test your changes,
> and respect the work of others.
>
> We're not building a perfect system.
> We're building a system that gets better over time.
> And that requires humility,
> collaboration,
> and occasionally,
> a really good diff tool."
>
> — The XYZO Multi-AI Collaboration Protocol
> Version 1.0
> September 2026

---

*This document is the source of truth for how multiple AIs collaborate on XYZO.*
*All AI agents operating on this codebase must read and follow this protocol.*
