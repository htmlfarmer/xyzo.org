"""extractor_selector — picks which extractor to run for a URL and
merges field-level conflicts when multiple extractors fire."""
from __future__ import annotations


# Default order. JSON-LD is highest quality, heuristic is cheapest.
EXTRACTOR_ORDER = ["json_ld", "microdata", "rss", "ai", "heuristic"]


# Field-level conflict resolution: JSON-LD always wins when present.
# AI patches fields JSON-LD missed. Heuristic only fills gaps.
FIELD_SOURCES = ("jsonld", "ai", "heur")


# Fields we extract from pages
FIELDS = (
    "title", "description", "starts_at", "ends_at",
    "venue_name", "city", "country_code", "lat", "lng",
    "image_url", "price_min", "price_max", "currency",
    "is_free", "is_online", "event_url", "organizer_name",
)


def select_extractors(url: str, intelligence: dict | None) -> list[str]:
    """Return the extractors to try, in order.

    Default: JSON-LD > microdata > RSS > AI > heuristic.
    Intelligence can reorder or skip per URL.
    """
    order = list(EXTRACTOR_ORDER)

    if intelligence:
        preferred = (intelligence.get("preferred_extractor_per_url") or {}).get(url)
        if preferred and preferred in order:
            order.remove(preferred)
            order.insert(0, preferred)
        skips = (intelligence.get("skip_extractors") or {}).get(url) or []
        order = [extractor for extractor in order if extractor not in skips]

    return order


def merge_event_fields(
    sources: dict,
    return_conflicts: bool = False,
) -> dict | tuple[dict, list[dict]]:
    """Merge field-level values from jsonld/ai/heuristic extractors.

    JSON-LD wins over AI and heuristic; AI wins over heuristic when
    JSON-LD is absent. Fields absent from every source resolve to None.
    When requested, report disagreements between present JSON-LD and AI values.
    """
    merged = {}
    conflicts = []

    for field in FIELDS:
        jsonld_val = sources.get(f"jsonld_{field}")
        ai_val = sources.get(f"ai_{field}")
        heur_val = sources.get(f"heur_{field}")

        if jsonld_val is not None:
            chosen = jsonld_val
            if ai_val is not None and ai_val != jsonld_val:
                conflicts.append({
                    "field": field,
                    "jsonld": jsonld_val,
                    "ai": ai_val,
                })
        elif ai_val is not None:
            chosen = ai_val
        else:
            chosen = heur_val

        merged[field] = chosen

    if return_conflicts:
        return merged, conflicts
    return merged
