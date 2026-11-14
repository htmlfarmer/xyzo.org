#!/usr/bin/env python3
"""
Country Name Normalization Utility

Maps country name variants to canonical ISO 3166-1 alpha-2 codes.
Handles:
- English names: "United States" -> "US"
- Native names: "Deutschland" -> "DE", "中国" -> "CN"
- ISO codes: "US" -> "US"
- Various spellings and abbreviations
"""

from typing import Dict, Optional

# Canonical ISO code mapping - English names
COUNTRY_NAME_TO_CODE: Dict[str, str] = {
    # Major countries (most frequent)
    "United States": "US",
    "US": "US",
    "United States of America": "US",
    "America": "US",
    "USA": "US",
    "U.S.": "US",
    "U.S.A.": "US",

    # China
    "China": "CN",
    "CN": "CN",
    "中国": "CN",
    "People's Republic of China": "CN",
    "PRC": "CN",

    # India
    "India": "IN",
    "IN": "IN",
    "भारत": "IN",
    "Bharat": "IN",

    # Brazil
    "Brasil": "BR",
    "Brazil": "BR",
    "BR": "BR",
    "Brasilien": "BR",

    # Germany
    "Deutschland": "DE",
    "Germany": "DE",
    "DE": "DE",
    "Germania": "DE",

    # Argentina
    "Argentina": "AR",
    "AR": "AR",
    "Argentine": "AR",

    # Turkey
    "Türkiye": "TR",
    "Turkey": "TR",
    "TR": "TR",
    "Turkiye": "TR",
    "Turkia": "TR",

    # Iran
    "ایران": "IR",
    "Iran": "IR",
    "IR": "IR",
    "Persia": "IR",
    "Iran, Islamic Republic of": "IR",

    # Indonesia
    "Indonesia": "ID",
    "ID": "ID",
    "Indonesien": "ID",
    "Republik Indonesia": "ID",

    # Australia
    "Australia": "AU",
    "AU": "AU",
    "Australian": "AU",
    "Australien": "AU",

    # France
    "France": "FR",
    "FR": "FR",
    "Francia": "FR",
    "Französische Republik": "FR",

    # Philippines
    "Philippines": "PH",
    "PH": "PH",
    "Pilipinas": "PH",
    "The Philippines": "PH",

    # Japan
    "日本": "JP",
    "Japan": "JP",
    "JP": "JP",
    "Nhật Bản": "JP",

    # Mexico
    "México": "MX",
    "Mexico": "MX",
    "MX": "MX",
    "Mexiko": "MX",

    # Italy
    "Italia": "IT",
    "Italy": "IT",
    "IT": "IT",
    "Italien": "IT",

    # Nigeria
    "Nigeria": "NG",
    "NG": "NG",
    "Nigerien": "NG",
    "Nigeriya": "NG",

    # United Kingdom
    "United Kingdom": "GB",
    "UK": "GB",
    "GB": "GB",
    "Britain": "GB",
    "Great Britain": "GB",
    "England": "GB",
    "U.K.": "GB",

    # Thailand
    "ประเทศไทย": "TH",
    "Thailand": "TH",
    "TH": "TH",
    "Thái Lan": "TH",

    # Peru
    "Perú": "PE",
    "Peru": "PE",
    "PE": "PE",
    "Piruw": "PE",

    # South Africa
    "South Africa": "ZA",
    "ZA": "ZA",
    "Suid-Afrika": "ZA",
    "Afrika": "ZA",

    # Romania
    "România": "RO",
    "Romania": "RO",
    "RO": "RO",
    "Rumania": "RO",

    # Malaysia
    "Malaysia": "MY",
    "MY": "MY",
    "Malaysien": "MY",
    "Malaisie": "MY",

    # Canada
    "Canada": "CA",
    "CA": "CA",
    "Kanada": "CA",
    "Canadá": "CA",

    # Colombia
    "Colombia": "CO",
    "CO": "CO",
    "Colombie": "CO",
    "Kolumbien": "CO",

    # Croatia
    "Hrvatska": "HR",
    "Croatia": "HR",
    "HR": "HR",
    "Kroatien": "HR",

    # Russia
    "Россия": "RU",
    "Russia": "RU",
    "RU": "RU",
    "Rossiyskaya Federatsiya": "RU",
    "Russie": "RU",
    "Russland": "RU",

    # Chile
    "Chile": "CL",
    "CL": "CL",
    "Chili": "CL",
    "Ŝilio": "CL",

    # Pakistan
    "پاکستان": "PK",
    "Pakistan": "PK",
    "PK": "PK",
    "Paquistão": "PK",

    # Nepal
    "नेपाल": "NP",
    "Nepal": "NP",
    "NP": "NP",
    "Nepa": "NP",

    # Bangladesh
    "বাংলাদেশ": "BD",
    "Bangladesh": "BD",
    "BD": "BD",
    "Bangladesch": "BD",

    # Portugal
    "Portugal": "PT",
    "PT": "PT",
    "Portugues": "PT",
    "Portugalia": "PT",

    # Vietnam
    "Việt Nam": "VN",
    "Vietnam": "VN",
    "VN": "VN",
    "Viet Nam": "VN",
    "Biet Nam": "VN",

    # Serbia
    "Србија": "RS",
    "Serbia": "RS",
    "RS": "RS",
    "Serbie": "RS",
    "Srbija": "RS",

    # Belgium
    "België / Belgique / Belgien": "BE",
    "Belgium": "BE",
    "BE": "BE",
    "Belgie": "BE",
    "Belgien": "BE",

    # Poland
    "Polska": "PL",
    "Poland": "PL",
    "PL": "PL",
    "Polen": "PL",

    # Venezuela
    "Venezuela": "VE",
    "VE": "VE",
    "Venezuelan": "VE",
    "Venezuela, Bolivarian Republic of": "VE",

    # Greece
    "Ελλάς": "GR",
    "Greece": "GR",
    "GR": "GR",
    "Hellenic Republic": "GR",
    "Ellas": "GR",
    "Grecia": "GR",

    # Czech Republic
    "Česko": "CZ",
    "Czech Republic": "CZ",
    "CZ": "CZ",
    "Czechia": "CZ",
    "Tschechien": "CZ",
    "Češka": "CZ",

    # Sweden
    "Sverige": "SE",
    "Sweden": "SE",
    "SE": "SE",
    "Schweden": "SE",
    "Suède": "SE",

    # Bulgaria
    "България": "BG",
    "Bulgaria": "BG",
    "BG": "BG",
    "Bulgarie": "BG",
    "Bulgarien": "BG",

    # Egypt
    "مصر": "EG",
    "Egypt": "EG",
    "EG": "EG",
    "Aegypten": "EG",
    "Égypte": "EG",
    "Egypten": "EG",

    # Korea (South)
    "대한민국": "KR",
    "South Korea": "KR",
    "KR": "KR",
    "Korea": "KR",
    "Korea, Republic of": "KR",
    "Republic of Korea": "KR",
    "Corea del Sud": "KR",

    # Hungary
    "Magyarország": "HU",
    "Hungary": "HU",
    "HU": "HU",
    "Ungarn": "HU",
    "Hongrie": "HU",

    # Slovakia
    "Slovensko": "SK",
    "Slovakia": "SK",
    "SK": "SK",
    "Slowakei": "SK",
    "Slovaquie": "SK",

    # Finland
    "Suomi / Finland": "FI",
    "Finland": "FI",
    "FI": "FI",
    "Finnland": "FI",
    "Finlande": "FI",

    # Tunisia
    "تونس": "TN",
    "Tunisia": "TN",
    "TN": "TN",
    "Tunisie": "TN",
    "Tunesis": "TN",

    # Bolivia
    "Bolivia": "BO",
    "BO": "BO",
    "Bolivian": "BO",
    "Estado Plurinacional de Bolivia": "BO",

    # Ecuador
    "Ecuador": "EC",
    "EC": "EC",
    "Equateur": "EC",
    "Ekuador": "EC",

    # Kenya
    "Kenya": "KE",
    "KE": "KE",
    "Kenia": "KE",
    "Kénya": "KE",

    # Moldova
    "Moldova": "MD",
    "MD": "MD",
    "Moldavie": "MD",
    "Moldawien": "MD",
    "Republic of Moldova": "MD",

    # Saudi Arabia
    "السعودية": "SA",
    "Saudi Arabia": "SA",
    "SA": "SA",
    "Saudi-Arabien": "SA",
    "Arabie Saoudite": "SA",

    # Algeria
    "ⵍⵣⵣⴰⵢⴻⵔ الجزائر": "DZ",
    "Algeria": "DZ",
    "DZ": "DZ",
    "Algerien": "DZ",
    "Algérie": "DZ",
    "Al-Jazair": "DZ",

    # Belarus
    "Беларусь": "BY",
    "Belarus": "BY",
    "BY": "BY",
    "Belorussia": "BY",
    "Weißrussland": "BY",

    # Norway
    "Norge": "NO",
    "Norway": "NO",
    "NO": "NO",
    "Norwegen": "NO",
    "Norvège": "NO",

    # Senegal
    "Sénégal": "SN",
    "Senegal": "SN",
    "SN": "SN",
    "Senegales": "SN",
    "Senegalien": "SN",

    # Dominican Republic
    "República Dominicana": "DO",
    "Dominican Republic": "DO",
    "DO": "DO",
    "Dominicana": "DO",
    "Republik Dominikan": "DO",

    # Yemen
    "اليمن": "YE",
    "Yemen": "YE",
    "YE": "YE",
    "Yaman": "YE",
    "Yémen": "YE",

    # Uzbekistan
    "Oʻzbekiston": "UZ",
    "Uzbekistan": "UZ",
    "UZ": "UZ",
    "Usbekistan": "UZ",
    "Ouzbékistan": "UZ",

    # Kazakhstan
    "Қазақстан": "KZ",
    "Kazakhstan": "KZ",
    "KZ": "KZ",
    "Khasakstan": "KZ",
    "Kasachstan": "KZ",

    # Ireland
    "Éire / Ireland": "IE",
    "Ireland": "IE",
    "IE": "IE",
    "Irland": "IE",
    "Irlande": "IE",

    # Austria
    "Österreich": "AT",
    "Austria": "AT",
    "AT": "AT",
    "Oesterreich": "AT",
    "Autriche": "AT",

    # Switzerland
    "Schweiz/Suisse/Svizzera/Svizra": "CH",
    "Switzerland": "CH",
    "CH": "CH",
    "Schweiz": "CH",
    "Suisse": "CH",
    "Svizzera": "CH",

    # Singapore
    "Singapore": "SG",
    "SG": "SG",
    "Singapur": "SG",
    "Singapour": "SG",
    "Singapora": "SG",

    # UAE
    "الإمارات العربية المتحدة": "AE",
    "United Arab Emirates": "AE",
    "AE": "AE",
    "UAE": "AE",
    "Vereinte Arabische Emirate": "AE",
    "Émirats Arabes Unis": "AE",

    # Morocco
    "Maroc ⵍⵎⵖⵔⵉⴱ المغرب": "MA",
    "Morocco": "MA",
    "MA": "MA",
    "Marokko": "MA",
    "Maroc": "MA",
    "Marruecos": "MA",

    # Ukraine
    "Україна": "UA",
    "Ukraine": "UA",
    "UA": "UA",
    "Ukrainian": "UA",
    "Ukrainska": "UA",
    "Ukrain": "UA",

    # Cameroon
    "Cameroun": "CM",
    "Cameroon": "CM",
    "CM": "CM",
    "Kamerun": "CM",
    "Cameroun": "CM",

    # Angola
    "Angola": "AO",
    "AO": "AO",
    "Angolen": "AO",

    # Guatemala
    "Guatemala": "GT",
    "GT": "GT",
    "Guatemalten": "GT",
    "Guatémala": "GT",

    # Qatar
    "قطر": "QA",
    "Qatar": "QA",
    "QA": "QA",
    "Katar": "QA",

    # Bosnia
    "Bosna i Hercegovina / Босна и Херцеговина": "BA",
    "Bosnia and Herzegovina": "BA",
    "BA": "BA",
    "Bosnien und Herzegowina": "BA",
    "Bosnie-Herzégovine": "BA",

    # Mozambique
    "Moçambique": "MZ",
    "Mozambique": "MZ",
    "MZ": "MZ",
    "Mosambik": "MZ",
    "Mozambique": "MZ",

    # Cuba
    "Cuba": "CU",
    "CU": "CU",
    "Kuba": "CU",
    "Cuban": "CU",

    # Panama
    "Panamá": "PA",
    "Panama": "PA",
    "PA": "PA",

    # Paraguay
    "Paraguay / Paraguái": "PY",
    "Paraguay": "PY",
    "PY": "PY",
    "Paraguai": "PY",

    # Lithuania
    "Lietuva": "LT",
    "Lithuania": "LT",
    "LT": "LT",
    "Litauen": "LT",
    "Lituanie": "LT",

    # Slovenia
    "Slovenija": "SI",
    "Slovenia": "SI",
    "SI": "SI",
    "Slowenien": "SI",
    "Slovaquie": "SI",

    # Estonia
    "Eesti": "EE",
    "Estonia": "EE",
    "EE": "EE",
    "Estland": "EE",
    "Estonie": "EE",

    # Oman
    "عمان": "OM",
    "Oman": "OM",
    "OM": "OM",

    # Jordan
    "الأردن": "JO",
    "Jordan": "JO",
    "JO": "JO",
    "Jordanien": "JO",

    # Iraq
    "العراق": "IQ",
    "Iraq": "IQ",
    "IQ": "IQ",
    "Irak": "IQ",
    "Irag": "IQ",

    # Azerbaijan
    "Azərbaycan": "AZ",
    "Azerbaijan": "AZ",
    "AZ": "AZ",
    "Aserbaidschan": "AZ",
    "Azerbaïdjan": "AZ",

    # Bahrain
    "البحرين": "BH",
    "Bahrain": "BH",
    "BH": "BH",
    "Bahreïn": "BH",
    "Bahrajn": "BH",

    # Luxembourg
    "Lëtzebuerg": "LU",
    "Luxembourg": "LU",
    "LU": "LU",
    "Luxemburg": "LU",

    # Latvia
    "Latvija": "LV",
    "Latvia": "LV",
    "LV": "LV",
    "Lettland": "LV",
    "Lettonie": "LV",

    # Kuwait
    "الكويت": "KW",
    "Kuwait": "KW",
    "KW": "KW",
    "Koweit": "KW",
    "Koweït": "KW",

    # Albania
    "Shqipëria": "AL",
    "Albania": "AL",
    "AL": "AL",
    "Albanien": "AL",
    "Albanie": "AL",

    # Armenia
    "Հայաստան": "AM",
    "Armenia": "AM",
    "AM": "AM",
    "Armenien": "AM",
    "Arménie": "AM",

    # Georgia
    "საქართველო": "GE",
    "Georgia": "GE",
    "GE": "GE",
    "Georgien": "GE",
    "Géorgie": "GE",

    # Myanmar
    "မြန်မာ": "MM",
    "Myanmar": "MM",
    "MM": "MM",
    "Birmanie": "MM",
    "Myanmar/Burma": "MM",

    # Malawi
    "Malawi": "MW",
    "MW": "MW",
    "Malawien": "MW",
    "Malawi": "MW",

    # Taiwan
    "臺灣": "TW",
    "Taiwan": "TW",
    "TW": "TW",
    "Formosa": "TW",
    "Republic of China": "TW",

    # Macedonia
    "Северна Македонија": "MK",
    "North Macedonia": "MK",
    "MK": "MK",
    "Mazedonien": "MK",
    "Macédoine du Nord": "MK",

    # Nicaragua
    "Nicaragua": "NI",
    "NI": "NI",
    "Nikaragua": "NI",
    "Nicaraguan": "NI",

    # Cyprus
    "Κύπρος - Kıbrıs": "CY",
    "Cyprus": "CY",
    "CY": "CY",
    "Zypern": "CY",
    "Chypre": "CY",

    # Turkmenistan
    "Türkmenistan": "TM",
    "Turkmenistan": "TM",
    "TM": "TM",
    "Turkménistan": "TM",
    "Turkmenistan": "TM",

    # Lebanon
    "لبنان": "LB",
    "Lebanon": "LB",
    "LB": "LB",
    "Libanon": "LB",
    "Liban": "LB",

    # Uruguay
    "Uruguay": "UY",
    "UY": "UY",
    "Uruguai": "UY",
    "Uruguayayan": "UY",

    # Costa Rica
    "Costa Rica": "CR",
    "CR": "CR",
    "Kostarika": "CR",
    "Costa-Rica": "CR",

    # Honduras
    "Honduras": "HN",
    "HN": "HN",
    "Honduran": "HN",
    "Hondurien": "HN",

    # South Sudan
    "South Sudan جنوب السودان": "SS",
    "South Sudan": "SS",
    "SS": "SS",
    "Südsudan": "SS",
    "Soudan du Sud": "SS",

    # Puerto Rico
    "Puerto Rico": "PR",
    "PR": "PR",
    "Porto Rico": "PR",
    "Porto-Rico": "PR",

    # Palestine
    "الأراضي الفلسطينية": "PS",
    "Palestine": "PS",
    "PS": "PS",
    "Palestinian Territories": "PS",
    "Palästina": "PS",
    "Palaestina": "PS",

    # Syria
    "سوريا": "SY",
    "Syria": "SY",
    "SY": "SY",
    "Syrien": "SY",
    "Syrie": "SY",

    # Israel
    "ישראל": "IL",
    "Israel": "IL",
    "IL": "IL",
    "Israele": "IL",
    "Israël": "IL",

    # Malta
    "Malta": "MT",
    "MT": "MT",
    "Malte": "MT",
    "Malt": "MT",

    # Ghana
    "Ghana": "GH",
    "GH": "GH",
    "Ghanan": "GH",
    "Ghanaian": "GH",

    # Uzbekistan
    "O'zbekiston": "UZ",
    "Uzbekistan": "UZ",
    "UZ": "UZ",

    # Madagascar
    "Madagasikara / Madagascar": "MG",
    "Madagascar": "MG",
    "MG": "MG",
    "Madagaskar": "MG",

    # Benin
    "Bénin": "BJ",
    "Benin": "BJ",
    "BJ": "BJ",
    "Beninien": "BJ",

    # Rwanda
    "Rwanda": "RW",
    "RW": "RW",
    "Rwandan": "RW",
    "Ruanda": "RW",

    # Libya
    "ⵍⵉⴱⵢⴰ ليبيا Libya": "LY",
    "Libya": "LY",
    "LY": "LY",
    "Libyen": "LY",
    "Libie": "LY",

    # Jamaica
    "Jamaica": "JM",
    "JM": "JM",
    "Jamaican": "JM",
    "Jamaika": "JM",

    # Sudan
    "السودان": "SD",
    "Sudan": "SD",
    "SD": "SD",
    "Soudan": "SD",
    "Sudanien": "SD",

    # Mali
    "Mali": "ML",
    "ML": "ML",
    "Malien": "ML",
    "Malines": "ML",

    # Burkina Faso
    "Burkina Faso": "BF",
    "BF": "BF",
    "Burkina": "BF",
    "Burkina Faso": "BF",

    # Haiti
    "Haiti": "HT",
    "HT": "HT",
    "Haïti": "HT",
    "Haitian": "HT",

    # Togo
    "Togo": "TG",
    "TG": "TG",
    "Togolese": "TG",
    "Togo": "TG",

    # Niger
    "Niger": "NE",
    "NE": "NE",
    "Nigerien": "NE",
    "Nigerian": "NE",

    # Chad
    "Tchad تشاد": "TD",
    "Chad": "TD",
    "TD": "TD",
    "Tchad": "TD",
    "Tschad": "TD",

    # Guinea
    "Guinée": "GN",
    "Guinea": "GN",
    "GN": "GN",
    "Guinean": "GN",
    "Guinée": "GN",

    # El Salvador
    "El Salvador": "SV",
    "SV": "SV",
    "Salvador": "SV",
    "Salvadorian": "SV",

    # Gabon
    "Gabon": "GA",
    "GA": "GA",
    "Gabun": "GA",
    "Gabonese": "GA",

    # Trinidad and Tobago
    "Trinidad and Tobago": "TT",
    "TT": "TT",
    "Trinidad": "TT",
    "Trinidad und Tobago": "TT",

    # Ethiopia
    "ኢትዮጵያ": "ET",
    "Ethiopia": "ET",
    "ET": "ET",
    "Äthiopien": "ET",
    "Éthiopie": "ET",

    # Brunei
    "Brunei": "BN",
    "BN": "BN",
    "Brunei Darussalam": "BN",
    "Brunei": "BN",

    # Papua New Guinea
    "Papua Niugini": "PG",
    "Papua New Guinea": "PG",
    "PG": "PG",
    "Papua-Neuguinea": "PG",
    "Papouasie-Nouvelle-Guinée": "PG",

    # Iceland
    "Ísland": "IS",
    "Iceland": "IS",
    "IS": "IS",
    "Islande": "IS",
    "Island": "IS",

    # Namibia
    "Namibia": "NA",
    "NA": "NA",
    "Namibian": "NA",
    "Namibie": "NA",

    # Botswana
    "Botswana": "BW",
    "BW": "BW",
    "Botswanan": "BW",
    "Botsuana": "BW",

    # Gambia
    "Gambia": "GM",
    "GM": "GM",
    "Gambian": "GM",
    "Gambie": "GM",

    # Burundi
    "Burundi": "BI",
    "BI": "BI",
    "Burundian": "BI",
    "Burundi": "BI",

    # Belize
    "Belize": "BZ",
    "BZ": "BZ",
    "Belizan": "BZ",
    "Belize": "BZ",

    # Djibouti
    "Djibouti جيبوتي": "DJ",
    "Djibouti": "DJ",
    "DJ": "DJ",
    "Dschibuti": "DJ",
    "Djibouti": "DJ",

    # Mauritania
    "Mauritanie موريتانيا": "MR",
    "Mauritania": "MR",
    "MR": "MR",
    "Mauretanien": "MR",
    "Mauritanie": "MR",

    # Mauritius
    "Mauritius / Maurice": "MU",
    "Mauritius": "MU",
    "MU": "MU",
    "Maurice": "MU",
    "Mauritius": "MU",

    # Sierra Leone
    "Sierra Leone": "SL",
    "SL": "SL",
    "Sierra Leonean": "SL",
    "Sierra Leona": "SL",

    # Liberia
    "Liberia": "LR",
    "LR": "LR",
    "Liberian": "LR",
    "Liberia": "LR",

    # Antigua and Barbuda
    "Antigua and Barbuda": "AG",
    "AG": "AG",
    "Antigua": "AG",
    "Antigua und Barbuda": "AG",

    # Grenada
    "Grenada": "GD",
    "GD": "GD",
    "Grenadian": "GD",
    "Grenade": "GD",

    # Barbados
    "Barbados": "BB",
    "BB": "BB",
    "Barbadian": "BB",
    "Barbados": "BB",

    # Saint Lucia
    "Saint Lucia": "LC",
    "LC": "LC",
    "St. Lucia": "LC",
    "Sainte-Lucie": "LC",

    # Guyana
    "Guyana": "GY",
    "GY": "GY",
    "Guyanese": "GY",
    "Guyane": "GY",

    # Suriname
    "Suriname": "SR",
    "SR": "SR",
    "Surinamese": "SR",
    "Surinam": "SR",

    # Maldives
    "Maldives": "MV",
    "MV": "MV",
    "Maldivian": "MV",
    "Malediven": "MV",

    # Fiji
    "Fiji": "FJ",
    "FJ": "FJ",
    "Fijian": "FJ",
    "Fidschi": "FJ",

    # Solomon Islands
    "Solomon Islands": "SB",
    "SB": "SB",
    "Solomon Islands": "SB",
    "Salomonen": "SB",

    # Tonga
    "Tonga": "TO",
    "TO": "TO",
    "Tongan": "TO",
    "Tonga": "TO",

    # Tuvalu
    "Tuvalu": "TV",
    "TV": "TV",
    "Tuvaluan": "TV",
    "Tuvalu": "TV",

    # Kiribati
    "Kiribati": "KI",
    "KI": "KI",
    "Kiribatian": "KI",
    "Kiribati": "KI",

    # Vanuatu
    "Vanuatu": "VU",
    "VU": "VU",
    "Vanuatuan": "VU",
    "Vanuatu": "VU",

    # Samoa
    "Samoa": "WS",
    "WS": "WS",
    "Samoan": "WS",
    "Samoa": "WS",

    # Seychelles
    "Seychelles": "SC",
    "SC": "SC",
    "Seychellois": "SC",
    "Seychellen": "SC",

    # Cape Verde
    "Cabo Verde": "CV",
    "Cape Verde": "CV",
    "CV": "CV",
    "Cabo Verde": "CV",
    "Kap Verde": "CV",

    # Comoros
    "Comoros": "KM",
    "KM": "KM",
    "Comorian": "KM",
    "Komoren": "KM",

    # Sao Tome and Principe
    "São Tomé and Príncipe": "ST",
    "ST": "ST",
    "Sao Tome and Principe": "ST",
    "São Tomé und Príncipe": "ST",

    # Equatorial Guinea
    "Equatorial Guinea": "GQ",
    "GQ": "GQ",
    "Guinea Ecuatorial": "GQ",
    "Guinée équatoriale": "GQ",
    "Äquatorialguinea": "GQ",

    # Guinea-Bissau
    "Guinea-Bissau": "GW",
    "GW": "GW",
    "Guinea Bissau": "GW",
    "Guinée-Bissau": "GW",

    # Eritrea
    "ኤርትራ Eritrea إرتريا": "ER",
    "Eritrea": "ER",
    "ER": "ER",
    "Érythrée": "ER",
    "Eritrea": "ER",

    # Central African Republic
    "Ködörösêse tî Bêafrîka / République centrafricaine": "CF",
    "Central African Republic": "CF",
    "CF": "CF",
    "Zentralafrika": "CF",
    "République centrafricaine": "CF",

    # Congo (Republic)
    "Congo": "CG",
    "CG": "CG",
    "Kongo": "CG",
    "Congo": "CG",
    "Republic of the Congo": "CG",

    # DR Congo
    "République démocratique du Congo": "CD",
    "Democratic Republic of the Congo": "CD",
    "CD": "CD",
    "DR Congo": "CD",
    "Kongo": "CD",
    "Kinshasa": "CD",
    "Zaire": "CD",

    # Tanzania
    "Tanzania": "TZ",
    "TZ": "TZ",
    "Tansania": "TZ",
    "Tanzanie": "TZ",

    # Uganda
    "Uganda": "UG",
    "UG": "UG",
    "Ugandan": "UG",
    "Uganda": "UG",

    # Zambia
    "Zambia": "ZM",
    "ZM": "ZM",
    "Sambia": "ZM",
    "Zambie": "ZM",

    # Zimbabwe
    "Zimbabwe": "ZW",
    "ZW": "ZW",
    "Simbabwe": "ZW",
    "Zimbabwe": "ZW",

    # Senegal
    "Senegal": "SN",
    "SN": "SN",

    # Somalia
    "Somalia": "SO",
    "SO": "SO",
    "Soomaaliya الصومال": "SO",
    "Soomaaliland أرض الصومال": "SO",
    "Somali": "SO",
    "Somaliens": "SO",

    # Afghanistan
    "افغانستان": "AF",
    "Afghanistan": "AF",
    "AF": "AF",
    "Afghan": "AF",
    "Afganistan": "AF",

    # Bhutan
    "འབྲུག་ཡུལ།": "BT",
    "Bhutan": "BT",
    "BT": "BT",
    "Bhutanese": "BT",
    "Bhután": "BT",

    # Sri Lanka
    "Sri Lanka": "LK",
    "LK": "LK",
    "Sri Lankan": "LK",
    "Ceylon": "LK",

    # Laos
    "ປະເທດລາວ": "LA",
    "Laos": "LA",
    "LA": "LA",
    "Laotian": "LA",
    "Lao": "LA",

    # Cambodia
    "ព្រះរាជាណាចក្រកម្ពុជា": "KH",
    "Cambodia": "KH",
    "KH": "KH",
    "Kambodscha": "KH",
    "Cambodge": "KH",

    # Mongolia
    "Монгол улс ᠮᠤᠩᠭᠤᠯ ᠤᠯᠤᠰ": "MN",
    "Mongolia": "MN",
    "MN": "MN",
    "Mongolei": "MN",
    "Mongolie": "MN",

    # Tajikistan
    "Тоҷикистон": "TJ",
    "Tajikistan": "TJ",
    "TJ": "TJ",
    "Tadschikistan": "TJ",
    "Tadjikistan": "TJ",

    # Kyrgyzstan
    "Кыргызстан": "KG",
    "Kyrgyzstan": "KG",
    "KG": "KG",
    "Kirgisistan": "KG",
    "Kirghizistan": "KG",

    # Iran
    "Iran": "IR",

    # Dominican Republic
    "Dominican Rep.": "DO",

    # Bosnia
    "Bosnia": "BA",
    "Herzegovina": "BA",
    "Bosnien": "BA",

    # Maldives
    "Maldivian Islands": "MV",

    # Myanmar
    "Burma": "MM",

    # Macedonia
    "Macedonia": "MK",
    "FYROM": "MK",

    # Palestine
    "Palestinian": "PS",
    "Palestina": "PS",
    "Palestinian Authority": "PS",
    "West Bank": "PS",
    "Gaza": "PS",

    # Antarctica
    "Antarctica": "AQ",
    "AQ": "AQ",

    # UN
    "UN": "UN",
    "United Nations": "UN",

    # European Union
    "EU": "EU",
    "European Union": "EU",

    # Kosovo
    "Kosova / Kosovo": "XK",
    "Kosovo": "XK",
    "XK": "XK",

    # Montenegro
    "Crna Gora / Црна Гора": "ME",
    "Montenegro": "ME",
    "ME": "ME",
    "Montenegro": "ME",

    # Liechtenstein
    "Liechtenstein": "LI",
    "LI": "LI",

    # San Marino
    "San Marino": "SM",
    "SM": "SM",

    # Monaco
    "Monaco": "MC",
    "MC": "MC",

    # Andorra
    "Andorra": "AD",
    "AD": "AD",

    # Vatican City
    "Civitas Vaticana - Città del Vaticano": "VA",
    "Vatican City": "VA",
    "Holy See": "VA",
    "VA": "VA",

    # Maldives
    "Maldives": "MV",

    # Timor-Leste
    "Timor-Leste": "TL",
    "East Timor": "TL",
    "TL": "TL",

    # Lesotho
    "Lesotho": "LS",
    "LS": "LS",

    # Eswatini
    "Eswatini": "SZ",
    "SZ": "SZ",
    "Swaziland": "SZ",

    # Djibouti
    "Djibouti": "DJ",

    # Guinea-Bissau
    "Guinea Bissau": "GW",

    # Bahamas
    "The Bahamas": "BS",
    "Bahamas": "BS",
    "BS": "BS",

    # Saint Kitts and Nevis
    "Saint Kitts and Nevis": "KN",
    "KN": "KN",
    "St. Kitts": "KN",

    # Saint Vincent and the Grenadines
    "Saint Vincent and the Grenadines": "VC",
    "VC": "VC",
    "St. Vincent": "VC",

    # Dominica
    "Dominica": "DM",
    "DM": "DM",

    # Saint Lucia
    "St Lucia": "LC",

    # Nauru
    "Nauru": "NR",
    "NR": "NR",

    # Palau
    "Palau": "PW",
    "PW": "PW",

    # Marshall Islands
    "Marshall Islands": "MH",
    "MH": "MH",

    # Micronesia
    "Micronesia": "FM",
    "FM": "FM",
    "Federated States of Micronesia": "FM",

    # Cook Islands
    "Cook Islands": "CK",
    "CK": "CK",

    # Niue
    "Niue": "NU",
    "NU": "NU",

    # Tokelau
    "Tokelau": "TK",
    "TK": "TK",

    # French Polynesia
    "French Polynesia": "PF",
    "PF": "PF",
    "Tahiti": "PF",

    # New Caledonia
    "New Caledonia": "NC",
    "NC": "NC",

    # Guam
    "Guam": "GU",
    "GU": "GU",

    # American Samoa
    "American Samoa": "AS",
    "AS": "AS",

    # Northern Mariana Islands
    "Northern Mariana Islands": "MP",
    "MP": "MP",

    # Puerto Rico
    "Porto Rico": "PR",

    # British Virgin Islands
    "British Virgin Islands": "VG",
    "VG": "VG",

    # US Virgin Islands
    "US Virgin Islands": "VI",
    "VI": "VI",

    # Cayman Islands
    "Cayman Islands": "KY",
    "KY": "KY",

    # Bermuda
    "Bermuda": "BM",
    "BM": "BM",

    # Greenland
    "Greenland": "GL",
    "GL": "GL",
    "Kalaallit Nunaat": "GL",

    # Faroe Islands
    "Faroe Islands": "FO",
    "FO": "FO",

    # Gibraltar
    "Gibraltar": "GI",
    "GI": "GI",

    # Guernsey
    "Guernsey": "GG",
    "GG": "GG",

    # Isle of Man
    "Isle of Man": "IM",
    "IM": "IM",

    # Jersey
    "Jersey": "JE",
    "JE": "JE",

    # Montserrat
    "Montserrat": "MS",
    "MS": "MS",

    # Anguilla
    "Anguilla": "AI",
    "AI": "AI",

    # British Indian Ocean Territory
    "British Indian Ocean Territory": "IO",
    "IO": "IO",

    # French Guiana
    "French Guiana": "GF",
    "GF": "GF",

    # Guadeloupe
    "Guadeloupe": "GP",
    "GP": "GP",

    # Martinique
    "Martinique": "MQ",
    "MQ": "MQ",

    # Reunion
    "Réunion": "RE",
    "RE": "RE",

    # Mayotte
    "Mayotte": "YT",
    "YT": "YT",

    # Saint Pierre and Miquelon
    "Saint Pierre and Miquelon": "PM",
    "PM": "PM",

    # South Georgia and the South Sandwich Islands
    "South Georgia and the South Sandwich Islands": "GS",
    "GS": "GS",

    # Falkland Islands
    "Falkland Islands": "FK",
    "FK": "FK",

    # Svalbard and Jan Mayen
    "Svalbard and Jan Mayen": "SJ",
    "SJ": "SJ",

    # Heard Island and McDonald Islands
    "Heard Island and McDonald Islands": "HM",
    "HM": "HM",

    # Cocos (Keeling) Islands
    "Cocos (Keeling) Islands": "CC",
    "CC": "CC",

    # Christmas Island
    "Christmas Island": "CX",
    "CX": "CX",

    # Norfolk Island
    "Norfolk Island": "NF",
    "NF": "NF",

    # Pitcairn
    "Pitcairn": "PN",
    "PN": "PN",

    # Wake Island
    "Wake Island": "UM",

    # Baker Island
    "Baker Island": "UM",

    # Howland Island
    "Howland Island": "UM",

    # Jarvis Island
    "Jarvis Island": "UM",

    # Johnston Atoll
    "Johnston Atoll": "UM",

    # Kingman Reef
    "Kingman Reef": "UM",

    # Midway Atoll
    "Midway Atoll": "UM",

    # Palmyra Atoll
    "Palmyra Atoll": "UM",

    # World / Global
    "World": "WW",
    "Global": "WW",
    "WW": "WW",

    # Unknown
    "XX": "XX",
    "Unknown": "XX",
}


