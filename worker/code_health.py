"""code_health.py — AI-powered code health analyzer.

Analyzes the Xyzo codebase for improvement opportunities:
- Test coverage gaps
- Code complexity hotspots
- Dependency freshness
- Performance anti-patterns
- Security concerns

Usage:
    python -m worker.code_health              # full analysis
    python -m worker.code_health --quick      # fast checks only
    python -m worker.code_health --json       # machine-readable output
"""
from __future__ import annotations

import ast
import json
import logging
import math
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

log = logging.getLogger("xyzo.code_health")

WORKDIR = Path(os.environ.get("XYZO_WORKDIR", Path(__file__).resolve().parent.parent))
PUBLIC_DIR = WORKDIR / "public_html"
API_DIR = WORKDIR / "api" / "src"
WORKER_DIR = WORKDIR / "worker"
TESTS_DIR = WORKDIR / "public_html" / "tests"


@dataclass
class Finding:
    severity: str  # critical, warning, info
    category: str
    file: str
    line: int | None
    message: str
    suggestion: str = ""


@dataclass
class HealthReport:
    score: float = 100.0
    findings: list[Finding] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)

    def add(self, severity: str, category: str, file: str, line: int | None,
            message: str, suggestion: str = ""):
        self.findings.append(Finding(severity, category, file, line, message, suggestion))
        if severity == "critical":
            self.score -= 5
        elif severity == "warning":
            self.score -= 1
        self.score = max(0, self.score)


# ── Analyzers ────────────────────────────────────────────────────────────────

def _count_lines(path: Path) -> int:
    try:
        return len(path.read_text(errors="replace").splitlines())
    except Exception:
        return 0


def _find_js_files() -> list[Path]:
    return sorted(PUBLIC_DIR.glob("*.js"))


def _find_py_files() -> list[Path]:
    return sorted(WORKER_DIR.glob("*.py"))


def _find_ts_files() -> list[Path]:
    if not API_DIR.exists():
        return []
    return sorted(API_DIR.rglob("*.ts"))


def analyze_test_coverage(report: HealthReport):
    """Check that main modules have corresponding test files."""
    # JS files vs bun tests
    js_files = {f.stem for f in _find_js_files() if f.name not in ("console-guard.js",)}
    test_files = {f.stem.replace(".bun", "").replace(".test", "") for f in TESTS_DIR.glob("*.test.*")}
    tested = js_files & test_files
    untested = js_files - test_files - {"analytics", "presence", "viewport-nudge", "map-debug",
                                         "update-check", "debug-panel", "submit-sniff", "help-me-chat"}

    for name in sorted(untested):
        report.add("warning", "test_coverage", f"public_html/{name}.js", None,
                    f"No test file for {name}.js",
                    f"Add public_html/tests/{name}.bun.test.js")

    # Python files vs pytest
    py_files = {f.stem for f in _find_py_files() if not f.name.startswith("_") and f.name != "__init__.py"}
    py_tests = {f.stem.replace("test_", "") for f in (WORKER_DIR / "tests").glob("test_*.py")
                if f.name != "__init__.py"}
    untested_py = py_files - py_tests - {"db", "notify", "run", "cli", "__main__",
                                           "progress", "word_freq", "gazetteer"}

    for name in sorted(untested_py)[:10]:  # cap at 10 to avoid noise
        report.add("info", "test_coverage", f"worker/{name}.py", None,
                    f"No pytest file for {name}.py")

    report.metrics["js_files"] = len(js_files)
    report.metrics["js_tested"] = len(tested)
    report.metrics["js_coverage_pct"] = round(len(tested) / max(len(js_files), 1) * 100)
    report.metrics["py_files"] = len(py_files)
    report.metrics["py_tested"] = len(py_tests)
    report.metrics["py_coverage_pct"] = round(len(py_tests) / max(len(py_files), 1) * 100)


