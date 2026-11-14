#!/usr/bin/env python3
"""
Build the FAO AQUASTAT "Rivers (Global - edition 2026)" assets for Xyzo.

WHAT THIS PUBLISHES
-------------------
  public_html/data/rivers/fao/labels.geojson   one anchor point per river name
  public_html/data/rivers/fao/meta.json        licence, attribution, WMS, levels

WHY THE LINES ARE NOT BUILT HERE
--------------------------------
The 2026 network is the HydroRIVERS line layer: more than a MILLION river
reaches worldwide (every reach with a catchment of 10 km² or an average flow
of 0.1 m³/s). As GeoJSON that is roughly 700 MB — it cannot be shipped to a
browser, and it cannot be shipped as a raster pyramid without building the
whole world twice.

So the LINES are served by the publisher's own WMS
(https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wms, layer
`river_network`), which renders the full network at whatever zoom it is
asked for — that is what makes "as detailed as possible" possible at all.
GeoServer's WMS honours a `CQL_FILTER` vendor parameter, so the DETAIL
LEVEL is a server-side filter on `dis_av_cms` (the long-term average
discharge): the same four levels the client offers, computed by the
publisher, not by us.

WHAT THIS BUILDS, THEN, IS THE NAMES
------------------------------------
The 2026 network carries hydrology only (HYRIV_ID, NEXT_DOWN, ORD_FLOW,
LENGTH_KM, DIST_UP_KM, DIST_DN_KM, UPLAND_SKM, CATCH_SKM, DIS_AV_CMS) —
there is NO name on a reach, and none can be invented.

The names come from the FAO's own CLASSIC rivers layer
(`aquamaps:rivers_world_47950`), the same AQUASTAT family, which carries
`maj_name` (the major basin) and `sub_name` (the sub-basin) on every one of
its 86,882 features, plus a Strahler order and a flow regime. This script
takes the river NAMES out of it — one anchor point per distinct name — and
publishes them for the client to place as labels.

A NAME IS ONLY LABELLED IF IT IS A RIVER
----------------------------------------
`maj_name`/`sub_name` are BASIN names, and many of them are places, not
water: "Gobi Interior", "Hudson Bay Coast", "Arabian Peninsula", "Lake
Chad", "Sahara". Labelling a desert "Sahara" because the dataset calls it a
basin is worse than no label at all, so REGION_WORDS drops every name that
reads as land or sea rather than as a channel. What survives is the river
network a reader expects to see named.

Usage:
  python3 -m scripts.river_network_build
  python3 -m scripts.river_network_build --verify-only
  python3 -m scripts.river_network_build --skip-fetch   # rebuild from the cache
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "rivers", "fao")


# ── the UPSTREAM licence ────────────────────────────────────────────────
#
# THE FAO LABELS ITS LAYER CC BY 4.0, BUT THE PRODUCT IT IS DERIVED
# FROM — HydroRIVERS, from the HydroSHEDS version 1 core layers — CARRIES
# ITS OWN LICENCE (Appendix A of the HydroSHEDS Technical Documentation
# v1.4), and that licence requires the **Exhibit B attribution to travel
# with the product's METADATA**.
#
# **THESE STRINGS LIVE IN THE BUILDER BECAUSE THE BUILDER OVERWRITES THE
# PUBLISHED meta.json.** They were published once — by a version of the
# builder that carried them — and the repo's builder could NOT reproduce
# them: rebuilding dropped them, and `public_html/tests/data-licences.
# bun.test.js` failed on the published file ("the 2026 rivers carry the
# UPSTREAM licence's attribution too"). **A licence obligation must
# survive a rebuild**, so the builder writes them now, and the fetch
# script (which writes the out-of-web-root manifest) reads them from
# here — one text, two places it travels.
UPSTREAM = ("HydroRIVERS (HydroSHEDS version 1) — © World Wildlife Fund, "
            "Inc. (2006-2022), used under licence")

UPSTREAM_ATTRIBUTION = (
    "This product incorporates data from the HydroSHEDS version 1 "
    "database which is © World Wildlife Fund, Inc. (2006-2022) and has "
    "been used herein under license. WWF has not evaluated the data as "
    "altered and incorporated within this product, and therefore gives "
    "no warranty regarding its accuracy, completeness, currency or "
    "suitability for any particular purpose. Portions of the "
    "HydroSHEDS v1 database incorporate data which are the intellectual "
    "property rights of © USGS (2006-2008), NASA (2000-2005), ESRI "
    "(1992-1998), CIAT (2004-2006), UNEP-WCMC (1993), WWF (2004), "
    "Commonwealth of Australia (2007), and Her Royal Majesty and the "
    "British Crown and are used under license. The HydroSHEDS v1 "
    "database and more information are available at "
    "https://www.hydrosheds.org."
)

UPSTREAM_CITATION = (
    "The scientific citation for the HydroSHEDS version 1 database is: "
    "Lehner, B., Verdin, K., Jarvis, A. (2008): New global hydrography "
    "derived from spaceborne elevation data. Eos, Transactions, AGU, "
    "89(10): 93-94."
)# The cache is OUTSIDE public_html, and that is not tidiness: Caddy
# serves the web root, and a 72 MB download of the classic layer parked
# under /data/ was reachable at
# https://xyzo.org/data/rivers/fao/.cache/rivers_world_47950.json — 72 MB
# of a third party's data, served to anyone who asked for it.
CACHE = os.path.join(REPO, "data", "river_network_cache",
                     "rivers_world_47950.json")

# ── the publisher ────────────────────────────────────────────────────────
WFS_BASE = "https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wfs"
WMS_URL = "https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wms"
WMS_LAYER = "river_network"
WMS_STYLE = "river_network_v1"          # "River Network - Order and Perenniality"
CLASSIC_TYPE = "aquamaps:rivers_world_47950"

LICENSE = "CC BY 4.0"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
ATTRIBUTION = ("FAO AQUASTAT — Rivers (Global, 2026 ed.), from HydroRIVERS "
               "(HydroSHEDS) · CC BY 4.0")

SOURCE_URL = ("https://data.apps.fao.org/catalog/iso/"
              "e22667af-3977-4e9f-b58b-67fb91b0fa87")
WFS_DOC = ("https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wfs"
           "?service=WFS&version=1.1.0&request=GetFeature"
           "&typeName=aquamaps:river_network&srsName=EPSG%3A4326"
           "&maxFeatures=1000")

# ── the detail levels ────────────────────────────────────────────────────
# The SAME table lives in public_html/fao-rivers-layer.js (the client sends
# the filter) and is published here (the documentation). The client test
# asserts the two agree — a table that drifts would make the legend lie.
#
# `dis_av_cms` is the long-term average discharge in m³/s. The thresholds
# are the ones the publisher's own flow-order classes use: ORD_FLOW <= 4 is
# exactly `dis_av_cms >= 100` (273,191 reaches), ORD_FLOW <= 5 is exactly
# `dis_av_cms >= 10` (857,210 reaches). Measured with resultType=hits.
LEVELS = [
    {"id": "major", "label": "Major",
     "filter": "dis_av_cms>=100", "min_cms": 100,
     "note": "the world's great rivers — the Amazon, the Congo, the Nile"},
    {"id": "medium", "label": "Medium",
     "filter": "dis_av_cms>=10", "min_cms": 10,
     "note": "the main river network, tributaries included"},
    {"id": "fine", "label": "Fine",
     "filter": "dis_av_cms>=1", "min_cms": 1,
     "note": "every channel carrying more than a cubic metre a second"},
    {"id": "full", "label": "Full detail",
     "filter": None, "min_cms": 0,
     "note": "every reach in the network, down to 0.1 m³/s and 10 km² of catchment"},
]

# ── the cartography ──────────────────────────────────────────────────────
# WHY WE DRAW IT OURSELVES
# -------------------------
# The publisher's published style (`river_network_v1`, "River Network - Order
# and Perenniality") is a DARK-ON-LIGHT cartography: order 1 is #042946
# (near-black navy) and the pale classes carry the fine network. Over the
# map's default DARK satellite basemap the main stems therefore VANISH and
# only the pale tributaries survive — the layer draws, and the reader sees
# almost nothing. The site's own rule says it: a ramp with a dark end is
# invisible on a dark map.
#
# So the client sends its own SLD (GeoServer's `sld_body` vendor
# parameter). It is derived from the same attributes the published style
# uses — `ord_flow` and `smooth_200` — and it is BRIGHT AT BOTH ENDS, so
# the greatest rivers read as white and the finest twigs read as a pale
# thread rather than disappearing.
#
# It also fixes a GAP in the published style: that style has rules for
# `ord_flow` 1..6 only, so **every reach of order 7 and finer is not drawn
# at all** — and those are 59 % of the network (42,610 of 71,687 reaches
# over the lower Amazon). A GetMap with `CQL_FILTER=dis_av_cms<1` renders
# a tile with ZERO opaque pixels. Our SLD adds the missing class, which is
# what makes "Full detail" mean anything.
#
# The table is published in meta.json, so the LEGEND and the MAP are drawn
# from the same rows and cannot disagree.
CLASSES = [
    {"id": "great", "title": "Great rivers", "min_ord": 1, "max_ord": 2,
     "color": "#ffffff", "width": 1.25},
    {"id": "large", "title": "Large rivers", "min_ord": 3, "max_ord": 4,
     "color": "#67e8f9", "width": 0.85},
    {"id": "medium", "title": "Streams", "min_ord": 5, "max_ord": 6,
     "color": "#38bdf8", "width": 0.60},
    {"id": "fine", "title": "Fine detail (order 7+)", "min_ord": 7, "max_ord": None,
     "color": "#93c5fd", "width": 0.35},
]

INTERMITTENT = {"id": "intermittent", "title": "Intermittent",
                "color": "#fbbf24", "width": 0.45, "dashed": True}


def _is_perennial() -> str:
    return ("<ogc:PropertyIsEqualTo><ogc:PropertyName>smooth_200</ogc:PropertyName>"
            "<ogc:Literal>P</ogc:Literal></ogc:PropertyIsEqualTo>")


def class_filter(c: dict) -> str:
    """The ogc:Filter for one class.

    The ranges are DISJOINT on purpose. Two facts about GeoServer's SLD
    engine, both measured against this server:

    * **Every matching rule renders.** The rules are not "first match
      wins" — a reach that matches four of them is drawn four times, and
      the LAST one is what the reader sees. A cumulative ladder
      (`ord_flow <= 2`, then `ord_flow <= 4`, …) therefore paints the
      Amazon in the palest colour of the ramp, because every reach also
      matched the last rule. Measured: the whole Amazon came out
      `#93c5fd`.
    * **`ogc:PropertyIsBetween` CRASHES the renderer.** A dynamic SLD
      using it answers HTTP 200 with a ServiceException carrying
      `java.lang.NullPointerException` — a blank tile and a silent
      failure, not an error the reader can see. `PropertyIsEqualTo`,
      `PropertyIsLessThanOrEqualTo` and
      `PropertyIsGreaterThanOrEqualTo` all work, so a range is expressed
      as an `ogc:And` of the two, which is what the publisher's own
      published style does.

    Every order class also carries `smooth_200 = 'P'`, so it cannot also
    match the intermittent rule: without that, a dashed intermittent reach
    is drawn twice and the solid one covers the dash.
    """
    lo, hi = c.get("min_ord"), c.get("max_ord")
    if lo is None:
        return ("<ogc:PropertyIsEqualTo><ogc:PropertyName>smooth_200</ogc:PropertyName>"
                "<ogc:Literal>I</ogc:Literal></ogc:PropertyIsEqualTo>")
    parts = [_is_perennial(),
             "<ogc:PropertyIsGreaterThanOrEqualTo>"
             "<ogc:PropertyName>ord_flow</ogc:PropertyName>"
             "<ogc:Literal>%d</ogc:Literal>"
             "</ogc:PropertyIsGreaterThanOrEqualTo>" % lo]
    if hi is not None:
        parts.append(
            "<ogc:PropertyIsLessThanOrEqualTo>"
            "<ogc:PropertyName>ord_flow</ogc:PropertyName>"
            "<ogc:Literal>%d</ogc:Literal>"
            "</ogc:PropertyIsLessThanOrEqualTo>" % hi)
    return "<ogc:And>" + "".join(parts) + "</ogc:And>"


def build_sld(classes: list, intermittent: dict) -> str:
    """The compact SLD the client sends as `sld_body`.

    It is COMPACT on purpose: it travels in the URL of every tile request,
    and a request line has to stay well inside the 8 KB that a servlet
    container will accept. No whitespace, no <Title>s, no line joins.
    """
    rules = []
    # The intermittent rule comes FIRST: GeoServer renders EVERY matching
    # rule, so a reach that is both intermittent and of order 3 is drawn
    # twice — dashed amber and then solid blue, one over the other. The
    # intermittent rule is therefore given a filter that EXCLUDES the
    # perennial classes (smooth_200 = 'I'), and it is drawn first so the
    # dash is the one on top.
    all_rules = [intermittent] + list(classes)
    for c in all_rules:
        stroke = ('<CssParameter name="stroke">%s</CssParameter>'
                  '<CssParameter name="stroke-width">%s</CssParameter>'
                  % (c["color"], c["width"]))
        if c.get("dashed"):
            stroke += '<CssParameter name="stroke-dasharray">4 4</CssParameter>'
        rules.append(
            '<Rule><Name>%s</Name><ogc:Filter>%s</ogc:Filter>'
            '<LineSymbolizer><Stroke>%s</Stroke></LineSymbolizer></Rule>'
            % (c["id"], class_filter(c), stroke))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<StyledLayerDescriptor version="1.0.0" '
        'xmlns="http://www.opengis.net/sld" '
        'xmlns:ogc="http://www.opengis.net/ogc">'
        '<NamedLayer><Name>river_network</Name>'
        '<UserStyle><Title>Xyzo rivers — flow order and perenniality</Title>'
        '<FeatureTypeStyle>' + "".join(rules) +
        '</FeatureTypeStyle></UserStyle></NamedLayer>'
        '</StyledLayerDescriptor>'
    )


# ── the names ────────────────────────────────────────────────────────────
# Words that make a basin name a PLACE rather than a river. A name carrying
# one of these is dropped: "Gobi Interior", "Hudson Bay Coast", "Lake Chad",
# "Sahara", "Arabian Peninsula", "Caspian Sea, East Coast". The list is a
# judgement, and it is a VISIBLE one — every name it drops is a name the
# reader would have seen as a mistake.
REGION_WORDS = (
    "interior", "coast", "peninsula", "desert", "plateau", "lake", "sea",
    "gulf", "ocean", "island", "depression", "basin", "range", "mountain",
    "mountains", "highland", "highlands", "lowland", "lowlands", "valley",
    "region", "estuary", "bay", "sound", "strait", "delta", "marsh",
    "swamp", "wetland", "forest", "steppe", "savanna", "hill", "hills",
    "ridge", "tundra", "glacier", "oasis", "plain", "plains", "trench",
    "canyon", "gorge", "reef", "bank", "shoal", "slope", "flat", "shelf",
    "isthmus", "archipelago", "atoll", "cape", "fjord", "firth", "lagoon",
    "spring", "springs", "well", "wells", "dune", "dunes", "sand",
    "karst", "volcanic", "crater", "caldera", "taiga", "jungle", "wold",
    "weald", "downs", "heights", "shore", "beach", "cove", "harbour",
    "harbor", "port", "anchorage", "fjords", "wetlands", "marshland",
    # The named deserts and dry regions, which the dataset also carries
    # as basins. Their wadis are real watercourses, but the NAME the
    # dataset gives them is the desert.
    "sahara", "gobi", "taklamakan", "kalahari", "karakum", "kyzylkum",
    "mojave", "sonoran", "atacama", "patagonia", "outback", "steppe",
)

# A trailing digit is the FAO's own disambiguator between same-named
# basins — "Orinoco 8", "Courantyne 2", "Amur1"…"Amur4" are the same
# river's numbered sub-basins, not four different rivers. Left alone, the
# map would print "Amur", "Amur1", "Amur2", "Amur3" and "Amur4".
def strip_index(name: str) -> str:
    out = name.strip()
    while out and out[-1].isdigit():
        out = out[:-1].strip()
    return out


# ── the publisher's mangled accents ─────────────────────────────────────
#
# MEASURED AT THE SOURCE (2026-11-09): the FAO's WFS sends the bytes
# `c3 af c2 bf c2 bd` for a name that should read "Ariège" — that is the
# UTF-8 of U+FFFD, the REPLACEMENT CHARACTER, encoded a second time.
# The original accent is NOT in the data: the publisher lost it and
# published the loss. Verified by fetching the same feature from the
# live WFS (`startIndex=31300`) and looking at the raw bytes — the
# mangling is in THEIR response, not in our download.
#
# 1,546 of the 86,882 source features carry it ("Ariï¿½ge",
# "Bahï¿½a Lechuguilla", "Bolaï¿½os"). Printing the mojibake on a map is
# worse than admitting the character is unknown, so the sequence
# becomes a plain "?".
MOJIBAKE = "ï¿½"


def repair_mojibake(name: str) -> str:
    if MOJIBAKE not in name:
        return name
    return name.replace(MOJIBAKE, "?")


# Words that mean "this is a DESCRIPTION of an area", not a river.
#
# The source carries 16 such names and they are in SPANISH, which is
# why the English REGION_WORDS list above never caught them:
# "Zona de rios en Chaco Boreal", "Zona sin rios de importancia en
# Patagonia", "Zona de lago Los Mistoles". On a map they read as a
# sentence, not a name.
DESCRIPTION_WORDS = (
    "zona", "cuenca", "versante", "lagos", "sin rios", "sin importance",
)


# A name of one or two letters is the FAO's ABBREVIATED label for a
# sub-basin, not a name of its own — and the parent is published under
# its own name anyway. Measured on the source (86,882 features): "Aro"
# is a reach of the ORINOCO, "Ko" one of LAKE CHAD, "Lom" one of the
# DANUBE, "Mu" one of the IRRAWADDY, "Lo" one of the Hong (Red River),
# "Ma" one of the SALWEEN, "Yi" one of the La Plata. So dropping the
# abbreviation loses nothing: the map still says "Irrawaddy" and
# "Danube". Three letters is kept ("Ain", "Aare", "Amur" are names in
# their own right).
MIN_NAME_LEN = 3


# "Mouth of the Amazon" is a REACH of the Amazon, not a name for it. The
# dataset names its last segment that way; on a map it reads as a mistake.
MOUTH_PREFIXES = ("mouth of ", "upper mouth of ", "lower mouth of ")


def looks_like_a_river(name: str) -> bool:
    if not name:
        return False
    low = name.lower()
    for w in REGION_WORDS:
        if w in low:
            return False
    # A DESCRIPTION of an area is not a river (see DESCRIPTION_WORDS).
    for w in DESCRIPTION_WORDS:
        if w in low:
            return False
    # An abbreviation is not a river ("Ob", "Ko", "Po").
    if len(name) < MIN_NAME_LEN:
        return False
    # A name that is only a number is an id, not a river.
    if not any(ch.isalpha() for ch in name):
        return False
    return True


def log(msg: str) -> None:
    print(f"[fao-rivers] {msg}", flush=True)


# ── fetching ─────────────────────────────────────────────────────────────
def _get(url: str, timeout: int = 180) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "xyzo-river-build/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_classic(page_size: int = 5000) -> list:
    """Page the classic FAO rivers layer and return its features."""
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    features: list = []
    start = 0
    while True:
        q = {
            "service": "WFS", "version": "1.1.0", "request": "GetFeature",
            "typeName": CLASSIC_TYPE, "srsName": "EPSG:4326",
            "outputFormat": "application/json", "maxFeatures": str(page_size),
            "startIndex": str(start),
        }
        url = WFS_BASE + "?" + urllib.parse.urlencode(q)
        raw = _get(url)
        fc = json.loads(raw.decode("utf-8"))
        batch = fc.get("features") or []
        if not batch:
            break
        features.extend(batch)
        start += len(batch)
        log(f"  fetched {start} features")
        if len(batch) < page_size:
            break
        time.sleep(0.2)          # one host, sequentially — be polite
    with open(CACHE, "w") as fh:
        json.dump(features, fh, separators=(",", ":"))
    return features


def load_cached() -> list:
    with open(CACHE) as fh:
        return json.load(fh)


# ── geometry helpers ─────────────────────────────────────────────────────
def longest_line(geom: dict):
    """The longest part of a (Multi)LineString geometry."""
    if not geom or not geom.get("coordinates"):
        return None
    if geom.get("type") == "LineString":
        return geom["coordinates"]
    if geom.get("type") == "MultiLineString":
        best = None
        for line in geom["coordinates"]:
            if best is None or len(line) > len(best):
                best = line
        return best
    return None


def anchor_at(line, fraction: float = 1.0 / 3.0):
    """A point `fraction` along the line, in Leaflet's [lat, lng] order."""
    if not line or len(line) < 2:
        return None
    i = int(round((len(line) - 1) * fraction))
    i = max(0, min(len(line) - 1, i))
    x, y = line[i][0], line[i][1]
    return [round(float(y), 5), round(float(x), 5)]


