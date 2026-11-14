# hivv Plan G — Open Governance + Community

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the hivv protocol to community governance. End state: anyone can submit an RFC, decisions are logged immutably, weekly community call happens on Wednesdays 16:00 UTC, the dashboard has a "🏛️ GOVERNANCE" widget, and `hivv.org` (separate from xyzo.org) carries the public-facing governance artifacts.

**Architecture:** A `hivv-org/` GitHub org with three repos: `hivv-spec` (canonical, xyzo is one consumer), `hivv-rfcs` (PR-based proposals), `hivv-decisions` (append-only ADRs). A Postgres table mirrors decisions into xyzo's dashboard. The community call uses a public agenda doc + Jitsi/BBB room. The dashboard widget reads from the decisions table.

**Tech Stack:** Git + GitHub Actions, Markdown + MkDocs for hivv.org, Postgres mirror table, Hono endpoint, no new app deps.

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` §12

**Prerequisites:** Plans A–F shipped + green. Spec is published.

**Out of scope:** Migrating xyzo's internal governance to hivv-org (separate work; this plan makes the *mechanism* available).

**Cross-cutting invariants:**
1. **Decisions are append-only.** No deletion of ADRs. If a decision is reversed, a new ADR is written that reverses it.
2. **RFCs are PRs.** No special tooling; GitHub's review/discussion model is the API.
3. **No voting in code.** Voting is sociotechnical; the protocol provides the agenda + meeting minutes, not the decision itself.
4. **One canonical spec.** The spec lives in `hivv-spec/`. xyzo's `docs/superpowers/specs/` is a *copy against a tagged release* of hivv-spec, not the source.
5. **Public-by-default.** Governance artifacts are public. Private deliberation is the exception, not the rule, and is logged as such.

---

## File Structure

```
api/migrations/
  2026-09-13-governance.sql                     (Task 1 — mirror tables)

api/src/routes/
  governance.ts                                 (Task 2 — public read endpoint)
  governance-admin.ts                           (Task 3 — admin sync endpoint)

worker/governance/
  sync_decisions.py                             (Task 4 — pull from hivv-decisions repo)
  publish_weekly_agenda.py                      (Task 5)
  community_call_checklist.md                   (Task 6)

scripts/systemd/
  hivv-governance-sync.service                  (Task 7)
  hivv-governance-sync.timer                    (Task 7)
  hivv-weekly-agenda.service                    (Task 7)
  hivv-weekly-agenda.timer                      (Task 7)

public/dashboard/governance/
  index.html                                    (Task 8)
  governance.css                                (Task 8)

mkdocs.yml                                      (Task 9)
docs/governance/
  index.md                                      (Task 9)
  process.md                                    (Task 9)
  decision-log.md                               (Task 9)
  rfc-process.md                                (Task 9)
  code-of-conduct.md                            (Task 9)

.github/workflows/
  sync-rfcs.yml                                 (Task 10)
  publish-spec.yml                              (Task 10)

docs/hivv-plan-g-summary.md                     (Task 11)
```

---

## Task Index

- Task 1: Governance mirror schema (decisions + RFCs + meetings)
- Task 2: Public read endpoint
- Task 3: Admin sync endpoint
- Task 4: Decision sync worker
- Task 5: Weekly agenda publisher
- Task 6: Community call checklist
- Task 7: systemd timers
- Task 8: Governance dashboard widget
- Task 9: hivv.org MkDocs site (5 pages)
- Task 10: GitHub Actions (sync RFCS, publish spec)
- Task 11: Summary + handoff

---

### Task 1: Governance mirror schema

**Files:**
- Create: `api/migrations/2026-09-13-governance.sql`

- [ ] **Step 1: Write migration**

```sql
-- ── 2026-09-13-governance.sql ────────────────────────────────────────
-- Mirror of hivv-org governance artifacts into xyzo's dashboard.
-- The source of truth lives in github.com/hivv-org/{hivv-spec,hivv-rfcs,hivv-decisions}.
-- This mirror is rebuilt every 15 minutes by worker/governance/sync_decisions.py.
BEGIN;

CREATE TYPE decision_status AS ENUM ('proposed','accepted','rejected','superseded','reversed');
CREATE TYPE rfc_status AS ENUM ('draft','reviewing','accepted','rejected','withdrawn');

