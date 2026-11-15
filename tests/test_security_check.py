"""The security scanner must be able to FAIL.

A gate that passes against broken code is not a gate — that is the rule
this repo learned the hard way on 2026-11-12 (the first-load test
asserted the SOURCE SHAPE of a bug and the shape matched). So the
scanner is tested against files that deliberately contain each of the
dangerous patterns, and against a file that contains none of them.

The bad files are written into a temporary directory INSIDE the repo
(the scanner walks the repo, so it has to see them), and they are
removed afterwards.

Run: python3 -m pytest tests/test_security_check.py -q
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Load the scanner as a module — it is a script, but its scan() is the
# unit under test.
spec = importlib.util.spec_from_file_location(
    "security_check", ROOT / "scripts" / "security_check.py")
security_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(security_check)


@pytest.fixture
def sandbox():
    """A factory: a directory inside the repo the scanner will walk.

    The directory is chosen by the caller because the RULES ARE SCOPED
    TO A PART OF THE REPO — the TypeScript rules cover `api/src/`, the
    XSS rule covers `public_html/`. A sandbox outside a rule's scope
    would be scanned and ignored, and the test would pass for the wrong
    reason.
    """
    made = []

    def _make(where="api/src"):
        d = ROOT / where / "_security_test_tmp"
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
        made.append(d)
        return d

    yield _make
    for d in made:
        shutil.rmtree(d, ignore_errors=True)


def _scan_repo(root=None):
    return security_check.scan(root)


def _ids(findings, path_suffix):
    return [f for f in findings if f["file"].endswith(path_suffix)]


def test_a_clean_file_produces_nothing(sandbox):
    box = sandbox("public_html")
    (box / "clean.js").write_text(
        "const q = sql`SELECT * FROM t WHERE id = ${id}`;\n"
        "el.innerHTML = escapeHtml(userText);\n"
        "await fetch(url);\n",
        encoding="utf-8")
    (box / "clean.py").write_text(
        "from psycopg import sql\n"
        "cur.execute('SELECT * FROM t WHERE id = %s', (tid,))\n"
        "cur.execute(sql.SQL('SELECT * FROM {}').format(sql.Identifier(t)))\n",
        encoding="utf-8")
    findings = _scan_repo(box)
    assert not _ids(findings, "_security_test_tmp/clean.js"), \
        "a clean file must not produce a finding"
    assert not _ids(findings, "_security_test_tmp/clean.py"), \
        "a clean file must not produce a finding"


def test_an_interpolated_python_query_IS_found(sandbox):
    box = sandbox("api/src")
    (box / "bad.py").write_text(
        "cur.execute(f'SELECT * FROM t WHERE id = {tid}')\n", encoding="utf-8")
    findings = _scan_repo(box)
    hits = _ids(findings, "_security_test_tmp/bad.py")
    assert hits, "an f-string into execute() MUST be found"
    assert any(f["rule"] == "sql-interp-python" for f in hits)


def test_an_unsafe_ts_template_IS_found(sandbox):
    box = sandbox("api/src")
    (box / "bad.js").write_text(
        "const rows = await sql.unsafe(`SELECT * FROM t WHERE x = ${x}`);\n",
        encoding="utf-8")
    findings = _scan_repo(box)
    hits = _ids(findings, "_security_test_tmp/bad.js")
    assert hits, "sql.unsafe() with an interpolation MUST be found"
    assert any(f["rule"] == "sql-unsafe-ts" for f in hits)


def test_a_shell_call_IS_found(sandbox):
    box = sandbox("api/src")
    (box / "bad.py").write_text(
        "os.system('rm -rf ' + path)\n", encoding="utf-8")
    findings = _scan_repo(box)
    hits = _ids(findings, "_security_test_tmp/bad.py")
    assert hits, "os.system() MUST be found"
    assert any(f["rule"] == "shell-injection" for f in hits)


def test_an_unescaped_innerHTML_IS_reported(sandbox):
    # The XSS rule is scoped to public_html/, so the sandbox goes there.
    box = sandbox("public_html")
    (box / "bad.js").write_text(
        "el.innerHTML = `<b>${userText}</b>`;\n", encoding="utf-8")
    findings = _scan_repo(box)
    hits = _ids(findings, "_security_test_tmp/bad.js")
    assert hits, "an interpolated innerHTML MUST be reported"
    assert any(f["rule"] == "xss-unescaped" for f in hits)


def test_a_deliberate_injection_payload_is_NOT_a_shell_finding(sandbox):
    box = sandbox("api/src")
    # A test that asserts an injection is BLOCKED carries the payload on
    # purpose, inside a quoted string. That is not a call, and it must not
    # fail the gate.
    (box / "payload.ts").write_text(
        'name: "x\'; import os; os.system(\\"id\\"); x=\'",\n', encoding="utf-8")
    findings = _scan_repo(box)
    hits = _ids(findings, "_security_test_tmp/payload.ts")
    assert not any(f["rule"] == "shell-injection" for f in hits), \
        "a payload string inside a test is not a shell call"


def test_the_scanner_does_not_flag_itself():
    findings = _scan_repo()
    assert not _ids(findings, "scripts/security_check.py"), \
        "the scanner must not be a finding in itself"


def test_the_baseline_is_a_ratchet_not_a_wall():
    """A finding that IS in the baseline must not fail the gate."""
    findings = _scan_repo()
    gated = [f for f in findings if f["rule"] not in security_check.REPORT_ONLY]
    base = security_check.load_baseline()
    # Everything the baseline lists must be a real finding, and everything
    # that is NOT in the baseline is a NEW one — the two sets partition.
    baselined_ids = {f["id"] for f in gated if f["id"] in base}
    assert baselined_ids <= {f["id"] for f in gated}
    # The baseline file itself must exist and explain itself, so a reader
    # knows it is a ratchet and not a suppression list.
    p = security_check.baseline_path()
    assert p.exists(), "the baseline file must exist"
    text = p.read_text(encoding="utf-8")
    assert "RATCHET" in text.upper()
    assert "Do not add a line to silence a new finding" in text
