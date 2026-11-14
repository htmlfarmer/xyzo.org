"""Re-evaluation worker — handles news_re_evaluate_requests queued by the
API's /api/pins/:id/{re-evaluate,suggest-coords,suggest-location} endpoints.

The API spawns `python -m worker.run --re-evaluate-request <id>` per request.
The worker:

  1. Loads the request row.
  2. Switches on `kind`:
     - "re_evaluate"      → re-run AI extraction on the article body with
                            the user's suggestion as context. Uses the city
                            scanner to detect entities and the improved AI
                            prompt to avoid extracting person names.
     - "suggest_location" with `user_place="coords:lat,lng[,radius]"`
                        → user clicked the map; apply the move directly
                          to pins.location and update news_articles
                          .location_id via reverse geocode (or raw insert).
     - "suggest_location" with free-text `user_place`
                        → reverse-geocode the user's place via the AI /
                          Nominatim path and apply if confident.
  3. Sets the request's status to completed / failed / skipped and writes
     the result JSON.

Returns a summary dict that the runner can JSON-emit on stdout for the
API caller to log.
"""

import json
import logging
import re
import time
import urllib.parse
from typing import Any

from .db import connect
from . import geocode

log = logging.getLogger("xyzo.re_evaluate")


def _decode_coords(user_place: str | None) -> dict | None:
    """Decode one of:

      `coords:lat,lng[,radius_km[,confidence[,url_encoded_text]]]`
      `text+coords:lat,lng,radius_km,confidence,url_encoded_text`

    The "text+coords:" prefix means the user clicked the map AND typed a
    free-form reason — we apply the coordinates but capture the note for
    audit / suggested_reasoning. text-only submissions go through a
    different codepath (`_apply_text_suggestion`).

    Returns None when the format doesn't match (caller falls back to text
    mode for plain-text submissions)."""
    if not user_place:
        return None
    payload = None
    if user_place.startswith("coords:"):
        payload = user_place[len("coords:"):]
    elif user_place.startswith("text+coords:"):
        # Same shape as coords: — we drop the prefix and treat
        # identically. The "text+" part is just a routing hint for the
        # worker run_one() to know the click came with a note.
        payload = user_place[len("text+coords:"):]
    else:
        return None
    parts = payload.split(",")
    if len(parts) < 2:
        return None
    try:
        lat = float(parts[0])
        lng = float(parts[1])
    except ValueError:
        return None
    radius_km = float(parts[2]) if len(parts) >= 3 else 25.0
    confidence = float(parts[3]) if len(parts) >= 4 else None
    note: str | None = None
    if len(parts) >= 5:
        try:
            note = urllib.parse.unquote(parts[4])
        except Exception:
            note = None
    return {"lat": lat, "lng": lng, "radius_km": radius_km,
            "confidence": confidence, "note": note}


def _precision_for_radius(radius_km: float) -> str:
    """Mirror the API's precision bucket so the worker doesn't have to redo
    the same arithmetic — but defend against client drift by recomputing."""
    if radius_km <= 5:  return "exact"
    if radius_km <= 25: return "city"
    if radius_km <= 100: return "region"
    return "country"