# ── building ─────────────────────────────────────────────────────────────
def build_labels(features: list) -> tuple:
    """One anchor per distinct river name.

    Returns (labels, stats). A label is
      {"name", "lat", "lng", "strahler", "basin", "regime"}
    """
    best: dict = {}
    dropped_region = 0
    dropped_nonname = 0

    for f in features:
        props = f.get("properties") or {}
        maj = (props.get("maj_name") or "").strip()
        sub = (props.get("sub_name") or "").strip()
        strahler = props.get("strahler")
        regime = props.get("regime")
        try:
            strahler = int(strahler)
        except (TypeError, ValueError):
            strahler = 0

        line = longest_line(f.get("geometry") or {})
        if not line or len(line) < 2:
            continue
        # The anchor is on the longest stem, so the name sits on the river
        # and not on a fragment of it.
        pt = anchor_at(line)
        if not pt:
            continue
        weight = (strahler, len(line))

        for raw, basin in ((sub, maj), (maj, "")):
            if not raw:
                continue
            low = raw.lower().strip()
            if low.startswith(MOUTH_PREFIXES):
                dropped_region += 1
                continue
            # The publisher's mangled accents become a plain "?" — the
            # character itself is gone from their data (see MOJIBAKE).
            name = strip_index(repair_mojibake(raw))
            if not name:
                continue
            if not looks_like_a_river(name):
                dropped_region += 1
                continue
            cur = best.get(name)
            if cur is None or weight > cur["weight"]:
                best[name] = {
                    "name": name,
                    "lat": pt[0],
                    "lng": pt[1],
                    "strahler": strahler,
                    "basin": basin,
                    "regime": regime,
                    "weight": weight,
                }

    labels = sorted(
        ({"name": v["name"], "lat": v["lat"], "lng": v["lng"],
          "strahler": v["strahler"], "basin": v["basin"],
          "regime": v["regime"]}
         for v in best.values()),
        key=lambda d: (-d["strahler"], d["name"]),
    )
    stats = {
        "labels": len(labels),
        "dropped_region_names": dropped_region,
        "dropped_nonames": dropped_nonname,
    }
    return labels, stats


