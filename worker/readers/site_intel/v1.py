"""v1 site_intelligence schema adapter.

When the intelligence JSON shape changes:
  1. Create v2.py with the new shape + validation
  2. Bump CURRENT_FORMAT_VERSION below
  3. Keep v1.py readable so old rows in DB still work
"""
from __future__ import annotations

import copy
from typing import Any

CURRENT_FORMAT_VERSION = 1

REQUIRED_KEYS = ("feeds", "structural_map", "sd_fingerprint",
                 "politics", "site_summary")


def validate_intelligence(intel: dict[str, Any]) -> None:
    """Raise ValueError if `intel` does not match v1 schema."""
    if intel.get("schema_version") != CURRENT_FORMAT_VERSION:
        raise ValueError(
            f"schema_version={intel.get('schema_version')} != "
            f"{CURRENT_FORMAT_VERSION}"
        )
    for k in REQUIRED_KEYS:
        if k not in intel:
            raise ValueError(f"missing required key: {k}")


def parse_intelligence(record: dict[str, Any]) -> dict[str, Any]:
    """Parse a v1 site_intelligence row into a dict.

    Accepts either:
      - the full DB row dict (with 'intelligence' JSONB field), OR
      - the inner intelligence dict directly

    Returns a deep-copied parsed dict. Unknown keys are preserved
    so future fields can be read by newer code without losing data.
    """
    # If called with the inner dict directly (no "intelligence" key
    # but has the required top-level v1 keys), pass through.
    if "intelligence" not in record and any(
        k in record for k in REQUIRED_KEYS
    ):
        intel = record
    else:
        intel = record.get("intelligence") or {}
    validate_intelligence(intel)
    return copy.deepcopy(intel)
