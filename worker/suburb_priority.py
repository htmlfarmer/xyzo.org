"""Suburb-priority geocoding refinement.

News copy anchors everything to the famous parent city: a murder in
Naperville is "a Chicago suburb" crime, a factory opening in Noida is
"near Delhi", a Brooklyn story is filed under "New York". Selection
logic everywhere else picks the *highest-population* city mentioned,
which systematically erases suburb coverage from the map.

`refine()` detects that pattern: when the placed primary city is a large
metro and the article actually names a smaller city within ~60 km
(headline mention, or "X suburb of Y" phrasing), re-pin to the suburb.

Pure text logic is separated from the suburb-candidate lookup so both
can be unit-tested without a database.
"""

from __future__ import annotations

import logging
import math
import re
import threading
from typing import Any, Iterable

log = logging.getLogger("xyzo.suburb")

# Only these anchor cities absorb their suburbs by population bias.
MIN_PARENT_POP = 500_000
# Satellite floor: below this, false positives on common-word place
# names outweigh the coverage gain (world_cities has 28k rows >= 20k).
MIN_SUBURB_POP = 20_000
# Suburb must be meaningfully smaller than the anchor.
MAX_SUBURB_POP_RATIO = 0.85
MAX_DIST_KM = 60.0
HINT_WINDOW = 100  # chars around a mention to look for "suburb of" phrasing
# Short names ("Ali", "Man") collide with personal names / common words;
# they only get repin credit via hint-context, never plain title mentions.
MIN_TITLE_REPIN_NAME_LEN = 4
# A suburb name must appear in the first N chars of the headline to make
# the suburb the story's subject; late-title mentions are supporting
# detail ("City of Chicago honors ... with award in South Shore").
TITLE_EARLY_POS = 80
# Administrative divisions ("Aurora Township") are not news locations
# in their own right and shadow the real city of the same name.
_SKIP_NAME_RE = re.compile(
    r"\b(township|tehsil|taluka|taluk|mandal|district|county|province|"
    r"subdivision|block|council)\b", re.I)

# "suburb of X" context words. Deliberately excludes "neighborhood"/
# "borough": those mark districts INSIDE the parent city (South Shore is
# a Chicago neighborhood — the story belongs to Chicago).
_HINT_RE = re.compile(
    r"\b(suburb|suburbs|suburban|outskirts|exurb|exurbs|"
    r"satellite city|satellite town)\b",
    re.I,
)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ── Candidate loading (world_cities grid, cached per process) ────────

_lock = threading.Lock()
_grid: dict[tuple[int, int], list[dict]] | None = None
_CELL_DEG = 1.0


