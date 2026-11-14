"""One-shot migration: copy data from xyzo.world_cities + city_aliases
into xyzo_cities.public.cities + public.city_aliases.

Safe to re-run — uses ON CONFLICT DO NOTHING for idempotency.

Connects to xyzo_cities as cities_writer (write side) and to xyzo
as xyzo_app (read side). After the data is in place, the xyzo app
should be rewired to read from xyzo_cities via postgres_fdw.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("xyzo.cities_migrate")

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo",
)
CITIES_DSN = os.environ.get(
    "XYZO_CITIES_DSN",
    "postgresql://cities_writer:CHANGE_ME@localhost:5432/xyzo_cities",
)


# All ISO 3166-1 alpha-2 codes the loader has ever seen. This list is
# referenced from worker.learn.COUNTRY_POPULATION — keep them aligned
# so countries.bbox stays useful.
COUNTRIES: list[dict] = [
    # code, alpha3, name, region, subregion, population_m
    ("AD", "AND", "Andorra", "Europe", "Southern Europe", 0.08),
    ("AE", "ARE", "United Arab Emirates", "Asia", "Western Asia", 9.5),
    ("AF", "AFG", "Afghanistan", "Asia", "Southern Asia", 42.0),
    ("AG", "ATG", "Antigua and Barbuda", "Americas", "Caribbean", 0.1),
    ("AI", "AIA", "Anguilla", "Americas", "Caribbean", 0.02),
    ("AL", "ALB", "Albania", "Europe", "Southern Europe", 2.8),
    ("AM", "ARM", "Armenia", "Asia", "Western Asia", 3.0),
    ("AO", "AGO", "Angola", "Africa", "Middle Africa", 36.0),
    ("AR", "ARG", "Argentina", "Americas", "South America", 46.0),
    ("AS", "ASM", "American Samoa", "Oceania", "Polynesia", 0.04),
    ("AT", "AUT", "Austria", "Europe", "Western Europe", 9.0),
    ("AU", "AUS", "Australia", "Oceania", "Australia and New Zealand", 26.0),
    ("AW", "ABW", "Aruba", "Americas", "Caribbean", 0.1),
    ("AZ", "AZE", "Azerbaijan", "Asia", "Western Asia", 10.4),
    ("BA", "BIH", "Bosnia and Herzegovina", "Europe", "Southern Europe", 3.2),
    ("BB", "BRB", "Barbados", "Americas", "Caribbean", 0.3),
    ("BD", "BGD", "Bangladesh", "Asia", "Southern Asia", 173.0),
    ("BE", "BEL", "Belgium", "Europe", "Western Europe", 11.6),
    ("BF", "BFA", "Burkina Faso", "Africa", "Western Africa", 23.0),
    ("BG", "BGR", "Bulgaria", "Europe", "Eastern Europe", 6.5),
    ("BH", "BHR", "Bahrain", "Asia", "Western Asia", 1.5),
    ("BI", "BDI", "Burundi", "Africa", "Eastern Africa", 13.0),
    ("BJ", "BEN", "Benin", "Africa", "Western Africa", 13.0),
    ("BL", "BLM", "Saint Barthélemy", "Americas", "Caribbean", 0.01),
    ("BM", "BMU", "Bermuda", "Americas", "Northern America", 0.06),
    ("BN", "BRN", "Brunei Darussalam", "Asia", "South-Eastern Asia", 0.5),
    ("BO", "BOL", "Bolivia", "Americas", "South America", 12.0),
    ("BQ", "BES", "Bonaire, Sint Eustatius and Saba", "Americas", "Caribbean", 0.03),
    ("BR", "BRA", "Brazil", "Americas", "South America", 216.0),
    ("BS", "BHS", "Bahamas", "Americas", "Caribbean", 0.4),
    ("BT", "BTN", "Bhutan", "Asia", "Southern Asia", 0.8),
    ("BW", "BWA", "Botswana", "Africa", "Southern Africa", 2.7),
    ("BY", "BLR", "Belarus", "Europe", "Eastern Europe", 9.5),
    ("BZ", "BLZ", "Belize", "Americas", "Central America", 0.4),
    ("CA", "CAN", "Canada", "Americas", "Northern America", 40.0),
    ("CD", "COD", "Congo, Democratic Republic of the", "Africa", "Middle Africa", 102.0),
    ("CF", "CAF", "Central African Republic", "Africa", "Middle Africa", 5.0),
    ("CG", "COG", "Congo", "Africa", "Middle Africa", 6.0),
    ("CH", "CHE", "Switzerland", "Europe", "Western Europe", 8.8),
    ("CI", "CIV", "Côte d'Ivoire", "Africa", "Western Africa", 28.0),
    ("CK", "COK", "Cook Islands", "Oceania", "Polynesia", 0.02),
    ("CL", "CHL", "Chile", "Americas", "South America", 19.0),
    ("CM", "CMR", "Cameroon", "Africa", "Middle Africa", 28.0),
    ("CN", "CHN", "China", "Asia", "Eastern Asia", 1410.0),
    ("CO", "COL", "Colombia", "Americas", "South America", 52.0),
    ("CR", "CRI", "Costa Rica", "Americas", "Central America", 5.2),
    ("CU", "CUB", "Cuba", "Americas", "Caribbean", 11.0),
    ("CV", "CPV", "Cabo Verde", "Africa", "Western Africa", 0.6),
    ("CW", "CUW", "Curaçao", "Americas", "Caribbean", 0.15),
    ("CY", "CYP", "Cyprus", "Asia", "Western Asia", 1.3),
    ("CZ", "CZE", "Czechia", "Europe", "Eastern Europe", 10.5),
    ("DE", "DEU", "Germany", "Europe", "Western Europe", 84.0),
    ("DJ", "DJI", "Djibouti", "Africa", "Eastern Africa", 1.0),
    ("DK", "DNK", "Denmark", "Europe", "Northern Europe", 5.9),
    ("DM", "DMA", "Dominica", "Americas", "Caribbean", 0.07),
    ("DO", "DOM", "Dominican Republic", "Americas", "Caribbean", 11.0),
    ("DZ", "DZA", "Algeria", "Africa", "Northern Africa", 45.0),
    ("EC", "ECU", "Ecuador", "Americas", "South America", 18.0),
    ("EE", "EST", "Estonia", "Europe", "Northern Europe", 1.3),
    ("EG", "EGY", "Egypt", "Africa", "Northern Africa", 112.0),
    ("EH", "ESH", "Western Sahara", "Africa", "Northern Africa", 0.6),
    ("ER", "ERI", "Eritrea", "Africa", "Eastern Africa", 3.6),
    ("ES", "ESP", "Spain", "Europe", "Southern Europe", 48.0),
    ("ET", "ETH", "Ethiopia", "Africa", "Eastern Africa", 126.0),
    ("FI", "FIN", "Finland", "Europe", "Northern Europe", 5.6),
    ("FJ", "FJI", "Fiji", "Oceania", "Melanesia", 0.9),
    ("FK", "FLK", "Falkland Islands", "Americas", "South America", 0.004),
    ("FM", "FSM", "Micronesia, Federated States of", "Oceania", "Micronesia", 0.1),
    ("FO", "FRO", "Faroe Islands", "Europe", "Northern Europe", 0.05),
    ("FR", "FRA", "France", "Europe", "Western Europe", 68.0),
    ("GA", "GAB", "Gabon", "Africa", "Middle Africa", 2.4),
    ("GB", "GBR", "United Kingdom", "Europe", "Northern Europe", 67.0),
    ("GD", "GRD", "Grenada", "Americas", "Caribbean", 0.1),
    ("GE", "GEO", "Georgia", "Asia", "Western Asia", 3.7),
    ("GF", "GUF", "French Guiana", "Americas", "South America", 0.3),
    ("GG", "GGY", "Guernsey", "Europe", "Northern Europe", 0.07),
    ("GH", "GHA", "Ghana", "Africa", "Western Africa", 33.0),
    ("GI", "GIB", "Gibraltar", "Europe", "Southern Europe", 0.03),
    ("GL", "GRL", "Greenland", "Americas", "Northern America", 0.06),
    ("GM", "GMB", "Gambia", "Africa", "Western Africa", 2.5),
    ("GN", "GIN", "Guinea", "Africa", "Western Africa", 14.0),
    ("GP", "GLP", "Guadeloupe", "Americas", "Caribbean", 0.4),
    ("GQ", "GNQ", "Equatorial Guinea", "Africa", "Middle Africa", 1.5),
    ("GR", "GRC", "Greece", "Europe", "Southern Europe", 10.4),
    ("GS", "SGS", "South Georgia and the South Sandwich Islands", "Antarctic", None, 0.0),
    ("GT", "GTM", "Guatemala", "Americas", "Central America", 18.0),
    ("GU", "GUM", "Guam", "Oceania", "Micronesia", 0.2),
    ("GW", "GNB", "Guinea-Bissau", "Africa", "Western Africa", 2.0),
    ("GY", "GUY", "Guyana", "Americas", "South America", 0.8),
    ("HK", "HKG", "Hong Kong", "Asia", "Eastern Asia", 7.5),
    ("HN", "HND", "Honduras", "Americas", "Central America", 10.0),
    ("HR", "HRV", "Croatia", "Europe", "Southern Europe", 4.0),
    ("HT", "HTI", "Haiti", "Americas", "Caribbean", 11.7),
    ("HU", "HUN", "Hungary", "Europe", "Eastern Europe", 9.7),
    ("ID", "IDN", "Indonesia", "Asia", "South-Eastern Asia", 277.0),
    ("IE", "IRL", "Ireland", "Europe", "Northern Europe", 5.0),
    ("IL", "ISR", "Israel", "Asia", "Western Asia", 9.4),
    ("IM", "IMN", "Isle of Man", "Europe", "Northern Europe", 0.08),
    ("IN", "IND", "India", "Asia", "Southern Asia", 1430.0),
    ("IO", "IOT", "British Indian Ocean Territory", "Africa", "Eastern Africa", 0.0),
    ("IQ", "IRQ", "Iraq", "Asia", "Western Asia", 45.0),
    ("IR", "IRN", "Iran", "Asia", "Southern Asia", 89.0),
    ("IS", "ISL", "Iceland", "Europe", "Northern Europe", 0.4),
    ("IT", "ITA", "Italy", "Europe", "Southern Europe", 59.0),
    ("JE", "JEY", "Jersey", "Europe", "Northern Europe", 0.1),
    ("JM", "JAM", "Jamaica", "Americas", "Caribbean", 2.8),
    ("JO", "JOR", "Jordan", "Asia", "Western Asia", 11.0),
    ("JP", "JPN", "Japan", "Asia", "Eastern Asia", 124.0),
    ("KE", "KEN", "Kenya", "Africa", "Eastern Africa", 55.0),
    ("KG", "KGZ", "Kyrgyzstan", "Asia", "Central Asia", 6.7),
    ("KH", "KHM", "Cambodia", "Asia", "South-Eastern Asia", 17.0),
    ("KI", "KIR", "Kiribati", "Oceania", "Micronesia", 0.13),
    ("KM", "COM", "Comoros", "Africa", "Eastern Africa", 0.85),
    ("KN", "KNA", "Saint Kitts and Nevis", "Americas", "Caribbean", 0.05),
    ("KP", "PRK", "Korea, Democratic People's Republic of", "Asia", "Eastern Asia", 26.0),
    ("KR", "KOR", "Korea, Republic of", "Asia", "Eastern Asia", 52.0),
    ("KW", "KWT", "Kuwait", "Asia", "Western Asia", 4.3),
    ("KY", "CYM", "Cayman Islands", "Americas", "Caribbean", 0.07),
    ("KZ", "KAZ", "Kazakhstan", "Asia", "Central Asia", 20.0),
    ("LA", "LAO", "Lao People's Democratic Republic", "Asia", "South-Eastern Asia", 7.5),
    ("LB", "LBN", "Lebanon", "Asia", "Western Asia", 5.5),
    ("LC", "LCA", "Saint Lucia", "Americas", "Caribbean", 0.18),
    ("LI", "LIE", "Liechtenstein", "Europe", "Western Europe", 0.04),
    ("LK", "LKA", "Sri Lanka", "Asia", "Southern Asia", 22.0),
    ("LR", "LBR", "Liberia", "Africa", "Western Africa", 5.3),
    ("LS", "LSO", "Lesotho", "Africa", "Southern Africa", 2.3),
    ("LT", "LTU", "Lithuania", "Europe", "Northern Europe", 2.8),
    ("LU", "LUX", "Luxembourg", "Europe", "Western Europe", 0.65),
    ("LV", "LVA", "Latvia", "Europe", "Northern Europe", 1.8),
    ("LY", "LBY", "Libya", "Africa", "Northern Africa", 7.0),
    ("MA", "MAR", "Morocco", "Africa", "Northern Africa", 38.0),
    ("MC", "MCO", "Monaco", "Europe", "Western Europe", 0.04),
    ("MD", "MDA", "Moldova", "Europe", "Eastern Europe", 3.0),
    ("ME", "MNE", "Montenegro", "Europe", "Southern Europe", 0.62),
    ("MF", "MAF", "Saint Martin", "Americas", "Caribbean", 0.04),
    ("MG", "MDG", "Madagascar", "Africa", "Eastern Africa", 30.0),
    ("MH", "MHL", "Marshall Islands", "Oceania", "Micronesia", 0.06),
    ("MK", "MKD", "North Macedonia", "Europe", "Southern Europe", 2.1),
    ("ML", "MLI", "Mali", "Africa", "Western Africa", 22.0),
    ("MM", "MMR", "Myanmar", "Asia", "South-Eastern Asia", 55.0),
    ("MN", "MNG", "Mongolia", "Asia", "Eastern Asia", 3.4),
    ("MO", "MAC", "Macao", "Asia", "Eastern Asia", 0.7),
    ("MP", "MNP", "Northern Mariana Islands", "Oceania", "Micronesia", 0.05),
    ("MQ", "MTQ", "Martinique", "Americas", "Caribbean", 0.37),
    ("MR", "MRT", "Mauritania", "Africa", "Western Africa", 4.9),
    ("MS", "MSR", "Montserrat", "Americas", "Caribbean", 0.005),
    ("MT", "MLT", "Malta", "Europe", "Southern Europe", 0.5),
    ("MU", "MUS", "Mauritius", "Africa", "Eastern Africa", 1.3),
    ("MV", "MDV", "Maldives", "Asia", "Southern Asia", 0.5),
    ("MW", "MWI", "Malawi", "Africa", "Eastern Africa", 20.0),
    ("MX", "MEX", "Mexico", "Americas", "Central America", 130.0),
    ("MY", "MYS", "Malaysia", "Asia", "South-Eastern Asia", 34.0),
    ("MZ", "MOZ", "Mozambique", "Africa", "Eastern Africa", 33.0),
    ("NA", "NAM", "Namibia", "Africa", "Southern Africa", 2.6),
    ("NC", "NCL", "New Caledonia", "Oceania", "Melanesia", 0.3),
    ("NE", "NER", "Niger", "Africa", "Western Africa", 27.0),
    ("NF", "NFK", "Norfolk Island", "Oceania", "Australia and New Zealand", 0.002),
    ("NG", "NGA", "Nigeria", "Africa", "Western Africa", 223.0),
    ("NI", "NIC", "Nicaragua", "Americas", "Central America", 7.0),
    ("NL", "NLD", "Netherlands", "Europe", "Western Europe", 17.5),
    ("NO", "NOR", "Norway", "Europe", "Northern Europe", 5.5),
    ("NP", "NPL", "Nepal", "Asia", "Southern Asia", 30.0),
    ("NR", "NRU", "Nauru", "Oceania", "Micronesia", 0.01),
    ("NU", "NIU", "Niue", "Oceania", "Polynesia", 0.002),
    ("NZ", "NZL", "New Zealand", "Oceania", "Australia and New Zealand", 5.2),
    ("OM", "OMN", "Oman", "Asia", "Western Asia", 4.6),
    ("PA", "PAN", "Panama", "Americas", "Central America", 4.4),
    ("PE", "PER", "Peru", "Americas", "South America", 34.0),
    ("PF", "PYF", "French Polynesia", "Oceania", "Polynesia", 0.3),
    ("PG", "PNG", "Papua New Guinea", "Oceania", "Melanesia", 10.0),
    ("PH", "PHL", "Philippines", "Asia", "South-Eastern Asia", 117.0),
    ("PK", "PAK", "Pakistan", "Asia", "Southern Asia", 240.0),
    ("PL", "POL", "Poland", "Europe", "Eastern Europe", 41.0),
    ("PM", "SPM", "Saint Pierre and Miquelon", "Americas", "Northern America", 0.006),
    ("PN", "PCN", "Pitcairn", "Oceania", "Polynesia", 0.00005),
    ("PR", "PRI", "Puerto Rico", "Americas", "Caribbean", 3.2),
    ("PS", "PSE", "Palestine, State of", "Asia", "Western Asia", 5.0),
    ("PT", "PRT", "Portugal", "Europe", "Southern Europe", 10.3),
    ("PW", "PLW", "Palau", "Oceania", "Micronesia", 0.02),
    ("PY", "PRY", "Paraguay", "Americas", "South America", 7.5),
    ("QA", "QAT", "Qatar", "Asia", "Western Asia", 2.9),
    ("RE", "REU", "Réunion", "Africa", "Eastern Africa", 0.9),
    ("RO", "ROU", "Romania", "Europe", "Eastern Europe", 19.0),
    ("RS", "SRB", "Serbia", "Europe", "Southern Europe", 6.7),
    ("RU", "RUS", "Russian Federation", "Europe", "Eastern Europe", 144.0),
    ("RW", "RWA", "Rwanda", "Africa", "Eastern Africa", 14.0),
    ("SA", "SAU", "Saudi Arabia", "Asia", "Western Asia", 36.0),
    ("SB", "SLB", "Solomon Islands", "Oceania", "Melanesia", 0.7),
    ("SC", "SYC", "Seychelles", "Africa", "Eastern Africa", 0.1),
    ("SD", "SDN", "Sudan", "Africa", "Northern Africa", 47.0),
    ("SE", "SWE", "Sweden", "Europe", "Northern Europe", 10.5),
    ("SG", "SGP", "Singapore", "Asia", "South-Eastern Asia", 6.0),
    ("SH", "SHN", "Saint Helena", "Africa", "Western Africa", 0.005),
    ("SI", "SVN", "Slovenia", "Europe", "Southern Europe", 2.1),
    ("SJ", "SJM", "Svalbard and Jan Mayen", "Europe", "Northern Europe", 0.003),
    ("SK", "SVK", "Slovakia", "Europe", "Eastern Europe", 5.4),
    ("SL", "SLE", "Sierra Leone", "Africa", "Western Africa", 8.4),
    ("SM", "SMR", "San Marino", "Europe", "Southern Europe", 0.03),
    ("SN", "SEN", "Senegal", "Africa", "Western Africa", 17.0),
    ("SO", "SOM", "Somalia", "Africa", "Eastern Africa", 17.0),
    ("SR", "SUR", "Suriname", "Americas", "South America", 0.6),
    ("SS", "SSD", "South Sudan", "Africa", "Eastern Africa", 11.0),
    ("ST", "STP", "Sao Tome and Principe", "Africa", "Middle Africa", 0.23),
    ("SV", "SLV", "El Salvador", "Americas", "Central America", 6.5),
    ("SX", "SXM", "Sint Maarten", "Americas", "Caribbean", 0.04),
    ("SY", "SYR", "Syrian Arab Republic", "Asia", "Western Asia", 22.0),
    ("SZ", "SWZ", "Eswatini", "Africa", "Southern Africa", 1.2),
    ("TC", "TCA", "Turks and Caicos Islands", "Americas", "Caribbean", 0.04),
    ("TD", "TCD", "Chad", "Africa", "Middle Africa", 17.0),
    ("TG", "TGO", "Togo", "Africa", "Western Africa", 8.5),
    ("TH", "THA", "Thailand", "Asia", "South-Eastern Asia", 72.0),
    ("TJ", "TJK", "Tajikistan", "Asia", "Central Asia", 10.0),
    ("TK", "TKL", "Tokelau", "Oceania", "Polynesia", 0.002),
    ("TL", "TLS", "Timor-Leste", "Asia", "South-Eastern Asia", 1.3),
    ("TM", "TKM", "Turkmenistan", "Asia", "Central Asia", 6.2),
    ("TN", "TUN", "Tunisia", "Africa", "Northern Africa", 12.0),
    ("TO", "TON", "Tonga", "Oceania", "Polynesia", 0.1),
    ("TR", "TUR", "Türkiye", "Asia", "Western Asia", 85.0),
    ("TT", "TTO", "Trinidad and Tobago", "Americas", "Caribbean", 1.4),
    ("TV", "TUV", "Tuvalu", "Oceania", "Polynesia", 0.01),
    ("TW", "TWN", "Taiwan", "Asia", "Eastern Asia", 23.5),
    ("TZ", "TZA", "Tanzania", "Africa", "Eastern Africa", 67.0),
    ("UA", "UKR", "Ukraine", "Europe", "Eastern Europe", 37.0),
    ("UG", "UGA", "Uganda", "Africa", "Eastern Africa", 48.0),
    ("UM", "UMI", "United States Minor Outlying Islands", "Oceania", "Micronesia", 0.0),
    ("US", "USA", "United States", "Americas", "Northern America", 335.0),
    ("XK", "XKS", "Kosovo", "Europe", "Southern Europe", 1.8),
    ("XW", "XWA", "West Bank", "Asia", "Western Asia", 3.0),
    ("XG", "XGZ", "Gaza Strip", "Asia", "Western Asia", 2.1),
    ("UY", "URY", "Uruguay", "Americas", "South America", 3.5),
    ("UZ", "UZB", "Uzbekistan", "Asia", "Central Asia", 35.0),
    ("VA", "VAT", "Holy See (Vatican City State)", "Europe", "Southern Europe", 0.0008),
    ("VC", "VCT", "Saint Vincent and the Grenadines", "Americas", "Caribbean", 0.1),
    ("VE", "VEN", "Venezuela", "Americas", "South America", 29.0),
    ("VG", "VGB", "Virgin Islands, British", "Americas", "Caribbean", 0.03),
    ("VI", "VIR", "Virgin Islands, U.S.", "Americas", "Caribbean", 0.1),
    ("VN", "VNM", "Viet Nam", "Asia", "South-Eastern Asia", 100.0),
    ("VU", "VUT", "Vanuatu", "Oceania", "Melanesia", 0.3),
    ("WF", "WLF", "Wallis and Futuna", "Oceania", "Polynesia", 0.01),
    ("WS", "WSM", "Samoa", "Oceania", "Polynesia", 0.2),
    ("YE", "YEM", "Yemen", "Asia", "Western Asia", 33.0),
    ("YT", "MYT", "Mayotte", "Africa", "Eastern Africa", 0.3),
    ("ZA", "ZAF", "South Africa", "Africa", "Southern Africa", 60.0),
    ("ZM", "ZMB", "Zambia", "Africa", "Eastern Africa", 20.0),
    ("ZW", "ZWE", "Zimbabwe", "Africa", "Eastern Africa", 16.0),
]


# Approximate per-country bounding boxes for the anomaly detector.
# Pulled from worker/load_cities.py so the canonical set lives here.
COUNTRY_BBOX: dict[str, tuple[float, float, float, float]] = {
    "US": (17.5, 72.0, -180.0, -64.0),
    "CA": (42.0, 72.0, -140.0, -52.0),
    "MX": (14.0, 33.0, -118.0, -86.0),
    "BR": (-34.0, 6.0, -74.0, -34.0),
    "AR": (-56.0, -21.0, -74.0, -53.0),
    "GB": (49.0, 61.0, -8.0, 2.0),
    "FR": (41.0, 51.0, -5.0, 10.0),
    "DE": (47.0, 55.0, 6.0, 15.0),
    "IT": (36.0, 47.0, 6.0, 19.0),
    "ES": (27.0, 44.0, -10.0, 5.0),
    "PT": (32.0, 42.0, -10.0, -6.0),
    "NL": (50.0, 54.0, 3.0, 8.0),
    "PL": (49.0, 55.0, 14.0, 25.0),
    "UA": (44.0, 53.0, 22.0, 41.0),
    "RU": (41.0, 82.0, 19.0, 180.0),
    "TR": (35.0, 43.0, 25.0, 47.0),
    "EG": (21.0, 32.0, 24.0, 37.0),
    "NG": (4.0, 14.0, 2.0, 15.0),
    "ZA": (-35.0, -22.0, 16.0, 33.0),
    "KE": (-5.0, 5.0, 33.0, 42.0),
    "ET": (3.0, 15.0, 32.0, 48.0),
    "MA": (27.0, 36.0, -13.0, 0.0),
    "IN": (6.0, 36.0, 68.0, 98.0),
    "PK": (23.0, 37.0, 60.0, 78.0),
    "BD": (20.0, 27.0, 88.0, 93.0),
    "CN": (18.0, 54.0, 73.0, 135.0),
    "JP": (24.0, 46.0, 127.0, 146.0),
    "KR": (33.0, 39.0, 124.0, 132.0),
    "KP": (37.0, 43.0, 124.0, 131.0),
    "VN": (8.0, 24.0, 102.0, 110.0),
    "TH": (5.0, 21.0, 97.0, 106.0),
    "ID": (-11.0, 6.0, 94.0, 141.0),
    "PH": (4.0, 21.0, 117.0, 127.0),
    "MY": (0.5, 7.0, 99.0, 119.0),
    "SG": (1.0, 2.0, 103.0, 105.0),
    "AU": (-44.0, -10.0, 112.0, 154.0),
    "NZ": (-48.0, -34.0, 165.0, 179.0),
    "IR": (24.0, 40.0, 44.0, 64.0),
    "IQ": (29.0, 38.0, 38.0, 49.0),
    "SA": (15.0, 33.0, 34.0, 56.0),
    "AE": (22.0, 27.0, 51.0, 57.0),
    "IL": (29.0, 34.0, 34.0, 36.0),
    "PS": (31.0, 33.0, 34.0, 36.0),
    "LB": (33.0, 35.0, 35.0, 37.0),
    "JO": (29.0, 34.0, 34.0, 40.0),
    "AF": (29.0, 39.0, 60.0, 75.0),
    "YE": (12.0, 19.0, 42.0, 54.0),
}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    # 1. Seed countries reference.
    log.info("seeding countries reference...")
    with psycopg.connect(CITIES_DSN) as conn, conn.cursor() as cur:
        for code, alpha3, name, region, subregion, pop_m in COUNTRIES:
            cur.execute("""
                INSERT INTO public.countries (code, alpha3, name, region, subregion,
                                              population_m, bbox_min_lat, bbox_max_lat,
                                              bbox_min_lng, bbox_max_lng)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (code) DO UPDATE SET
                    alpha3 = EXCLUDED.alpha3,
                    name = EXCLUDED.name,
                    region = EXCLUDED.region,
                    subregion = EXCLUDED.subregion,
                    population_m = EXCLUDED.population_m
            """, (
                code, alpha3, name, region, subregion, pop_m,
                *(COUNTRY_BBOX.get(code, (None, None, None, None)))
            ))
        conn.commit()
        log.info("countries seeded: %d", len(COUNTRIES))

    # 2. Copy cities from xyzo.world_cities → xyzo_cities.public.cities.
    log.info("copying cities from xyzo.world_cities...")
    with psycopg.connect(XYZO_DSN, row_factory=dict_row) as src, \
         psycopg.connect(CITIES_DSN) as dst:
        with src.cursor() as scur:
            scur.execute("""
                SELECT geoname_id, name, ascii_name, country_code, state_name,
                       admin1_code, lat, lng, population, timezone, feature_code,
                       source, validated_at, notes
                FROM world_cities
            """)
            rows = scur.fetchall()
        log.info("read %d cities from source", len(rows))
        with dst.cursor() as dcur:
            COUNTRY_DICT = {c[0]: c[2] for c in COUNTRIES}
            for r in rows:
                search_text = " | ".join(filter(None, [
                    r["ascii_name"], r["name"],
                    COUNTRY_DICT.get(r["country_code"], ""),
                ])).lower()
                # Map old source labels to the new enum.
                src_map = {
                    "geonames": "geonames",
                    "user_csv": "user_csv",
                    "merged":   "merge",
                }
                src_kind = src_map.get(r["source"] or "geonames", "unknown")
                dcur.execute("""
                    INSERT INTO public.cities (
                        geoname_id, name, ascii_name, country_code,
                        state_code, state_name,
                        latitude, longitude, population, timezone,
                        feature_code, source, validated_at, validated_by,
                        notes, search_text, validation_score
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (geoname_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        ascii_name = EXCLUDED.ascii_name,
                        state_name = EXCLUDED.state_name,
                        latitude = EXCLUDED.latitude,
                        longitude = EXCLUDED.longitude,
                        population = EXCLUDED.population,
                        source = EXCLUDED.source,
                        validated_at = EXCLUDED.validated_at,
                        notes = EXCLUDED.notes
                """, (
                    r["geoname_id"], r["name"], r["ascii_name"], r["country_code"],
                    r.get("admin1_code"), r["state_name"],
                    r["lat"], r["lng"], r["population"], r["timezone"],
                    r["feature_code"], src_kind,
                    r["validated_at"], "load_cities.py" if r["source"] == "user_csv" else "build_cities_db.py",
                    r["notes"], search_text, 50,
                ))
        dst.commit()
        log.info("cities copied: %d", len(rows))

    # 3. Copy aliases.
    log.info("copying aliases from xyzo.city_aliases...")
    with psycopg.connect(XYZO_DSN, row_factory=dict_row) as src, \
         psycopg.connect(CITIES_DSN) as dst:
        with src.cursor() as scur:
            scur.execute("""
                SELECT ca.alias, ca.language, wc.geoname_id
                FROM city_aliases ca
                JOIN world_cities wc ON wc.id = ca.city_id
            """)
            rows = scur.fetchall()
        log.info("read %d aliases from source", len(rows))
        with dst.cursor() as dcur:
            for r in rows:
                dcur.execute("""
                    INSERT INTO public.city_aliases (city_id, alias, language, source)
                    SELECT id, %s, %s, 'manual'::cities_admin.source_kind
                    FROM public.cities WHERE geoname_id = %s
                    ON CONFLICT DO NOTHING
                """, (r["alias"], r["language"], r["geoname_id"]))
        dst.commit()
        log.info("aliases copied: %d", len(rows))

    # 4. Update manifest.
    with psycopg.connect(CITIES_DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM public.cities")
        n_cities = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM public.city_aliases")
        n_aliases = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM public.countries")
        n_countries = cur.fetchone()[0]
        cur.execute("""
            UPDATE cities_admin.manifest SET
                total_cities = %s,
                total_countries = %s,
                total_aliases = %s,
                last_load_at = now(),
                last_load_source = 'migrate_from_xyzo',
                last_load_batch = 'migrate_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
                last_load_row_count = %s,
                last_invalid_count = 0,
                updated_at = now()
        """, (n_cities, n_countries, n_aliases, n_cities))
        conn.commit()

    log.info("migration complete: %d cities, %d aliases, %d countries",
             n_cities, n_aliases, n_countries)


if __name__ == "__main__":
    main()