def write_outputs(labels: list, stats: dict) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    # The SLD the client sends to the WMS. It is PUBLISHED rather than
    # rebuilt in the browser, because a second implementation of it in
    # JavaScript would be a second source of truth — and the one that
    # drifts is the one nobody checks. The legend's class table is
    # published beside it, so the key and the map come from the same rows.
    #
    # It travels INSIDE meta.json rather than as its own file: one
    # request instead of two, no content-type to get wrong (Caddy does
    # not know what an .sld is and serves it with no type at all), and
    # the service worker already keeps every .json network-first.
    sld = build_sld(CLASSES, INTERMITTENT)

    fc = {
        "type": "FeatureCollection",
        "name": "fao_river_labels",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": l["name"],
                    "strahler": l["strahler"],
                },
                "geometry": {"type": "Point",
                             "coordinates": [round(l["lng"], 4), round(l["lat"], 4)]},
            }
            for l in labels
        ],
    }
    path = os.path.join(OUT_DIR, "labels.geojson")
    with open(path, "w") as fh:
        json.dump(fc, fh, separators=(",", ":"))

    meta = {
        "source": "FAO AQUASTAT — Rivers (Global, edition 2026), from HydroRIVERS",
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        "license_url": LICENSE_URL,
        "url": SOURCE_URL,
        "wfs_url": WFS_DOC,
        # The UPSTREAM licence travels with the metadata (see the
        # constants above) — the build must not be able to drop it.
        "upstream": UPSTREAM,
        "upstream_attribution": UPSTREAM_ATTRIBUTION,
        "upstream_citation": UPSTREAM_CITATION,
        "wms": {
            "url": WMS_URL,
            "layer": WMS_LAYER,
            "style": WMS_STYLE,
            "title": "River Network - Order and Perenniality",
            "note": ("The published style draws each reach by its flow order "
                     "(1 = the greatest rivers, dark; 6 = the smallest, pale) "
                     "and draws the INTERMITTENT reaches as a dashed line — "
                     "the perennial/intermittent classification of the 2026 "
                     "edition."),
        },
        "edition": "2026",
        "published": "2026-06-15",
        "revised": "2026-07-16",
        "classes": CLASSES,
        "intermittent": INTERMITTENT,
        "sld": {
            "body": sld,
            "bytes": len(sld),
            "note": ("The client sends this SLD to the WMS as `sld_body`. It "
                     "is the cartography the map and the legend both use: "
                     "BRIGHT AT BOTH ENDS, because the publisher's own "
                     "published style is dark-on-light and its order-1 rivers "
                     "(#042946) vanish on this site's default dark basemap. "
                     "It also adds the class the published style omits — "
                     "that style has rules for ord_flow 1..6 only, so every "
                     "reach of order 7 and finer (59 % of the network) is "
                     "not drawn by it at all."),
            "published_style_omits_ord_flow": 7,
            "published_style_colours": {
                "order1": "#042946", "order2": "#0f4165", "order3": "#21618e",
                "order4": "#689bc1", "order5": "#a1cdee", "order6": "#daeffe",
                "intermittent": "#dedbdb",
            },
        },
        "labels": {
            "file": "labels.geojson",
            "count": len(labels),
            "source_layer": "aquamaps:rivers_world_47950 (FAO AQUASTAT classic rivers)",
            "note": ("The 2026 network carries no names on its reaches; the "
                     "names come from the FAO's own classic rivers layer, "
                     "which carries the major-basin and sub-basin names of "
                     "the same AQUASTAT family."),
            **stats,
        },
        "levels": LEVELS,
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)


