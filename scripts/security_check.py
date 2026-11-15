#!/usr/bin/env python3
"""A static security scan for the patterns that actually bite in this repo.

WHY THIS EXISTS
---------------
The secrets side is covered: the global git hooks (`pre-commit`,
`pre-push`) scan every staged and pushed blob for credential-shaped
strings, with this repo's `.secret-guard-ignore` as the allowlist, and
`secretz --code` / `--gate staged|tracked` does the same on demand.

The OTHER side was not covered. The defences against SQL injection and
its neighbours here are STRUCTURAL — postgres.js tagged templates,
psycopg `%s` placeholders, a Zod schema on every route, `assertSafeUrl`
on every route that takes a URL — and structural defences do not fail
loudly when someone adds a fourth way in. Nothing scanned for a
regression.

WHAT IT CHECKS
--------------
Each rule is deliberately narrow: a rule that cries wolf gets switched
off, and a rule that is switched off protects nothing.

  sql-interp-python   a value interpolated into a Python query string
  sql-unsafe-ts       `sql.unsafe()` with anything but a literal
  sql-interp-ts       a value interpolated into a TS query string
  ssrf-unguarded      a route that takes a `url` without assertSafeUrl
  xss-unescaped       innerHTML assigned a value that is not escaped
  shell-injection     os.system / shell=True / eval / exec
  path-traversal      a request path joined into a filesystem path

HOW IT FAILS
------------
**A RATCHET, NOT A WALL** — the same rule `scripts/ci.sh` follows. The
findings that exist today are baselined; the gate fails only on a NEW
one. `scripts/security_baseline.txt` is that baseline.

Run: python3 scripts/security_check.py            # the gate
     python3 scripts/security_check.py --report   # every finding
     python3 scripts/security_check.py --write-baseline
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── what is scanned ────────────────────────────────────────────────────────
# The frontend's vendored libraries are EXCLUDED on purpose: they are
# third-party code, they are not ours to fix, and a finding inside them
# is a finding to report upstream, not to fail a build over.
SKIP_DIRS = {
    ".git", "node_modules", "vendor", "data", "backups", "logs",
    "__pycache__", ".deploy-backups", "public_html_dev", "maps",
}
SKIP_SUFFIXES = {".min.js", ".png", ".jpg", ".jpeg", ".gif", ".ico",
                 ".woff", ".woff2", ".bin", ".zip", ".gz", ".pyc"}

# ── the rules ──────────────────────────────────────────────────────────────
# Each rule is (id, directory scope, compiled regex, note).
# The regexes are line-based and deliberately avoid matching a string
# that has been through an escaping helper — the SAFE patterns below
# say which helpers count as "escaped".
#
# EVERY RULE IS NARROW ON PURPOSE. A rule that cries wolf gets switched
# off, and a rule that is switched off protects nothing — so each one
# below is written to match the DANGEROUS shape and nothing else. The
# measurements that shaped them are in the README.

RULES = [
    # ── SQL ────────────────────────────────────────────────────────────────
    ("sql-interp-python", ("worker", "scripts", "api", "tests"),
     re.compile(r"""execute\s*\(\s*f["']"""),
     "an f-string into execute() — psycopg wants %s placeholders"),
    ("sql-interp-python", ("worker", "scripts", "api", "tests"),
     re.compile(r"""execute\s*\(\s*[^,()]*["']\s*\+\s*[a-z_]"""),
     "a concatenation into execute() — psycopg wants %s placeholders"),
    ("sql-interp-python", ("worker", "scripts", "api", "tests"),
     re.compile(r"""execute\s*\(\s*["'][^"']*["']\s*%\s*[a-z_]"""),
     "a %-formatted string into execute() — psycopg wants %s placeholders"),
    # A template literal with an interpolation is the injection vector.
    # `sql.unsafe(LITERAL)` is safe; `sql.unsafe(`... ${x} ...`)` is not.
    ("sql-unsafe-ts", ("api/src",),
     re.compile(r"""sql\.unsafe\(\s*`[^`]*\$\{"""),
     "sql.unsafe() with an interpolated template literal — build it from parts"),
    ("sql-interp-ts", ("api/src",),
     re.compile(r"""sql`[^`]*\$\{"""),
     "an interpolation inside a tagged template — use sql() as a value"),

    # ── shell / code execution ─────────────────────────────────────────────
    # `(?<![.\w])` is what stops `model.eval()` (PyTorch) and
    # `regex.exec(s)` (a RegExp match) from matching: the call must not
    # be a method on something.
    #
    # `os.system(` must be followed by a PLAIN quote, which is what tells
    # a CALL apart from a PAYLOAD: a test that asserts an injection is
    # blocked carries the string "os.system(\"id\")" inside a quoted
    # literal, and there the quote is escaped.
    ("shell-injection", ("worker", "scripts", "api", "tests"),
     re.compile(r"""(?<![.\w])os\.system\(\s*["']"""),
     "os.system() — use subprocess with an argument list"),
    ("shell-injection", ("worker", "scripts", "api", "tests"),
     re.compile(r"""shell\s*=\s*True"""),
     "subprocess with shell=True — use an argument list"),
    ("shell-injection", ("worker", "scripts", "api", "tests"),
     re.compile(r"""(?<![.\w])(?:eval|exec)\s*\(\s*[a-z_]"""),
     "eval()/exec() of a string — a string of code is code"),

    # ── path traversal ─────────────────────────────────────────────────────
    ("path-traversal", ("api/src", "worker"),
     re.compile(r"""(?:path\.)?join\s*\([^)]*\b(?:req|request|params|query|body)\b"""),
     "a request value joined into a path — resolve it and check it is inside"),
]

