#!/usr/bin/env python3
"""
Test failure classifier for XYZO.

Parses raw test output from pytest/bun test and classifies each failure as:

  REAL_BUG       — Code is wrong; must be fixed
  SCHEMA_DRIFT   — Column/table/type changed; test fixture needs updating
  FLAKY         — Race condition or timing issue; may pass on retry
  SETUP_ERROR   — beforeEach timeout, missing DB, bad env
  UNCLASSIFIED  — Needs manual investigation

Each classification includes:
  - What happened (short summary)
  - Why it's that type (explanation)
  - What to do about it (actionable next step)

Usage:
  python3 tests/classify_failures.py              # classify all test output
  python3 tests/classify_failures.py --watch     # run tests and classify continuously
  python3 tests/classify_failures.py < /path/to/output.txt   # classify saved output
"""
from __future__ import annotations

import re
import subprocess
import sys
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class FailureType(Enum):
    REAL_BUG = "REAL_BUG"
    SCHEMA_DRIFT = "SCHEMA_DRIFT"
    FLAKY = "FLAKY"
    SETUP_ERROR = "SETUP_ERROR"
    UNCLASSIFIED = "UNCLASSIFIED"
    TIMEOUT = "TIMEOUT"
    NETWORK = "NETWORK"
    OK = "OK"


@dataclass
class Failure:
    test_name: str
    type: FailureType
    summary: str
    detail: str
    action: str
    raw_lines: list[str] = field(default_factory=list)


# ── Error signature database ──────────────────────────────────────────────────

# (regex_pattern, failure_type, summary_template, action_template)
ERROR_SIGNATURES: list[tuple[str, FailureType, str, str]] = [
    # ── PostgreSQL schema errors ───────────────────────────────────────────────
    (
        r"UndefinedColumn|column [\"'](\w+)[\"'] does not exist",
        FailureType.SCHEMA_DRIFT,
        "Column '{col}' does not exist — schema drift or missing migration",
        "Verify column exists: SELECT column_name FROM information_schema.columns WHERE table_name = '{table}'",
        "Run migrations or update test fixture to match new schema",
    ),
    (
        r"UndefinedTable|relation [\"'](\w+)[\"'] does not exist",
        FailureType.SCHEMA_DRIFT,
        "Table '{table}' does not exist — missing migration or wrong schema",
        "Check migrations/ and run pending migrations",
        "Run: alembic upgrade head  OR  manually create missing table",
    ),
    (
        r"duplicate key|unique constraint|violates unique",
        FailureType.FLAKY,
        "Duplicate key violation — test cleanup incomplete or race condition",
        "Check if test's beforeEach cleanup ran; may indicate flaky test isolation",
        "Verify truncateAll() runs in beforeEach; retry to confirm",
    ),
    (
        r"foreign key constraint|violates foreign-key",
        FailureType.SETUP_ERROR,
        "Foreign key violation — test data has dangling references",
        "Test created orphaned child record; cleanup order wrong",
        "Ensure truncate uses CASCADE or delete children before parents",
    ),
    (
        r"_datatype_mismatch|DatatypeMismatch|type mismatch",
        FailureType.SCHEMA_DRIFT,
        "SQL type mismatch — column type changed since test was written",
        "Check the column type in news_articles/news_locations schema",
    ),
    (
        r"invalid input syntax for (type \w+)|cannot cast",
        FailureType.SCHEMA_DRIFT,
        "Type cast error — column type changed or test uses wrong type",
        "Check the actual column type vs what test expects",
    ),
    # ── Timeouts ──────────────────────────────────────────────────────────────
    (
        r"(?i)(timeout|timed? out|took more than|exceeded)",
        FailureType.TIMEOUT,
        "Test timed out — query is too slow or DB is overloaded",
        "Profile the query with EXPLAIN ANALYZE; check DB connection pool",
    ),
    (
        r"beforeEach.*timed? out|afterEach.*timed? out",
        FailureType.SETUP_ERROR,
        "beforeEach/afterEach hook timed out — DB setup is too slow",
        "beforeEach timed out after 5000ms; check DB connection or truncate speed",
    ),
    # ── SQL syntax errors (real bugs) ─────────────────────────────────────────
    (
        r"syntax error at or near ['\"]?(\w+)['\"]?",
        FailureType.REAL_BUG,
        "SQL syntax error at '{kw}' — malformed query",
        "Check the SQL query in the route handler; likely a missing comma or extra alias",
    ),
    (
        r"SQL error|QueryFailedError|postgres error",
        FailureType.REAL_BUG,
        "SQL query failed — check the error detail above",
        "Look at the PostgresError message above for the exact position/type",
    ),
    # ── Network / external services ─────────────────────────────────────────
    (
        r"(?i)(connection refused|ECONNREFUSED|connection timed out|ETIMEDOUT|network)",
        FailureType.NETWORK,
        "Network error — DB connection or external service unreachable",
        "Check DB is running, network is up, and DNS resolves",
    ),
    (
        r"(?i)(rate.limit|too many requests|429)",
        FailureType.FLAKY,
        "Rate limited — external API or DB rate limit hit",
        "May be environmental; retry or add rate-limit delay",
    ),
    (
        r"(?i)(dns|DNS|ENOTFOUND|EAI_AGAIN)",
        FailureType.NETWORK,
        "DNS resolution failure — external service unreachable",
        "Check network connectivity and DNS configuration",
    ),
    # ── Python-specific errors ─────────────────────────────────────────────────
    (
        r"AssertionError",
        FailureType.UNCLASSIFIED,
        "Assertion failed — assertion in test didn't match reality",
        "Read the assertion diff to understand what didn't match",
    ),
    (
        r"ImportError|ModuleNotFoundError|cannot import",
        FailureType.SETUP_ERROR,
        "Import failed — module missing or path wrong",
        "Check PYTHONPATH, virtualenv, and that the module is installed",
    ),
    (
        r"psycopg|postgresql.*error|db.*error",
        FailureType.REAL_BUG,
        "Database error — check the specific PostgreSQL error above",
        "Look for the PostgresError with code and detail",
    ),
    # ── Bun/JS-specific ──────────────────────────────────────────────────────
    (
        r"(?i)(bun test|ReferenceError|TypeError): (\w+) is not defined",
        FailureType.SETUP_ERROR,
        "Variable not defined in JS — missing import or scope issue",
        "Check that the required module/variable is imported before use",
    ),
    (
        r"(?i)(heap out of memory|memory limit)",
        FailureType.SETUP_ERROR,
        "Out of memory — test suite needs too much RAM",
        "Reduce test parallelism or increase memory limit",
    ),
    # ── Catch-all ─────────────────────────────────────────────────────────────
    (
        r"(?i)(error|exception|failed|FAIL)",
        FailureType.UNCLASSIFIED,
        "Generic error — needs manual investigation",
        "Read the full error output to understand what happened",
    ),
]


