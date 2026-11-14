#!/usr/bin/env python3
"""
Tests for worker.extract._clean_topic_tags — the STRUCTURAL ARTEFACTS.

The extractor's system prompt used to show the model this shape:

    "topic_tags": ["3-6", "short", "topic", "tags"]

and a great many models copied it VERBATIM: those four words are literal
tags on thousands of articles ("3-6" 2,741 · "short" 1,482 · "tags" 1,395
· "topic" 1,265). The chip bar offered a chip labelled "topic", and a
reader who clicked it got a map of articles about nothing in particular
— which is exactly what it looks like.

The prompt no longer shows a copyable example (it asks for the tags in
prose and shows an empty list), but a model that answers with a
placeholder anyway must not be able to WRITE one. So the words are
stripped here, and an article left with no tags falls back to its event
type — which is a real topic.

Run with: python -m pytest worker/tests/test_extract_topic_tags.py -v
"""
from worker.extract import STRUCTURAL_TAGS, _clean_topic_tags


def test_the_four_artefacts_are_the_ones_the_prompt_used_to_show():
    # These are the words the prompt's example was made of. If the prompt
    # changes, this list changes with it — they are the SAME list.
    assert STRUCTURAL_TAGS == frozenset({"3-6", "short", "tags", "topic"})


def test_a_copied_placeholder_is_stripped():
    # The model answered with the prompt's example, verbatim.
    assert _clean_topic_tags(["3-6", "short", "topic", "tags"], "technology") == ["technology"]


def test_a_placeholder_among_real_tags_leaves_the_real_ones():
    assert _clean_topic_tags(
        ["politics", "topic", "tags", "short", "3-6"], "technology"
    ) == ["politics"]


def test_the_artefacts_are_matched_case_insensitively_and_after_stripping():
    assert _clean_topic_tags(["Topic", " TAGS ", "Short"], "politics") == ["politics"]
    assert _clean_topic_tags(["3-6", "TOPIC"], "business") == ["business"]


def test_no_tags_at_all_falls_back_to_the_event_type():
    # The event type IS a real topic, so an article is never left with
    # nothing to filter on.
    assert _clean_topic_tags([], "technology") == ["technology"]
    assert _clean_topic_tags(None, "science") == ["science"]


def test_the_fallback_skips_the_useless_event_type():
    # "other" says nothing, so it is not a tag.
    assert _clean_topic_tags([], "other") == []
    assert _clean_topic_tags(["3-6", "topic"], "other") == []


def test_real_tags_are_untouched():
    assert _clean_topic_tags(["election", "climate"], "politics") == ["election", "climate"]


def test_the_list_is_capped_at_six():
    # The DB column holds six; more than that is a model that ignored the
    # instruction, and the extra words are noise.
    many = [f"t{i}" for i in range(10)]
    assert len(_clean_topic_tags(many, "politics")) == 6


def test_the_normaliser_writes_the_cleaned_tags():
    # The cleaning must be where the tags are NORMALISED, not somewhere
    # else that could be bypassed.
    from worker.extract import _normalize

    out = _normalize({
        "summary": "s",
        "location_text": "Testville",
        "event_type": "technology",
        "entities": ["ok"],
        "topic_tags": ["3-6", "short", "topic", "tags"],
    })
    assert out["topic_tags"] == ["technology"]

    out2 = _normalize({
        "summary": "s",
        "location_text": "Testville",
        "event_type": "technology",
        "entities": ["ok"],
        "topic_tags": ["politics", "topic"],
    })
    assert out2["topic_tags"] == ["politics"]
