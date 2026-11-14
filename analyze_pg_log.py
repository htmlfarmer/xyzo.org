"""Analyze postgres log for error patterns — reads in chunks, replaces NULs."""
import subprocess
import re
from collections import Counter

# Read in chunks of 900000 bytes (under the 1MB default cap)
CHUNK = 900_000
OFFSET = 0
all_chunks = []

while True:
    sql = f"SELECT pg_read_file('/var/log/postgresql/postgresql-15-main.log', {OFFSET}, {CHUNK});"
    try:
        out = subprocess.check_output(
            ["psql", "-U", "postgres", "-h", "/var/run/postgresql",
             "-d", "xyzo", "-t", "-A", "-c", sql],
            stderr=subprocess.STDOUT,
        ).decode("utf-8", errors="replace")
    except subprocess.CalledProcessError as e:
        out = e.output.decode("utf-8", errors="replace")

    # Strip the psql prefix/suffix (header/footer)
    out = out.strip()
    if not out or "ERROR:" in out and "0x00" in out:
        # Hit a NUL boundary — replace NULs and re-read
        try:
            out = subprocess.check_output(
                ["psql", "-U", "postgres", "-h", "/var/run/postgresql",
                 "-d", "xyzo", "-t", "-A", "-c",
                 f"SELECT replace(pg_read_file('/var/log/postgresql/postgresql-15-main.log', {OFFSET}, {CHUNK}), E'\\\\000', ' ');"],
                stderr=subprocess.STDOUT,
            ).decode("utf-8", errors="replace")
        except subprocess.CalledProcessError as e:
            out = e.output.decode("utf-8", errors="replace")
        out = out.strip()

    if not out or out.startswith("ERROR"):
        break
    all_chunks.append(out)
    if len(out) < CHUNK * 0.95:
        break
    OFFSET += CHUNK
    if OFFSET > 15_000_000:
        break

text = "\n".join(all_chunks)
lines = text.split("\n")
print(f"Read {len(all_chunks)} chunks, {len(text)} chars, {len(lines)} lines")

errors_by_minute = Counter()
errors_by_signature = Counter()
errors_by_statement_type = Counter()
fatal = 0
warning = 0
info_lines = 0
total = 0

for line in lines:
    line = line.strip()
    if not line:
        continue
    total += 1

    # Postgres log lines look like:
    #   2026-09-06 00:01:07.236 PDT [715907] xyzo_app@xyzo ERROR:  ...
    if "ERROR:" in line:
        # Extract signature
        m = re.search(r'ERROR:\s+(.+?)(?:\s+at character\s+\d+|\s+\[".*?"\]|$)', line)
        if m:
            sig = m.group(1)[:120]
            errors_by_signature[sig] += 1
        # Look at table/relation mention
        rel_m = re.search(r'(news_\w+|pins|events|sources|cities\w*|locations\w*)', line)
        if rel_m:
            errors_by_statement_type[rel_m.group(1)] += 1
        ts_m = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', line)
        if ts_m:
            errors_by_minute[ts_m.group(1)] += 1
    elif "FATAL:" in line:
        fatal += 1
    elif "WARNING:" in line:
        warning += 1
    elif "LOG:" in line or "INFO:" in line:
        info_lines += 1

print(f"\nTotal log lines parsed: {total}")
print(f"ERROR: {sum(errors_by_signature.values())}")
print(f"FATAL: {fatal}")
print(f"WARNING: {warning}")
print(f"INFO/LOG: {info_lines}")

print(f"\nTop 20 ERROR signatures:")
for sig, count in errors_by_signature.most_common(20):
    print(f"  {count:5d}  {sig}")

print(f"\nTop relations mentioned in errors:")
for rel, count in errors_by_statement_type.most_common(15):
    print(f"  {count:5d}  {rel}")

print(f"\nError minutes (top 20):")
for minute, count in sorted(errors_by_minute.items(), reverse=True)[:20]:
    print(f"  {minute}  {count}")
