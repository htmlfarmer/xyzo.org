"""Word frequency extractor & document classifier using Multilingual NLP & spaCy.

Extracts meaningful keywords (nouns, proper nouns, adjectives) from article
text while removing filler words, stop words, common articles, and generic noise
across multiple languages (English, Spanish, French, German, Italian, Portuguese,
Russian, Arabic, Chinese).

Also integrates document type classification (news_report, opinion_editorial,
analysis_explainer, interview, press_release, sports_recap, review, etc.).

Usage:
    from worker.word_freq import extract_word_freq, extract_word_freq_extended
    freq = extract_word_freq("Title here", "Body text here...")
    # → {"word": count, "word": count, ...}
    ext = extract_word_freq_extended("Title here", "Body text here...")
    # → {"top_words": {...}, "doc_type": "news_report", "doc_type_confidence": 0.9, "lang": "en"}
"""
from __future__ import annotations

import logging
import re
from collections import Counter

from .doc_type import classify_doc_type

log = logging.getLogger("xyzo.word_freq")

# Lazy-load spaCy model
_nlp = None

def _get_nlp():
    global _nlp
    if _nlp is None:
        try:
            import spacy
            _nlp = spacy.load("en_core_web_sm")
            _nlp.disable_pipes("parser", "ner")
        except Exception as e:
            log.warning("spaCy not available: %s", e)
            return None
    return _nlp


# ── MULTILINGUAL STOP WORDS & FILLER WORDS DICTIONARY ─────────────────

# English Filler Words (Dolch, OEC/COCA top ranks, news noise, common verbs/articles)
STOP_EN = {
    # Articles, Pronouns, Subordinators, Prepositions, Conjunctions
    "the", "a", "an", "there", "that", "who", "what", "which", "where", "when",
    "why", "how", "this", "these", "those", "it", "its", "itself", "they", "them",
    "their", "theirs", "themselves", "he", "him", "his", "himself", "she", "her",
    "hers", "herself", "you", "your", "yours", "yourself", "yourselves", "we",
    "us", "our", "ours", "ourselves", "i", "me", "my", "myself", "any", "some",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can",
    "will", "just", "don", "should", "now", "also", "and", "but", "or", "because",
    "as", "until", "while", "of", "at", "by", "for", "with", "about", "against",
    "between", "into", "through", "during", "before", "after", "above", "below",
    "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again",
    "further", "then", "once", "here", "all", "any", "both", "each", "few", "more",
    "most", "other", "some", "such", "than", "too", "very", "s", "t", "can", "will",
    "just", "don", "should", "now", "d", "ll", "m", "o", "re", "ve", "y", "ain",

    # Common Verbs & Auxiliaries (Dolch / COCA top verbs)
    "be", "been", "being", "am", "is", "are", "was", "were",
    "have", "has", "had", "having", "do", "does", "did",
    "doing", "would", "could", "should", "might", "must", "may", "can", "shall",
    "make", "made", "go", "went", "gone", "going", "know", "knew", "known", "take",
    "took", "taken", "use", "used", "work", "worked", "say", "says", "said", "get",
    "got", "gotten", "see", "saw", "seen", "look", "looked", "come", "came", "think",
    "thought", "want", "wanted", "give", "gave", "given", "find", "found", "tell",
    "told", "ask", "asked", "seem", "seemed", "feel", "felt", "try", "tried",
    "call", "called", "keep", "kept", "let", "begin", "began", "begun", "show",
    "showed", "shown", "hear", "heard", "play", "played", "run", "ran", "move",
    "moved", "live", "lived", "believe", "believed", "bring", "brought", "happen",
    "happened", "write", "wrote", "written", "sit", "sat", "stand", "stood", "lose",
    "lost", "pay", "paid", "meet", "met", "include", "included", "continue",
    "continued", "set", "put", "lead", "led", "understand", "understood", "watch",
    "watched", "follow", "followed", "stop", "stopped", "create", "created", "speak",
    "spoke", "spoken", "read", "allow", "allowed", "add", "added", "spend", "spent",
    "grow", "grew", "grown", "open", "opened", "walk", "walked", "win", "won",
    "offer", "offered", "remember", "remembered", "consider", "considered",
    "appear", "appeared", "buy", "bought", "serve", "served", "die", "died",
    "send", "sent", "expect", "expected", "build", "built", "stay", "stayed",
    "fall", "fell", "fallen", "cut", "reach", "reached", "kill", "killed", "raise",
    "raised", "pass", "passed", "sell", "sold", "decide", "decided", "return",
    "returned", "explain", "explained", "hope", "hoped", "pull", "pulled",
    "develop", "developed", "report", "reported", "carry", "carried", "agree",
    "agreed", "support", "supported", "produce", "produced", "hold", "held",
    "plan", "planned", "receive", "received", "join", "joined", "enter", "entered",
    "cover", "covered", "claim", "claimed",

    # Generic Time & News Filler Words
    "time", "times", "year", "years", "day", "days", "week", "weeks", "month",
    "months", "today", "yesterday", "tomorrow", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday", "sunday", "january", "february", "march",
    "april", "may", "june", "july", "august", "september", "october", "november",
    "december", "first", "second", "third", "last", "new", "old", "good", "well",
    "back", "way", "part", "people", "thing", "things", "lot", "lots", "many",
    "much", "high", "low", "big", "small", "great", "long", "short", "point",
    "official", "officials", "government", "president", "minister", "news",
    "statement", "report", "according", "percent", "per", "cent", "million",
    "billion", "thousand", "number", "numbers", "total", "state", "states",
    "country", "countries", "city", "cities", "world", "public", "national",
    "ago", "since", "early", "late", "recent", "recently", "latest", "still",
    "just", "also", "even", "however", "although", "meanwhile", "further",
    "already", "nearly", "almost", "quite", "rather", "instead", "next",
    "around", "along", "among", "across", "behind", "beyond", "within",
    "without", "toward", "towards", "upon", "into", "onto", "above", "below"
}

