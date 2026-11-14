#!/usr/bin/env python3
"""
Wikimedia Intelligence Tests - Quick Version

Run all tests:
    cd /var/www/vhosts/xyzo.org && python3 tests/test_wikimedia.py

These are quick smoke tests that don't require DB connection.
"""

import sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org')

def test_entity_extract_basic():
    """Test entity_extract basic functions."""
    from worker.entity_extract import _content_hash, _parse_entity_response, _fallback_entity_extraction

    # Test content hash
    h1 = _content_hash("Title", "Body")
    h2 = _content_hash("Title", "Body")
    h3 = _content_hash("Different", "Body")
    assert h1 == h2, "Same content should produce same hash"
    assert h1 != h3, "Different content should produce different hash"
    print("  ✅ _content_hash works")

    # Test JSON parsing
    r = _parse_entity_response('["Apple", "Google"]')
    assert r == ["Apple", "Google"], f"Expected ['Apple', 'Google'], got {r}"
    print("  ✅ _parse_entity_response works")

    # Test fallback extraction
    entities = _fallback_entity_extraction("President Biden met Elon Musk", "White House statement")
    assert len(entities) > 0, "Should extract some entities"
    print(f"  ✅ _fallback_entity_extraction works ({len(entities)} entities)")


def test_ner_extract_basic():
    """Test ner_extract basic functions."""
    from worker.ner_extract import normalize_entity_type

    assert normalize_entity_type("PERSON") == "person"
    assert normalize_entity_type("ORG") == "organization"
    assert normalize_entity_type("GPE") == "place"
    print("  ✅ normalize_entity_type works")


def test_wiki_geo_basic():
    """Test wiki_geo basic functions."""
    from worker.wiki_geo import extract_keywords, COUNTRY_DEMONYMS

    # Test keyword extraction
    keywords = extract_keywords(None, "Apple Announces New iPhone", "")
    assert len(keywords) > 0, "Should extract some keywords"
    print(f"  ✅ extract_keywords works ({len(keywords)} keywords)")

    # Test country demonyms
    assert "chile" in COUNTRY_DEMONYMS
    assert COUNTRY_DEMONYMS["chile"] == "CL"
    print("  ✅ COUNTRY_DEMONYMS works")


def test_gazetteer_basic():
    """Test gazetteer basic functions."""
    from worker.gazetteer import _classify_entity, _extract_aliases

    # Test entity classification
    entity_type = _classify_entity("Stanford University", ["University"])
    assert entity_type == "university", f"Expected 'university', got '{entity_type}'"
    print("  ✅ _classify_entity works")

    # Test alias extraction
    aliases = _extract_aliases("Los Angeles (California)")
    assert "Los Angeles" in aliases
    print("  ✅ _extract_aliases works")


def test_latency_tracker():
    """Test latency tracking."""
    from worker.wikimedia_experiment import LatencyTracker

    tracker = LatencyTracker()
    tracker.add(10.0)
    tracker.add(20.0)
    tracker.add(30.0)

    assert abs(tracker.avg - 20.0) < 0.1, f"Expected 20.0, got {tracker.avg}"
    pcts = tracker.percentiles([50, 95])
    assert pcts[50] == 20.0, f"Expected median 20.0, got {pcts[50]}"
    print("  ✅ LatencyTracker works")


def test_wikidata_bridge_basic():
    """Test wikidata bridge basic functions."""
    from worker.wikidata.wiki_wikidata_bridge import WIKIDATA_DSN, WIKIPEDIA_DSN

    assert "wikipedia" in WIKIPEDIA_DSN
    assert "wikidata" in WIKIDATA_DSN
    print("  ✅ wikidata_bridge DSN constants work")


def main():
    print("\n🧪 Wikimedia Intelligence Quick Tests")
    print("=" * 50)

    tests = [
        ("entity_extract basic", test_entity_extract_basic),
        ("ner_extract basic", test_ner_extract_basic),
        ("wiki_geo basic", test_wiki_geo_basic),
        ("gazetteer basic", test_gazetteer_basic),
        ("latency tracker", test_latency_tracker),
        ("wikidata bridge", test_wikidata_bridge_basic),
    ]

    passed = 0
    failed = 0

    for name, test_fn in tests:
        try:
            print(f"\n📋 {name}...")
            test_fn()
            passed += 1
        except Exception as e:
            print(f"  ❌ FAILED: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print("\n" + "=" * 50)
    print(f"Results: {passed} passed, {failed} failed")

    if failed > 0:
        print("\n⚠️  Some tests failed. Check output above.")
        return 1
    else:
        print("\n✅ All quick tests passed!")
        return 0


if __name__ == "__main__":
    sys.exit(main())
