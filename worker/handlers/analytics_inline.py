"""Queue-callable handler for the ``analytics_inline`` job kind.

Dispatches on ``payload['op']`` to one of the two helpers in
``worker.analytics_inline``:

  * ``sniff_article_cities`` — replaces the inline ``-c`` at
    ``analytics.ts:~497`` (article city classification for the admin
    sniff context).
  * ``validate_url`` — replaces the inline ``-c`` at
    ``analytics.ts:~613`` (URL paywall/login probe, fired in the
    background on user reports).

The handler:

  * Polls ``ctx.check_cancel()`` once at the start so a `cancel` IPC
    message aborts the job before either helper runs. Both helpers
    are short, synchronous, and run under a 3s kind-level default,
    so a single checkpoint is enough — the dispatcher would otherwise
    see the job finish cleanly even after a cancel because there's no
    network I/O to interrupt cleanly inside the helpers themselves
    (``validate_url`` does run network I/O, but that's covered by the
    ``validate_url`` timeout, not by our cancel checkpoint).
  * Re-raises unknown ``op`` values so the dispatcher surfaces them as
    a ``fail`` event with a clear message instead of silently
    returning an empty dict.

Payload shape
-------------
``op``      : ``'sniff_article_cities'`` | ``'validate_url'``

``sniff_article_cities`` extras::

    text : str   — article body (or title+"\n"+body slice)

``validate_url`` extras::

    url     : str — URL to probe
    timeout : float (optional, default 15) — httpx timeout in seconds
"""
from __future__ import annotations

from typing import Any

from worker.analytics_inline import sniff_article_cities, validate_url


_OPS = {
    "sniff_article_cities": sniff_article_cities,
    "validate_url": validate_url,
}


def run(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Dispatcher's entry point for the ``analytics_inline`` kind.

    Forwards the payload to the matching ``worker.analytics_inline``
    helper and returns its unchanged result dict. Result shapes are:

      * ``sniff_article_cities`` → ``{primary, primary_label, count,
        high_confidence, countries, cities[], hint}``
      * ``validate_url`` → ``worker.url_validator.validate_url`` shape
        (``{url, accessible, paywalled, login_required, status_code,
        content_length, indicators[], title, error}``)

    Both shapes match what the legacy inline scripts emitted, so the
    queue path is wire-compatible with the legacy fallback registered
    in ``api/src/legacy/analyticsInline.ts``.
    """
    # Single cancel checkpoint before any work runs — matches the
    # pattern used by other short sync-wait handlers (feedback_suggest,
    # auto_categorize). validate_url can take up to 15s of network I/O
    # when the kind is fired fire-and-forget (waitMs=0), and the route
    # relies on the job continuing to run independently of the HTTP
    # response — a cancel that lands before this checkpoint will still
    # produce the right outcome.
    ctx.check_cancel()

    op = payload.get("op")
    fn = _OPS.get(op) if isinstance(op, str) else None
    if fn is None:
        raise ValueError(f"unknown analytics_inline op: {op!r}")
    return fn(payload)
