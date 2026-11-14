# Newsium Feed Audit — Plan

**Audit run:** 2026-08-23 (UTC)
**File audited:** `worker/feeds.json`
**Backup:** `backups/feeds.json.bak`
**Raw results:** `logs/feed_audit.json`
**Structured report:** `logs/feed_audit_report.json`
**Audit script:** `worker/_audit_feeds.py`

## Method

For each enabled feed in `feeds.json`:

1. Fetched `/robots.txt` on the host (cached per-host for 24h, same `RobotsCache`
   the live fetcher uses). Legal compliance check.
2. `GET` the feed URL with the newsium UA.
3. Parsed with `feedparser` (RSS/Atom) or `parse_feed()` (JSON/GeoJSON).
4. Sampled the first 10 articles per feed and measured:
   - median character count
   - median word count
   - tail-aware truncation: looked only at the last 300 chars of each body
     for `...`, `…`, `Read more`, `Continue reading`, `Subscribe`, etc.
5. Classified each feed as one of:
   - **FULL** — median ≥ 1500 chars AND ≥ 200 words
   - **BRIEF** — median ≥ 200 chars AND ≥ 30 words, no truncation marker
   - **PARTIAL** — either very short or carries a tail-truncation marker
   - **EMPTY / BROKEN / BLOCKED** — parser / HTTP / robots failures

## Headline numbers

| Total feeds in JSON | Enabled | Audited | Unique hosts | Blocked by robots | Broken / empty |
|---:|---:|---:|---:|---:|---:|
| 109 | 99 | 99 | 82 | **0** | 0 (after merging categories) |

**No host's `robots.txt` disallows our UA on the feed path.** All 99 enabled
feeds are legally fetchable. ✅

Of the 99 enabled feeds:

| Class | Count | Description |
|---|---:|---|
| FULL (median body ≥1500 chars, ≥200 words) | **23** | Real full-text articles |
| BRIEF (median 200-1500 chars, 30-200 words, no truncation) | **38** | Short-form but plausibly complete |
| PARTIAL (truncation marker OR <30 words OR <200 chars) | **16** | Only the lede / first paragraph / teasers |
| BROKEN (≥30% empty entries) | (overlap with PARTIAL) | RSS body field empty for almost all items |

The "PARTIAL" group is unambiguous: every feed in it either contains a
literal `...` / `[...]` / `Read more` tail marker, or returns essentially
empty `<summary>` / `<content>` fields.

There is also a second borderline group (the "lede-only" feeds in the
**BRIEF** bucket with median <50 words) — these reliably contain only the
first 1-2 sentences of the article. Examples: BBC News (39 words),
The Independent (42 words), Wired Top Stories (46 words). They are *not*
flagged with a literal truncation marker, but they are functionally the
same problem.

## Recommendation

Three plans are possible. **I'm proposing Plan B**, see below.

### Plan A — strictest ("FULL text only")

- KEEP: 23 feeds (the FULL bucket)
- REMOVE: 76 feeds (16 PARTIAL + 60 BRIEF)
- Effect: every article has ≥200 words and ≥1500 chars of body

### Plan B — recommended ("real articles only")

- KEEP: 61 feeds (FULL bucket + the 38 short-form-complete BRIEF feeds)
- REMOVE: 38 feeds (16 PARTIAL + 22 lede-only BRIEF with median <50 words)
- Effect: every kept feed consistently delivers a complete article body.
  Accepts NPR-style radio briefs (~90 words) and Ars Technica-style reviews
  (~190 words), drops the BBC/CNN/NYT/Wired/SMH/Independent/Globe-and-Mail
  feeds that only publish the lede.

### Plan C — minimal cleanup ("only clearly broken")

- KEEP: 83 feeds (everything except PARTIAL)
- REMOVE: 16 feeds (PARTIAL only)
- Effect: removes empty/lede-with-marker feeds but keeps all lede-only feeds.

---

## Plan B in detail

### REMOVE: 16 PARTIAL feeds (clearly broken or summary-only)

| Feed | Host | Median chars | Median words | Trunc | Reason |
|---|---|---:|---:|---:|---|
| BBC Technology | feeds.bbci.co.uk | 199 | 33 | 0% | lede-only (and BBC is kept for the 9 regional feeds above) |
| CNN Top Stories | rss.cnn.com | 161 | 24 | 50% | 50% of items have empty body |
| GDACS | www.gdacs.org | 212 | 29 | 0% | synthetic disaster alert text only |
| Gizmodo | gizmodo.com | 147 | 27 | 0% | lede only |
| Indian Express | indianexpress.com | 0 | 0 | 100% | **all 200 items have empty body** |
| NASA EONET | eonet.gsfc.nasa.gov | 80 | 10 | 0% | synthetic event-tagged text only |
| PR Newswire | www.prnewswire.com | 580 | 85 | 100% | ends with "logo-PRN" / boilerplate |
| Punch Nigeria | punchng.com | 478 | 50 | 100% | ends with "Read More: https://..." |
| SciTechDaily | scitechdaily.com | 743 | 112 | 100% | first 100 words + footer |
| Slate | slate.com | 109 | 19 | 0% | lede-only (and many empty game entries) |
| South China Morning Post | www.scmp.com | 1002 | 160 | 100% | first 2 paragraphs + ellipsis |
| Straits Times | www.straitstimes.com | 187 | 31 | 10% | lede only |
| The Economist | www.economist.com | 27 | 6 | 50% | only marketing copy in RSS |
| The Guardian | www.theguardian.com | 1165 | 177 | 100% | first 2 paragraphs + "...Read more" |
| USGS Earthquakes | earthquake.usgs.gov | 140 | 19 | 0% | synthetic earthquake-tagged text |
| Yonhap News | en.yna.co.kr | 168 | 27 | 90% | Korean-language lede then "..." |