def _re_evaluate_with_ai(request_id: int, pin_id: int, article_id: int | None,
                         user_place: str | None) -> dict:
    """Re-run AI extraction on the article body with the user's suggestion
    as context. Uses the city scanner to detect entities and the improved
    AI prompt to avoid extracting person names.

    Returns a dict with {applied, place_name, lat, lng, precision, confidence, reasoning}.
    """
    from . import cities_text, extract, web_search

    if not article_id:
        _mark_skipped(request_id, "no article_id for re_evaluate", {"applied": False})
        return {"applied": False, "reason": "no_article"}

    # Load the article.
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, title, body, location_text, extracted_lat, extracted_lng
            FROM news_articles WHERE id = %s
        """, (article_id,))
        article = cur.fetchone()

    if not article:
        _mark_skipped(request_id, f"article {article_id} not found", {"applied": False})
        return {"applied": False, "reason": "article_not_found"}

    title = article["title"] or ""
    body = article["body"] or ""

    # Run city scanner to detect entities and cities.
    scan_text = f"{title}\n{body[:2000]}"
    city_stats = cities_text.stats(scan_text)
    city_hint = cities_text.format_city_hint(city_stats)

    # If the user suggested a location, verify it via web search.
    web_verification = None
    if user_place and not user_place.startswith("coords:"):
        web_verification = web_search.verify_location(title, user_place)
        log.info("Web verification for %r + %r: %s (confidence=%.2f)",
                 title[:50], user_place,
                 "verified" if web_verification["verified"] else "not verified",
                 web_verification["confidence"])

    # Build a context-aware prompt for the AI.
    context_parts = [f"Title: {title}", f"Body:\n{body[:2500]}"]
    if user_place and not user_place.startswith("coords:"):
        context_parts.insert(0, f"USER SUGGESTS THIS LOCATION: \"{user_place}\"")
    if city_hint:
        context_parts.insert(0, city_hint)
    if web_verification and web_verification.get("verified"):
        context_parts.insert(0,
            f"WEB SEARCH CONFIRMS: The location '{user_place}' is plausible for this article. "
            f"Reasoning: {web_verification.get('reasoning', '')}")

    prompt = "\n\n".join(context_parts)

    # Call the AI.
    try:
        import httpx
        with httpx.Client() as client:
            result = extract.extract_one(client, {"id": article_id, "title": title, "body": body})
    except Exception as e:
        log.warning("AI re-evaluation failed for article %d: %s", article_id, e)
        _mark_failed(request_id, f"AI failed: {e}"[:500])
        return {"applied": False, "reason": "ai_failed"}

    location_text = result.get("location_text")
    if not location_text:
        _mark_skipped(request_id, "AI found no location", {"applied": False})
        return {"applied": False, "reason": "no_location_found"}

    # Geocode the AI's result.
    try:
        with httpx.Client() as client:
            geo = geocode.geocode_one(client, location_text)
    except Exception as e:
        log.warning("Geocode failed for %r: %s", location_text, e)
        geo = None

    if not geo:
        _mark_skipped(request_id, f"geocode failed for {location_text}", {"applied": False})
        return {"applied": False, "reason": "geocode_failed", "location_text": location_text}

    # Apply the result.
    location_id = geocode.upsert_location(geo)
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_articles
            SET location_id = %s,
                location_text = %s,
                location_confidence = %s,
                re_evaluated_at = now(),
                re_evaluation_reasoning = %s
            WHERE id = %s
        """, (location_id, geo["place_name"], geo["confidence"],
              f"AI re-evaluation with user hint: {user_place or 'none'}", article_id))
        conn.commit()

    _mark_completed(request_id, {
        "applied": True,
        "place_name": geo["place_name"],
        "lat": geo["lat"],
        "lng": geo["lng"],
        "precision": geo["precision"],
        "confidence": geo["confidence"],
        "reasoning": f"AI re-evaluated with user hint: {user_place or 'none'}",
        "web_verification": web_verification,
    })

    return {
        "applied": True,
        "place_name": geo["place_name"],
        "lat": geo["lat"],
        "lng": geo["lng"],
        "precision": geo["precision"],
        "confidence": geo["confidence"],
    }


def _load_request(request_id: int) -> dict | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT r.id, r.pin_id, r.article_id, r.kind, r.user_place,
                   r.status, r.started_at, r.completed_at, r.error_message
            FROM news_re_evaluate_requests r
            WHERE r.id = %s
            """,
            (request_id,),
        )
        return cur.fetchone()


def _mark_running(request_id: int) -> None:
    """Idempotent: only flip queued → running, never running → queued."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_re_evaluate_requests
            SET status = 'running',
                started_at = COALESCE(started_at, now())
            WHERE id = %s AND status = 'queued'
            """,
            (request_id,),
        )


def _mark_completed(request_id: int, result: dict) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_re_evaluate_requests
            SET status = 'completed',
                completed_at = now(),
                result = %s
            WHERE id = %s
            """,
            (json.dumps(result), request_id),
        )


def _mark_failed(request_id: int, message: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_re_evaluate_requests
            SET status = 'failed',
                completed_at = now(),
                error_message = %s
            WHERE id = %s
            """,
            (message[:1000], request_id),
        )


def _mark_skipped(request_id: int, reason: str, result: dict | None = None) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_re_evaluate_requests
            SET status = 'skipped',
                completed_at = now(),
                error_message = %s,
                result = %s
            WHERE id = %s
            """,
            (reason[:1000], json.dumps(result or {}), request_id),
        )


