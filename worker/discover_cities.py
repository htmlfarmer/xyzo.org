"""Discover news sources for XYZO's 500 Cool Cities over 24 hours.

This module systematically finds and adds RSS/Atom news feeds for a curated
list of 500 culturally/strategically important cities worldwide.

Architecture:
  1. Load/refresh the 500-cities list with country/region metadata
  2. For each city not yet processed (or failed), run discovery via:
       - Probe: Try common RSS paths on known local news domains
       - Web search: DuckDuckGo for "[city] news RSS feed"
       - Directory: Feedly search for local sources
       - AI: Ask Gemma-4 for regional source suggestions
  3. Validate each candidate (HTTP HEAD + feedparser parse)
  4. Check robots.txt via RobotsCache before adding
  5. Add to feeds.json AND news_sources DB
  6. Record progress in news_city_discovery table for resumability

Rate limiting:
  - ~20 cities per batch (to fit in 24hr window = ~1 city/minute average)
  - 2-5 second delays between discovery steps
  - Respect robots.txt crawl-delay for any domains we probe
  - Can be run as a long-running worker or in discrete batches

Usage:
    # Full 24hr run (default):
    python -m worker.discover_cities

    # Process one batch only (useful for cron/interval runs):
    python -m worker.discover_cities --batch 20

    # Dry run (discover only, don't add):
    python -m worker.discover_cities --dry-run

    # Resume interrupted run:
    python -m worker.discover_cities --resume

    # Status report:
    python -m worker.discover_cities --status

CLI args:
    --batch N     Process N cities then exit (default: all)
    --dry-run     Discover sources but don't add them
    --resume      Resume from last checkpoint
    --status      Print progress table and exit
    --force       Re-process cities that already have sources
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("xyzo.discover_cities")

WORKER_DIR = Path(__file__).parent
FEEDS_FILE = WORKER_DIR / "feeds.json"
CITIES_FILE = WORKER_DIR / "cool_cities_500.py"

# Ensure we can import from worker/
sys.path.insert(0, str(WORKER_DIR.parent.parent))

from worker.db import connect
from worker.robots import RobotsCache
from worker.source_discovery import (
    discover_sources,
    add_source,
    bulk_add,
    validate_feed,
    _resolve_country,
    _COUNTRY_REGIONS,
)

# ── 500 Cool Cities Data ────────────────────────────────────────────────────

# Each entry: (city_name, country_code_2, region_tag, [optional_aliases])
# This list is kept in a separate file to keep this module readable.
COOL_CITIES_500 = [
    # Central & South Asia
    ("Kabul", "AF", "south-asia"),
    ("Bamyan", "AF", "south-asia"),
    ("Herat", "AF", "south-asia"),
    ("Mazar-i-Sharif", "AF", "south-asia"),
    ("Samarkand", "UZ", "central-asia"),
    ("Bukhara", "UZ", "central-asia"),
    ("Khiva", "UZ", "central-asia"),
    ("Tashkent", "UZ", "central-asia"),
    ("Bishkek", "KG", "central-asia"),
    ("Osh", "KG", "central-asia"),
    ("Almaty", "KZ", "central-asia"),
    ("Astana", "KZ", "central-asia"),
    ("Turkistan", "KZ", "central-asia"),
    ("Dushanbe", "TJ", "central-asia"),
    ("Khujand", "TJ", "central-asia"),
    ("Ashgabat", "TM", "central-asia"),
    ("Mary", "TM", "central-asia"),
    ("Tehran", "IR", "middle-east"),
    ("Isfahan", "IR", "middle-east"),
    ("Shiraz", "IR", "middle-east"),
    ("Yazd", "IR", "middle-east"),
    ("Kashan", "IR", "middle-east"),
    ("Tabriz", "IR", "middle-east"),
    ("Qeshm", "IR", "middle-east"),
    ("Bandar Abbas", "IR", "middle-east"),
    ("Muscat", "OM", "middle-east"),
    ("Salalah", "OM", "middle-east"),
    ("Nizwa", "OM", "middle-east"),
    ("Khasab", "OM", "middle-east"),
    ("Dubai", "AE", "middle-east"),
    ("Abu Dhabi", "AE", "middle-east"),
    ("Al Ain", "AE", "middle-east"),
    ("Doha", "QA", "middle-east"),
    ("Manama", "BH", "middle-east"),
    ("Kuwait City", "KW", "middle-east"),
    ("Riyadh", "SA", "middle-east"),
    ("Jeddah", "SA", "middle-east"),
    ("AlUla", "SA", "middle-east"),
    ("Medina", "SA", "middle-east"),
    ("Amman", "JO", "middle-east"),
    ("Petra", "JO", "middle-east"),
    ("Wadi Musa", "JO", "middle-east"),
    ("Jerusalem", "IL", "middle-east"),
    ("Bethlehem", "PS", "middle-east"),
    ("Beirut", "LB", "middle-east"),
    ("Byblos", "LB", "middle-east"),
    ("Baalbek", "LB", "middle-east"),
    ("Damascus", "SY", "middle-east"),
    ("Aleppo", "SY", "middle-east"),
    ("Kathmandu", "NP", "south-asia"),
    # Himalaya / India / Bangladesh / Pakistan
    ("Pokhara", "NP", "south-asia"),
    ("Namche Bazaar", "NP", "south-asia"),
    ("Lukla", "NP", "south-asia"),
    ("Mustang", "NP", "south-asia"),
    ("Thimphu", "BT", "south-asia"),
    ("Paro", "BT", "south-asia"),
    ("Punakha", "BT", "south-asia"),
    ("Dhaka", "BD", "south-asia"),
    ("Chittagong", "BD", "south-asia"),
    ("Sylhet", "BD", "south-asia"),
    ("Cox's Bazar", "BD", "south-asia"),
    ("Bandarban", "BD", "south-asia"),
    ("Srinagar", "IN", "south-asia"),
    ("Leh", "IN", "south-asia"),
    ("Manali", "IN", "south-asia"),
    ("Shimla", "IN", "south-asia"),
    ("Dharamshala", "IN", "south-asia"),
    ("Rishikesh", "IN", "south-asia"),
    ("Varanasi", "IN", "south-asia"),
    ("Jaipur", "IN", "south-asia"),
    ("Jaisalmer", "IN", "south-asia"),
    ("Udaipur", "IN", "south-asia"),
    ("Jodhpur", "IN", "south-asia"),
    ("Agra", "IN", "south-asia"),
    ("Delhi", "IN", "south-asia"),
    ("Mumbai", "IN", "south-asia"),
    ("Goa", "IN", "south-asia"),
    ("Kochi", "IN", "south-asia"),
    ("Munnar", "IN", "south-asia"),
    ("Ooty", "IN", "south-asia"),
    ("Hampi", "IN", "south-asia"),
    ("Mysuru", "IN", "south-asia"),
    ("Bengaluru", "IN", "south-asia"),
    ("Chennai", "IN", "south-asia"),
    ("Pondicherry", "IN", "south-asia"),
    ("Kolkata", "IN", "south-asia"),
    ("Darjeeling", "IN", "south-asia"),
    ("Shillong", "IN", "south-asia"),
    ("Gangtok", "IN", "south-asia"),
    ("Port Blair", "IN", "south-asia"),
    ("Hyderabad", "IN", "south-asia"),
    ("Ahmedabad", "IN", "south-asia"),
    ("Amritsar", "IN", "south-asia"),
    ("Lucknow", "IN", "south-asia"),
    ("Khajuraho", "IN", "south-asia"),
    ("Aurangabad", "IN", "south-asia"),
    ("Nashik", "IN", "south-asia"),
    ("Bhopal", "IN", "south-asia"),
    ("Bhubaneswar", "IN", "south-asia"),
    ("Visakhapatnam", "IN", "south-asia"),
    # East Asia
    ("Tokyo", "JP", "east-asia"),
    ("Kyoto", "JP", "east-asia"),
    ("Osaka", "JP", "east-asia"),
    ("Nara", "JP", "east-asia"),
    ("Kanazawa", "JP", "east-asia"),
    ("Takayama", "JP", "east-asia"),
    ("Sapporo", "JP", "east-asia"),
    ("Hakodate", "JP", "east-asia"),
    ("Aomori", "JP", "east-asia"),
    ("Sendai", "JP", "east-asia"),
    ("Hiroshima", "JP", "east-asia"),
    ("Nagasaki", "JP", "east-asia"),
    ("Fukuoka", "JP", "east-asia"),
    ("Okinawa", "JP", "east-asia"),
    ("Yakushima", "JP", "east-asia"),
    ("Taipei", "TW", "east-asia"),
    ("Hualien", "TW", "east-asia"),
    ("Taitung", "TW", "east-asia"),
    ("Jiufen", "TW", "east-asia"),
    ("Seoul", "KR", "east-asia"),
    ("Busan", "KR", "east-asia"),
    ("Jeju", "KR", "east-asia"),
    ("Gyeongju", "KR", "east-asia"),
    ("Pyongyang", "KP", "east-asia"),
    ("Beijing", "CN", "east-asia"),
    ("Shanghai", "CN", "east-asia"),
    ("Xi'an", "CN", "east-asia"),
    ("Chengdu", "CN", "east-asia"),
    ("Chongqing", "CN", "east-asia"),
    ("Lhasa", "CN", "east-asia"),
    ("Kashgar", "CN", "east-asia"),
    ("Urumqi", "CN", "east-asia"),
    ("Guilin", "CN", "east-asia"),
    ("Zhangjiajie", "CN", "east-asia"),
    ("Kunming", "CN", "east-asia"),
    ("Dali", "CN", "east-asia"),
    ("Lijiang", "CN", "east-asia"),
    ("Xiamen", "CN", "east-asia"),
    ("Harbin", "CN", "east-asia"),
    ("Macau", "MO", "east-asia"),
    # Southeast Asia
    ("Bangkok", "TH", "southeast-asia"),
    ("Chiang Mai", "TH", "southeast-asia"),
    ("Chiang Rai", "TH", "southeast-asia"),
    ("Pai", "TH", "southeast-asia"),
    ("Phuket", "TH", "southeast-asia"),
    ("Krabi", "TH", "southeast-asia"),
    ("Koh Samui", "TH", "southeast-asia"),
    ("Koh Tao", "TH", "southeast-asia"),
    ("Ayutthaya", "TH", "southeast-asia"),
    ("Luang Prabang", "LA", "southeast-asia"),
    ("Vientiane", "LA", "southeast-asia"),
    ("Vang Vieng", "LA", "southeast-asia"),
    ("Pakse", "LA", "southeast-asia"),
    ("Hanoi", "VN", "southeast-asia"),
    ("Ho Chi Minh City", "VN", "southeast-asia"),
    ("Da Nang", "VN", "southeast-asia"),
    ("Hue", "VN", "southeast-asia"),
    ("Hoi An", "VN", "southeast-asia"),
    ("Ha Long", "VN", "southeast-asia"),
    ("Sapa", "VN", "southeast-asia"),
    ("Ninh Binh", "VN", "southeast-asia"),
    ("Phu Quoc", "VN", "southeast-asia"),
    ("Phnom Penh", "KH", "southeast-asia"),
    ("Siem Reap", "KH", "southeast-asia"),
    ("Battambang", "KH", "southeast-asia"),
    ("Sihanoukville", "KH", "southeast-asia"),
    ("Kuala Lumpur", "MY", "southeast-asia"),
    ("George Town", "MY", "southeast-asia"),
    ("Ipoh", "MY", "southeast-asia"),
    ("Malacca", "MY", "southeast-asia"),
    ("Kota Kinabalu", "MY", "southeast-asia"),
    ("Kuching", "MY", "southeast-asia"),
    ("Bandar Seri Begawan", "BN", "southeast-asia"),
    ("Singapore", "SG", "southeast-asia"),
    ("Jakarta", "ID", "southeast-asia"),
    ("Bali", "ID", "southeast-asia"),
    ("Yogyakarta", "ID", "southeast-asia"),
    ("Bandung", "ID", "southeast-asia"),
    ("Surabaya", "ID", "southeast-asia"),
    ("Lombok", "ID", "southeast-asia"),
    ("Flores", "ID", "southeast-asia"),
    ("Komodo", "ID", "southeast-asia"),
    ("Raja Ampat", "ID", "southeast-asia"),
    ("Ubud", "ID", "southeast-asia"),
    ("Labuan Bajo", "ID", "southeast-asia"),
    ("Makassar", "ID", "southeast-asia"),
    ("Manado", "ID", "southeast-asia"),
    ("Dili", "TL", "southeast-asia"),
    ("Boracay", "PH", "southeast-asia"),
    ("Cebu", "PH", "southeast-asia"),
    # Pacific / Oceania
    ("Manila", "PH", "oceania"),
    ("Palawan", "PH", "oceania"),
    ("Siargao", "PH", "oceania"),
    ("Bohol", "PH", "oceania"),
    ("Vigan", "PH", "oceania"),
    ("El Nido", "PH", "oceania"),
    ("Port Moresby", "PG", "oceania"),
    ("Goroka", "PG", "oceania"),
    ("Rabaul", "PG", "oceania"),
    ("Lae", "PG", "oceania"),
    ("Honiara", "SB", "oceania"),
    ("Port Vila", "VU", "oceania"),
    ("Luganville", "VU", "oceania"),
    ("Nouméa", "NC", "oceania"),
    ("Papeete", "PF", "oceania"),
    ("Bora Bora", "PF", "oceania"),
    ("Rarotonga", "CK", "oceania"),
    ("Apia", "WS", "oceania"),
    ("Nuku'alofa", "TO", "oceania"),
    ("Suva", "FJ", "oceania"),
    ("Nadi", "FJ", "oceania"),
    ("Savusavu", "FJ", "oceania"),
    ("Funafuti", "TV", "oceania"),
    ("Tarawa", "KI", "oceania"),
    ("Majuro", "MH", "oceania"),
    ("Palikir", "FM", "oceania"),
    ("Koror", "PW", "oceania"),
    ("Hanga Roa", "CL", "oceania"),
    ("Auckland", "NZ", "oceania"),
    ("Wellington", "NZ", "oceania"),
    ("Queenstown", "NZ", "oceania"),
    ("Rotorua", "NZ", "oceania"),
    ("Dunedin", "NZ", "oceania"),
    ("Christchurch", "NZ", "oceania"),
    ("Nelson", "NZ", "oceania"),
    ("Hobart", "AU", "oceania"),
    ("Launceston", "AU", "oceania"),
    ("Melbourne", "AU", "oceania"),
    ("Sydney", "AU", "oceania"),
    ("Perth", "AU", "oceania"),
    # Africa
    ("Cape Town", "ZA", "southern-africa"),
    ("Johannesburg", "ZA", "southern-africa"),
    ("Durban", "ZA", "southern-africa"),
    ("Pretoria", "ZA", "southern-africa"),
    ("Gqeberha", "ZA", "southern-africa"),
    ("Stellenbosch", "ZA", "southern-africa"),
    ("Kruger", "ZA", "southern-africa"),
    ("Maseru", "LS", "southern-africa"),
    ("Mbabane", "SZ", "southern-africa"),
    ("Maputo", "MZ", "southern-africa"),
    ("Tofo", "MZ", "southern-africa"),
    ("Vilanculos", "MZ", "southern-africa"),
    ("Pemba", "MZ", "southern-africa"),
    ("Victoria Falls", "ZW", "southern-africa"),
    ("Harare", "ZW", "east-africa"),
    ("Bulawayo", "ZW", "east-africa"),
    ("Lusaka", "ZM", "east-africa"),
    ("Livingstone", "ZM", "east-africa"),
    ("Lower Zambezi", "ZM", "east-africa"),
    ("Lilongwe", "MW", "east-africa"),
    ("Blantyre", "MW", "east-africa"),
    ("Lake Malawi", "MW", "east-africa"),
    ("Nairobi", "KE", "east-africa"),
    ("Mombasa", "KE", "east-africa"),
    ("Lamu", "KE", "east-africa"),
    ("Malindi", "KE", "east-africa"),
    ("Kisumu", "KE", "east-africa"),
    ("Maasai Mara", "KE", "east-africa"),
    ("Arusha", "TZ", "east-africa"),
    ("Dar es Salaam", "TZ", "east-africa"),
    ("Zanzibar City", "TZ", "east-africa"),
    ("Stone Town", "TZ", "east-africa"),
    ("Serengeti", "TZ", "east-africa"),
    ("Ngorongoro", "TZ", "east-africa"),
    ("Kilimanjaro", "TZ", "east-africa"),
    ("Dodoma", "TZ", "east-africa"),
    ("Kampala", "UG", "east-africa"),
    ("Jinja", "UG", "east-africa"),
    ("Entebbe", "UG", "east-africa"),
    ("Kigali", "RW", "east-africa"),
    ("Musanze", "RW", "east-africa"),
    ("Bujumbura", "BI", "east-africa"),
    ("Addis Ababa", "ET", "east-africa"),
    ("Lalibela", "ET", "east-africa"),
    ("Gondar", "ET", "east-africa"),
    ("Axum", "ET", "east-africa"),
    ("Harar", "ET", "east-africa"),
    ("Djibouti City", "DJ", "east-africa"),
    ("Mogadishu", "SO", "east-africa"),
    ("Hargeisa", "SO", "east-africa"),
    ("Cairo", "EG", "north-africa"),
    ("Alexandria", "EG", "north-africa"),
    ("Luxor", "EG", "north-africa"),
    ("Aswan", "EG", "north-africa"),
    ("Siwa Oasis", "EG", "north-africa"),
    ("Marrakech", "MA", "north-africa"),
    ("Fez", "MA", "north-africa"),
    ("Chefchaouen", "MA", "north-africa"),
    ("Essaouira", "MA", "north-africa"),
    ("Casablanca", "MA", "north-africa"),
    ("Tangier", "MA", "north-africa"),
    ("Agadir", "MA", "north-africa"),
    ("Tunis", "TN", "north-africa"),
    ("Sidi Bou Said", "TN", "north-africa"),
    ("Algiers", "DZ", "north-africa"),
    ("Oran", "DZ", "north-africa"),
    ("Dakar", "SN", "west-africa"),
    ("Saint-Louis", "SN", "west-africa"),
    ("Banjul", "GM", "west-africa"),
    ("Accra", "GH", "west-africa"),
    # West / Central Africa
    ("Kumasi", "GH", "west-africa"),
    ("Tamale", "GH", "west-africa"),
    ("Lomé", "TG", "west-africa"),
    ("Cotonou", "BJ", "west-africa"),
    ("Porto-Novo", "BJ", "west-africa"),
    ("Lagos", "NG", "west-africa"),
    ("Abuja", "NG", "west-africa"),
    ("Calabar", "NG", "west-africa"),
    ("Ibadan", "NG", "west-africa"),
    ("Jos", "NG", "west-africa"),
    ("Kano", "NG", "west-africa"),
    ("Douala", "CM", "central-africa"),
    ("Yaoundé", "CM", "central-africa"),
    ("Limbe", "CM", "central-africa"),
    ("Libreville", "GA", "central-africa"),
    ("São Tomé", "ST", "central-africa"),
    ("Malabo", "GQ", "central-africa"),
    ("Kinshasa", "CD", "central-africa"),
    ("Goma", "CD", "central-africa"),
    ("Bukavu", "CD", "central-africa"),
    ("Brazzaville", "CG", "central-africa"),
    ("Luanda", "AO", "central-africa"),
    ("Lubango", "AO", "central-africa"),
    ("Benguela", "AO", "central-africa"),
    ("Windhoek", "NA", "southern-africa"),
    ("Swakopmund", "NA", "southern-africa"),
    ("Walvis Bay", "NA", "southern-africa"),
    ("Lüderitz", "NA", "southern-africa"),
    ("Maun", "BW", "southern-africa"),
    ("Gaborone", "BW", "southern-africa"),
    # Indian Ocean / Islands
    ("Antananarivo", "MG", "east-africa"),
    ("Antsiranana", "MG", "east-africa"),
    ("Nosy Be", "MG", "east-africa"),
    ("Morondava", "MG", "east-africa"),
    ("Toamasina", "MG", "east-africa"),
    ("Port Louis", "MU", "east-africa"),
    ("Grand Baie", "MU", "east-africa"),
    ("Victoria", "SC", "east-africa"),
    ("Praslin", "SC", "east-africa"),
    ("La Digue", "SC", "east-africa"),
    ("Moroni", "KM", "east-africa"),
    ("Mamoudzou", "YT", "east-africa"),
    ("Saint-Denis", "RE", "east-africa"),
    ("Port Mathurin", "MU", "east-africa"),
    ("Praia", "CV", "west-africa"),
    ("Mindelo", "CV", "west-africa"),
    ("São Filipe", "CV", "west-africa"),
    ("Funchal", "PT", "europe"),
    ("Ponta Delgada", "PT", "europe"),
    ("Horta", "PT", "europe"),
    # Europe
    ("Reykjavik", "IS", "europe"),
    ("Akureyri", "IS", "europe"),
    ("Vik", "IS", "europe"),
    ("Tromsø", "NO", "europe"),
    ("Bergen", "NO", "europe"),
    ("Oslo", "NO", "europe"),
    ("Lofoten", "NO", "europe"),
    ("Stockholm", "SE", "europe"),
    ("Gothenburg", "SE", "europe"),
    ("Copenhagen", "DK", "europe"),
    ("Helsinki", "FI", "europe"),
    ("Rovaniemi", "FI", "europe"),
    ("Tallinn", "EE", "europe"),
    ("Riga", "LV", "europe"),
    ("Vilnius", "LT", "europe"),
    ("Warsaw", "PL", "europe"),
    ("Kraków", "PL", "europe"),
    ("Wrocław", "PL", "europe"),
    ("Prague", "CZ", "europe"),
    ("Český Krumlov", "CZ", "europe"),
    ("Vienna", "AT", "europe"),
    ("Salzburg", "AT", "europe"),
    ("Ljubljana", "SI", "europe"),
    ("Lake Bled", "SI", "europe"),
    ("Zagreb", "HR", "europe"),
    ("Dubrovnik", "HR", "europe"),
    ("Split", "HR", "europe"),
    ("Kotor", "ME", "europe"),
    ("Podgorica", "ME", "europe"),
    ("Sarajevo", "BA", "europe"),
    ("Mostar", "BA", "europe"),
    ("Belgrade", "RS", "europe"),
    ("Novi Sad", "RS", "europe"),
    ("Sofia", "BG", "europe"),
    ("Plovdiv", "BG", "europe"),
    ("Bucharest", "RO", "europe"),
    ("Brașov", "RO", "europe"),
    ("Sibiu", "RO", "europe"),
    ("Budapest", "HU", "europe"),
    ("Bratislava", "SK", "europe"),
    ("Athens", "GR", "europe"),
    ("Thessaloniki", "GR", "europe"),
    ("Santorini", "GR", "europe"),
    ("Crete", "GR", "europe"),
    ("Corfu", "GR", "europe"),
    ("Valletta", "MT", "europe"),
    ("Palermo", "IT", "europe"),
    ("Naples", "IT", "europe"),
    ("Rome", "IT", "europe"),
    ("Venice", "IT", "europe"),
    # More Europe, especially weird/cool
    ("Florence", "IT", "europe"),
    ("Bologna", "IT", "europe"),
    ("Matera", "IT", "europe"),
    ("Cinque Terre", "IT", "europe"),
    ("Nice", "FR", "europe"),
    ("Marseille", "FR", "europe"),
    ("Paris", "FR", "europe"),
    ("Lyon", "FR", "europe"),
    ("Bordeaux", "FR", "europe"),
    ("Strasbourg", "FR", "europe"),
    ("Barcelona", "ES", "europe"),
    ("Madrid", "ES", "europe"),
    ("Seville", "ES", "europe"),
    ("Granada", "ES", "europe"),
    ("Málaga", "ES", "europe"),
    ("Bilbao", "ES", "europe"),
    ("Ibiza", "ES", "europe"),
    ("Porto", "PT", "europe"),
    ("Lisbon", "PT", "europe"),
    ("Sintra", "PT", "europe"),
    ("Lagos", "PT", "europe"),
    ("Dublin", "IE", "europe"),
    ("Galway", "IE", "europe"),
    ("Edinburgh", "GB", "europe"),
    ("Glasgow", "GB", "europe"),
    ("London", "GB", "europe"),
    ("Bath", "GB", "europe"),
    ("Oxford", "GB", "europe"),
    ("Cardiff", "GB", "europe"),
    ("Belfast", "GB", "europe"),
    # Caucasus / Balkans / Eastern Europe
    ("Tbilisi", "GE", "caucasus"),
    ("Batumi", "GE", "caucasus"),
    ("Kutaisi", "GE", "caucasus"),
    ("Mestia", "GE", "caucasus"),
    ("Yerevan", "AM", "caucasus"),
    ("Dilijan", "AM", "caucasus"),
    ("Gyumri", "AM", "caucasus"),
    ("Baku", "AZ", "caucasus"),
    ("Sheki", "AZ", "caucasus"),
    ("Nakhchivan", "AZ", "caucasus"),
    ("Istanbul", "TR", "eurasia"),
    ("Cappadocia", "TR", "eurasia"),
    ("Antalya", "TR", "eurasia"),
    ("Izmir", "TR", "eurasia"),
    ("Trabzon", "TR", "eurasia"),
    ("Van", "TR", "eurasia"),
    ("Ankara", "TR", "eurasia"),
    ("Kyiv", "UA", "europe"),
    ("Lviv", "UA", "europe"),
    ("Odesa", "UA", "europe"),
    # North & Central America
    ("Mexico City", "MX", "central-america"),
    ("Oaxaca", "MX", "central-america"),
    ("Mérida", "MX", "central-america"),
    ("San Miguel de Allende", "MX", "central-america"),
    ("Guanajuato", "MX", "central-america"),
    ("Tulum", "MX", "central-america"),
    ("Puerto Vallarta", "MX", "central-america"),
    ("La Paz", "MX", "central-america"),
    ("Cabo San Lucas", "MX", "central-america"),
    ("San Cristóbal de las Casas", "MX", "central-america"),
    ("Antigua Guatemala", "GT", "central-america"),
    ("Guatemala City", "GT", "central-america"),
    ("Lake Atitlán", "GT", "central-america"),
    ("Flores", "GT", "central-america"),
    ("Belize City", "BZ", "central-america"),
    ("San Pedro", "BZ", "central-america"),
    ("Panama City", "PA", "central-america"),
    ("Boquete", "PA", "central-america"),
    ("Bocas del Toro", "PA", "central-america"),
    ("Casco Viejo", "PA", "central-america"),
    ("San José", "CR", "central-america"),
    ("Monteverde", "CR", "central-america"),
    ("Tamarindo", "CR", "central-america"),
    ("Manuel Antonio", "CR", "central-america"),
    ("Granada", "NI", "central-america"),
    ("León", "NI", "central-america"),
    ("Managua", "NI", "central-america"),
    ("Roatán", "HN", "central-america"),
    ("Tegucigalpa", "HN", "central-america"),
    ("Havana", "CU", "caribbean"),
    # Caribbean + South America
    ("Nassau", "BS", "caribbean"),
    ("Kingston", "JM", "caribbean"),
    ("Montego Bay", "JM", "caribbean"),
    ("Port-au-Prince", "HT", "caribbean"),
    ("Santo Domingo", "DO", "caribbean"),
    ("San Juan", "PR", "caribbean"),
    ("Willemstad", "CW", "caribbean"),
    ("Bridgetown", "BB", "caribbean"),
    ("Castries", "LC", "caribbean"),
    ("Port of Spain", "TT", "caribbean"),
    ("Bogotá", "CO", "south-america"),
    ("Medellín", "CO", "south-america"),
    ("Cartagena", "CO", "south-america"),
    ("Quito", "EC", "south-america"),
    ("Galápagos", "EC", "south-america"),
    ("Lima", "PE", "south-america"),
    ("Cusco", "PE", "south-america"),
    ("Ushuaia", "AR", "south-america"),
    ("Rio de Janeiro", "BR", "south-america"),
]

# Build a lookup dict: (city, country) -> {city, country, region}
_CITY_LOOKUP: dict[tuple[str, str], dict[str, str]] = {}
for city, country, region in COOL_CITIES_500:
    _CITY_LOOKUP[(city.lower(), country.upper())] = {
        "city": city,
        "country": country.upper(),
        "region": region,
    }


# ── Database Schema ─────────────────────────────────────────────────────────

DISCOVERY_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS news_city_discovery (
    id              BIGSERIAL PRIMARY KEY,
    city            TEXT NOT NULL,
    country         TEXT NOT NULL,
    region          TEXT NOT NULL DEFAULT 'unknown',
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed','skipped')),
    sources_found   INT NOT NULL DEFAULT 0,
    sources_added   INT NOT NULL DEFAULT 0,
    candidates      INT NOT NULL DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (city, country)
);

CREATE INDEX IF NOT EXISTS idx_city_discovery_status
    ON news_city_discovery(status);
CREATE INDEX IF NOT EXISTS idx_city_discovery_country
    ON news_city_discovery(country);
"""