CREATE TABLE decisions (
  id BIGSERIAL PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,            -- 'ADR-0001' etc
  title TEXT NOT NULL,
  status decision_status NOT NULL,
  decided_on DATE NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  consequences TEXT,
  supersedes TEXT,
  reversed_by TEXT,
  source_url TEXT NOT NULL,
  raw_markdown TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON decisions (decided_on DESC);
CREATE INDEX ON decisions (status);

-- Append-only: forbid UPDATE/DELETE
CREATE OR REPLACE FUNCTION decisions_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decisions is append-only; write a reversing ADR instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decisions_no_update BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_append_only();

CREATE TABLE rfcs (
  id BIGSERIAL PRIMARY KEY,
  rfc_number INT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status rfc_status NOT NULL,
  author TEXT NOT NULL,
  created_on DATE NOT NULL,
  pr_url TEXT NOT NULL,
  discussion_url TEXT,
  summary TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON rfcs (rfc_number DESC);
CREATE INDEX ON rfcs (status);

CREATE TABLE meetings (
  id BIGSERIAL PRIMARY KEY,
  scheduled_for TIMESTAMPTZ NOT NULL UNIQUE,
  agenda_url TEXT NOT NULL,
  minutes_url TEXT,
  recording_url TEXT,
  attendee_count INT,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  decisions_referenced TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX ON meetings (scheduled_for DESC);

GRANT SELECT ON decisions, rfcs, meetings TO xyzo_app, xyzo_public;
GRANT INSERT, UPDATE ON meetings TO xyzo_app, xyzo_owner;

COMMIT;
```

- [ ] **Step 2: Apply + commit**

```bash
cd api && bun run db:migrate -- up migrations/2026-09-13-governance.sql
psql $XYZO_DB_DSN -c "\dt" | grep -E "decisions|rfcs|meetings"
git add api/migrations/2026-09-13-governance.sql
git commit -m "feat(hivv-G): governance mirror schema (decisions + rfcs + meetings)"
```

---

### Task 2: Public read endpoint

**Files:**
- Create: `api/src/routes/governance.ts`

- [ ] **Step 1: Write route**

```ts
// api/src/routes/governance.ts
// Public read of governance artifacts. No auth.
import { Hono } from "hono";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

export const governanceRoutes = new Hono();

governanceRoutes.use("/api/governance/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  await next();
});

governanceRoutes.get("/api/governance/decisions", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
  const rows = await sql`
    SELECT decision_id, title, status, decided_on, summary, source_url
    FROM decisions ORDER BY decided_on DESC LIMIT ${limit}
  `;
  return c.json({ decisions: rows });
});

governanceRoutes.get("/api/governance/decisions/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await sql`SELECT * FROM decisions WHERE decision_id = ${id}`;
  if (!row) return c.json({error: "not_found"}, 404);
  return c.json(row);
});

governanceRoutes.get("/api/governance/rfcs", async (c) => {
  const rows = await sql`
    SELECT rfc_number, title, status, author, pr_url, summary
    FROM rfcs ORDER BY rfc_number DESC LIMIT 50
  `;
  return c.json({ rfcs: rows });
});

governanceRoutes.get("/api/governance/meetings", async (c) => {
  const rows = await sql`
    SELECT scheduled_for, agenda_url, minutes_url, recording_url,
           attendee_count, topics
    FROM meetings ORDER BY scheduled_for DESC LIMIT 20
  `;
  return c.json({ meetings: rows });
});
```

- [ ] **Step 2: Wire + commit**

```bash
# In api/src/server.ts: app.route("/", governanceRoutes);

git add api/src/routes/governance.ts api/src/server.ts
git commit -m "feat(hivv-G): /api/governance/* public read endpoints"
```

---

### Task 3: Admin sync endpoint

**Files:**
- Create: `api/src/routes/governance-admin.ts`

- [ ] **Step 1: Write route**

```ts
// api/src/routes/governance-admin.ts
// Owner-only: trigger a manual sync of the governance mirror.
import { Hono } from "hono";
import { spawn } from "bun";
import { requireOwner } from "../middleware/owner";

export const governanceAdminRoutes = new Hono();
governanceAdminRoutes.use("/api/governance/admin/*", requireOwner());