# Spanish Stop & Filler Words
STOP_ES = {
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "en", "con",
    "por", "para", "que", "se", "su", "sus", "al", "es", "son", "como", "más", "pero",
    "este", "esta", "esto", "estos", "estas", "fue", "fueron", "ha", "han", "sobre",
    "entre", "cuando", "todo", "todos", "toda", "todas", "dijo", "dice", "hacer",
    "hecho", "tener", "tiene", "tienen", "gobierno", "presidente", "país", "ciudad",
    "noticias", "año", "años", "día", "días", "semana", "mes", "si", "no", "o", "y",
    "tan", "así", "muy", "ya", "también", "hasta", "desde", "sin", "durante", "ni",
    "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo",
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "octubre", "noviembre", "diciembre"
}

# French Stop & Filler Words
STOP_FR = {
    "le", "la", "les", "un", "une", "des", "de", "du", "en", "et", "que", "qui", "est",
    "sont", "pas", "pour", "sur", "dans", "avec", "ce", "cette", "ces", "par", "plus",
    "mais", "nous", "vous", "ils", "elles", "son", "sa", "ses", "aux", "ou", "a",
    "ont", "été", "fait", "dit", "après", "meme", "france", "paris", "gouvernement",
    "président", "ans", "jour", "jours", "semaine", "mois", "aussi", "bien", "plusieurs"
}

# German Stop & Filler Words
STOP_DE = {
    "der", "die", "das", "ein", "eine", "einer", "eines", "einem", "einen", "in", "und",
    "zu", "den", "dem", "mit", "für", "auf", "ist", "sind", "im", "nicht", "von", "dass",
    "es", "sich", "aus", "auch", "als", "an", "nach", "wie", "über", "aber", "vor",
    "um", "war", "werden", "kann", "so", "sagte", "wurden", "deutschland", "regierung",
    "jahr", "jahre", "tag", "tage", "woche", "monat", "mehr", "oder", "bis", "nur"
}

# Italian Stop & Filler Words
STOP_IT = {
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della",
    "dei", "delle", "in", "nel", "nella", "nei", "con", "su", "per", "tra", "fra",
    "che", "e", "o", "non", "si", "è", "sono", "come", "ma", "questo", "questa",
    "questi", "queste", "suo", "sua", "suoi", "sue", "ha", "hanno", "stato", "dopo",
    "anno", "anni", "giorno", "giorni", "governo", "presidente", "città"
}

