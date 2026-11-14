/**
 * cityLookup.ts — Fast in-memory city geocoder.
 *
 * Strategy:
 *  - MAJOR_CITIES: ~200 most-searched cities loaded instantly (no DB).
 *  - warmCityLookup() optionally expands with world_cities (>50k pop) via
 *    the foreign table. Takes ~30s so runs in background.
 *  - findCity() checks MAJOR_CITIES first (always fast), then world_cities
 *    cache if available.
 */

interface CityEntry {
  lat: number;
  lng: number;
  countryCode: string;
  radiusKm: number;
}

// Loaded instantly — no DB call needed.
const MAJOR_CITIES: [string, number, number, string][] = [
  // [name, lat, lng, countryCode]
  ['New York', 40.7128, -74.006, 'US'],
  ['Los Angeles', 34.0522, -118.2437, 'US'],
  ['Chicago', 41.8781, -87.6298, 'US'],
  ['Houston', 29.7604, -95.3698, 'US'],
  ['Phoenix', 33.4484, -112.074, 'US'],
  ['Philadelphia', 39.9526, -75.1652, 'US'],
  ['San Antonio', 29.4241, -98.4936, 'US'],
  ['San Diego', 32.7157, -117.1611, 'US'],
  ['Dallas', 32.7767, -96.797, 'US'],
  ['San Jose', 37.3382, -121.8863, 'US'],
  ['Austin', 30.2672, -97.7431, 'US'],
  ['Jacksonville', 30.3322, -81.6557, 'US'],
  ['Fort Worth', 32.7555, -97.3308, 'US'],
  ['Columbus', 39.9612, -82.9988, 'US'],
  ['Charlotte', 35.2271, -80.8431, 'US'],
  ['Indianapolis', 39.7684, -86.1581, 'US'],
  ['Seattle', 47.6062, -122.3321, 'US'],
  ['Denver', 39.7392, -104.9903, 'US'],
  ['Boston', 42.3601, -71.0589, 'US'],
  ['Detroit', 42.3314, -83.0458, 'US'],
  ['Nashville', 36.1627, -86.7816, 'US'],
  ['Portland', 45.5051, -122.675, 'US'],
  ['Memphis', 35.1495, -90.049, 'US'],
  ['Oklahoma City', 35.4676, -97.5164, 'US'],
  ['Las Vegas', 36.1749, -115.1372, 'US'],
  ['Louisville', 38.2527, -85.7585, 'US'],
  ['Baltimore', 39.2904, -76.6122, 'US'],
  ['Milwaukee', 43.0389, -87.9065, 'US'],
  ['Albuquerque', 35.0844, -106.6504, 'US'],
  ['Tucson', 32.2226, -110.9747, 'US'],
  ['Fresno', 36.7378, -119.7871, 'US'],
  ['Mesa', 33.4152, -111.8315, 'US'],
  ['Sacramento', 38.5816, -121.4944, 'US'],
  ['Atlanta', 33.749, -84.388, 'US'],
  ['Kansas City', 39.0997, -94.5786, 'US'],
  ['Colorado Springs', 38.8339, -104.8214, 'US'],
  ['Miami', 25.7617, -80.1918, 'US'],
  ['Raleigh', 35.7796, -78.6382, 'US'],
  ['Omaha', 41.2565, -95.9345, 'US'],
  ['Cleveland', 41.4993, -81.6944, 'US'],
  ['Tampa', 27.9506, -82.4572, 'US'],
  ['Arlington', 32.7357, -97.1081, 'US'],
  ['New Orleans', 29.9511, -90.0715, 'US'],
  ['Bakersfield', 35.3733, -119.0187, 'US'],
  ['Honolulu', 21.3069, -157.8583, 'US'],
  ['Anaheim', 33.8366, -117.9143, 'US'],
  ['Aurora', 39.7294, -104.8319, 'US'],
  ['Santa Ana', 33.7455, -117.8677, 'US'],
  ['Riverside', 33.9806, -117.3755, 'US'],
  ['St. Louis', 38.627, -90.1994, 'US'],
  ['London', 51.5074, -0.1278, 'GB'],
  ['Birmingham', 52.4862, -1.8904, 'GB'],
  ['Manchester', 53.4808, -2.2426, 'GB'],
  ['Glasgow', 55.8642, -4.2518, 'GB'],
  ['Edinburgh', 55.9533, -3.1883, 'GB'],
  ['Leeds', 53.7997, -1.5491, 'GB'],
  ['Liverpool', 53.4084, -2.9916, 'GB'],
  ['Paris', 48.8566, 2.3522, 'FR'],
  ['Marseille', 43.2965, 5.3698, 'FR'],
  ['Lyon', 45.764, 4.8357, 'FR'],
  ['Toulouse', 43.6047, 1.4442, 'FR'],
  ['Nice', 43.7102, 7.262, 'FR'],
  ['Nantes', 47.2186, -1.5545, 'FR'],
  ['Strasbourg', 48.5734, 7.7521, 'FR'],
  ['Bordeaux', 44.8378, -0.5792, 'FR'],
  ['Berlin', 52.52, 13.405, 'DE'],
  ['Hamburg', 53.5511, 9.9937, 'DE'],
  ['Munich', 48.1351, 11.582, 'DE'],
  ['Cologne', 50.9375, 6.9603, 'DE'],
  ['Frankfurt', 50.1109, 8.6821, 'DE'],
  ['Stuttgart', 48.7758, 9.1829, 'DE'],
  ['Düsseldorf', 51.2277, 6.7735, 'DE'],
  ['Leipzig', 51.3397, 12.3731, 'DE'],
  ['Dortmund', 51.5136, 7.4653, 'DE'],
  ['Madrid', 40.4168, -3.7038, 'ES'],
  ['Barcelona', 41.3851, 2.1734, 'ES'],
  ['Valencia', 39.4699, -0.3763, 'ES'],
  ['Seville', 37.3891, -5.9845, 'ES'],
  ['Zaragoza', 41.6488, -0.8897, 'ES'],
  ['Málaga', 36.7213, -4.4214, 'ES'],
  ['Rome', 41.9028, 12.4964, 'IT'],
  ['Milan', 45.4642, 9.19, 'IT'],
  ['Naples', 40.8518, 14.2681, 'IT'],
  ['Turin', 45.0703, 7.6869, 'IT'],
  ['Florence', 43.7696, 11.2558, 'IT'],
  ['Venice', 45.4408, 12.3155, 'IT'],
  ['Bologna', 43.7696, 11.2558, 'IT'],
  ['Amsterdam', 52.3676, 4.9041, 'NL'],
  ['Rotterdam', 51.9244, 4.4777, 'NL'],
  ['The Hague', 52.0705, 4.3007, 'NL'],
  ['Eindhoven', 51.4416, 5.4697, 'NL'],
  ['Utrecht', 52.0907, 5.1214, 'NL'],
  ['Vienna', 48.2082, 16.3738, 'AT'],
  ['Brussels', 50.8503, 4.3517, 'BE'],
  ['Zurich', 47.3769, 8.5417, 'CH'],
  ['Geneva', 46.2044, 6.1432, 'CH'],
  ['Stockholm', 59.3293, 18.0686, 'SE'],
  ['Oslo', 59.9139, 10.7522, 'NO'],
  ['Copenhagen', 55.6761, 12.5683, 'DK'],
  ['Helsinki', 60.1699, 24.9384, 'FI'],
  ['Dublin', 53.3498, -6.2603, 'IE'],
  ['Lisbon', 38.7223, -9.1393, 'PT'],
  ['Porto', 41.1579, -8.6291, 'PT'],
  ['Prague', 50.0755, 14.4378, 'CZ'],
  ['Warsaw', 52.2297, 21.0122, 'PL'],
  ['Krakow', 50.0647, 19.945, 'PL'],
  ['Budapest', 47.4979, 19.0402, 'HU'],
  ['Bucharest', 44.4268, 26.1025, 'RO'],
  ['Athens', 37.9838, 23.7275, 'GR'],
  ['Istanbul', 41.0082, 28.9784, 'TR'],
  ['Moscow', 55.7558, 37.6173, 'RU'],
  ['St. Petersburg', 59.9311, 30.3609, 'RU'],
  ['Kiev', 50.4501, 30.5234, 'UA'],
  ['Minsk', 53.9045, 27.5615, 'BY'],
  ['Helsinki', 60.1699, 24.9384, 'FI'],
  ['Tokyo', 35.6762, 139.6503, 'JP'],
  ['Yokohama', 35.4437, 139.638, 'JP'],
  ['Osaka', 34.6937, 135.5023, 'JP'],
  ['Nagoya', 35.1815, 136.9066, 'JP'],
  ['Sapporo', 43.0642, 141.3469, 'JP'],
  ['Fukuoka', 33.5904, 130.4017, 'JP'],
  ['Seoul', 37.5665, 126.978, 'KR'],
  ['Busan', 35.1796, 129.0756, 'KR'],
  ['Incheon', 37.4563, 126.7052, 'KR'],
  ['Beijing', 39.9042, 116.4074, 'CN'],
  ['Shanghai', 31.2304, 121.4737, 'CN'],
  ['Guangzhou', 23.1291, 113.2644, 'CN'],
  ['Shenzhen', 22.5431, 114.0579, 'CN'],
  ['Hong Kong', 22.3193, 114.1694, 'HK'],
  ['Taipei', 25.033, 121.5654, 'TW'],
  ['Singapore', 1.3521, 103.8198, 'SG'],
  ['Kuala Lumpur', 3.139, 101.6869, 'MY'],
  ['Bangkok', 13.7563, 100.5018, 'TH'],
  ['Jakarta', -6.2088, 106.8456, 'ID'],
  ['Surabaya', -7.2575, 112.7521, 'ID'],
  ['Bandung', -6.9175, 107.6191, 'ID'],
  ['Medan', 3.5952, 98.6722, 'ID'],
  ['Manila', 14.5995, 120.9842, 'PH'],
  ['Ho Chi Minh City', 10.8231, 106.6297, 'VN'],
  ['Hanoi', 21.0285, 105.8542, 'VN'],
  ['Mumbai', 19.076, 72.8777, 'IN'],
  ['Delhi', 28.7041, 77.1025, 'IN'],
  ['Bangalore', 12.9716, 77.5946, 'IN'],
  ['Kolkata', 22.5726, 88.3639, 'IN'],
  ['Chennai', 13.0827, 80.2707, 'IN'],
  ['Hyderabad', 17.385, 78.4867, 'IN'],
  ['Pune', 18.5204, 73.8567, 'IN'],
  ['Ahmedabad', 23.0225, 72.5714, 'IN'],
  ['Karachi', 24.8607, 67.0011, 'PK'],
  ['Lahore', 31.5204, 74.3587, 'PK'],
  ['Islamabad', 33.6844, 73.0479, 'PK'],
  ['Dhaka', 23.8103, 90.4125, 'BD'],
  ['Colombo', 6.9271, 79.8612, 'LK'],
  ['Kathmandu', 27.7172, 85.324, 'NP'],
  ['Dubai', 25.2048, 55.2708, 'AE'],
  ['Abu Dhabi', 24.4539, 54.3773, 'AE'],
  ['Doha', 25.2854, 51.531, 'QA'],
  ['Riyadh', 24.7136, 46.6753, 'SA'],
  ['Jeddah', 21.5434, 39.1728, 'SA'],
  ['Kuwait City', 29.3759, 47.9774, 'KW'],
  ['Muscat', 23.588, 58.3829, 'OM'],
  ['Tel Aviv', 32.0853, 34.7818, 'IL'],
  ['Jerusalem', 31.7683, 35.2137, 'IL'],
  ['Beirut', 33.8938, 35.5018, 'LB'],
  ['Amman', 31.9454, 35.9284, 'JO'],
  ['Cairo', 30.0444, 31.2357, 'EG'],
  ['Alexandria', 31.2001, 29.9187, 'EG'],
  ['Casablanca', 33.5731, -7.5898, 'MA'],
  ['Rabat', 34.0209, -6.8416, 'MA'],
  ['Tunis', 36.8065, 10.1815, 'TN'],
  ['Lagos', 6.5244, 3.3792, 'NG'],
  ['Abuja', 9.0765, 7.3986, 'NG'],
  ['Kinshasa', -4.4419, 15.2663, 'CD'],
  ['Nairobi', -1.2921, 36.8219, 'KE'],
  ['Addis Ababa', 9.032, 38.7469, 'ET'],
  ['Accra', 5.6037, -0.187, 'GH'],
  ['Dakar', 14.7167, -17.4677, 'SN'],
  ['Johannesburg', -26.2041, 28.0473, 'ZA'],
  ['Cape Town', -33.9249, 18.4241, 'ZA'],
  ['Durban', -29.8587, 31.0218, 'ZA'],
  ['São Paulo', -23.5505, -46.6333, 'BR'],
  ['Rio de Janeiro', -22.9068, -43.1729, 'BR'],
  ['Brasília', -15.7975, -47.8919, 'BR'],
  ['Salvador', -12.9714, -38.5014, 'BR'],
  ['Buenos Aires', -34.6037, -58.3816, 'AR'],
  ['Santiago', -33.4489, -70.6693, 'CL'],
  ['Lima', -12.0464, -77.0428, 'PE'],
  ['Bogotá', 4.711, -74.0721, 'CO'],
  ['Caracas', 10.4806, -66.9036, 'VE'],
  ['Mexico City', 19.4326, -99.1332, 'MX'],
  ['Guadalajara', 20.6597, -103.3496, 'MX'],
  ['Monterrey', 25.6866, -100.3161, 'MX'],
  ['Toronto', 43.6532, -79.3832, 'CA'],
  ['Montreal', 45.5017, -73.5673, 'CA'],
  ['Vancouver', 49.2827, -123.1207, 'CA'],
  ['Calgary', 51.0447, -114.0719, 'CA'],
  ['Sydney', -33.8688, 151.2093, 'AU'],
  ['Melbourne', -37.8136, 144.9631, 'AU'],
  ['Brisbane', -27.4698, 153.0251, 'AU'],
  ['Perth', -31.9505, 115.8605, 'AU'],
  ['Auckland', -36.8509, 174.7645, 'NZ'],
  ['Wellington', -41.2866, 174.7756, 'NZ'],
];

