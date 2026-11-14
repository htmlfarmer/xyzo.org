"""Import GeoNames alternateNamesV2.txt into the city_names table.

Reads the 745MB GeoNames file, filters to only our 8,227 cities
(matched by geoname_id), normalizes language codes, generates ASCII
transliterations, and batch-inserts into xyzo_cities.public.city_names.

Usage:
    python -m worker.import_city_names
    # or directly:
    python worker/import_city_names.py
"""
from __future__ import annotations

import csv
import logging
import os
import sys
import unicodedata
from pathlib import Path

import psycopg
from unidecode import unidecode

log = logging.getLogger("xyzo.import_city_names")

DATA_DIR = Path(__file__).parent.parent / "data"
GEONAMES_FILE = DATA_DIR / "alternateNamesV2.txt"

DSN = os.environ.get(
    "XYZO_CITIES_DSN",
    "postgresql://postgres@localhost:5432/xyzo_cities",
)

# GeoNames uses some non-language codes — skip these.
SKIP_LANG_CODES = frozenset({
    "iata", "faac", "tcid", "icao", "tat", "link", "post", "unlc",
    "fr_1793", "fr_1801", "abbr", "name", "military", "natlang",
})

# ISO 639-2/3 → 639-1 mappings for common languages we care about.
# GeoNames sometimes uses 3-letter codes.
LANG_MAP: dict[str, str] = {
    "zho": "zh", "chi": "zh", "cmn": "zh",
    "jpn": "ja",
    "kor": "ko",
    "rus": "ru",
    "ara": "ar",
    "hin": "hi",
    "ben": "bn",
    "urd": "ur",
    "por": "pt",
    "spa": "es",
    "fra": "fr",
    "deu": "de",
    "ger": "de",
    "ita": "it",
    "tur": "tr",
    "pol": "pl",
    "ukr": "uk",
    "vie": "vi",
    "tha": "th",
    "ind": "id",
    "msa": "ms",
    "fas": "fa", "per": "fa",
    "heb": "he",
    "swa": "sw",
    "amh": "am",
    "hau": "ha",
    "yor": "yo",
    "ibo": "ig",
    "tam": "ta",
    "tel": "te",
    "mar": "mr",
    "guj": "gu",
    "kan": "kn",
    "mal": "ml",
    "pan": "pa",
    "sin": "si",
    "mya": "my", "bur": "my",
    "khm": "km",
    "lao": "lo",
    "mon": "mn",
    "kat": "ka",
    "hye": "hy", "arm": "hy",
    "aze": "az",
    "kaz": "kk",
    "uzb": "uz",
    "tuk": "tk",
    "kir": "ky",
    "tgk": "tg",
    "pus": "ps", "pus": "ps",
    "kur": "ku",
    "nld": "nl", "dut": "nl",
    "ell": "el", "gre": "el",
    "hun": "hu",
    "ces": "cs", "cze": "cs",
    "slk": "sk", "slo": "sk",
    "ron": "ro", "rum": "ro",
    "bul": "bg",
    "hrv": "hr",
    "srp": "sr",
    "bos": "bs",
    "mkd": "mk", "mac": "mk",
    "slv": "sl",
    "fin": "fi",
    "est": "et",
    "lav": "lv",
    "lit": "lt",
    "nob": "nb", "nor": "no",
    "nno": "nn",
    "dan": "da",
    "swe": "sv",
    "cat": "ca",
    "glg": "gl",
    "eus": "eu", "baq": "eu",
    "cym": "cy", "wel": "cy",
    "gle": "ga", "iri": "ga",
    "mlt": "mt",
    "sqi": "sq", "alb": "sq",
    "fil": "tl",
}

# Keep only 2-letter ISO 639-1 codes we want to import.
# This filters out rare languages and non-language codes.
KEEP_LANGS = frozenset({
    "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "uk",
    "zh", "ja", "ko", "ar", "he", "fa", "tr", "vi", "th", "id",
    "ms", "hi", "bn", "ur", "ta", "te", "mr", "gu", "kn", "ml",
    "pa", "si", "ne", "my", "km", "lo", "ka", "hy", "az", "kk",
    "uz", "tk", "ky", "tg", "ps", "ku", "el", "hu", "cs", "sk",
    "ro", "bg", "hr", "sr", "bs", "mk", "sl", "fi", "et", "lv",
    "lt", "no", "nb", "nn", "da", "sv", "ca", "gl", "eu", "cy",
    "ga", "mt", "sq", "tl", "sw", "am", "ha", "yo", "ig", "mn",
    "be", "eo", "la", "af",
})


def ascii_fold(s: str) -> str:
    """Generate ASCII transliteration of a name."""
    if not s:
        return ""
    # Try unidecode first (handles CJK, Arabic, Cyrillic, etc.)
    result = unidecode(s).strip()
    if not result:
        # Fallback: strip combining marks
        nfd = unicodedata.normalize("NFD", s)
        result = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
        result = unicodedata.normalize("NFC", result).strip()
    return result.lower()