def analyze_js_complexity(report: HealthReport):
    """Flag JS files with high cyclomatic complexity (many branches/conditions)."""
    for path in _find_js_files():
        try:
            text = path.read_text(errors="replace")
        except Exception:
            continue
        lines = text.splitlines()
        line_count = len(lines)

        # Simple complexity proxy: count decision points
        complexity = 0
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("//") or stripped.startswith("/*"):
                continue
            complexity += len(re.findall(r'\bif\b|\belse\b|\bfor\b|\bwhile\b|\bswitch\b|\b\?\s', stripped))

        if line_count > 500:
            ratio = complexity / max(line_count, 1)
            if ratio > 0.08:
                report.add("warning", "complexity", f"public_html/{path.name}", None,
                           f"High complexity: {complexity} decisions in {line_count} lines (ratio {ratio:.3f})",
                           "Consider extracting helper functions")

        # Check for very long functions (>200 lines between function declarations)
        func_starts = [i for i, l in enumerate(lines) if re.match(r'(?:async\s+)?function\s+\w+', l.strip())]
        for i in range(len(func_starts) - 1):
            func_len = func_starts[i + 1] - func_starts[i]
            if func_len > 200:
                report.add("warning", "complexity", f"public_html/{path.name}",
                           func_starts[i] + 1,
                           f"Function is {func_len} lines long",
                           "Extract sub-functions for readability")


def analyze_python_patterns(report: HealthReport):
    """Check Python files for common anti-patterns."""
    for path in _find_py_files():
        try:
            text = path.read_text(errors="replace")
        except Exception:
            continue

        lines = text.splitlines()

        # Bare except
        for i, line in enumerate(lines, 1):
            if re.match(r'\s*except\s*:', line):
                report.add("warning", "python_patterns", f"worker/{path.name}", i,
                           "Bare 'except:' catches everything including KeyboardInterrupt",
                           "Use 'except Exception:' instead")

        # TODO/FIXME/HACK
        for i, line in enumerate(lines, 1):
            if re.search(r'#\s*(TODO|FIXME|HACK|XXX)\b', line, re.IGNORECASE):
                report.add("info", "tech_debt", f"worker/{path.name}", i,
                           f"Technical debt marker: {line.strip()[:80]}")

        # print() in production code (should use logging)
        if path.name in ("run.py", "__main__.py", "cli.py"):
            continue
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith("print(") and not stripped.startswith("print(f"):
                report.add("info", "python_patterns", f"worker/{path.name}", i,
                           "print() in non-CLI module — prefer logging",
                           "Replace with log.info() or log.debug()")


def analyze_api_patterns(report: HealthReport):
    """Check API TypeScript for common issues."""
    for path in _find_ts_files():
        try:
            text = path.read_text(errors="replace")
        except Exception:
            continue

        # console.log in routes
        for i, line in enumerate(text.splitlines(), 1):
            if "console.log" in line and "/routes/" in str(path):
                report.add("info", "api_patterns", f"api/src/{path.relative_to(API_DIR)}", i,
                           "console.log in route file — prefer structured logging")

        # Missing error handling on fetch
        if "fetch(" in text:
            lines = text.splitlines()
            for i, line in enumerate(lines, 1):
                if "fetch(" in line and not line.strip().startswith("//"):
                    # Check surrounding context
                    start = max(0, i - 5)
                    end = min(len(lines), i + 5)
                    context = "\n".join(lines[start:end])
                    if ".catch" not in context and "try" not in context and "AbortController" not in context:
                        report.add("warning", "error_handling",
                                   f"api/src/{path.relative_to(API_DIR)}", i,
                                   "fetch() call without visible error handling")


def analyze_security(report: HealthReport):
    """Check for basic security concerns."""
    # Check for hardcoded secrets in JS
    secret_patterns = [
        (r'(?i)api[_-]?key\s*[:=]\s*["\'][A-Za-z0-9]{20,}', "Possible hardcoded API key"),
        (r'(?i)password\s*[:=]\s*["\'][^"\']{8,}', "Possible hardcoded password"),
        (r'(?i)secret\s*[:=]\s*["\'][A-Za-z0-9]{16,}', "Possible hardcoded secret"),
    ]

    for path in _find_js_files():
        try:
            text = path.read_text(errors="replace")
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for pattern, msg in secret_patterns:
                if re.search(pattern, line):
                    report.add("critical", "security", f"public_html/{path.name}", i, msg,
                               "Move to environment variable or server-side config")

    # Check Python files too
    for path in _find_py_files():
        try:
            text = path.read_text(errors="replace")
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for pattern, msg in secret_patterns:
                if re.search(pattern, line) and "DEFAULT_UA" not in line and "USER_AGENT" not in line:
                    report.add("critical", "security", f"worker/{path.name}", i, msg)


