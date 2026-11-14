#!/usr/bin/env python3
"""Normalise `news_locations.country` to ISO 3166-1 alpha-2 codes.

THE BUG
-------
The geocoder stores Nominatim's `address.country` — the country's FULL
NAME ("United States", "Deutschland", "ایران", "Türkiye") — in
`news_locations.country`, while the rest of the system speaks ISO-2
("US", "DE", "IR", "TR"). Every comparison between the two is therefore
always a mismatch:

  * the cross-country placement guard sees a "foreign" city for a US
    source and rejects the article (it then falls through to the
    source-based fallback, which is what piled stories onto capitals);
  * the source geography profiles are grouped by full country names, so
    "does this source publish from its own country?" could never be
    answered correctly;
  * the map API returns `source_country` = "United States" for some pins
    and "US" for others.

USAGE
-----
    python -m worker.normalize_location_countries --dry-run
    python -m worker.normalize_location_countries --apply
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# No credentials in the repo: export XYZO_DB_DSN (or set PGPASSWORD)
# before running. The default matches worker/tests/conftest.py.
os.environ.setdefault("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")

from worker.db import connect
from worker.country_normalizer import normalize_country

log = logging.getLogger("xyzo.normalize_location_countries")

# Full names the normalizer does not know. Keep this list short — it is
# a safety net for the native endonyms that show up in the gazetteer.
# Full names the normalizer does not know — mostly native endonyms that
# Nominatim returns. Keep this list short; it is a safety net, not a
# replacement for the normalizer.
EXTRA_NAMES = {
    "españa": "ES",
    "nederland": "NL",
    "osterreich": "AT",
    "schweiz": "CH",
    "suisse": "CH",
    "belgique": "BE",
    "sverige": "SE",
    "norge": "NO",
    "danmark": "DK",
    "suomi": "FI",
    "magyarország": "HU",
    "россия": "RU",
    "украина": "UA",
    "казахстан": "KZ",
    "uzbekiston": "UZ",
    "türkiye": "TR",
    "turkiye": "TR",
    "србија": "RS",
    "македонија": "MK",
    "hrvatska": "HR",
    "slovenija": "SI",
    "slovensko": "SK",
    "česko": "CZ",
    "polska": "PL",
    "portugal": "PT",
    "méxico": "MX",
    "mêxico": "MX",
    "brasil": "BR",
    "perú": "PE",
    "românia": "RO",
    "qazaqstan": "KZ",
    "azərbaycan": "AZ",
    "ελλάδα": "GR",
    "المغرب": "MA",
    "maroc": "MA",
    "الجزائر": "DZ",
    "تونس": "TN",
    "ليبيا": "LY",
    "السودان": "SD",
    "भारत": "IN",
    "ایران": "IR",
    "éire": "IE",
    "węgry": "HU",
    # Exotic territories / native endonyms that Nominatim returns
    "new zealand / aotearoa": "NZ",
    "viti": "FJ",
    "ayiti": "HT",
    "côte d’ivoire": "CI",
    "cote d’ivoire": "CI",
    "ព្រះរាជាណាចក្រកម្ពុជា": "KH",
    "ព្រះរាជាណាចក្រកម្ពុជា": "KH",
    "ދިވެހިރާއްޖެ": "MV",
    "Ṃajeḷ": "MT",
    "조선민주주의인민공화국": "KP",
    "brunei بروني": "BN",
    "guiné-bissau": "GW",
    "guine-bissau": "GW",
    "sāmoa": "WS",
    "samoa": "WS",
    "são tomé e príncipe": "ST",
    "føroyar": "FO",
    "comores komori جزر القمر": "KM",
    "sesel": "SC",
    "saint helena, ascension and tristan da cunha": "SH",
    "curaçao": "CW",
    "curacao": "CW",
    "turks and caicos islands": "TC",
    "aruba": "AW",
    "niuē": "NU",
    "niue": "NU",
    "pitcairn islands": "PN",
    "naoero": "NR",
    "sint maarten": "SX",
    "kuzey kıbrıs": "CY",
    "akrotiri and dhekelia": "CY",
    "абхазия - аԥсны": "GE",
    "хуссар ирыстон - южная осетия": "GE",
    "rạch cái bác / ទន្លេរទី": "KH",
}

# Names that are regions/organisations, never a country.
REGIONAL_NAMES = {
    "mena", "middle east", "north africa", "africa", "europe", "asia",
    "americas", "eastern europe", "western europe", "southern europe",
    "northern europe", "southeast asia", "east asia", "central asia",
    "west asia", "south asia", "sub-saharan africa", "caribbean", "pacific",
    "gulf", "levant", "arab world", "scandinavia", "balkans", "caucasus",
    "world", "global", "international", "oceania", "antarctica",
}

SUFFIX_RE = re.compile(r",\s*([A-Z]{2})\s*$")


def _norm_code(value) -> str | None:
    """Return a 2-letter ISO code for `value`, or None."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if len(raw) == 2 and raw.isalpha() and raw.isupper():
        return raw
    low = raw.lower()
    if low in REGIONAL_NAMES:
        return None
    if low in EXTRA_NAMES:
        return EXTRA_NAMES[low]
    try:
        code = normalize_country(raw)
    except Exception:
        return None
    if code and len(code) == 2 and code.isalpha() and code.isupper():
        return code
    return None


def main():
    parser = argparse.ArgumentParser(description="Normalise news_locations.country to ISO-2")
    parser.add_argument("--dry-run", action="store_true", help="Only report")
    parser.add_argument("--apply", action="store_true", help="Write to DB")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    apply = args.apply and not args.dry_run

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, place_name, country
            FROM news_locations
            WHERE country IS NOT NULL
              AND (length(country) <> 2 OR country <> upper(country))
        """)
        rows = cur.fetchall()

        updates = []
        unresolved = []
        for r in rows:
            code = _norm_code(r["country"])
            if not code:
                # Fall back to the ISO suffix in the place name ("Leshan, CN").
                m = SUFFIX_RE.search(r["place_name"] or "")
                code = m.group(1) if m else None
            if code and code != r["country"]:
                updates.append((code, r["id"]))
            elif not code:
                unresolved.append((r["id"], r["place_name"], r["country"]))

        log.info("news_locations rows with a non-ISO country: %d", len(rows))
        log.info("resolvable: %d   unresolved (left alone): %d", len(updates), len(unresolved))

        if apply:
            cur.executemany(
                "UPDATE news_locations SET country = %s WHERE id = %s",
                updates,
            )
            conn.commit()
            log.info("updated %d rows", len(updates))
        else:
            conn.rollback()
            log.info("[dry run] would update %d rows", len(updates))

        if unresolved:
            log.info("\nunresolved country values (top 25):")
            for _id, name, country in unresolved[:25]:
                log.info("  id=%-7s %-40s country=%r", _id, (name or "")[:40], country)


if __name__ == "__main__":
    main()