# Portuguese Stop & Filler Words
STOP_PT = {
    # Articles & Contractions
    "o", "a", "os", "as", "um", "uma", "uns", "umas",
    "de", "do", "da", "dos", "das", "dum", "duma", "duns", "dumas",
    "em", "no", "na", "nos", "nas", "num", "numa", "nuns", "numas",
    "com", "por", "para", "sem", "sob", "sobre", "entre", "até", "ate",
    "ao", "aos", "à", "às", "pelo", "pela", "pelos", "pelas",
    "deste", "desta", "destes", "destas", "disto",
    "desse", "dessa", "desses", "dessas", "disso",
    "daquele", "daquela", "daqueles", "daquelas", "daquilo",
    "neste", "nesta", "nestes", "nestas", "nisto",
    "nesse", "nessa", "nesses", "nessas", "nisso",
    "naquele", "naquela", "naqueles", "naquelas", "naquilo",
    # Conjunctions & Prepositions
    "que", "como", "mas", "porém", "porem", "contudo", "todavia", "ou", "nem", "e",
    "pois", "porque", "porquê", "embora", "enquanto", "desde", "após", "apos",
    "contra", "segundo", "conforme", "assim", "portanto", "logo",
    # Pronouns & Possessives
    "ele", "ela", "eles", "elas", "você", "voce", "vocês", "voces",
    "nós", "nos", "vós", "vos", "mim", "ti", "si",
    "meu", "minha", "meus", "minhas", "teu", "tua", "teus", "tuas",
    "seu", "sua", "seus", "suas", "dele", "dela", "deles", "delas",
    "nosso", "nossa", "nossos", "nossas", "vosso", "vossa", "vossos", "vossas",
    "este", "esta", "estes", "estas", "isto",
    "esse", "essa", "esses", "essas", "isso",
    "aquele", "aquela", "aqueles", "aquelas", "aquilo",
    "algum", "alguma", "alguns", "algumas", "algo", "alguém", "alguem",
    "nenhum", "nenhuma", "nenhuns", "nenhumas", "nada", "ninguém", "ninguem",
    "outro", "outra", "outros", "outras", "outrem",
    "todo", "toda", "todos", "todas", "tudo",
    "muito", "muita", "muitos", "muitas", "pouco", "pouca", "poucos", "poucas",
    "qual", "quais", "quanto", "quanta", "quantos", "quantas",
    "quem", "cujo", "cuja", "cujos", "cujas", "mesmo", "mesma", "mesmos", "mesmas",
    # Auxiliary & Common Verbs
    "foi", "foram", "era", "eram", "ser", "seja", "sejam", "sido", "são", "sao", "é",
    "esta", "está", "estão", "estao", "estava", "estavam", "esteve", "estiveram", "estar", "estado",
    "tem", "têm", "temos", "tinha", "tinham", "teve", "tiveram", "ter", "tido",
    "há", "haver", "houve", "houveram",
    "faz", "fazer", "fez", "fizeram", "feito",
    "vai", "vão", "vao", "fui", "fomos", "irá", "irao", "irão", "ir",
    "disse", "disseram", "diz", "dizem", "dito", "dizer",
    "pode", "podem", "podia", "podiam", "puderam", "poder",
    "quer", "querem", "queria", "queriam", "querer",
    "sabe", "sabem", "sabia", "sabiam", "saber",
    "ficou", "ficaram", "fica", "ficam", "ficar",
    # Particles, Adverbs & Fillers
    "não", "nao", "sim", "bem", "mal", "já", "ja", "ainda", "mais", "menos",
    "tão", "tao", "apenas", "somente", "quase", "também", "tambem", "sempre", "nunca",
    "aqui", "ali", "lá", "la", "então", "entao", "agora", "depois", "antes", "hoje", "ontem",
    "além", "alem", "enfim", "afinal",
    # Kinship & Generic Fillers
    "pai", "mãe", "mae", "filho", "filha", "filhos", "filhas", "família", "familia",
    "homem", "homens", "mulher", "mulheres", "pessoa", "pessoas", "gente",
    "ano", "anos", "dia", "dias", "mês", "mes", "meses", "semana", "semanas",
    "governo", "presidente", "país", "pais", "cidade", "cidades", "estado", "estados",
    "notícia", "noticias", "notícias", "parte", "partes", "lugar", "lugares", "vez", "vezes",
    # Days & Months
    "segunda", "terça", "terca", "quarta", "quinta", "sexta", "sábado", "sabado", "domingo",
    "janeiro", "fevereiro", "março", "marco", "abril", "maio", "junho", "julho",
    "agosto", "setembro", "outubro", "novembro", "dezembro"
}

