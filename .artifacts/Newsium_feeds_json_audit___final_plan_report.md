# Newsium Feed Audit — Final Plan

**Audit run:** 2026-08-23 (UTC)
**File audited:** `worker/feeds.json`
**Backup:** `backups/feeds.json.bak`
**Raw results:** `logs/feed_audit.json`
**Structured report:** `logs/feed_audit_report.json`
**Audit script (kept in tree for future re-runs):** `worker/_audit_feeds.py`

## Method

For each of the 99 enabled feeds in `feeds.json`:

1. **robots.txt** — fetched `/robots.txt` once per host (cached, same `RobotsCache`
   the live fetcher uses). Checked against our `newsium-fetcher/0.1` UA.
2. **Feed fetch** — `GET feed_url`, 30 s timeout, real headers.
3. **Parsing** — `feedparser` for RSS/Atom, `parse_feed()` for JSON/GeoJSON.
4. **Body statistics** — for the first 10 articles per feed, measured:
   - character count
   - word count
   - **tail-aware truncation**: looked only at the last 300 chars of each
     body for explicit truncation markers (`...` at end, `[...]`, `Read more`,
     `Read the full story`, `Read more: https://...`, `Leer más`,
     `Continue reading`, `Sign up here`, `Subscribe to`, `Submit a tip`,
     `Getty Images`, image-only GDELT entries, etc.)
5. **Classification**:
   - **FULL** — median ≥1500 chars AND ≥200 words
   - **BRIEF** — median ≥200 chars AND ≥30 words, no truncation marker
   - **PARTIAL** — either very short, or carries a tail-truncation marker,
     or ≥30% of sampled entries have empty body
   - **EMPTY / BROKEN / BLOCKED** — parser / HTTP / robots failures

## Headline results

| Total feeds in JSON | Enabled | Audited | Unique hosts | Blocked by robots |
|---:|---:|---:|---:|---:|
| 109 | 99 | 99 | 82 | **0** |

✅ **Every one of the 82 unique hosts allows `newsium-fetcher/0.1` on the feed
path.** No removal is driven by robots.txt compliance. The live fetcher's
existing `RobotsCache` will continue to enforce crawl-delay on hosts that
declare it.

Of the 99 enabled feeds:

| Class | Count | What it means |
|---|---:|---|
| **FULL** | 23 | Median ≥1500 chars / ≥200 words — real full-text articles |
| **BRIEF** | 56 | Median 200-1500 chars / 30-200 words, no tail marker |
| **PARTIAL** | 20 | Median <200 chars OR <30 words OR tail-truncation marker |

## Recommended action — **Plan B**

> Keep feeds that consistently deliver a complete article body (≥50 words
> median, no tail truncation). Remove feeds whose bodies are the lede + first
> paragraph only, and remove feeds with literal truncation footers.

| Action | Count | Feeds |
|---|---:|---|
| **KEEP** — full-text (≥200 words) | **23** | see list A |
| **KEEP** — short-form complete (50-200 words, no marker) | **35** | see list B |
| **REMOVE** — partial / broken / tail-truncated | **20** | see list C |
| **REMOVE** — lede-only BRIEF (median <50 words, no marker) | **21** | see list D |
| **Net** | 99 → **58 kept**, 41 removed | |

> Two of the "partial" feeds (GDACS, USGS Earthquakes, NASA EONET) carry
> no article copy at all — they're tagged event feeds with synthetic body
> text. They're useful only as **location-anchored pins** for the disaster
> map, not as readable stories. **If you want to keep them as event pins
> only**, flag them with a `purpose: "events_only"` field rather than
> deleting them; otherwise remove them.

## List A — KEEP full-text (23)

| Feed | Host | Med chars | Med words |
|---|---|---:|---:|
| Buenos Aires Herald | buenosairesherald.com | 4378 | 665 |
| Climate Home News | www.climatechangenews.com | 9056 | 1130 |
| Dawn Pakistan | www.dawn.com | 9163 | 1360 |
| Fox News World | moxie.foxnews.com | 3245 | 512 |
| Global Voices | globalvoices.org | 8962 | 1216 |
| IPS News | www.ipsnews.net | 6660 | 1026 |
| Irish Times | www.irishtimes.com | 7640 | 1260 |
| Korea Times | www.koreatimes.co.kr | 3310 | 518 |
| MIT Tech Review | www.technologyreview.com | 7024 | 1116 |
| Middle East Eye | www.middleeasteye.net | 2337 | 333 |
| Mongabay | news.mongabay.com | 2364 | 368 |
| NASA Breaking | www.nasa.gov | 5272 | 638 |
| Politico | rss.politico.com | 6249 | 992 |
| Politico EU | www.politico.eu | 2650 | 352 |
| ProPublica | feeds.propublica.org | 10582 | 1602 |
| ReliefWeb | reliefweb.int | 5905 | 815 |
| Slashdot | rss.slashdot.org | 4680 | 739 |
| TIME Magazine | time.com | 4696 | 759 |
| TechRadar | www.techradar.com | 4432 | 630 |
| The Atlantic | www.theatlantic.com | 6853 | 1082 |
| The Intercept | theintercept.com | 10858 | 1686 |
| Vanguard Nigeria | www.vanguardngr.com | 10654 | 1682 |
| Vox News | www.vox.com | 7338 | 1244 |

## List B — KEEP short-form complete (35)

Median 50-200 words, no tail truncation marker. Includes NPR-style radio
briefs and DW/UN/AllAfrica press releases that ARE complete at this length.