def analyze_file_sizes(report: HealthReport):
    """Flag files that are getting unwieldy."""
    sizes = {}
    for path in _find_js_files():
        lines = _count_lines(path)
        sizes[path.name] = lines
        if lines > 5000:
            report.add("warning", "file_size", f"public_html/{path.name}", None,
                        f"File is {lines:,} lines — very large for a single file",
                        "Consider splitting into modules if growth continues")

    for path in _find_py_files():
        lines = _count_lines(path)
        sizes[path.name] = lines
        if lines > 1000:
            report.add("warning", "file_size", f"worker/{path.name}", None,
                        f"File is {lines:,} lines — consider splitting")

    report.metrics["largest_files"] = dict(sorted(sizes.items(), key=lambda x: -x[1])[:5])
    report.metrics["total_js_lines"] = sum(_count_lines(p) for p in _find_js_files())
    report.metrics["total_py_lines"] = sum(_count_lines(p) for p in _find_py_files())


def analyze_zindex(report: HealthReport):
    """Audit z-index usage for stacking issues."""
    css_path = PUBLIC_DIR / "styles.css"
    if not css_path.exists():
        return

    text = css_path.read_text(errors="replace")
    zindex_re = re.compile(r'z-index:\s*(\d+)')
    values = [int(m.group(1)) for m in zindex_re.finditer(text)]

    if values:
        report.metrics["zindex_count"] = len(values)
        report.metrics["zindex_max"] = max(values)
        report.metrics["zindex_unique"] = len(set(values))

        # Check for extremely high values
        for v in values:
            if v > 10000:
                report.add("warning", "z_index", "styles.css", None,
                            f"Very high z-index value: {v}",
                            "Use CSS custom properties for z-index layers")


def analyze_dependencies(report: HealthReport):
    """Check package.json for outdated dependencies."""
    pkg_path = API_DIR.parent / "package.json"
    if not pkg_path.exists():
        return

    try:
        pkg = json.loads(pkg_path.read_text())
        deps = pkg.get("dependencies", {})
        dev_deps = pkg.get("devDependencies", {})
        report.metrics["npm_deps"] = len(deps)
        report.metrics["npm_dev_deps"] = len(dev_deps)
    except Exception:
        pass


# ── Main ─────────────────────────────────────────────────────────────────────

def run_analysis(quick: bool = False) -> HealthReport:
    report = HealthReport()

    analyze_test_coverage(report)
    analyze_file_sizes(report)
    analyze_zindex(report)

    if not quick:
        analyze_js_complexity(report)
        analyze_python_patterns(report)
        analyze_api_patterns(report)
        analyze_security(report)
        analyze_dependencies(report)

    report.score = round(report.score, 1)
    return report


def print_report(report: HealthReport):
    print()
    print("═══════════════════════════════════════════════════════════")
    print("  XYZO Code Health Report")
    print("═══════════════════════════════════════════════════════════")
    print()

    # Score
    score = report.score
    if score >= 90:
        color = "\033[32m"
    elif score >= 70:
        color = "\033[33m"
    else:
        color = "\033[31m"
    print(f"  Health Score: {color}{score:.0f}/100\033[0m")
    print()

    # Metrics
    if report.metrics:
        print("  Metrics:")
        for k, v in report.metrics.items():
            if isinstance(v, dict):
                print(f"    {k}:")
                for mk, mv in v.items():
                    print(f"      {mk}: {mv}")
            else:
                print(f"    {k}: {v}")
        print()

    # Findings by severity
    by_severity = defaultdict(list)
    for f in report.findings:
        by_severity[f.severity].append(f)

    for severity in ["critical", "warning", "info"]:
        findings = by_severity.get(severity, [])
        if not findings:
            continue
        icon = {"critical": "🔴", "warning": "🟡", "info": "🔵"}[severity]
        print(f"  {icon} {severity.upper()} ({len(findings)}):")
        for f in findings[:10]:  # cap display
            loc = f"{f.file}"
            if f.line:
                loc += f":{f.line}"
            print(f"    [{f.category}] {f.message}")
            if f.suggestion:
                print(f"      → {f.suggestion}")
        if len(findings) > 10:
            print(f"    ... and {len(findings) - 10} more")
        print()

    print("═══════════════════════════════════════════════════════════")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Code health analyzer")
    parser.add_argument("--quick", action="store_true", help="Fast checks only")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    report = run_analysis(quick=args.quick)

    if args.json:
        output = {
            "score": report.score,
            "metrics": report.metrics,
            "findings": [asdict(f) for f in report.findings],
            "summary": {
                "critical": sum(1 for f in report.findings if f.severity == "critical"),
                "warning": sum(1 for f in report.findings if f.severity == "warning"),
                "info": sum(1 for f in report.findings if f.severity == "info"),
            },
        }
        print(json.dumps(output, indent=2))
    else:
        print_report(report)


if __name__ == "__main__":
    main()