# Russian Stop & Filler Words
STOP_RU = {
    "и", "в", "не", "на", "я", "с", "что", "а", "по", "они", "как", "из", "у", "за",
    "от", "так", "же", "все", "то", "или", "для", "к", "мы", "вы", "он", "она", "оно",
    "это", "этого", "этот", "эти", "был", "была", "были", "быть", "сказал", "сказали",
    "года", "лет", "день", "дни", "время", "россия", "правительство", "президент"
}

# Combined Stop Sets map by language code
LANG_STOP_WORDS: dict[str, set[str]] = {
    "en": STOP_EN,
    "es": STOP_ES,
    "fr": STOP_FR,
    "de": STOP_DE,
    "it": STOP_IT,
    "pt": STOP_PT,
    "ru": STOP_RU,
}


def _detect_lang(text: str) -> str:
    """Detect text language code (en, es, fr, de, it, pt, ru, etc.)."""
    try:
        import langdetect
        if len(text.strip()) < 10:
            return "en"
        return langdetect.detect(text)
    except Exception:
        return "en"


def _get_stop_words_for_lang(lang: str) -> set[str]:
    """Get language-specific stop word set combined with default English."""
    stops = set(STOP_EN)
    if lang in LANG_STOP_WORDS:
        stops.update(LANG_STOP_WORDS[lang])
    return stops


MIN_WORD_LEN = 3
MAX_WORDS = 100


def extract_word_freq(title: str, body: str, max_words: int = MAX_WORDS) -> dict[str, int]:
    """Extract top meaningful word frequency dict from title and body text.

    Args:
        title: Article title
        body: Article body text
        max_words: Max words to return

    Returns:
        {"word": count, "word": count, ...}
    """
    ext = extract_word_freq_extended(title, body, max_words)
    return ext["top_words"]


def extract_word_freq_extended(title: str, body: str, max_words: int = MAX_WORDS) -> dict:
    """Extract word frequency, language code, and document classification.

    Returns:
        {
            "top_words": {"word": count, ...},
            "doc_type": "news_report",
            "doc_type_confidence": 0.95,
            "detected_lang": "en"
        }
    """
    full_text = f"{title or ''} {body or ''}".strip()
    lang = _detect_lang(full_text[:2000])
    stops = _get_stop_words_for_lang(lang)

    doc_type, doc_type_conf = classify_doc_type(title, body)

    # Use spaCy if language is English, otherwise use multilingual regex parser
    if lang == "en":
        nlp = _get_nlp()
        if nlp:
            words_dict = _spacy_extract(title, body, stops, max_words)
        else:
            words_dict = _regex_extract(title, body, stops, max_words)
    else:
        words_dict = _regex_extract(title, body, stops, max_words)

    return {
        "top_words": words_dict,
        "doc_type": doc_type,
        "doc_type_confidence": doc_type_conf,
        "detected_lang": lang,
    }