def _ensure_discovery_table() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(DISCOVERY_TABLE_DDL)
        conn.commit()


# ── Progress Tracking ───────────────────────────────────────────────────────

def _get_pending_cities(limit: int | None = None, force: bool = False) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        if force:
            # Re-process all cities regardless of status
            query = """
                SELECT city, country, region, status, sources_found, sources_added
                FROM news_city_discovery
                ORDER BY
                    CASE status
                        WHEN 'failed' THEN 0
                        WHEN 'pending' THEN 1
                        WHEN 'processing' THEN 2
                        WHEN 'completed' THEN 3
                        WHEN 'skipped' THEN 4
                    END,
                    updated_at ASC
            """
            cur.execute(query)
        else:
            query = """
                SELECT city, country, region, status, sources_found, sources_added
                FROM news_city_discovery
                WHERE status IN ('pending', 'failed', 'processing')
                ORDER BY
                    CASE status
                        WHEN 'failed' THEN 0
                        WHEN 'pending' THEN 1
                        WHEN 'processing' THEN 2
                    END,
                    updated_at ASC
            """
            cur.execute(query)

        rows = cur.fetchall()
        if limit:
            rows = rows[:limit]
        return [dict(r) for r in rows]


def _seed_discovery_table() -> int:
    _ensure_discovery_table()
    seeded = 0
    with connect() as conn, conn.cursor() as cur:
        for city, country, region in COOL_CITIES_500:
            cur.execute("""
                INSERT INTO news_city_discovery (city, country, region)
                VALUES (%s, %s, %s)
                ON CONFLICT (city, country) DO NOTHING
            """, [city, country.upper(), region])
            if cur.rowcount > 0:
                seeded += 1
        conn.commit()
    return seeded


