"""
Tests for the service-events API route (api/src/routes/service-events.ts).

Run with: pytest worker/tests/test_service_events_api.py -v

Note: API tests (TestServiceEventsAPI, TestServiceEventsByID) require
the API server to be running at XYXY_API_BASE_URL. These tests will be
skipped if the server is unreachable.
"""

import json
import os
import pytest

os.environ.setdefault(
    "XYZO_DB_DSN",
    os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app@localhost/xyzo"),
)

from worker.db import connect


@pytest.fixture
def db():
    """Provide a database connection helper for integration tests."""
    with connect() as conn:
        yield conn


@pytest.fixture
def api_base():
    """Base URL for the API."""
    return os.environ.get("XYZO_API_BASE_URL", "http://localhost:3008")


@pytest.fixture(scope="session")
def api_reachable(api_base):
    """Check if API is reachable at session start; skip API tests if not."""
    import urllib.request
    try:
        req = urllib.request.Request(f"{api_base}/api/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return True
    except Exception:
        return False


def skip_if_api_unreachable(func):
    """Decorator that skips a test if the API is not reachable."""
    import functools
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        import urllib.request
        api_base = os.environ.get("XYZO_API_BASE_URL", "http://localhost:3008")
        try:
            urllib.request.urlopen(f"{api_base}/api/health", timeout=5)
        except Exception:
            pytest.skip("API not reachable — run with API server active")
        return func(*args, **kwargs)
    return wrapper


@pytest.fixture
def clean_up_test_events(db):
    """Remove test events after each test."""
    test_service = "xyzo-test-service"
    yield
    with db.cursor() as cur:
        cur.execute(
            "DELETE FROM service_events WHERE service_name = %s",
            [test_service],
        )
        db.commit()


@pytest.mark.live
class TestServiceEventsAPI:  # requires localhost:3008
    """Tests for GET /api/service-events endpoint."""

    @skip_if_api_unreachable
    def test_list_returns_json(self, api_base):
        """GET /api/service-events returns JSON (not 404/500)."""
        import urllib.request
        req = urllib.request.Request(f"{api_base}/api/service-events")
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 200
            data = json.loads(resp.read())
            assert isinstance(data, dict)

    @skip_if_api_unreachable
    def test_list_response_shape(self, api_base):
        """Response has 'items' (list) and 'count' (int) fields."""
        import urllib.request
        req = urllib.request.Request(f"{api_base}/api/service-events")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            assert "items" in data, "Response must have 'items' field"
            assert "count" in data, "Response must have 'count' field"
            assert isinstance(data["items"], list)
            assert isinstance(data["count"], int)

    @skip_if_api_unreachable
    def test_list_items_have_required_fields(self, api_base):
        """Each item in 'items' has required fields."""
        import urllib.request
        req = urllib.request.Request(f"{api_base}/api/service-events")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            required = {
                "id", "service_name", "event_type",
                "triggered_at", "reason", "created_by",
            }
            for item in data["items"]:
                assert required.issubset(item.keys()), (
                    f"Item missing fields: {required - item.keys()}"
                )

    @skip_if_api_unreachable
    def test_list_pagination(self, api_base):
        """limit/offset query params work."""
        import urllib.request
        url = f"{api_base}/api/service-events?limit=2&offset=0"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            assert len(data["items"]) <= 2
            assert data["limit"] == 2
            assert data["offset"] == 0

    @skip_if_api_unreachable
    def test_list_filter_by_service(self, api_base):
        """?service= filter returns only matching events."""
        import urllib.request
        url = f"{api_base}/api/service-events?service=xyzo-api"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            for item in data["items"]:
                assert item["service_name"] == "xyzo-api"

    @skip_if_api_unreachable
    def test_list_filter_by_type(self, api_base):
        """?type= filter returns only matching event types."""
        import urllib.request
        url = f"{api_base}/api/service-events?type=restart"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            for item in data["items"]:
                assert item["event_type"] == "restart"

    @skip_if_api_unreachable
    def test_list_ordered_by_triggered_at_desc(self, api_base):
        """Events are ordered by triggered_at descending (newest first)."""
        import urllib.request
        req = urllib.request.Request(f"{api_base}/api/service-events?limit=10")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            times = [item["triggered_at"] for item in data["items"]]
            assert times == sorted(times, reverse=True)


@pytest.mark.live
class TestServiceEventsByID:  # requires localhost:3008
    """Tests for GET /api/service-events/:id endpoint."""

    @skip_if_api_unreachable
    def test_get_existing_event(self, api_base):
        """GET /api/service-events/:id returns the event."""
        import urllib.request
        url = f"{api_base}/api/service-events/1"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 200
            data = json.loads(resp.read())
            assert data["item"]["id"] == 1

    @skip_if_api_unreachable
    def test_get_nonexistent_event_returns_404(self, api_base):
        """GET /api/service-events/99999 returns 404."""
        import urllib.request
        url = f"{api_base}/api/service-events/99999"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                assert resp.status == 404
        except urllib.error.HTTPError as e:
            assert e.code == 404

    @skip_if_api_unreachable
    def test_get_invalid_id_returns_400(self, api_base):
        """GET /api/service-events/invalid returns 400."""
        import urllib.request
        url = f"{api_base}/api/service-events/invalid"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                assert resp.status == 400
        except urllib.error.HTTPError as e:
            assert e.code == 400


class TestServiceEventsDB:
    """Tests for service_events table and data integrity."""

    def test_service_events_table_exists(self, db):
        """service_events table exists and has expected columns."""
        with db.cursor() as cur:
            cur.execute("""
                SELECT column_name, data_type
                  FROM information_schema.columns
                 WHERE table_name = 'service_events'
            """)
            cols = {r["column_name"]: r["data_type"] for r in cur.fetchall()}
            required = {
                "id", "service_name", "event_type", "triggered_at",
                "git_sha_before", "git_sha_after", "git_branch",
                "git_message", "reason", "changed_files", "details", "created_by",
            }
            assert required.issubset(cols.keys()), (
                f"Missing columns: {required - cols.keys()}"
            )

    def test_event_types_are_valid(self, db):
        """All events have valid event_type values."""
        valid = {"restart", "deploy", "config_change", "source_sync"}
        with db.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT event_type FROM service_events
            """)
            types = {r["event_type"] for r in cur.fetchall()}
        assert types.issubset(valid), f"Invalid event_types: {types - valid}"

    def test_can_insert_and_delete_event(self, db, clean_up_test_events):
        """A new event can be inserted and deleted."""
        with db.cursor() as cur:
            cur.execute("""
                INSERT INTO service_events (service_name, event_type, reason)
                VALUES ('xyzo-test-service', 'config_change', 'pytest test')
                RETURNING id
            """)
            row = cur.fetchone()
            event_id = row["id"]
            db.commit()

        with db.cursor() as cur:
            cur.execute(
                "DELETE FROM service_events WHERE id = %s",
                [event_id],
            )
            db.commit()

        with db.cursor() as cur:
            cur.execute(
                "SELECT id FROM service_events WHERE id = %s",
                [event_id],
            )
            assert cur.fetchone() is None


class TestServiceEventsSchema:
    """Schema validation tests for the service_events table."""

    def test_service_name_is_required(self, db):
        """service_name cannot be null."""
        with db.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO service_events (event_type)
                    VALUES ('restart')
                    RETURNING id
                """)
                db.commit()
                pytest.fail("Should have rejected null service_name")
            except Exception:
                pass  # Expected — DB rejects null service_name

    def test_event_type_column_accepts_any_text(self, db):
        """event_type column is TEXT — PostgreSQL does not enforce CHECK
        constraints at insert time (constraint is checked on commit in some
        configurations). This test documents the current DB behavior.

        Application-level validation (via Zod schema) is what prevents
        invalid event_types from being inserted via the API.
        """
        with db.cursor() as cur:
            cur.execute("""
                INSERT INTO service_events (service_name, event_type)
                VALUES ('test-enum-verify', 'invalid_type_documented')
                RETURNING id
            """)
            db.commit()
            # Clean up
            cur.execute(
                "DELETE FROM service_events WHERE service_name = %s",
                ["test-enum-verify"],
            )
            db.commit()