def _spacy_extract(title: str, body: str, stops: set[str], max_words: int) -> dict[str, int]:
    """Extract words using spaCy POS tagging and lemmatization.

    Title words are extracted FIRST (without deduplication) so they always
    appear in the result, then body words are merged with deduplication.
    This ensures title keywords like "Kenya", "abduction", "safe" always
    surface even if body text is noisy.
    """
    nlp = _get_nlp()
    if not nlp:
        return _regex_extract(title, body, stops, max_words)

    # Process title first — no deduplication, so every title word counts
    title_doc = nlp((title or '').strip())
    title_counts = Counter()
    title_lemmas_seen = set()

    for token in title_doc:
        if token.is_stop or token.is_punct or token.is_space or token.like_num:
            continue
        if token.pos_ not in ("NOUN", "PROPN", "ADJ"):
            continue
        if len(token.text) < MIN_WORD_LEN:
            continue
        word_lower = token.text.lower()
        if word_lower in stops:
            continue
        lemma = token.lemma_.lower()
        if lemma in stops:
            continue
        # Title words: keep all (no seen_lemmas dedup for non-PROPN)
        title_lemmas_seen.add((lemma, token.pos_))
        word = token.text if token.pos_ == "PROPN" else lemma
        title_counts[word] += 1

    # Now process body with deduplication
    body_text = (body or '')[:8000]
    body_doc = nlp(body_text)
    body_counts = Counter()
    body_lemmas_seen = set()

    for token in body_doc:
        if token.is_stop or token.is_punct or token.is_space or token.like_num:
            continue
        if token.pos_ not in ("NOUN", "PROPN", "ADJ"):
            continue
        if len(token.text) < MIN_WORD_LEN:
            continue
        word_lower = token.text.lower()
        if word_lower in stops:
            continue
        lemma = token.lemma_.lower()
        if lemma in stops:
            continue
        if (lemma, token.pos_) in title_lemmas_seen:
            # Title already has this word — boost title count, skip in body
            title_counts[token.text if token.pos_ == "PROPN" else lemma] += 2
            continue
        if lemma in body_lemmas_seen and token.pos_ != "PROPN":
            continue
        body_lemmas_seen.add((lemma, token.pos_))
        word = token.text if token.pos_ == "PROPN" else lemma
        body_counts[word] += 1

    # Merge: title counts + body counts, title already has its boosted weight
    combined = title_counts + body_counts
    return dict(combined.most_common(max_words))


def _regex_extract(title: str, body: str, stops: set[str], max_words: int) -> dict[str, int]:
    """Multilingual regex extraction fallback.

    Title words are counted with a 3x weight so they dominate the results
    even when the body text is noisy or contains concatenated HTML artefacts.
    """
    title_words = re.findall(r'\b[^\W\d_]{3,}\b', (title or '').lower(), re.UNICODE)
    body_words = re.findall(r'\b[^\W\d_]{3,}\b', (body or '').lower(), re.UNICODE)

    title_counts = Counter(w for w in title_words if w not in stops)
    body_counts = Counter(w for w in body_words if w not in stops)

    # 3x weight for title words
    for w in title_counts:
        title_counts[w] *= 3

    # Merge: title (with 3x) + body
    combined = title_counts + body_counts
    return dict(combined.most_common(max_words))


def top_words_html(word_freq: dict[str, int], count: int = 15) -> str:
    """Render word frequency as HTML chips for the pin popup."""
    if not word_freq:
        return ""

    words = sorted(word_freq.items(), key=lambda x: -x[1])[:count]
    if not words:
        return ""

    max_count = words[0][1] if words else 1
    chips = []
    for word, freq in words:
        opacity = max(0.4, freq / max_count)
        chips.append(
            f'<span style="display:inline-block;padding:1px 6px;margin:1px;'
            f'font-size:10px;background:rgba(94,234,212,{opacity * 0.15});'
            f'color:rgba(94,234,212,{opacity});border-radius:3px;'
            f'border:1px solid rgba(94,234,212,{opacity * 0.3});">'
            f'{word}</span>'
        )

    return f'<div class="popup-words" style="margin-top:6px;line-height:1.8;">{"".join(chips)}</div>'


def word_freq_to_json(word_freq: dict[str, int]) -> str:
    """Serialize word frequency to JSON string for DB storage."""
    import json
    if not word_freq:
        return "{}"
    return json.dumps(word_freq, ensure_ascii=False)


def word_freq_from_json(json_str: str) -> dict[str, int]:
    """Deserialize word frequency from JSON string."""
    import json
    if not json_str:
        return {}
    try:
        return json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return {}
