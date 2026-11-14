#!/usr/bin/env python3
"""
Build the earthquake overlay for Xyzo.

Source: **USGS Earthquake Hazards Program** — the GeoJSON "summary" feeds.
  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson
  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson
  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson

Licence: **Public domain — U.S. Geological Survey, Earthquake Hazards
Program**.  USGS asks to be credited; the attribution is carried in
meta.json and printed on the map by the layer.

WHY THIS DATASET
----------------
Every other overlay on this site is a raster or a vector file that some
body re-published. Earthquakes are the exception: the authoritative
catalogue is a set of plain GeoJSON files that the USGS refreshes every
minute, with no key, no account and no rate limit.

It is also the only live, event-shaped dataset in the site's catalogue —
and this site is a news map, so "what just happened, where" is exactly
the question the map is for. An M7 near a city is a story; the USGS
catalogue is where the story's facts come from.

The four feeds are the SAME catalogue at four time horizons, so they are
published as four files rather than one file with a time filter: the
client then fetches only the window the reader asked for, and the "last
hour" file stays small (a handful of events) instead of dragging the
30-day file (about 10,000 events) over the wire on every page load.

WHAT IS PUBLISHED
-----------------
  public_html/data/earthquakes/hour.geojson    Point per event, last hour
  public_html/data/earthquakes/day.geojson     Point per event, last 24 h
  public_html/data/earthquakes/week.geojson    Point per event, last 7 days
  public_html/data/earthquakes/month.geojson   Point per event, last 30 days
  public_html/data/earthquakes/meta.json        licence, counts, scales

Every feature carries the fields the popup shows: magnitude, place,
origin time (ms epoch), depth, the USGS event id, the felt-report count,
the tsunami flag, the status and the alert level.

NOTHING BUT .geojson AND .json — every *.png under public_html is served
`immutable` for a year, so a regenerated pyramid hides behind a stale
version token (the bug that hid the Köppen layer on 2026-10-22). A
.geojson revalidates, and it is the right shape for the data anyway.

Usage:
  python3 -m scripts.earthquake_build
  python3 -m scripts.earthquake_build --refresh
  python3 -m scripts.earthquake_build --verify-only
  python3 -m scripts.earthquake_build --out /tmp/eq

A systemd timer should run `python3 -m scripts.earthquake_build` every
TEN MINUTES. The build skips the download when the published files are
younger than ten minutes, so an impatient cron cannot hammer USGS.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "earthquakes")

SOURCE_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary"
SOURCE_URLS = {
    "hour": SOURCE_BASE + "/all_hour.geojson",
    "day": SOURCE_BASE + "/all_day.geojson",
    "week": SOURCE_BASE + "/all_week.geojson",
    "month": SOURCE_BASE + "/all_month.geojson",
}
SOURCE_PAGE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/"

ATTRIBUTION = "U.S. Geological Survey, Earthquake Hazards Program (public domain)"
LICENSE = "Public domain — U.S. Geological Survey, Earthquake Hazards Program"
LICENSE_URL = "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits"
EVENT_PAGE = "https://earthquake.usgs.gov/earthquakes/eventpage/{id}/executive"

USER_AGENT = "xyzo.org earthquake overlay builder (+https://xyzo.org)"
HTTP_TIMEOUT = 90
FRESH_SECONDS = 600          # the published files are re-used for 10 minutes

# ── the four windows ──────────────────────────────────────────────────────
# `hours` is the nominal span of the USGS feed, and it is what the
# freshness check in verify() measures against.
WINDOWS = [
    {"id": "hour", "label": "Last hour", "chip": "1 h", "hours": 1},
    {"id": "day", "label": "Last 24 hours", "chip": "24 h", "hours": 24},
    {"id": "week", "label": "Last 7 days", "chip": "7 d", "hours": 168},
    {"id": "month", "label": "Last 30 days", "chip": "30 d", "hours": 720},
]
DEFAULT_WINDOW = "day"

# ── the age → colour scale ────────────────────────────────────────────────
# Red is "it is happening now", and the scale cools as the event ages.
# This table is published in meta.json so the legend, the client and the
# builder all read ONE definition — a second copy of the thresholds is a
# second source of truth, and the two drift.
AGE_CLASSES = [
    {"id": "hour", "label": "Last hour", "tint": "< 1 h",
     "max_age_ms": 3_600_000, "color": "#ff2d2d"},
    {"id": "day", "label": "Last 24 hours", "tint": "< 24 h",
     "max_age_ms": 86_400_000, "color": "#ff7a1a"},
    {"id": "week", "label": "Last 7 days", "tint": "< 7 d",
     "max_age_ms": 604_800_000, "color": "#ffd21f"},
    {"id": "month", "label": "Last 30 days", "tint": "< 30 d",
     "max_age_ms": 2_592_000_000, "color": "#4aa3ff"},
    {"id": "older", "label": "Older than 30 days", "tint": "> 30 d",
     "max_age_ms": None, "color": "#8b9bb4"},
]

# ── the magnitude → radius scale ──────────────────────────────────────────
# A circle's radius in pixels. The floor keeps a magnitude-0 aftershock
# visible; the ceiling keeps an M8 from swallowing the map.
RADIUS_SCALE = {
    "formula": "clamp(3 + 2.2 * (mag - 1), 4, 26)",
    "base_px": 3.0,
    "per_mag_px": 2.2,
    "base_mag": 1.0,
    "min_px": 4,
    "max_px": 26,
}

# ── the place probes ──────────────────────────────────────────────────────
# (name, lat_lo, lat_hi, lon_centre, lon_half_width, why)
#
# The longitude is a CENTRE plus a half-width, not a pair of bounds,
# because Alaska's Aleutians cross the antimeridian: an event at 179.95°E
# is an Alaskan event, and a naive "-180..-130" box would reject it.
#
# These are the axis check. A GeoJSON that decodes with the latitude and
# the longitude swapped still produces a plausible-looking map — the dots
# are in the ocean, but they are in the ocean in a way nobody notices.
# Only KNOWN PLACES catch it: an event whose place says "Japan" has to
# be in Japan's box, and a swapped axis puts it at latitude 135.
PLACE_PROBES = [
    ("Alaska", 48.0, 73.0, -160.0, 45.0, "the Aleutians cross the antimeridian"),
    ("Hawaii", 17.0, 23.0, -155.8, 3.0, "the Pacific hotspot"),
    ("Japan", 20.0, 47.0, 136.0, 14.0, "the Japan trench"),
    ("Indonesia", -12.0, 7.0, 117.0, 26.0, "the Sunda arc"),
    ("Vanuatu", -24.0, -12.0, 168.0, 6.0, "the New Hebrides trench"),
    # MEASURED 2026-11-14 against the live month feed (9,933 events).
    # The old box was (-41..-17 lat, -70 +/- 7 lon) and 4 of the 30
    # Chile events sat outside it — 13.3 % against a 5 % tolerance, so
    # the gate refused to publish for THREE DAYS (229 VERIFY FAILs in a
    # 3-day journal window at a 10-minute cadence, and the overlay's
    # own files froze at their last success, 2026-11-11 11:34):
    #
    #   (-41.55, -74.21)  "48 km NW of Ancud, Chile"   <- Chiloé, and
    #                         Chile itself runs to -56, so the old
    #                         southern edge cut the country in half;
    #   (-36.46, -97.96)  "West Chile Rise"  (x2)
    #   (-40.69, -87.60)  "West Chile Rise"           <- USGS names the
    #                         Chile Rise spreading centre after Chile,
    #                         ~3,000 km offshore.
    #
    # THE MATCHER IS BY NAME (`name in place`), so the box has to cover
    # what the name covers — a box that only spans the trench was always
    # going to fire on a real catalogue, it just needed a swarm to reach
    # it. This is a wrong box being corrected, NOT a tolerance being
    # loosened: PLACE_PROBE_TOLERANCE is untouched.
    #
    # THE AXIS TEST STILL BITES, which is the whole point of the probe:
    # a swapped coordinate puts the longitude in the latitude (-63..-98
    # as a latitude, against a box that stops at -56) and the latitude
    # in the longitude (14..53 degrees off -70, against a half-width of
    # 35) — so a swap still puts 100 % of the events outside. A MIRRORED
    # longitude (+63..+98) is 133..168 degrees off -70, also outside.
    ("Chile", -56.0, -17.0, -70.0, 35.0, "the Peru-Chile trench and the Chile Rise"),
    ("Mexico", 12.0, 34.0, -104.0, 14.0, "the Middle America trench"),
    ("Peru", -19.0, -2.0, -75.0, 8.0, "the Peruvian margin"),
    ("Philippines", 2.0, 22.0, 123.0, 7.0, "the Manila trench"),
    ("Panama", 3.0, 11.0, -81.3, 4.0, "the Cocos ridge"),
    ("Papua New Guinea", -9.0, 1.0, 148.0, 10.0, "the Solomon arc"),
]

# A place probe fails when MORE than this share of the matching events
# falls outside the box. A swapped axis puts ALL of them outside; one
# event 300 km offshore does not, and a build must not be held hostage by
# a single offshore aftershock.
PLACE_PROBE_TOLERANCE = 0.05


def log(msg: str) -> None:
    print(f"[earthquakes] {msg}", flush=True)


def age_class(age_ms: int) -> str:
    """The age class id of an event `age_ms` old."""
    for c in AGE_CLASSES:
        if c["max_age_ms"] is None:
            return c["id"]
        if age_ms < c["max_age_ms"]:
            return c["id"]
    return AGE_CLASSES[-1]["id"]


def radius_for(mag: float) -> float:
    """Marker radius in pixels for a magnitude — the published scale."""
    r = RADIUS_SCALE["base_px"] + RADIUS_SCALE["per_mag_px"] * (mag - RADIUS_SCALE["base_mag"])
    return max(RADIUS_SCALE["min_px"], min(RADIUS_SCALE["max_px"], r))


# ── source acquisition ────────────────────────────────────────────────────

def fetch(url: str) -> bytes:
    """GET a feed with a timeout and a User-Agent (USGS asks for one)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def parse_feed(raw: bytes, now_ms: int) -> tuple[list[dict], int, int | None]:
    """A feed's bytes -> the feature list we publish, plus a skip count
    and the feed's own generation timestamp.

    A feature is dropped when it cannot be drawn: no magnitude, no time,
    no coordinate, or a coordinate outside the world. Those are not
    errors in the catalogue — they are events the catalogue has not
    finished reviewing — but they must not reach the map as NaN.
    """
    doc = json.loads(raw.decode("utf-8"))
    generated = None
    meta = doc.get("metadata") or {}
    if isinstance(meta.get("generated"), (int, float)):
        generated = int(meta["generated"])
    features: list[dict] = []
    skipped = 0
    for f in doc.get("features") or []:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        mag = props.get("mag")
        ts = props.get("time")
        if not isinstance(mag, (int, float)) or isinstance(mag, bool):
            skipped += 1
            continue
        if not math.isfinite(float(mag)):
            skipped += 1
            continue
        if not isinstance(ts, (int, float)) or isinstance(ts, bool):
            skipped += 1
            continue
        if len(coords) < 2:
            skipped += 1
            continue
        try:
            lng = float(coords[0])
            lat = float(coords[1])
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not (math.isfinite(lng) and math.isfinite(lat)):
            skipped += 1
            continue
        if not (-180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0):
            skipped += 1
            continue
        depth = None
        if len(coords) > 2 and coords[2] is not None:
            try:
                depth = float(coords[2])
            except (TypeError, ValueError):
                depth = None
        ev_id = f.get("id") or (props.get("ids") or "").strip(",")
        age = max(0, now_ms - int(ts))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "id": ev_id,
                "mag": float(mag),
                "place": props.get("place") or "",
                "time": int(ts),
                "depth": depth,
                "url": props.get("url") or "",
                "felt": props.get("felt"),
                "sig": props.get("sig"),
                "tsunami": bool(props.get("tsunami")),
                "type": props.get("type") or "earthquake",
                "status": props.get("status") or "",
                "alert": props.get("alert") or "",
                "title": props.get("title") or "",
                "ageClass": age_class(age),
            },
        })
    # Newest first: the client's first hit in the flat index is the newest
    # event, and the popup list reads like a feed.
    features.sort(key=lambda ft: ft["properties"]["time"], reverse=True)
    return features, skipped, generated


