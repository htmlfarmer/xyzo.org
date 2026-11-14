"""Tests for worker/place_disambiguation.py.

Coverage:
  - Bare watchlisted names require a context keyword
  - Already-qualified ("City, ST") strings bypass the watchlist
  - Globally-famous cities are auto-allowed (not on watchlist)
  - Empty/null inputs are no-ops (keep=True, no-op reason)
  - "Man" specifically (the user's reported bug):
      - kept when article mentions Côte d'Ivoire / Ivory Coast / Nigeria
        / West Africa / Tonkpi / Abidjan / Ghana / Guinea / Liberia / etc.
      - dropped when title+body has zero context
      - kept as "qualified" when written as "Man, Côte d'Ivoire"
"""
from __future__ import annotations

import pytest

from worker.place_disambiguation import (
    ENTRIES,
    disambiguate,
    is_qualified,
    watchlisted_names,
)


# ── Empty / no-op cases ─────────────────────────────────────────────
@pytest.mark.parametrize("loc", ["", None, "   "])
def test_empty_or_whitespace_is_noop(loc):
    keep, reason = disambiguate(loc, "anything here")
    assert keep is True
    assert reason in {"empty"}


# ── Globally-famous cities are not on the watchlist ─────────────────
@pytest.mark.parametrize("loc,ctx", [
    ("Paris",    "Eiffel Tower reopened this week."),
    ("Paris",    "City of Light celebrates something."),
    ("London",   "Westminster announces new policy."),
    ("London",   "City across the pond had a busy week."),
    ("Moscow",   "Kremlin spokesman made a statement."),
    ("Tokyo",    "Skytree reopened for visitors."),
    ("New York", "Manhattan had a busy morning."),
    ("Beijing",  "Olympics news coverage everywhere."),
    ("Sydney",   "Harbour Bridge anniversary."),
])
def test_famous_cities_auto_allowed(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True
    assert reason == "not_on_watchlist"


# ── "Man" specifically — the user's reported bug ───────────────────
@pytest.mark.parametrize("ctx", [
    "Flooding near Ivory Coast displaces thousands.",
    "A politician in Nigeria speaks out.",
    "Officials in west africa met in Abidjan.",
    "Trade deal involves Côte d'Ivoire.",
    "The Tonkpi region saw heavy rains.",
    "Nigeria don suffer.",
    "Burkina Faso and Ivory Coast held talks.",
    "Ghana and Liberia cooperation announced.",
])
def test_man_kept_with_country_or_region_context(ctx):
    keep, reason = disambiguate("Man", ctx)
    assert keep is True
    assert reason.startswith("context_matched")
    assert "Man" in reason


@pytest.mark.parametrize("ctx", [
    "The new policy was announced today.",
    "Lorem ipsum dolor sit amet.",
    "Annual festival in the village.",
    "Breaking news: something happened.",
    "",
    "The quarterback threw for 300 yards.",
])
def test_man_dropped_without_context(ctx):
    keep, reason = disambiguate("Man", ctx)
    assert keep is False
    assert reason.startswith("no_context")


@pytest.mark.parametrize("loc", [
    "Man, Côte d'Ivoire",
    "Man, Ivory Coast",
    "Man, CI",
    "man, côte d'ivoire",
])
def test_man_with_comma_qualifier_is_kept(loc):
    keep, reason = disambiguate(loc, "anything at all")
    assert keep is True
    assert reason == "qualified"


# ── Other watchlisted names — keep-if-context, drop-without ────────
def test_springfield_kept_illinois():
    keep, _ = disambiguate("Springfield", "Illinois governor signed the bill.")
    assert keep is True


def test_springfield_kept_simpson_culture():
    keep, _ = disambiguate("Springfield", "Simpsons character celebrates anniversary.")
    assert keep is True


def test_springfield_dropped_no_context():
    keep, reason = disambiguate("Springfield", "Weather across the country varied.")
    assert keep is False
    assert "Springfield" in reason


def test_memphis_kept_tennessee():
    keep, _ = disambiguate("Memphis", "The Tennessee titans won big.")
    assert keep is True


def test_memphis_kept_egypt():
    keep, _ = disambiguate("Memphis", "Ancient Egypt exhibit at the museum.")
    assert keep is True


def test_memphis_dropped_no_context():
    keep, _ = disambiguate("Memphis", "The concert at the arena last night.")
    assert keep is False


def test_cordoba_kept_argentina():
    keep, _ = disambiguate("Cordoba", "Argentine president visited the region.")
    assert keep is True


def test_cordoba_dropped_no_context():
    keep, _ = disambiguate("Cordoba", "Annual festival in the village.")
    assert keep is False


def test_portland_kept_pdx():
    keep, _ = disambiguate("Portland", "PDX airport saw record traffic.")
    assert keep is True


def test_portland_dropped_no_state():
    keep, _ = disambiguate("Portland", "Local man arrested for robbery.")
    assert keep is False


def test_adelaide_kept_australia():
    keep, _ = disambiguate("Adelaide", "A new bar opened in Adelaide, Australia.")
    assert keep is True


def test_adelaide_dropped_without_au():
    keep, _ = disambiguate("Adelaide", "A new bar opened in Adelaide.")
    assert keep is False


# ── Qualified ("City, ST") strings bypass the watchlist ─────────────
def test_qualified_bypasses_watchlist():
    """Even watchlisted names, when written with a state qualifier,
    keep their qualifier (no double-check)."""
    keep, reason = disambiguate("Paris, Texas", "Article has no related context.")
    assert keep is True
    assert reason == "qualified"

    keep, reason = disambiguate("Moscow, Idaho", "Restaurants opened in the city.")
    assert keep is True
    assert reason == "qualified"


# ── is_qualified ────────────────────────────────────────────────────
@pytest.mark.parametrize("s,expected", [
    ("Paris, Texas",        True),
    ("Paris,Texas",         True),
    ("Paris",               False),
    ("",                    False),
    ("Los, Angeles, CA",    True),
])
def test_is_qualified(s, expected):
    assert is_qualified(s) is expected


# ── Watchlist shape / regression guards ─────────────────────────────
def test_watchlist_has_expected_man_entry():
    assert "man" in ENTRIES
    assert "Côte d'Ivoire" in ENTRIES["man"]["label"]


# ── New Disambiguation Tests: Common Words, Politicians, Vehicles ──
@pytest.mark.parametrize("loc,ctx", [
    ("Man", "Monetochka Song Removed From Russian Screenings of New 'Spider-Man' Film"),
    ("Man", "Florida man arrested after police chase"),
    ("Man", "Chinese man admits to scattering murder victim's remains"),
    ("Man", "31-year-old man accused of stalking Sabrina Carpenter"),
    ("Man", "US Capitol Police arrest man with guillotine in pickup truck"),
])
def test_man_common_phrases_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Alexandria", "Alexandria Ocasio-Cortez rejoins DSA after membership lapse"),
    ("Alexandria", "Rep. Alexandria Ocasio-Cortez speaks at press conference"),
    ("Alexandria", "Congresswoman Alexandria votes on the new bill"),
    ("Alexandria, EG", "Alexandria Ocasio-Cortez highlights climate change policy"),
])
def test_alexandria_politician_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Alexandria", "Historic museum exhibition opens in Alexandria, Egypt near the Nile."),
    ("Alexandria", "Archaeologists discover ancient ruins off the coast of Alexandria, Egypt."),
])
def test_alexandria_egypt_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True
    assert "context_matched" in reason or "qualified" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Jordan", "Michael Jordan's legendary 1998 jersey sells at auction"),
    ("Jordan", "Air Jordan 1 Retro High OG sneaker release date announced"),
    ("Jordan", "Jordan Poole scores 30 points in NBA game"),
])
def test_jordan_sports_person_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Jordan", "Trump promises strong response after attack on US base in Jordan."),
    ("Jordan", "King Abdullah of Jordan meets with leaders in Amman."),
])
def test_jordan_country_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Van", "Italy arrests Frenchman after anti-tank missiles found in delivery van"),
    ("Van", "Onder het oog van Diderot schittert Marguerite Duras"),
    ("Van", "How Eloy van Hal's Dementia Village Is Transforming Patient Care"),
    ("Van", "Four children fatally knocked down by moving van near town"),
])
def test_van_vehicle_or_dutch_word_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Van", "Lake Van in eastern Turkey sees record low water levels."),
    ("Van", "Archaeological excavation in Van province, Türkiye reveals Urartian fortress."),
])
def test_van_turkey_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Sur", "Apple 'Surprise and Shine' event announced for September 9"),
    ("Sur", "Leaker says iPhone Ultra will come in these colors with one surprise"),
    ("Sur", "Prospérité : le Maroc 76e sur 161 pays, l'éducation reste son point faible"),
    ("Sur", "Corea del Sur aprueba nuevo presupuesto nacional"),
])
def test_sur_common_word_or_spanish_south_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Sur", "Port city of Sur in Oman hosts traditional dhow sailing festival."),
    ("Sur", "Heavy rain hits Sharqiyah region near Sur, Oman."),
])
def test_sur_oman_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Ise", "YKS'de ilk 1000'e giren adaylardan 490'ı tıp tercih ederken eşit ağırlıkta girenler ise en fazla hukuk seçti."),
    ("Ise", "WFP: Gazze'de nüfusun 3'te 2'si hala acil durum seviyesinde açlıkla karşı karşıya."),
])
def test_ise_turkish_conjunction_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Ise", "Mie Prefecture in Japan hosts the historic Ise Grand Shrine."),
    ("Ise, JP", "Tourists visit Ise, Japan for traditional festivals."),
])
def test_ise_japan_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Lira", "SGK prim borçlarına yönelik 183,3 milyar liralık borç taksitlendirildi."),
    ("Lira", "Turkish Lira gains value against the US dollar after central bank meeting."),
])
def test_lira_currency_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Kisi", "Gülistan Doku soruşturmasında 1 kişi daha tutuklandı."),
    ("Kisi", "Mahkemeye çıkarılan 2 kadın şüpheliden biri tutuklandı."),
])
def test_kisi_turkish_person_word_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Toda", "Tienen seis hijos y viven en la selva: Los más pequeños aprenden en casa, preparan la tierra y cuidan a los animales."),
    ("Toda", "Toda la familia Porter cambió su rutina urbana en Estados Unidos por una vida autosustentable en el Amazonas ecuatoriano."),
])
def test_toda_spanish_word_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Toda", "Saitama Prefecture in Japan includes Toda City near Tokyo."),
    ("Toda, JP", "Fireworks festival held in Toda, Japan."),
])
def test_toda_japan_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Aba", "La familia trabajaba y preparaba la tierra todos los días."),
])
def test_aba_spanish_word_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Koga", "PRAVO IME ILDE ŠAULIĆ Arapskog je porekla, niko koga poznajete se ne zove ovako."),
    ("Koga", "Nije znao za koga je pripremila iznenađenje u restoranu."),
])
def test_koga_serbian_word_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Koga", "Ibaraki Prefecture in Japan includes Koga City near Tone River."),
    ("Koga, JP", "Cherry blossom festival celebrated in Koga, Japan."),
])
def test_koga_japan_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Split", "iTunes Explained: Features, Uses, What Changed"),
    ("Split", "Perplexity's Hybrid Compute splits sensitive tasks between cloud and local AI"),
    ("Split", "COLLPLANT ANNOUNCES REVERSE SHARE SPLIT"),
    ("Split", "Tech bosses press G20 to build data centers, but split on risk"),
    ("Split", "Zelenskyy dismisses talks of wartime polls over 'split' Ukraine fears"),
    ("Split, HR", "iTunes Explained: Features, Uses, What Changed"),
    ("Split, HR", "Perplexity's Hybrid Compute splits sensitive tasks between cloud and local AI"),
])
def test_split_word_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Split", "Tourism soars in Split, Croatia along the Dalmatian coast."),
    ("Split", "Hajduk Split secures victory in Croatian football league."),
    ("Split, HR", "Heavy rain causes flooding in Split, Croatia near the Adriatic."),
])
def test_split_croatia_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Addison", "GMN Weather Sketch: Addison drawing submitted by viewer"),
    ("Addison", "Weather Sketch for September 4th: Addison"),
    ("Addison", "Addison Rae released a new song today"),
    ("Addison", "Local news update without any state specified"),
])
def test_addison_rejected(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Addison", "Community board meets in Addison, Illinois to discuss budget."),
    ("Addison", "Addison, TX village council approves new park."),
    ("Addison, IL", "Severe storms hit Addison, IL near Chicago."),
])
def test_addison_kept(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


def test_watchlisted_names_is_sorted_and_no_commas():
    names = watchlisted_names()
    assert names == sorted(names)
    assert all("," not in n for n in names)
    assert "man" in names
    assert "alexandria" in names
    assert "jordan" in names
    assert "van" in names
    assert "sur" in names
    assert "ise" in names
    assert "lira" in names
    assert "kisi" in names
    assert "toda" in names
    assert "aba" in names
    assert "koga" in names


def test_all_entries_have_patterns():
    for key, entry in ENTRIES.items():
        assert entry["patterns"] or entry.get("reject_patterns"), f"entry {key!r} has no patterns"


@pytest.mark.parametrize("loc,ctx", [
    ("Tema", "Rosy Cueva estrena su sexto tema 'Te solté'"),
    ("Tema", "ONU. 'Restaurar confiança' é o tema da 81ª Assembleia-Geral"),
    ("Tema", "Emilio Monzó: 'Este es un Gobierno bulímico, se atraganta con un tema y lo expulsa'"),
    ("Tema", "Biotech Is Popping: Yuri Khodjamirian, CIO at Tema ETFs says"),
    ("Tema", "Discutieron sobre este tema en el congreso"),
    ("Tema", "Un gran tema musical de rock latinoamericano"),
    ("Tema", "El debate sobre temas ambientales continuó hoy"),
    ("Tema", "Weather forecast for the weekend across the country"),
    ("temas", "Muchos temas para tratar en la sesión de hoy"),
])
def test_tema_rejected_on_topic_and_no_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("Tema", "Law student killed in hit-and-run on Tema Motorway; family offers GH¢50,000 bounty"),
    ("Tema", "Ghana : un port à Mpakadan prévu pour désengorger Tema et desservir le Sahel"),
    ("Tema", "Community engagement was held at Tema Newtown in Greater Accra"),
    ("Tema", "Ghana Oil Refinery located in Tema announced changes"),
    ("Tema, GH", "Port operations resume in Tema, GH after weather delays"),
    ("Tema, Ghana", "New logistics hub opens in Tema, Ghana"),
])
def test_tema_kept_with_ghana_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("San Bruno", "MrBeast surprises Kansas school. Watch the full video on YouTube!"),
    ("San Bruno", "DefCon security researcher shares tutorial via his YouTube channel"),
    ("San Bruno", "Rusija dala Nemackoj rok da zatvori konzulat u Sankt Peterburgu"),
    ("San Bruno", "Dogovorena lokacija za novu crkvu u Indjiji"),
    ("San Bruno, US", "La nouvelle paranoia de l'AI slop. Subscribe on YouTube."),
    ("San Bruno", "Breaking tech news without any state or regional context"),
])
def test_san_bruno_rejected_without_context_or_youtube_rejection(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False
    assert "rejected_by_pattern" in reason or "no_context" in reason


@pytest.mark.parametrize("loc,ctx", [
    ("San Bruno", "City of San Bruno announces public library renovations in San Mateo County."),
    ("San Bruno", "Housing development proposed near San Bruno Caltrain station in the Bay Area."),
    ("San Bruno, CA", "San Bruno, CA police department investigates robbery near El Camino Real."),
    ("San Bruno", "Wildfire smoke reaches San Bruno, California from northern fires."),
])
def test_san_bruno_kept_with_california_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("San Mateo", "¿A qué hora es el lanzamiento de 'GTA VI' en México? PlayStation dio una nueva noticia."),
    ("San Mateo", "Subastan consolas PlayStation 5 desde $350.000: remate de la ARCA."),
    ("San Mateo", "GTA 6 ganha controles especiais no PlayStation 5."),
    ("San Mateo", "Latest gaming news on PS5 and Xbox console sales worldwide."),
])
def test_san_mateo_rejected_on_playstation_or_no_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("San Mateo", "New transit center opens in San Mateo, California along El Camino Real."),
    ("San Mateo, CA", "San Mateo County health officials announce new clinic."),
    ("San Mateo", "Barangay election results in San Mateo, Rizal in the Philippines."),
])
def test_san_mateo_kept_with_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Pueblo", "El pueblo gallego de 400 habitantes donde se celebró el festival rural."),
    ("Pueblo", "Defensoría del Pueblo da seguimiento a condiciones en hospital de Panamá."),
    ("Pueblo", "Reclaman los derechos del pueblo indígena en la asamblea."),
    ("Pueblo", "El presidente habló para todo el pueblo en cadena nacional."),
])
def test_pueblo_rejected_on_spanish_noun(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("Pueblo", "Steel mill expansion in Pueblo, Colorado brings new jobs."),
    ("Pueblo, CO", "Severe hail damages cars across Pueblo County in the Front Range."),
    ("Pueblo", "Arkansas River levels rise near the city of Pueblo after mountain runoff."),
])
def test_pueblo_kept_with_colorado_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Mesa", "Gobierno acuerda reunión en la mesa de diálogo con transportistas."),
    ("Mesa", "Consulte su lugar de votación y la mesa electoral asignada."),
    ("Mesa", "EU suspendovala uvoz brazilskog mesa zbog novih sanitarnih propisa."),
    ("Mesa", "La mesa directiva del congreso sesionará mañana temprano."),
])
def test_mesa_rejected_on_table_or_meat(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("Mesa", "Police in Mesa, Arizona arrest suspect after highway chase."),
    ("Mesa, AZ", "New semiconductor campus planned in Mesa in the East Valley near Phoenix."),
    ("Mesa", "Maricopa County community college campus expands in the city of Mesa."),
])
def test_mesa_kept_with_arizona_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Fez", "Rumo e Bunge negociam governança; empresa fez declarações ao mercado."),
    ("Fez", "Filmes na Netflix: série gótica fez muito sucesso na estreia."),
    ("Fez", "Golpista se passa por médico e fez vítimas em hospitais do Paraná."),
    ("Fez", "He wore a red fez hat to the costume party."),
])
def test_fez_rejected_on_portuguese_verb_or_hat(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("Fez", "Historic university in Fez, Morocco undergoes major restoration."),
    ("Fez, MA", "Artisans in the ancient medina of Fez welcome tourists to Fès-Meknès."),
    ("Fez", "Moroccan ministry announces new railway link connecting Fez and Rabat."),
])
def test_fez_kept_with_morocco_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Libertad", "Quedan en libertad condicional 32 tripulantes tras fallo judicial."),
    ("Libertad", "Defienden la libertad de expresión y la libertad de prensa en el foro."),
    ("Libertad", "Manifestantes exigen libertad para los detenidos políticos."),
])
def test_libertad_rejected_on_spanish_freedom(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("Libertad", "Coastal fishermen in Libertad, Antique receive government boats in the Philippines."),
    ("Libertad", "Hospital de Santa Elena atiende emergencias en La Libertad, Ecuador."),
    ("Libertad", "Nuevas obras de pavimentación en Libertad, Buenos Aires."),
])
def test_libertad_kept_with_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Poblacion", "Bbva prevé que la pobreza en la población aumentará para 2040."),
    ("Poblacion", "Censo de población revela caída en la tasa de natalidad del país."),
    ("Poblacion", "Programas de salud dirigidos a la población vulnerable del municipio."),
])
def test_poblacion_rejected_on_spanish_population(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("Poblacion", "Barangay Poblacion in Makati announces community fiesta schedule in the Philippines."),
    ("Poblacion, PH", "Police officers patrol streets of Poblacion, Makati."),
])
def test_poblacion_kept_with_philippines_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


