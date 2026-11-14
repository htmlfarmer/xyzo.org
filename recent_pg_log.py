"""Read the *latest* portion of the postgres log via pg_read_file."""
import subprocess
import re
from collections import Counter

sql = """SELECT replace(
  pg_read_file('/var/log/postgresql/postgresql-15-main.log', 10000000, 1500000),
  E'\\000', ' '
);"""
out = subprocess.check_output(
    ["psql", "-U", "postgres", "-h", "/var/run/postgresql",
     "-d", "xyzo", "-t", "-A", "-c", sql],
    stderr=subprocess.STDOUT,
).decode("utf-8", errors="replace").strip()

lines = out.split("\n")
print(f"Lines: {len(lines)}")
print(f"First line:  {lines[0][:200] if lines else ''}")
print(f"Last line:   {lines[-1][:200] if lines else ''}")
print()

errors = [l for l in lines if "ERROR:" in l]
warnings = [l for l in lines if "WARNING:" in l]
fatals = [l for l in lines if "FATAL:" in l]
print(f"Errors in this chunk: {len(errors)}")
print(f"Warnings in this chunk: {len(warnings)}")
print(f"Fatals in this chunk: {len(fatals)}")
print()

# Unique error signatures
sigs = Counter()
errs_by_minute = Counter()
for e in errors:
    m = re.search(r'ERROR:\s+(.+?)(?:\s+at character\s+\d+|\s+\[".*?"\]|$)', e)
    if m:
        sigs[m.group(1)[:100]] += 1
    ts_m = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', e)
    if ts_m:
        errs_by_minute[ts_m.group(1)] += 1

print("Top 15 error signatures in the last 1.5MB of log:")
for s, c in sigs.most_common(15):
    print(f"  {c:5d}  {s}")

print("\nTop 20 minutes with errors (most recent first):")
for m, c in sorted(errs_by_minute.items(), reverse=True)[:20]:
    print(f"  {m}  {c}")

# Show first 5 actual error lines for context
print("\nFirst 5 actual ERROR lines:")
for e in errors[:5]:
    print(f"  {e[:300]}")
