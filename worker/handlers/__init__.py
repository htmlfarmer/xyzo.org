"""Queue-callable worker handlers.

Each handler module exposes ``run(payload, ctx)`` matching the dispatcher's
HANDLERS contract in ``worker/dispatcher.py``. The dispatcher lazy-loads
modules on first use and threads a JobContext in; this package is the
canonical home for handlers that fan work out from the Node-side queue.

Legacy ``worker/<module>.py`` files still hold the underlying business
logic (so the same code stays callable from synchronous CLI paths and
existing callers); this package adds a thin ctx-aware adapter on top.
"""