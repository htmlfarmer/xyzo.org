"""Unit & Integration Tests for Multilingual Word Frequency & Document Type Classifier.

Runs via pytest or python -m unittest tests/test_word_freq_doctype.py
"""
import unittest
from worker.word_freq import extract_word_freq, extract_word_freq_extended
from worker.doc_type import classify_doc_type


class TestWordFreqAndDocType(unittest.TestCase):

    def test_english_filler_word_removal(self):
        """Test that English Dolch/COCA filler words and articles are stripped out."""
        title = "Magnitude 7.2 earthquake hits Tokyo near the coast"
        body = "A powerful earthquake struck off the coast of Japan today. Officials said residents should evacuate. The emergency team is on site."
        res = extract_word_freq_extended(title, body)

        words = res["top_words"]
        # Essential keywords must be present
        self.assertIn("Tokyo", words)
        self.assertIn("earthquake", words)
        self.assertIn("Japan", words)

        # Filler words MUST be absent
        filler_words = {"the", "a", "an", "there", "today", "said", "officials", "is", "on", "off", "of", "should"}
        for f in filler_words:
            self.assertNotIn(f, words, f"Filler word '{f}' was not removed!")

    def test_spanish_stop_word_removal(self):
        """Test Spanish language detection and stop word removal."""
        title = "El terremoto sacudió la ciudad de Madrid este lunes"
        body = "Un fuerte sismo afectó a los habitantes de la capital española. El gobierno dijo que los bomberos están trabajando."
        res = extract_word_freq_extended(title, body)

        self.assertEqual(res["detected_lang"], "es")
        words = res["top_words"]
        self.assertIn("terremoto", words)
        self.assertIn("madrid", words)

        # Spanish filler words MUST be absent
        spanish_fillers = {"el", "la", "los", "las", "un", "una", "de", "del", "en", "este", "lunes", "dijo"}
        for f in spanish_fillers:
            self.assertNotIn(f, words, f"Spanish filler word '{f}' was not removed!")

    def test_french_stop_word_removal(self):
        """Test French language detection and stop word removal."""
        title = "Le gouvernement annonce de nouvelles mesures économiques à Paris"
        body = "Le ministre a déclaré aujourd hui que le parlement va voter la loi la semaine prochaine."
        res = extract_word_freq_extended(title, body)

        self.assertEqual(res["detected_lang"], "fr")
        words = res["top_words"]

        # French filler words MUST be absent
        french_fillers = {"le", "la", "les", "un", "une", "des", "de", "du", "en", "et", "que", "est", "a", "qui"}
        for f in french_fillers:
            self.assertNotIn(f, words, f"French filler word '{f}' was not removed!")

    def test_portuguese_stop_word_removal(self):
        """Test Portuguese language detection and stop word removal."""
        title = "O incêndio florestal atingiu a região de Lisboa este domingo"
        body = "O meu pai disse que foi um momento difícil para a família com a fumaça. Ele nao bem conseguiu sair por causa do vento."
        res = extract_word_freq_extended(title, body)

        self.assertEqual(res["detected_lang"], "pt")
        words = res["top_words"]

        # Meaningful terms should be present
        self.assertIn("incêndio", words)
        self.assertIn("lisboa", words)

        # Portuguese filler words MUST be absent
        pt_fillers = {"por", "para", "nao", "ele", "pai", "bem", "com", "meu", "foi", "este", "domingo", "disse"}
        for f in pt_fillers:
            self.assertNotIn(f, words, f"Portuguese filler word '{f}' was not removed!")

    def test_doc_type_opinion_editorial(self):
        """Test Opinion/Editorial document classification."""
        title = "Opinion: Why we must address climate change immediately"
        body = "In my view, the government should take bold action to protect coastal communities."
        doc_type, conf = classify_doc_type(title, body)
        self.assertEqual(doc_type, "opinion_editorial")
        self.assertGreaterEqual(conf, 0.85)

    def test_doc_type_live_blog(self):
        """Test Live Blog document classification."""
        title = "LIVE: Election night results and live updates"
        body = "10:00 PM - Polls close in western states. As it happened..."
        doc_type, conf = classify_doc_type(title, body)
        self.assertEqual(doc_type, "live_blog")
        self.assertGreaterEqual(conf, 0.90)

    def test_doc_type_interview(self):
        """Test Interview / Q&A document classification."""
        title = "Q&A with NASA Astronaut: Life in Space"
        body = "Q: What is the hardest part of spaceflight? A: Living in zero gravity."
        doc_type, conf = classify_doc_type(title, body)
        self.assertEqual(doc_type, "interview")
        self.assertGreaterEqual(conf, 0.90)

    def test_doc_type_sports_recap(self):
        """Test Sports Recap document classification."""
        title = "Lakers defeat Celtics 112-108 in game recap"
        body = "LeBron James scored 34 points as the Lakers held off the Celtics in the final score."
        doc_type, conf = classify_doc_type(title, body)
        self.assertEqual(doc_type, "sports_recap")
        self.assertGreaterEqual(conf, 0.85)


if __name__ == "__main__":
    unittest.main()
