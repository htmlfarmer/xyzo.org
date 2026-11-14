"""Unit tests for user request auto-resolution and location suggestion processing.

Tests coordinate payload decoding, radius-to-precision mapping, non-AI location
resolution, and ground-truth location learning without requiring AI endpoints.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make project root importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.re_evaluate import (
    _decode_coords,
    _precision_for_radius,
)


class TestCoordsDecoding:
    def test_decode_coords_standard(self):
        payload = "coords:35.6895,139.6917,25.0,0.9,Tokyo%20Japan"
        decoded = _decode_coords(payload)
        assert decoded is not None
        assert decoded["lat"] == 35.6895
        assert decoded["lng"] == 139.6917
        assert decoded["radius_km"] == 25.0
        assert decoded["confidence"] == 0.9
        assert decoded["note"] == "Tokyo Japan"

    def test_decode_coords_text_plus_coords(self):
        payload = "text+coords:31.52,74.36,5.0,0.95,Protest%20in%20Lahore"
        decoded = _decode_coords(payload)
        assert decoded is not None
        assert decoded["lat"] == 31.52
        assert decoded["lng"] == 74.36
        assert decoded["radius_km"] == 5.0
        assert decoded["confidence"] == 0.95
        assert decoded["note"] == "Protest in Lahore"

    def test_decode_invalid_coords(self):
        assert _decode_coords("invalid_string") is None
        assert _decode_coords("") is None
        assert _decode_coords(None) is None


class TestPrecisionRadiusMapping:
    def test_precision_mapping(self):
        assert _precision_for_radius(2.0) == "exact"
        assert _precision_for_radius(5.0) == "exact"
        assert _precision_for_radius(15.0) == "city"
        assert _precision_for_radius(25.0) == "city"
        assert _precision_for_radius(50.0) == "region"
        assert _precision_for_radius(100.0) == "region"
        assert _precision_for_radius(150.0) == "country"
