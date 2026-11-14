"""Ad-hoc analytics helpers formerly inlined as ``python3 -c "..."`` scripts
in ``api/src/routes/analytics.ts``.

Two operations were extracted:

  * ``sniff_article_cities`` — runs the cities-text extractor over an
    article body (used by the admin sniff context on
    ``POST /api/analytics/report-quality`` to attach a location hint to
    the row in ``news_quality_reports.sniff_result``).
  * ``validate_url`` — checks whether a URL is accessible, paywalled, or
    login-gated (fired in the background when a user reports an article
    as ``paywall`` / ``login_required``).

The inline scripts were the only callers of these helpers; both now flow
through the ``analytics_inline`` queue kind so the dispatcher owns the
process lifecycle. The wrapper layer (``worker/handlers/analytics_inline.py``)
dispatches on ``payload['op']`` to the matching function below.
"""
from __future__ import annotations

from typing import Any

from worker.cities_text import format_city_hint, stats
from worker.url_validator import validate_url as _validate_url


def sniff_article_cities(payload: dict[str, Any]) -> dict[str, Any]:
    """Run the cities-text extractor over an article body.

    Replaces the inline ``-c`` script at ``analytics.ts:~497`` which did::

        from worker.cities_text import stats, format_city_hint
        text = sys.argv[1]
        s = stats(text)
        print(json.dumps({...}))

    The result shape is unchanged: callers (the admin triage queue)
    already render ``primary`` / ``primary_label`` / ``count`` /
    ``high_confidence`` / ``countries`` / ``cities`` / ``hint``. The
    list of cities is trimmed to the top 8 to match the inline
    script's slice, keeping the JSON bounded for the DB column.
    """
    text = payload.get("text")
    if not isinstance(text, str):
        raise ValueError(
            f"sniff_article_cities payload requires 'text' (str), got {type(text).__name__}"
        )

    s = stats(text)
    cities_raw = s.get("cities") or []
    cities_trimmed = [
        {
            "id": c.get("id"),
            "name": c.get("name"),
            "country_code": c.get("country_code"),
            "population": c.get("population"),
        }
        for c in cities_raw[:8]
    ]
    return {
        "primary": s.get("primary"),
        "primary_label": s.get("primary_label"),
        "count": s.get("count"),
        "high_confidence": s.get("high_confidence"),
        "countries": s.get("countries"),
        "cities": cities_trimmed,
        "hint": format_city_hint(s),
    }


def validate_url(payload: dict[str, Any]) -> dict[str, Any]:
    """Check whether a URL is accessible, paywalled, or login-gated.

    Replaces the inline ``-c`` script at ``analytics.ts:~613`` which did::

        from worker.url_validator import validate_url
        result = validate_url("${article[0]?.url || ''}")
        print(json.dumps(result))

    The original spawn was fire-and-forget (``detached: true``,
    ``stdio: "ignore"``); the queue path preserves that semantic via
    ``waitMs: 0`` on the route side. ``validate_url`` does network I/O
    with a 15s timeout inside ``worker.url_validator``, which is well
    within the kind's ``defaultTimeoutMs`` of 3s when callers enqueue
    with ``waitMs: 0`` (the route only fires this op when a user
    reports a paywall/login issue, so latency on the request handler
    is not a concern).
    """
    url = payload.get("url")
    if not isinstance(url, str) or not url:
        raise ValueError(
            f"validate_url payload requires non-empty 'url' (str), got {url!r}"
        )
    # NB: timeout forwarded so callers can tune it via payload['timeout'].
    # Defaults to 15s to match worker.url_validator's existing contract.
    try:
        timeout = float(payload.get("timeout") or 15)
    except (TypeError, ValueError):
        timeout = 15.0
    return _validate_url(url, timeout=timeout)