# ── verification ──────────────────────────────────────────────────────────
#
# A GATE, not a checkpoint: it refuses to publish, and it is able to
# fail. Every check below is a RELATIONSHIP — "the month feed holds more
# events than the hour feed", "an event whose place says Japan is in
# Japan's box", "the newest event in the hour feed is minutes old" —
# because those survive a decode that a shape check would not.

def verify(windows: dict[str, list[dict]], now_ms: int,
           generated: dict[str, int | None] | None = None) -> None:
    problems: list[str] = []
    notes: list[str] = []
    generated = generated or {}

    # 1. every published feature must be drawable
    for wid, feats in windows.items():
        ids = []
        for f in feats:
            p = f["properties"]
            c = f["geometry"]["coordinates"]
            if not isinstance(p.get("mag"), (int, float)) or not math.isfinite(p["mag"]):
                problems.append(f"{wid}: event {p.get('id')!r} has no finite magnitude")
            if len(c) < 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in c[:2]):
                problems.append(f"{wid}: event {p.get('id')!r} has a broken coordinate")
            elif not (-180 <= c[0] <= 180 and -90 <= c[1] <= 90):
                problems.append(f"{wid}: event {p.get('id')!r} is outside the world "
                                f"({c[0]}, {c[1]})")
            if not p.get("id"):
                problems.append(f"{wid}: an event has no id")
            if p.get("depth") is None:
                problems.append(f"{wid}: event {p.get('id')!r} has no depth")
            ids.append(p.get("id"))
        dupes = [i for i, n in Counter(ids).items() if n > 1]
        if dupes:
            problems.append(f"{wid}: {len(dupes)} duplicated event ids (e.g. {dupes[0]})")

    # 2. the windows are nested — the month feed holds the week feed, and
    #    so on. A file written to the wrong name breaks this at once.
    counts = {wid: len(feats) for wid, feats in windows.items()}
    if not (counts["month"] > counts["week"] > counts["day"] and counts["day"] >= counts["hour"]):
        problems.append(f"the windows are not nested: {counts}")

    # 3. freshness. The newest event of every window has to be inside
    #    that window, and every feed has to have been GENERATED recently
    #    — a cached copy of an old feed parses just as well as a live one.
    #
    #    The oldest event is NOT required to reach the far edge of the
    #    window: a quiet hour has no event at the one-hour boundary, and
    #    refusing to publish because the catalogue was quiet would be the
    #    gate lying to us. The feed's own `generated` stamp is what says
    #    the window was covered.
    for w in WINDOWS:
        wid, span_h = w["id"], w["hours"]
        feats = windows[wid]
        gen = generated.get(wid)
        if gen:
            gen_age_min = (now_ms - gen) / 60_000
            if gen_age_min > 120:
                problems.append(f"{wid}: the feed was generated {gen_age_min:.0f} min ago — "
                                "it is a stale copy, not the live feed")
        if not feats:
            if wid == "hour":
                notes.append("the hour window is empty — a genuinely quiet hour")
                continue
            problems.append(f"{wid}: no events at all")
            continue
        times = [f["properties"]["time"] for f in feats]
        newest_age_h = (now_ms - max(times)) / 3_600_000
        if newest_age_h > span_h + 0.5:
            problems.append(f"{wid}: the newest event is {newest_age_h:.2f} h old "
                            f"(the window is {span_h} h)")
        oldest_age_h = (now_ms - min(times)) / 3_600_000
        notes.append(f"{wid}: {len(feats)} events spanning {oldest_age_h:.1f} h")
    hour_feats = windows["hour"]
    if hour_feats:
        newest_age_h = (now_ms - max(f["properties"]["time"] for f in hour_feats)) / 3_600_000
        if newest_age_h > 2.0:
            problems.append(f"the hour feed's newest event is {newest_age_h:.2f} h old — "
                            "the feed is stale")

    # 4. each window must carry real events. The floors are set where the
    #    Poisson tail is negligible: M3+ happens ~50 times a day, M5+
    #    ~50 times a week, M6+ ~20 times a month. A floor set at the
    #    AVERAGE rate would fire on a quiet week and stop publication.
    floors = {"month": 6.0, "week": 5.0, "day": 3.0}
    for wid, floor in floors.items():
        mags = [f["properties"]["mag"] for f in windows[wid]]
        if not mags:
            continue
        if max(mags) < floor:
            problems.append(f"{wid}: no event of M{floor:.1f}+ (the strongest is M{max(mags):.1f})")

    # 5. THE AXIS CHECK — known places in known boxes. A swapped
    #    longitude/latitude still looks like a plausible map.
    #
    #    The test is a RATE, not a single event: a swapped axis puts
    #    every matching event outside the box, while one aftershock 300 km
    #    offshore puts one outside. The gate fires on the rate.
    matched = 0
    for name, lat_lo, lat_hi, lon_c, lon_half, why in PLACE_PROBES:
        hits = [f for f in windows["month"] if name in (f["properties"]["place"] or "")]
        if not hits:
            notes.append(f"no {name} event this month — probe skipped")
            continue
        matched += 1
        outside = []
        for f in hits:
            lng, lat = f["geometry"]["coordinates"]
            dlon = ((lng - lon_c + 180.0) % 360.0) - 180.0
            if not (lat_lo <= lat <= lat_hi) or abs(dlon) > lon_half:
                outside.append(f)
        rate = len(outside) / len(hits)
        if rate > PLACE_PROBE_TOLERANCE:
            problems.append(
                f"{rate * 100:.1f} % of the {len(hits)} {name} events fall outside "
                f"{name}'s box ({lat_lo}..{lat_hi} lat, {lon_c} +/- {lon_half} lon) — "
                f"the axes may be swapped (e.g. {outside[0]['properties']['place']})")
        elif outside:
            notes.append(f"{len(outside)} {name} events sit outside the box "
                         "(offshore events) — within tolerance")

    if matched < 3:
        problems.append(f"only {matched} of {len(PLACE_PROBES)} place probes matched — "
                        "the probe set proved nothing")

    # 6. the longitude axis is not mirrored or compressed: there are
    #    events east of Asia AND on the American west coast.
    month_lons = [f["geometry"]["coordinates"][0] for f in windows["month"]]
    if not any(l >= 155.0 for l in month_lons):
        problems.append("no event east of Asia (longitude >= 155) in the month window")
    if not any(l <= -120.0 for l in month_lons):
        problems.append("no event on the American west coast (longitude <= -120) "
                        "in the month window")

    # 7. the deepest and the strongest event must be a real place, and
    #    the tsunami flag must be a boolean.
    for wid, feats in windows.items():
        for f in feats:
            if not isinstance(f["properties"]["tsunami"], bool):
                problems.append(f"{wid}: event {f['properties']['id']!r} has a "
                                "non-boolean tsunami flag")
                break

    for n in notes:
        log(f"  note: {n}")
    if problems:
        for p in problems:
            log(f"VERIFY FAIL: {p}")
        raise SystemExit("verify() failed — refusing to publish")
    log(f"verify() passed: {counts}, {matched}/{len(PLACE_PROBES)} place probes")