# ── verification ─────────────────────────────────────────────────────────
# The rivers that must be present, at a point they genuinely cross.
# A swapped axis or a shifted projection puts the Amazon in the wrong
# ocean and every probe fails at once.
#
# The geography is checked against the SOURCE features — "is there a reach
# of the Nile within a few hundred kilometres of this point?" — and the
# published set is checked for the NAME. Checking the published ANCHOR
# against a point would be wrong: the anchor sits where the river's longest
# stem is, and the Nile's longest stem is in Egypt, 1,500 km from the
# probe in Sudan.
LABEL_PROBES = [
    ("Amazon", -3.0, -60.0),
    ("Nile", 15.5, 32.5),
    ("Mississippi", 35.0, -90.5),
    ("Danube", 48.0, 17.5),
    ("Yangtze", 30.5, 112.5),
    ("Congo", -1.5, 20.0),
]

# The WMS must actually answer for the layer, and for every filter the
# client is going to send it. A dead endpoint is a legend that lies.
#
# WMS 1.3.0 + `srs=EPSG:4326` has the AXIS-ORDER trap: 1.3.0 says the axis
# order is the one the CRS authority defines, which for EPSG:4326 is
# (latitude, longitude). Ask for the Amazon with `bbox=-62,-5,-52,0` and
# the server renders **Antarctica** — a blank tile, a 200 response and no
# error at all. The server's own capability document has the same
# confusion (its EPSG:4326 BoundingBox has minx and miny swapped). So the
# probe asks for **1.1.1**, where the order is mandated to be
# (longitude, latitude) whatever the CRS says.
#
# The probe box is the Amazon basin, because it is where the four levels
# actually differ: the main stem is over 100 m³/s and its floodplain
# creeks are under 1.
WMS_PROBE_BBOX = "-62,-5,-52,0"     # WGS84 lon/lat — the lower Amazon


