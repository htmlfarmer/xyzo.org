"""xyzo_debug — comprehensive debugging infrastructure for xyzo.org.

Submodules:
    click_investigator   — diagnose unclickable elements
    ui_health_scanner    — automated UI element health checks
    bug_packet           — auto-generate diagnostic bug packets
    playwright_diagnostics — Playwright browser diagnostics + traces
    mobile_testing       — device emulation + mobile workflows
    visual_regression    — screenshot comparison
    network_throttle     — network condition testing
    db_diagnostics      — PostgreSQL→API→Browser tracing
"""

from .click_investigator import ClickInvestigationResult
from .ui_health_scanner import UIHealthReport
from .bug_packet import BugPacket
from .playwright_diagnostics import PlaywrightDiagnostics
from .mobile_testing import MobileTestMatrix
from .visual_regression import VisualRegression
from .network_throttle import NetworkThrottle
from .db_diagnostics import DBDiagnostics

__all__ = [
    "ClickInvestigationResult",
    "UIHealthReport",
    "BugPacket",
    "PlaywrightDiagnostics",
    "MobileTestMatrix",
    "VisualRegression",
    "NetworkThrottle",
    "DBDiagnostics",
]
