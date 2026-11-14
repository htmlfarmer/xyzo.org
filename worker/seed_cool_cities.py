"""Seed and maintain the 500 Cool Cities list.

This module:
1. Seeds the cool_city_500 table with curated cities
2. Marks cities that are under-covered (need source discovery)
3. Provides status reports

Usage:
    # Seed the 500 cool cities:
    python -m worker.seed_cool_cities

    # Status report:
    python -m worker.seed_cool_cities --status

    # Find under-covered cities:
    python -m worker.seed_cool_cities --undercovered
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from worker.db import connect

log = logging.getLogger("xyzo.seed_cool_cities")

# The 500 Cool Cities list (from user input)
COOL_CITIES = [
    ("Kabul", "AF", "south-asia"), ("Bamyan", "AF", "south-asia"), ("Herat", "AF", "south-asia"),
    ("Mazar-i-Sharif", "AF", "south-asia"), ("Samarkand", "UZ", "central-asia"), ("Bukhara", "UZ", "central-asia"),
    ("Khiva", "UZ", "central-asia"), ("Tashkent", "UZ", "central-asia"), ("Bishkek", "KG", "central-asia"),
    ("Osh", "KG", "central-asia"), ("Almaty", "KZ", "central-asia"), ("Astana", "KZ", "central-asia"),
    ("Turkistan", "KZ", "central-asia"), ("Dushanbe", "TJ", "central-asia"), ("Khujand", "TJ", "central-asia"),
    ("Ashgabat", "TM", "central-asia"), ("Mary", "TM", "central-asia"), ("Tehran", "IR", "middle-east"),
    ("Isfahan", "IR", "middle-east"), ("Shiraz", "IR", "middle-east"), ("Yazd", "IR", "middle-east"),
    ("Kashan", "IR", "middle-east"), ("Tabriz", "IR", "middle-east"), ("Qeshm", "IR", "middle-east"),
    ("Bandar Abbas", "IR", "middle-east"), ("Muscat", "OM", "middle-east"), ("Salalah", "OM", "middle-east"),
    ("Nizwa", "OM", "middle-east"), ("Khasab", "OM", "middle-east"), ("Dubai", "AE", "middle-east"),
    ("Abu Dhabi", "AE", "middle-east"), ("Al Ain", "AE", "middle-east"), ("Doha", "QA", "middle-east"),
    ("Manama", "BH", "middle-east"), ("Kuwait City", "KW", "middle-east"), ("Riyadh", "SA", "middle-east"),
    ("Jeddah", "SA", "middle-east"), ("AlUla", "SA", "middle-east"), ("Medina", "SA", "middle-east"),
    ("Amman", "JO", "middle-east"), ("Petra", "JO", "middle-east"), ("Wadi Musa", "JO", "middle-east"),
    ("Jerusalem", "IL", "middle-east"), ("Bethlehem", "PS", "middle-east"), ("Beirut", "LB", "middle-east"),
    ("Byblos", "LB", "middle-east"), ("Baalbek", "LB", "middle-east"), ("Damascus", "SY", "middle-east"),
    ("Aleppo", "SY", "middle-east"), ("Kathmandu", "NP", "south-asia"), ("Pokhara", "NP", "south-asia"),
    ("Namche Bazaar", "NP", "south-asia"), ("Lukla", "NP", "south-asia"), ("Mustang", "NP", "south-asia"),
    ("Thimphu", "BT", "south-asia"), ("Paro", "BT", "south-asia"), ("Punakha", "BT", "south-asia"),
    ("Dhaka", "BD", "south-asia"), ("Chittagong", "BD", "south-asia"), ("Sylhet", "BD", "south-asia"),
    ("Cox's Bazar", "BD", "south-asia"), ("Bandarban", "BD", "south-asia"), ("Srinagar", "IN", "south-asia"),
    ("Leh", "IN", "south-asia"), ("Manali", "IN", "south-asia"), ("Shimla", "IN", "south-asia"),
    ("Dharamshala", "IN", "south-asia"), ("Rishikesh", "IN", "south-asia"), ("Varanasi", "IN", "south-asia"),
    ("Jaipur", "IN", "south-asia"), ("Jaisalmer", "IN", "south-asia"), ("Udaipur", "IN", "south-asia"),
    ("Jodhpur", "IN", "south-asia"), ("Agra", "IN", "south-asia"), ("Delhi", "IN", "south-asia"),
    ("Mumbai", "IN", "south-asia"), ("Goa", "IN", "south-asia"), ("Kochi", "IN", "south-asia"),
    ("Munnar", "IN", "south-asia"), ("Ooty", "IN", "south-asia"), ("Hampi", "IN", "south-asia"),
    ("Mysuru", "IN", "south-asia"), ("Bengaluru", "IN", "south-asia"), ("Chennai", "IN", "south-asia"),
    ("Pondicherry", "IN", "south-asia"), ("Kolkata", "IN", "south-asia"), ("Darjeeling", "IN", "south-asia"),
    ("Shillong", "IN", "south-asia"), ("Gangtok", "IN", "south-asia"), ("Port Blair", "IN", "south-asia"),
    ("Hyderabad", "IN", "south-asia"), ("Ahmedabad", "IN", "south-asia"), ("Amritsar", "IN", "south-asia"),
    ("Lucknow", "IN", "south-asia"), ("Khajuraho", "IN", "south-asia"), ("Aurangabad", "IN", "south-asia"),
    ("Nashik", "IN", "south-asia"), ("Bhopal", "IN", "south-asia"), ("Bhubaneswar", "IN", "south-asia"),
    ("Visakhapatnam", "IN", "south-asia"), ("Tokyo", "JP", "east-asia"), ("Kyoto", "JP", "east-asia"),
    ("Osaka", "JP", "east-asia"), ("Nara", "JP", "east-asia"), ("Kanazawa", "JP", "east-asia"),
    ("Takayama", "JP", "east-asia"), ("Sapporo", "JP", "east-asia"), ("Hakodate", "JP", "east-asia"),
    ("Aomori", "JP", "east-asia"), ("Sendai", "JP", "east-asia"), ("Hiroshima", "JP", "east-asia"),
    ("Nagasaki", "JP", "east-asia"), ("Fukuoka", "JP", "east-asia"), ("Okinawa", "JP", "east-asia"),
    ("Yakushima", "JP", "east-asia"), ("Taipei", "TW", "east-asia"), ("Hualien", "TW", "east-asia"),
    ("Taitung", "TW", "east-asia"), ("Jiufen", "TW", "east-asia"), ("Seoul", "KR", "east-asia"),
    ("Busan", "KR", "east-asia"), ("Jeju", "KR", "east-asia"), ("Gyeongju", "KR", "east-asia"),
    ("Pyongyang", "KP", "east-asia"), ("Beijing", "CN", "east-asia"), ("Shanghai", "CN", "east-asia"),
    ("Xi'an", "CN", "east-asia"), ("Chengdu", "CN", "east-asia"), ("Chongqing", "CN", "east-asia"),
    ("Lhasa", "CN", "east-asia"), ("Kashgar", "CN", "east-asia"), ("Urumqi", "CN", "east-asia"),
    ("Guilin", "CN", "east-asia"), ("Zhangjiajie", "CN", "east-asia"), ("Kunming", "CN", "east-asia"),
    ("Dali", "CN", "east-asia"), ("Lijiang", "CN", "east-asia"), ("Xiamen", "CN", "east-asia"),
    ("Harbin", "CN", "east-asia"), ("Macau", "MO", "east-asia"), ("Bangkok", "TH", "southeast-asia"),
    ("Chiang Mai", "TH", "southeast-asia"), ("Chiang Rai", "TH", "southeast-asia"), ("Pai", "TH", "southeast-asia"),
    ("Phuket", "TH", "southeast-asia"), ("Krabi", "TH", "southeast-asia"), ("Koh Samui", "TH", "southeast-asia"),
    ("Koh Tao", "TH", "southeast-asia"), ("Ayutthaya", "TH", "southeast-asia"), ("Luang Prabang", "LA", "southeast-asia"),
    ("Vientiane", "LA", "southeast-asia"), ("Vang Vieng", "LA", "southeast-asia"), ("Pakse", "LA", "southeast-asia"),
    ("Hanoi", "VN", "southeast-asia"), ("Ho Chi Minh City", "VN", "southeast-asia"), ("Da Nang", "VN", "southeast-asia"),
    ("Hue", "VN", "southeast-asia"), ("Hoi An", "VN", "southeast-asia"), ("Ha Long", "VN", "southeast-asia"),
    ("Sapa", "VN", "southeast-asia"), ("Ninh Binh", "VN", "southeast-asia"), ("Phu Quoc", "VN", "southeast-asia"),
    ("Phnom Penh", "KH", "southeast-asia"), ("Siem Reap", "KH", "southeast-asia"), ("Battambang", "KH", "southeast-asia"),
    ("Sihanoukville", "KH", "southeast-asia"), ("Kuala Lumpur", "MY", "southeast-asia"), ("George Town", "MY", "southeast-asia"),
    ("Ipoh", "MY", "southeast-asia"), ("Malacca", "MY", "southeast-asia"), ("Kota Kinabalu", "MY", "southeast-asia"),
    ("Kuching", "MY", "southeast-asia"), ("Bandar Seri Begawan", "BN", "southeast-asia"), ("Singapore", "SG", "southeast-asia"),
    ("Jakarta", "ID", "southeast-asia"), ("Bali", "ID", "southeast-asia"), ("Yogyakarta", "ID", "southeast-asia"),
    ("Bandung", "ID", "southeast-asia"), ("Surabaya", "ID", "southeast-asia"), ("Lombok", "ID", "southeast-asia"),
    ("Flores", "ID", "southeast-asia"), ("Komodo", "ID", "southeast-asia"), ("Raja Ampat", "ID", "southeast-asia"),
    ("Ubud", "ID", "southeast-asia"), ("Labuan Bajo", "ID", "southeast-asia"), ("Makassar", "ID", "southeast-asia"),
    ("Manado", "ID", "southeast-asia"), ("Dili", "TL", "southeast-asia"), ("Boracay", "PH", "southeast-asia"),
    ("Cebu", "PH", "southeast-asia"), ("Manila", "PH", "oceania"), ("Palawan", "PH", "oceania"),
    ("Siargao", "PH", "oceania"), ("Bohol", "PH", "oceania"), ("Vigan", "PH", "oceania"),
    ("El Nido", "PH", "oceania"), ("Port Moresby", "PG", "oceania"), ("Goroka", "PG", "oceania"),
    ("Rabaul", "PG", "oceania"), ("Lae", "PG", "oceania"), ("Honiara", "SB", "oceania"),
    ("Port Vila", "VU", "oceania"), ("Luganville", "VU", "oceania"), ("Nouméa", "NC", "oceania"),
    ("Papeete", "PF", "oceania"), ("Bora Bora", "PF", "oceania"), ("Rarotonga", "CK", "oceania"),
    ("Apia", "WS", "oceania"), ("Nuku'alofa", "TO", "oceania"), ("Suva", "FJ", "oceania"),
    ("Nadi", "FJ", "oceania"), ("Savusavu", "FJ", "oceania"), ("Funafuti", "TV", "oceania"),
    ("Tarawa", "KI", "oceania"), ("Majuro", "MH", "oceania"), ("Palikir", "FM", "oceania"),
    ("Koror", "PW", "oceania"), ("Hanga Roa", "CL", "oceania"), ("Auckland", "NZ", "oceania"),
    ("Wellington", "NZ", "oceania"), ("Queenstown", "NZ", "oceania"), ("Rotorua", "NZ", "oceania"),
    ("Dunedin", "NZ", "oceania"), ("Christchurch", "NZ", "oceania"), ("Nelson", "NZ", "oceania"),
    ("Hobart", "AU", "oceania"), ("Launceston", "AU", "oceania"), ("Melbourne", "AU", "oceania"),
    ("Sydney", "AU", "oceania"), ("Perth", "AU", "oceania"), ("Cape Town", "ZA", "southern-africa"),
    ("Johannesburg", "ZA", "southern-africa"), ("Durban", "ZA", "southern-africa"), ("Pretoria", "ZA", "southern-africa"),
    ("Gqeberha", "ZA", "southern-africa"), ("Stellenbosch", "ZA", "southern-africa"), ("Kruger", "ZA", "southern-africa"),
    ("Maseru", "LS", "southern-africa"), ("Mbabane", "SZ", "southern-africa"), ("Maputo", "MZ", "southern-africa"),
    ("Tofo", "MZ", "southern-africa"), ("Vilanculos", "MZ", "southern-africa"), ("Pemba", "MZ", "southern-africa"),
    ("Victoria Falls", "ZW", "southern-africa"), ("Harare", "ZW", "east-africa"), ("Bulawayo", "ZW", "east-africa"),
    ("Lusaka", "ZM", "east-africa"), ("Livingstone", "ZM", "east-africa"), ("Lower Zambezi", "ZM", "east-africa"),
    ("Lilongwe", "MW", "east-africa"), ("Blantyre", "MW", "east-africa"), ("Lake Malawi", "MW", "east-africa"),
    ("Nairobi", "KE", "east-africa"), ("Mombasa", "KE", "east-africa"), ("Lamu", "KE", "east-africa"),
    ("Malindi", "KE", "east-africa"), ("Kisumu", "KE", "east-africa"), ("Maasai Mara", "KE", "east-africa"),
    ("Arusha", "TZ", "east-africa"), ("Dar es Salaam", "TZ", "east-africa"), ("Zanzibar City", "TZ", "east-africa"),
    ("Stone Town", "TZ", "east-africa"), ("Serengeti", "TZ", "east-africa"), ("Ngorongoro", "TZ", "east-africa"),
    ("Kilimanjaro", "TZ", "east-africa"), ("Dodoma", "TZ", "east-africa"), ("Kampala", "UG", "east-africa"),
    ("Jinja", "UG", "east-africa"), ("Entebbe", "UG", "east-africa"), ("Kigali", "RW", "east-africa"),
    ("Musanze", "RW", "east-africa"), ("Bujumbura", "BI", "east-africa"), ("Addis Ababa", "ET", "east-africa"),
    ("Lalibela", "ET", "east-africa"), ("Gondar", "ET", "east-africa"), ("Axum", "ET", "east-africa"),
    ("Harar", "ET", "east-africa"), ("Djibouti City", "DJ", "east-africa"), ("Mogadishu", "SO", "east-africa"),
    ("Hargeisa", "SO", "east-africa"), ("Cairo", "EG", "north-africa"), ("Alexandria", "EG", "north-africa"),
    ("Luxor", "EG", "north-africa"), ("Aswan", "EG", "north-africa"), ("Siwa Oasis", "EG", "north-africa"),
    ("Marrakech", "MA", "north-africa"), ("Fez", "MA", "north-africa"), ("Chefchaouen", "MA", "north-africa"),
    ("Essaouira", "MA", "north-africa"), ("Casablanca", "MA", "north-africa"), ("Tangier", "MA", "north-africa"),
    ("Agadir", "MA", "north-africa"), ("Tunis", "TN", "north-africa"), ("Sidi Bou Said", "TN", "north-africa"),
    ("Algiers", "DZ", "north-africa"), ("Oran", "DZ", "north-africa"), ("Dakar", "SN", "west-africa"),
    ("Saint-Louis", "SN", "west-africa"), ("Banjul", "GM", "west-africa"), ("Accra", "GH", "west-africa"),
    ("Kumasi", "GH", "west-africa"), ("Tamale", "GH", "west-africa"), ("Lomé", "TG", "west-africa"),
    ("Cotonou", "BJ", "west-africa"), ("Porto-Novo", "BJ", "west-africa"), ("Lagos", "NG", "west-africa"),
    ("Abuja", "NG", "west-africa"), ("Calabar", "NG", "west-africa"), ("Ibadan", "NG", "west-africa"),
    ("Jos", "NG", "west-africa"), ("Kano", "NG", "west-africa"), ("Douala", "CM", "central-africa"),
    ("Yaoundé", "CM", "central-africa"), ("Limbe", "CM", "central-africa"), ("Libreville", "GA", "central-africa"),
    ("São Tomé", "ST", "central-africa"), ("Malabo", "GQ", "central-africa"), ("Kinshasa", "CD", "central-africa"),
    ("Goma", "CD", "central-africa"), ("Bukavu", "CD", "central-africa"), ("Brazzaville", "CG", "central-africa"),
    ("Luanda", "AO", "central-africa"), ("Lubango", "AO", "central-africa"), ("Benguela", "AO", "central-africa"),
    ("Windhoek", "NA", "southern-africa"), ("Swakopmund", "NA", "southern-africa"), ("Walvis Bay", "NA", "southern-africa"),
    ("Lüderitz", "NA", "southern-africa"), ("Maun", "BW", "southern-africa"), ("Gaborone", "BW", "southern-africa"),
    ("Antananarivo", "MG", "east-africa"), ("Antsiranana", "MG", "east-africa"), ("Nosy Be", "MG", "east-africa"),
    ("Morondava", "MG", "east-africa"), ("Toamasina", "MG", "east-africa"), ("Port Louis", "MU", "east-africa"),
    ("Grand Baie", "MU", "east-africa"), ("Victoria", "SC", "east-africa"), ("Praslin", "SC", "east-africa"),
    ("La Digue", "SC", "east-africa"), ("Moroni", "KM", "east-africa"), ("Mamoudzou", "YT", "east-africa"),
    ("Saint-Denis", "RE", "east-africa"), ("Port Mathurin", "MU", "east-africa"), ("Praia", "CV", "west-africa"),
    ("Mindelo", "CV", "west-africa"), ("São Filipe", "CV", "west-africa"), ("Funchal", "PT", "europe"),
    ("Ponta Delgada", "PT", "europe"), ("Horta", "PT", "europe"), ("Reykjavik", "IS", "europe"),
    ("Akureyri", "IS", "europe"), ("Vik", "IS", "europe"), ("Tromsø", "NO", "europe"),
    ("Bergen", "NO", "europe"), ("Oslo", "NO", "europe"), ("Lofoten", "NO", "europe"),
    ("Stockholm", "SE", "europe"), ("Gothenburg", "SE", "europe"), ("Copenhagen", "DK", "europe"),
    ("Helsinki", "FI", "europe"), ("Rovaniemi", "FI", "europe"), ("Tallinn", "EE", "europe"),
    ("Riga", "LV", "europe"), ("Vilnius", "LT", "europe"), ("Warsaw", "PL", "europe"),
    ("Kraków", "PL", "europe"), ("Wrocław", "PL", "europe"), ("Prague", "CZ", "europe"),
    ("Český Krumlov", "CZ", "europe"), ("Vienna", "AT", "europe"), ("Salzburg", "AT", "europe"),
    ("Ljubljana", "SI", "europe"), ("Lake Bled", "SI", "europe"), ("Zagreb", "HR", "europe"),
    ("Dubrovnik", "HR", "europe"), ("Split", "HR", "europe"), ("Kotor", "ME", "europe"),
    ("Podgorica", "ME", "europe"), ("Sarajevo", "BA", "europe"), ("Mostar", "BA", "europe"),
    ("Belgrade", "RS", "europe"), ("Novi Sad", "RS", "europe"), ("Sofia", "BG", "europe"),
    ("Plovdiv", "BG", "europe"), ("Bucharest", "RO", "europe"), ("Brașov", "RO", "europe"),
    ("Sibiu", "RO", "europe"), ("Budapest", "HU", "europe"), ("Bratislava", "SK", "europe"),
    ("Athens", "GR", "europe"), ("Thessaloniki", "GR", "europe"), ("Santorini", "GR", "europe"),
    ("Crete", "GR", "europe"), ("Corfu", "GR", "europe"), ("Valletta", "MT", "europe"),
    ("Palermo", "IT", "europe"), ("Naples", "IT", "europe"), ("Rome", "IT", "europe"),
    ("Venice", "IT", "europe"), ("Florence", "IT", "europe"), ("Bologna", "IT", "europe"),
    ("Matera", "IT", "europe"), ("Cinque Terre", "IT", "europe"), ("Nice", "FR", "europe"),
    ("Marseille", "FR", "europe"), ("Paris", "FR", "europe"), ("Lyon", "FR", "europe"),
    ("Bordeaux", "FR", "europe"), ("Strasbourg", "FR", "europe"), ("Barcelona", "ES", "europe"),
    ("Madrid", "ES", "europe"), ("Seville", "ES", "europe"), ("Granada", "ES", "europe"),
    ("Málaga", "ES", "europe"), ("Bilbao", "ES", "europe"), ("Ibiza", "ES", "europe"),
    ("Porto", "PT", "europe"), ("Lisbon", "PT", "europe"), ("Sintra", "PT", "europe"),
    ("Lagos", "PT", "europe"), ("Dublin", "IE", "europe"), ("Galway", "IE", "europe"),
    ("Edinburgh", "GB", "europe"), ("Glasgow", "GB", "europe"), ("London", "GB", "europe"),
    ("Bath", "GB", "europe"), ("Oxford", "GB", "europe"), ("Cardiff", "GB", "europe"),
    ("Belfast", "GB", "europe"), ("Tbilisi", "GE", "caucasus"), ("Batumi", "GE", "caucasus"),
    ("Kutaisi", "GE", "caucasus"), ("Mestia", "GE", "caucasus"), ("Yerevan", "AM", "caucasus"),
    ("Dilijan", "AM", "caucasus"), ("Gyumri", "AM", "caucasus"), ("Baku", "AZ", "caucasus"),
    ("Sheki", "AZ", "caucasus"), ("Nakhchivan", "AZ", "caucasus"), ("Istanbul", "TR", "eurasia"),
    ("Cappadocia", "TR", "eurasia"), ("Antalya", "TR", "eurasia"), ("Izmir", "TR", "eurasia"),
    ("Trabzon", "TR", "eurasia"), ("Van", "TR", "eurasia"), ("Ankara", "TR", "eurasia"),
    ("Kyiv", "UA", "europe"), ("Lviv", "UA", "europe"), ("Odesa", "UA", "europe"),
    ("Mexico City", "MX", "central-america"), ("Oaxaca", "MX", "central-america"), ("Mérida", "MX", "central-america"),
    ("San Miguel de Allende", "MX", "central-america"), ("Guanajuato", "MX", "central-america"), ("Tulum", "MX", "central-america"),
    ("Puerto Vallarta", "MX", "central-america"), ("La Paz", "MX", "central-america"), ("Cabo San Lucas", "MX", "central-america"),
    ("San Cristóbal de las Casas", "MX", "central-america"), ("Antigua Guatemala", "GT", "central-america"),
    ("Guatemala City", "GT", "central-america"), ("Lake Atitlán", "GT", "central-america"), ("Flores", "GT", "central-america"),
    ("Belize City", "BZ", "central-america"), ("San Pedro", "BZ", "central-america"), ("Panama City", "PA", "central-america"),
    ("Boquete", "PA", "central-america"), ("Bocas del Toro", "PA", "central-america"), ("Casco Viejo", "PA", "central-america"),
    ("San José", "CR", "central-america"), ("Monteverde", "CR", "central-america"), ("Tamarindo", "CR", "central-america"),
    ("Manuel Antonio", "CR", "central-america"), ("Granada", "NI", "central-america"), ("León", "NI", "central-america"),
    ("Managua", "NI", "central-america"), ("Roatán", "HN", "central-america"), ("Tegucigalpa", "HN", "central-america"),
    ("Havana", "CU", "caribbean"), ("Nassau", "BS", "caribbean"), ("Kingston", "JM", "caribbean"),
    ("Montego Bay", "JM", "caribbean"), ("Port-au-Prince", "HT", "caribbean"), ("Santo Domingo", "DO", "caribbean"),
    ("San Juan", "PR", "caribbean"), ("Willemstad", "CW", "caribbean"), ("Bridgetown", "BB", "caribbean"),
    ("Castries", "LC", "caribbean"), ("Port of Spain", "TT", "caribbean"), ("Bogotá", "CO", "south-america"),
    ("Medellín", "CO", "south-america"), ("Cartagena", "CO", "south-america"), ("Quito", "EC", "south-america"),
    ("Galápagos", "EC", "south-america"), ("Lima", "PE", "south-america"), ("Cusco", "PE", "south-america"),
    ("Ushuaia", "AR", "south-america"), ("Rio de Janeiro", "BR", "south-america"),
]


def seed_cities() -> dict:
    """Seed the cool_city_500 table with curated cities."""
    seeded = 0
    updated = 0

    with connect() as conn:
        with conn.cursor() as cur:
            for city_name, country_code, region in COOL_CITIES:
                # Try to find the city in world_cities to get the ID
                cur.execute("""
                    SELECT id FROM world_cities
                    WHERE LOWER(name) = LOWER(%s)
                      AND country_code = %s
                    LIMIT 1
                """, [city_name, country_code])

                row = cur.fetchone()
                city_id = row["id"] if row else None

                if city_id:
                    # City exists in world_cities
                    cur.execute("""
                        INSERT INTO cool_city_500 (city_id, city_name, country_code, region)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (city_name, country_code) DO UPDATE SET
                            city_id = EXCLUDED.city_id,
                            region = EXCLUDED.region
                        RETURNING id
                    """, [city_id, city_name, country_code, region])
                    if cur.rowcount > 0:
                        seeded += 1
                    else:
                        updated += 1
                else:
                    # City not found - still insert without city_id
                    cur.execute("""
                        INSERT INTO cool_city_500 (city_name, country_code, region)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (city_name, country_code) DO UPDATE SET
                            region = EXCLUDED.region
                        RETURNING id
                    """, [city_name, country_code, region])
                    updated += 1

        conn.commit()

    return {"seeded": seeded, "updated": updated, "total": len(COOL_CITIES)}


def show_status() -> None:
    """Show status of cool cities."""
    with connect() as conn:
        with conn.cursor() as cur:
            # Total in list
            cur.execute("SELECT COUNT(*) FROM cool_city_500")
            total = cur.fetchone()["count"]

            # With city_id mapped
            cur.execute("SELECT COUNT(*) FROM city_value_curated WHERE city_id IS NOT NULL")
            mapped = cur.fetchone()["count"]

            # With value scores
            cur.execute("""
                SELECT COUNT(*) FROM city_value_curated c
                JOIN city_value cc ON cc.city_id = c.city_id
                WHERE cc.value_score > 0
            """)
            with_scores = cur.fetchone()["count"]

            # Under-covered (in list but low/no coverage)
            cur.execute("""
                SELECT c.city_name, c.country_code, c.region,
                       COALESCE(cc.value_score, 0) AS value_score,
                       COALESCE(cc.articles_7d, 0) AS articles_7d
                FROM city_value_curated c
                LEFT JOIN city_value cc ON cc.city_id = c.city_id
                WHERE cc.city_id IS NULL OR cc.articles_7d = 0
                ORDER BY c.region, c.city_name
            """)
            uncovered = cur.fetchall()

            print(f"\n=== 500 Curated Cities Status ===\n")
            print(f"Total in list:         {total}")
            print(f"Matched to world_cities: {mapped}")
            print(f"With value scores:   {with_scores}")
            print(f"Under-covered:          {len(uncovered)}")
            print()

            if uncovered:
                print("Under-covered cities (need source discovery):")
                print(f"{'City':<30} {'Country':<6} {'Region':<20} {'Score':<8} {'7d Art'}")
                print("-" * 80)
                for row in uncovered[:30]:
                    print(f"{row['city_name']:<30} {row['country_code']:<6} {row['region']:<20} "
                          f"{row['value_score']:<8.1f} {row['articles_7d']}")
                if len(uncovered) > 30:
                    print(f"... and {len(uncovered) - 30} more")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(description="500 Cool Cities management")
    parser.add_argument("--status", action="store_true", help="Show status")
    parser.add_argument("--undercovered", action="store_true", help="Show under-covered cities")
    args = parser.parse_args()

    if args.status or args.undercovered:
        show_status()
        return

    # Seed the cities
    result = seed_cities()
    print(f"\n=== Seeded 500 Cool Cities ===\n")
    print(f"New cities seeded: {result['seeded']}")
    print(f"Cities updated:    {result['updated']}")
    print(f"Total in list:     {result['total']}")


if __name__ == "__main__":
    main()