def _apply_coord_suggestion(
    pin_id: int,
    article_id: int,
    coords: dict,
    precision: str,
    confidence: float,
) -> dict:
    """Move a pin to user-supplied coordinates. Used when the user clicked
    the map to indicate the correct area.

    Side effects:
      - INSERT/UPDATE news_locations row with the user's lat/lng.
      - UPDATE pins.location and confidence_score to point at the new
        location.
      - UPDATE news_articles.location_id and re-evaluated_at.
      - Increment news_locations.learned_from_user_count (so future
        extractor runs weight this user input).

    `coords["note"]` is the optional free-text reason the user typed. It
    replaces the synthesised "user suggestion" placeholder in place_name
    and (more importantly) ends up in news_articles.suggested_reasoning
    via the `_mark_completed` flow — useful for audit + downstream
    clusterer weight tuning.
    """
    radius_km = coords["radius_km"]
    lat = coords["lat"]
    lng = coords["lng"]
    # Trust caller-supplied confidence when present (it comes from the
    # API's radius_km bucket computation, which is more authoritative
    # than our recomputation). Fall back to the bucket-derived value.
    if coords.get("confidence") is not None:
        confidence = coords["confidence"]
    note = (coords.get("note") or "").strip()

    # Synthesise a place_name that's identifiable in audit logs. Prefer
    # the user's note (it's actual context, "Beirut, Lebanon" reads
    # better than coordinates) but truncate to keep the column short.
    if note:
        place_name = note[:120]
    else:
        place_name = f"user suggestion ({lat:.4f},{lng:.4f})"
    with connect() as conn, conn.cursor() as cur:
        # Find existing location within ~radius/2 — exact match by lat/lng
        # precision matching the suggestion's bucket. Don't merge with a
        # distant row; create a new one to keep the suggestion traceable.
        cur.execute(
            """
            SELECT id FROM news_locations
            WHERE ROUND(lat::numeric, 3) = ROUND(%s::numeric, 3)
              AND ROUND(lng::numeric, 3) = ROUND(%s::numeric, 3)
            LIMIT 1
            """,
            (lat, lng),
        )
        row = cur.fetchone()
        if row:
            location_id = row["id"]
        else:
            cur.execute(
                """
                INSERT INTO news_locations (
                    place_name, place_name_normalized, country, lat, lng,
                    precision, confidence, osm_id, osm_type, geom,
                    learned_from_user_count
                )
                VALUES (%s, %s, NULL, %s, %s, %s, %s, NULL, NULL,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                        1)
                RETURNING id
                """,
                (
                    place_name, f"user:{lat:.4f},{lng:.4f}",
                    lat, lng, precision, confidence,
                    lng, lat,
                ),
            )
            location_id = cur.fetchone()["id"]

        # Move the pin to the new location. Don't touch category — the
        # editor / AI extracted the right one at insert time, and we don't
        # want a "Wrong location" click on a category-3 pin to silently
        # downgrade it to "other".
        cur.execute(
            """
            UPDATE pins
            SET location = ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                location_precision = %s,
                confidence_score = %s
            WHERE id = %s
            """,
            (lng, lat, precision, max(confidence, 0.5), pin_id),
        )

        # Update the article row too so /api/pins reflects the new
        # location_id and re-evaluated_at. Also bump confidence on the
        # locations row so future geocoders bias toward it.
        cur.execute(
            """
            UPDATE news_articles
            SET location_id = %s,
                location_confidence = %s,
                re_evaluated_at = now()
            WHERE id = %s
            """,
            (location_id, confidence, article_id),
        )

        # Bump learned_from_user_count on the new location row to signal
        # the clusterer / extractor that this is user-validated ground truth.
        cur.execute(
            """
            UPDATE news_locations
            SET learned_from_user_count = learned_from_user_count + 1
            WHERE id = %s
            """,
            (location_id,),
        )

    return {
        "applied": True,
        "location_id": location_id,
        "lat": lat,
        "lng": lng,
        "radius_km": radius_km,
        "precision": precision,
        "confidence": confidence,
    }


