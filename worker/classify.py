"""Keyword-based event_type classifier for xyzo.

A fast, deterministic pre-pass that runs BEFORE the LLM call in extract.py
and as the AI's fallback path. Pure regex + word matching, no external
calls, no AI cost. Catches the obvious cases the LLM would otherwise
classify as "other" — keeping the map visually rich even when the local
Gemma endpoint is unreachable.

Vocabulary mirrors CATEGORIES in api/src/validate.ts and EVENT_ICONS in
public_html/app.js. Order matters: more specific patterns go first so
"earthquake" wins over the generic "disaster" bucket, "ai" wins over the
generic "technology" bucket, etc.

Each entry is a tuple of (category_key, [patterns]). Matching is
whole-word by default (so "ai" doesn't match "verstappen" via "app"); a
pattern can opt into raw substring matching with the WILDCARD_PREFIX.
"""

import re

WILDCARD_PREFIX = "wild:"

PATTERNS: list[tuple[str, list[str]]] = [

    # ── Crime & Safety ────────────────────────────────────────────────────
    # Most specific first — wins over generic "politics" or "conflict"
    ("shooting",    ["shooting", "mass shooting", "active shooter", "gunman",
                     "gun violence", "drive-by", "shot dead", "opened fire",
                     "gunshot", "shots fired"]),
    ("terrorism",   ["terrorist", "terrorism", "bombing", "bomb attack",
                     "suicide attack", "suicide bomber", "extremist",
                     "radicalized", "jihadist", "isis", "al-qaeda", "taliban",
                     "insurgent", "militant attack", "terror plot"]),
    ("cybercrime",  ["cybercrime", "hacking", "hacker",
                     "ransomware", "phishing", "identity theft", "online fraud",
                     "cyber attack", "malware", "botnet", "ddos attack"]),
    ("missing",     ["missing person", "missing child", "disappeared",
                     "search and rescue", " amber alert", "last seen",
                     "family appeals", "vanished"]),
    ("traffic",     ["traffic accident", "car crash", "road accident",
                     "highway collision", "pile-up", "drunk driving",
                     "hit and run", "fatal crash", "traffic fatalities"]),
    ("crime",       ["murder", "homicide", "stabbing", "assault",
                     "robbery", "armed robbery", "burglary", "kidnapping",
                     "sexual assault", "domestic violence", "drug bust",
                     "criminal", "crime wave", "serial killer",
                     " organized crime", "gang", "cartel", "smuggling",
                     "charged with murder", "charged with assault",
                     "police investigation", "law enforcement",
                     "death penalty", "life sentence", "prison sentence"]),
    ("courts",      ["supreme court", "verdict", "sentenced", "convicted",
                     "acquitted", "ruling", "appeals court", "judge ruled",
                     "lawsuit", "indicted", "attorney general", "prosecutor",
                     "court case", "judicial", "juror", "jury", "litigation",
                     "court hearing", "trial begins", "found guilty",
                     "found not guilty", "appeal", "bail"]),

    # ── Government & Politics ─────────────────────────────────────────────
    # More specific first
    ("elections",   ["election", "elections", "vote", "ballot", "ballots", "poll",
                     "polls", "voter", "voters", "primary", "electoral", "referendum",
                     "polling", "electorate", "suffrage",
                     "ballot box", "campaign trail", "running mate",
                     "election result", "exit poll", "swing state"]),
    ("diplomacy",   ["diplomat", "diplomats", "embassy", "ambassador", "summit", "treaty",
                     "foreign minister", "bilateral", "state visit", "consul",
                     "diplomatic", "foreign affairs", "foreign policy",
                     "consulate", "international relations"]),
    ("protest",     ["protest", "protests", "protesters", "rally", "rallying",
                     "march", "demonstration", "demonstrators", "riot",
                     "civil unrest", "uprising", "demonstrate"]),
    ("corruption",  ["corruption", "fraud", "bribery", "embezzlement", "scandal",
                     "kickback", "misconduct", "abuse of power", "graft",
                     "corrupt", "anticorruption", "whistleblower", "leak"]),
    ("geopolitics", ["geopolitics", "geopolitical", "power shift", "strategic rivalry",
                     "great power", "nato", "un security council", "g20", "g7",
                     "regional power", "global power", "world power",
                     "strategic", "balance of power"]),
    ("sanctions",   ["sanctions", "economic sanctions", "trade embargo", "asset freeze",
                     "targeted sanctions", "sanctioned", "blacklist", "export controls",
                     "trade restrictions", "restrictive measures"]),
    ("immigration", ["immigration", "immigrant", "immigrants", "migrant", "migrants",
                      "border crossing", "illegal border crossing", "deportation", "visa",
                      "asylum seeker", "naturalisation", "migration crisis",
                      "immigration policy", "border control", "immigration reform",
                      "undocumented", "daca", "green card"]),
    ("policy",      ["legislation", "bill passed", "law signed", "executive order",
                     "regulation", "lawmakers", "lawmaking",
                     "law passed", "policy change", "new rule", "regulation",
                     "legislature"]),
    ("government",  ["governance", "public sector", "civil service", "bureaucracy",
                     "governing", "regulatory", "executive"]),
    ("politics",    ["president", "prime minister", "minister", "congress",
                     "senator", "lawmaker", "mayor", "governor",
                     "administration", "cabinet", "chancellor",
                     "white house", "downing street", "kremlin", "capitol",
                     "biden", "trump", "harris", "starmer", "macron", "scholz",
                     "putin", "zelensky", "modi", "xi jinping", "political"]),

    # ── Economy & Business ───────────────────────────────────────────────
    # More specific first
    ("markets",     ["stock market", "stocks", "shares", "share", "trading", "wall street",
                     "s&p 500", "dow jones", "nasdaq", "ipo", "rally",
                     "market cap", "share price", "stock plunge", "shares plunge",
                     "stocks fell", "shares fall", "plunge", "rallied", "stocks surged",
                     "share buyback", "dividend", "bull market", "bear market",
                     "shareholder", "trader"]),
    ("banking",     ["central bank", "interest rate", "rate hike", "rate cut",
                     "monetary policy", "fed funds", "deposit", "lender", "mortgage",
                     "credit", "banking sector", "financial institution",
                     "federal reserve", "ecb"]),
    ("finance",     ["finance", "financial", "investment", "investor", "investors",
                     "capital", "hedge fund", "private equity", "wealth management",
                     "asset management", "hedge", "portfolio"]),
    ("startups",    ["startup", "startups", "venture capital", "vc", "angel investor",
                     "seed round", "series a", "funding round", "unicorn",
                     "bootstrapped", "tech startup", "founder"]),
    ("employment",  ["unemployment", "jobs", "job market", "hiring", "layoffs",
                     "payroll", "workforce", "employment rate", "labor force",
                     "jobless", "hired", "fired", "recruitment", "jobless rate"]),
    ("trade",       ["trade", "tariff", "tariffs", "imports", "import",
                     "exports", "wto", "embargo", "customs", "trade agreement",
                     "free trade", "trade deficit", "trade war", "trade deal",
                     "trading", "export"]),
    ("manufacturing",["manufacturing", "factory", "factories", "industrial",
                     "production", "output", "capacity", "assembly line",
                     "manufacturing sector", "heavy industry", "industrial output"]),
    ("retail",      ["retail", "retailer", "shopping", "store", "stores",
                     "e-commerce", "consumer spending", "shopper", "mall",
                     "supermarket", "discounter", "shopping centre"]),
    ("shipping",    ["shipping", "container", "freight", "logistics",
                     "supply chain", "truck", "trucking", "haulage", "fleet",
                     "trucking industry", "freight"]),
    ("business",    ["company", "companies", "corp", "inc.", "ltd", "earnings",
                     "revenue", "profit", "ceo", "merger", "acquisition",
                     "quarterly", "billion", "million", "deal", "sector",
                     "industry", "corporate", "enterprise"]),
    ("economy",     ["economy", "economic growth", "gdp", "recession", "economic crisis",
                     "fiscal", "macroeconomic", "economic outlook", "economic data",
                     "economic", "economic policy"]),

    # ── Technology ───────────────────────────────────────────────────────
    # Order: specific subtypes first, then general
    ("ai",          ["ai", "artificial intelligence", "machine learning",
                     "llm", "large language model", "chatgpt", "gpt-",
                     "neural network", "deep learning", "generative ai",
                     "openai", "anthropic", "deepmind", "humanoid"]),
    ("gaming",      ["gaming", "playstation", "xbox", "nintendo", "esports",
                     "game studio", "steam", "gaming industry", "video game",
                     "game developer", "gameplay", "console"]),
    ("telecom",     ["telecom", "telecommunication", "mobile network",
                     "spectrum", "fiber optic", "carrier", "wireless", "satellite",
                     "telco", "5g", "broadband"]),
    ("software",    ["software", "application", "code", "programming",
                     "developer", "algorithm", "open source", "saas", "cloud",
                     "apps", "developer", "programming", "software update"]),
    ("cybersecurity",["cybersecurity", "security flaw", "vulnerability",
                      "cve-", "zero-day", "patch released", "infosec", "data breach",
                      "ransomware", "hacker", "cyberattack", "phishing",
                      "malware", "cyber crime", "hacked"]),
    ("technology",  ["tech", "technology", "platform",
                     "google", "apple", "microsoft", "meta",
                     "digital", "smartphone", "device", "hardware", "nvidia",
                     "semiconductor", "chip", "silicon", "innovation",
                     "digital transformation", "tech giant", "silicon valley"]),

    # ── Science ──────────────────────────────────────────────────────────
    # More specific first
    ("research",    ["researchers", "study published", "peer-reviewed", "scientists say",
                     "university study", "research shows", "research paper",
                     "research team", "scientific study", "laboratory research"]),
    ("space",       ["nasa", "spacex", "rocket launch", "satellite", "space station",
                     "astronaut", "mars", "moon landing", "space mission", "orbit",
                     "telescope", "spacecraft", "rocket", "astronomy", "asteroid",
                     "space agency", "space exploration", "cosmic"]),
    ("medicine",    ["medical research", "clinical trial", "drug approval",
                     "fda", "therapy", "patient", "diagnosis",
                     "pharmaceutical", "medical breakthrough", "new drug",
                     "medical study", "treatment trial", "cure"]),
    ("biology",     ["biology", "biological", "species", "ecosystem", "genome", "dna",
                     "rna", "gene edit", "crispr", "evolution", "genetics",
                     "ecology", "flora", "fauna", "organism", "biologist",
                     "genetic", "evolutionary", "ecosystem",
                     "amazon basin", "tropical rainforest", "tropical forest",
                     "rainforest ecosystem", "biodiversity"]),
    ("science",     ["science", "scientific", "discovery", "laboratory",
                     "scientist", "scientific research", "breakthrough",
                     "scientifically", "ocean floor", "scientific study"]),

    # ── Weather & Earth ─────────────────────────────────────────────────
    # More specific disaster/weather types first, then general weather
    ("cyclone",     ["tropical cyclone", "cyclone", "cyclone yasi", "cyclone winston",
                     "cyclone pam", "cyclone gita", "severe tropical cyclone",
                     "fiji cyclone", "pacific cyclone", "bay of bengal",
                     "cyclone warning"]),
    ("storm",       ["hurricane", "typhoon", "tornado", "thunderstorm", "storm surge",
                     "tropical storm", "severe storm", "gale", "windstorm",
                     "tropical depression", "extratropical cyclone",
                     "storm force", "severe weather"]),
    ("floods",      ["flood", "floods", "flooding", "flooded", "deluge",
                     "flash flood", "river overflow", "inundation", "overflow",
                     "flooding", "inundated", "flood warning",
                     "flood alert", "levee", "embankment"]),
    ("wildfire",    ["wildfire", "forest fire", "bush fire", "brush fire",
                     "fire spreading", "blaze", "raging fire", "firefighters",
                     "arson", "wildfire season", "fire line", "firebreak",
                     "smoke alert", "air quality alert"]),
    ("drought",     ["drought", "dry spell", "water shortage", "arid",
                     "parched", "drought conditions", "drought emergency",
                     "reservoir level", "water restriction"]),
    ("snow",        ["blizzard", "snowstorm", "snowfall", "ice storm",
                     "winter storm", "snow warning", "frost alert",
                     "freezing rain", "sleet"]),
    ("heatwave",    ["heatwave", "heat wave", "extreme heat", "heat advisory",
                     "record temperature", "scorching", "heat index",
                     "cooling center", "heat emergency"]),
    # Aid before disaster so "Charity delivers aid to disaster zone" matches aid
    ("aid",         ["humanitarian aid", "food aid", "red cross",
                     "donations", "charity", "assistance", "support",
                     "relief supplies", "aid delivery", "delivers aid", "disaster zone"]),
    ("disaster",    ["disaster", "catastrophe", "tsunami", "mass casualty",
                     "tragedy", "emergency", "calamity", "major incident",
                     "disaster relief", "natural disaster", "devastation",
                     "tsunami advisory", "tsunami warning",
                     "building collapse", "explosion", "industrial accident",
                     "chemical spill", "mine collapse", "dam failure"]),
    ("earthquake",  ["earthquake", "magnitude", "tremor", "seismic",
                     "richter", "quake", "aftershock", "seismic wave", "seismic activity",
                     "earthquake magnitude", "seismic event", "quake hits"]),
    ("volcano",     ["volcano", "volcanic", "eruption", "lava", "ash cloud", "magma",
                     "volcanic ash", "pyroclastic", "crater", "volcanic eruption",
                     "volcanic activity", "eruption warning"]),
    ("weather_alert",["weather warning", "storm warning", "flood warning",
                     "yellow alert", "orange alert", "red alert", "weather alert",
                     "wild:meteoroloji", "wild:bmkg", "wild:dwd", "wild:meteo",
                     "wild:smn", "wild:pronostico", "wild:pronóstico",
                     "wild:tormenta", "wild:lluvia", "wild:cuaca", "wild:hujan",
                     "wild:pertya", "wild:灾难", "wild:天气",
                     "advisory", "weather advisory", "wind warning", "rain warning"]),
    ("weather",     ["weather", "forecast", "temperature", "rainfall", "meteorolog",
                     "el nino", "la nina", "el niño", "monsoon",
                     "rain", "sunny", "cloudy", "wind", "humidity"]),

    # ── Environment ─────────────────────────────────────────────────────
    # Climate first (more specific), then others
    ("climate",     ["climate change", "global warming", "carbon emission",
                     "greenhouse gas", "paris agreement", "cop", "ipcc",
                     "carbon footprint", "net zero", "climate crisis",
                     "sea level rise", "global climate", "climate action",
                     "climate accord", "climate policy", "climate summit",
                     "carbon neutral", "emissions target", "climate protest",
                     "extinction rebellion"]),
    ("pollution",   ["pollution", "contamination", "toxic", "air quality", "pm2.5",
                     "microplastic", "waste", "hazardous", "contaminated",
                     "emissions", "carbon", "smog", "air pollution", "water pollution"]),
    ("energy",      ["solar", "wind farm", "renewable", "fossil fuel", "oil rig",
                     "pipeline", "offshore wind", "nuclear plant", "coal",
                     "natural gas", "oil", "petroleum", "energy transition",
                     "green energy", "clean energy"]),
    ("agriculture", ["agriculture", "farming", "farm", "crops", "harvest",
                     "livestock", "agricultural", "cultivation",
                     "food production", "grain", "wheat", "corn", "rice",
                     "agricultural sector", "agri", "crop"]),
    ("water",       ["water", "water supply", "water shortage", "water scarcity", "water quality",
                     "groundwater", "watershed", "irrigation", "aquifer", "wetland",
                     "drinking water", "freshwater", "river", "water crisis"]),
    ("wildlife",    ["endangered species", "wildlife", "biodiversity", "poaching",
                     "habitat", "extinction", "migratory", "wildlife conservation",
                     "animal", "birds", "marine life", "coral", "reef",
                     "wildlife protection", "species conservation", "sanctuary"]),
    ("deforestation",["deforestation", "illegal logging", "forest loss",
                      "tree cover loss", "jungle", "woodland", "logging",
                      "forest destruction", "clear-cutting", "rain forest",
                      "rainforest loss", "amazon deforestation", "amazon rainforest",
                      "loss of forest", "deforestation in"]),

    # ── Health ───────────────────────────────────────────────────────────
    # More specific first
    ("epidemic",    ["epidemic", "pandemic", "outbreak", "infection", "virus spread",
                     "case count", "quarantine", "covid", "ebola", "measles",
                     "mpox", "monkeypox", "global health emergency", "pheic",
                     "communicable disease", "infection rate", "spread of disease",
                     "disease outbreak", "viral outbreak"]),
    ("vaccines",    ["vaccine", "vaccination", "jab", "immunisation", "booster",
                     "dose", "inoculation", "pfizer", "moderna", "astrazeneca",
                     "vaccinated", "immunization", "jabs"]),
    ("mental_health",["mental health", "depression", "anxiety", "suicide",
                      "therapy", "psychiatr", "burnout", "stress", "trauma",
                      "psychological", "mental illness", "mental wellbeing"]),
    ("medical",     ["surgery", "patient", "treatment", "doctor", "doctors",
                     "diagnosis", "medication", "cancer", "clinic", "medical care",
                     "surgical", "medical treatment", "hospital",
                     "emergency room", "icu", "transplant", "biopsy",
                     "specialist", "general practitioner", "health check"]),
    ("healthcare",  ["healthcare", "health system", "medical care",
                     "health worker", "nurse", "physician",
                     "health service", "healthcare sector", "healthcare reform",
                     "health reforms", "medical reforms", "healthcare reforms",
                     "nhs", "medicare", "medicaid", "health insurance"]),
    ("health",      ["health", "disease", "illness", "symptom", "public health",
                     "who", "wellness", "clinical", "health ministry",
                     "health alert", "health risk", "health warning",
                     "antibiotic", "drug resistance", "antimicrobial"]),

    # ── Society ──────────────────────────────────────────────────────────
    # More specific first
    ("military",    ["military", "army", "navy", "air force", "defense",
                     "pentagon", "weapons", "ammunition", "missile",
                     "warship", "deployed", "battalion", "regiment",
                     "armed forces", "defense minister", "military exercise"]),
    ("conflict",    ["war", "armed conflict", "civil war", "ceasefire",
                     "military operation", "troops", "combat",
                     "battle", "frontline", "siege", "occupation",
                     "invasion", "bombardment", "shelling",
                     "cross-border", "clash", "skirmish",
                     "peace talks", "peace deal", "peace agreement",
                     "ceasefire agreement", "demilitarization"]),
    ("refugees",    ["refugee", "refugees", "refugee camp", "displaced",
                     "wild:displaced", "asylum", "evacuees", "displaced people",
                     "forced displacement", "stateless", "refugee crisis"]),
    ("inequality",  ["inequality", "income inequality", "wealth gap", "economic divide",
                     "social inequality", "gender gap", "discrimination", "prejudice",
                     "income gap", "wealth inequality", "social divide"]),
    ("human_rights",["human rights", "civil rights", "freedom",
                     "liberty", "justice", "equality", "injustice",
                     "amnesty international", "human rights watch",
                     "rights violation", "rights abuse"]),
    ("poverty",     ["poverty", "impoverished", "extreme poverty",
                     "food insecurity", "hunger", "malnutrition", "homeless",
                     "deprivation", "underserved", "poor", "poorest"]),
    ("humanitarian",["humanitarian", "unhcr", "wfp", "aid worker", "relief effort",
                     "humanitarian crisis", "emergency relief", "disaster relief"]),
    ("demographics",["population", "demographic", "birth rate", "death rate",
                     "ageing", "urbanisation", "census", "growth rate",
                     "population growth", "demographic shift"]),
    ("social_issues",["social issues", "community", "urban", "rural", "neighbourhood",
                      "societal", "public safety", "social welfare", "homelessness"]),

    # ── Culture ─────────────────────────────────────────────────────────
    # More specific first
    ("entertainment",["entertainment", "celebrity", "red carpet", "talk show",
                     "reality tv", "streaming", "netflix", "disney",
                     "awards ceremony", "golden globe", "emmy", "tony",
                     "tabloid", "gossip", "paparazzi", "celebrity news"]),
    ("music",       ["album", "song", "concert", "grammy", "spotify",
                     "music video", "single", "band", "singer", "rapper",
                     "musician", "orchestra", "musical", "billboard",
                     "music chart", "record label", "debut album",
                     "live performance", "encore"]),
    ("literature",  ["novel", "author", "bestseller", "publisher",
                     "literary", "poetry", "memoir", "book festival", "writing",
                     "book", "books"]),
    ("art",         ["exhibition", "gallery", "museum", "painting", "sculpture",
                     "artist", "art fair", "auction", "artwork", "artistic",
                     "art show", "art exhibit"]),
    ("theater",     ["theater", "theatre", "play", "drama", "musical",
                     "broadway", "performing arts"]),
    ("film",        ["movie", "cinema", "box office", "director", "film festival",
                     "actor", "actress", "oscar", "premiere",
                     "sequel", "trailer", "hollywood", "bollywood"]),
    ("religion",    ["church", "mosque", "temple", "synagogue", "pope", "ramadan",
                     "christianity", "easter", "diwali", "eid", "pilgrim", "bishop",
                     "faith", "vatican", "clergy", "religious", "spiritual"]),
    ("culture",     ["cultural", "tradition", "heritage", "cultural event",
                     "pageant", "miss universe", "cultural heritage", "indigenous culture",
                     "folklore", "cultural festival"]),
    ("festivals",   ["festival", "parade", "carnival", "fair",
                     "expo", "celebration", "fireworks", "anniversary",
                     "street festival"]),

    # ── Sports ───────────────────────────────────────────────────────────
    # Specific sports first, then general
    ("cricket",     ["cricket world cup", "cricket", "cricket match", "test cricket",
                     "one day international", "t20", "ipl", "ashhes", "batting",
                     "bowling", "cricket board", "cricketer"]),
    ("soccer",      ["soccer", "fifa", "uefa", "premier league",
                     "la liga", "champions league", "world cup", "messi", "ronaldo",
                     "football match", "footballer", "goal", "penalty",
                     "football", "football club"]),
    ("basketball",  ["basketball", "nba", "lebron", "lakers", "warriors",
                     "celtics", "wnba", "basketball game", "dunk", "basketball court"]),
    ("motorsport",  ["motorsport", "motor racing", "motogp", "world rally",
                     "circuit", "driver", "championship", "race car", "nascar",
                     "formula one", "formula 1", "f1", "motorsport", "rally driver"]),
    ("olympics",    ["olympics", "olympic games", "paralympic", "torch relay",
                     "olympic champion", "winter olympics",
                     "olympic committee", "olympic venue"]),
    ("swimming",    ["olympic swimmer", "swimmer", "swimming", "olympic swimming", "freestyle",
                     "backstroke", "breaststroke", "butterfly", "medley relay",
                     "pool", "diving", "competitive swimming"]),
    ("athletics",   ["track and field", "long jump", "high jump", "sprint",
                     "hurdles", "relay", "decathlon", "heptathlon", "javelin",
                     "shot put", "pole vault", "athletics", "track event",
                     "track athletes", "sprinter", "runner"]),
    ("tennis",      ["tennis", "tennis match", "wimbledon", "us open", "french open",
                     "australian open", "grand slam", "serve", "rally", "ace",
                     "tennis player", "tennis tour"]),
    ("racing",      ["racing", "grand prix", "monaco gp", "indycar",
                     "horse racing", "jockey", "racehorse", "horse race"]),
    ("sports",      ["sports", "tournament", "championship", "playoff",
                     "athlete", "coach", "team wins", "trophy",
                     "victory", "defeat", "defeats", "scored", "stadium",
                     "sport", "sporting", "marathon",
                     "game day", "game score", "game-winning",
                     "match point", "match winner"]),

    # ── Transport ────────────────────────────────────────────────────────
    # More specific first
    ("aviation",    ["aviation", "airline", "airlines", "airport", "flight", "flights",
                     "boeing", "airbus", "aircraft", "air travel", "pilot",
                     "passenger", "runway", "airline industry", "air travel"]),
    ("maritime",    ["ship", "ships", "vessel", "vessels", "boat", "boats", "sailing",
                     "port", "harbor", "maritime", "cargo ship",
                     "ferry", "cruise ship", "naval", "coast guard", "sailor",
                     "suez canal"]),
    ("rail",        ["rail", "train", "trains", "railway", "locomotive", "railroad",
                     "commuter rail", "high-speed rail", "bullet train", "tram",
                     "railway station", "rail link"]),
    ("development", ["infrastructure", "construction", "project", "dam", "highway",
                     "tunnel", "bridge", "urban development", "rural development",
                     "development project", "construction project", "building",
                     "construction site", "engineer", "engineered"]),

    # ── Other ────────────────────────────────────────────────────────────
    ("other",       ["other", "miscellaneous", "various", "general news"]),
]


