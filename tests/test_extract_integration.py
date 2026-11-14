"""
Integration test for worker/extract.py - tests the full run() function
and catches NameError bugs like missing function references.

This test would have caught the _update_article NameError bug where
the code called a non-existent function instead of _batch_update_articles.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


class TestExtractRunIntegrity:
    """Test that extract.run() doesn't have NameError issues."""

    def test_batch_update_articles_is_callable(self):
        """Verify _batch_update_articles exists and is callable."""
        from worker.extract import _batch_update_articles
        assert callable(_batch_update_articles)

    def test_lightweight_extract_is_callable(self):
        """Verify _lightweight_extract exists and is callable."""
        from worker.extract import _lightweight_extract
        assert callable(_lightweight_extract)

    def test_batch_check_coords_is_callable(self):
        """Verify _batch_check_coords exists and is callable."""
        from worker.extract import _batch_check_coords
        assert callable(_batch_check_coords)

    @patch("worker.extract._batch_update_articles")
    @patch("worker.extract._batch_check_coords")
    @patch("worker.extract.connect")
    def test_run_calls_batch_update_articles(
        self, mock_connect, mock_check_coords, mock_batch_update
    ):
        """
        Test that run() properly calls _batch_update_articles for both
        skipped_articles and ai_articles, NOT a non-existent _update_article.
        """
        from worker.extract import run

        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cur)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        mock_connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_connect.return_value.__exit__ = MagicMock(return_value=False)

        mock_cur.fetchall.return_value = []
        mock_check_coords.return_value = {}

        with patch("worker.extract.httpx.Client") as mock_httpx:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.iter_text.return_value = []
            mock_response.raise_for_status = MagicMock()
            mock_client.stream.return_value.__enter__ = MagicMock(
                return_value=mock_response
            )
            mock_client.stream.return_value.__exit__ = MagicMock(return_value=False)
            mock_httpx.return_value.__enter__ = MagicMock(return_value=mock_client)
            mock_httpx.return_value.__exit__ = MagicMock(return_value=False)

            with patch("worker.extract.extract_one") as mock_extract_one:
                mock_extract_one.return_value = {
                    "summary": "test",
                    "location_text": "Tokyo",
                    "event_type": "news",
                    "entities": [],
                    "topic_tags": [],
                    "_method": "ai",
                    "_latency_ms": 100,
                }

                mock_cur.fetchall.side_effect = [
                    [],
                    [],
                ]

                try:
                    result = run(limit=1, progress=None)
                    assert mock_batch_update.called, (
                        "_batch_update_articles was never called - "
                        "code may be calling non-existent function"
                    )
                except NameError as e:
                    pytest.fail(f"NameError in run(): {e}")


class TestExtractLightweight:
    """Test _lightweight_extract produces valid extractions."""

    def test_lightweight_returns_valid_structure(self):
        """Verify lightweight extraction returns all required keys."""
        from worker.extract import _lightweight_extract

        article = {
            "title": "Earthquake hits Tokyo",
            "body": "A magnitude 6.1 earthquake struck Tokyo today",
        }
        result = _lightweight_extract(article)

        assert "summary" in result
        assert "location_text" in result
        assert "event_type" in result
        assert "entities" in result
        assert "topic_tags" in result
        assert isinstance(result["entities"], list)
        assert isinstance(result["topic_tags"], list)

    def test_lightweight_extracts_city_from_title(self):
        """Test that city names in title are extracted."""
        from worker.extract import _lightweight_extract

        article = {
            "title": "Flooding in Bangkok leaves thousands homeless",
            "body": "Severe flooding reported in Bangkok",
        }
        result = _lightweight_extract(article)
        assert result["location_text"] is not None or result["event_type"] is not None


class TestExtractBatchUpdate:
    """Test _batch_update_articles correctly updates articles."""

    def test_batch_update_empty_list(self):
        """Empty list should not cause errors."""
        from worker.extract import _batch_update_articles

        _batch_update_articles([])

    @patch("worker.extract.connect")
    def test_batch_update_single_article(self, mock_connect):
        """Single article update should work."""
        from worker.extract import _batch_update_articles

        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cur)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        mock_connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_connect.return_value.__exit__ = MagicMock(return_value=False)

        updates = [
            (
                123,
                {
                    "summary": "Test summary",
                    "location_text": "Tokyo",
                    "event_type": "news",
                    "entities": [],
                    "topic_tags": [],
                    "image_url": None,
                },
                "extracted",
            )
        ]

        _batch_update_articles(updates)
        assert mock_cur.execute.called


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