const CITY_RADIUS_KM = 80;

function buildMajorCityMap(): Map<string, CityEntry> {
  const map = new Map<string, CityEntry>();
  for (const [name, lat, lng, cc] of MAJOR_CITIES) {
    map.set(name.toLowerCase(), { lat, lng, countryCode: cc, radiusKm: CITY_RADIUS_KM });
    // Also index by city name without country (e.g., "las vegas")
    map.set(name.replace(/[^a-z\s]/gi, '').trim().toLowerCase(), { lat, lng, countryCode: cc, radiusKm: CITY_RADIUS_KM });
  }
  return map;
}

const _majorCityMap: Map<string, CityEntry> = buildMajorCityMap();

let _worldCityMap: Map<string, CityEntry[]> | null = null;
let _loading = false;

export async function warmCityLookup(): Promise<void> {
  if (_worldCityMap) return;
  if (_loading) return;
  _loading = true;
  try {
    const sql = await import('../db').then(m => m.getDb());
    const rows = await sql<{ name: string; country_code: string; lat: number; lng: number; population: number }[]>`
      SELECT name, country_code, lat, lng, population
      FROM world_cities
      WHERE population > 100000
        AND name IS NOT NULL
        AND lat IS NOT NULL
        AND lng IS NOT NULL
    `;
    const map = new Map<string, CityEntry[]>();
    for (const row of rows) {
      const key = row.name.toLowerCase();
      const entry: CityEntry = { lat: row.lat, lng: row.lng, countryCode: row.country_code, radiusKm: CITY_RADIUS_KM };
      const existing = map.get(key);
      if (existing) { existing.push(entry); }
      else { map.set(key, [entry]); }
    }
    _worldCityMap = map;
  } finally {
    _loading = false;
  }
}