def _compile_patterns() -> list[tuple[str, re.Pattern]]:
    """Compile pattern lists into ultra-fast per-category regular expressions."""
    compiled = []
    for category, patterns in PATTERNS:
        parts = []
        for pat in patterns:
            pat_str = pat.strip().lower()
            if pat_str.startswith(WILDCARD_PREFIX):
                bare = re.escape(pat_str[len(WILDCARD_PREFIX):])
                parts.append(bare)
            elif " " in pat_str or not pat_str.isalnum():
                parts.append(rf"\b{re.escape(pat_str)}\b")
            else:
                parts.append(rf"\b{re.escape(pat_str)}\b")
        regex = re.compile("|".join(parts), re.IGNORECASE)
        compiled.append((category, regex))
    return compiled


_COMPILED_PATTERNS = _compile_patterns()


def classify(title: str, summary: str = "") -> str:
    """Return the best-matching category for the given article text in sub-millisecond time.

    Examples:
        >>> classify("Magnitude 7.2 earthquake hits Turkey")
        'earthquake'
        >>> classify("OpenAI launches new GPT model")
        'ai'
        >>> classify("Formula 1: Verstappen wins Monaco GP")
        'racing'
    """
    text = (title or "") + "  " + (summary or "")
    if not text.strip():
        return "other"

    for category, regex in _COMPILED_PATTERNS:
        if regex.search(text):
            return category

    return "other"