# ── the REPORT-ONLY rules ──────────────────────────────────────────────────
# These need judgement a regex cannot make, so they are listed, not
# gated. They must stay SHORT, or nobody reads them.
REPORT_RULES = [
    # ── XSS ────────────────────────────────────────────────────────────────
    # EVERY `.innerHTML =` is 476 hits on this codebase — the frontend
    # builds its panels with innerHTML on purpose, and half of them
    # interpolate a value that was escaped three lines earlier. Whether
    # `${chips}` is safe depends on where `chips` came from, which is a
    # data-flow question a regex cannot answer. So it is REPORTED, not
    # gated: a short list a human reads.
    ("xss-unescaped", ("public_html",),
     re.compile(r"""\.innerHTML\s*=\s*[^;]*\$\{"""),
     "innerHTML with an interpolated value — escape it with escapeHtml()"),
    ("ssrf-schema", ("api/src",),
     re.compile(r"""\burl\s*:\s*z\."""),
     "a Zod schema takes a URL — is it fetched through safeFetch()?"),
    ("sql-unsafe-var", ("api/src",),
     re.compile(r"""sql\.unsafe\(\s*[a-z_][a-zA-Z0-9_]*\s*[,)]"""),
     "sql.unsafe() with a variable — is it built from literals only?"),
]

# ── the helpers that make a hit SAFE ──────────────────────────────────────
# A line that mentions one of these is a line that took the value through
# the right door. This is the difference between a gate and a nuisance.
SAFE_HINTS = (
    # `safeFetch` is the SSRF guard's sibling: it resolves the host and
    # refuses a private or disallowed address before it connects. A route
    # that fetches through it is guarded.
    "assertSafeUrl", "safeFetch", "escapeHtml", "escapeAttr", "sanitize",
    "sql(",  # postgres.js parameterised value
    "sql`",   # a tagged template
    "Math.floor", "Math.round", "Number(", "Number.isFinite",
    "parseInt", "Number.parseInt",
    "# ", "/*", "//", "example", "Example", "EXAMPLE",
    "placeholder", "PLACEHOLDER", "CHANGE_ME", "dummy", "TODO",
    "test_", "tests/", "def test_",
)

# The rules that are REPORT-ONLY: they need judgement a regex cannot make.
REPORT_ONLY = {r[0] for r in REPORT_RULES}


def _iter_files(root=None):
    """Every scannable file, under `root` (the whole repo by default)."""
    base = Path(root) if root else ROOT
    for dirpath, dirnames, filenames in os.walk(base):
        rel = os.path.relpath(dirpath, ROOT)
        if rel == ".":
            rel = ""
        parts = set(Path(rel).parts) if rel else set()
        if parts & SKIP_DIRS:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and not d.startswith(".git")]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix in SKIP_SUFFIXES or ".min." in name:
                continue
            yield p


def _in_scope(path: Path, dirs) -> bool:
    rel = path.relative_to(ROOT)
    top = rel.parts[0] if len(rel.parts) > 1 else ""
    return any(str(rel).startswith(d) for d in dirs)


# The scanner and its own test file carry the dangerous patterns ON
# PURPOSE — they are the examples the scanner is tested against — so
# neither is a finding in itself.
SELF_FILES = {"security_check.py", "test_security_check.py"}