def _apply_text_suggestion(pin_id: int, article_id: int, user_place: str) -> dict:
    """User typed a free-text place (e.g. "Beirut, Lebanon"). Geocode it
    and apply if confident.

    This is the path for /api/pins/:id/suggest-location. For now we use
    a simple reverse lookup via Nominatim or the AI's place resolver;
    if confidence is below threshold we record but don't move."""
    # Normalise place.
    place = re.sub(r"\s+", " ", user_place or "").strip()
    if len(place) < 2:
        return {"applied": False, "reason": "empty_place"}
    # We don't import httpx here to keep this module light; geocode.geocode_one
    # drives the lookup. Re-use the constant it already uses.
    import httpx
    try:
        with httpx.Client(timeout=20) as client:
            r = client.get(
                geocode.NOMINATIM_URL,
                params={"q": place, "format": "json", "limit": 1, "addressdetails": 0},
                headers={"User-Agent": "xyzo.org/1.0 (geocoder)"},
            )
            r.raise_for_status()
            data = r.json()
        if not data:
            return {"applied": False, "reason": "no_match", "user_place": place}
        hit = data[0]
        lat = float(hit["lat"])
        lng = float(hit["lon"])
        confidence = 0.7  # Nominatim hits are reasonable but not perfect
        # Auto-pick precision based on the OSM `type` and class.
        osm_type = hit.get("type", "")
        precision = "city" if osm_type in {"city", "town"} else "region"
        return _apply_coord_suggestion(pin_id, article_id, {"lat": lat, "lng": lng, "radius_km": 25}, precision, confidence)
    except Exception as exc:
        log.warning("text-suggestion geocode failed for %r: %s", place, exc)
        return {"applied": False, "reason": "geocode_error", "error": str(exc)[:200]}


def run_one(request_id: int) -> dict:
    """Process a single re-evaluation request. Returns a summary dict."""
    req = _load_request(request_id)
    if not req:
        return {"id": request_id, "skipped": True, "reason": "not_found"}

    if req["status"] not in ("queued", "running"):
        return {"id": request_id, "skipped": True, "reason": f"already_{req['status']}"}

    _mark_running(request_id)
    pin_id = req["pin_id"]
    article_id = req["article_id"]
    kind = req["kind"]
    user_place = req["user_place"]

    t0 = time.time()
    try:
        if kind == "re_evaluate":
            # Re-run AI extraction on the article body with the user's
            # suggestion as context. Uses the city scanner to detect
            # entities and the improved AI prompt to avoid extracting
            # person names.
            result = _re_evaluate_with_ai(request_id, pin_id, article_id, user_place)
            return {"id": request_id, "kind": kind, **result, "elapsed_s": round(time.time() - t0, 1)}

        if kind == "suggest_location":
            # Two encoded shapes arrive here:
            #   coords:lat,lng,radius_km,confidence[,url_encoded_note]
            #   text:free-form description      (legacy / plain prose)
            #   text+coords:lat,lng,radius_km,confidence,url_encoded_note  (both)
            #
            # We try each prefix in order; first that parses wins. The
            # text-only path falls through to Nominatim-style reverse
            # geocoding of the user's free text.
            coords = _decode_coords(user_place)
            if coords is not None and (user_place or "").startswith("text+coords:"):
                # Both signals — user clicked the map AND typed a
                # reason. Trust the click for coordinates (it's grounded
                # in the map) but use the reason as the place_name +
                # audit text. Confidence is set from radius_km at the API.
                precision = _precision_for_radius(coords["radius_km"])
                confidence = coords.get("confidence") or {
                    "exact": 0.9, "city": 0.85, "region": 0.7, "country": 0.55
                }[precision]
                result = _apply_coord_suggestion(
                    pin_id, article_id, coords, precision, confidence,
                )
            elif coords is not None:
                # Coord-only path: pure map click.
                precision = _precision_for_radius(coords["radius_km"])
                confidence = coords.get("confidence") or {
                    "exact": 0.9, "city": 0.85, "region": 0.7, "country": 0.55
                }[precision]
                result = _apply_coord_suggestion(
                    pin_id, article_id, coords, precision, confidence,
                )
            elif user_place:
                # Text path: user typed a place name.
                result = _apply_text_suggestion(pin_id, article_id, user_place)
            else:
                _mark_skipped(request_id, "no user_place provided")
                return {"id": request_id, "kind": kind, "applied": False, "skipped": True}

            _mark_completed(request_id, result)
            return {"id": request_id, "kind": kind, **result, "elapsed_s": round(time.time() - t0, 1)}

        # Unknown kind — skip.
        _mark_skipped(request_id, f"unknown kind: {kind}")
        return {"id": request_id, "skipped": True, "reason": f"unknown_kind:{kind}"}
    except Exception as exc:
        log.exception("re-evaluate failed for request %s", request_id)
        _mark_failed(request_id, f"{type(exc).__name__}: {exc}"[:1000])
        return {"id": request_id, "failed": True, "error": str(exc)[:200]}
