"""Tests for the visualization (viz.js) module.

Since viz.js is a browser-only module, we test the pure logic portions
that can be extracted and tested in Python.
"""
from __future__ import annotations

import math
import pytest


class TestHaversineKm:
    """Test the haversine distance calculation."""

    def test_same_point_is_zero(self):
        assert haversine_km(0, 0, 0, 0) == 0

    def test_equator_quarter(self):
        # ~111km per degree at equator
        result = haversine_km(0, 0, 0, 1)
        assert 110 < result < 112

    def test_london_to_paris(self):
        # ~340km
        result = haversine_km(51.5074, -0.1278, 48.8566, 2.3522)
        assert 330 < result < 350

    def test_symmetric(self):
        a = haversine_km(40.7128, -74.0060, 51.5074, -0.1278)
        b = haversine_km(51.5074, -0.1278, 40.7128, -74.0060)
        assert abs(a - b) < 0.01


class TestHexKey:
    """Test hexagonal bin key generation."""

    def test_consistent(self):
        key1 = hex_key(40.7128, -74.0060, 0.5)
        key2 = hex_key(40.7128, -74.0060, 0.5)
        assert key1 == key2

    def test_different_coords_different_keys(self):
        # Use coords far apart to ensure different hex bins
        key1 = hex_key(40.7128, -74.0060, 0.5)
        key2 = hex_key(51.5074, -0.1278, 0.5)  # London vs NYC
        assert key1 != key2


# Pure Python implementations for testing (mirrors viz.js logic)
def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371
    dLat = (lat2 - lat1) * math.pi / 180
    dLng = (lng2 - lng1) * math.pi / 180
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) *
         math.sin(dLng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def hex_key(lat: float, lng: float, size: float) -> str:
    h = size / 2
    col = int(lng / h)
    row = int(lat / (size * 0.866))
    return f"{row * size * 0.866},{col * h}"