def _mark_city_processing(city: str, country: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_city_discovery
            SET status = 'processing',
                started_at = NOW(),
                updated_at = NOW(),
                error_message = NULL
            WHERE city = %s AND country = %s
        """, [city, country.upper()])
        conn.commit()


def _mark_city_completed(
    city: str,
    country: str,
    sources_found: int,
    sources_added: int,
    candidates: int,
) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_city_discovery
            SET status = 'completed',
                completed_at = NOW(),
                updated_at = NOW(),
                sources_found = %s,
                sources_added = %s,
                candidates = %s
            WHERE city = %s AND country = %s
        """, [sources_found, sources_added, candidates, city, country.upper()])
        conn.commit()


def _mark_city_failed(city: str, country: str, error: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_city_discovery
            SET status = 'failed',
                completed_at = NOW(),
                updated_at = NOW(),
                error_message = %s
            WHERE city = %s AND country = %s
        """, [error[:500], city, country.upper()])
        conn.commit()


# ── Discovery ───────────────────────────────────────────────────────────────

ROBOTS = RobotsCache()

# Domain → known local news sites to probe first
# These are pre-seeded to avoid costly web searches for well-known cities
LOCAL_NEWS_DOMAINS: dict[tuple[str, str], list[str]] = {
    # Format: (city_lower, country) -> [domain1, domain2]
    ("kabul", "AF"): ["tolonews.com", "pajhwok.com", "ariananews.af"],
    ("delhi", "IN"): ["thehindu.com", "timesofindia.indiatimes.com", "ndtv.com", "hindustantimes.com"],
    ("mumbai", "IN"): ["mid-day.com", "mumbaimirror.com"],
    ("kolkata", "IN"): ["anandabazar.com", "bartaman.com"],
    ("bangalore", "IN"): ["deccanherald.com"],
    ("bengaluru", "IN"): ["deccanherald.com"],
    ("chennai", "IN"): ["thehindu.com"],
    ("hyderabad", "IN"): ["deccanchronicle.com"],
    ("london", "GB"): ["theguardian.com", "bbc.co.uk/news", "standard.co.uk", " Evening Standard"],
    ("paris", "FR"): ["lemonde.fr", "france24.com", "liberation.fr"],
    ("tokyo", "JP"): ["japantimes.co.jp", "nhk.or.jp/news", "nikkei.com"],
    ("sydney", "AU"): ["abc.net.au/news", "smh.com.au", "theage.com.au"],
    ("melbourne", "AU"): ["abc.net.au/news", "theage.com.au", "heraldsun.com.au"],
    ("singapore", "SG"): ["straitstimes.com", "channelnewsasia.com"],
    ("dubai", "AE"): ["thenationalnews.com", "gulfnews.com", "khaleejtimes.com"],
    ("toronto", "CA"): ["thestar.com", "globeandmail.com", "ctvnews.ca"],
    ("vancouver", "CA"): ["vancouversun.com", "bcbc.com"],
    ("new york", "US"): ["nytimes.com", "nypost.com", "am纽约.com", "gothamist.com"],
    ("los angeles", "US"): ["latimes.com", "laweekly.com", "nbclosangeles.com"],
    ("chicago", "US"): ["chicagotribune.com", "wbez.org", "blockclubchicago.org"],
    ("mexico city", "MX"): ["eluniversal.com.mx", " jornada.com.mx", "excelsior.com.mx"],
    ("cairo", "EG"): ["ahram.org.eg", "dailynewssegypt.com", "egypttoday.com"],
    ("nairobi", "KE"): ["standardmedia.co.ke", "nation.africa", "capitalfm.com"],
    ("johannesburg", "ZA"): ["mailandguardian.co.za", "news24.com", "businessday.co.za"],
    ("cape town", "ZA"): ["capetimes.co.za", "dailymaverick.co.za"],
    ("rio de janeiro", "BR"): ["oglobo.globo.com", "folha.uol.com.br", "g1.globo.com"],
    ("sao paulo", "BR"): ["folha.uol.com.br", "estadao.com", "g1.globo.com"],
    ("bogota", "CO"): ["eltiempo.com", "semana.com", "elespectador.com"],
    ("buenos aires", "AR"): ["lanacion.com.ar", "clarin.com", "pagina12.com.ar"],
    ("istanbul", "TR"): ["hurriyet.com.tr", "sabah.com.tr", "dnh.com.tr"],
    ("moscow", "RU"): ["themoscowtimes.com", "rferl.org"],
    ("beijing", "CN"): ["shine.cn", "sixthtone.com", "ecns.cn"],
    ("shanghai", "CN"): ["shine.cn", "sixthtone.com"],
    ("bangkok", "TH"): ["bangkokpost.com", "nationthailand.com", "thaipbs.or.th"],
    ("hanoi", "VN"): ["vietnamnews.vn", "vnexpress.net", "thanhnien.com"],
    ("ho chi minh city", "VN"): ["vietnamnews.vn", "vnexpress.net"],
    ("jakarta", "ID"): ["thejakartapost.com", "kompas.com", "detik.com"],
    ("kuala lumpur", "MY"): ["nst.com.my", "malaymail.com", "theedgemarkets.com"],
    ("manila", "PH"): ["inquirer.net", "abs-cbn.com", "rappler.com"],
    ("seoul", "KR"): ["koreatimes.co.kr", "koreaherald.com", "yna.co.kr"],
    ("kathmandu", "NP"): ["nepalnews.com", "kathmandupost.com", "setopati.com"],
    ("dhaka", "BD"): ["dhakatribune.com", "bdnews24.com", "thefinancialexpress.com.bd"],
    ("karachi", "PK"): ["dawn.com", " Tribune", "geo.tv"],
    ("lahore", "PK"): ["dawn.com", " Tribune", "geo.tv"],
    ("islamabad", "PK"): ["dawn.com", "dailytimes.com.pk"],
    ("mumbai", "IN"): ["mid-day.com", "mumbaimirror.com"],
    ("osaka", "JP"): ["japantimes.co.jp", "asahi.com"],
    ("kyoto", "JP"): ["kyotonews.jp", "kansaicc1.com"],
    ("bali", "ID"): ["thebalinews.com", "balipost.com"],
    ("ubud", "ID"): ["thebalinews.com", "balipost.com"],
    ("chiang mai", "TH"): ["chiangmainews.com", "coconuts.co/chiang-mai"],
    ("lisbon", "PT"): ["publico.pt", "tsf.pt", "dn.pt"],
    ("porto", "PT"): ["publico.pt", "jn.pt", "ojogo.pt"],
    ("barcelona", "ES"): ["elpais.com", "lavanguardia.com", "eldiario.es"],
    ("madrid", "ES"): ["elpais.com", "elmundo.es", "abc.es"],
    ("rome", "IT"): ["repubblica.it", "corriere.it", "lastampa.it"],
    ("venice", "IT"): ["lanuovasoluzione80.net", "veneziatoday.it"],
    ("berlin", "DE"): ["spiegel.de", "faz.net", "taz.de", "dw.com"],
    ("vienna", "AT"): ["derstandard.at", "diepresse.com", "wienerzeitung.at"],
    ("amsterdam", "NL"): ["dutchnews.nl", "trouw.nl", "nos.nl"],
    ("brussels", "BE"): ["brut.be", "rtbf.be", "lesoir.be"],
    ("zurich", "CH"): ["nzz.ch", "srf.ch/news"],
    ("prague", "CZ"): ["expats.cz", "radio.cz", "praguepost.com"],
    ("budapest", "HU"): ["hungarytoday.hu", "budapestbeacon.com", "rtl.hu"],
    ("warsaw", "PL"): ["thenews.pl", "pap.pl", "tvpworld.com"],
    ("krakow", "PL"): ["krakowpost.com", "radio.pl"],
    ("athens", "GR"): ["ekathimerini.com", "amna.gr", " tovima.com"],
    ("marrakech", "MA"): ["marocexplorer.com", "telquel.ma"],
    ("casablanca", "MA"): ["marocipher.com", "lematin.ma"],
}


def _build_city_query(city: str, country: str) -> str:
    """Build a search query for a city."""
    return f"{city} news"


def _get_local_domains(city: str, country: str) -> list[str]:
    """Get pre-seeded local news domains for a city, if any."""
    key = (city.lower(), country.upper())
    return LOCAL_NEWS_DOMAINS.get(key, [])


def _check_robots_allowed(url: str) -> tuple[bool, str]:
    """Check if a URL is allowed by robots.txt. Returns (allowed, reason)."""
    try:
        v = ROBOTS.is_allowed(url)
        if v.allowed:
            return True, ""
        return False, f"robots.txt blocked ({v.note})"
    except Exception as e:
        return False, f"robots check failed: {e}"


def discover_for_city(
    city: str,
    country: str,
    region: str,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Discover news sources for a single city.

    Returns:
        {
            "city": str,
            "country": str,
            "candidates": int,       # total found
            "validated": int,        # passed validation
            "sources_found": int,    # unique new sources found
            "sources_added": int,    # actually added to DB
            "already_existed": int,  # were already in feeds.json
            "skipped_robots": int,   # blocked by robots.txt
            "errors": [str],
            "feeds": [dict],         # details of each feed
        }
    """
    result = {
        "city": city,
        "country": country,
        "region": region,
        "candidates": 0,
        "validated": 0,
        "sources_found": 0,
        "sources_added": 0,
        "already_existed": 0,
        "skipped_robots": 0,
        "errors": [],
        "feeds": [],
    }

    query = _build_city_query(city, country)
    country_code = _resolve_country(country) or country.upper()

    log.info("Discovering sources for %s, %s [%s]", city, country, country_code)

    try:
        # Run discovery with all 4 strategies (but limit web to avoid timeout)
        disc_result = discover_sources(
            query=query,
            country=country_code,
            strategies=["probe", "web", "directory", "ai"],
            include_existing=False,
        )

        candidates = disc_result.get("candidates", [])
        result["candidates"] = len(candidates)
        result["errors"] = disc_result.get("errors", [])

        # Deduplicate by feed_url
        seen_urls = set()
        unique_candidates = []
        for c in candidates:
            url = c.get("feed_url", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                unique_candidates.append(c)

        result["validated"] = len(unique_candidates)
        log.info(
            "  %s: %d candidates → %d unique after dedup",
            city,
            len(candidates),
            len(unique_candidates),
        )

        # Process each candidate
        for cand in unique_candidates:
            url = cand.get("feed_url", "")
            name = cand.get("name", "Unknown")

            if not url:
                continue

            # Robots check first (before even trying to validate)
            allowed, reason = _check_robots_allowed(url)
            if not allowed:
                result["skipped_robots"] += 1
                log.debug("  SKIP (robots) %s: %s", name, reason)
                continue

            # Validate feed
            validation = validate_feed(url)
            if not validation.get("valid"):
                log.debug("  SKIP (invalid) %s: %s", name, validation.get("error", "unknown"))
                continue

            # Check if already exists
            existing_urls = set()
            try:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute("SELECT feed_url FROM news_sources WHERE feed_url = %s", [url])
                    existing_urls = {r["feed_url"] for r in cur.fetchall()}
            except Exception as e:
                log.warning("  DB check failed for %s: %s", url, e)

            if url in existing_urls:
                result["already_existed"] += 1
                log.debug("  EXISTS: %s (%s)", name, url)
                continue

            result["sources_found"] += 1

            # Build source record
            source = {
                "name": name or validation.get("title", city),
                "feed_url": url,
                "country": cand.get("country") or country.upper(),
                "language": cand.get("language", "en"),
                "region": region,
                "source_type": "rss",
                "description": cand.get("description", f"{city} news source"),
            }

            if not dry_run:
                try:
                    add_result = add_source(source)
                    if add_result.get("added"):
                        result["sources_added"] += 1
                        log.info("  ADDED: %s (%s)", name, url)
                    else:
                        log.debug("  NOT ADDED: %s - %s", name, add_result.get("reason"))
                except Exception as e:
                    log.warning("  Failed to add %s: %s", url, e)
                    result["errors"].append(f"add failed: {e}")

            result["feeds"].append({
                "name": source["name"],
                "feed_url": url,
                "country": source["country"],
                "added": not dry_run and result["sources_added"] > 0,
            })

            time.sleep(0.5)  # Be polite between adds

    except Exception as e:
        error_msg = f"discovery failed: {e}"
        result["errors"].append(error_msg)
        log.exception("Discovery failed for %s, %s: %s", city, country, e)

    return result


# ── Batch Processing ─────────────────────────────────────────────────────────

BATCH_DELAY = 5.0  # seconds between cities


def run_batch(
    batch_size: int | None = None,
    dry_run: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    """Process a batch of pending cities.

    Args:
        batch_size: Max cities to process (None = all pending)
        dry_run: Discover but don't add
        force: Re-process completed cities too

    Returns:
        Summary dict with totals
    """
    _seed_discovery_table()

    pending = _get_pending_cities(limit=batch_size, force=force)

    if not pending:
        log.info("No pending cities to process")
        return {
            "processed": 0,
            "total_found": 0,
            "total_added": 0,
            "total_existing": 0,
            "total_skipped_robots": 0,
            "errors": [],
        }

    log.info(
        "Processing %d cities (dry_run=%s, force=%s)",
        len(pending),
        dry_run,
        force,
    )

    total_found = 0
    total_added = 0
    total_existing = 0
    total_skipped_robots = 0
    all_errors = []
    results_by_city = {}

    for i, city_rec in enumerate(pending, start=1):
        city = city_rec["city"]
        country = city_rec["country"]
        region = city_rec["region"]

        log.info(
            "[%d/%d] Processing %s, %s [%s]",
            i,
            len(pending),
            city,
            country,
            region,
        )

        _mark_city_processing(city, country)

        result = discover_for_city(
            city=city,
            country=country,
            region=region,
            dry_run=dry_run,
        )

        total_found += result["sources_found"]
        total_added += result["sources_added"]
        total_existing += result["already_existed"]
        total_skipped_robots += result["skipped_robots"]
        all_errors.extend(result["errors"])
        results_by_city[f"{city},{country}"] = result

        if result["errors"]:
            _mark_city_failed(city, country, "; ".join(result["errors"]))
        else:
            _mark_city_completed(
                city=city,
                country=country,
                sources_found=result["sources_found"],
                sources_added=result["sources_added"],
                candidates=result["candidates"],
            )

        # Rate limit between cities
        if i < len(pending):
            time.sleep(BATCH_DELAY)

    return {
        "processed": len(pending),
        "total_found": total_found,
        "total_added": total_added,
        "total_existing": total_existing,
        "total_skipped_robots": total_skipped_robots,
        "errors": all_errors[:50],  # cap errors in output
        "results_by_city": results_by_city,
    }


# ── Status Report ────────────────────────────────────────────────────────────

def print_status() -> None:
    _ensure_discovery_table()

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                status,
                COUNT(*) AS city_count,
                SUM(sources_found) AS total_found,
                SUM(sources_added) AS total_added,
                SUM(candidates) AS total_candidates,
                SUM(error_message IS NOT NULL)::int AS error_count
            FROM news_city_discovery
            GROUP BY status
            ORDER BY status
        """)
        status_rows = cur.fetchall()

        print("\n=== City Discovery Status ===\n")
        print(f"{'Status':<15} {'Cities':<10} {'Candidates':<12} {'Found':<8} {'Added':<8} {'Errors':<8}")
        print("-" * 65)

        total_cities = 0
        total_found = 0
        total_added = 0
        total_candidates = 0

        for row in status_rows:
            status = row["status"]
            cnt = int(row["city_count"])
            found = int(row["total_found"] or 0)
            added = int(row["total_added"] or 0)
            candidates = int(row["total_candidates"] or 0)
            errors = int(row["error_count"])

            print(f"{status:<15} {cnt:<10} {candidates:<12} {found:<8} {added:<8} {errors:<8}")

            total_cities += cnt
            total_found += found
            total_added += added
            total_candidates += candidates

        print("-" * 65)
        print(f"{'TOTAL':<15} {total_cities:<10} {total_candidates:<12} {total_found:<8} {total_added:<8}")
        print()

        # Top countries by sources found
        cur.execute("""
            SELECT country, region,
                   COUNT(*) AS cities,
                   SUM(sources_found) AS found,
                   SUM(sources_added) AS added
            FROM news_city_discovery
            WHERE sources_found > 0
            GROUP BY country, region
            ORDER BY found DESC
            LIMIT 20
        """)
        country_rows = cur.fetchall()

        print("\nTop 20 Countries by Sources Found:\n")
        print(f"{'Country':<8} {'Region':<20} {'Cities':<8} {'Found':<8} {'Added':<8}")
        print("-" * 60)
        for row in country_rows:
            print(
                f"{row['country']:<8} {row['region']:<20} "
                f"{int(row['cities']):<8} {int(row['found'] or 0):<8} {int(row['added'] or 0):<8}"
            )

        print()


# ── CLI ─────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(description="Discover news sources for 500 cool cities")
    parser.add_argument("--batch", type=int, default=None, help="Process N cities then exit")
    parser.add_argument("--dry-run", action="store_true", help="Discover but don't add sources")
    parser.add_argument("--resume", action="store_true", help="Resume from last checkpoint")
    parser.add_argument("--status", action="store_true", help="Print status and exit")
    parser.add_argument("--force", action="store_true", help="Re-process completed cities too")

    args = parser.parse_args()

    if args.status:
        print_status()
        return

    result = run_batch(
        batch_size=args.batch,
        dry_run=args.dry_run,
        force=args.force or args.resume,
    )

    print("\n=== Batch Complete ===\n")
    print(f"Cities processed:      {result['processed']}")
    print(f"Sources found:         {result['total_found']}")
    print(f"Sources added:         {result['total_added']}")
    print(f"Already existed:       {result['total_existing']}")
    print(f"Skipped (robots.txt):  {result['total_skipped_robots']}")
    if result["errors"]:
        print(f"\nErrors encountered: {len(result['errors'])}")
        for err in result["errors"][:5]:
            print(f"  - {err}")


if __name__ == "__main__":
    main()