governanceAdminRoutes.post("/api/governance/admin/sync", async (c) => {
  const proc = spawn({
    cmd: ['python3', '-m', 'worker.governance.sync_decisions'],
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return c.json({ok: code === 0, stdout, stderr});
});
```

- [ ] **Step 2: Wire + commit**

```bash
# In api/src/server.ts: app.route("/", governanceAdminRoutes);

git add api/src/routes/governance-admin.ts api/src/server.ts
git commit -m "feat(hivv-G): /api/governance/admin/sync owner trigger"
```

---

### Task 4: Decision sync worker

**Files:**
- Create: `worker/governance/sync_decisions.py`

- [ ] **Step 1: Write sync worker**

```python
"""sync_decisions.py — pull ADRs and RFCs from hivv-org GitHub repos into Postgres.
Spec: §12. Idempotent. Runs every 15 minutes via systemd timer.
"""
import logging, os, re, json
from datetime import datetime, date
from pathlib import Path
import psycopg
import urllib.request, base64

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')               # optional; raises rate limit
DECISIONS_REPO = os.environ.get('HIVV_DECISIONS_REPO', 'hivv-org/hivv-decisions')
RFCS_REPO      = os.environ.get('HIVV_RFCS_REPO',      'hivv-org/hivv-rfcs')
SPEC_REPO      = os.environ.get('HIVV_SPEC_REPO',      'hivv-org/hivv-spec')

def gh_get(path: str) -> tuple[bytes, dict]:
    req = urllib.request.Request(f"https://api.github.com{path}", headers={
        'Accept': 'application/vnd.github+json',
        **({'Authorization': f'Bearer {GITHUB_TOKEN}'} if GITHUB_TOKEN else {}),
    })
    with urllib.request.urlopen(req) as r:
        return r.read(), dict(r.headers)

def gh_list_dir(repo: str, path: str) -> list[dict]:
    body, _ = gh_get(f"/repos/{repo}/contents/{path}")
    return json.loads(body)

def gh_get_raw(repo: str, path: str) -> bytes:
    body, _ = gh_get(f"/repos/{repo}/contents/{path}")
    return base64.b64decode(json.loads(body)['content'])

def parse_adr(md: bytes) -> dict:
    """Parse an ADR-style markdown file."""
    text = md.decode('utf-8', errors='replace')
    decision_id = ''
    title = ''
    status = 'proposed'
    decided_on = None
    summary = ''
    rationale = ''
    consequences = ''
    supersedes = ''
    reversed_by = ''
    m = re.search(r'#\s+(ADR-\d+):\s*(.+)', text)
    if m:
        decision_id, title = m.group(1), m.group(2).strip()
    else:
        m = re.search(r'#\s+(.+)', text)
        if m: title = m.group(1).strip()
    m = re.search(r'\*\*Status\*\*:\s*(\w+)', text)
    if m: status = m.group(1).lower()
    m = re.search(r'\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})', text)
    if m: decided_on = date.fromisoformat(m.group(1))
    m = re.search(r'## Summary\s+(.+?)(?=##|\Z)', text, re.DOTALL)
    if m: summary = m.group(1).strip()
    m = re.search(r'## Decision\s+(.+?)(?=##|\Z)', text, re.DOTALL)
    if m: rationale = m.group(1).strip()
    m = re.search(r'## Consequences\s+(.+?)(?=##|\Z)', text, re.DOTALL)
    if m: consequences = m.group(1).strip()
    m = re.search(r'\*\*Superseded by\*\*:\s*(.+)', text)
    if m: supersedes = m.group(1).strip()
    m = re.search(r'\*\*Reversed by\*\*:\s*(.+)', text)
    if m: reversed_by = m.group(1).strip()
    return {
        'decision_id': decision_id or f"ADR-UNKNOWN-{hash(text) & 0xffff:04x}",
        'title': title, 'status': status,
        'decided_on': decided_on or date.today(),
        'summary': summary, 'rationale': rationale,
        'consequences': consequences, 'supersedes': supersedes,
        'reversed_by': reversed_by,
    }

def sync_decisions() -> int:
    """Returns the number of decisions synced."""
    files = gh_list_dir(DECISIONS_REPO, '/')
    n = 0
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            for f in files:
                if not f['name'].endswith('.md'): continue
                if not re.match(r'^\d{4}-', f['name']): continue
                try:
                    md = gh_get_raw(DECISIONS_REPO, f['path'])
                    parsed = parse_adr(md)
                    cur.execute("""
                        INSERT INTO decisions (decision_id, title, status, decided_on,
                                               summary, rationale, consequences,
                                               supersedes, reversed_by, source_url, raw_markdown)
                        VALUES (%s, %s, %s::decision_status, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (decision_id) DO NOTHING
                    """, (parsed['decision_id'], parsed['title'], parsed['status'],
                          parsed['decided_on'], parsed['summary'], parsed['rationale'],
                          parsed['consequences'], parsed['supersedes'], parsed['reversed_by'],
                          f['html_url'], md.decode('utf-8', errors='replace')))
                    n += 1
                except Exception as e:
                    log.warning("failed to sync %s: %s", f['name'], e)
        c.commit()
    log.info("synced %d decisions", n)
    return n

def sync_rfcs() -> int:
    """Returns the number of RFCs synced (from PRs)."""
    prs, _ = gh_get(f"/repos/{RFCS_REPO}/pulls?state=all&per_page=100")
    n = 0
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            for pr in json.loads(prs):
                m = re.match(r'^RFC[-_]?(\d+):', pr['title'])
                if not m: continue
                rfc_number = int(m.group(1))
                status = {'open':'reviewing','closed': 'accepted' if pr.get('merged_at') else 'rejected'}.get(pr['state'], 'draft')
                if pr.get('draft'): status = 'draft'
                cur.execute("""
                    INSERT INTO rfcs (rfc_number, title, status, author, created_on, pr_url, discussion_url, summary)
                    VALUES (%s, %s, %s::rfc_status, %s, %s::date, %s, %s, %s)
                    ON CONFLICT (rfc_number) DO UPDATE SET
                      status = EXCLUDED.status,
                      pr_url = EXCLUDED.pr_url,
                      discussion_url = EXCLUDED.discussion_url
                """, (rfc_number, pr['title'], status, pr['user']['login'],
                      pr['created_at'][:10], pr['html_url'],
                      pr.get('issue_url'), (pr.get('body') or '')[:500]))
                n += 1
        c.commit()
    log.info("synced %d RFCs", n)
    return n

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, stream=__import__('sys').stderr)
    a = sync_decisions()
    b = sync_rfcs()
    print(json.dumps({"decisions": a, "rfcs": b}))
```

- [ ] **Step 2: Commit**

```bash
git add worker/governance/sync_decisions.py
git commit -m "feat(hivv-G): decision + RFC sync from hivv-org GitHub"
```

---

### Task 5: Weekly agenda publisher

**Files:**
- Create: `worker/governance/publish_weekly_agenda.py`

- [ ] **Step 1: Write publisher**

```python
"""publish_weekly_agenda.py — write the agenda for the upcoming Wednesday community call.
Spec: §12 — every Wednesday 16:00 UTC.
"""
import logging, os, sys, json
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
import psycopg

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']
AGENDA_DIR = Path('public/dashboard/governance/agendas')
AGENDA_DIR.mkdir(parents=True, exist_ok=True)

def next_wednesday_16_utc() -> datetime:
    now = datetime.now(timezone.utc)
    days_ahead = (2 - now.weekday()) % 7
    if days_ahead == 0 and now.hour >= 16:
        days_ahead = 7
    return (now + timedelta(days=days_ahead)).replace(hour=16, minute=0, second=0, microsecond=0)

def recent_decisions(limit: int = 5) -> list[dict]:
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                SELECT decision_id, title, summary, source_url
                FROM decisions ORDER BY decided_on DESC LIMIT %s
            """, (limit,))
            return [dict(r) for r in cur.fetchall()]

def open_rfcs(limit: int = 10) -> list[dict]:
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                SELECT rfc_number, title, author, pr_url FROM rfcs
                WHERE status IN ('draft','reviewing') ORDER BY rfc_number DESC LIMIT %s
            """, (limit,))
            return [dict(r) for r in cur.fetchall()]

