"""One-off: apply the corrections discovered during the validation sweep.

Run from the repo root:  python3 scripts/wildlife_registry_patch.py

This applies the corrections that a HUMAN can see (a wrong feed URL, a wrong
publisher name, a feed that is really the general news feed rather than a
wildlife feed). It does NOT decide which entries are dead — that is derived
from the probe report by ``worker.wildlife_sources.derive_skip_flags()``, so
the registry's status always matches the evidence.
"""
import json
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "worker" / "data" / "wildlife_sources.json"
doc = json.loads(P.read_text())
srcs = doc["sources"]
by_id = {s["id"]: s for s in srcs}

# ── reset any previous skip flags (they are derived, not hand-maintained) ──
for s in srcs:
    s.pop("skip", None)
    s.pop("skip_reason", None)

# ── corrected feed URLs ──
FEED_FIX = {
    "mongabay_indonesia": (
        ["https://news.mongabay.com/location/indonesia/feed/"],
        "https://news.mongabay.com/location/indonesia/",
    ),
    "mongabay_brasil": (
        ["https://news.mongabay.com/location/brazil/feed/"],
        "https://news.mongabay.com/location/brazil/",
    ),
}

for sid, (feeds, homepage) in FEED_FIX.items():
    s = by_id.get(sid)
    if not s:
        continue
    if feeds:
        s["feeds"] = feeds
    if homepage:
        s["homepage"] = homepage

# The feed at elephantconservation.org is the International Elephant Foundation.
s = by_id.get("elephant_conservation_sri_lanka")
if s:
    s["name"] = "International Elephant Foundation"

# ── entries that are NOT news feeds at all (data portals / databases) ──
DATA_PORTALS = {
    "iucn_redlist": "IUCN Red List — assessment database, not a news feed",
    "gbif": "GBIF — open occurrence data portal, not a news feed",
    "inaturalist": "iNaturalist — observation platform, not a news feed",
    "living_planet_index": "WWF Living Planet Index — research portal, not a news feed",
    "seamless_india_biodiversity": "Seamless India Biodiversity — occurrence data portal",
    "indian_biodiversity_portal": "Indian Biodiversity Portal — species data portal",
    "natureserve": "NatureServe Explorer — conservation-status dataset",
    "natureserve_news": "NatureServe — no working feed",
    "protected_planet": "Protected Planet — protected-areas database",
    "species_plus": "Species+ — CITES species data portal",
    "obis": "OBIS — marine occurrence database",
    "animalia_bio": "BioLib — taxonomy/occurrence database",
    "fishbase": "FishBase — fish species database",
    "wd_ramsar": "Ramsar RSIS — wetland data service",
    "birdlife_data": "BirdLife Data Zone — species/IBAdata portal",
    "birdlife_datazone": "BirdLife DataZone — species data portal (299 entries, kept as a data feed)",
    "wildlife_data_collective": "Wildlife Data Collective — camera-trap data platform",
    "marine_protection_atlas": "Marine Protection Atlas — MPA data portal",
    "earthwatch": "Earthwatch — citizen-science programme, no feed",
    "wcrm": "WCRM — project portal, no feed",
    "obis_alt": "duplicate OBIS entry",
    "wildlife_biodiversity_data": "duplicate biodiversity-data entry",
}
for sid, note in DATA_PORTALS.items():
    s = by_id.get(sid)
    if s:
        s["note"] = note
        s["data_portal"] = True

# ── feeds that are GENERAL news, not specialist wildlife ──
# The topic label must not overclaim: a general feed tagged "wildlife" makes
# the wildlife filter on the map lie.
GENERAL = {
    "bbc_science_environment": ("science", ["science", "environment"]),
    "pbs_newshour": ("science", ["science"]),
    "euronews_green": ("environment", ["environment", "climate"]),
    "physorg_biology": ("science", ["science", "biology"]),
    "sciencedaily_biology": ("science", ["science", "biology"]),
    "the_conversation_environment": ("science", ["science", "environment"]),
    "science_zoology": ("science", ["science", "biology"]),
    "journal_of_applied_ecology": ("science", ["science"]),
    "wildlife_ecology": ("science", ["science"]),
    "wildlife_society_journal": ("science", ["science"]),
    "bird_study": ("science", ["science"]),
    "restoration_journal": ("science", ["science"]),
    "nature_news": ("science", ["science"]),
    "nasa_earth_observatory": ("earth", ["environment"]),
    "un_water_biodiversity": ("environment", ["environment"]),
    "unesco_biodiversity": ("environment", ["environment"]),
    "woah": ("earth", ["wildlife", "health"]),
    "woah_standards": ("earth", ["wildlife", "health"]),
    "ebird": ("earth", ["birds"]),
    "eBird": ("earth", ["birds"]),
    "woodah": ("earth", ["wildlife", "health"]),
    "wildlife_biodiversity": ("earth", ["biodiversity"]),
    "biodiversity_international": ("earth", ["biodiversity"]),
    "birdlife_datazone": ("earth", ["birds", "biodiversity"]),
    "ramsar_sites": ("earth", ["wetlands"]),
    "wd_ramsar": ("earth", ["wetlands"]),
    "obis": ("science", ["biology", "marine"]),
    "animalia_bio": ("science", ["biology"]),
    "fishbase": ("science", ["biology", "marine"]),
    "protected_planet": ("earth", ["protected-areas"]),
    "species_plus": ("earth", ["biodiversity"]),
    "wildlife_data_collective": ("science", ["biology"]),
    "marine_protection_atlas": ("earth", ["marine"]),
    "living_planet_index": ("science", ["biology"]),
    "earthwatch": ("science", ["biology"]),
    "natureserve": ("science", ["biology"]),
}

for sid, (topic, topics) in GENERAL.items():
    s = by_id.get(sid)
    if not s:
        continue
    s["feed_scope"] = "general"
    s["topic"] = topic
    s["topics"] = topics

# Everything else is a specialist wildlife / conservation feed.
for s in srcs:
    s.setdefault("feed_scope", "wildlife")
    s.setdefault("topic", "wildlife")

P.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
print(f"corrected {len(FEED_FIX)} feed URLs, flagged {len(GENERAL)} general-scope feeds")