def classify_error(lines: list[str], test_name: str = "") -> Failure:
    """Classify a failure based on its error message lines."""
    text = "\n".join(lines)

    for entry in ERROR_SIGNATURES:
        pattern, ftype, summary, *rest = entry
        action = rest[0] if rest else ""
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            groups = m.groups()
            # Fill in template variables
            summary_filled = summary
            action_filled = action
            for g in groups:
                if g:
                    summary_filled = summary_filled.replace("{col}", g).replace("{table}", g).replace("{kw}", g).replace("{g}", g)
                    action_filled = action_filled.replace("{col}", g).replace("{table}", g).replace("{kw}", g).replace("{g}", g)

            # Special case: look for table name in context around the match
            if ftype == FailureType.SCHEMA_DRIFT and "{table}" in summary_filled:
                # Try to extract table name from surrounding context
                table_m = re.search(r"(?:relation|table) [\"']?(\w+)[\"']?", text, re.IGNORECASE)
                if table_m:
                    summary_filled = summary_filled.replace("{table}", table_m.group(1))
                    action_filled = action_filled.replace("{table}", table_m.group(1))

            return Failure(
                test_name=test_name,
                type=ftype,
                summary=summary_filled,
                detail=text[:500],
                action=action_filled,
                raw_lines=lines,
            )

    return Failure(
        test_name=test_name,
        type=FailureType.UNCLASSIFIED,
        summary="Unknown failure — needs manual investigation",
        detail=text[:500],
        action="Read the error output above to understand what happened",
        raw_lines=lines,
    )


def parse_pytest_output(output: str) -> list[Failure]:
    """Parse pytest output and return a list of Failures."""
    failures = []
    # Split on "FAILED" markers
    blocks = re.split(r"^---+\s*$", output, flags=re.MULTILINE)

    for block in blocks:
        if not block.strip():
            continue

        # Extract test name
        test_m = re.search(r"FAILED\s+(.+?)\s+---", block)
        if not test_m:
            test_m = re.search(r"FAILED\s+(.+)$", block, re.MULTILINE)

        test_name = test_m.group(1).strip() if test_m else "unknown"

        # Check if it's actually a pass (error in setup/teardown)
        if "ERROR at setup" in block or "ERROR at teardown" in block:
            ftype = FailureType.SETUP_ERROR
            summary = "Setup/teardown error"
            action = "beforeEach/afterEach failed — check the error above"
        elif "FAILED" not in block and "ERROR" not in block:
            continue  # Not actually a failure
        else:
            f = classify_error(block.strip().split("\n"), test_name)
            f.test_name = test_name
            failures.append(f)

    return failures