export interface CityMatch {
  lat: number;
  lng: number;
  name: string;
  countryCode: string;
  radiusKm: number;
}

// Known city+state combinations that need special handling (not in world_cities due to size)
// Maps lowercase "city state" -> {lat, lng, countryCode, name}
const KNOWN_CITY_STATE_ALIASES: Record<string, { lat: number; lng: number; countryCode: string; name: string }> = {
  'moscow idaho': { lat: 46.7324, lng: -117.0002, countryCode: 'US', name: 'Moscow, ID' },
  'moscow id': { lat: 46.7324, lng: -117.0002, countryCode: 'US', name: 'Moscow, ID' },
  'canton ohio': { lat: 40.7989, lng: -81.3785, countryCode: 'US', name: 'Canton, OH' },
  'canton oh': { lat: 40.7989, lng: -81.3785, countryCode: 'US', name: 'Canton, OH' },
  'fargo north dakota': { lat: 46.8772, lng: -96.7898, countryCode: 'US', name: 'Fargo, ND' },
  'fargo nd': { lat: 46.8772, lng: -96.7898, countryCode: 'US', name: 'Fargo, ND' },
  'spokane washington': { lat: 47.6588, lng: -117.4260, countryCode: 'US', name: 'Spokane, WA' },
  'spokane wa': { lat: 47.6588, lng: -117.4260, countryCode: 'US', name: 'Spokane, WA' },
  'boise idaho': { lat: 43.6150, lng: -116.2023, countryCode: 'US', name: 'Boise, ID' },
  'boise id': { lat: 43.6150, lng: -116.2023, countryCode: 'US', name: 'Boise, ID' },
};

