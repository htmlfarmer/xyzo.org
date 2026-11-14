"""pytest configuration — sets up the database DSN so worker tests can run."""
from __future__ import annotations

import os

os.environ.setdefault("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")