def write_agenda() -> Path:
    when = next_wednesday_16_utc()
    decisions = recent_decisions()
    rfcs = open_rfcs()

    md = [f"# hivv community call — {when.date().isoformat()}",
          "",
          f"_Wednesday {when.date().isoformat()} at 16:00 UTC_",
          "",
          "_Where: Jitsi room https://meet.hivv.org/community (open, no signup)_",
          "_Agenda doc: this file. Add your name to any topic you want to discuss._",
          "",
          "## Recent decisions",
          ""]
    if not decisions:
        md.append("_No recent decisions._")
    for d in decisions:
        md.append(f"- **{d['decision_id']}**: {d['title']} ([source]({d['source_url']}))")
    md += ["", "## Open RFCs", ""]
    if not rfcs:
        md.append("_No open RFCs._")
    for r in rfcs:
        md.append(f"- **RFC-{r['rfc_number']}**: {r['title']} by @{r['author']} ([PR]({r['pr_url']}))")
    md += ["", "## Topics anyone can add", "",
           "- (your topic here — open a PR against this file)",
           "",
           f"_Generated at {datetime.now(timezone.utc).isoformat()}_"]

    out = AGENDA_DIR / f"{when.date().isoformat()}.md"
    out.write_text("\n".join(md) + "\n", encoding='utf-8')
    log.info("wrote agenda: %s", out)
    return out