@pytest.mark.parametrize("loc,ctx", [
    ("Hub", "China's coal hub Shanxi emerges from floods, easing supply concerns."),
    ("Hub", "Satya Niketan building collapse exposes student hub housing crisis."),
    ("Hub", "Singapore continues to strengthen its position as an international aviation hub."),
    ("Hub", "Regional green hydrogen hub receives $1B in federal infrastructure funding."),
])
def test_hub_rejected_on_transport_or_tech_hub(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is False


@pytest.mark.parametrize("loc,ctx", [
    ("Hub", "Water levels in Hub Dam rise following monsoon rains in Balochistan, Pakistan."),
    ("Hub, PK", "Industrial estate in Hub tehsil Lasbela district faces power outage."),
])
def test_hub_kept_with_pakistan_context(loc, ctx):
    keep, reason = disambiguate(loc, ctx)
    assert keep is True


# ══════════════════════════════════════════════════════════════════════
# SOURCE COUNTRY PRIOR TESTS (Sep 21 addition)
# ══════════════════════════════════════════════════════════════════════

# ── Virginia: US source should default to US Virginia ──────────────────
def test_virginia_us_source_default():
    """US source mentioning Virginia with no context should default to US Virginia."""
    keep, reason = disambiguate("Virginia", "Virginia governor announced new policy.", source_country="US")
    assert keep is True, f"Expected keep=True for US source, got {reason}"
    assert "source_country_defaulted" in reason


def test_virginia_za_source_requires_context():
    """ZA source mentioning Virginia without SA context should be rejected."""
    keep, reason = disambiguate("Virginia", "Virginia announced new policy.", source_country="ZA")
    assert keep is False, f"Expected keep=False for ZA source without context, got {reason}"


def test_virginia_za_source_with_sa_context():
    """ZA source mentioning Virginia WITH SA context should be accepted."""
    keep, reason = disambiguate("Virginia", "Virginia in the Free State of South Africa announced.", source_country="ZA")
    assert keep is True


def test_virginia_us_source_with_va_context():
    """US source with explicit US state context should still work.
    
    Note: "Richmond Virginia" is in the reject_patterns for virginia (ZA version)
    because it's a city-within-state reference, not a state reference.
    """
    # Using "Virginia governor" which is clearly US state context
    keep, reason = disambiguate("Virginia", "Virginia governor announced new policy.", source_country="US")
    assert keep is True


# ── Alexandria: US vs Egypt ──────────────────────────────────────────
def test_alexandria_us_source_default():
    """US source mentioning Alexandria with no context should default to US Alexandria (VA)."""
    keep, reason = disambiguate("Alexandria", "Alexandria city council announced.", source_country="US")
    assert keep is True
    assert "source_country_defaulted" in reason


def test_alexandria_eg_source_default():
    """EG source mentioning Alexandria with no context should default to Egyptian Alexandria."""
    keep, reason = disambiguate("Alexandria", "Alexandria port sees increased traffic.", source_country="EG")
    assert keep is True
    assert "source_country_defaulted" in reason


# ── Memphis: US vs Egypt ──────────────────────────────────────────────
def test_memphis_us_source_default():
    """US source mentioning Memphis with Tennessee context should default to Memphis, TN."""
    keep, reason = disambiguate("Memphis", "Memphis in Tennessee saw developments.", source_country="US")
    assert keep is True


def test_memphis_eg_source_requires_context():
    """EG source mentioning Memphis without Egypt context should be rejected."""
    keep, reason = disambiguate("Memphis", "Memphis ancient ruins opened.", source_country="EG")
    assert keep is False


# ── Santiago: multiple countries ─────────────────────────────────────
def test_santiago_cl_source_default():
    """CL source defaulting to Santiago, Chile."""
    keep, reason = disambiguate("Santiago", "Santiago metro expansion announced.", source_country="CL")
    assert keep is True


def test_santiago_do_source_requires_context():
    """DO source without DR context should be rejected."""
    keep, reason = disambiguate("Santiago", "Santiago local festival announced.", source_country="DO")
    assert keep is False


# ══════════════════════════════════════════════════════════════════════
# COMMA-LESS QUALIFIER TESTS (Sep 21 addition)
# ══════════════════════════════════════════════════════════════════════

# ── "City of X" pattern ──────────────────────────────────────────────
@pytest.mark.parametrize("loc", [
    "City of Springfield",
    "city of memphis",
    "CITY OF KARACHI",
    "City of Lahore",
])
def test_city_of_pattern_is_qualified(loc):
    """'City of X' should be qualified (bypass watchlist)."""
    assert is_qualified(loc) is True, f"{loc} should be qualified"


# ── "X TN" / US state abbreviation pattern ───────────────────────────
@pytest.mark.parametrize("loc,expected", [
    ("Memphis TN", True),
    ("Springfield IL", True),
    ("Nashville TN", True),
    ("Austin TX", True),
    ("Phoenix AZ", True),
    ("memphis tn", True),
    ("Memphis", False),  # no abbrev
])
def test_state_abbrev_pattern_is_qualified(loc, expected):
    """'X ST' with US state abbreviation should be qualified."""
    assert is_qualified(loc) is expected, f"is_qualified({loc!r}) = {not expected}, expected {expected}"


# ── "X city" pattern (single word) ─────────────────────────────────
@pytest.mark.parametrize("loc,expected", [
    ("Springfield city", True),  # single word before "city"
    ("Tampa city", True),
    ("Raleigh city", True),
    ("New York city", False),  # multi-word
    ("Memphis city", True),
])
def test_x_city_pattern_is_qualified(loc, expected):
    """'X city' with single word X should be qualified."""
    assert is_qualified(loc) is expected, f"is_qualified({loc!r}) = {not expected}, expected {expected}"


# ── "Town of X" pattern ─────────────────────────────────────────────
@pytest.mark.parametrize("loc", [
    "Town of Springfield",
    "town of memphis",
    "Town of Atlanta",
])
def test_town_of_pattern_is_qualified(loc):
    """'Town of X' should be qualified."""
    assert is_qualified(loc) is True


# ── Qualified locations bypass watchlist even with no context ───────────
def test_city_of_bypasses_watchlist():
    """'City of Springfield' should bypass watchlist even without context."""
    keep, reason = disambiguate("City of Springfield", "Some generic news happened.")
    assert keep is True
    assert reason == "qualified"


def test_state_abbrev_bypasses_watchlist():
    """'Memphis TN' should bypass watchlist even without context."""
    keep, reason = disambiguate("Memphis TN", "Some news happened.")
    assert keep is True
    assert reason == "qualified"


# ══════════════════════════════════════════════════════════════════════
# REJECT PATTERNS STILL APPLY TO QUALIFIED LOCATIONS
# ══════════════════════════════════════════════════════════════════════

def test_qualified_but_reject_pattern_still_rejects():
    """Qualified locations should still be rejected if reject_pattern matches."""
    # "Man, Côte d'Ivoire" is qualified BUT YouTube context should still reject
    keep, reason = disambiguate(
        "Man, Côte d'Ivoire",
        "Watch this video on YouTube about Spider-Man!"
    )
    assert keep is False, f"Expected rejection due to YouTube/Spider-Man context, got {reason}"
    assert "rejected_by_pattern" in reason


# ══════════════════════════════════════════════════════════════════════
# QUALIFIED WITH COMMA OVERRIDE TESTS (Sep 21 addition)
# ══════════════════════════════════════════════════════════════════════

# ── Cali: CO vs US (California) ───────────────────────────────────────
def test_cali_co_qualified_with_us_source_defaults_to_us():
    """'Cali, CO' from US source should override to US (California)."""
    keep, reason = disambiguate("Cali, CO", "", source_country="US")
    assert keep is True
    assert "source_country_defaulted:US" in reason


def test_cali_co_qualified_with_co_source_keeps_co():
    """'Cali, CO' from CO source should keep Colombia."""
    keep, reason = disambiguate("Cali, CO", "", source_country="CO")
    assert keep is True
    assert "source_country_defaulted:CO" in reason


def test_cali_co_qualified_with_us_source_with_california_context():
    """'Cali, CO' from US source with California context should override to US."""
    keep, reason = disambiguate(
        "Cali, CO",
        "California insurance commissioner race",
        source_country="US"
    )
    assert keep is True
    assert "source_country_defaulted:US" in reason


# ── Santa Fe: AR vs US (NM) ──────────────────────────────────────────
def test_santa_fe_ar_qualified_with_us_source_defaults_to_us():
    """'Santa Fe, AR' from US source should override to US (New Mexico)."""
    keep, reason = disambiguate("Santa Fe, AR", "", source_country="US")
    assert keep is True
    assert "source_country_defaulted:US" in reason


def test_santa_fe_ar_qualified_with_ar_source_keeps_ar():
    """'Santa Fe, AR' from AR source should keep Argentina."""
    keep, reason = disambiguate("Santa Fe, AR", "", source_country="AR")
    assert keep is True
    assert "source_country_defaulted:AR" in reason


def test_santa_fe_ar_qualified_with_us_source_with_context():
    """'Santa Fe, AR' from US source with NM context should override to US."""
    keep, reason = disambiguate(
        "Santa Fe, AR",
        "Santa Fe New Mexican newspaper reports",
        source_country="US"
    )
    assert keep is True
    assert "source_country_defaulted:US" in reason



