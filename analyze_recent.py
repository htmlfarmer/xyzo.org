"""Analyze the recent postgres log chunk."""
import re
from collections import Counter

with open("/tmp/pg_recent.log", encoding="utf-8", errors="replace") as f:
    text = f.read()
lines = text.split("\n")
print(f"Total lines: {len(lines)}")

errors = [l for l in lines if "ERROR:" in l]
warnings = [l for l in lines if "WARNING:" in l]
fatals = [l for l in lines if "FATAL:" in l]
print(f"ERROR: {len(errors)}")
print(f"WARNING: {len(warnings)}")
print(f"FATAL: {len(fatals)}")

sigs = Counter()
errs_by_minute = Counter()
for e in errors:
    m = re.search(r'ERROR:\s+(.+?)(?:\s+at character\s+\d+|\s+\[".*?"\]|$)', e)
    if m:
        sigs[m.group(1)[:120]] += 1
    ts_m = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', e)
    if ts_m:
        errs_by_minute[ts_m.group(1)] += 1

print("\nTop 20 ERROR signatures:")
for s, c in sigs.most_common(20):
    print(f"  {c:5d}  {s}")

print("\nTop 20 minutes with errors:")
for m, c in sorted(errs_by_minute.items(), reverse=True)[:20]:
    print(f"  {m}  {c}")

# Show 5 actual error lines for context
print("\nFirst 5 ERROR lines (truncated):")
for e in errors[:5]:
    print(f"  {e[:280]}")
    print()

print("\nLast 5 ERROR lines (truncated):")
for e in errors[-5:]:
    print(f"  {e[:280]}")
    print()