def upsert_meeting_row(agenda_path: Path) -> None:
    when = next_wednesday_16_utc()
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                INSERT INTO meetings (scheduled_for, agenda_url)
                VALUES (%s, %s)
                ON CONFLICT (scheduled_for) DO UPDATE SET agenda_url = EXCLUDED.agenda_url
            """, (when, f"/dashboard/governance/agendas/{when.date().isoformat()}.md"))
        c.commit()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    p = write_agenda()
    upsert_meeting_row(p)
    print(p)
```

- [ ] **Step 2: Commit**

```bash
git add worker/governance/publish_weekly_agenda.py
git commit -m "feat(hivv-G): weekly agenda publisher (Wed 16:00 UTC, Jitsi)"
```

---

### Task 6: Community call checklist

**Files:**
- Create: `worker/governance/community_call_checklist.md`

- [ ] **Step 1: Write checklist**

```markdown
# hivv community call — facilitator checklist

Weekly. Wednesday 16:00 UTC. Jitsi: https://meet.hivv.org/community (open).

## 10 minutes before

- [ ] Open the Jitsi room. Note attendees as they join.
- [ ] Pull up the agenda doc from `public/dashboard/governance/agendas/YYYY-MM-DD.md`.
- [ ] Open the dashboard at `/dashboard/governance` so attendees can see live data.
- [ ] Open the decisions log (`/api/governance/decisions`) and the RFCs list (`/api/governance/rfcs`).

## At 16:00 UTC

- [ ] Welcome. State the date and the agenda link.
- [ ] "Anything new to add to the agenda?" (silence for ~30 seconds).
- [ ] Walk through recent decisions (5 minutes).
- [ ] Walk through open RFCs (10 minutes).
- [ ] Open floor (15 minutes).
- [ ] Notice of next call: same time next Wednesday.

## After

- [ ] Write minutes to `public/dashboard/governance/minutes/YYYY-MM-DD.md` within 24 hours.
- [ ] Update the `meetings` row with `minutes_url`, `attendee_count`, and `topics` JSON.
- [ ] Record the Jitsi session (with consent) and add the recording URL to the row.
- [ ] Post the minutes link to the hivv-org/community channel.

## Decision-making in calls

- Calls discuss; they do not vote.
- Decisions happen in PRs (RFCs → ADRs).
- If a call reaches consensus that an RFC should be merged, the RFC author opens a PR within 7 days.

## Conflicts

- If a participant is being disruptive: facilitator names the behaviour, redirects to the code of conduct, and warns.
- If it continues: mute. The call continues.
- Persistent issues go to the hivv-org/moderation team.

## Recording

- The default is OFF (no recording).
- A recording requires explicit consent at the start of the call.
- Recordings are uploaded to hivv-org/community-recordings (public).
- Anyone who objects to being recorded can keep their camera off and ask not to be quoted.
```

- [ ] **Step 2: Commit**

```bash
git add worker/governance/community_call_checklist.md
git commit -m "docs(hivv-G): community call facilitator checklist"
```

---

### Task 7: systemd timers

**Files:**
- Create: `scripts/systemd/hivv-governance-sync.{service,timer}`
- Create: `scripts/systemd/hivv-weekly-agenda.{service,timer}`

- [ ] **Step 1: Sync service**

```ini
# scripts/systemd/hivv-governance-sync.service
[Unit]
Description=hivv — sync decisions + RFCs from hivv-org GitHub

[Service]
Type=oneshot
WorkingDirectory=/var/www/vhosts/xyzo.org
EnvironmentFile=/etc/hivv/env
User=hivv
ExecStart=/usr/bin/python3 -m worker.governance.sync_decisions
Nice=10
```

- [ ] **Step 2: Sync timer (every 15 minutes)**

```ini
# scripts/systemd/hivv-governance-sync.timer
[Unit]
Description=hivv — pull governance from hivv-org every 15 min

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Agenda service**

```ini
# scripts/systemd/hivv-weekly-agenda.service
[Unit]
Description=hivv — publish next Wednesday's community call agenda

[Service]
Type=oneshot
WorkingDirectory=/var/www/vhosts/xyzo.org
EnvironmentFile=/etc/hivv/env
User=hivv
ExecStart=/usr/bin/python3 -m worker.governance.publish_weekly_agenda
Nice=10
```

- [ ] **Step 4: Agenda timer (Monday 12:00 UTC, two days before call)**

```ini
# scripts/systemd/hivv-weekly-agenda.timer
[Unit]
Description=hivv — publish weekly agenda Monday noon

[Timer]
OnCalendar=Mon *-*-* 12:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Install + commit**

```bash
sudo cp scripts/systemd/hivv-governance-sync.{service,timer} /etc/systemd/system/
sudo cp scripts/systemd/hivv-weekly-agenda.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hivv-governance-sync.timer hivv-weekly-agenda.timer
git add scripts/systemd/
git commit -m "feat(hivv-G): systemd timers (15-min sync, Mon 12:00 agenda)"
```

---

### Task 8: Governance dashboard widget

**Files:**
- Create: `public/dashboard/governance/index.html`
- Create: `public/dashboard/governance/governance.css`

- [ ] **Step 1: index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hivv — Governance</title>
  <link rel="stylesheet" href="/dashboard/governance/governance.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <header>
    <h1>🏛️ hivv governance</h1>
    <p class="tagline">Decisions are append-only. RFCs are PRs. The community meets Wednesdays 16:00 UTC.</p>
  </header>
  <main id="main" tabindex="-1">
    <section aria-labelledby="next-meeting">
      <h2 id="next-meeting">Next community call</h2>
      <div id="next-meeting-body" aria-live="polite"><p>Loading…</p></div>
    </section>

    <section aria-labelledby="recent-decisions">
      <h2 id="recent-decisions">Recent decisions</h2>
      <div id="recent-decisions-body"><p>Loading…</p></div>
    </section>

    <section aria-labelledby="open-rfcs">
      <h2 id="open-rfcs">Open RFCs</h2>
      <div id="open-rfcs-body"><p>Loading…</p></div>
    </section>

    <section aria-labelledby="past-meetings">
      <h2 id="past-meetings">Past meetings</h2>
      <div id="past-meetings-body"><p>Loading…</p></div>
    </section>
  </main>
  <script>
    async function fetchInto(id, url, render) {
      const el = document.getElementById(id);
      try {
        const r = await fetch(url);
        const data = await r.json();
        el.innerHTML = render(data);
      } catch (e) {
        el.innerHTML = `<p role="alert">Failed to load: ${e.message}</p>`;
      }
    }
    fetchInto('recent-decisions-body', '/api/governance/decisions?limit=10', (d) => {
      if (!d.decisions?.length) return '<p>No decisions yet.</p>';
      return '<ul>' + d.decisions.map(x =>
        `<li><strong><a href="${x.source_url}">${x.decision_id}</a></strong>: ${x.title}
         <small>(${x.status}, ${x.decided_on})</small></li>`
      ).join('') + '</ul>';
    });
    fetchInto('open-rfcs-body', '/api/governance/rfcs', (d) => {
      if (!d.rfcs?.length) return '<p>No open RFCs.</p>';
      return '<ul>' + d.rfcs.map(x =>
        `<li><strong>RFC-${x.rfc_number}</strong>: ${x.title} <small>by @${x.author}, ${x.status}</small>
         — <a href="${x.pr_url}">PR</a></li>`
      ).join('') + '</ul>';
    });
    fetchInto('next-meeting-body', '/api/governance/meetings', (d) => {
      const next = d.meetings?.[0];
      if (!next) return '<p>No meeting scheduled. Community calls are weekly Wednesday 16:00 UTC.</p>';
      const when = new Date(next.scheduled_for);
      return `<p><strong>${when.toUTCString()}</strong></p>
              <p><a href="${next.agenda_url}">Agenda</a></p>`;
    });
    fetchInto('past-meetings-body', '/api/governance/meetings', (d) => {
      if (!d.meetings?.length) return '<p>No past meetings logged.</p>';
      return '<ul>' + d.meetings.map(x =>
        `<li>${new Date(x.scheduled_for).toUTCString()}
         — ${x.minutes_url ? `<a href="${x.minutes_url}">minutes</a>` : 'no minutes yet'}
         ${x.recording_url ? ` · <a href="${x.recording_url}">recording</a>` : ''}</li>`
      ).join('') + '</ul>';
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: governance.css (a11y-first, reuses Plan D palette)**

```css
body {
  font-family: ui-sans-serif, system-ui, sans-serif;
  margin: 0; padding: 0;
  background: var(--bg, #fafafa); color: var(--fg, #1a1a1a);
  line-height: 1.5;
}
header {
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border, #d0d0d0);
  border-top: 4px solid #9467bd;
}
header h1 { margin: 0; font-size: 1.5rem; }
header .tagline { margin: 0; color: #555; font-size: 0.875rem; }
main { padding: 1rem 2rem; max-width: 60rem; margin: 0 auto; }
main section { margin-bottom: 2rem; }
main h2 { font-size: 1.125rem; margin-top: 2rem; }
.skip-link {
  position: absolute; top: -40px; left: 0;
  background: #0066cc; color: white; padding: 0.5rem 1rem; z-index: 100;
}
.skip-link:focus { top: 0; }
:focus-visible { outline: 3px solid #ff8800; outline-offset: 2px; }
ul { padding-left: 1.5rem; }
li { margin-bottom: 0.5rem; }
small { color: #555; }
```

- [ ] **Step 3: Commit**

```bash
git add public/dashboard/governance/
git commit -m "feat(hivv-G): /dashboard/governance widget (a11y-first)"
```

---

### Task 9: hivv.org MkDocs site

**Files:**
- Create: `mkdocs.yml`
- Create: `docs/governance/index.md`
- Create: `docs/governance/process.md`
- Create: `docs/governance/decision-log.md`
- Create: `docs/governance/rfc-process.md`
- Create: `docs/governance/code-of-conduct.md`

- [ ] **Step 1: mkdocs.yml**

```yaml
site_name: hivv
site_description: A distributed, local-first control plane for human-AI coordination.
repo_url: https://github.com/hivv-org/hivv-spec
site_url: https://hivv.org

theme:
  name: material
  palette:
    primary: deep purple
    accent: amber

nav:
  - Home: governance/index.md
  - Process: governance/process.md
  - Decision log: governance/decision-log.md
  - RFC process: governance/rfc-process.md
  - Code of conduct: governance/code-of-conduct.md

markdown_extensions:
  - admonition
  - toc:
      permalink: true
  - footnotes
```

- [ ] **Step 2: index.md**

```markdown
# hivv

A distributed, local-first control plane for human-AI coordination.

## What this site is

This is the public home of the hivv protocol. xyzo.org is one deployment of hivv;
hivv.org is the project itself.

## How to participate

- **Read the spec:** [github.com/hivv-org/hivv-spec](https://github.com/hivv-org/hivv-spec)
- **Propose an RFC:** open a PR on [github.com/hivv-org/hivv-rfcs](https://github.com/hivv-org/hivv-rfcs)
- **Attend a community call:** Wednesdays 16:00 UTC, Jitsi at https://meet.hivv.org/community
- **Read decisions:** [Decision log](decision-log.md)

## License

MIT. The protocol is open. Fork it.
```

- [ ] **Step 3: process.md**

```markdown
# hivv governance process

The hivv protocol is open. Decisions are made in PRs, recorded as ADRs, and discussed live on Wednesdays.

## Roles

- **Anyone** can submit an RFC.
- **Maintainers** of hivv-spec merge accepted RFCs.
- **The community** meets weekly to discuss open RFCs and recent decisions.

## How a change happens

1. **RFC**: open a PR on `hivv-org/hivv-rfcs`. The PR description proposes a change.
2. **Discussion**: asynchronous in the PR. Synchronous in the Wednesday call.
3. **Decision**: when consensus forms (or after 4 weeks of discussion), a maintainer either:
   - Accepts the RFC and opens a PR on `hivv-org/hivv-spec` to implement it, or
   - Rejects the RFC with a written rationale.
4. **ADR**: every accepted RFC produces an ADR (Architecture Decision Record) in `hivv-org/hivv-decisions`. The ADR is append-only.

## Reversing a decision

To reverse a decision, write a new ADR that explicitly reverses it. Do not delete or edit the old one. The chain of decisions stays traceable.

## Conflicts

Conflicts are resolved in the weekly call first. If that fails, the hivv-org/moderation team arbitrates. The protocol itself never arbitrates disputes between humans.
```

- [ ] **Step 4: decision-log.md**

```markdown
# hivv decision log

ADRs (Architecture Decision Records). Append-only. Source: [github.com/hivv-org/hivv-decisions](https://github.com/hivv-org/hivv-decisions).

The full mirror is at `/api/governance/decisions`.
```

- [ ] **Step 5: rfc-process.md**

```markdown
# hivv RFC process

An RFC (Request for Comments) is a PR against `hivv-org/hivv-rfcs`. PRs are the protocol's API.

## Filing an RFC

1. Fork `hivv-org/hivv-rfcs`.
2. Copy `0000-template.md` to `NNNN-your-title.md`.
3. Fill in all sections.
4. Open a PR titled `RFC-NNNN: your title`.

## What makes a good RFC

- **Problem statement** before the solution.
- **Alternatives considered**, including the option of doing nothing.
- **Migration story** if the change is non-backwards-compatible.
- **Audit fields** for any new audit or identity primitive.
- **Test plan** if the RFC introduces testable behaviour.

## Lifecycle

- `draft` → opened but WIP
- `reviewing` → ready for feedback
- `accepted` → merged + ADR written
- `rejected` → closed with rationale
- `withdrawn` → author takes it back

## Where discussion happens

Asynchronous in the PR. Synchronous on the Wednesday call.

## Time

RFCs are not on a clock. Some take a week; some take a year. The 4-week "decide or close" guideline is for stalled RFCs, not for rushed ones.
```

- [ ] **Step 6: code-of-conduct.md**

```markdown
# hivv code of conduct

The hivv community is open to anyone who treats others with dignity.

## Behaviors we expect

- **Disagree on the merits.** Attack arguments, never people.
- **Hold space.** If a participant is quiet, wait. If they're being talked over, redirect.
- **Assume good faith.** Until you have evidence otherwise.
- **Be brief.** Long monologues lose the room.
- **Be humble.** You may be wrong. The protocol may be wrong. We are all iterating.

## Behaviors we don't tolerate

- Harassment (any form).
- Discriminatory language or imagery.
- Personal attacks.
- Sustained disruption.
- Sustained off-topic discussion.

## Enforcement

- A facilitator names the behaviour in the moment.
- If it continues, the facilitator mutes.
- Persistent issues go to the hivv-org/moderation team.
- Decisions of the moderation team are themselves subject to ADR process.

## License

This code of conduct is adapted from the Contributor Covenant, with one change: we name "harassment" rather than "unwelcome behavior," because we believe clarity > comfort.
```

- [ ] **Step 7: Commit**

```bash
git add mkdocs.yml docs/governance/
git commit -m "docs(hivv-G): hivv.org MkDocs site (5 pages, material theme)"
```

---

### Task 10: GitHub Actions

**Files:**
- Create: `.github/workflows/sync-rfcs.yml`
- Create: `.github/workflows/publish-spec.yml`

- [ ] **Step 1: sync-rfcs.yml**

```yaml
# .github/workflows/sync-rfcs.yml
# Runs every 15 min to push the canonical RFCS list into the dashboard mirror.
name: Sync RFCs to xyzo
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: {python-version: '3.11'}
      - name: Sync
        env:
          XYZO_DB_DSN: ${{ secrets.XYZO_DB_DSN }}
          GITHUB_TOKEN: ${{ secrets.HIVV_GITHUB_TOKEN }}
        run: python -m worker.governance.sync_decisions
```

- [ ] **Step 2: publish-spec.yml**

```yaml
# .github/workflows/publish-spec.yml
# On hivv-spec release: pin xyzo's spec copy to the tagged commit.
name: Pin xyzo spec to hivv-spec release
on:
  repository_dispatch:
    types: [hivv-spec-released]
  workflow_dispatch:

jobs:
  pin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: {repository: 'xyzo-org/xyzo', path: 'xyzo'}
      - name: Copy tagged spec
        run: |
          cd xyzo
          curl -L "https://raw.githubusercontent.com/hivv-org/hivv-spec/${{ github.event.client_payload.tag }}/spec.md" \
            -o docs/superpowers/specs/2026-09-07-hivv-protocol-design.md
          git config user.name "hivv-publisher"
          git config user.email "publisher@hivv.org"
          git add docs/superpowers/specs/
          git commit -m "spec: pin to hivv-spec@${{ github.event.client_payload.tag }}"
          git push
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci(hivv-G): GitHub Actions for RFC sync + spec publish"
```

---

### Task 11: Summary + handoff

- [ ] **Step 1: Write summary**

```bash
cat > docs/hivv-plan-g-summary.md <<'EOF'
# hivv Plan G — Open Governance + Community

**Status:** Complete. hivv.org is open. Decisions are append-only. RFCs are PRs.

## What ships
- 3 mirror tables: decisions (append-only ADRs), rfcs, meetings
- /api/governance/* public read endpoints (no auth, CORS *)
- /api/governance/admin/sync owner-only trigger
- worker/governance/sync_decisions.py — pulls from hivv-org GitHub every 15 min
- worker/governance/publish_weekly_agenda.py — Wed 16:00 UTC agenda
- /dashboard/governance widget (a11y-first)
- hivv.org MkDocs site (5 pages: home, process, decision log, RFC process, code of conduct)
- GitHub Actions: RFC sync every 15 min, spec-pin on hivv-spec release
- systemd timers: 15-min sync, Mon 12:00 agenda publish

## Process

1. **Anyone** opens a PR on hivv-org/hivv-rfcs.
2. Async discussion in the PR.
3. Wed 16:00 UTC: live discussion on Jitsi (https://meet.hivv.org/community).
4. Maintainer merges accepted RFCs → ADR is written into hivv-org/hivv-decisions.
5. xyzo's mirror table reads those ADRs every 15 minutes.
6. Reversing a decision = writing a new ADR that reverses it. Old ADRs are never deleted.

## Why this design

- **PRs as API.** GitHub already has review, diff, blame, history. No need to reinvent.
- **Append-only ADRs.** Traceability is a feature. The chain of decisions stays intact.
- **No voting in code.** Voting is sociotechnical; the protocol provides the room, not the decision.
- **One canonical spec.** hivv-spec/ is the source. xyzo's copy is a tagged release, not the source of truth.

## Next
- All 7 plans (A–G) shipped + green. Ready for full integration testing.
- Roadmap: physical community meetups, more languages, hardware-local-first variants.
EOF
git add docs/hivv-plan-g-summary.md
git commit -m "docs(hivv-G): Plan G summary"
```

---

## Done — Plan G complete (and all 7 plans shipped)

Verify:
```bash
cd api && bun test tests/audit.test.ts tests/inter-agent.test.ts 2>&1 | tail -5
cd worker && pytest governance/ -v
psql $XYZO_DB_DSN -c "SELECT * FROM decisions ORDER BY decided_on DESC LIMIT 5;"
psql $XYZO_DB_DSN -c "SELECT * FROM rfcs ORDER BY rfc_number DESC LIMIT 5;"
psql $XYZO_DB_DSN -c "SELECT * FROM meetings ORDER BY scheduled_for DESC LIMIT 5;"
ls public/dashboard/governance/agendas/
```

All green → **hivv protocol A→G complete.** Ready for full integration testing and community release.