def normalize_lang(code: str) -> str | None:
    """Normalize a GeoNames language code to ISO 639-1. Returns None if skipped."""
    if not code:
        return None
    code = code.strip().lower()
    if code in SKIP_LANG_CODES:
        return None
    # Already 2-letter
    if len(code) == 2:
        return code if code in KEEP_LANGS else None
    # 3-letter → 2-letter
    if code in LANG_MAP:
        mapped = LANG_MAP[code]
        return mapped if mapped in KEEP_LANGS else None
    # IETF tags like 'zh-Hans', 'en-US' → take base
    if "-" in code:
        base = code.split("-")[0]
        if len(base) == 2:
            return base if base in KEEP_LANGS else None
    return None


def load_geoname_ids(dsn: str) -> dict[int, int]:
    """Load {geoname_id: city_id} mapping from our cities table."""
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT geoname_id, id FROM cities WHERE geoname_id IS NOT NULL")
            mapping = {row[0]: row[1] for row in cur.fetchall()}
    log.info("loaded %d geoname_id → city_id mappings", len(mapping))
    return mapping


def classify_name_type(is_preferred: bool, is_short: bool,
                       is_colloquial: bool, is_historic: bool) -> str:
    if is_preferred:
        return "official"
    if is_historic:
        return "historical"
    if is_colloquial:
        return "colloquial"
    if is_short:
        return "abbreviation"
    return "alternate"


def import_geonames(dsn: str, data_file: Path, batch_size: int = 10000) -> dict:
    """Stream GeoNames alternateNamesV2.txt and insert into city_names."""
    geo_map = load_geoname_ids(dsn)
    if not geo_map:
        log.error("no geoname_ids found in cities table!")
        return {"error": "no cities"}

    stats = {"read": 0, "matched": 0, "inserted": 0, "skipped_lang": 0,
             "skipped_short": 0, "skipped_dup": 0}
    batch: list[tuple] = []

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            with data_file.open(encoding="utf-8") as f:
                reader = csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
                for row in reader:
                    stats["read"] += 1
                    if stats["read"] % 2_000_000 == 0:
                        log.info("progress: %dM rows read, %d matched, %d inserted",
                                 stats["read"] // 1_000_000, stats["matched"],
                                 stats["inserted"])

                    if len(row) < 8:
                        continue

                    try:
                        geoname_id = int(row[1])
                    except (ValueError, TypeError):
                        continue

                    if geoname_id not in geo_map:
                        continue

                    stats["matched"] += 1
                    city_id = geo_map[geoname_id]
                    raw_lang = row[2]
                    name = row[3].strip()
                    is_preferred = row[4].strip().lower() == "1" if len(row) > 4 else False
                    is_short = row[5].strip().lower() == "1" if len(row) > 5 else False
                    is_colloquial = row[6].strip().lower() == "1" if len(row) > 6 else False
                    is_historic = row[7].strip().lower() == "1" if len(row) > 7 else False

                    lang = normalize_lang(raw_lang)
                    if lang is None:
                        stats["skipped_lang"] += 1
                        continue

                    if len(name) < 2:
                        stats["skipped_short"] += 1
                        continue

                    name_ascii = ascii_fold(name)
                    name_type = classify_name_type(is_preferred, is_short,
                                                   is_colloquial, is_historic)

                    batch.append((city_id, lang, name, name_ascii,
                                  is_preferred, name_type, "geonames"))

                    if len(batch) >= batch_size:
                        inserted = _flush_batch(cur, batch)
                        stats["inserted"] += inserted
                        stats["skipped_dup"] += len(batch) - inserted
                        batch.clear()
                        conn.commit()

            # Final flush
            if batch:
                inserted = _flush_batch(cur, batch)
                stats["inserted"] += inserted
                stats["skipped_dup"] += len(batch) - inserted
                batch.clear()
                conn.commit()

    log.info("import complete: %s", stats)
    return stats


def _flush_batch(cur, batch: list[tuple]) -> int:
    """Batch INSERT using executemany with ON CONFLICT DO NOTHING."""
    cur.executemany(
        """INSERT INTO city_names (city_id, lang, name, name_ascii, is_preferred, name_type, source)
           VALUES (%s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (city_id, lang, lower(name)) DO NOTHING""",
        batch,
    )
    return cur.rowcount


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not GEONAMES_FILE.exists():
        log.error("GeoNames file not found: %s", GEONAMES_FILE)
        log.error("Download from: https://download.geonames.org/export/dump/alternateNamesV2.zip")
        sys.exit(1)

    dsn = DSN
    log.info("importing %s into city_names...", GEONAMES_FILE)
    log.info("database: %s", dsn.split("@")[-1] if "@" in dsn else dsn)

    stats = import_geonames(dsn, GEONAMES_FILE)

    print(f"\n{'='*60}")
    print(f"  GeoNames city_names import complete")
    print(f"{'='*60}")
    print(f"  Rows read:      {stats['read']:>12,}")
    print(f"  Matched cities: {stats['matched']:>12,}")
    print(f"  Inserted:       {stats['inserted']:>12,}")
    print(f"  Skipped (lang): {stats['skipped_lang']:>12,}")
    print(f"  Skipped (dup):  {stats['skipped_dup']:>12,}")
    print(f"  Skipped (short):{stats['skipped_short']:>12,}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