# ── writing ───────────────────────────────────────────────────────────────

def write_outputs(windows: dict[str, list[dict]], meta: dict, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for w in WINDOWS:
        wid = w["id"]
        feats = windows[wid]
        fc = {"type": "FeatureCollection", "features": feats}
        path = os.path.join(out_dir, f"{wid}.geojson")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(fc, fh, separators=(",", ":"), ensure_ascii=False)
        log(f"wrote {path} ({len(feats)} events, {os.path.getsize(path) / 1024:.0f} KB)")
    meta_path = os.path.join(out_dir, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
    log(f"wrote {meta_path}")


def published_is_fresh(out_dir: str) -> bool:
    """True when every published file is younger than FRESH_SECONDS."""
    meta_path = os.path.join(out_dir, "meta.json")
    if not os.path.exists(meta_path):
        return False
    try:
        age = time.time() - os.path.getmtime(meta_path)
    except OSError:
        return False
    for w in WINDOWS:
        if not os.path.exists(os.path.join(out_dir, f"{w['id']}.geojson")):
            return False
    return age < FRESH_SECONDS


def build(out_dir: str, refresh: bool) -> int:
    now_ms = int(time.time() * 1000)
    windows: dict[str, list[dict]] = {}
    generated: dict[str, int | None] = {}
    skipped_total = 0
    for w in WINDOWS:
        wid = w["id"]
        url = SOURCE_URLS[wid]
        log(f"fetching {wid}: {url}")
        raw = fetch(url)
        feats, skipped, gen = parse_feed(raw, now_ms)
        skipped_total += skipped
        windows[wid] = feats
        generated[wid] = gen
        mags = [f["properties"]["mag"] for f in feats]
        log(f"  {wid}: {len(feats)} events"
            + (f", strongest M{max(mags):.1f}" if mags else "")
            + (f", {skipped} dropped (no magnitude/time/coordinate)" if skipped else ""))

    verify(windows, now_ms, generated)

    for w in WINDOWS:
        wid = w["id"]
        feats = windows[wid]
        mags = [f["properties"]["mag"] for f in feats]
        times = [f["properties"]["time"] for f in feats]
        w["file"] = f"{wid}.geojson"
        w["count"] = len(feats)
        w["max_mag"] = max(mags) if mags else None
        w["min_mag"] = min(mags) if mags else None
        w["newest_time"] = max(times) if times else None
        w["oldest_time"] = min(times) if times else None

    meta = {
        "name": "Earthquakes",
        "source": "USGS Earthquake Hazards Program — GeoJSON summary feeds",
        "source_page": SOURCE_PAGE,
        "source_urls": SOURCE_URLS,
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        "license_url": LICENSE_URL,
        "event_page": EVENT_PAGE,
        "fetched_at": now_ms,
        "fetched_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ms / 1000)),
        "counts": {w["id"]: w["count"] for w in WINDOWS},
        "windows": [{k: v for k, v in w.items() if k != "hours"} | {"hours": w["hours"]}
                    for w in WINDOWS],
        "default_window": DEFAULT_WINDOW,
        "age_classes": AGE_CLASSES,
        "radius_scale": RADIUS_SCALE,
        "skipped_features": skipped_total,
        "notes": [
            "Magnitude is the USGS reported magnitude; the radius scale is "
            "clamp(3 + 2.2 * (mag - 1), 4, 26) pixels.",
            "The colour is the AGE of the event at the moment the file was "
            "written: red under an hour, orange under a day, yellow under a "
            "week, blue under a month, grey beyond that.",
            "The catalogue includes quarry blasts, explosions and other "
            "induced events; each carries its own `type`.",
            "Depth is in kilometres below sea level.",
        ],
    }
    write_outputs(windows, meta, out_dir)
    return 0


def verify_published(out_dir: str) -> int:
    """Re-read the published files and gate them (no network)."""
    windows: dict[str, list[dict]] = {}
    now_ms = int(time.time() * 1000)
    for w in WINDOWS:
        path = os.path.join(out_dir, f"{w['id']}.geojson")
        if not os.path.exists(path):
            log(f"VERIFY FAIL: {path} is missing")
            return 2
        with open(path, encoding="utf-8") as fh:
            fc = json.load(fh)
        windows[w["id"]] = fc.get("features") or []
    try:
        verify(windows, now_ms)
    except SystemExit as exc:
        log(f"{exc}")
        return 2
    meta_path = os.path.join(out_dir, "meta.json")
    if not os.path.exists(meta_path):
        log("VERIFY FAIL: meta.json is missing")
        return 2
    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh)
    for key in ("license", "attribution"):
        if not isinstance(meta.get(key), str) or len(meta[key]) < 5:
            log(f"VERIFY FAIL: meta.json has no usable {key}")
            return 2
    log("published files pass the gate")
    return 0


def main() -> int:
    global OUT_DIR

    ap = argparse.ArgumentParser(description="Build the earthquake overlay")
    ap.add_argument("--out", default=OUT_DIR, help="output directory")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download even when the published files are fresh")
    ap.add_argument("--verify-only", action="store_true",
                    help="re-check the published files without touching the network")
    args = ap.parse_args()

    OUT_DIR = args.out

    if args.verify_only:
        return verify_published(OUT_DIR)

    if not args.refresh and published_is_fresh(OUT_DIR):
        age = int(time.time() - os.path.getmtime(os.path.join(OUT_DIR, "meta.json")))
        log(f"published {age} s ago (under {FRESH_SECONDS} s) — nothing to do")
        return 0

    try:
        return build(OUT_DIR, args.refresh)
    except SystemExit:
        raise
    except Exception as exc:  # network, JSON, disk
        log(f"build failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