def parse_bun_output(output: str) -> list[Failure]:
    """Parse bun test output and return a list of Failures."""
    failures = []
    # bun test separates failures with blank lines
    blocks = re.split(r"\n(?=\(fail\))", output)

    for block in blocks:
        if not block.strip() or "(fail)" not in block:
            continue

        # Extract test name
        test_m = re.search(r"\(fail\)\s+(.+?)\s+\[", block)
        test_name = test_m.group(1).strip() if test_m else "unknown"

        lines = block.strip().split("\n")
        f = classify_error(lines, test_name)
        failures.append(f)

    return failures


def classify_summary(passes: int, failures: list[Failure]) -> dict:
    """Summarize classification results."""
    counts = {ft: 0 for ft in FailureType}
    for f in failures:
        counts[f.type] += 1

    return {
        "total": passes + len(failures),
        "passed": passes,
        "failed": len(failures),
        "by_type": {ft.value: counts[ft] for ft in FailureType if counts[ft] > 0},
        "real_bugs": [f for f in failures if f.type == FailureType.REAL_BUG],
        "schema_drifts": [f for f in failures if f.type == FailureType.SCHEMA_DRIFT],
        "flaky": [f for f in failures if f.type == FailureType.FLAKY],
        "setup_errors": [f for f in failures if f.type == FailureType.SETUP_ERROR],
        "timeouts": [f for f in failures if f.type == FailureType.TIMEOUT],
        "unclassified": [f for f in failures if f.type == FailureType.UNCLASSIFIED],
    }


def print_report(output: str, tool: str):
    """Classify and print a report for the given test output."""
    if tool == "pytest":
        failures = parse_pytest_output(output)
    elif tool == "bun":
        failures = parse_bun_output(output)
    else:
        print(f"Unknown tool: {tool}")
        return

    # Try to extract pass count
    pass_m = re.search(r"(\d+)\s+passed", output)
    passes = int(pass_m.group(1)) if pass_m else 0

    summary = classify_summary(passes, failures)

    print(f"\n{'='*60}")
    print(f" TEST CLASSIFICATION REPORT ({tool})")
    print(f"{'='*60}")
    print(f"\nSummary: {summary['passed']} passed, {summary['failed']} failed "
          f"({summary['failed']}/{summary['total']} = {summary['failed']/max(summary['total'],1)*100:.0f}% failure rate)")

    if summary['failed'] == 0:
        print(f"\n  {'✅ ALL TESTS PASSED — no failures to classify'}")
        return

    # ── Print by category ───────────────────────────────────────────────────
    cats = [
        ("🐛 REAL BUGS — must fix before deploy", summary["real_bugs"], "\033[0;31m"),
        ("🗄️ SCHEMA DRIFTS — migrate or update fixtures", summary["schema_drifts"], "\033[0;33m"),
        ("⏱️  TIMEOUTS — query too slow or DB overloaded", summary["timeouts"], "\033[0;33m"),
        ("⚙️  SETUP ERRORS — env, DB, or hook problem", summary["setup_errors"], "\033[0;33m"),
        ("🔄 FLAKY — race condition or timing", summary["flaky"], "\033[0;36m"),
        ("❓ UNCLASSIFIED — needs manual investigation", summary["unclassified"], "\033[0;35m"),
    ]

    for label, items, color in cats:
        if not items:
            continue
        print(f"\n{color}{label}\033[0m")
        for f in items:
            print(f"\n  Test: {f.test_name}")
            print(f"  What: {f.summary}")
            if f.action:
                print(f"  Fix:  {f.action}")

    # ── Quick triage ────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(" QUICK TRIAGE")
    print(f"{'='*60}")
    rb = len(summary["real_bugs"])
    sd = len(summary["schema_drifts"])
    fl = len(summary["flaky"])
    se = len(summary["setup_errors"])
    to = len(summary["timeouts"])
    uc = len(summary["unclassified"])

    if rb > 0:
        print(f"\n  🛑 {rb} REAL BUGS — code is broken, fix before next deploy")
    if sd > 0:
        print(f"\n  🗄️  {sd} SCHEMA DRIFTS — update test fixtures to match schema")
    if se > 0:
        print(f"\n  ⚙️  {se} SETUP ERRORS — fix environment or DB connection")
    if to > 0:
        print(f"\n  ⏱️  {to} TIMEOUTS — optimize query or increase timeout")
    if fl > 0:
        print(f"\n  🔄 {fl} FLAKY — add retry logic or fix test isolation")
    if uc > 0:
        print(f"\n  ❓ {uc} UNCLASSIFIED — manual investigation needed")

    print()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Classify XYZO test failures")
    parser.add_argument("--tool", choices=["pytest", "bun"], default="pytest",
                        help="Test framework")
    parser.add_argument("--file", help="Read output from file instead of stdin")
    args = parser.parse_args()

    if args.file:
        output = open(args.file).read()
    else:
        output = sys.stdin.read()

    print_report(output, args.tool)
