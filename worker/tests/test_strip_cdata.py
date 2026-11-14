"""Unit tests for _strip_cdata helper in worker/extract.py."""
import unittest
from worker.extract import _strip_cdata


class TestStripCdata(unittest.TestCase):
    def test_basic_cdata(self):
        raw = "<![CDATA[Homem morre atropelado na A33]]>"
        self.assertEqual(_strip_cdata(raw), "Homem morre atropelado na A33")

    def test_cdata_with_whitespace(self):
        raw = "  <![CDATA[   Headline with spaces   ]]>  "
        self.assertEqual(_strip_cdata(raw), "Headline with spaces")

    def test_empty_cdata(self):
        raw = "<![CDATA[]]>"
        self.assertEqual(_strip_cdata(raw), "")

    def test_none_input(self):
        self.assertEqual(_strip_cdata(None), "")

    def test_empty_string_input(self):
        self.assertEqual(_strip_cdata(""), "")

    def test_idempotent_plain_text(self):
        raw = "Regular headline without CDATA"
        self.assertEqual(_strip_cdata(raw), "Regular headline without CDATA")

    def test_case_insensitive_cdata_tag(self):
        raw = "<![cdata[ Lowercase cdata tag ]]>"
        self.assertEqual(_strip_cdata(raw), "Lowercase cdata tag")

    def test_multiline_cdata(self):
        raw = "<![CDATA[\nLine 1\nLine 2\n]]>"
        self.assertEqual(_strip_cdata(raw), "Line 1\nLine 2")

    def test_html_entities_and_formatting(self):
        raw = "<![CDATA[<b>Breaking:</b> &amp; important news]]>"
        self.assertEqual(_strip_cdata(raw), "<b>Breaking:</b> &amp; important news")


if __name__ == "__main__":
    unittest.main()