def _nearest_source_distance(features: list, name: str, lat: float, lng: float):
    """Distance in degrees to the nearest reach carrying this name.

    A prefix match counts: the source calls the Mississippi reach
    "Mississippi - Missouri" and the Danube's basin "Danube", and both
    are the river the probe is asking about.
    """
    target = name.lower()
    best = None
    for f in features:
        props = f.get("properties") or {}
        names = {strip_index((props.get("maj_name") or "").strip()).lower(),
                 strip_index((props.get("sub_name") or "").strip()).lower()}
        if not any(n == target or n.startswith(target) for n in names if n):
            continue
        line = longest_line(f.get("geometry") or {})
        if not line:
            continue
        for x, y in line[::3]:
            d = ((y - lat) ** 2 + ((x - lng) * 0.85) ** 2) ** 0.5
            if best is None or d < best:
                best = d
    return best


def wms_probe(cql: str | None) -> bool:
    q = {
        "service": "WMS", "version": "1.1.1", "request": "GetMap",
        "layers": WMS_LAYER, "styles": "", "bbox": WMS_PROBE_BBOX,
        "width": "256", "height": "256", "srs": "EPSG:4326",
        "format": "image/png", "transparent": "true",
        # The client sends OUR SLD, so the probe does too — a probe of the
        # publisher's style would test a thing nobody uses.
        "sld_body": build_sld(CLASSES, INTERMITTENT),
    }
    if cql:
        q["CQL_FILTER"] = cql
    url = WMS_URL + "?" + urllib.parse.urlencode(q)
    try:
        raw = _get(url, timeout=180)
    except Exception as exc:                        # noqa: BLE001
        log(f"  WMS probe FAILED ({cql or 'no filter'}): {exc}")
        return False
    if not raw.startswith(b"\x89PNG"):
        log(f"  WMS probe FAILED ({cql or 'no filter'}): not a PNG")
        return False
    log(f"  WMS ok ({cql or 'no filter'}): {len(raw)} bytes")
    return True


