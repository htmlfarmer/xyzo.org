"""Shared pytest fixtures for worker integration tests."""
import os

# Mirror tests/conftest.py so a bare `pytest` (both dirs via pytest.ini
# testpaths) can collect worker/tests without XYZO_DB_DSN pre-exported.
os.environ.setdefault("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")

import pytest
import psycopg
from worker.db import connect


class DbHelper:
    """Wrapper that provides a dict-like cursor interface with .unsafe() method."""

    def __init__(self, conn):
        self._conn = conn

    def unsafe(self, sql, *params):
        """Execute SQL and return rows (SELECT) or command result metadata."""
        with self._conn.cursor() as cur:
            cur.execute(sql, params if params else None)
            try:
                return cur.fetchall()
            except psycopg.ProgrammingError:
                # Command that doesn't return rows (DELETE, INSERT without RETURNING, etc.)
                if cur.description is None:
                    # Return a mock result with affected rows
                    return [{"rows_affected": cur.rowcount}]
                raise

    def value(self, sql, *params):
        """Return a single scalar value."""
        try:
            rows = self.unsafe(sql, *params)
        except TypeError:
            # Command that doesn't return rows
            return None
        if rows and isinstance(rows[0], dict) and len(rows[0]) == 1:
            return list(rows[0].values())[0]
        return None

    def row(self, sql, *params):
        """Return the first row as a dict."""
        try:
            rows = self.unsafe(sql, *params)
        except TypeError:
            return None
        return rows[0] if rows else None

    def rows(self, sql, *params):
        """Return all rows as a list of dicts."""
        try:
            return self.unsafe(sql, *params)
        except TypeError:
            return []


@pytest.fixture
def db():
    """Provide a database connection with .unsafe() helper for integration tests."""
    with connect() as conn:
        yield DbHelper(conn)