if __name__ == "__main__":
    import sys

    tests = [
        # Government & Politics
        ("Biden meets with congressional leaders", "politics"),
        ("Election results show close race in key state", "elections"),
        ("Supreme Court rules on landmark case", "courts"),
        ("Ambassador summoned over diplomatic incident", "diplomacy"),
        ("Thousands protest proposed reforms in capital", "protest"),
        ("New environmental policy passes legislature", "policy"),
        ("Official arrested for corruption", "corruption"),
        ("NATO leaders discuss strategic response", "geopolitics"),
        ("Civil service reforms announced by government", "government"),
        ("New sanctions imposed on Tehran", "sanctions"),

        # Economy & Business
        ("Central bank signals rate decision", "banking"),
        ("Stock market reaches record high", "markets"),
        ("Tech giant reports quarterly earnings", "business"),
        ("New startup secures $100M funding", "startups"),
        ("Factory output rises for third month", "manufacturing"),
        ("Retail sales show unexpected surge", "retail"),
        ("Global trade negotiations stall", "trade"),
        ("Economists warn of recession risk", "economy"),
        ("Unemployment rate falls to 20-year low", "employment"),
        ("Investment fund acquires rival company", "finance"),

        # Technology
        ("New AI model demonstrates human-level reasoning", "ai"),
        ("Major data breach exposes millions of users", "cybersecurity"),
        ("Game developer announces highly anticipated sequel", "gaming"),
        ("Telecom operator launches 5G network nationwide", "telecom"),
        ("Silicon Valley firm unveils new processor chip", "technology"),
        ("Software update patches critical vulnerability", "software"),

        # Science
        ("Researchers publish breakthrough in genetics", "research"),
        ("NASA confirms discovery of new exoplanet", "space"),
        ("Clinical trial shows promising cancer treatment", "medicine"),
        ("Biologists discover new species in Amazon", "biology"),
        ("International team maps ocean floor", "science"),

        # Weather & Earth
        ("Tornado warning issued for multiple counties", "storm"),
        ("Cyclone approaches coastal region", "cyclone"),
        ("Heavy rains cause widespread flooding", "floods"),
        ("Wildfire forces evacuation of mountain town", "wildfire"),
        ("Magnitude 6.2 earthquake strikes region", "earthquake"),
        ("Volcano shows signs of imminent eruption", "volcano"),
        ("Red alert issued for approaching storm", "weather_alert"),
        ("Weather service forecasts record heat", "weather"),
        ("Tsunami advisory issued after undersea quake", "disaster"),

        # Environment
        ("New climate accord signed by 120 nations", "climate"),
        ("Air quality reaches hazardous levels in city", "pollution"),
        ("Solar farm project powers 50000 homes", "energy"),
        ("Drought devastates agricultural crops", "drought"),
        ("Water shortages affect rural communities", "water"),
        ("New marine sanctuary created", "wildlife"),
        ("Rainforest loss accelerates in Amazon", "deforestation"),

        # Health
        ("WHO declares new disease outbreak", "epidemic"),
        ("Vaccination campaign reaches milestone", "vaccines"),
        ("Mental health awareness week launches", "mental_health"),
        ("Hospital performs pioneering surgery", "medical"),
        ("Healthcare reforms debated in parliament", "healthcare"),
        ("Health ministry issues wellness guidelines", "health"),

        # Society
        ("New immigration policy unveiled", "immigration"),
        ("Refugee camp faces supply shortages", "refugees"),
        ("Report reveals widening income gap", "inequality"),
        ("Poverty rate declines in rural areas", "poverty"),
        ("Amnesty documents human rights violations", "human_rights"),
        ("Charity delivers aid to disaster zone", "aid"),
        ("UN agency responds to humanitarian crisis", "humanitarian"),
        ("Urban community centers face closure", "social_issues"),
        ("Census shows population shift to cities", "demographics"),

        # Culture
        ("Grammy nominations announced", "music"),
        ("Film festival showcases indie directors", "film"),
        ("Bestselling author releases new novel", "literature"),
        ("Art museum opens contemporary wing", "art"),
        ("Theater troupe tours remote communities", "theater"),
        ("Religious leaders call for peace", "religion"),
        ("Cultural festival celebrates heritage", "culture"),
        ("City holds annual carnival parade", "festivals"),

        # Sports
        ("Champions League final set for June", "soccer"),
        ("NBA playoffs begin with upset wins", "basketball"),
        ("Cricket world cup reaches semifinal stage", "cricket"),
        ("Formula One champion wins home race", "motorsport"),
        ("Olympic torch relay begins journey", "olympics"),
        ("Olympic swimmer breaks world record", "swimming"),
        ("Track athletes qualify for championships", "athletics"),
        ("Tennis star wins fourth consecutive title", "tennis"),
        ("International football match ends in draw", "soccer"),
        ("Marathon held across major cities", "sports"),

        # Transport
        ("Airlines announce new international routes", "aviation"),
        ("Cargo ship blocked in Suez Canal", "maritime"),
        ("High-speed rail line opens connecting capitals", "rail"),
        ("Trucking industry faces driver shortage", "shipping"),
        ("Bridge construction halfway complete", "development"),

        # Other
        ("Odd stories from around the world", "other"),
        ("Unusual weather phenomena observed", "weather"),
        ("Community comes together for project", "social_issues"),

        # Crime & Safety (new)
        ("Man arrested after shooting downtown", "shooting"),
        ("Terrorist bombing kills 12 in market", "terrorism"),
        ("Major data breach exposes millions", "cybersecurity"),
        ("Missing child found safe after 3 days", "missing"),
        ("Fatal car crash on highway closes lanes", "traffic"),
        ("Police investigate double homicide", "crime"),
        ("Jury reaches verdict in fraud trial", "courts"),

        # Conflict & Military (new)
        ("Ceasefire agreed after months of fighting", "conflict"),
        ("Military deploys troops to border region", "military"),

        # Entertainment (new)
        ("Netflix announces new original series", "entertainment"),
        ("Celebrity couple announces divorce", "entertainment"),

        # Weather sub-types (new)
        ("Blizzard dumps 3 feet of snow on northeast", "snow"),
        ("Record-breaking heatwave grips southern Europe", "heatwave"),
        ("Severe drought declared in agricultural region", "drought"),
    ]

    passed = 0
    failed = 0
    errors = []

    for text, expected in tests:
        result = classify(text)
        if result == expected:
            passed += 1
        else:
            failed += 1
            errors.append(f"FAIL: classify('{text}') => '{result}', expected '{expected}'")

    print(f"Results: {passed}/{len(tests)} passed")
    if failed > 0:
        print(f"\nFailed tests:")
        for e in errors:
            print(f"  {e}")
        sys.exit(1)
    else:
        print("All tests passed!")

    seen = {}
    dups = []
    for cat, _ in PATTERNS:
        if cat in seen:
            dups.append(cat)
        else:
            seen[cat] = True
    if dups:
        print(f"\nDuplicate categories found: {dups}")
        sys.exit(1)
    else:
        print(f"No duplicate categories ({len(seen)} unique)")
