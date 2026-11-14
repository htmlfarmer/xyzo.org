"""Newsium city text detection — Python port of the JS CityEngine.

Same algorithm as `public_html/city-engine.js` so server-side and
client-side detection produce identical results. Used by:

  * worker/extract.py — pre-extraction: scan title+body before calling
    Gemma, providing a city hint so the AI doesn't waste tokens on
    easy cases. When the hint is high-confidence, the article can be
    geocoded without any further inference.

  * Any future server-side text scanner (admin tools, batch reports).

Self-contained; loads /world_cities via the existing FDW foreign
table so it reads from xyzo_cities transparently.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from pathlib import Path
from typing import Any

from .db import connect

log = logging.getLogger("xyzo.cities_text")

# ── Entity-to-location mapping ──────────────────────────────────────
# Loaded from data/entity_locations.json. Maps company/organization
# names to their headquarters city + country. Used to recognize that
# "Microsoft" means Seattle/Redmond, "Apple" means Cupertino, etc.
ENTITY_LOCATIONS_PATH = Path(__file__).parent.parent / "data" / "entity_locations.json"
_entity_index: dict[str, dict] | None = None


def _load_entity_locations() -> dict[str, dict]:
    """Load entity→location mapping. Returns {lowercase_name: {city, country, lat, lng}}."""
    global _entity_index
    if _entity_index is not None:
        return _entity_index
    try:
        with ENTITY_LOCATIONS_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
        entities = data.get("entities", {})
        aliases = data.get("_aliases", {})
        index: dict[str, dict] = {}
        for name, loc in entities.items():
            index[name.lower()] = loc
        for alias, canonical in aliases.items():
            if canonical.lower() in index:
                index[alias.lower()] = index[canonical.lower()]
        _entity_index = index
        log.info("entity locations loaded: %d entries", len(index))
    except Exception as e:
        log.warning("failed to load entity_locations.json: %s", e)
        _entity_index = {}
    return _entity_index

# ── Built-in aliases (mirror of public_html/city-engine.js) ─────────
ALIASES: dict[str, str] = {
    "new york": "New York City",
    "nueva york": "New York City",
    "nova york": "New York City",
    "nova iorque": "New York City",
    "nuova york": "New York City",
    "neu-york": "New York City",
    "neuyork": "New York City",
    "нью-йорк": "New York City",
    "нью йорк": "New York City",
    "нью-йорка": "New York City",
    "nyc": "New York City",
    "la": "Los Angeles",
    "sf": "San Francisco",
    "dc": "Washington",
    "philly": "Philadelphia",
    "vegas": "Las Vegas",
    "kc": "Kansas City",
    "nola": "New Orleans",
    "nueva orleans": "New Orleans",
    "nova orleans": "New Orleans",
    "nuova orleans": "New Orleans",
    "la nouvelle-orléans": "New Orleans",
    "la nouvelle orléans": "New Orleans",
    "nouvelle orléans": "New Orleans",
    "nouvelle orleans": "New Orleans",
    "новый орлеан": "New Orleans",
    "новом орлеане": "New Orleans",
    "nuevo mexico": "Albuquerque",
    "nuevo méxico": "Albuquerque",
    "novo mexico": "Albuquerque",
    "novo méxico": "Albuquerque",
    "nouveau-mexique": "Albuquerque",
    "nouveau mexique": "Albuquerque",
    "neu-mexiko": "Albuquerque",
    "neu mexiko": "Albuquerque",
    "нью-мексико": "New Mexico",
    "нью мексико": "New Mexico",
    "nueva jersey": "Newark",
    "nova jersey": "Newark",
    "нью-джерси": "New Jersey",
    "нью джерси": "New Jersey",
    "delhi": "New Delhi",
    "nueva delhi": "New Delhi",
    "nova deli": "New Delhi",
    "nuova delhi": "New Delhi",
    "neu-delhi": "New Delhi",
    "neu delhi": "New Delhi",
    "нью-дели": "New Delhi",
    "нью дели": "New Delhi",
    "cdmx": "Mexico City",
    "ciudad de mexico": "Mexico City",
    "ciudad de méxico": "Mexico City",
    "cidade do mexico": "Mexico City",
    "cidade do méxico": "Mexico City",
    "città del messico": "Mexico City",
    "bombay": "Mumbai",
    "madras": "Chennai",
    "calcutta": "Kolkata",
    "bangalore": "Bengaluru",
    "peking": "Beijing",
    "saigon": "Ho Chi Minh City",
    "hcmc": "Ho Chi Minh City",
    "hk": "Hong Kong",
    "rio": "Rio de Janeiro",
    "ba": "Buenos Aires",
    "joburg": "Johannesburg",
    "vatican": "Vatican City",
    "constantinople": "Istanbul",
    "moskva": "Moscow",
    "leningrad": "Saint Petersburg",
    "st petersburg": "Saint Petersburg",
    "st. petersburg": "Saint Petersburg",
    "bali": "Denpasar",
    "tema, ghana": "Tema",
    "tema, gh": "Tema",
    "port of tema": "Tema",
    "tema port": "Tema",
    "tema motorway": "Tema",
    "tema newtown": "Tema",
    "tema oil refinery": "Tema",
}

ARABIC_CITY_ALIASES: dict[str, str] = {
    "القاهرة": "Cairo",
    "القاهره": "Cairo",
    "cairo": "Cairo",
    "الأسكندرية": "Alexandria",
    "الاسكندرية": "Alexandria",
    "اسكندريه": "Alexandria",
    "اسكندرية": "Alexandria",
    "alexandria": "Alexandria",
    "قنا": "Qena",
    "قنأ": "Qena",
    "الأقصر": "Luxor",
    "الاقصر": "Luxor",
    "لوكسور": "Luxor",
    "luxor": "Luxor",
    "أسوان": "Aswan",
    "اسوان": "Aswan",
    "aswan": "Aswan",
    "سوهاج": "Sohag",
    "سحاجه": "Sohag",
    "sohag": "Sohag",
    "أسيوط": "Asyut",
    "اسيوط": "Asyut",
    "asyut": "Asyut",
    "المنيا": "Minya",
    "منيا": "Minya",
    "minya": "Minya",
    "بني سويف": "Beni Suef",
    "بنى سويف": "Beni Suef",
    "beni suef": "Beni Suef",
    "الفيوم": "Faiyum",
    "الفيوم": "Faiyum",
    "faiyum": "Faiyum",
    "البحيرة": "Beheira",
    "البحر الأحمر": "Red Sea",
    "الشرقية": "Sharqia",
    "الدقهلية": "Dakahlia",
    "كفر الشيخ": "Kafr El Sheikh",
    "كفر الشيخ": "Kafr El Sheikh",
    "الغربية": "Gharbia",
    "المنوفية": "Menofia",
    "الوادي الجديد": "New Valley",
    "مطروح": "Matrouh",
    "السويس": "Suez",
    "suez": "Suez",
    "الإسماعيلية": "Ismailia",
    "الاسماعيلية": "Ismailia",
    "ismailia": "Ismailia",
    "بورسعيد": "Port Said",
    "بور سعيد": "Port Said",
    "port said": "Port Said",
    "دمياط": "Damietta",
    "damietta": "Damietta",
    "شبين الكوم": "Shibīn al Kawm",
    "شبين": "Shibīn al Kawm",
    "طنطا": "Tanta",
    "tanta": "Tanta",
    "الإسكندرية": "Alexandria",
    "الأسماعيلية": "Ismailia",
    "الزقازيق": "Zagazig",
    "زقازيق": "Zagazig",
    " zagazig": "Zagazig",
    "المنصورة": "Mansoura",
    "منصورة": "Mansoura",
    "mansoura": "Mansoura",
    "نجع": "Nag Hammadi",
    "النجع": "Nag Hammadi",
    "دشنا": "Dishna",
    "قنا الجديدة": "New Qena",
    "بني معروف": "Bani Murr",
    "سيوة": "Siwa",
    "siwa": "Siwa",
    "رأس غارب": "Ras Gharib",
    "مرسي مطروح": "Marsa Matrouh",
    "الطور": "Tur",
    "طور": "Tur",
    "شرم الشيخ": "Sharm El Sheikh",
    "شرم الشيخ": "Sharm El Sheikh",
    "sharm el sheikh": "Sharm El Sheikh",
    "دهب": "Dahab",
    "dahab": "Dahab",
    "نويبع": "Nuweiba",
    "طابا": "Taba",
    "كاسل": "Cairo",
    "الجيزة": "Giza",
    "الجيزه": "Giza",
    "giza": "Giza",
    "السادس من أكتوبر": "6th Of October",
    "6 أكتوبر": "6th Of October",
    "العباسية": "Abbasiya",
    " المعادي": "Maadi",
    "مصر الجديدة": "New Cairo",
    "مدينتي": "Madinaty",
    "الرماية": "Ramyram",
    "الرحاب": "Rehab",
    "بدر": "Badr",
    "الواحات": "El Wahat",
    "الواحات البحرية": "El Wahat El Bahariya",
    "الفرافرة": "Farafra",
    "بلصفورة": "Bilshe",
    "إدفو": "Edfu",
    "ادفو": "Edfu",
    "edfu": "Edfu",
    "أسوان الجديدة": "New Aswan",
    "كوم أمبو": "Kom Ombo",
    "أبو سمبل": "Abu Simbel",
    "ابو سمبل": "Abu Simbel",
    "سوهاج الجديدة": "New Sohag",
    "المراغة": "El Maragah",
    "طهطا": "Tahta",
    "دار السلام": "Dar El Salam",
    "البلينا": "El Badari",
    "ساقلته": "Saqlt",
    "أولاد铝": "Awlad",
}

MULTI_WORD_CITIES = (
    "new york city", "new york", "nueva york", "nova york", "nova iorque",
    "nuova york", "neu-york", "neuyork", "нью-йорк", "нью йорк", "нью-йорка",
    "los angeles", "san francisco", "san diego", "san jose", "san antonio",
    "san salvador", "sao paulo", "são paulo", "buenos aires", "rio de janeiro",
    "mexico city", "ciudad de mexico", "ciudad de méxico", "cidade do mexico",
    "cidade do méxico", "città del messico", "kuala lumpur", "hong kong",
    "new orleans", "nueva orleans", "nova orleans", "nuova orleans",
    "la nouvelle-orléans", "la nouvelle orléans", "nouvelle orléans",
    "nouvelle orleans", "новый орлеан", "новом орлеане",
    "new delhi", "nueva delhi", "nova deli", "nuova delhi", "neu-delhi",
    "neu delhi", "нью-дели", "нью дели",
    "nuevo mexico", "nuevo méxico", "novo mexico", "novo méxico",
    "nouveau-mexique", "nouveau mexique", "neu-mexiko", "neu mexiko",
    "nueva jersey", "nova jersey", "нью-джерси", "нью джерси",
    "las vegas", "los altos", "el paso", "la paz",
    "cape town", "dar es salaam", "addis ababa", "abu dhabi",
    "tel aviv", "west bank", "gaza strip", "ho chi minh city",
    "phnom penh", "kampala", "saint petersburg", "st petersburg",
    "st. petersburg", "saint louis", "st louis", "st. louis",
    "saint paul", "st paul", "st. paul",
    "tema, ghana", "tema, gh", "port of tema", "tema port", "tema motorway",
    "tema newtown", "tema oil refinery",
    # City + US state combinations (state name or abbreviation after city name)
    # These are special because small US towns have same name as famous foreign cities
    "moscow idaho", "moscow id", "canton ohio", "canton oh",
    "fargo north dakota", "fargo nd", "boise idaho", "boise id",
    "spokane washington", "spokane wa", "boulder colorado", "boulder co",
)

SKIP_WORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "this", "that", "are", "was",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "not", "no",
    "new", "old", "big", "small", "good", "bad", "first", "last",
    "long", "great", "little", "own", "other", "right", "high",
    "different", "large", "next", "early", "young", "important",
    "few", "public", "same", "able", "north", "south", "east", "west",
    "report", "news", "story", "article", "today", "yesterday",
    "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "january", "february", "march", "april",
    "may", "june", "july", "august", "september", "october", "november",
    "december", "us", "usa", "uk", "eu", "un",
    "man", "men", "most", "reading", "mobile", "deal", "nice", "bath",
    "best", "normal", "union", "central", "general", "van", "sur",
    "split", "splits", "sale", "sales", "independence", "surprise",
    "college", "enterprise", "marathon", "liberty",
    "opportunity", "heaven", "paradise", "freedom", "prosperity",
    "concord", "harmony", "metro", "overall", "worth", "vista", "plano",
    "xinhua", "sino", "centro", "san", "los", "las", "dos", "tres",
    "por", "sin", "mas", "algo", "nada", "casa", "como", "viven",
    "vida", "tierra", "hijos", "para", "aba", "toda", "todo", "todas",
    "todos", "ise", "lira", "kisi", "noma", "koka", "mura", "mora",
    "tema", "temas",
    "hub", "hubs", "center", "centre", "station", "port", "gate",
    "summit", "peak", "ridge", "corner", "crossing", "junction",
    "mill", "park", "grove", "hills", "springs", "landing",
    "rosetta", "java", "python",
    # ── Words that collide with city names but are common in news text ──
    # Fargo → Wells Fargo bank (thousands of financial conference articles)
    "fargo",
    # Negara → Indonesian word for "country/state" (ubiquitous in ID text)
    "negara",
    # Jos → substring in Croatian/Slavic words (Projekt, koga, etc.)
    "jos",
    # El Paso → Spanish "the step/pass" (common in Spanish text)
    # Note: "el paso" is multi-word so handled in MULTI_WORD_CITIES skip
    # Victoria → extremely common name (person names, landmarks, brands)
    # Note: kept in city index for proper qualified matches like "Victoria, HK"
    # but should not match bare "Victoria" in most contexts
    # Wollongong → legitimate city but duplicate location IDs inflate counts
})

WORD_RE = re.compile(r"[A-Za-zÀ-ÿ\u00C0-\u017F]+")

# Unicode-aware word regex that matches words in any script.
# Includes combining marks (Mc category) so Indic vowel signs stay
# attached to consonants (e.g., Hindi "तोक्यो" stays as one token).
UNICODE_WORD_RE = re.compile(
    r"(?:[^\W\d_]|[\u0300-\u036f\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f"
    r"\u0b80-\u0bff\u0c00-\u0c7f\u0c80-\u0cff\u0d00-\u0d7f\u0d80-\u0dff"
    r"\u0e00-\u0e7f\u0f00-\u0fff\u1000-\u109f\u1100-\u11ff\uac00-\ud7af"
    r"\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\ufe70-\ufeff])+"
)

# CJK character regex — one token per character (for n-gram matching)
CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")


# ── Lazy-loaded index ───────────────────────────────────────────────
class _Index:
    def __init__(self):
        self.cities_by_name: dict[str, list[dict]] = {}
        self.cities_by_ascii: dict[str, list[dict]] = {}
        self.multi_word: dict[str, dict] = {}
        # Multilingual index: {lang: {name_lower: [city_row, ...]}}
        self.by_lang: dict[str, dict[str, list[dict]]] = {}
        # Multilingual ASCII index: {lang: {name_ascii_lower: [city_row, ...]}}
        self.by_lang_ascii: dict[str, dict[str, list[dict]]] = {}
        # Multilingual multi-word: {lang: {phrase_lower: city_row}}
        self.multi_word_lang: dict[str, dict[str, dict]] = {}
        self.loaded = False

    def load(self) -> None:
        if self.loaded:
            return
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT id, name, ascii_name, country_code, state_name,
                       lat, lng, population
                FROM world_cities
                WHERE population >= 100000
            """)
            rows = cur.fetchall()

        for r in rows:
            nm = (r["name"] or "").lower()
            as_ = (r["ascii_name"] or "").lower()
            if not nm:
                continue
            self.cities_by_name.setdefault(nm, []).append(r)
            if as_ and as_ != nm:
                self.cities_by_ascii.setdefault(as_, []).append(r)

        for r in rows:
            nm = (r["name"] or "").lower().strip()
            if " " in nm or "-" in nm:
                existing = self.multi_word.get(nm)
                if existing is None or (r["population"] or 0) > (existing["population"] or 0):
                    self.multi_word[nm] = r
        # Fill in any multi-word phrases from the static list that
        # didn't show up in the data.
        # Handle "City StateName" patterns specially - extract city name and filter by state
        US_STATE_ABBREVS = {
            "al": "AL", "ak": "AK", "az": "AZ", "ar": "AR", "ca": "CA",
            "co": "CO", "ct": "CT", "de": "DE", "fl": "FL", "ga": "GA",
            "hi": "HI", "id": "ID", "il": "IL", "in": "IN", "ia": "IA",
            "ks": "KS", "ky": "KY", "la": "LA", "me": "ME", "md": "MD",
            "ma": "MA", "mi": "MI", "mn": "MN", "ms": "MS", "mo": "MO",
            "mt": "MT", "ne": "NE", "nv": "NV", "nh": "NH", "nj": "NJ",
            "nm": "NM", "ny": "NY", "nc": "NC", "nd": "ND", "oh": "OH",
            "ok": "OK", "or": "OR", "pa": "PA", "ri": "RI", "sc": "SC",
            "sd": "SD", "tn": "TN", "tx": "TX", "ut": "UT", "vt": "VT",
            "va": "VA", "wa": "WA", "wv": "WV", "wi": "WI", "wy": "WY",
        }
        US_STATE_NAMES = {
            "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
            "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
            "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
            "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
            "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
            "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
            "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
            "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
            "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
            "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
            "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
            "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
            "wisconsin": "WI", "wyoming": "WY",
        }
        for phrase in MULTI_WORD_CITIES:
            if phrase in self.multi_word:
                continue
            # Check if this is a "City StateName" or "City StateAbbrev" pattern
            # Handle multi-word state names like "north dakota", "new york"
            words = phrase.split()
            state_code = None
            city_name = phrase
            if len(words) >= 2:
                # Check last word first
                last_word = words[-1].lower()
                # Check for two-word state names at end: "new york", "north dakota", etc.
                if len(words) >= 3:
                    two_words = " ".join(words[-2:]).lower()
                    if two_words in US_STATE_NAMES:
                        state_code = US_STATE_NAMES[two_words]
                        city_name = " ".join(words[:-2])
                    elif two_words in US_STATE_ABBREVS:
                        state_code = US_STATE_ABBREVS[two_words]
                        city_name = " ".join(words[:-2])
                # Check single-word state name/abbreviation
                if state_code is None:
                    if last_word in US_STATE_ABBREVS:
                        state_code = US_STATE_ABBREVS[last_word]
                        city_name = " ".join(words[:-1])
                    elif last_word in US_STATE_NAMES:
                        state_code = US_STATE_NAMES[last_word]
                        city_name = " ".join(words[:-1])

            target_name = ALIASES.get(phrase, city_name)
            hits = (
                self.cities_by_name.get(phrase)
                or self.cities_by_ascii.get(phrase)
                or self.cities_by_name.get(target_name.lower())
                or self.cities_by_ascii.get(ascii_fold(target_name))
            )
            if hits:
                # If we detected a US state, filter to that country first
                if state_code:
                    state_hits = [h for h in hits if h.get("country_code") == "US"]
                    if state_hits:
                        hits = state_hits
                best = max(hits, key=lambda c: c.get("population") or 0)
                self.multi_word[phrase] = best
            elif state_code:
                # City not in index (below population threshold) but we have a state qualifier.
                # Do a direct DB lookup for this specific city+state combination.
                try:
                    with connect() as conn, conn.cursor() as cur:
                        cur.execute("""
                            SELECT id, name, ascii_name, country_code, state_name,
                                   lat, lng, population
                            FROM world_cities
                            WHERE LOWER(name) = LOWER(%s) AND country_code = 'US'
                            LIMIT 5
                        """, (city_name,))
                        db_hits = cur.fetchall()
                        if db_hits:
                            # Filter by state if we have state info
                            state_name = last_word if last_word in US_STATE_NAMES else None
                            for hit in db_hits:
                                hit_state = (hit.get("state_name") or "").lower()
                                if state_name and (hit_state == state_name or hit_state == US_STATE_NAMES.get(state_name, "").lower()):
                                    self.multi_word[phrase] = hit
                                    break
                            else:
                                # No state match, use first result
                                self.multi_word[phrase] = db_hits[0]
                except Exception:
                    pass

            # If we have a state_code but the selected city is not in the US state we want,
            # do a direct DB lookup to find the correct city
            if state_code and phrase in self.multi_word:
                selected = self.multi_word[phrase]
                selected_state = (selected.get("state_name") or "").lower()
                state_name_lower = last_word if last_word in US_STATE_NAMES else None
                if selected.get("country_code") != "US" or (state_name_lower and selected_state != state_name_lower and selected_state != US_STATE_NAMES.get(state_name_lower, "").lower()):
                    # Selected wrong country/state - do DB lookup
                    try:
                        with connect() as conn, conn.cursor() as cur:
                            cur.execute("""
                                SELECT id, name, ascii_name, country_code, state_name,
                                       lat, lng, population
                                FROM world_cities
                                WHERE LOWER(name) = LOWER(%s) AND country_code = 'US'
                                LIMIT 5
                            """, (city_name,))
                            db_hits = cur.fetchall()
                            if db_hits:
                                state_name = last_word if last_word in US_STATE_NAMES else None
                                for hit in db_hits:
                                    hit_state = (hit.get("state_name") or "").lower()
                                    if state_name and (hit_state == state_name or hit_state == US_STATE_NAMES.get(state_name, "").lower()):
                                        self.multi_word[phrase] = hit
                                        break
                                else:
                                    # No state match, use first US result
                                    for hit in db_hits:
                                        if hit.get("country_code") == "US":
                                            self.multi_word[phrase] = hit
                                            break
                    except Exception:
                        pass

        # Load multilingual names from city_names (FDW → xyzo_cities).
        self._load_multilingual()

        self.loaded = True
        total_ml = sum(len(v) for v in self.by_lang.values())
        log.info("city index loaded: %d name keys, %d multi-word, %d multilingual names across %d langs",
                 len(self.cities_by_name), len(self.multi_word),
                 total_ml, len(self.by_lang))

    def _load_multilingual(self) -> None:
        """Load city_names into per-language indexes."""
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    SELECT cn.city_id, cn.lang, cn.name, cn.name_ascii,
                           wc.id, wc.name AS wc_name, wc.ascii_name, wc.country_code,
                           wc.state_name, wc.lat, wc.lng, wc.population
                    FROM city_names cn
                    JOIN world_cities wc ON wc.id = cn.city_id
                    WHERE wc.population >= 100000
                      AND cn.lang != 'en'
                """)
                rows = cur.fetchall()
        except Exception as e:
            log.warning("failed to load multilingual city names: %s", e)
            return

        for r in rows:
            lang = r["lang"]
            name = (r["name"] or "").lower()
            if not name or len(name) < 2:
                continue

            city = {
                "id": r["id"],
                "name": r["wc_name"],
                "ascii_name": r["ascii_name"],
                "country_code": r["country_code"],
                "state_name": r["state_name"],
                "lat": r["lat"],
                "lng": r["lng"],
                "population": r["population"],
                "_local_name": r["name"],
                "_name_ascii_folded": ascii_fold(r["name_ascii"] or ""),
            }

            lang_idx = self.by_lang.setdefault(lang, {})
            lang_idx.setdefault(name, []).append(city)

            # Also index by ASCII-folded name for fuzzy fallback
            name_ascii_folded = ascii_fold(r["name_ascii"] or r["name"] or "")
            if name_ascii_folded and name_ascii_folded != name:
                ascii_idx = self.by_lang_ascii.setdefault(lang, {})
                ascii_idx.setdefault(name_ascii_folded, []).append(city)

            if " " in name or "-" in name:
                mw_idx = self.multi_word_lang.setdefault(lang, {})
                existing = mw_idx.get(name)
                if existing is None or (r["population"] or 0) > (existing.get("population") or 0):
                    mw_idx[name] = city


_INDEX = _Index()


def ascii_fold(s: str) -> str:
    if not s:
        return ""
    try:
        from unidecode import unidecode
        return unidecode(s).lower().strip()
    except ImportError:
        # Fallback: strip combining marks (Latin-only)
        nfd = unicodedata.normalize("NFD", s)
        stripped = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
        return unicodedata.normalize("NFC", stripped).lower().strip()


def _confidence_for(population: int | None) -> str:
    p = population or 0
    if p >= 1_000_000:
        return "high"
    if p >= 250_000:
        return "medium"
    return "low"


# ── Public API ──────────────────────────────────────────────────────
def find_cities_in_text(text: str,
                        *,
                        lang: str | None = None,
                        min_population: int = 100_000,
                        include_aliases: bool = True,
                        max_results: int = 50,
                        ) -> list[dict]:
    """Detect cities in text. Returns list of {city, start, end, kind,
    confidence}.

    If `lang` is provided (ISO 639-1 code), searches multilingual names
    in that language first, then falls back to English/ASCII matching.
    """
    if not text or len(text) < 3:
        return []
    _INDEX.load()
    lc = text.lower()
    matches: list[dict] = []

    # 0. Multilingual multi-word phrases (if lang is known).
    if lang and lang in _INDEX.multi_word_lang:
        mw_lang = _INDEX.multi_word_lang[lang]
        phrases = sorted(
            (p for p in mw_lang if len(p) >= 2),
            key=len, reverse=True,
        )
        for phrase in phrases:
            r = mw_lang[phrase]
            if (r.get("population") or 0) < min_population:
                continue
            from_ = 0
            while True:
                idx = lc.find(phrase, from_)
                if idx == -1:
                    break
                before = text[idx - 1] if idx > 0 else " "
                after_idx = idx + len(phrase)
                after = text[after_idx] if after_idx < len(text) else " "
                if not before.isalnum() and not after.isalnum():
                    matches.append({
                        "city": r, "start": idx, "end": idx + len(phrase),
                        "length": len(phrase),
                        "confidence": _confidence_for(r.get("population")),
                        "kind": "name",
                        "matched_lang": lang,
                        "matched_name": phrase,
                    })
                from_ = idx + 1

    # 1. English multi-word phrases (longest first).
    phrases = sorted(
        (p for p in _INDEX.multi_word if len(p) >= 3),
        key=len, reverse=True,
    )
    for phrase in phrases:
        r = _INDEX.multi_word[phrase]
        if (r.get("population") or 0) < min_population:
            continue
        from_ = 0
        while True:
            idx = lc.find(phrase, from_)
            if idx == -1:
                break
            before = text[idx - 1] if idx > 0 else " "
            after_idx = idx + len(phrase)
            after = text[after_idx] if after_idx < len(text) else " "
            if not before.isalnum() and not after.isalnum():
                matches.append({
                    "city": r, "start": idx, "end": idx + len(phrase),
                    "length": len(phrase),
                    "confidence": _confidence_for(r.get("population")),
                    "kind": "name",
                })
            from_ = idx + 1

    # 2. Single-word scan.
    # Use Unicode-aware regex for non-Latin scripts (Cyrillic, Arabic,
    # Devanagari, etc.) so we can match city names in any language.
    # When lang is None, we use UNICODE_WORD_RE to handle any script.
    word_re = UNICODE_WORD_RE if lang is None or lang != "en" else WORD_RE
    for m in word_re.finditer(text):
        w = m.group(0)
        lower = w.lower()
        folded = ascii_fold(w)
        if len(w) < 3 or lower in SKIP_WORDS or folded in SKIP_WORDS:
            continue
        # Lookbehind / lookahead guards for multi-word city components
        if lower in ("york", "orleans", "mexico", "jersey", "delhi", "hampshire", "zealand", "brunswick"):
            if m.start() >= 4 and text[m.start()-4:m.start()].lower() in ("new ", "nueva "):
                continue
            if f"new {lower}" in lc or f"nueva {lower}" in lc:
                continue
        # Skip if already covered by a multi-word match.
        if any(mm["start"] <= m.start() < mm["end"] for mm in matches):
            continue
        # Check explicit ALIASES override first
        if include_aliases and lower in ALIASES:
            target = ALIASES[lower]
            target_hits = (
                _INDEX.cities_by_name.get(target.lower())
                or _INDEX.cities_by_ascii.get(ascii_fold(target))
                or []
            )
            if target_hits:
                alias_best = max(target_hits, key=lambda c: c.get("population") or 0)
                if (alias_best.get("population") or 0) >= min_population:
                    matches.append({
                        "city": alias_best, "start": m.start(),
                        "end": m.start() + len(w), "length": len(w),
                        "confidence": _confidence_for(alias_best.get("population")),
                        "kind": "alias",
                    })
                    continue

        # Check ARABIC_CITY_ALIASES for Arabic text
        if include_aliases and lower in ARABIC_CITY_ALIASES:
            target = ARABIC_CITY_ALIASES[lower]
            target_hits = (
                _INDEX.cities_by_name.get(target.lower())
                or _INDEX.cities_by_ascii.get(ascii_fold(target))
                or []
            )
            if target_hits:
                alias_best = max(target_hits, key=lambda c: c.get("population") or 0)
                if (alias_best.get("population") or 0) >= min_population:
                    matches.append({
                        "city": alias_best, "start": m.start(),
                        "end": m.start() + len(w), "length": len(w),
                        "confidence": _confidence_for(alias_best.get("population")),
                        "kind": "alias",
                    })
                    continue

        hits = []
        # Check multilingual index first (if lang is known)
        if lang and lang in _INDEX.by_lang:
            hits = (
                _INDEX.by_lang[lang].get(lower)
                or _INDEX.by_lang[lang].get(folded)
                or []
            )
            # ASCII fallback within the same language
            if not hits and folded and lang in _INDEX.by_lang_ascii:
                hits = _INDEX.by_lang_ascii[lang].get(folded) or []
            # Prefix match on ASCII — handles inflected forms like
            # Russian "Москве" → "moskve" ≈ "moskva" (Москва)
            if not hits and folded and len(folded) >= 5 and lang in _INDEX.by_lang_ascii:
                prefix = folded[:len(folded) - 1]
                for ascii_key, cities in _INDEX.by_lang_ascii[lang].items():
                    if " " not in ascii_key and "-" not in ascii_key and ascii_key.startswith(prefix):
                        hits = cities
                        break

        # Fall back to English/ASCII index (always, for any language)
        if not hits:
            hits = (
                _INDEX.cities_by_name.get(lower)
                or _INDEX.cities_by_name.get(folded)
                or _INDEX.cities_by_ascii.get(lower)
                or _INDEX.cities_by_ascii.get(folded)
                or []
            )
        if hits:
            best = max(hits, key=lambda c: c.get("population") or 0)
            if (best.get("population") or 0) >= min_population:
                matches.append({
                    "city": best, "start": m.start(),
                    "end": m.start() + len(w), "length": len(w),
                    "confidence": _confidence_for(best.get("population")),
                    "kind": "name",
                })
                continue

    # 2b. CJK character matching (Chinese, Japanese kanji).
    # CJK text has no spaces, so we match individual chars and bigrams
    # against the multilingual index. "东京" → bigram match for Tokyo.
    cjk_chars = list(CJK_RE.finditer(text))
    if cjk_chars and lang in ("zh", "ja"):
        # Try bigrams first (2-char city names are common in CJK)
        for i in range(len(cjk_chars) - 1):
            bigram = cjk_chars[i].group() + cjk_chars[i + 1].group()
            bg_lower = bigram.lower()
            start = cjk_chars[i].start()
            end = cjk_chars[i + 1].end()
            # Skip if already covered
            if any(mm["start"] <= start < mm["end"] for mm in matches):
                continue
            hits = []
            if lang in _INDEX.by_lang:
                hits = _INDEX.by_lang[lang].get(bg_lower, [])
            if not hits:
                # Try other CJK languages
                for cjk_lang in ("zh", "ja"):
                    if cjk_lang in _INDEX.by_lang:
                        hits = _INDEX.by_lang[cjk_lang].get(bg_lower, [])
                        if hits:
                            break
            if hits:
                best = max(hits, key=lambda c: c.get("population") or 0)
                if (best.get("population") or 0) >= min_population:
                    matches.append({
                        "city": best, "start": start, "end": end,
                        "length": len(bigram),
                        "confidence": _confidence_for(best.get("population")),
                        "kind": "name",
                    })

    # 3. Entity-to-location detection (company HQs).
    #    Looks for company/organization names in the text and maps them
    #    to their headquarters city. E.g., "Microsoft" → Redmond/Seattle.
    entity_index = _load_entity_locations()
    if entity_index:
        for m in WORD_RE.finditer(text):
            w = m.group(0)
            lower = w.lower()
            if len(w) < 3 or lower in SKIP_WORDS:
                continue
            # Skip if already covered by a city match.
            if any(mm["start"] <= m.start() < mm["end"] for mm in matches):
                continue
            if lower in entity_index:
                loc = entity_index[lower]
                # Create a synthetic city dict that looks like a real city
                # entry so downstream code (stats, format_city_hint) works.
                entity_city = {
                    "id": None,
                    "name": loc["city"],
                    "ascii_name": loc["city"].lower(),
                    "country_code": loc["country"],
                    "state_name": None,
                    "lat": loc["lat"],
                    "lng": loc["lng"],
                    "population": 0,  # unknown — but we flag as entity
                }
                matches.append({
                    "city": entity_city,
                    "start": m.start(),
                    "end": m.start() + len(w),
                    "length": len(w),
                    "confidence": "medium",
                    "kind": "entity",
                    "entity_name": w,
                })

    # Dedupe overlaps: keep the highest-population match per range.
    matches.sort(key=lambda m: (m["start"], -m["length"]))
    out: list[dict] = []
    last_end = -1
    for mm in matches:
        if mm["start"] >= last_end:
            out.append(mm)
            last_end = mm["end"]
    return out[:max_results]


def stats(text: str, *, min_population: int = 100_000, lang: str | None = None) -> dict:
    matches = find_cities_in_text(text, min_population=min_population, lang=lang)
    result = {
        "count": 0,
        "primary": None,
        "primary_label": None,
        "cities": [],
        "countries": [],
        "diversity": 0,
        "flagged": False,
        "is_national": False,
        "high_confidence": 0,
        "medium_confidence": 0,
        "low_confidence": 0,
        "entity_matches": 0,
        "entities": [],
    }
    if not matches:
        return result
    # Filter to real cities only (population > 0, kind != 'entity').
    # Company/platform entities (e.g. YouTube, Google, Apple) must NEVER be
    # promoted to primary city for news geolocation without explicit city context.
    city_matches = [m for m in matches if m.get("kind") != "entity"]
    real_cities = [m["city"] for m in city_matches]
    by_country: dict[str, int] = {}
    for c in real_cities:
        cc = c.get("country_code")
        if cc:
            by_country[cc] = by_country.get(cc, 0) + 1

    # Title mentions (start of text) get 2x priority multiplier.
    first_newline = text.find("\n")
    title_end = first_newline if first_newline > 0 else 100

    def match_score(m: dict) -> float:
        c = m["city"]
        pop = float(c.get("population") if c.get("population") is not None else 0)
        title_boost = 2.0 if m.get("start", 0) < title_end else 1.0
        kind_boost = 1.2 if m.get("kind") == "name" else 1.0
        return pop * title_boost * kind_boost

    if city_matches:
        best_match = max(city_matches, key=match_score)
        primary = best_match["city"]
    else:
        primary = None
    result.update({
        "count": len(city_matches),
        "primary": primary,
        "primary_label": (
            f"{primary.get('name')}, {primary.get('country_code')}"
            if primary else None
        ),
        "cities": real_cities,
        "countries": list(by_country.keys()),
        "diversity": len(by_country),
        "flagged": any(m["confidence"] == "low" for m in city_matches),
        "is_national": len(by_country) > 1,
        "high_confidence": sum(1 for m in city_matches if m["confidence"] == "high"),
        "medium_confidence": sum(1 for m in city_matches if m["confidence"] == "medium"),
        "low_confidence": sum(1 for m in city_matches if m["confidence"] == "low"),
        "entity_matches": sum(1 for m in matches if m.get("kind") == "entity"),
        "entities": [m for m in matches if m.get("kind") == "entity"],
    })
    return result


def format_city_hint(stats_or_matches, *, max_cities: int = 3) -> str | None:
    """Format a one-line hint for AI prompt augmentation.

    Returns e.g. "Primary location hint: Mumbai, IN (pop 15.4M). Other
    detected: Pune, IN; Delhi, IN." Returns None if no cities.
    """
    if isinstance(stats_or_matches, dict):
        s = stats_or_matches
    else:
        s = None
    if s is not None:
        if s.get("count", 0) == 0:
            return None
        primary = s.get("primary")
        cities = s.get("cities", [])
    else:
        cities = stats_or_matches
        if not cities:
            return None
        primary = max(cities, key=lambda c: c.get("population") or 0)
        cities = [m["city"] if "city" in m else m for m in cities]

    # Format primary location — show population if available, otherwise
    # indicate it's an entity match (company HQ).
    pop = primary.get("population") or 0
    if pop > 0:
        primary_str = f"{primary['name']}, {primary['country_code']} (pop {pop:,})"
    else:
        primary_str = f"{primary['name']}, {primary['country_code']} (entity HQ)"
    others = [c for c in cities[:max_cities]
              if c.get("id") != primary.get("id")]
    other_str = "; ".join(
        f"{c['name']}, {c['country_code']}" for c in others
    ) if others else ""
    if other_str:
        return f"Primary location hint: {primary_str}. Other detected: {other_str}."
    return f"Primary location hint: {primary_str}."
