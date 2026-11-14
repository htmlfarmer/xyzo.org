# Source Retirement List — 2026-09-26

**965 active sources have NEVER succeeded and contributed ZERO articles.**

> STANCE: keep them ALL active (owner decision 2026-09-26) — too few users
> today to judge demand; deep backoff already caps their cost at ~1 poll/8d.
> Revisit `--apply` when 30-day sessions are an order of magnitude larger.

Split by measured demand signal:

- **Tier B — KEEP & REPAIR (283)**: zero successes but from countries with
  real 30-day view demand (e.g. BBC Malayalam, Dawn, Jakarta Post). These are
  likely blocked/renamed feeds, not garbage. Backoff caps their cost automatically;
  they need a feed-URL/UA repair pass, not retirement.
- **Tier R — DORMANT (682)**: zero successes, zero articles, no demand signal
  yet. Kept active, on automatic deep backoff. `--revive`-style probes and the
  weekly report watch them; `--apply` would deactivate — deliberately unused.

## Breakdown
- by type: [('web', 669), ('rss', 296)]
- top countries affected: [('ME', 102), ('AF', 78), ('SO', 69), ('US', 48), ('EA', 41), ('XX', 23), ('ID', 22), ('AR', 17), ('PH', 16), ('CL', 12), ('GB', 12), ('IN', 11), ('PL', 11), ('BO', 10), ('CZ', 10)]

## Worst cost first (top 30)

| id | name | type | country | errors | added |
|---|---|---|---|---|---|
| 2170 | The Irish Times | rss | IE | 408 | 2026-09-01 |
| 525 | Daily Maverick | rss | ZA | 402 | 2026-08-23 |
| 527 | The Star Malaysia | rss | MY | 402 | 2026-08-23 |
| 528 | Malay Mail | rss | MY | 402 | 2026-08-23 |
| 509 | Addis Standard | rss | ET | 402 | 2026-08-23 |
| 533 | The Irrawaddy | rss | MM | 401 | 2026-08-23 |
| 552 | Kyiv Independent | rss | UA | 401 | 2026-08-23 |
| 539 | Pajhwok Afghan News | rss | AF | 401 | 2026-08-23 |
| 538 | Tolo News | rss | AF | 401 | 2026-08-23 |
| 541 | The Himalayan Times | rss | NP | 401 | 2026-08-23 |
| 3430 | La Nación (Argentina) | rss | AR | 401 | 2026-09-06 |
| 543 | Cameroon Tribune | rss | CM | 401 | 2026-08-23 |
| 535 | Sudan Tribune | rss | SD | 401 | 2026-08-23 |
| 1727 | La Nación (Argentina) | rss | AR | 401 | 2026-08-29 |
| 1726 | Clarín (Argentina) | rss | AR | 400 | 2026-08-29 |
| 548 | Radio Okapi | rss | CD | 400 | 2026-08-23 |
| 532 | CBC News | rss | CA | 400 | 2026-08-23 |
| 2101 | Los Tiempos | rss | BO | 399 | 2026-09-01 |
| 2115 | Tiempo Honduras | rss | HN | 399 | 2026-09-01 |
| 2104 | Bolivia TV | rss | BO | 399 | 2026-09-01 |
| 2092 | TSF | rss | PT | 399 | 2026-09-01 |
| 2072 | Seznam Zprávy | rss | CZ | 399 | 2026-09-01 |
| 2118 | Ultima Hora | rss | PY | 399 | 2026-09-01 |
| 2121 | Confidencial | rss | NI | 399 | 2026-09-01 |
| 2119 | Paraguay.com | rss | PY | 399 | 2026-09-01 |
| 2123 | El Nuevo Diario | rss | NI | 399 | 2026-09-01 |
| 2103 | La Razón | rss | BO | 399 | 2026-09-01 |
| 2125 | Radio La Primerísima | rss | NI | 399 | 2026-09-01 |
| 2122 | La Prensa Nicaragua | rss | NI | 399 | 2026-09-01 |
| 2143 | Roya News | rss | JO | 399 | 2026-09-01 |

## Tier B — keep & repair (top 20 by errors)

| id | name | type | country | errors |
|---|---|---|---|---|
| 2731 | Xinhua News China | rss | CN | 412 |
| 1701 | BBC Malayalam | rss | IN | 407 |
| 1741 | Dawn (Pakistan) | rss | PK | 407 |
| 2232 | Dawn | rss | PK | 406 |
| 3306 | SciTechDaily | rss | US | 406 |
| 2250 | Vanguard | rss | NG | 406 |
| 3302 | Vanguard Nigeria | rss | NG | 405 |
| 2027 | The News | rss | PK | 404 |
| 472 | Jakarta Post | rss | ID | 403 |
| 492 | Mainichi | rss | JP | 403 |
| 473 | Tempo English | rss | ID | 403 |
| 2245 | Ahram Online | rss | EG | 402 |
| 515 | ANSA English | rss | IT | 402 |
| 498 | VnExpress | rss | VN | 402 |
| 502 | TRT World | rss | TR | 402 |
| 1704 | NHK World Japan | rss | JP | 402 |
| 523 | Daily Nation | rss | KE | 402 |
| 491 | NHK World | rss | JP | 402 |
| 496 | Al-Ahram | rss | EG | 402 |
| 3420 | El País | rss | ES | 401 |

## Demand check — what humans actually read (30d views by country)

XX: 1,050,871, US: 1,810, IR: 636, IN: 585, CN: 377, NG: 358, KZ: 307, ID: 275, GB: 227, DE: 222, FR: 217, BR: 213, EG: 199, IT: 191, TR: 187, JP: 155, MX: 120, AU: 120, PK: 113, VN: 109, AZ: 107, CH: 105, ES: 94, GR: 79, CI: 76, PH: 75, DO: 71, KR: 68, TZ: 67, GH: 66, KE: 63, DZ: 60, UG: 59, VE: 59, TH: 58, RU: 56, BJ: 49, BD: 49, AO: 45, MA: 43

- Tracked locations: 1,060,293 views from 372 sessions in 30d
- Cities people LOOKED AT but we have no coverage for: 2,603

Acquisition focus: those gap cities are the next sources to hunt —
demand already exists, supply is zero. Retirement frees the budget for it.

## Rollback

```sql
UPDATE news_sources SET active = TRUE, locality = NULL
WHERE locality = 'retired_never_produced';
```