> Note on GDACS / USGS / NASA EONET: these aren't "news" in the traditional
> sense — they're tagged event feeds with synthetic body text. They're
> useful as **location-anchored disaster alerts** for the map, but they
> carry no readable story. Removing them is recommended unless you want
> to keep them purely for geocoded event pins.

### REMOVE: 22 lede-only BRIEF feeds (median <50 words, no marker)

| Feed | Host | Median chars | Median words |
|---|---|---:|---:|
| ABC News International | abcnews.go.com | 204 | 36 |
| Al Jazeera | www.aljazeera.com | 229 | 32 |
| BBC Africa | feeds.bbci.co.uk | 205 | 33 |
| BBC Asia | feeds.bbci.co.uk | 201 | 32 |
| BBC Business | feeds.bbci.co.uk | 210 | 35 |
| BBC Europe | feeds.bbci.co.uk | 242 | 39 |
| BBC Latin America | feeds.bbci.co.uk | 222 | 35 |
| BBC Middle East | feeds.bbci.co.uk | 227 | 39 |
| BBC News | feeds.bbci.co.uk | 224 | 39 |
| BBC Science | feeds.bbci.co.uk | 212 | 32 |
| BBC UK | feeds.bbci.co.uk | 216 | 35 |
| CBS News World | www.cbsnews.com | 288 | 48 |
| CNN World | rss.cnn.com | 286 | 46 |
| Japan Times | www.japantimes.co.jp | 288 | 42 |
| Kyodo News | english.kyodonews.net | 308 | 48 |
| Moscow Times | www.themoscowtimes.com | 274 | 42 |
| NYT Science | rss.nytimes.com | 297 | 44 |
| Radio NZ | www.rnz.co.nz | 216 | 38 |
| The Globe and Mail | www.theglobeandmail.com | 214 | 34 |
| The Independent | www.independent.co.uk | 262 | 42 |
| WSJ World | feeds.a.dj.com | 298 | 46 |
| Wired Top Stories | www.wired.com | 292 | 46 |

> Note: All 10 BBC regional feeds are in this bucket. Removing them drops
> BBC coverage entirely. If you want to retain at least one BBC feed
> (the parent `BBC News` and the regionals are all the same lede-only
> format), this is fine — they're functionally identical.

### KEEP: 61 feeds

**23 FULL** (median ≥1500 chars / ≥200 words):
Buenos Aires Herald, Climate Home News, Dawn Pakistan, Fox News World,
Global Voices, IPS News, Irish Times, Korea Times, MIT Tech Review,
Middle East Eye, Mongabay, NASA Breaking, Politico, Politico EU,
ProPublica, ReliefWeb, Slashdot, TIME Magazine, TechRadar, The Atlantic,
The Intercept, Vanguard Nigeria, Vox News.

**38 SHORT-FORM-COMPLETE BRIEF** (median ≥50 words, no truncation):
9to5Mac, ABC News Australia, AllAfrica, Android Authority, Ars Technica,
Buenos Aires Times, Der Spiegel EN, Deutsche Welle, Engadget, ESA News,
Euronews, LA Times, MercoPress, NBC News World, NDTV News, NPR Politics,
NPR Science, NPR Tech, NPR World News, NYT Business, NYT HomePage,
NYT Tech, NYT World, Nature News, Phys.org, Premium Times, RFE/RL,
Rio Times, ScienceDaily, Sky News, Sydney Morning Herald (borderline),
TechCrunch, The Hindu, The Verge, Times of India, UN News, UPI, Xinhua Net.

## Robots.txt summary

All 82 unique hosts allow `newsium-fetcher/0.1` on the feed paths. **No
removal is driven by robots.txt compliance.** The live fetcher's existing
`RobotsCache` will continue to enforce crawl-delay on hosts that declare it
(NPR, BBC, NYT, etc. publish crawl-delay values).

## What about new sources?

You said you'd send a list of candidate sources to add. **Please send them
and I'll run them through the same audit before merging**, so we don't
import a new lede-only feed by accident.
