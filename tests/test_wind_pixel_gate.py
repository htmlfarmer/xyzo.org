"""The wind pixel gate must FAIL when it cannot measure.

WHY THIS FILE EXISTS
--------------------
`scripts/wind_perf_audit.py::pixel_gate()` was written to stop an
invisible wind being reported as a performance win — the owner shipped
`contain: paint` on the wind pane, measured 51 fps, and the wind was
drawn at **0 pixels on screen**. The gate was supposed to catch that.

**IT SHIPPED BROKEN AND PASSED ANYWAY.** Three defects, each of which
alone defeats it:

  1. `_screen_pixels_for_wind()` interpolated the pane lookup as a
     FUNCTION DEFINITION into `const p = %s;` — so `p` bound the arrow
     function itself (truthy, and a function has no `.style`) and every
     hide/show threw a TypeError. The guard `!!(%s)` evaluated
     `!!(function)` === true, so it did not catch that either.
  2. The exception left `wind_px` as `None`.
  3. `pixel_gate()` read `None` as "not applicable" and SKIPPED it.

Net effect: a gate that had measured **nothing** reported
"wind visible on every run" — on the very run where the wind was
invisible. Measured live: `pixel check FAILED: … p.style is
undefined`, immediately followed by `wind visible on every run`.

This file pins the gate's four distinct outcomes, because the whole
value of the gate is that it cannot pass when it cannot run.
"""
from __future__ import annotations

import importlib.util
import os
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "scripts", "wind_perf_audit.py")


def _load():
    """Load the audit script by path (scripts/ is not a package)."""
    spec = importlib.util.spec_from_file_location("wind_perf_audit", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


AUDIT = _load()


def _report(px, fps=10.0, label="density=100", browser="firefox"):
    """A minimal report shaped like the real one."""
    return {
        "browsers": {
            browser: {
                "runs": [
                    {
                        "label": label,
                        "wind_screen_px": px,
                        "cadence": {"fps": fps},
                    }
                ]
            }
        }
    }


class PixelGateTest(unittest.TestCase):
    def test_visible_wind_passes(self):
        ok, msg = AUDIT.pixel_gate(_report(79794))
        self.assertTrue(ok, msg)
        self.assertIn("visible", msg)

    def test_zero_pixels_fails(self):
        """The original purpose: a renderer that draws nothing."""
        ok, msg = AUDIT.pixel_gate(_report(0))
        self.assertFalse(ok)
        self.assertIn("0 pixels", msg)

    def test_an_errored_check_FAILS_instead_of_passing(self):
        """THE DEFECT THIS FILE EXISTS FOR.

        `None` used to mean both "wind not wanted" and "the check
        threw", and was skipped in both cases — so an exception became
        a pass. The sentinel must be a failure.
        """
        ok, msg = AUDIT.pixel_gate(_report("error"))
        self.assertFalse(ok, "an errored check must not pass")
        self.assertIn("UNVERIFIED", msg)

    def test_a_missing_wind_pane_fails(self):
        """The layer never mounted — the fps belongs to no wind at all."""
        ok, msg = AUDIT.pixel_gate(_report("missing"))
        self.assertFalse(ok)
        self.assertIn("never mounted", msg)

    def test_wind_not_wanted_is_still_skipped(self):
        """`None` now means ONLY "the wind was off for this run".

        The wind-off baseline is a legitimate part of every report, so
        it must not fail the gate — but it must be the ONLY thing None
        can mean.
        """
        ok, msg = AUDIT.pixel_gate(_report(None))
        self.assertTrue(ok, msg)

    def test_a_failure_in_any_browser_fails_the_whole_run(self):
        """The gate is a gate over the WHOLE report, not per browser."""
        rep = {
            "browsers": {
                "firefox": {"runs": [{"label": "a", "wind_screen_px": 79794,
                                      "cadence": {"fps": 50.0}}]},
                "chromium": {"runs": [{"label": "b", "wind_screen_px": 0,
                                       "cadence": {"fps": 51.0}}]},
            }
        }
        ok, msg = AUDIT.pixel_gate(rep)
        self.assertFalse(ok)
        self.assertIn("chromium", msg)

    def test_one_error_among_many_runs_still_fails(self):
        rep = {
            "browsers": {
                "firefox": {
                    "runs": [
                        {"label": "density=100", "wind_screen_px": 5000,
                         "cadence": {"fps": 30.0}},
                        {"label": "density=50", "wind_screen_px": "error",
                         "cadence": {"fps": 40.0}},
                    ]
                }
            }
        }
        ok, msg = AUDIT.pixel_gate(rep)
        self.assertFalse(ok)
        self.assertIn("density=50", msg)


class PaneExpressionTest(unittest.TestCase):
    """The pane lookup must be an EXPRESSION, not a function.

    It is interpolated into `const p = %s;` and into `!!(%s)`. As an
    arrow function both sites silently did the wrong thing: `p` bound
    the function (truthy, no `.style` → TypeError) and `!!(function)`
    was `true` (guard blind). This pins the shape that makes both sites
    work.
    """

    def test_pane_source_is_not_a_function_definition(self):
        # Recover the pane expression from the module source, since the
        # value itself is built inside a function.
        import inspect

        src = inspect.getsource(AUDIT._screen_pixels_for_wind)
        # The arrow-function form is the bug; it must not be present.
        self.assertNotIn(
            'pane = """() =>', src,
            "pane is interpolated into `const p = %s;` — as a function "
            "definition `p` binds the function itself and every "
            "hide/show throws",
        )

    def test_pane_expression_is_wrapped_in_parens(self):
        """Parenthesised so `!!(%s)` and `const p = %s;` both parse."""
        import inspect

        src = inspect.getsource(AUDIT._screen_pixels_for_wind)
        self.assertIn('pane = """([', src)

    def test_the_gate_records_sentinels_not_bare_none(self):
        """The run must tag a failed check so the gate can see it."""
        import inspect

        src = inspect.getsource(AUDIT.run_browser)
        self.assertIn('wind_px = "error"', src,
                      "an exception must leave a FAILING sentinel, not None")


if __name__ == "__main__":
    unittest.main()
