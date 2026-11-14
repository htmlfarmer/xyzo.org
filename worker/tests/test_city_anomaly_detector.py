"""Unit tests for worker.city_anomaly_detector."""
import pytest
from worker.city_anomaly_detector import (
    extract_country_code,
    extract_bare_city_name,
    detect_simple_lang,
    scan_location,
)


def test_extract_country_code():
    assert extract_country_code("San Bruno, US") == "US"
    assert extract_country_code("Fez, MA") == "MA"
    assert extract_country_code("Pueblo, CO, US") == "US"
    assert extract_country_code("Tokyo", explicit_country="JP") == "JP"
    assert extract_country_code("Random Place") is None


def test_extract_bare_city_name():
    assert extract_bare_city_name("San Bruno, US") == "San Bruno"
    assert extract_bare_city_name("Mesa, US") == "Mesa"
    assert extract_bare_city_name("Pueblo, US") == "Pueblo"
    assert extract_bare_city_name("Fez, MA") == "Fez"
    assert extract_bare_city_name("London") == "London"


def test_detect_simple_lang():
    assert detect_simple_lang("El gobierno de la república anunció nuevas medidas") == "es"
    assert detect_simple_lang("Não foi possível carregar as informações do sistema") == "pt"
    assert detect_simple_lang("Le président de la république a prononcé un discours") == "fr"
    assert detect_simple_lang("Das ist ein sehr wichtiges Thema für Deutschland") == "de"
    assert detect_simple_lang("Major severe storm warning issued for city center") == "en"


def test_scan_location_flags_youtube_in_san_bruno():
    loc = {"id": 1723, "place_name": "San Bruno, US", "country": "US", "lat": 37.63, "lng": -122.41}
    articles = [
        {"id": 1, "title": "MrBeast surprises Kansas school on YouTube", "body": "Watch the full video on YouTube today!", "source_country": "US"},
        {"id": 2, "title": "DefCon security tutorial posted to YouTube", "body": "Subscribe to our YouTube channel.", "source_country": "US"},
        {"id": 3, "title": "Viral music clip breaks record on YouTube", "body": "Millions watched the video on YouTube.", "source_country": "US"},
    ]
    report = scan_location(loc, articles)
    assert report is not None
    assert report.bogus_articles == 3
    assert report.valid_articles == 0
    assert report.severity in ("high", "medium")
    assert report.anomaly_score >= 0.70


def test_scan_location_preserves_legitimate_san_bruno_stories():
    loc = {"id": 1723, "place_name": "San Bruno, US", "country": "US", "lat": 37.63, "lng": -122.41}
    articles = [
        {"id": 10, "title": "City of San Bruno announces public library renovations in San Mateo County", "body": "California officials attended the ceremony.", "source_country": "US"},
        {"id": 11, "title": "Housing development proposed near San Bruno Caltrain station in the Bay Area", "body": "The Peninsula project will add 200 units.", "source_country": "US"},
        {"id": 12, "title": "Wildfire smoke reaches San Bruno, California from northern fires", "body": "Bay Area air quality advisory issued.", "source_country": "US"},
    ]
    report = scan_location(loc, articles)
    # Legitimate stories with proper context should not be flagged as an anomaly
    assert report is None


def test_scan_location_flags_playstation_in_san_mateo():
    loc = {"id": 1719, "place_name": "San Mateo, US", "country": "US", "lat": 37.56, "lng": -122.32}
    articles = [
        {"id": 20, "title": "¿A qué hora es el lanzamiento de ‘GTA VI’ en México? Esto sabemos", "body": "PlayStation dio una nueva noticia sobre el estreno.", "source_country": "MX"},
        {"id": 21, "title": "Subastan consolas PlayStation 5 desde $350.000 en Buenos Aires", "body": "Remate oficial de la ARCA de consolas PS5.", "source_country": "AR"},
        {"id": 22, "title": "GTA 6 ganha controles especiais no PlayStation 5", "body": "Sony anunciou novos controles DualSense para o console.", "source_country": "BR"},
    ]
    report = scan_location(loc, articles)
    assert report is not None
    assert report.bogus_articles == 3
    assert report.foreign_source_ratio == 1.0
    assert report.language_divergence_ratio == 1.0
    assert report.severity == "high"


def test_scan_location_flags_pueblo_spanish_homonym():
    loc = {"id": 1750, "place_name": "Pueblo, US", "country": "US", "lat": 38.25, "lng": -104.60}
    articles = [
        {"id": 30, "title": "El pueblo gallego de 400 habitantes donde Pedro Alonso pasó su infancia", "body": "Un hermoso pueblo rural para una escapada.", "source_country": "ES"},
        {"id": 31, "title": "Defensoría del Pueblo da seguimiento a condiciones de atención en hospital", "body": "Funcionarios del pueblo visitaron las instalaciones en Panamá.", "source_country": "PA"},
        {"id": 32, "title": "El presidente habló para todo el pueblo en cadena nacional", "body": "Mensaje transmitido a todo el pueblo.", "source_country": "PE"},
    ]
    report = scan_location(loc, articles)
    assert report is not None
    assert report.bogus_articles == 3
    assert report.anomaly_score >= 0.75