def normalize_country(country_name: Optional[str]) -> Optional[str]:
    """
    Normalize a country name to its canonical ISO 3166-1 alpha-2 code.
    
    Args:
        country_name: The country name to normalize (can be ISO code, English name,
                     native name, or various spellings)
    
    Returns:
        The canonical ISO 3166-1 alpha-2 code, or the original input if not found
    """
    if not country_name:
        return None
    
    # Direct lookup (handles case-insensitive matching)
    name_lower = country_name.strip()
    
    # Try exact match first
    if name_lower in COUNTRY_NAME_TO_CODE:
        return COUNTRY_NAME_TO_CODE[name_lower]
    
    # Try with title case
    name_title = country_name.strip().title()
    if name_title in COUNTRY_NAME_TO_CODE:
        return COUNTRY_NAME_TO_CODE[name_title]
    
    # Try with uppercase
    name_upper = country_name.strip().upper()
    if name_upper in COUNTRY_NAME_TO_CODE:
        return COUNTRY_NAME_TO_CODE[name_upper]
    
    # Return as-is if no match found (it's likely already a valid ISO code)
    return country_name


def get_country_name(iso_code: str) -> Optional[str]:
    """
    Get the English name for a country from its ISO code.
    
    Args:
        iso_code: The ISO 3166-1 alpha-2 code
    
    Returns:
        The English name of the country, or None if not found
    """
    # Reverse lookup - find the canonical English name
    for name, code in COUNTRY_NAME_TO_CODE.items():
        if code == iso_code.upper() and len(name) > 2 and not name.isupper():
            return name
    return None


if __name__ == "__main__":
    # Test the normalization
    test_cases = [
        "United States",
        "US",
        "United Kingdom",
        "UK",
        "Deutschland",
        "中国",
        "中国",
        "Ελλάς",
        "Brasil",
        "Türkiye",
        "Россия",
        "日本",
        "invalid country",
        None,
    ]
    
    print("Country Name Normalization Test:")
    print("-" * 50)
    for test in test_cases:
        normalized = normalize_country(test)
        print(f"  '{test}' -> '{normalized}'")