// US state name to abbreviation mapping
const US_STATE_ABBREVS: Record<string, string> = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY',
};

// US state abbreviation to state name mapping (for reverse lookup)
const US_ABBREV_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_ABBREVS).map(([name, abbrev]) => [abbrev.toLowerCase(), name])
);

// Check if a name is a US state (full name or abbreviation)
function isUSState(name: string): string | null {
  const lower = name.toLowerCase();
  if (US_STATE_ABBREVS[lower]) return US_STATE_ABBREVS[lower];
  if (US_ABBREV_TO_STATE[lower]) return US_STATE_ABBREVS[US_ABBREV_TO_STATE[lower]];
  return null;
}

export function findCity(name: string): CityMatch | null {
  const lower = name.toLowerCase().trim();

  // Check known city+state aliases first (Moscow Idaho, Canton Ohio, etc.)
  const alias = KNOWN_CITY_STATE_ALIASES[lower];
  if (alias) {
    return { name: alias.name, lat: alias.lat, lng: alias.lng, countryCode: alias.countryCode, radiusKm: CITY_RADIUS_KM };
  }

  // Fast path: major cities (always available, no async needed)
  const major = _majorCityMap.get(lower);
  if (major) return { name, ...major };

  // Handle "City StateName" or "City StateAbbrev" patterns (e.g., "Moscow Idaho", "Canton Ohio", "Moscow ID")
  const words = lower.split(/\s+/);
  if (words.length >= 2) {
    // Try last word as state
    const lastWord = words[words.length - 1];
    const stateAbbrev = isUSState(lastWord);
    if (stateAbbrev) {
      const cityName = words.slice(0, -1).join(' ');
      const cityMajor = _majorCityMap.get(cityName);
      if (cityMajor && cityMajor.countryCode === 'US') {
        return { name, ...cityMajor };
      }
      // Also check worldCityMap for the city
      if (_worldCityMap) {
        const entries = _worldCityMap.get(cityName);
        if (entries?.length) {
          // Prefer US entry
          const usEntry = entries.find(e => e.countryCode === 'US');
          if (usEntry) {
            return { name, lat: usEntry.lat, lng: usEntry.lng, countryCode: usEntry.countryCode, radiusKm: CITY_RADIUS_KM };
          }
          // If no US entry but we have entries and the state matches, use first match
          const best = entries[0];
          return { name, lat: best.lat, lng: best.lng, countryCode: best.countryCode, radiusKm: CITY_RADIUS_KM };
        }
      }
    }
  }

  // Expand path: world cities cache
  if (_worldCityMap) {
    const entries = _worldCityMap.get(lower);
    if (entries?.length) {
      const best = entries.reduce((a, b) => (a.countryCode === 'US' && b.countryCode !== 'US') ? a : b);
      return { name, lat: best.lat, lng: best.lng, countryCode: best.countryCode, radiusKm: CITY_RADIUS_KM };
    }
  }
  return null;
}

export function makeBbox(lat: number, lng: number, radiusKm: number): [number, number, number, number] {
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((lat * Math.PI) / 180);
  const latDelta = radiusKm / kmPerDegLat;
  const lngDelta = radiusKm / kmPerDegLng;
  return [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
}
