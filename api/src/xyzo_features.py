"""xyzo_features — runtime feature flag + config reader.

Used by every Python worker subprocess (called via `python3 -c` from
Hono routes). Reads from Postgres feature_flags + feature_config tables.

Design goals:
- Never raise. Falls back to defaults if DB is unreachable.
- Cheap to call repeatedly (in-memory cache, invalidated on demand).
- Stable hash for percentage-based rollout.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

log = logging.getLogger("xyzo.features")

_CACHE_TTL_S = 30.0
_cache: dict[str, tuple[float, Any]] = {}


def _stable_hash(s: str) -> int:
    """Deterministic 31-bit hash. Stable across processes.

    Returns an int in [0, 2**31) so callers can safely use it as
    ``hash % 100`` without consuming an unsigned 32-bit range that
    would skew the percentile distribution."""
    digest = hashlib.sha256(s.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big", signed=False) & 0x7FFFFFFF


def _resolve_pct(flag: dict, host: str, tier: str) -> bool:
    """Resolve a flag to a boolean for a given host+tier.

    Precedence: host_overrides > tier_overrides > rollout_pct."""
    overrides = flag.get("host_overrides") or {}
    if host in overrides:
        return bool(overrides[host])
    tier_overrides = flag.get("tier_overrides") or {}
    pct = tier_overrides.get(tier, flag.get("rollout_pct", 0))
    return _stable_hash(f"{host}") % 100 < int(pct)


def _connect():
    """Lazy import to keep this module importable without DB env."""
    from db import connect  # type: ignore
    return connect()


def _fetch_all_flags() -> dict[str, dict]:
    """Read all flags from DB. Returned dict is keyed by flag key."""
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT key, enabled, rollout_pct, tier_overrides, "
                "host_overrides FROM feature_flags"
            )
            rows = cur.fetchall()
        out: dict[str, dict] = {}
        for r in rows:
            out[r["key"]] = {
                "enabled": r["enabled"],
                "rollout_pct": r["rollout_pct"],
                "tier_overrides": r["tier_overrides"] or {},
                "host_overrides": r["host_overrides"] or {},
            }
        return out
    except Exception as e:
        log.warning("failed to fetch flags: %s", e)
        return {}


def _fetch_config() -> dict[str, Any]:
    """Read all feature_config rows."""
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT key, value FROM feature_config")
            rows = cur.fetchall()
        return {r["key"]: r["value"] for r in rows}
    except Exception as e:
        log.warning("failed to fetch config: %s", e)
        return {}


def _maybe_refresh(key: str) -> bool:
    """Return True if cache is fresh."""
    if key not in _cache:
        return False
    ts, _ = _cache[key]
    return (time.time() - ts) < _CACHE_TTL_S


def get_all_flags() -> dict[str, dict]:
    """Return all flags as a dict. Cached for _CACHE_TTL_S seconds."""
    if _maybe_refresh("flags"):
        return _cache["flags"][1]
    try:
        flags = _fetch_all_flags()
    except Exception as e:
        log.warning("get_all_flags: fetch failed, returning empty: %s", e)
        return {}
    _cache["flags"] = (time.time(), flags)
    return flags


def get_config(key: str, default: Any = None) -> Any:
    """Return the value of a feature_config key. Falls back to default."""
    if not _maybe_refresh("config"):
        try:
            cfg = _fetch_config()
        except Exception as e:
            log.warning("get_config: fetch failed, using default: %s", e)
            return default
        _cache["config"] = (time.time(), cfg)
    else:
        cfg = _cache["config"][1]
    return cfg.get(key, default)


def is_enabled(flag_key: str, host: str, tier: str,
               flags: dict | None = None) -> bool:
    """Check if a feature flag is enabled for a given host + tier.

    Honors the `emergency_disable_intelligence` kill switch first.
    `flags` parameter is injectable for testing.
    """
    if flags is None:
        flags = get_all_flags()

    # 1. Kill switch
    emergency = flags.get("emergency_disable_intelligence", {})
    if emergency.get("enabled"):
        return False

    flag = flags.get(flag_key)
    if not flag:
        return False
    if not flag.get("enabled"):
        return False

    return _resolve_pct(flag, host, tier)


def invalidate_cache() -> None:
    """Force-refresh on next call. Useful after flag updates."""
    _cache.clear()