9to5Mac (526c/83w), ABC News Australia (418/70), AllAfrica (581/95),
Android Authority (642/118), Buenos Aires Times dropped to partial (337/58 +
truncated), Der Spiegel EN (592/99), Deutsche Welle (390/62), Engadget
(283/51), ESA News (551/86), Euronews (341/54), LA Times (500/75),
MercoPress (677/99), NBC News World (450/73), NDTV News (429/71),
NPR Politics (561/89), NPR Science (552/92), NPR Tech (552/88), NPR World
News (567/94), NYT Business (428/66), NYT HomePage (457/71), NYT Tech
(446/67), NYT World (468/74), Nature News (549/68), Phys.org (580/90),
Premium Times (536/79), RFE/RL (446/65), Rio Times (562/94), ScienceDaily
(693/98), Sky News (403/66), Sydney Morning Herald (316/51), TechCrunch
(338/54), The Hindu (454/73), Times of India (791/115), UN News (405/62),
UPI (446/68), Xinhua Net (355/57).

## List C — REMOVE: partial / broken / tail-truncated (20)

| Feed | Host | Med chars | Med words | Trunc% | Why |
|---|---|---:|---:|---:|---|
| Ars Technica | feeds.arstechnica.com | 1202 | 192 | 100% | "Read full article" footer |
| BBC Technology | feeds.bbci.co.uk | 199 | 33 | 0% | BBC lede only |
| Buenos Aires Times | www.batimes.com.ar | 337 | 58 | 100% | "Leer más" footer |
| CNN Top Stories | rss.cnn.com | 161 | 24 | 50% | 50% empty entries |
| GDACS | www.gdacs.org | 212 | 29 | 0% | synthetic disaster alert only |
| Gizmodo | gizmodo.com | 147 | 27 | 0% | lede only |
| Indian Express | indianexpress.com | 0 | 0 | 100% | **all 200 items empty body** |
| Kyodo News | english.kyodonews.net | 308 | 48 | 100% | "Read full story here" |
| NASA EONET | eonet.gsfc.nasa.gov | 80 | 10 | 0% | synthetic event tag only |
| PR Newswire | www.prnewswire.com | 580 | 85 | 100% | PR boilerplate / logo footer |
| Punch Nigeria | punchng.com | 478 | 50 | 100% | "Read More: https://..." |
| SciTechDaily | scitechdaily.com | 743 | 112 | 100% | first 100w + footer |
| Slate | slate.com | 109 | 19 | 0% | lede only + games / quiz entries |
| South China Morning Post | www.scmp.com | 1002 | 160 | 100% | first 2 paragraphs + ellipsis |
| Straits Times | www.straitstimes.com | 187 | 31 | 10% | lede only |
| The Economist | www.economist.com | 27 | 6 | 50% | only marketing copy in RSS |
| The Guardian | www.theguardian.com | 1165 | 177 | 100% | first 2 paragraphs + "Read more" |
| The Verge | www.theverge.com | 1420 | 242 | 90% | "Read the full story at The Verge" |
| USGS Earthquakes | earthquake.usgs.gov | 140 | 19 | 0% | synthetic earthquake tag only |
| Yonhap News | en.yna.co.kr | 168 | 27 | 90% | Korean lede then "..." |

## List D — REMOVE: lede-only BRIEF (21)

Median <50 words, no explicit marker (but the body is clearly the lede +
one short paragraph only).

ABC News International (204c/36w), Al Jazeera (214/31), BBC Africa (205/33),
BBC Asia (201/32), BBC Business (210/35), BBC Europe (242/39), BBC Latin
America (222/35), BBC Middle East (227/39), BBC News (224/39), BBC Science
(212/32), BBC UK (216/35), CBS News World (288/48), CNN World (286/46),
Japan Times (288/42), Moscow Times (274/42), NYT Science (297/44),
Radio NZ (216/38), The Globe and Mail (214/34), The Independent (262/42),
WSJ World (298/46), Wired Top Stories (292/46).

> Note: 10 of these are BBC regional feeds. Dropping all 10 removes BBC
> entirely. The feeds are functionally identical — all return the lede
> only — so there's no value in keeping one but not others.

## What the change will look like

The current `worker/feeds.json` has 109 entries (10 disabled + 99 enabled).
After this change the file will have 68 enabled + 41 removed (or 41 entries
flagged `enabled: false` for a soft-disable path — see "Soft vs hard remove"
below).

## Soft vs hard remove

Two implementation options:

### Soft (recommended)

Set `"enabled": false` on the 41 feeds in lists C and D. The live fetcher
will skip them silently. They stay in the file so the operator can flip
them back on if a feed improves, and so the audit script can re-measure
on the next run.

### Hard

Delete the 41 entries entirely from `feeds.json`. Cleaner file, but loses
the history. The audit script re-measures every time, so re-adding is just
a JSON edit anyway.

## Robots.txt

All 82 hosts allow scraping. **No host disallows the UA on the feed path.**
The fetcher continues to honor per-host crawl-delay (BBC, NPR, NYT,
Guardian, etc. publish crawl-delay values).

## New sources to add

You said you'd provide a list of candidate sources. **Please send the list
and I'll run each candidate through the same audit (robots.txt + body
quality) before merging**, so we don't import another lede-only feed.
Common candidates worth checking (I'll only add ones that pass):

- Reuters — has full text RSS in some feeds
- Associated Press
- France 24 (already in JSON, currently disabled)
- Le Monde EN (currently disabled in JSON)
- Bloomberg
- El País English
- Al Jazeera Arabic
- Haaretz
- The Japan Times (already in JSON as Japan Times)
- Channel News Asia
- The Straits Times (already in JSON, currently partial — see List C)
- ABC Australia regional feeds

I'll wait for your list before adding anything.