def _load_grid() -> dict[tuple[int, int], list[dict]]:
    global _grid
    if _grid is not None:
        return _grid
    with _lock:
        if _grid is not None:
            return _grid
        from .db import connect
        rows: list[dict] = []
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, name, ascii_name, country_code, state_name,
                           lat, lng, population
                    FROM world_cities
                    WHERE population >= %s
                      AND lat IS NOT NULL AND lng IS NOT NULL
                    """,
                    (MIN_SUBURB_POP,),
                )
                rows = cur.fetchall()
        except Exception as e:
            log.warning("suburb_priority: world_cities load failed: %s", e)
            rows = []
        grid: dict[tuple[int, int], list[dict]] = {}
        for r in rows:
            key = (int(r["lat"] // _CELL_DEG), int(r["lng"] // _CELL_DEG))
            grid.setdefault(key, []).append(r)
        _grid = grid
        log.info("suburb_priority: loaded %d cities (>= %d pop) into %d cells",
                 len(rows), MIN_SUBURB_POP, len(grid))
    return _grid


def suburb_candidates(parent: dict) -> list[dict]:
    """Cities within MAX_DIST_KM of `parent`, same country, smaller pop."""
    return _candidates_from(grid=_load_grid(), parent=parent)


def _candidates_from(*, grid: dict, parent: dict) -> list[dict]:
    plat = parent.get("lat")
    plng = parent.get("lng")
    ppop = parent.get("population") or 0
    country = (parent.get("country_code") or "").upper()
    pname = (parent.get("name") or "").strip().lower()
    if plat is None or plng is None or ppop < MIN_PARENT_POP:
        return []
    deg = MAX_DIST_KM / 111.32
    c0, c1 = int((plat - deg) // _CELL_DEG), int((plat + deg) // _CELL_DEG) + 1
    l0, l1 = int((plng - deg / max(0.2, math.cos(math.radians(plat)))) // _CELL_DEG), \
             int((plng + deg / max(0.2, math.cos(math.radians(plat)))) // _CELL_DEG) + 1
    out: list[dict] = []
    for ci in range(c0, c1 + 1):
        for lj in range(l0, l1 + 1):
            for r in grid.get((ci, lj), ()):
                if (r.get("country_code") or "").upper() != country:
                    continue
                rname = (r.get("name") or "").strip().lower()
                if not rname or rname == pname:
                    continue
                if _SKIP_NAME_RE.search(rname):
                    continue  # "Aurora Township" etc — admin divisions
                # "Delhi" parent vs "New Delhi" candidate — same place, skip
                if rname in pname or pname in rname:
                    continue
                pop = r.get("population") or 0
                if pop < MIN_SUBURB_POP or pop > ppop * MAX_SUBURB_POP_RATIO:
                    continue
                d = _haversine_km(plat, plng, r["lat"], r["lng"])
                if d <= MAX_DIST_KM:
                    out.append({**r, "_dist_km": d})
    return out


# ── Pure text scoring ────────────────────────────────────────────────

def _mentions(needle: str, hay: str, *, ci: bool = False) -> list[int]:
    needle = (needle or "").strip()
    if len(needle) < 3:
        return []
    flags = re.I if ci else 0
    pat = re.compile(r"(?<![\w-])" + re.escape(needle) + r"(?![\w-])", flags)
    return [m.start() for m in pat.finditer(hay)]


def score_suburb(parent: dict, suburb: dict, title: str, body: str) -> tuple[int, str]:
    """Return (score, reason). Score >= 90 means re-pin.

    Matching is case-sensitive (proper-noun discipline): city names appear
    capitalized in copy, so lowercase "ali" or "man" mid-sentence cannot
    title-credit a suburb of that name. Short names additionally need a
    "suburb of X" style hint before they can repin.
    """
    sname = suburb.get("name") or ""
    sawidth = suburb.get("ascii_name") or ""
    title_s = title or ""
    body_s = (body or "")[:3000]
    tlow, blow = title_s.lower(), body_s.lower()

    title_hits = (_mentions(sname, title_s)
                  or (sawidth.lower() != sname.lower()
                      and _mentions(sawidth, title_s)) or [])
    body_hits = (_mentions(sname, body_s)
                 or (sawidth.lower() != sname.lower()
                     and _mentions(sawidth, body_s)) or [])
    parent_title_hits = _mentions((parent.get("name") or "").lower(), tlow, ci=True)
    total_mentions = len(title_hits) + len(body_hits)
    short_name = len(sname) < MIN_TITLE_REPIN_NAME_LEN

    # (a) Headline names the suburb — early in the headline (the subject).
    if title_hits and not short_name and min(title_hits) <= TITLE_EARLY_POS:
        # Parent ALSO in headline and appearing before the suburb — the
        # story's subject is the metro ("Killed in Chicago; Naperville
        # family mourns") — keep the parent unless suburb-first phrasing
        # ("Naperville, Chicago suburb, ...") or an explicit hint ties
        # the headline to the suburb.
        parent_first = (parent_title_hits
                        and min(parent_title_hits) < min(title_hits))
        hint = _hint_near(suburb, title_hits, tlow) or _hint_near(
            suburb, body_hits, blow)
        if not parent_first or hint:
            return 100, f"title-mention ({sname})"
        return 40, f"suburb in title but parent leads ({sname})"

    # (b) "the Chicago suburb of Naperville" style phrasing near the
    # suburb mention, with the suburb actually carrying mentions.
    # Short names must use this path (title mention alone is not enough).
    if body_hits and _hint_near(suburb, body_hits, blow) and total_mentions >= 2:
        return 90, f"suburb-context phrase ({sname})"
    if title_hits and short_name and _hint_near(suburb, title_hits, tlow):
        return 90, f"short-name suburb-context ({sname})"

    return 0, ""


def _hint_near(suburb: dict, positions: list[int], hay: str) -> bool:
    for pos in positions:
        window = hay[max(0, pos - HINT_WINDOW):pos + len(suburb.get("name") or "") + HINT_WINDOW]
        if _HINT_RE.search(window):
            return True
    return False


# ── Public API ───────────────────────────────────────────────────────

def refine(primary: dict, title: str, body: str, *,
           candidates: Iterable[dict] | None = None,
           ) -> tuple[dict | None, str]:
    """Return (suburb, reason) if the placement should move from the
    parent `primary` city to a named suburb; (None, '') otherwise.

    `candidates` is injectable for tests / callers that already have a
    nearby-city list.
    """
    if not primary or (primary.get("population") or 0) < MIN_PARENT_POP:
        return None, ""
    try:
        cands = (list(candidates) if candidates is not None
                 else suburb_candidates(primary))
        if not cands:
            return None, ""
        best: dict | None = None
        best_score, best_reason = 0, ""
        for s in cands:
            score, reason = score_suburb(primary, s, title, body)
            if score > best_score or (best is not None and score == best_score
                                      and s.get("_dist_km", 999) < best.get("_dist_km", 999)):
                best, best_score, best_reason = s, score, reason
        if best is not None and best_score >= 90:
            return best, best_reason
        return None, ""
    except Exception as e:  # never break ingestion over refinement
        log.debug("suburb_priority.refine failed: %s", e)
        return None, ""


def suburb_label(suburb: dict) -> str:
    """Geocodable 'Name, State, CC' string from a world_cities row."""
    parts = [suburb.get("name")]
    st = (suburb.get("state_name") or "").strip()
    cc = (suburb.get("country_code") or "").strip()
    if st:
        parts.append(st)
    if cc:
        parts.append(cc)
    return ", ".join(str(p) for p in parts if p)