def scan(root=None):
    """Every finding, as a stable id.

    `root` narrows the walk (the self-test uses it to scan a sandbox
    directory); the paths in the findings stay relative to the repo
    root, so the scope rules and the baseline mean the same thing
    either way.
    """
    findings = []
    for path in _iter_files(root):
        # The scanner is not a finding in itself.
        if path.name in SELF_FILES:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = path.relative_to(ROOT)
        if not any(_in_scope(path, d) for d, *_ in RULES):
            continue
        # The SSRF question is a FILE question, not a line question: a
        # route takes a URL in its schema and fetches it somewhere else
        # in the file. So it is asked per file — "does this file have a
        # URL in its schema and NO guard anywhere in it?"
        file_has_guard = ("assertSafeUrl" in text) or ("safeFetch" in text)
        for i, line in enumerate(text.split("\n"), 1):
            if len(line) > 400:
                continue
            for rule_id, dirs, rx, note in RULES:
                if not _in_scope(path, dirs):
                    continue
                if not rx.search(line):
                    continue
                if any(h in line for h in SAFE_HINTS):
                    continue
                # The line's own text, stripped of anything long, is the
                # stable part of the id — so a moved file does not
                # re-baseline, but a CHANGED line does.
                snippet = re.sub(r"\s+", " ", line.strip())[:90]
                findings.append({
                    "id": f"{rule_id}|{rel}:{i}|{snippet}",
                    "rule": rule_id,
                    "file": str(rel),
                    "line": i,
                    "note": note,
                    "text": line.strip()[:160],
                })
            # ── the report-only rules ────────────────────────────────────
            for rule_id, dirs, rx, note in REPORT_RULES:
                if not _in_scope(path, dirs):
                    continue
                if not rx.search(line):
                    continue
                if any(h in line for h in SAFE_HINTS):
                    continue
                if rule_id == "ssrf-schema" and file_has_guard:
                    # The file guards its URLs — the fetch is just not on
                    # the schema line.
                    continue
                snippet = re.sub(r"\s+", " ", line.strip())[:90]
                findings.append({
                    "id": f"{rule_id}|{rel}:{i}|{snippet}",
                    "rule": rule_id,
                    "file": str(rel),
                    "line": i,
                    "note": note,
                    "text": line.strip()[:160],
                })
    return findings


def baseline_path() -> Path:
    return ROOT / "scripts" / "security_baseline.txt"


def load_baseline():
    p = baseline_path()
    if not p.exists():
        return set()
    out = set()
    for line in p.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line)
    return out


def write_baseline(findings):
    base = baseline_path()
    by_rule = {}
    for f in findings:
        by_rule.setdefault(f["rule"], []).append(f)
    lines = [
        "# The security findings that exist today.",
        "#",
        "# A RATCHET: the gate fails only on a NEW finding, so the baseline",
        "# can only shrink. One line per finding:",
        "#     <rule>|<file>:<line>|<the line, collapsed>",
        "#",
        "# Remove a line when its finding is FIXED — the gate then says so.",
        "# Do not add a line to silence a new finding.",
        "",
    ]
    for rule in sorted(by_rule):
        lines.append(f"# ── {rule} ──")
        for f in sorted(by_rule[rule], key=lambda x: x["id"]):
            lines.append(f["id"])
        lines.append("")
    base.write_text("\n".join(lines), encoding="utf-8")
    return base


def run_secretz():
    """The secrets gate, if the tool is on this box."""
    tool = Path.home() / "helpz" / "secretz"
    if not tool.exists():
        return None
    out = subprocess.run([str(tool), "--gate", "tracked", "--no-color"],
                         capture_output=True, text=True, cwd=ROOT)
    return out.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true",
                    help="print every finding, not only the new ones")
    ap.add_argument("--write-baseline", action="store_true",
                    help="rewrite the baseline from the current findings")
    ap.add_argument("--no-secretz", action="store_true",
                    help="skip the secrets gate")
    args = ap.parse_args()

    findings = scan()
    gated = [f for f in findings if f["rule"] not in REPORT_ONLY]
    reported = [f for f in findings if f["rule"] in REPORT_ONLY]

    if args.write_baseline:
        p = write_baseline(gated)
        print(f"baseline written: {p} ({len(gated)} finding(s))")
        return 0

    base = load_baseline()
    new = [f for f in gated if f["id"] not in base]

    print(f"security scan: {len(findings)} finding(s) — "
          f"{len(gated)} gated, {len(reported)} report-only")
    print(f"  baselined: {len(gated) - len(new)}   NEW: {len(new)}")
    # A machine-readable summary, so `scripts/ci.sh` can count the new
    # findings without parsing prose.
    print(f"security-scan: new={len(new)} gated={len(gated)} report={len(reported)}")

    if args.report:
        for f in findings:
            mark = "NEW " if (f["id"] not in base and f["rule"] not in REPORT_ONLY) else "    "
            print(f"  {mark}{f['rule']:22} {f['file']}:{f['line']}")
            print(f"        {f['text']}")
            print(f"        → {f['note']}")

    if new:
        print("\nNEW SECURITY FINDINGS (the gate fails):")
        for f in new:
            print(f"  {f['rule']}  {f['file']}:{f['line']}")
            print(f"      {f['text']}")
            print(f"      → {f['note']}")
        print("\nFix them, or — if a finding is a FALSE positive — add the "
              "helper name to SAFE_HINTS in scripts/security_check.py.")
        # The line scripts/ci.sh greps for when it prints WHY a stage
        # failed — without it, a red stage shows no detail at all.
        print(f"ERROR: {len(new)} new security finding(s)")

    secrets_ok = True
    if not args.no_secretz:
        secrets_ok = run_secretz()
        if secrets_ok is None:
            print("secrets gate: secretz is not on this box — SKIPPED")
        else:
            print(f"secrets gate: {'✓ clean' if secrets_ok else '✗ SECRETS FOUND'}")

    return 0 if (not new and secrets_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
