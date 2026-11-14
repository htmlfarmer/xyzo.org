"""legal_scan — fetch ToS / Privacy pages and detect scraping prohibitions.

robots.txt is mechanical: a publisher either blocks our UA or doesn't.
But many sites block scraping in their Terms of Service or Acceptable
Use Policy even when robots.txt is silent. To respect these we have to
*read* the legal pages and decide whether they prohibit our bot's
behaviour.

We do this with three layers, in order of cost:

  1. **Local keyword classifier** (no network call, no API). Looks for
     phrases like "no scraping", "automated access prohibited",
     "robots, spiders, crawlers". Cheap; runs first.
  2. **Claude API** (if `XYZO_CLAUDE_API_KEY` is set). Asks the model
     to extract the scraping-relevant clauses with citation spans.
  3. **Cache** — every verdict is stored in `legal_policies` keyed by
     host + document URL hash. Refetch weekly.

The local classifier returns a verdict immediately so the API
endpoint can answer without waiting on a network round-trip when the
text clearly forbids scraping. Only ambiguous cases escalate to the
model.

The output of `scan_host()` is a `LegalVerdict` with:

  • status: 'prohibited' | 'restricted' | 'unrestricted' | 'unknown'
  • confidence: 0.0–1.0
  • clauses: list of quoted excerpts with citations
  • crawl_summary: a one-line human-readable summary

Surface this in /api/sites/study so the UI can warn before letting
a user enable a source that is legally off-limits.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field, asdict
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from site_study import study_url

log = logging.getLogger("xyzo.legal_scan")

USER_AGENT = ("xyzo-legal-scan/1.0 (+https://xyzo.org/bot) "
              "policy-classifier; contact@xyzo.org")

# Standard locations to probe for legal pages.
_LEGAL_PATHS: list[tuple[str, str]] = [
    ("/terms", "Terms of Service"),
    ("/terms-of-service", "Terms of Service"),
    ("/tos", "Terms of Service"),
    ("/terms-and-conditions", "Terms and Conditions"),
    ("/conditions", "Conditions"),
    ("/legal", "Legal"),
    ("/legal-notice", "Legal Notice"),
    ("/acceptable-use", "Acceptable Use Policy"),
    ("/aup", "Acceptable Use Policy"),
    ("/api-terms", "API Terms"),
    ("/api-policy", "API Policy"),
    ("/developers/terms", "Developer Terms"),
    ("/developers/policies", "Developer Policies"),
    ("/policies/terms", "Policy: Terms"),
    ("/policy/terms-of-service", "Policy: Terms"),
    ("/privacy", "Privacy Policy"),
    ("/privacy-policy", "Privacy Policy"),
    ("/cookie-policy", "Cookie Policy"),
    ("/dmca", "DMCA Policy"),
]

# ── Local keyword classifier ─────────────────────────────────────────
# Phrases that strongly suggest scraping prohibition. The regex is
# deliberately conservative — we'd rather escalate to Claude than
# false-positive a public-data site.
_PROHIBIT_PHRASES: list[str] = [
    r"may not (?:use|attempt to use|access|attempt to access)\s+(?:any|automated|manual|the)\s+(?:means|methods|tools|programs|robots|spiders|crawlers|scrapers|techniques|software|devices)",
    r"(?:prohibits?|forbidden|prohibited|not permitted|not allowed|may not)\s+(?:scraping|crawling|spidering|harvesting|data[- ]mining|automated access|automated collection|automated harvesting|automated extraction)",
    r"you (?:will not|may not|shall not|agree not to|prohibit|may not use any)\s+(?:any|automated|robot|spider|scraper|crawler|bot|harvester|tool|software|program|script)\s+(?:to|that|for)",
    r"(?:reverse engineer|reverse-engineer|systematically (?:reproduce|retrieve|download|copy))",
    r"automated (?:means|methods|tools|programs|robots|spiders|crawlers|scrapers|techniques|software|devices)\s+(?:is|are)?\s*(?:strictly\s+)?prohibited",
    r"scraping.*is (?:strictly\s+)?prohibited",
    r"(?:use|using)\s+any\s+(?:robot|spider|scraper|crawler|harvester|bot|automated (?:means|tool|software))\s+(?:is\s+)?(?:strictly\s+)?prohibited",
    r"without (?:our|express|prior|written)\s+(?:prior\s+)?(?:written\s+)?(?:consent|permission|approval)",
]

# Phrases that imply restriction but not prohibition — e.g. "rate
# limits apply", "API key required".
_RESTRICT_PHRASES: list[str] = [
    r"rate[- ]limit",
    r"api[- ]?key\s+(?:is\s+)?required",
    r"authentication is required",
    r"robots\.txt",
    r"respect\s+our\s+(?:crawl|robots)",
    r"subject to (?:our\s+)?(?:terms|terms of service|acceptable use)",
    r"may be monitored",
    r"we (?:reserve the right|may)\s+(?:to|suspend|terminate|block)",
]

# Phrases that explicitly grant permission — e.g. Open Data licences.
_ALLOW_PHRASES: list[str] = [
    r"public domain",
    r"creative commons",
    r"\bcc[- ]?by\b",
    r"open data",
    r"may be (?:used|reproduced|redistributed|republished)\s+(?:freely|without restriction|for any purpose)",
    r"(?:explicitly|expressly)\s+(?:permits?|authorizes?)\s+(?:the use of|use of)\s+(?:robots|spiders|crawlers|scrapers|automated)",
]

_PROHIBIT_RE = [re.compile(p, re.IGNORECASE) for p in _PROHIBIT_PHRASES]
_RESTRICT_RE = [re.compile(p, re.IGNORECASE) for p in _RESTRICT_PHRASES]
_ALLOW_RE = [re.compile(p, re.IGNORECASE) for p in _ALLOW_PHRASES]


@dataclass
class ClauseHit:
    """A single phrase match with surrounding context."""
    phrase: str
    excerpt: str
    source_url: str
    source_title: str


@dataclass
class LegalVerdict:
    host: str
    status: str           # 'prohibited' | 'restricted' | 'unrestricted' | 'unknown'
    confidence: float
    clauses: list[ClauseHit]
    sources_checked: list[str]
    summary: str
    scanned_at: float
    method: str           # 'local' | 'claude' | 'mixed'

    def to_dict(self) -> dict[str, Any]:
        return {
            "host": self.host,
            "status": self.status,
            "confidence": round(self.confidence, 3),
            "clauses": [asdict(c) for c in self.clauses],
            "sources_checked": self.sources_checked,
            "summary": self.summary,
            "scanned_at": self.scanned_at,
            "method": self.method,
        }


def _excerpt(text: str, m: re.Match, window: int = 220) -> str:
    """Return a window of `window` chars around the match."""
    start = max(0, m.start() - window // 2)
    end = min(len(text), m.end() + window // 2)
    snippet = text[start:end]
    snippet = re.sub(r"\s+", " ", snippet).strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def local_classify(text: str, source_url: str,
                   source_title: str) -> tuple[str, float, list[ClauseHit]]:
    """Run the keyword classifier. Returns (status, confidence, hits).

    status is one of: 'prohibited', 'restricted', 'unrestricted', 'unknown'.
    """
    if not text:
        return "unknown", 0.0, []
    hits: list[ClauseHit] = []
    prohib_count = 0
    restrict_count = 0
    allow_count = 0
    for rgx in _PROHIBIT_RE:
        for m in rgx.finditer(text):
            hits.append(ClauseHit(
                phrase=m.group(0)[:140],
                excerpt=_excerpt(text, m),
                source_url=source_url,
                source_title=source_title,
            ))
            prohib_count += 1
    for rgx in _RESTRICT_RE:
        for m in rgx.finditer(text):
            hits.append(ClauseHit(
                phrase=m.group(0)[:140],
                excerpt=_excerpt(text, m),
                source_url=source_url,
                source_title=source_title,
            ))
            restrict_count += 1
    for rgx in _ALLOW_RE:
        for m in rgx.finditer(text):
            hits.append(ClauseHit(
                phrase=m.group(0)[:140],
                excerpt=_excerpt(text, m),
                source_url=source_url,
                source_title=source_title,
            ))
            allow_count += 1

    # Decide
    if prohib_count >= 1 and prohib_count > allow_count:
        # Higher confidence if multiple prohibition hits
        conf = min(0.55 + 0.1 * prohib_count, 0.9)
        return "prohibited", conf, hits
    if restrict_count >= 1:
        return "restricted", min(0.4 + 0.1 * restrict_count, 0.7), hits
    if allow_count >= 1:
        return "unrestricted", min(0.5 + 0.1 * allow_count, 0.8), hits
    return "unknown", 0.2, hits


def _summary(status: str, host: str,
             clauses: list[ClauseHit]) -> str:
    """One-line human summary for the verdict."""
    if status == "prohibited":
        return (f"{host} terms prohibit scraping/crawling. "
                f"{len(clauses)} clause(s) matched.")
    if status == "restricted":
        return (f"{host} terms restrict automated access. "
                f"{len(clauses)} clause(s) matched.")
    if status == "unrestricted":
        return f"{host} terms allow automated access under stated conditions."
    return f"{host} terms scanned — no clear prohibition found."


def scan_host(host: str,
              client: httpx.Client | None = None,
              use_claude: bool = True,
              max_pages: int = 6,
              ) -> LegalVerdict:
    """Scan the standard legal pages for a host. Returns a LegalVerdict.

    `use_claude` — if True AND XYZO_CLAUDE_API_KEY is set AND the local
    classifier returns 'unknown', escalate to Claude for a final answer.
    """
    close = False
    if client is None:
        client = httpx.Client(
            timeout=15.0,
            headers={"User-Agent": USER_AGENT,
                     "Accept": "text/html, application/xhtml+xml"},
            follow_redirects=True,
        )
        close = True

    sources: list[str] = []
    all_hits: list[ClauseHit] = []
    worst_status = "unknown"
    worst_confidence = 0.0
    method = "local"

    try:
        for path, title in _LEGAL_PATHS[:max_pages]:
            url = f"https://{host}{path}"
            try:
                resp = client.get(url)
            except httpx.HTTPError:
                continue
            if resp.status_code not in (200, 301, 302):
                continue
            text = resp.text
            if not text or len(text) < 200:
                continue
            sources.append(url)
            status, conf, hits = local_classify(text, url, title)
            all_hits.extend(hits)
            if conf > worst_confidence:
                worst_status = status
                worst_confidence = conf
            # If we already have a high-confidence prohibition, stop.
            if worst_status == "prohibited" and worst_confidence >= 0.8:
                break
    finally:
        if close:
            client.close()

    # If local says unknown and Claude is enabled, escalate.
    if worst_status == "unknown" and use_claude:
        api_key = os.environ.get("XYZO_CLAUDE_API_KEY")
        if api_key and sources:
            verdict = _claude_classify(host, sources, all_hits, api_key)
            if verdict is not None:
                method = "mixed"
                return verdict

    return LegalVerdict(
        host=host, status=worst_status, confidence=worst_confidence,
        clauses=all_hits, sources_checked=sources,
        summary=_summary(worst_status, host, all_hits),
        scanned_at=time.time(), method=method,
    )


# ── Claude escalation ────────────────────────────────────────────────
_CLAUDE_MODEL = os.environ.get("XYZO_CLAUDE_MODEL", "claude-haiku-4-5")
_CLAUDE_URL = "https://api.anthropic.com/v1/messages"


def _claude_classify(host: str, sources: list[str],
                     hits: list[ClauseHit],
                     api_key: str) -> LegalVerdict | None:
    """Send the candidate clauses to Claude for a final verdict.

    Falls back to None on any error so the caller can fall through to
    the local result.
    """
    # Build a tight prompt: only send excerpts (not full pages) so we
    # stay under token limits.
    excerpt_blob = "\n\n".join(
        f"FROM {h.source_url}:\n  {h.excerpt}"
        for h in hits[:20]
    ) or "(no candidate clauses found)"
    sources_blob = "\n".join(sources[:6])
    prompt = (
        f"You are a legal-policy classifier. The site `{host}` was "
        "scanned for terms that govern automated access (bots, "
        "scrapers, crawlers, spiders, data mining).\n\n"
        f"Pages examined:\n{sources_blob}\n\n"
        "Candidate excerpts (with source URLs):\n\n"
        f"{excerpt_blob}\n\n"
        "Decide which one status best describes this host's policy "
        "toward a polite, rate-limited event/news aggregator that "
        "respects robots.txt:\n"
        "  - 'prohibited': the terms forbid automated access.\n"
        "  - 'restricted': automated access is allowed only with "
        "credentials or rate-limits (treat as restricted — not "
        "automatically fetchable without a key).\n"
        "  - 'unrestricted': the terms allow automated access or "
        "release the data under an open licence.\n"
        "  - 'unknown': the policy is silent or too vague to decide.\n\n"
        "Respond with a JSON object: {\"status\": ..., "
        "\"confidence\": 0..1, \"reasoning\": one sentence, "
        "\"cited_excerpts\": [string, ...]}. Do not include any "
        "prose outside the JSON."
    )
    body = {
        "model": _CLAUDE_MODEL,
        "max_tokens": 600,
        "messages": [{"role": "user", "content": prompt}],
    }
    try:
        with httpx.Client(timeout=30.0) as c:
            resp = c.post(
                _CLAUDE_URL,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                content=json.dumps(body),
            )
            if resp.status_code != 200:
                log.warning("claude legal-scan %s: %d", host, resp.status_code)
                return None
            data = resp.json()
            text = "".join(
                blk.get("text", "") for blk in data.get("content", [])
                if blk.get("type") == "text"
            )
            # Strip code fences if present
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
            parsed = json.loads(text)
            status = str(parsed.get("status", "unknown")).lower()
            if status not in ("prohibited", "restricted",
                              "unrestricted", "unknown"):
                status = "unknown"
            conf = max(0.0, min(1.0, float(parsed.get("confidence", 0.5))))
            cited = parsed.get("cited_excerpts", []) or []
            new_hits = [
                ClauseHit(
                    phrase="claude-cited",
                    excerpt=str(c)[:400],
                    source_url=sources[0] if sources else "",
                    source_title="Claude extraction",
                )
                for c in cited[:5]
            ]
            return LegalVerdict(
                host=host, status=status, confidence=conf,
                clauses=hit + new_hits if (hit := hits) else new_hits,
                sources_checked=sources,
                summary=_summary(status, host, hits),
                scanned_at=time.time(),
                method="claude",
            )
    except Exception as e:
        log.warning("claude legal-scan %s: %s", host, e)
        return None


# ── DB persistence (best-effort, uses db.connect) ───────────────────
def persist_verdict(verdict: LegalVerdict) -> int | None:
    """Upsert into legal_policies. Returns the row id or None on failure."""
    try:
        from db import connect
    except ImportError:
        try:
            from .db import connect
        except ImportError:
            return None
    doc_hash = hashlib.sha256(
        "|".join(sorted(verdict.sources_checked)).encode("utf-8")
    ).hexdigest()[:32]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO legal_policies (
                host, status, confidence, summary, clauses,
                sources_checked, method, doc_hash, scanned_at
            )
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, to_timestamp(%s))
            ON CONFLICT (host) DO UPDATE SET
                status = EXCLUDED.status,
                confidence = EXCLUDED.confidence,
                summary = EXCLUDED.summary,
                clauses = EXCLUDED.clauses,
                sources_checked = EXCLUDED.sources_checked,
                method = EXCLUDED.method,
                doc_hash = EXCLUDED.doc_hash,
                scanned_at = EXCLUDED.scanned_at
            RETURNING id
            """,
            (
                verdict.host,
                verdict.status,
                verdict.confidence,
                verdict.summary,
                json.dumps([asdict(c) for c in verdict.clauses]),
                verdict.sources_checked,
                verdict.method,
                doc_hash,
                verdict.scanned_at,
            ),
        )
        row = cur.fetchone()
        return int(row["id"]) if row else None
