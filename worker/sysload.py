"""System load monitor — CPU and GPU utilization for adaptive pipeline control.

The xyzo pipeline uses this module to decide whether to:
  - Run AI extraction (needs GPU headroom)
  - Run non-AI verifications (needs CPU headroom)
  - Throttle back to fast-path only (system under load)

Usage:
    from worker import sysload
    load = sysload.snapshot()
    if load.gpu_available:
        # safe to call AI
    elif load.cpu_idle_pct > 50:
        # run non-AI verifications

Caches results for CACHE_TTL_S seconds to avoid re-polling on every
article in a batch.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import time
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger("xyzo.sysload")

# How long to cache a snapshot before re-polling.
CACHE_TTL_S = 15.0

# Thresholds for decision-making.
#
# Policy: "anytime the GPU is <80% utilised, use it; once it climbs past
# 80%, treat it as busy and skip AI until it cools down." This is a
# stricter busy cutoff than the prior 90% — the GPU gets more breathing
# room between batches, but every cycle below 80% is fair game.
GPU_BUSY_PCT = 80        # GPU util% at-or-above this → "busy, skip AI"
GPU_MEMORY_BUSY_PCT = 85 # GPU memory% above this → "busy, skip AI"
CPU_IDLE_MIN_PCT = 30    # CPU idle% below this → "CPU busy, throttle back"
CPU_IDLE_GOOD_PCT = 50   # CPU idle% above this → "CPU free, run verifications"


@dataclass
class SystemLoad:
    """Point-in-time snapshot of system utilization."""
    # CPU
    cpu_count: int = 0
    cpu_idle_pct: float = 100.0      # % idle (higher = more free)
    cpu_user_pct: float = 0.0        # % in user mode
    cpu_sys_pct: float = 0.0         # % in system mode
    cpu_iowait_pct: float = 0.0      # % waiting on I/O

    # GPU (NVIDIA via nvidia-smi)
    gpu_available: bool = False      # nvidia-smi found a GPU
    gpu_name: str = ""
    gpu_util_pct: float = 0.0        # GPU core utilization %
    gpu_mem_used_mb: float = 0.0
    gpu_mem_total_mb: float = 0.0
    gpu_mem_pct: float = 0.0         # GPU memory utilization %
    gpu_temp_c: float = 0.0

    # Derived flags
    gpu_busy: bool = False           # True if GPU is too loaded for AI
    cpu_free: bool = True            # True if CPU has headroom for verifications
    mode: str = "full"               # "full" | "cpu_only" | "throttle"

    # Metadata
    timestamp: float = 0.0
    error: Optional[str] = None


_cache: Optional[SystemLoad] = None
_cache_at: float = 0.0


def _read_cpu_stats() -> dict:
    """Read /proc/stat for CPU utilization. Returns dict with percentages."""
    try:
        with open("/proc/stat") as f:
            line = f.readline()  # first line: "cpu  ..."
        parts = line.split()
        if len(parts) < 5:
            return {}
        # fields: user, nice, system, idle, iowait, irq, softirq, steal
        vals = [int(x) for x in parts[1:9]]
        total = sum(vals)
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
        iowait = vals[4] if len(vals) > 4 else 0
        return {
            "total": total,
            "idle": idle,
            "iowait": iowait,
            "user": vals[0] + vals[1],
            "sys": vals[2],
        }
    except Exception as e:
        log.debug("failed to read /proc/stat: %s", e)
        return {}


def _cpu_snapshot() -> dict:
    """Get CPU utilization by sampling /proc/stat twice with a short delay."""
    s1 = _read_cpu_stats()
    if not s1:
        return {}
    time.sleep(0.25)
    s2 = _read_cpu_stats()
    if not s2:
        return {}

    d_total = s2["total"] - s1["total"]
    d_idle = s2["idle"] - s1["idle"]
    d_iowait = s2["iowait"] - s1["iowait"]
    d_user = s2["user"] - s1["user"]
    d_sys = s2["sys"] - s1["sys"]

    if d_total == 0:
        return {}

    return {
        "idle_pct": round(100 * d_idle / d_total, 1),
        "user_pct": round(100 * d_user / d_total, 1),
        "sys_pct": round(100 * d_sys / d_total, 1),
        "iowait_pct": round(100 * d_iowait / d_total, 1),
    }


def _gpu_snapshot() -> dict:
    """Query nvidia-smi for GPU utilization. Returns empty dict if no GPU."""
    try:
        result = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return {}
        line = result.stdout.strip().split("\n")[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            return {}
        return {
            "name": parts[0],
            "util_pct": float(parts[1]),
            "mem_util_pct": float(parts[2]),
            "mem_used_mb": float(parts[3]),
            "mem_total_mb": float(parts[4]),
            "temp_c": float(parts[5]),
        }
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError, IndexError) as e:
        log.debug("nvidia-smi not available: %s", e)
        return {}


def snapshot(force: bool = False) -> SystemLoad:
    """Get current system load. Cached for CACHE_TTL_S seconds.

    Args:
        force: If True, bypass cache and re-poll immediately.

    Returns:
        SystemLoad dataclass with all utilization metrics.
    """
    global _cache, _cache_at
    now = time.time()
    if not force and _cache is not None and (now - _cache_at) < CACHE_TTL_S:
        return _cache

    load = SystemLoad(timestamp=now)

    # CPU
    cpu = _cpu_snapshot()
    if cpu:
        load.cpu_idle_pct = cpu.get("idle_pct", 100.0)
        load.cpu_user_pct = cpu.get("user_pct", 0.0)
        load.cpu_sys_pct = cpu.get("sys_pct", 0.0)
        load.cpu_iowait_pct = cpu.get("iowait_pct", 0.0)
    # Use the TRUE thread count. `nproc` reports 8 here because a global
    # OMP_NUM_THREADS=8 was exported from .bashrc (coreutils nproc honours
    # it) on a 16-thread box — so nproc understated capacity by 2x.
    load.cpu_count = os.cpu_count() or 0

    # GPU
    gpu = _gpu_snapshot()
    if gpu:
        load.gpu_available = True
        load.gpu_name = gpu.get("name", "")
        load.gpu_util_pct = gpu.get("util_pct", 0.0)
        load.gpu_mem_used_mb = gpu.get("mem_used_mb", 0.0)
        load.gpu_mem_total_mb = gpu.get("mem_total_mb", 0.0)
        load.gpu_mem_pct = gpu.get("mem_util_pct", 0.0)
        load.gpu_temp_c = gpu.get("temp_c", 0.0)
    else:
        load.gpu_available = False

    # Derive flags
    load.gpu_busy = (
        load.gpu_available and (
            load.gpu_util_pct >= GPU_BUSY_PCT or
            load.gpu_mem_pct >= GPU_MEMORY_BUSY_PCT
        )
    )
    load.cpu_free = load.cpu_idle_pct >= CPU_IDLE_MIN_PCT

    # Decision mode
    if load.gpu_busy and not load.cpu_free:
        load.mode = "throttle"      # system under heavy load — fast-path only
    elif load.gpu_busy and load.cpu_free:
        load.mode = "cpu_only"      # GPU busy but CPU free — run verifications
    else:
        load.mode = "full"          # GPU available — run AI

    _cache = load
    _cache_at = now
    return load


def ai_allowed() -> bool:
    """Quick check: should we attempt an AI call right now?

    Returns False if GPU is busy or system is throttled.
    Combines with the existing circuit breaker in extract.py.
    """
    load = snapshot()
    if load.gpu_busy:
        log.info("sysload: GPU busy (%.0f%% util, %.0f%% mem) — skipping AI",
                 load.gpu_util_pct, load.gpu_mem_pct)
        return False
    if load.mode == "throttle":
        log.info("sysload: system throttled (CPU idle=%.0f%%) — skipping AI",
                 load.cpu_idle_pct)
        return False
    return True


def should_run_verifications() -> bool:
    """Check if CPU has headroom for non-AI verification passes."""
    load = snapshot()
    return load.cpu_free


def status_dict() -> dict:
    """Return a JSON-serializable dict for the API."""
    load = snapshot()
    return {
        "mode": load.mode,
        "cpu": {
            "count": load.cpu_count,
            "idle_pct": load.cpu_idle_pct,
            "user_pct": load.cpu_user_pct,
            "sys_pct": load.cpu_sys_pct,
            "iowait_pct": load.cpu_iowait_pct,
            "free": load.cpu_free,
        },
        "gpu": {
            "available": load.gpu_available,
            "name": load.gpu_name,
            "util_pct": load.gpu_util_pct,
            "mem_used_mb": load.gpu_mem_used_mb,
            "mem_total_mb": load.gpu_mem_total_mb,
            "mem_pct": load.gpu_mem_pct,
            "temp_c": load.gpu_temp_c,
            "busy": load.gpu_busy,
        },
        "thresholds": {
            "gpu_busy_pct": GPU_BUSY_PCT,
            "gpu_mem_busy_pct": GPU_MEMORY_BUSY_PCT,
            "cpu_idle_min_pct": CPU_IDLE_MIN_PCT,
            "cpu_idle_good_pct": CPU_IDLE_GOOD_PCT,
        },
        "timestamp": load.timestamp,
        "error": load.error,
    }


if __name__ == "__main__":
    import json
    logging.basicConfig(level=logging.DEBUG)
    load = snapshot(force=True)
    print(json.dumps(status_dict(), indent=2))
