"""Cooperative CPU load guard — "if something goes very wrong, spot it from
the CPU side and stop that" — WITHOUT needing systemd privileges.

Design: the watchdog (or health_monitor --cron) calls evaluate() every few
minutes. If 1-minute load average exceeds HIGH_WATER × nproc, a pause flag is
written. Every pipeline entrypoint calls should_pause() at startup and skips
its cycle politely (exit 0, logged). When load drops back under LOW_WATER the
flag clears itself. This is deliberately dumb, deterministic, and restart-safe.

Why not auto `systemctl stop`: we run without sudo in this session; cgroup
CPUQuota drop-ins (deploy/systemd/) are the hard cap — this module is the
soft cap that works today and leaves an audit trail.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

# Shared location: workers run as root and as asher — /tmp survives both,
# the site dir survives reboots. Use the site (visible + gitignored-worthy).
PAUSE_FILE = Path(__file__).resolve().parents[1] / "data" / "load_pause"

# Thresholds are driven by *stall* pressure, not load average.
#
# Load average counts runnable AND uninterruptible-sleep (D-state) tasks, so
# on this box it is inflated by IO wait rather than CPU demand. A worker
# waiting on the disk pushed the 1-minute load to ~7 while the CPU sat 80%
# idle — the old 0.75 threshold (12.0 on 16 threads) therefore never fired,
# and when load did climb it was usually IO, which pausing does not fix.
#
# PSI (pressure stall information) measures the fraction of wall time tasks
# were actually stalled waiting for a resource. That is the signal we want:
# if the CPU is genuinely saturated, "some" rises; if the disk is slow,
# only the io file rises and we keep working.
CPU_PRESSURE_HIGH = 25.0   # % of time some task stalled on CPU -> pause
CPU_PRESSURE_LOW = 10.0    # resume below this
MEM_AVAIL_LOW_MB = 2048     # pause if available RAM drops below this
MAX_PAUSE_S = 3600          # never pause longer than 1 h without re-evaluation


def cpu_count() -> int:
    # Use the TRUE capacity (os.cpu_count), not the shell's affinity mask —
    # this box has 16 hardware threads; nproc reports 8 for some users.
    # systemd CPUQuota caps are the day-to-day politeness; this guard is the
    # runaway detector, so it should fire at real saturation, not at 8/16.
    return os.cpu_count() or 4


def _psi(resource: str) -> float:
    """Return the 'some' stall percentage (avg10) for a PSI resource.

    /proc/pressure/<resource> lines look like:
        some avg10=4.87 avg60=6.69 avg300=5.42 total=75285062093
    We want avg10 — the recent past — so the guard reacts quickly.
    """
    try:
        with open(f"/proc/pressure/{resource}") as f:
            for line in f:
                if line.startswith("some"):
                    for field in line.split():
                        if field.startswith("avg10="):
                            return float(field.split("=", 1)[1])
    except (OSError, ValueError):
        pass
    return 0.0


def cpu_pressure_pct() -> float:
    """% of wall time at least one task was stalled waiting for CPU."""
    return _psi("cpu")


def mem_available_mb() -> float:
    """Available RAM in MB (MemAvailable accounts for reclaimable cache)."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return float(line.split()[1]) / 1024.0
    except (OSError, ValueError):
        pass
    return float("inf")


def load_frac() -> float:
    """Normalized 1-minute load average — kept for reporting/back-compat.

    No longer used for the pause decision; see CPU_PRESSURE_* above.
    """
    try:
        return os.getloadavg()[0] / cpu_count()
    except OSError:
        return 0.0


def should_pause() -> bool:
    if not PAUSE_FILE.exists():
        return False
    try:
        age = time.time() - PAUSE_FILE.stat().st_mtime
        if age > MAX_PAUSE_S:
            PAUSE_FILE.unlink(missing_ok=True)
            return False
        return True
    except OSError:
        return False


def pause_reason() -> str:
    try:
        return PAUSE_FILE.read_text().strip()[:200]
    except OSError:
        return ""


def evaluate(verbose: bool = False) -> dict:
    """Sample stall pressure, set/clear the pause flag. Returns status dict."""
    frac = load_frac()
    cores = cpu_count()
    cpu_pct = cpu_pressure_pct()
    mem_mb = mem_available_mb()
    was_paused = should_pause()
    state = {"load_frac": round(frac, 2), "cores": cores,
             "cpu_pressure_pct": round(cpu_pct, 2),
             "mem_available_mb": round(mem_mb),
             "paused": was_paused, "changed": False}

    # Two independent reasons to hold off: the CPU is genuinely saturated
    # (tasks stalled waiting for a core), or RAM is nearly exhausted (the
    # next cycle would thrash the machine).
    cpu_hot = cpu_pct > CPU_PRESSURE_HIGH
    mem_low = mem_mb < MEM_AVAIL_LOW_MB
    cpu_ok = cpu_pct < CPU_PRESSURE_LOW and mem_mb >= MEM_AVAIL_LOW_MB * 2

    if not was_paused and (cpu_hot or mem_low):
        PAUSE_FILE.parent.mkdir(parents=True, exist_ok=True)
        why = []
        if cpu_hot:
            why.append(f"cpu stall {cpu_pct:.1f}% > {CPU_PRESSURE_HIGH:.0f}%")
        if mem_low:
            why.append(f"available RAM {mem_mb:.0f}MB < {MEM_AVAIL_LOW_MB}MB")
        PAUSE_FILE.write_text(
            f"paused at {time.strftime('%Y-%m-%d %H:%M:%S %Z')} "
            f"— {', '.join(why)}. Cycles skip until cpu stall "
            f"< {CPU_PRESSURE_LOW:.0f}% and RAM recovers, or after "
            f"{MAX_PAUSE_S // 60} min.")
        state["paused"] = True
        state["changed"] = True
    elif was_paused and cpu_ok:
        age = time.time() - PAUSE_FILE.stat().st_mtime
        if age > 120:  # don't oscillate on a single lucky sample
            PAUSE_FILE.unlink(missing_ok=True)
            state["paused"] = False
            state["changed"] = True

    if verbose or state["changed"]:
        import logging
        log = logging.getLogger("xyzo.load_guard")
        msg = (f"cpu stall {cpu_pct:.1f}% | avail RAM {mem_mb:.0f}MB "
               f"| load {frac:.0%} of {cores} cores — "
               + ("PAUSED" if state["paused"] else "running"))
        (log.warning if state["changed"] else log.info)(msg)
    return state


def top_cpu_processes(n: int = 5) -> list[tuple[float, str]]:
    """Best-effort CPU hogs for the alert (pure /proc, no ps permissions)."""
    procs: list[tuple[float, str]] = []
    try:
        import subprocess
        out = subprocess.run(
            ["ps", "-eo", "pcpu,comm,args", "--sort=-pcpu", "--no-headers"],
            capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines()[:n]:
            parts = line.split(None, 2)
            if len(parts) == 3:
                procs.append((float(parts[0]), parts[2][:70]))
    except Exception:
        pass
    return procs