def _probe_bytes(cql: str | None, sld: str | None) -> int:
    q = {
        "service": "WMS", "version": "1.1.1", "request": "GetMap",
        "layers": WMS_LAYER, "styles": "", "bbox": WMS_PROBE_BBOX,
        "width": "256", "height": "256", "srs": "EPSG:4326",
        "format": "image/png", "transparent": "true",
    }
    if cql:
        q["CQL_FILTER"] = cql
    if sld:
        q["sld_body"] = sld
    else:
        q["styles"] = WMS_STYLE
    return len(_get(WMS_URL + "?" + urllib.parse.urlencode(q), timeout=180))


def verify(features: list | None = None) -> bool:
    ok = True
    path = os.path.join(OUT_DIR, "labels.geojson")
    if not os.path.exists(path):
        print(f"[fao-rivers] no {path}", file=sys.stderr)
        return False
    with open(path) as fh:
        fc = json.load(fh)
    labels = fc["features"]
    published = {(f["properties"] or {}).get("name") for f in labels}

    if features is None and os.path.exists(CACHE):
        features = load_cached()

    for name, lat, lng in LABEL_PROBES:
        named = name in published or any(
            (n or "").startswith(name) for n in published if n)
        geo = None
        if features:
            geo = _nearest_source_distance(features, name, lat, lng)
        # The name must be published, and it must belong to a river that
        # really is at that place (within ~2° ≈ 220 km).
        geo_ok = geo is not None and geo < 2.0
        good = named and geo_ok
        log(f"probe {name:12s} ({lat:6.1f},{lng:7.1f}) -> "
            f"name={'yes' if named else 'NO'} "
            f"nearest={'%.2f°' % geo if geo is not None else '?'} "
            f"{'ok' if good else 'FAIL'}")
        if not good:
            ok = False

    # The four levels must not all draw the SAME picture — a filter that is
    # ignored looks exactly like a filter that matches everything. The
    # probe uses OUR SLD, because that is what the client sends.
    sizes = {}
    for lvl in LEVELS:
        if not wms_probe(lvl["filter"]):
            ok = False
            sizes[lvl["id"]] = 0
            continue
        sizes[lvl["id"]] = _probe_bytes(lvl["filter"],
                                        build_sld(CLASSES, INTERMITTENT))
    if len(set(sizes.values())) < len(sizes):
        log(f"  WMS levels are NOT all different: {sizes}")
        ok = False
    else:
        log(f"  WMS levels differ: {sizes}")

    # THE GAP IN THE PUBLISHED STYLE — the reason this layer draws itself.
    # The publisher's style has rules for ord_flow 1..6 only, so the reaches
    # of order 7 and finer are not drawn by it: a GetMap for exactly those
    # reaches comes back as a tile with NOTHING in it. Our own SLD draws
    # them. Both halves are checked, because the first one alone would pass
    # on a server that simply had no data there.
    published = _probe_bytes("dis_av_cms<1", None)
    ours = _probe_bytes("dis_av_cms<1", build_sld(CLASSES, INTERMITTENT))
    if published >= ours:
        log(f"  the published style draws the fine reaches "
            f"({published} >= {ours} bytes) — the gap has been closed "
            f"upstream, so our own SLD may no longer be needed")
        ok = False
    else:
        log(f"  the published style draws NOTHING of the fine reaches "
            f"({published} bytes) while our SLD draws them "
            f"({ours} bytes) — confirmed")
    return ok


def main() -> int:
    global OUT_DIR

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--skip-fetch", action="store_true",
                    help="rebuild the labels from the cached download")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    OUT_DIR = args.out

    if args.verify_only:
        return 0 if verify() else 2

    if args.skip_fetch and os.path.exists(CACHE):
        log("using the cached classic-rivers download")
        features = load_cached()
    else:
        log("fetching the FAO classic rivers layer (names) …")
        features = fetch_classic()
    log(f"{len(features)} classic river features")

    labels, stats = build_labels(features)
    write_outputs(labels, stats)
    log(f"{stats['labels']} river names "
        f"({stats['dropped_region_names']} place names dropped)")

    if not verify(features):
        print("[fao-rivers] verification FAILED — refusing to leave bad data",
              file=sys.stderr)
        return 2
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
