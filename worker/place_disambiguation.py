"""Place disambiguation watchlist for small, multi-country ambiguous place names.

Problem: a place name like "Man" exists in many countries. The dominant
referent for plain "Man" is the city in Côte d'Ivoire (~7.4 N, -7.5 W,
pop ~150k). Nominatim + AI extraction both default to that, even when
the article is about a totally different "man" (e.g., an adult male,
or a different town's name). The pin lands in West Africa with no
justification from the article.

Strategy:
- For globally-famous places (Paris/France, London/UK, Moscow/Russia,
  Tokyo/Japan, etc.) the geocoder is reliable. We DON'T constrain
  those — the user's stated rule: context confirmation is mostly
  useful for smaller towns.
- For small towns whose name collides across countries, we require
  the article title/body to mention a context keyword (the country,
  the region, a nearby landmark, or a properly-formed "City, State"
  qualifier). If no context matches, we drop the location_text instead
  of pinning to a wrong country.

The watchlist is intentionally curated and easy to extend. Each entry
is keyed by the lowercase, comma-stripped bare place name; the
canonical forms (with qualifier) are also in the dict so we don't
double-check when the AI/regex already wrote "Moscow, Idaho".

Public surface:
  - ENTRIES            — dict of name -> {patterns, label}
  - disambiguate(loc, context) -> (keep: bool, reason: str)
  - is_qualified(loc)  — does the location string already include a
                          comma qualifier like "City, ST"?
"""
from __future__ import annotations

import re
from typing import Iterable

# Each entry's "patterns" is a list of compiled-free regex strings.
# At disambiguate() time we compile + cache once at module load.
# A qualifier like "Moscow, Idaho" is matched against both:
#   - the bare key "moscow"
#   - the qualified key "moscow, idaho"
# so writing either in the AI output bypasses the watchlist gate.
_RAW_ENTRIES: dict[str, dict] = {
    # ── Côte d'Ivoire town. Reject common phrases like "Spider-Man",
    # "Florida man", "man arrested" when not referring to the Ivory Coast town.
    "man": {
        "label": "Man (Côte d'Ivoire)",
        "reject_patterns": [
            r"\bspider-man\b", r"\biron-man\b", r"\batman\b", r"\bac-man\b",
            r"\bman\s+(?:was|is|dies|shot|found|arrested|killed|sentenced|charged|admits|throws|with)\b",
            r"\b(?:florida|young|local|chinese|pennsylvania|lybian|libyan|unidentified)\s+man\b",
        ],
        "patterns": [
            r"\bcôte\s+d['’]ivoire\b",
            r"\bivory\s+coast\b",
            r"\btonkpi\b",
            r"\bciv\b",
            r"\babidjan\b",
            r"\bwest\s+africa\b",
            r"\bafrica\b",
            r"\bnigeria\b",
            r"\bghana\b",
            r"\bguinea\b",
            r"\bliberia\b",
            r"\bsierra\s+leone\b",
            r"\bmali\b",
            r"\bburkina\b",
        ],
    },
    # ── Same: Tanzania town vs common English words "same", "same-day"
    "same": {
        "label": "Same (Tanzania)",
        "reject_patterns": [
            r"\bsame\s+(?:day|time|way|thing|place|page|rate|year|month|week|level|period|amount|size|type|kind|store|store-sales|category|price|issue|problem|result|reason)\b",
            r"\b(?:the|at\s+the|in\s+the|much\s+the|about\s+the|all\s+the|one\s+and\s+the|exact|exactly\s+the)\s+same\b",
            r"\bsame-day\b", r"\bsame-store\b", r"\bsame-sex\b",
        ],
        "patterns": [
            r"\btanzania\b", r"\btanzanian\b", r"\bkilimanjaro\b", r"\bpare\s+mountains\b",
            r"\bsame,\s*tz\b", r"\bsame\s+district\b", r"\bkiwira\b",
        ],
    },
    # ── Reading: Reading, UK / Reading, PA vs common word "reading"
    "reading": {
        "label": "Reading (UK/US)",
        "reject_patterns": [
            r"\breading\s+(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their|books?|list|room|glasses|habit|level|score|test|bill|meter|passage|material|mind|between|through|about|from|into|on|for|of|with|in)\b",
            r"\b(?:after|before|while|by|worth|enjoy|love|start|stop|keep|finished|began|recommended)\s+reading\b",
            r"\b(?:first|second|third)\s+reading\b", r"\b(?:required|further|bedtime|summer)\s+reading\b",
            r"\b(?:speed|mind|tarot|palm|meter|temperature|pressure)\s+reading\b",
        ],
        "patterns": [
            r"\bberkshire\b", r"\bengland\b", r"\buk\b", r"\bbritain\b", r"\brg1\b", r"\brg2\b",
            r"\breading\s+(?:fc|football|festival|station|university|uni|council|borough)\b",
            r"\bpennsylvania\b", r"\bpa\b", r"\bberks\s+county\b",
            r"\breading,\s*(?:uk|gb|pa|berkshire)\b",
        ],
    },
    # ── Mobile: Mobile, AL (US) vs "mobile phone / network / app"
    "mobile": {
        "label": "Mobile (Alabama, US)",
        "reject_patterns": [
            r"\bmobile\s+(?:phone|phones|app|apps|device|devices|network|networks|service|services|banking|money|data|user|users|game|games|gaming|payment|payments|tech|technology|internet|broadband|carrier|operators?|first|web|site|version|home|homes|clinic|unit|units|patrol|command|kitchen|suite|appstore|ios|android)\b",
            r"\b(?:auto|t|t-mobile|tmobile|china|t-mobile\s+us)\s+mobile\b",
        ],
        "patterns": [
            r"\balabama\b", r"\bal\b", r"\bmobile\s+bay\b", r"\bmobile\s+county\b",
            r"\bmobile\s+civic\b", r"\bmobile,\s*(?:al|alabama)\b", r"\bcity\s+of\s+mobile\b",
        ],
    },
    # ── University: University, FL (US) vs "university" as institution
    "university": {
        "label": "University (Florida, US)",
        "reject_patterns": [
            r"\buniversity\s+(?:of|at|in|for|and|the|a|an)\b",
            r"\b(?:the|a|an|my|his|her|their|our|its)\s+university\b",
            r"\buniversity\s+(?:campus|students?|faculty|professor|degree|program|research|department|college|school|library|hospital|medical|law|engineering|arts|science|education|administration|president|dean|chancellor)\b",
            r"\b(?:state|national|technical|community|private|public|research|medical|law|art)\s+university\b",
            r"\buniversity\s+(?:park|heights|city|area|district|quarter)\b",
        ],
        "patterns": [
            r"\bflorida\b", r"\bfl\b", r"\buniversity\s+city\b", r"\buniversity\s+park\b",
            r"\buniversity,\s*(?:fl|florida)\b", r"\balachua\b",
        ],
    },
    # ── Deal: Deal, UK / Deal, NJ vs common word "deal"
    "deal": {
        "label": "Deal (UK/US)",
        "reject_patterns": [
            r"\b(?:a|the|good|great|big|new|trade|peace|side|cut|close|sign|make|strike|reach|cancel|reject|approve|block|delay|abandon|secure)\s+deals?\b",
            r"\bdeals?\s+(?:with|for|to|on|of|in|between|worth|signed|struck|made|closed|done|reached|pending|approved|rejected)\b",
            r"\b(?:deal-making|dealmaking|dealmaker|dealmakers)\b",
        ],
        "patterns": [
            r"\bkent\b", r"\bengland\b", r"\buk\b", r"\bdover\b", r"\bdeal,\s*(?:uk|gb|kent)\b",
            r"\bnew\s+jersey\b", r"\bnj\b", r"\bmonmouth\b", r"\bdeal,\s*nj\b",
        ],
    },
    # ── Nice: Nice, France vs common word "nice"
    "nice": {
        "label": "Nice (France)",
        "reject_patterns": [
            r"\bnice\s+(?:car|job|gesture|day|touch|guy|place|weather|try|work|story|picture|photo|view|surprises?|words?|things?|idea|to|and)\b",
            r"\b(?:a|so|very|really|pretty|super|nice|kind|how|feel)\s+nice\b",
        ],
        "patterns": [
            r"\bfrance\b", r"\bfrench\b", r"\bcôte\s+d['’]azur\b", r"\bcote\s+d['’]azur\b",
            r"\briviera\b", r"\bpromenade\s+des\s+anglais\b", r"\balpes-maritimes\b",
            r"\bnice,\s*fr\b", r"\bnice\s+france\b", r"\bogc\s+nice\b",
        ],
    },
    # ── Bath: Bath, UK / Bath, US vs common word "bath"
    "bath": {
        "label": "Bath (UK/US)",
        "reject_patterns": [
            r"\b(?:a|take|took|taking|hot|ice|bubble|bird|sponge|bed|mud|blood|cold|warm)\s+baths?\b",
            r"\bbath\s+(?:tub|room|towel|salts|mat|water|bomb|house|tissue|product|products)\b",
            r"\bbloodbath\b",
        ],
        "patterns": [
            r"\bsomerset\b", r"\bengland\b", r"\buk\b", r"\bbath\s+spa\b", r"\bbath\s+abbey\b",
            r"\bbath\s+(?:rugby|university|uni)\b", r"\bbath,\s*(?:uk|gb|somerset)\b",
            r"\bmaine\b", r"\bme\b", r"\bnew\s+york\b", r"\bny\b",
        ],
    },
    # ── Normal: Normal, IL vs common word "normal"
    "normal": {
        "label": "Normal (Illinois, US)",
        "reject_patterns": [
            r"\b(?:is|was|are|were|be|been|feel|feels|return|returns|back|to|new|above|below|near|more|less|quite|fairly)\s+normal\b",
            r"\bnormal\s+(?:life|range|level|behavior|ops|operations|limits?|values?|distribution|conditions?)\b",
        ],
        "patterns": [
            r"\billinois\b", r"\bil\b", r"\bmclean\s+county\b", r"\bloomington-normal\b",
            r"\billinois\s+state\s+university\b", r"\bnormal,\s*(?:il|illinois)\b",
        ],
    },
    # ── Best: Best, Netherlands vs common word "best"
    "best": {
        "label": "Best (Netherlands)",
        "reject_patterns": [
            r"\b(?:the|my|your|his|her|its|our|their|one\s+of\b|at\s+its|for\s+the)\s+best\b",
            r"\bbest\s+(?:of|way|place|practices|performance|result|results|actor|actress|picture|album|song|movie|film|player|team|time|friend|friends|thing|things|seller|sellers|selling|wishes|regards)\b",
        ],
        "patterns": [
            r"\bnetherlands\b", r"\bdutch\b", r"\bnorth\s+brabant\b", r"\beindhoven\b",
            r"\bbest,\s*nl\b", r"\bgemeente\s+best\b",
        ],
    },
    # ── Van: Türkiye town vs "van" (vehicle/Dutch names)
    "van": {
        "label": "Van (Türkiye)",
        "reject_patterns": [
            r"\bvan\s+(?:gogh|hal|der|den|de|dijk|leeuwen|straaten|ryn|fleet|bellen|cleef|fleet)\b",
            r"\b(?:delivery|moving|cargo|white|police|camper|minivan|sprinter)\s+van\b",
            r"\bvan\s+(?:crash|accident|driver|struck|hit|found|stolen|rammed|vanished)\b",
            r"\bvan\s+tafel\b", r"\bvan\s+het\b", r"\bvan\s+de\b", r"\bvan\s+een\b",
        ],
        "patterns": [
            r"\btürkiye\b", r"\bturkey\b", r"\bturkish\b", r"\blake\s+van\b",
            r"\bvan,\s*tr\b", r"\bvan\s+province\b", r"\bkurdistan\b", r"\banatolia\b",
        ],
    },
    # ── Sur: Oman town vs "sur" (French preposition, Spanish south, "surprise")
    "sur": {
        "label": "Sur (Oman)",
        "reject_patterns": [
            r"\bsurprise\b", r"\bsurrender\b", r"\bsurface\b", r"\bsurreal\b",
            r"\bsurround\b", r"\bsurvey\b", r"\bsurvive\b", r"\bsurgeon\b",
            r"\bdel\s+sur\b", r"\bamérica\s+del\s+sur\b", r"\bsur\s+\d+\b",
        ],
        "patterns": [
            r"\boman\b", r"\bomani\b", r"\bsur,\s*om\b", r"\bsharqiyah\b",
            r"\bmuscat\b", r"\barabian\s+sea\b",
        ],
    },
    # ── Alexandria: Egypt vs Virginia (US) vs AOC (politician)
    "alexandria": {
        "label": "Alexandria (EG/US)",
        "reject_patterns": [
            r"\bocasio\b", r"\bcortez\b", r"\baoc\b",
            r"\bcongresswoman\b", r"\brep\.\s+alexandria\b",
            r"\brepresentative\s+alexandria\b",
        ],
        "patterns": [
            r"\begypt\b", r"\begyptian\b", r"\bcairo\b", r"\bnile\b", r"\bmediterranean\b",
            r"\bvirginia\b", r"\bva\b", r"\bdc\b", r"\bwashington\b", r"\bpotomac\b",
            r"\bminnesota\b", r"\bmn\b", r"\blouisiana\b", r"\bla\b", r"\brougemont\b",
            r"\bcinematheque\b", r"\balexandria,\s*egypt\b", r"\balexandria,\s*va\b",
        ],
    },
    # ── Split: Croatia (Split, HR) vs English word "split/splits/share split"
    "split": {
        "label": "Split (Croatia)",
        "reject_patterns": [
            r"\b(?:stock|share|reverse|equity|company|party|opposition|vote|coalition|opinion|country|government|cabinet|council)\s+split\b",
            r"\bsplit\s+(?:screen|second|level|ticket|bill|decision|vote|system|file|data|into|up|off|between|across|with|from|after|before|over|among|fears|tasks|on|down)\b",
            r"\b(?:splits|splitting|split-second|war-split|split-ticket|split-level|share-split)\b",
            r"\b(?:itunes|apple|microsoft|google|windows|mac|android|ios|app|appstore|tech|software|download|update|hybrid|compute|perplexity|engadget|remake)\b",
            r"\b(?:iceland|iran|nepal|japan|ukraine|zelenskyy|purdue|lockyer|gezirah|darfur|g20)\b",
        ],
        "patterns": [
            r"\bcroatia\b", r"\bcroatian\b", r"\bhrvatska\b", r"\bdalmatia\b", r"\bdalmatian\b", r"\badriatic\b",
            r"\bsplit,\s*hr\b", r"\bsplit\s+croatia\b", r"\bsplit\s+city\b", r"\bsplit\s+airport\b", r"\bhajduk\b",
        ],
    },
    # ── Jordan: Country vs Person (Michael Jordan, Jordan shoes)
    "jordan": {
        "label": "Jordan (Country/Person)",
        "reject_patterns": [
            r"\bmichael\s+jordan\b", r"\bjordan\s+shoes\b", r"\bair\s+jordan\b",
            r"\bjordan\s+poole\b", r"\bjordan\s+henderson\b", r"\bjordan\s+spieth\b",
            r"\bjordan\s+peele\b", r"\bjordan\s+peterson\b",
        ],
        "patterns": [
            r"\bamman\b", r"\bhashemite\b", r"\bking\s+abdullah\b", r"\bjordanian\b",
            r"\bmiddle\s+east\b", r"\bargob\b", r"\bzarqa\b", r"\birbid\b", r"\baqaba\b",
            r"\bjo\b", r"\bjordan,\b", r"\bin\s+jordan\b", r"\bjordan\b",
        ],
    },
    # ── Ise: Japan vs Turkish conjunction "ise" ("however/whereas")
    "ise": {
        "label": "Ise (Japan)",
        "reject_patterns": [
            r"\bgirenler\s+ise\b", r"\bise\s+en\s+fazla\b", r"\bise\s+hukuk\b",
            r"\bise\s+daha\b", r"\bise\s+sonuc\b",
        ],
        "patterns": [
            r"\bjapan\b", r"\bmie\b", r"\bise-shima\b", r"\bise\s+grand\s+shrine\b", r"\bise,\s*jp\b",
        ],
    },
    # ── Tema: Tema, Ghana vs Spanish/Portuguese/Romanian/Czech/Croatian word "tema" (topic/theme)
    # Tema is Ghana's primary port city (pop ~160k, Greater Accra). In Romance/Slavic languages,
    # "tema" is the everyday word for topic, subject, or musical track.
    "tema": {
        "label": "Tema (Ghana)",
        "reject_patterns": [
            r"\b(?:un|el|este|ese|aquel|otro|mismo|nuevo|gran|buen|sexto|primer|segundo|tercer|cada)\s+temas?\b",
            r"\btemas?\s+(?:de|del|para|sobre|en|con|por|musical|musicales|clave|central|principales?|políticos?|sociales?|económicos?|ambientales?|legales?)\b",
            r"\b(?:tratar|trata|tratan|hablar|habla|hablan|discutir|discute|tocó|tocar|abordar|aborda|abordó|abordan|debaten|debatir|cerrar|cerramos)\s+(?:el|este|un|ese)\s+temas?\b",
            r"\b(?:o|um|este|esse|aquele|outro|mesmo|novo|cada)\s+temas?\b",
            r"\btemas?\s+(?:da|do|dos|das|para|sobre)\b",
            r"\b(?:temă|teme|temele|temei)\b",
            r"\btema\s+etfs?\b",
        ],
        "patterns": [
            r"\bghana\b", r"\bghanaian\b", r"\baccra\b", r"\bgreater\s+accra\b",
            r"\btema\s+(?:port|harbour|harbor|motorway|station|oil|refinery|metropolitan|metro|assembly|newtown|manhean)\b",
            r"\bport\s+of\s+tema\b", r"\bgh¢\b", r"\bghs\b", r"\bcedis?\b",
            r"\btema,\s*(?:gh|ghana)\b",
        ],
    },
    "temas": {
        "label": "Temas (Not a place / Plural topic)",
        "patterns": [
            r"\bghana\b", r"\baccra\b",
        ],
    },
    # ── Opportunity: Opportunity, MD (census-designated place in Washington
    # County, Maryland, pop ~50) vs the common English word. Articles like
    # "Trump Has the Opportunity to Do the Funniest Thing" should NOT be
    # pinned to Maryland.
    "opportunity": {
        "label": "Opportunity (Maryland, US)",
        "reject_patterns": [
            # The bare word "opportunity" in any phrasing — once it's the
            # extracted_location_text the article is almost certainly about
            # the abstract concept, not the Maryland CDP.
            r"\b(?:the|a|an|this|that|every|each|great|golden|missed|lost|rare|once-in-a-lifetime|business|career|job|market|economic|sales)\s+opportunit(?:y|ies)\b",
            r"\bopportunit(?:y|ies)\s+(?:to|for|of|as|in)\b",
            r"\bopportunit(?:y|ies)\s*[,!.;:]",
        ],
        "patterns": [
            r"\bmaryland\b", r"\bmd\b", r"\bwashington\s+county\b", r"\bpg\s+county\b",
            r"\bprince\s+george'?s\s+county\b", r"\bcensus-designated\b",
            r"\bopportunity,\s*md\b", r"\bunincorporated\s+opportunity\b",
        ],
    },
    # ── Surprise: Surprise, AZ (pop ~100k) vs common word "surprise/surprising"
    "surprise": {
        "label": "Surprise (Arizona, US)",
        "reject_patterns": [
            r"\b(?:a|big|major|huge|total|complete|nice|pleasant|welcome|lovely|mild)\s+surprise\b",
            r"\bsurprise\s+(?:announcement|visit|gift|party|attack|win|winner|defeat|birthday|wedding|baby|ending|twist|move|decision|choice|result|outcome|verdict|release|drop)\b",
            r"\bsurprised\b", r"\bsurprising\b", r"\bsurprisingly\b",
            r"\bto\s+(?:my|our|his|her|their|a)\s+surprise\b",
        ],
        "patterns": [
            r"\barizona\b", r"\baz\b", r"\bmaricopa\s+county\b",
            r"\bsurprise,\s*az\b", r"\bcity\s+of\s+surprise\b",
            r"\bnfl\b", r"\bkansas\s+city\b", r"\bchiefs\b",
        ],
    },
    # ── Pleasant / Pleasanton / Pleasant Hill / Mount Pleasant / etc — vs
    # "pleasant" the adjective. Only fire when qualified (City, ST).
    "pleasant": {
        "label": "Pleasant (US)",
        "reject_patterns": [
            r"\bpleasant\s+(?:surprise|treat|experience|memory|weather|day|evening|morning|afternoon|view|conversation|tone|smile|voice|dream|time|ride|walk|chat|exchange|greeting|feeling|mood|atmosphere)\b",
            r"\b(?:a|very|quite|fairly|most|more|less)\s+pleasant\b",
        ],
        "patterns": [
            r"\bcalifornia\b", r"\bca\b", r"\biowa\b", r"\bia\b",
            r"\btexas\b", r"\btx\b", r"\bnew\s+york\b", r"\bny\b",
            r"\bsouth\s+carolina\b", r"\bsc\b",
            r"\bpleasant(?:on|ville|view|ridge|grove|hill|valley|garden|prairie|lake|gap|hill)\b",
            r"\bpleasant,\s*(?:ca|ia|tx|ny|sc)\b",
            r"\bmount\s+pleasant\b",
        ],
    },
    # ── Advance: Advance, NC / Advance, MO / etc vs "advance" the noun/verb
    "advance": {
        "label": "Advance (US)",
        "reject_patterns": [
            r"\badvance\s+(?:warning|notice|purchase|booking|reservation|order|payment|deposit|ticket|tickets|pass|stage|degree|degree|degree|years?|months?|weeks?|days?|hours?)\b",
            r"\bin\s+advance\b", r"\bthe\s+advance\s+of\b",
            r"\badvanced\b", r"\badvancing\b", r"\badvances?\s+(?:in|on|toward|against|by|of)\b",
            r"\b(?:major|significant|important|key|scientific|technological|medical|military|rapid|steady)\s+advances?\b",
        ],
        "patterns": [
            r"\bnorth\s+carolina\b", r"\bnc\b", r"\bdavidson\s+county\b",
            r"\bindiana\b", r"\bboone\s+county\b", r"\bmissouri\b", r"\bmo\b",
            r"\bmichigan\b", r"\bmi\b", r"\badvance,\s*(?:nc|in|mo|mi)\b",
        ],
    },
    # ── Justice: Justice, IL / Justice, WV vs "justice" the concept
    "justice": {
        "label": "Justice (US)",
        "reject_patterns": [
            r"\bjustice\s+(?:system|reform|department|minister|court|courts|league|of\s+the\s+peace)\b",
            r"\bsocial\s+justice\b", r"\bcriminal\s+justice\b", r"\bcivil\s+justice\b",
            r"\bdo\s+justice\b", r"\bperverted\s+the\s+justice\b",
            r"\bjustices?\s+(?:of|on|for|in|at)\b",
            r"\bchief\s+justice\b", r"\bassociate\s+justice\b", r"\bjustice\s+alito\b",
            r"\bto\s+(?:do|deliver|seek|demand|fight\s+for)\s+justice\b",
        ],
        "patterns": [
            r"\billinois\b", r"\bil\b", r"\bcook\s+county\b",
            r"\bwest\s+virginia\b", r"\bwv\b", r"\bputnam\s+county\b",
            r"\bjustice,\s*(?:il|wv)\b",
        ],
    },
    # ── Pay / Pays: Pays, UT vs "pay" the verb / "pays" the noun
    "pays": {
        "label": "Pays (Utah, US)",
        "reject_patterns": [
            r"\bpays?\s+(?:for|to|off|out|in|on|with|through)\b",
            r"\b(?:who|he|she|they|we|it|company|employer|firm)\s+pays?\b",
            r"\b(?:low|high|good|fair)\s+pays?\b",
            r"\bback\s+pay\b", r"\bpay\s+(?:check|cheque|raise|rise|cut|gap|equity|tv|wall|pal|attention)\b",
        ],
        "patterns": [
            r"\butah\b", r"\but\b", r"\butah\s+county\b",
            r"\bpays,\s*ut\b", r"\btown\s+of\s+pays\b",
        ],
    },
    # ── Moon: Moon, PA / Moon Township vs the celestial body / "moon" verb
    "moon": {
        "label": "Moon (Pennsylvania, US)",
        "reject_patterns": [
            r"\b(?:full|new|half|waxing|waning|crescent|gibbous|blue|blood|harvest|supermoon)\s+moon\b",
            r"\bmoon\s+(?:landing|rise|set|light|beam|phase|cycle|orbit|surface|eclipse|today|tonight|yesterday)\b",
            r"\b(?:to)\s+(?:moon|cry\s+for\s+the\s+moon|shoot\s+the\s+moon)\b",
            r"\bmoon\s+river\b", r"\bmoon\s+(?:is|was|will|does|could|might)\b",
        ],
        "patterns": [
            r"\bpennsylvania\b", r"\bpa\b", r"\ballegheny\s+county\b",
            r"\brobinson\s+township\b", r"\bmoon,\s*pa\b", r"\bmoon\s+township\b",
        ],
    },
    # ── Lira: Uganda vs Currency
    "lira": {
        "label": "Lira (Uganda)",
        "reject_patterns": [
            r"\bmilyar\s+lira\b", r"\bmillion\s+lira\b", r"\bturkish\s+lira\b", r"\btl\b",
            r"\bliralık\b", r"\bliraya\b", r"\bliradan\b", r"\blirayı\b",
        ],
        "patterns": [
            r"\buganda\b", r"\bnorthern\s+region\b", r"\blira,\s*ug\b", r"\blira\s+district\b",
        ],
    },
    # ── Kisi: Nigeria vs Turkish word for person ("kişi")
    "kisi": {
        "label": "Kisi (Nigeria)",
        "reject_patterns": [
            r"\bkişi\b", r"\b1\s+kisi\b", r"\b2\s+kisi\b", r"\b3\s+kisi\b", r"\b4\s+kisi\b",
            r"\b5\s+kisi\b", r"\bkaç\s+kisi\b",
        ],
        "patterns": [
            r"\bnigeria\b", r"\boyo\b", r"\bkisi,\s*ng\b", r"\boyo\s+state\b",
        ],
    },
    # ── Toda: Japan vs Spanish word "toda" ("all/whole")
    "toda": {
        "label": "Toda (Japan)",
        "reject_patterns": [
            r"\btoda\s+la\b", r"\btoda\s+su\b", r"\btoda\s+mi\b", r"\btoda\s+una\b",
            r"\btoda\s+esta\b", r"\btoda\s+nuestra\b", r"\ben\s+toda\b",
        ],
        "patterns": [
            r"\bjapan\b", r"\bsaitama\b", r"\btoda,\s*jp\b", r"\btoda\s+city\b",
        ],
    },
    # ── Aba: Nigeria vs Spanish verb ending / substring
    "aba": {
        "label": "Aba (Nigeria)",
        "reject_patterns": [
            r"\btrabajaba\b", r"\bpreparaba\b", r"\bcuidaba\b", r"\bestaba\b", r"\bllegaba\b",
        ],
        "patterns": [
            r"\bnigeria\b", r"\babia\b", r"\baba,\s*ng\b", r"\babia\s+state\b",
        ],
    },
    # ── Koga: Japan vs Serbo-Croatian pronoun "koga" ("whom/anyone")
    "koga": {
        "label": "Koga (Japan)",
        "reject_patterns": [
            r"\bniko\s+koga\b", r"\bkoga\s+poznajete\b", r"\bkoga\s+se\b", r"\bod\s+koga\b",
            r"\bdo\s+koga\b", r"\bza\s+koga\b",
        ],
        "patterns": [
            r"\bjapan\b", r"\bibaraki\b", r"\bkoga,\s*jp\b", r"\bkoga\s+city\b",
        ],
    },
    # ── Addison: Addison, IL vs viewer submission / child artwork / person names
    "addison": {
        "label": "Addison (US)",
        "reject_patterns": [
            r"\b(?:gmn|weather|morning)\s+sketch\b",
            r"\bsketch:\s*addison\b",
            r"\bartwork\b",
            r"\bdrawing\b",
            r"\baddison\s+(?:rae|smith|jones|johnson|williams|brown|davis|miller|wilson|taylor|anderson|thomas|jackson|white|harris|martin|thompson|garcia|martinez|robinson|clark|rodriguez|lewis|lee|walker|hall|allen|young|hernandez|king|wright|lopez|hill|scott|green|adams|baker|gonzalez|nelson|carter|mitchell|perez|roberts|turner|phillips|campbell|parker|evans|edwards|collins|stewart|sanchez|morris|rogers|reed|cook|morgan|bell|murphy|bailey|rivera|cooper|richardson|cox|howard|ward|torres|peterson|gray|ramirez|james|watson|brooks|kelly|sanders|price|bennett|wood|barnes|ross|henderson|coleman|jenkins|perry|powell|long|patterson|hughes|flores|washington|butler|simmons|foster|gonzales|bryant|alexander|russell|griffin|diaz|hayes)\b",
        ],
        "patterns": [
            r"\billinois\b", r"\bil\b",
            r"\btexas\b", r"\btx\b",
            r"\balabama\b", r"\bal\b",
            r"\bvermont\b", r"\bvt\b",
            r"\bmaine\b", r"\bme\b",
            r"\bchicago\b", r"\bdall?as\b", r"\bdupage\b",
            r"\baddison,\s*(?:il|tx|al|vt|me)\b",
        ],
    },
    # ── Algonquin: Algonquin, IL vs company/stock AQN / park / tribe
    "algonquin": {
        "label": "Algonquin (US)",
        "reject_patterns": [
            r"\b(?:aqn|tsx:?\s*aqn|nyse:?\s*aqn)\b",
            r"\balgonquin\s+(?:power|utilities|gas|college|park|native|tribe|indians|first\s+nation)\b",
            r"\b(?:selling|buying|stake|water\s+stake|stock|shares|earnings|dividend|returns|quarterly|reit)\b",
        ],
        "patterns": [
            r"\billinois\b", r"\bil\b",
            r"\bchicago\b", r"\bmchenry\b", r"\bkane\b",
            r"\balgonquin,\s*(?:il|illinois)\b",
            r"\bvillage\s+of\s+algonquin\b",
        ],
    },
    # ── Sale: UK / Australia town vs common business word ("sale", "for sale", "selling", "sales")
    "sale": {
        "label": "Sale (UK/AU)",
        "reject_patterns": [
            r"\b(?:for|on|asset|stock|home|house|car|retail|ticket|property|land|business)\s+sales?\b",
            r"\bsales?\s+(?:growth|tax|figures|report|volume|department|team|person|representative|force|pitch|event|price|discount)\b",
            r"\b(?:is|was|are|were|be|been)\s+selling\b",
            r"\bselling\s+(?:its|their|his|her|out|off|a|the|stake|assets|business|shares|stock)\b",
            r"\b(?:clearance|black\s+friday|cyber\s+monday|mega|annual|holiday|summer|winter)\s+sale\b",
        ],
        "patterns": [
            r"\bmanchester\b", r"\btrafford\b", r"\bcheshire\b", r"\bengland\b", r"\buk\b",
            r"\bvictoria\b", r"\bgippsland\b", r"\baustralia\b", r"\bau\b",
            r"\bsale,\s*(?:uk|gb|au|vic)\b",
        ],
    },
    # ── Springfield: 30+ places in the US. Default geocoder picks
    # Springfield, Illinois (state capital).
    "springfield": {
        "label": "Springfield (US)",
        "patterns": [
            r"\billinois\b", r"\bil\b",
            r"\bmissouri\b", r"\bmo\b",
            r"\bmassachusetts\b", r"\bma\b",
            r"\boregon\b", r"\bor\b",
            r"\bohio\b",
            r"\bnew\s+jersey\b", r"\bnj\b",
            r"\bvirginia\b", r"\bva\b",
            r"\bcolorado\b", r"\bco\b",
            r"\btennessee\b", r"\btn\b",
            r"\bflorida\b", r"\bfl\b",
            r"\bgeorgia\b", r"\bga\b",
            r"\bkentucky\b", r"\bky\b",
            r"\bnebraska\b", r"\bne\b",
            r"\bpennsylvania\b", r"\bpa\b",
            r"\bsimpsons?\b",
        ],
    },
    # ── Portland: Oregon (PDX) vs Maine vs others.
    "portland": {
        "label": "Portland (US)",
        "patterns": [
            r"\boregon\b", r"\bor\b", r"\bpdx\b",
            r"\bmaine\b", r"\bme\b",
            r"\bconnecticut\b", r"\bct\b",
            r"\bindiana\b", r"\bin\b",
            r"\bnew\s+york\b", r"\bny\b",
        ],
    },
    # ── Memphis: TN (Graceland, NBA) vs Memphis, Egypt (Cairo suburb)
    "memphis": {
        "label": "Memphis (TN or EG)",
        "patterns": [
            r"\btennessee\b", r"\btn\b",
            r"\belvis\b", r"\bgraceland\b",
            r"\bnba\b", r"\bgrizzlies\b",
            r"\bmississippi\b", r"\bms\b",
            r"\barkansas\b", r"\bar\b",
            r"\begypt\b", r"\bcairo\b",
            r"\bnile\b", r"\bpharaoh\b",
            r"\bptolemaic\b",
        ],
    },
    # ── Virginia: VA (USA) vs Virginia, ZA (South Africa, Free State)
    # Virginia, ZA is a small mining town (pop ~122k). Virginia, USA is a major state.
    # Articles about Virginia without explicit ZA context are almost always about US Virginia.
    # We REJECT Virginia, ZA placement unless there's clear South African context.
    "virginia": {
        "label": "Virginia (ZA needs context)",
        "reject_patterns": [
            # If context mentions US states/cities without SA context, reject
            r"\bnorthern\s+virginia\b",
            r"\bvirginia\s+beach\b",
            r"\bvirginia\s+tech\b",
            r"\bvirginia\s+commonwealth\b",
            r"\bwest\s+virginia\b",
            r"\brichmond\s+virginia\b",
            r"\barlington\s+virginia\b",
            r"\balexandria\s+virginia\b",
            r"\bmanassas\b",
            r"\btysons\b",
            r"\bmclean\b",
            r"\bpotomac\b",
            r"\bdc\b", r"\bd\.c\.\b",
            r"\bwashington\s+d\.c\.\b",
            r"\bhampton\s+virginia\b",
            r"\bchesapeake\s+virginia\b",
            r"\bnewport\s+news\b",
            r"\bportsmouth\s+virginia\b",
            r"\bfredericksburg\b",
        ],
        "patterns": [
            # Only keep if there's clear SA context
            r"\bvirginia,\s*za\b",
            r"\bvirginia,\s*free\s+state\b",
            r"\bfree\s+state\b",  # SA province
            r"\bsouth\s+africa\b", r"\bsouth\s+african\b",
            r"\bza\b", r"\bsa\b",
        ],
    },
    # ── Córdoba: Argentina vs Spain (Andalucía)
    "cordoba": {
        "label": "Córdoba (AR or ES)",
        "patterns": [
            r"\bargentina\b", r"\bargentine\b",
            r"\bargentin[oa]\b",
            r"\bbuenos\s+aires\b",
            r"\bspain\b", r"\bspanish\b",
            r"\bandaluc[íi]a\b",
            r"\bmadrid\b",
            r"\bmezquita\b",
        ],
    },
    # ── Santiago: Chile vs Dominican Republic vs Spain (Galicia)
    "santiago": {
        "label": "Santiago (CL/DO/ES)",
        "patterns": [
            r"\bchile\b", r"\bchilean\b",
            r"\bdominican\b",
            r"\bspain\b", r"\bgalicia\b",
        ],
    },
    # ── San Bruno: San Bruno, California (pop ~43k) vs bare YouTube/video references
    "san bruno": {
        "label": "San Bruno (California, US)",
        "reject_patterns": [
            r"\b(?:watch|see|view|stream|listen|subscribe|follow)\s+(?:on|via|at)\s+youtube\b",
            r"\byoutube\s+(?:video|channel|clip|stream|series|views|subscribers|shorts|link|creator|content|algorithm|embed)\b",
            r"\bon\s+youtube\b",
        ],
        "patterns": [
            r"\bcalifornia\b", r"\bcalif\b", r"\bca\b",
            r"\bsan\s+mateo\b", r"\bsan\s+mateo\s+county\b",
            r"\bbay\s+area\b", r"\bsan\s+francisco\b", r"\bpeninsula\b",
            r"\bsan\s+bruno,\s*(?:ca|california)\b",
            r"\bcity\s+of\s+san\s+bruno\b",
        ],
    },
    # ── San Mateo: San Mateo, California vs bare PlayStation mentions / Latin America
    "san mateo": {
        "label": "San Mateo (California, US)",
        "reject_patterns": [
            r"\bplaystation\s+(?:5|4|pro|vr|portal|plus|network|store|games?|controller|dualsense|state\s+of\s+play)\b",
            r"\bps5\b", r"\bps4\b", r"\bsony\s+interactive\b",
        ],
        "patterns": [
            r"\bcalifornia\b", r"\bcalif\b", r"\bca\b",
            r"\bsan\s+mateo\s+county\b", r"\bbay\s+area\b", r"\bpeninsula\b",
            r"\bsan\s+francisco\b", r"\bsilicon\s+valley\b",
            r"\bsan\s+mateo,\s*(?:ca|california)\b",
            r"\bcity\s+of\s+san\s+mateo\b",
            r"\bphilippines\b", r"\brizal\b",
        ],
    },
    # ── Pueblo: Pueblo, Colorado vs Spanish common noun "pueblo" (village/people/town)
    "pueblo": {
        "label": "Pueblo (Colorado, US)",
        "reject_patterns": [
            r"\b(?:el|del|al|un|este|nuestro|mi|su|cada|todo)\s+pueblos?\b",
            r"\bdefensor(?:[íi]a)?\s+del\s+pueblo\b",
            r"\bpueblo\s+(?:ind[íi]gena|originario|gallego|m[áa]gico|unido|espa[ñn]ol|mexicano|argentino|colombiano|peruano)\b",
            r"\bpueblos?\s+(?:rurales?|vecinos?|cercanos?|de)\b",
        ],
        "patterns": [
            r"\bcolorado\b", r"\bco\b", r"\bpueblo\s+county\b",
            r"\bpueblo,\s*(?:co|colorado)\b", r"\bcity\s+of\s+pueblo\b",
            r"\bpikes\s+peak\b", r"\bfront\s+range\b", r"\barkansas\s+river\b",
        ],
    },
    # ── Mesa: Mesa, Arizona vs Spanish "mesa" (table/board) & Serbian "mesa" (meat)
    "mesa": {
        "label": "Mesa (Arizona, US)",
        "reject_patterns": [
            r"\b(?:la|una|esta|esa|en\s+la|sobre\s+la)\s+mesas?\b",
            r"\bmesa\s+(?:de\s+(?:di[áa]logo|trabajo|negociaci[óo]n|votaci[óo]n|sufragio|electoral|redonda|partes|entrada|dinero|conducci[óo]n)|directiva|sectorial)\b",
            r"\bmesa\s+(?:de\s+(?:negocia[çc][ãa]o|di[áa]logo|trabalho)|diretora)\b",
            r"\b(?:uvoz|izvoz|proizvodnja|prodaja|cena|cijena|kila|tona|vrste|prerada)\s+mesa\b",
            r"\b(?:pile[ćc]eg|gove[đd]eg|svinjskog|june[ćc]eg|crvenog|sve[žz]eg)\s+mesa\b",
        ],
        "patterns": [
            r"\barizona\b", r"\baz\b", r"\bmaricopa\s+county\b",
            r"\bphoenix\b", r"\bmesa,\s*(?:az|arizona)\b",
            r"\bcity\s+of\s+mesa\b", r"\beast\s+valley\b",
        ],
    },
    # ── Fez: Fez, Morocco vs Portuguese verb "fez" (past of fazer) / Turkish hat
    "fez": {
        "label": "Fez (Morocco)",
        "reject_patterns": [
            r"\b(?:ele|ela|voc[êe]|governo|quem|que|n[ãa]o|j[áa]|tamb[ée]m|sempre|nunca|isso|tudo|se)\s+fez\b",
            r"\bfez\s+(?:com\s+que|uma?|o|a|os|as|parte|sucesso|hist[óo]ria|quest[ãa]o|falta|sentido|declara[çc][õo]es|an[úu]ncio|coment[áa]rio)\b",
            r"\bnada\s+fez\b",
            r"\bfez\s+hat\b", r"\bwear(?:ing)?\s+a\s+fez\b",
        ],
        "patterns": [
            r"\bmorocco\b", r"\bmoroccan\b", r"\bmaroc\b", r"\bmarruecos\b",
            r"\bf[eèé]s\b", r"\bf[eèé]s-mekn[èé]s\b", r"\bmedina\s+of\s+fez\b",
            r"\bfez,\s*(?:ma|morocco)\b",
        ],
    },
    # ── Libertad: Libertad, Philippines / Americas vs Spanish noun "libertad" (freedom)
    "libertad": {
        "label": "Libertad (Philippines / Americas)",
        "reject_patterns": [
            r"\b(?:qued[óo]|puest[oa]|dejad[oa]|est[áa]|dejaron|pusieron|seguir[áa]|segu[íi]an)\s+en\s+libertad\b",
            r"\blibertad\s+(?:condicional|de\s+(?:expresi[óo]n|prensa|culto|opini[óo]n|comercio|c[áa]tedra|tr[áa]nsito|elecci[óo]n)|financiera|sindical|provisional|bajo\s+fianza)\b",
            r"\b(?:restringir|privad[oa]s?\s+de|privaci[óo]n\s+de)\s+(?:la\s+)?libertad\b",
            r"\bpuesta\s+en\s+libertad\b",
            r"\brecuper[óo]\s+la\s+libertad\b",
        ],
        "patterns": [
            r"\bphilippines\b", r"\bantique\b", r"\bmisamis\s+oriental\b",
            r"\blibertad,\s*(?:ph|antique)\b",
            r"\bmerlo\b", r"\bbuenos\s+aires\b", r"\blibertad,\s*ar\b",
            r"\bla\s+libertad\b", r"\bsanta\s+elena\b", r"\becuador\b",
        ],
    },
    # ── Poblacion: Poblacion, Philippines vs Spanish noun "población" (population)
    "poblacion": {
        "label": "Poblacion (Philippines)",
        "reject_patterns": [
            r"\b(?:la|una|de\s+la|en\s+la|toda\s+la|gran\s+parte\s+de\s+la)\s+poblaci[óo]n\b",
            r"\bpoblaci[óo]n\s+(?:mundial|total|local|rural|urbana|vulnerable|civil|carcelaria|penitenciaria|activa|infantil|juvenil|adulta|mayor|ind[íi]gena|flotante|ocupada)\b",
            r"\bcenso\s+de\s+poblaci[óo]n\b",
            r"\bcrecimiento\s+de\s+(?:la\s+)?poblaci[óo]n\b",
        ],
        "patterns": [
            r"\bphilippines\b", r"\bphilippine\b", r"\bbarangay\b",
            r"\bmunicipality\b", r"\bmakati\b", r"\bpoblacion,\s*(?:ph|makati)\b",
        ],
    },
    # ── Hub: Hub, Balochistan, Pakistan vs English common noun "hub" (transport/tech/etc.)
    "hub": {
        "label": "Hub (Pakistan)",
        "reject_patterns": [
            r"\b(?:transport|aviation|transit|rail|cargo|freight|shipping|logistics|industrial|economic|commercial|financial|business|tech|technology|innovation|startup|digital|energy|green\s+energy|hydrogen|solar|coal|oil|gas|manufacturing|student|media|cultural|travel|airline|global|regional|major)\s+hubs?\b",
            r"\bhubs?\s+(?:and\s+spokes?|for|of)\b",
            r"\ba\s+(?:major\s+)?hub\b", r"\bas\s+a\s+hub\b",
        ],
        "patterns": [
            r"\bpakistan\b", r"\bpakistani\b", r"\bbalochistan\b",
            r"\blasbela\b", r"\bhub\s+dam\b", r"\bhub\s+river\b",
            r"\bhub\s+tehsil\b", r"\bhub,\s*(?:pk|balochistan)\b",
        ],
    },
    # ── Rosetta: Rosetta/Rashid, Egypt vs Apple Rosetta (translation layer), Rosetta Stone, Rosetta spacecraft
    "rosetta": {
        "label": "Rosetta (Egypt)",
        "reject_patterns": [
            r"\bapple\b", r"\bmacos?\b", r"\bmac\s+os\b", r"\bios\b",
            r"\btranslation\s+layer\b", r"\btranslato(?:r|ion)\b",
            r"\bapp\s+store\b", r"\bsubmission\b", r"\bxcode\b",
            r"\bintel\b", r"\barm\b", r"\bcpu\b", r"\bprocessor\b",
            r"\bstone\b", r"\blanguage\s+learning\b", r"\bapp\b",
            r"\bspacecraft\b", r"\bcomet\b", r"\b67p\b", r"\becospace\b",
            r"\bmission\b", r"\blaunched\b",
        ],
        "patterns": [
            r"\begypt\b", r"\bcairo\b", r"\bnile\b",
            r"\bnile\s+delta\b", r"\bmediterranean\b",
            r"\brashid\b", r"\baboukir\b", r"\bcharleston\b",
            r"\brosetta,\s*(?:eg|egypt)\b",
        ],
    },
    # ── Java: Indonesia island vs Java programming language
    "java": {
        "label": "Java (Indonesia)",
        "reject_patterns": [
            r"\bprogramming\b", r"\bcode\b", r"\bcoding\b", r"\bdeveloper\b",
            r"\blanguage\b", r"\bvirtual\s+machine\b", r"\bjvm\b",
            r"\bscript\b", r"\bframework\b", r"\blib(?:rary|raries)\b",
            r"\bapi\b", r"\bsoftware\b", r"\bapp(?:lication)?\b",
            r"\bcoffee\b", r"\bcoffee\s+script\b",
        ],
        "patterns": [
            r"\bindonesia\b", r"\bindonesian\b", r"\bjakarta\b",
            r"\bbali\b", r"\bsurabaya\b", r"\bjava\s+sea\b",
            r"\bjawa\b", r"\bsunda\b", r"\bmedan\b",
        ],
    },
    # ── Python: Montana vs Python programming language
    "python": {
        "label": "Python (Montana, US)",
        "reject_patterns": [
            r"\bprogramming\b", r"\bcode\b", r"\bcoding\b", r"\bdeveloper\b",
            r"\blanguage\b", r"\bscript\b", r"\bframework\b",
            r"\bimport\b", r"\bdef\s+\w+\b", r"\bclass\s+\w+\b",
            r"\bconda\b", r"\bpip\b", r"\bflask\b", r"\bdjango\b",
            r"\bnumpy\b", r"\bpandas\b", r"\bmachine\s+learning\b",
        ],
        "patterns": [
            r"\bmontana\b", r"\bflathead\b", r"\bglacier\b",
            r"\bwhitefish\b", r"\bcolumbia\s+falls\b",
        ],
    },
    # ── Lima: Peru vs Lima, Ohio
    "lima": {
        "label": "Lima (PE or OH)",
        "patterns": [
            r"\bperu\b", r"\bperuvian\b",
            r"\bohio\b", r"\boh\b",
            r"\bputnam\s+county\b",
        ],
    },
    # ── Quito vs Quito, others
    "quito": {
        "label": "Quito (EC)",
        "patterns": [
            r"\becuador\b", r"\becuadorian\b",
            r"\bandean\b", r"\bgalapagos\b",
        ],
    },
    # ── Hamburg: Germany vs US towns
    "hamburg": {
        "label": "Hamburg",
        "patterns": [
            r"\bgermany\b", r"\bgerman\b",
            r"\belbe\b", r"\breeperbahn\b",
            r"\bnew\s+york\b", r"\bny\b",
            r"\bpennsylvania\b", r"\bpa\b",
            r"\bnew\s+jersey\b", r"\bnj\b",
            r"\biowa\b", r"\bia\b",
            r"\barkansas\b", r"\bar\b",
        ],
    },
    # ── Florence: Italy vs US states
    "florence": {
        "label": "Florence (IT/US)",
        "patterns": [
            r"\bitaly\b", r"\bitalian\b",
            r"\btuscany\b", r"\btoscana\b",
            r"\bfirenze\b", r"\barno\b",
            r"\balabama\b", r"\bal\b",
            r"\bsouth\s+carolina\b", r"\bsc\b",
            r"\boregon\b", r"\bor\b",
            r"\bkentucky\b", r"\bky\b",
        ],
    },
    # ── Kingston: Jamaica vs NY/ON
    "kingston": {
        "label": "Kingston (JM/US/CA)",
        "patterns": [
            r"\bjamaica\b", r"\bjamaican\b",
            r"\bnew\s+york\b", r"\bny\b",
            r"\bhudson\s+valley\b",
            r"\bontario\b", r"\bcanada\b",
            r"\bpa\b", r"\bpennsylvania\b",
            r"\bnorfolk\s+island\b",
        ],
    },
    # ── Adelaide: Australia
    "adelaide": {
        "label": "Adelaide (AU)",
        "patterns": [
            r"\baustralia\b", r"\baustralian\b",
            r"\bsouth\s+australia\b",
        ],
    },
    # ── Canton: China vs US
    "canton": {
        "label": "Canton",
        "patterns": [
            r"\bchina\b", r"\bchinese\b",
            r"\bguangzhou\b", r"\bguangdong\b",
            r"\bohio\b", r"\boh\b",
            r"\bgeorgia\b", r"\bga\b",
            r"\bmichigan\b", r"\bmississippi\b",
        ],
    },
    # ── Newcastle: UK vs AU vs US
    "newcastle": {
        "label": "Newcastle",
        "patterns": [
            r"\bengland\b", r"\bbritain\b",
            r"\buk\b", r"\bbritish\b",
            r"\baustralia\b", r"\baustralian\b",
            r"\bnew\s+south\s+wales\b", r"\bnsw\b",
            r"\bindiana\b", r"\bin\b",
            r"\bpennsylvania\b", r"\bpa\b",
            r"\bdelaware\b", r"\bde\b",
            r"\bwyoming\b", r"\bwy\b",
        ],
    },
    # ── Plymouth: UK vs US
    "plymouth": {
        "label": "Plymouth",
        "patterns": [
            r"\bengland\b", r"\bbritain\b",
            r"\buk\b", r"\bbritish\b",
            r"\bmassachusetts\b", r"\bma\b",
            r"\bmayflower\b", r"\bplymouth\s+rock\b",
            r"\bminnesota\b", r"\bmn\b",
            r"\bindiana\b", r"\bin\b",
            r"\biowa\b", r"\bia\b",
        ],
    },
    # ── Birmingham: UK vs AL
    "birmingham": {
        "label": "Birmingham",
        "patterns": [
            r"\bengland\b", r"\bbritain\b",
            r"\buk\b", r"\bbritish\b",
            r"\balabama\b", r"\bal\b",
        ],
    },
    # ── Cambridge: UK vs MA
    "cambridge": {
        "label": "Cambridge",
        "patterns": [
            r"\bengland\b", r"\bbritain\b",
            r"\buk\b", r"\bbritish\b",
            r"\bmassachusetts\b", r"\bma\b",
            r"\bharvard\b", r"\bmit\b",
            r"\bontario\b", r"\bcanada\b",
            r"\bohio\b", r"\bindiana\b", r"\bminnesota\b",
        ],
    },
    # ── Richmond: VA vs London vs AU
    "richmond": {
        "label": "Richmond",
        "patterns": [
            r"\bvirginia\b", r"\bva\b",
            r"\blondon\b", r"\bengland\b",
            r"\baustralia\b", r"\bnew\s+south\s+wales\b",
            r"\bindiana\b", r"\bin\b",
            r"\bkentucky\b", r"\bky\b",
            r"\bcalifornia\b", r"\bca\b",
        ],
    },
    # ── Valencia: Spain (La Liga, floods) vs Venezuela (Carabobo) vs California
    # Valencia CF, La Liga, Mestalla → Spain. "Wells Fargo" articles → NOT Valencia VE.
    # Pop: VE 1.6M > ES 824K, so cities_text picks VE by default — WRONG for football articles.
    "valencia": {
        "label": "Valencia (ES/VE)",
        "reject_patterns": [
            # Football / soccer context → Spain
            r"\bvalencia\s+cf\b", r"\bmestalla\b", r"\bla\s+liga\b",
            r"\blaliga\b", r"\bvalencia\s+cf\b",
            r"\bvalencia\s+(?:vs?|defeats?|beats?|wins?|losses?|draws?|draw|clash|match|game|tie|fixture)\b",
            r"\b(?:real\s+)?(?:madrid|barcelona|bar[çc]a|atletico|sevilla|sociedad)\b.*\bvalencia\b",
            r"\bvalencia\b.*\b(?:real\s+)?(?:madrid|barcelona|bar[çc]a|atletico|sevilla|sociedad)\b",
            # SailGP / racing / sporting events in Valencia Spain
            r"\bsailgp\b", r"\b america'?s?\s+cup\b",
            r"\bvalencia\s+(?:sail|race|grand\s+prix|circuit)\b",
            # Spanish-language flood / DANA context → Spain
            r"\bdana\b", r"\bvalencia\s+flood\b",
            r"\bvalencia\s+(?:airport|metro|metro\s+shut)\b",
            # "Valencia's Honorary Citizens" → Spain
            r"\bhonorary\s+citizen\b",
            # "Wells Fargo" → bank, NOT the city
            r"\bwells\s+fargo\b",
            r"\bwells\s+fargo\s+(?:healthcare|conference|securities?|capital|advisors?)\b",
            # California context
            r"\bvalencia\s+(?:ca|california|town\s+center|santa\s+clarita)\b",
            r"\bsanta\s+clarita\b",
        ],
        "patterns": [
            r"\bspain\b", r"\bspanish\b", r"\bmadrid\b",
            r"\bandaluc[íi]a\b", r"\bgalicia\b", r"\bcatalon[íi]a\b",
            r"\bvalencia\s+(?:community|comunidad|region|province|provincia)\b",
            r"\bvalencia,\s*es\b",
            r"\bvenezuela\b", r"\bvenezuelan\b", r"\bcaracas\b",
            r"\bcarabobo\b", r"\bvalencia,\s*ve\b",
            r"\bcalifornia\b", r"\bca\b", r"\bsanta\s+clarita\b",
        ],
    },
    # ── Fargo: Fargo, ND vs "Wells Fargo" (bank)
    # "Wells Fargo Healthcare Conference" generates thousands of false matches.
    "fargo": {
        "label": "Fargo (North Dakota, US)",
        "reject_patterns": [
            r"\bwells\s+fargo\b",
            r"\bwells\s+fargo\s+(?:healthcare|conference|securities?|capital|advisors?|analyst|hosted|annual|presentation|investor|stock|price|target|maintained|raised|lowered|initiated|downgraded|upgraded)\b",
            r"\bfargo\s+(?:conference|healthcare|securities?|capital)\b",
            # Generic financial news mentioning Wells Fargo
            r"\bnys[ea]\:?\s*wfc\b",
            r"\bticker:?\s*wfc\b",
        ],
        "patterns": [
            r"\bnorth\s+dakota\b", r"\bnd\b", r"\bcalumet\b",
            r"\bcass\s+county\b", r"\bfargo,\s*(?:nd|north\s+dakota)\b",
            r"\bmoorhead\b",
        ],
    },
    # ── Negara: small city in Bali (pop ~40k) vs Indonesian word for "country/state"
    # Nearly ALL matches are the Indonesian common noun, NOT the city.
    "negara": {
        "label": "Negara (Bali, Indonesia)",
        "reject_patterns": [
            # "Negara" = "country/state" in Indonesian — reject nearly all uses
            r"\bnegara\s+(?:ini|tersebut|itu|bersangkutan|yang|adalah|memiliki|menjadi|akan|telah|dapat)\b",
            r"\b(?:di|ke|dari|untuk|dengan|pada|dalam|antara|antara|seluruh|sejumlah|beberapa|negara-negara)\s+negara\b",
            r"\bnegara\s+(?:berkembang|maj|tujuan|asal|tuj|target|mitra|anggota|partner)\b",
            r"\b(?:seluruh|sejumlah|beberapa|negara-negara|berbagai|masih|antara|majoriti|sebagian besar)\s+negara\b",
            r"\bnegara\s+berkembang\b", r"\bnegara\s+mayoritas\b",
            r"\bislam\b", r"\bprotein\b",  # Common substring in Indonesian text
        ],
        "patterns": [
            r"\bbali\b", r"\bjembrana\b", r"\bbuleleng\b",
            r"\bnegara,\s*id\b", r"\bnegara\s+district\b",
        ],
    },
    # ── Victoria: extremely common place name (HK, BC, Australia, BC, etc.)
    # "Victoria" appears in countless article contexts (person names, "victoria's secret", etc.)
    "victoria": {
        "label": "Victoria (Multiple)",
        "reject_patterns": [
            r"\bvictoria'?s?\s+secret\b",
            r"\bvictoria\s+beckham\b", r"\bvictoria\s+principals?\b",
            r"\bvictoria\s+justice\b",  # actress
            r"\bvictoria\s+day\b", r"\bvictoria\s+day\b",
            r"\bvictoria\s+cross\b",
            r"\bvictoria\s+falls?\b",  # Zimbabwe/Zambia
            r"\bvictoria\s+lake\b", r"\blake\s+victoria\b",
            r"\bvictoria\s+harbour\b", r"\bvictoria\s+peak\b",
            r"\bvictoria\s+park\b", r"\bvictoria\s+station\b",
            r"\bvictoria\s+line\b", r"\bvictoria\s+embankment\b",
            r"\bvictoria\s+boulevard\b", r"\bvictoria\s+street\b",
            r"\bvictoria\s+square\b", r"\bvictoria\s+road\b",
            # FIX (2026-09-26, golden-set): the "victoria, bc/au/hk" rejects
            # contradicted the accept patterns below (british columbia /
            # australia / hong kong) and, since reject runs FIRST on context
            # that always contains the city name, NO story could ever place
            # in the legit Victorias. Landmark rejects above are kept.
        ],
        "patterns": [
            r"\bhong\s+kong\b", r"\bhk\b",
            r"\bbritish\s+columbia\b", r"\bbc\b", r"\bcanada\b",
            r"\baustralia\b", r"\bmelbourne\b",
            r"\bseychelles\b", r"\bsa\b",
        ],
    },
    # ── El Paso: city in Texas vs Spanish "el paso" (the step/pass/stride)
    "el paso": {
        "label": "El Paso (Texas, US)",
        "reject_patterns": [
            r"\bel\s+paso\s+(?:del|de\s+la|del\s+rey|de\s+los)\b",
            r"\bdar\s+(?:un|el)\s+paso\b",
            r"\bel\s+paso\s+(?:a|ante|hacia|por)\b",
        ],
        "patterns": [
            r"\btexas\b", r"\btx\b", r"\budacity\b", r"\bcabrillo\b",
            r"\bel\s+paso,\s*(?:tx|texas)\b",
        ],
    },
    # ── Jos: Nigeria (capital of Plateau State) vs substring in many languages
    # "Jos" appears in Croatian "koga", "Projekt", etc. as a substring.
    "jos": {
        "label": "Jos (Nigeria)",
        "reject_patterns": [
            # Croatian/Serbian substrings
            r"\bproje(?:kt|kata|kte|ktom|ktu|kta)\b",
            r"\bod\s+koga\b", r"\bza\s+koga\b", r"\bdo\s+koga\b",
            r"\bniko\s+koga\b",
            # English PERSON names only — bare "jos" must NOT be here:
            # reject patterns run first on a context that nearly always
            # contains the city name itself, so rejecting "Jos" made every
            # genuine Jos (Nigeria) story unrejectable-proof (FIX_NOTES 1.4 class).
            r"\bjo(?:seph|sh|shua)\b",
        ],
        "patterns": [
            r"\bnigeria\b", r"\bplateau\s+state\b", r"\baba\s+plateau\b",
            r"\bjos,\s*ng\b", r"\b jos\s+metropolitan\b",
        ],
    },
    # ── Wollongong: legitimate Australian city BUT duplicate location IDs
    # (370, 379, 6250, 6253, 6254) cause inflated counts. Not a code fix —
    # just noting for DB cleanup.
    # (No disambiguation needed — Wollongong is unambiguous)
}

# Compile once at module load.
def _compile() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for key, spec in _RAW_ENTRIES.items():
        out[key] = {
            "label": spec["label"],
            "patterns": [re.compile(p, re.I) for p in spec.get("patterns", [])],
            "reject_patterns": [re.compile(p, re.I) for p in spec.get("reject_patterns", [])],
        }
    return out


ENTRIES: dict[str, dict] = _compile()

_QUALIFIED_KEYS: set[str] = {
    k for k in _RAW_ENTRIES.keys() if "," in k
}


def is_qualified(location_text: str) -> bool:
    """Check if a location string has a qualifying context.

    A location is "qualified" if it includes a comma (e.g., "City, ST")
    or if it has a recognized qualifier pattern like "City of X" or "X city".

    Qualified locations bypass the watchlist disambiguation because
    the qualifier provides clear disambiguation context.
    """
    if not location_text:
        return False
    if "," in location_text:
        return True
    # Check for comma-less qualifier patterns like "City of X", "X city", etc.
    # These provide enough context to identify the location even without a comma.
    lower = location_text.lower()
    # "City of X" pattern
    if lower.startswith("city of "):
        return True
    # "X city" pattern (for US state context like "Springfield city")
    # But be careful not to match things like "New York city" which is redundant
    if lower.endswith(" city"):
        # Allow "X city" where X is not already a multi-word city
        # e.g., "Springfield city" (IL) is qualified, but "New York city" is not
        stripped = lower[:-5].strip()  # Remove " city"
        if stripped and " " not in stripped:  # Single word before "city"
            return True
    # "Town of X" pattern
    if lower.startswith("town of "):
        return True
    # "District of X" pattern
    if lower.startswith("district of "):
        return True
    # "County of X" pattern
    if lower.startswith("county of "):
        return True
    # "State of X" pattern
    if lower.startswith("state of "):
        return True
    # "Province of X" pattern
    if lower.startswith("province of "):
        return True
    # "Region of X" pattern
    if lower.startswith("region of "):
        return True
    # US state abbreviations that commonly appear after a city name without comma
    # e.g., "Springfield IL", "Memphis TN"
    # FIX (2026-09-26, FIX_NOTES 1.7): this previously matched the abbrev
    # ANYWHERE in the string — two-letter tokens like "in", "de", "la", "id",
    # "hi", "me", "ma" are common English/Spanish words, so "Alexandria in
    # Egypt", "Ciudad de Mexico", "Sur in Oman" all falsely qualified and
    # bypassed the watchlist. A trailing-abbrev ("City ST") only counts at
    # the END of the string, separated by whitespace.
    import re
    state_abbrevs = r"\b(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b"
    if re.search(r"\w{3,}\s+" + state_abbrevs + r"$", lower):
        return True
    # Also check for full US state names after a city name (e.g., "Moscow Idaho")
    # This handles the common pattern of "City StateName" without comma.
    # Same end-anchoring fix as above.
    us_state_names = r"\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming)$"
    if re.search(r"\w{3,}\s+" + us_state_names, lower):
        return True
    return False


def disambiguate(location_text: str, context: str, source_country: str | None = None) -> tuple[bool, str]:
    """Disambiguate a location string.

    Args:
        location_text: The raw location string (e.g., "Virginia" or "Virginia, ZA")
        context: The surrounding text (title + body excerpt) for context matching
        source_country: ISO country code of the news source (e.g., "US", "GB")

    Returns:
        (keep: bool, reason: str)
    """
    if not location_text:
        return True, "empty"

    norm = re.sub(r"\s+", " ", location_text.strip().lower())
    if not norm:
        return True, "empty"

    bare_name = norm.split(",")[0].strip()
    entry = ENTRIES.get(norm) or ENTRIES.get(bare_name)

    ctx = context or ""

    # Check reject patterns FIRST - these override everything
    # Even qualified locations can be rejected if context matches a reject pattern
    if entry:
        label: str = entry["label"]
        rejects: list[re.Pattern] = entry.get("reject_patterns", [])
        for rpat in rejects:
            if rpat.search(ctx):
                return False, f"rejected_by_pattern:{label}"

    # If location is qualified (has comma or recognized qualifier pattern),
    # accept it - the qualifier provides clear disambiguation
    # HOWEVER, for multi-country ambiguous cities (in AMBIGUOUS_CITY_COUNTRIES),
    # we still need to check source_country prior because the qualifier
    # might be wrong (e.g., "Cali, CO" where CO is Colombia but source is US)
    if is_qualified(location_text):
        # Check if this bare_name is in our multi-country map
        if bare_name in AMBIGUOUS_CITY_COUNTRIES or bare_name.strip() in AMBIGUOUS_CITY_COUNTRIES:
            # Still apply source_country prior check for ambiguous cities
            if source_country:
                keep, reason = _try_source_country_prior(bare_name, source_country, ctx, None)
                if keep:
                    return keep, reason
        return True, "qualified"

    if entry:
        label: str = entry["label"]
        # Check for context match
        patterns: list[re.Pattern] = entry["patterns"]
        for pat in patterns:
            if pat.search(ctx):
                return True, f"context_matched:{label}"

        # Not qualified and no context match - check source_country prior
        # For multi-country ambiguous places, source country provides a strong prior
        if source_country:
            keep, reason = _try_source_country_prior(bare_name, source_country, ctx, entry)
            if keep:
                return keep, reason

        # Fall through to final rejection
        return False, f"no_context:{label}"

    if entry is None:
        # City not on watchlist - but still check if context provides strong
        # disambiguation signals that contradict the default (global famous) city
        if context:
            ctx_countries = detect_context_countries(ctx)
            ctx_states = detect_context_states(ctx)
            # If context has Idaho-specific signals, reject Russia placement
            # These patterns are unique to Idaho and indicate a misplacement
            idaho_signals = re.compile(
                r'\b(?:vandals|kibbie|moscowberfest|palouse|latah\s+county|'
                r'u\s*of\s*i\b|university\s+of\s+idaho|'
                r'moscow\s+idaho|pullman\s+wa|'
                r'idaho\s+vandals|idaho\s+fall|idaho\s+moscow)\b',
                re.I
            )
            if idaho_signals.search(ctx) and 'RU' not in ctx_countries:
                return False, "idaho_context_no_moscow_russia"
        return True, "not_on_watchlist"

    label = entry["label"]
    patterns = entry["patterns"]
    for pat in patterns:
        if pat.search(ctx):
            return True, f"context_matched:{label}"

    # Last chance: check source_country prior before final rejection
    if source_country:
        keep, reason = _try_source_country_prior(bare_name, source_country, ctx, entry)
        if keep:
            return keep, reason

    return False, f"no_context:{label}"


# Countries where news is predominantly in English - strong priors for ambiguous English place names
_ENGLISH_NEWS_COUNTRIES: frozenset[str] = frozenset(["US", "GB", "CA", "AU", "NZ", "IE", "ZA"])

# Multi-country ambiguous city names - cities that exist in multiple countries
# Map of bare_name -> {country_code: (lat, lng)}
# Used by _try_source_country_prior to default to source country when no context matches
AMBIGUOUS_CITY_COUNTRIES: dict[str, dict[str, tuple[float, float]]] = {
    "virginia": {"US": (37.4316, -78.6569)},  # Richmond, VA
    "alexandria": {"EG": (31.2001, 29.9187), "US": (38.8048, -77.0469)},  # Alexandria, EG vs Alexandria, VA
    "cordoba": {"AR": (-31.4201, -64.1888), "ES": (37.8882, -4.7794)},  # Cordoba, AR vs Cordoba, ES
    "santiago": {"CL": (-33.4489, -70.6693), "DO": (18.4862, -69.9312), "ES": (42.8782, -8.5448)},  # CL, DO, ES (Galicia)
    "granada": {"ES": (37.1773, -3.5986), "NI": (11.9279, -85.1670)},  # Spain vs Nicaragua
    "manaus": {"BR": (-3.1190, -60.0217)},  # Brazil (not to be confused with "Man" city)
    "trinidad": {"TT": (10.6918, -61.2225)},  # Trinidad and Tobago
    "merida": {"MX": (20.9674, -89.5926), "ES": (38.9146, -6.3427)},  # Mexico vs Spain
    "lima": {"PE": (-12.0464, -77.0428)},  # Peru (exact-key dict — no substring risk)
    "sucre": {"BO": (-19.0196, -65.2619), "VE": (8.6409, -70.0629)},  # Bolivia vs Venezuela
    "potosi": {"BO": (-19.5716, -65.7559), "US": (37.9519, -90.4712)},  # Bolivia vs Missouri, US
    "tucuman": {"AR": (-26.8241, -65.2226)},  # Argentina
    "copiapo": {"CL": (-27.3665, -70.3324)},  # Chile
    "iquique": {"CL": (-20.2133, -70.1526)},  # Chile
    "antofagasta": {"CL": (-23.6509, -70.3975)},  # Chile
    "valparaiso": {"CL": (-33.0458, -71.6199)},  # Chile
    "concepcion": {"CL": (-36.8201, -73.0444), "US": (36.9741, -122.0308)},  # Chile vs California, US
    "santa cruz": {"BO": (-17.8146, -63.1561), "US": (36.9741, -122.0308)},  # Bolivia vs California, US
    "cochabamba": {"BO": (-17.3895, -66.1570)},  # Bolivia
    "cali": {"CO": (3.4516, -76.5319), "US": (36.7783, -119.4179)},  # Cali, CO vs California, US
    "santa fe": {"AR": (-31.6488, -60.7087), "US": (35.6870, -105.9378)},  # Santa Fe, AR vs Santa Fe, NM
    "fargo": {"US": (46.8772, -96.7898), "CA": (49.0, -97.0)},  # Fargo, ND vs Fargo, Canada (Manitoba)
    "victoria": {"CA": (48.4284, -123.3656), "AU": (-37.8136, 144.9631), "US": (28.8, -97.0)},  # Victoria, CA vs Melbourne AU vs Victoria, TX
    "el paso": {"US": (31.7619, -106.4850), "MX": (31.6904, -106.4243)},  # El Paso, TX vs Ciudad Juárez MX
    "phoenix": {"US": (33.4484, -112.0740)},  # AZ is a state, not a country (FIX_NOTES 1.4)
    "guatemala": {"GT": (14.5586, -90.7295), "US": (15.5, -90.3)},  # Guatemala City vs Guatemala country
    "jordan": {"JO": (31.9454, 35.9284), "US": (40.2, -74.0)},  # Jordan vs Jordan, US (NY area)
    "texas": {"US": (31.9686, -99.9018)},  # Texas, US
    "oklahoma": {"US": (35.0078, -97.0929)},  # Oklahoma, US
}


def _try_source_country_prior(bare_name: str, source_country: str, ctx: str, entry: dict | None) -> tuple[bool, str]:
    """Try to use source_country as a prior when no context matched.

    For ambiguous place names that exist in multiple countries, when an article
    from a source country mentions the bare place name with no clarifying context,
    we default to the source country's version if that country has the city.

    E.g., an article from a US source mentioning "Virginia" with no context
    should be interpreted as Virginia, USA (not Virginia, ZA).
    """
    if not source_country:
        return False, ""

    city_countries = AMBIGUOUS_CITY_COUNTRIES.get(bare_name) or AMBIGUOUS_CITY_COUNTRIES.get(bare_name.strip())
    if not city_countries:
        return False, ""

    # If source country matches one of the possible countries for this city
    if source_country in city_countries:
        # Check if context has keywords pointing to a DIFFERENT country
        # If so, don't override - let the foreign context win
        other_country_keywords = {
            "BR": [r"\bbrasil\b", r"\bbrazil\b", r"\bbrasilia\b", r"\brio\b", r"\bsão\s+paulo\b", r"\bbrazilian\b"],
            "AR": [r"\bargentina\b", r"\bbuenos\s+aires\b", r"\bargentinian\b", r"\bargentin[oa]\b"],
            "CL": [r"\bchile\b", r"\bsantiago\b", r"\bchileno\b", r"\bshile\b"],
            "EG": [r"\begypt\b", r"\bcairo\b", r"\begyptian\b"],
            "BO": [r"\bbolivia\b", r"\bbolivian\b", r"\bla\s+paz\b", r"\bsucre\b", r"\bpotosi\b"],
            "PE": [r"\bperu\b", r"\bperuvian\b", r"\blima\b", r"\blimeño\b"],
            "MX": [r"\bmexico\b", r"\bmexican\b", r"\bmexico\s+city\b"],
            "NI": [r"\bnicaragua\b", r"\bnicaraguan\b"],
            "DO": [r"\bdominican\b", r"\bsanto\s+domingo\b"],
            "TT": [r"\btrinidad\b", r"\btobago\b", r"\bcaribbean\b"],
            "VE": [r"\bvenezuela\b", r"\bvenezuelan\b", r"\bcaracas\b"],
            "ES": [r"\bspain\b", r"\bspanish\b", r"\bmadrid\b", r"\bandaluc[íi]a\b", r"\bgalicia\b"],
            "ZA": [r"\bsouth\s+africa\b", r"\bsouth\s+african\b", r"\bfree\s+state\b", r"\bpretoria\b", r"\bjohannesburg\b", r"\bcapetown\b", r"\bcape\s+town\b"],
            "US": [r"\bunited\s+states\b", r"\busa\b", r"\bamerican\b", r"\bwashington\b", r"\bnew\s+york\b", r"\bcalifornia\b", r"\btexas\b"],
            "GB": [r"\bunited\s+kingdom\b", r"\bbritain\b", r"\benglish\b", r"\blondon\b", r"\buk\b"],
        }

        # Check if context mentions any OTHER country that has this city
        other_countries = [c for c in city_countries.keys() if c != source_country]
        for other_country in other_countries:
            keywords = other_country_keywords.get(other_country, [])
            for kw in keywords:
                if re.search(kw, ctx, re.I):
                    # Context mentions a different country that has this city
                    # Don't override - foreign context should win
                    return False, ""

        # No competing foreign context found
        # Use source_country as the prior
        return True, f"source_country_defaulted:{source_country}"

    return False, ""


def watchlisted_names() -> list[str]:
    """Sorted list of bare names (no comma) — useful for diagnostics / debugging."""
    return sorted(k for k in _RAW_ENTRIES if "," not in k)


# ── Country/state context detection ───────────────────────────────────────────

# Patterns that identify country mentions in text
_COUNTRY_CONTEXT_PATTERNS: list[tuple[re.Pattern, str]] = [
    # English-speaking countries
    (re.compile(r'\b(?:united\s+states|usa|america\b|american\b|washington\s*d\.?c\.?|america\b)\b', re.I), 'US'),
    # Idaho-specific context (University of Idaho, Vandals, Palouse region)
    (re.compile(r'\b(?:idaho|idahoan|vandals|kibbie|moscowberfest|palouse|latah|pullman|UI\b|U\s*of\s*I\b|University\s+of\s+Idaho)\b', re.I), 'US'),
    (re.compile(r'\b(?:united\s+kingdom|britain|british\b|england\b|english\b|london\b)\b', re.I), 'GB'),
    (re.compile(r'\b(?:canada\b|canadian\b|toronto\b|ottawa\b|vancouver\b)\b', re.I), 'CA'),
    (re.compile(r'\b(?:australia\b|australian\b|sydney\b|melbourne\b|canberra\b)\b', re.I), 'AU'),
    (re.compile(r'\b(?:new\s+zealand\b|kiwi\b|auckland\b|wellington\b)\b', re.I), 'NZ'),
    (re.compile(r'\b(?:ireland\b|irish\b|dublin\b)\b', re.I), 'IE'),
    (re.compile(r'\b(?:south\s+africa\b|south\s+african\b|johannesburg\b|cape\s+town\b|pretoria\b|durban\b)\b', re.I), 'ZA'),

    # European countries
    (re.compile(r'\b(?:germany|german|berlin|munich|hamburg|frankfurt|dortmund)\b', re.I), 'DE'),
    (re.compile(r'\b(?:france|french|paris|marseille|lyon|strasbourg)\b', re.I), 'FR'),
    (re.compile(r'\b(?:spain|spanish|madrid|barcelona|valencia|seville)\b', re.I), 'ES'),
    (re.compile(r'\b(?:italy|italian|rome|milan|naples|turin|florence)\b', re.I), 'IT'),
    (re.compile(r'\b(?:portugal|portuguese|lisbon|porto)\b', re.I), 'PT'),
    (re.compile(r'\b(?:netherlands|dutch|amsterdam|rotterdam|the\s+hague)\b', re.I), 'NL'),
    (re.compile(r'\b(?:belgium|belgian|bussels\b|antwerp)\b', re.I), 'BE'),
    (re.compile(r'\b(?:switzerland|swiss|zurich|geneva|bern)\b', re.I), 'CH'),
    (re.compile(r'\b(?:austria|austrian|vienna|innsbruck)\b', re.I), 'AT'),
    (re.compile(r'\b(?:poland|polish|warsaw|krakow)\b', re.I), 'PL'),
    (re.compile(r'\b(?:sweden|swedish|stockholm|gothenburg)\b', re.I), 'SE'),
    (re.compile(r'\b(?:norway|norwegian|oslo|bergen)\b', re.I), 'NO'),
    (re.compile(r'\b(?:denmark|danish|copenhagen)\b', re.I), 'DK'),
    (re.compile(r'\b(?:finland|finnish|helsinki|tampere)\b', re.I), 'FI'),
    (re.compile(r'\b(?:greece|greek|athens|thessaloniki)\b', re.I), 'GR'),
    (re.compile(r'\b(?:czech|czechia|prague|brno)\b', re.I), 'CZ'),
    (re.compile(r'\b(?:hungary|hungarian|budapest|debrecen)\b', re.I), 'HU'),
    (re.compile(r'\b(?:romania|romanian|bucharest|cluj)\b', re.I), 'RO'),
    (re.compile(r'\b(?:bulgaria|bulgarian|sofia|plovdiv)\b', re.I), 'BG'),
    (re.compile(r'\b(?:croatia|croatian|zagreb|split)\b', re.I), 'HR'),
    (re.compile(r'\b(?:serbia|serbian|belgrade|novi\s+sad)\b', re.I), 'RS'),
    (re.compile(r'\b(?:slovenia|slovenian|ljubljana|maribor)\b', re.I), 'SI'),
    (re.compile(r'\b(?:slovakia|slovak|bratislava|kosice)\b', re.I), 'SK'),

    # Asia
    (re.compile(r'\b(?:china|chinese|beijing|shanghai|guangzhou|shenzhen|hong\s+kong|tibet|xinjiang|taiwan)\b', re.I), 'CN'),
    (re.compile(r'\b(?:japan|japanese|tokyo|osaka|yokohama|nagoya|sapporo)\b', re.I), 'JP'),
    (re.compile(r'\b(?:korea|korean|seoul|busan|pyongyang)\b', re.I), 'KR'),
    (re.compile(r'\b(?:india|indian|delhi|mumbai|bangalore|chennai|kolkata|hyderabad)\b', re.I), 'IN'),
    (re.compile(r'\b(?:pakistan|pakistani|karachi|lahore|islamabad)\b', re.I), 'PK'),
    (re.compile(r'\b(?:indonesia|indonesian|jakarta|bali|surabaya)\b', re.I), 'ID'),
    (re.compile(r'\b(?:malaysia|malaysian|kuala\s+lumpur|penang)\b', re.I), 'MY'),
    (re.compile(r'\b(?:philippines|filipino|manila|cebu|davao)\b', re.I), 'PH'),
    (re.compile(r'\b(?:thailand|thai|bangkok|phuket)\b', re.I), 'TH'),
    (re.compile(r'\b(?:vietnam|vietnamese|hanoi|ho\s+chi\s+minh)\b', re.I), 'VN'),
    (re.compile(r'\b(?:singapore|singaporean)\b', re.I), 'SG'),
    (re.compile(r'\b(?:bangladesh|bangladeshi|dhaka|chittagong)\b', re.I), 'BD'),
    (re.compile(r'\b(?:sri\s+lanka|sri\s+lankan|colombo|kandy)\b', re.I), 'LK'),
    (re.compile(r'\b(?:nepal|nepalese|kathmandu|pokhara)\b', re.I), 'NP'),
    (re.compile(r'\b(?:myanmar|myanmarese|myanmarese|yangon|mandalay)\b', re.I), 'MM'),

    # Middle East
    (re.compile(r'\b(?:saudi\s+arabia|saudi|riyadh|jeddah|mecca|medina)\b', re.I), 'SA'),
    (re.compile(r'\b(?:uae|emirati|dubai|abu\s+dhabi|sharjah)\b', re.I), 'AE'),
    (re.compile(r'\b(?:qatar|qatari|doha)\b', re.I), 'QA'),
    (re.compile(r'\b(?:kuwait|kuwaiti|kuwait\s+city)\b', re.I), 'KW'),
    (re.compile(r'\b(?:israel|israeli|tel\s+aviv|jerusalem|haifa)\b', re.I), 'IL'),
    (re.compile(r'\b(?:turkey|turkish|istanbul|ankara|izmir)\b', re.I), 'TR'),
    (re.compile(r'\b(?:iran|iranian|tehran|mashhad)\b', re.I), 'IR'),
    (re.compile(r'\b(?:iraq|iraqi|baghdad|basra)\b', re.I), 'IQ'),
    (re.compile(r'\b(?:jordan|jordanian|amman)\b', re.I), 'JO'),
    (re.compile(r'\b(?:lebanon|lebanese|beirut)\b', re.I), 'LB'),

    # Africa
    (re.compile(r'\b(?:egypt|egyptian|cairo|alexandria)\b', re.I), 'EG'),
    (re.compile(r'\b(?:nigeria|nigerian|lagos|abuja|port\s+harcourt)\b', re.I), 'NG'),
    (re.compile(r'\b(?:kenya|kenyan|nairobi|mombasa)\b', re.I), 'KE'),
    (re.compile(r'\b(?:ethiopia|ethiopian|addis\s+ababa)\b', re.I), 'ET'),
    (re.compile(r'\b(?:ghana|ghanaian|accra|kumasi)\b', re.I), 'GH'),
    (re.compile(r'\b(?:tanzania|tanzanian|dar\s+es\s+salaam)\b', re.I), 'TZ'),
    (re.compile(r'\b(?:uganda|ugandan|kampala)\b', re.I), 'UG'),
    (re.compile(r'\b(?:morocco|moroccan|casablanca|rabat|marrakech)\b', re.I), 'MA'),
    (re.compile(r'\b(?:algeria|algerian|algiers|oran)\b', re.I), 'DZ'),
    (re.compile(r'\b(?:tunisia|tunisian|tunis|sfax)\b', re.I), 'TN'),
    (re.compile(r'\b(?:libya|libyan|tripoli|benghazi)\b', re.I), 'LY'),
    (re.compile(r'\b(?:cameroon|cameroonian|douala|yaoundé)\b', re.I), 'CM'),
    (re.compile(r"\b(?:ivory\s+coast|côte\s+d['\x27]ivoire|cote\s+d['\x27]ivoire|abidjan)\b", re.I), 'CI'),

    # Americas
    (re.compile(r'\b(?:mexico|mexican|mexico\s+city|cdmx|guadalajara|monterrey)\b', re.I), 'MX'),
    (re.compile(r'\b(?:brazil|brazilian|brasilia|rio\s+de\s+janeiro|sao\s+paulo)\b', re.I), 'BR'),
    (re.compile(r'\b(?:argentina|argentinian|buenos\s+aires|cordoba|rosario)\b', re.I), 'AR'),
    (re.compile(r'\b(?:chile|chilean|santiago|valparaiso)\b', re.I), 'CL'),
    (re.compile(r'\b(?:colombia|colombian|bogota|medellin)\b', re.I), 'CO'),
    (re.compile(r'\b(?:peru|peruvian|lima|arequipa)\b', re.I), 'PE'),
    (re.compile(r'\b(?:venezuela|venezuelan|caracas|maracaibo)\b', re.I), 'VE'),
    (re.compile(r'\b(?:ecuador|ecuadorian|quito|guayaquil)\b', re.I), 'EC'),
    (re.compile(r'\b(?:uruguay|uruguayan|montevideo)\b', re.I), 'UY'),
    (re.compile(r'\b(?:paraguay|paraguayan|asuncion)\b', re.I), 'PY'),
    (re.compile(r'\b(?:bolivia|bolivian|la\s+paz|santa\s+cruz)\b', re.I), 'BO'),
    (re.compile(r'\b(?:cuba|cuban|havana)\b', re.I), 'CU'),
    (re.compile(r'\b(?:jamaica|jamaican|kingston|montego\s+bay)\b', re.I), 'JM'),
    (re.compile(r'\b(?:haiti|haitian|port-au-prince)\b', re.I), 'HT'),
    (re.compile(r'\b(?:trinidad|tobago|port\s+of\s+spain)\b', re.I), 'TT'),

    # Russia/Ukraine/Central Asia
    (re.compile(r'\b(?:russia|russian|kremlin|putin)\b', re.I), 'RU'),
    (re.compile(r'\b(?:ukraine|ukrainian|kyiv|kiev)\b', re.I), 'UA'),
    (re.compile(r'\b(?:belarus|belarusian|minsk)\b', re.I), 'BY'),
    (re.compile(r'\b(?:kazakhstan|kazakh|almaty|astana)\b', re.I), 'KZ'),
    (re.compile(r'\b(?:uzbekistan|uzbek|tashkent)\b', re.I), 'UZ'),
    (re.compile(r'\b(?:georgia|georgian|tbilisi|batumi)\b', re.I), 'GE'),

    # Oceania
    (re.compile(r'\b(?:fiji|fijian|suva)\b', re.I), 'FJ'),
    (re.compile(r'\b(?:png|papua\s+new\s+guinea|port\s+moresby)\b', re.I), 'PG'),
]

# US state patterns - maps state name -> state abbreviation
_US_STATE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r'\b(?:alabama|al\b)\b', re.I), 'US-AL'),
    (re.compile(r'\b(?:alaska|ak\b)\b', re.I), 'US-AK'),
    (re.compile(r'\b(?:arizona|az\b)\b', re.I), 'US-AZ'),
    (re.compile(r'\b(?:arkansas|ar\b)\b', re.I), 'US-AR'),
    (re.compile(r'\b(?:california|ca\b)\b', re.I), 'US-CA'),
    (re.compile(r'\b(?:colorado|co\b)\b', re.I), 'US-CO'),
    (re.compile(r'\b(?:connecticut|ct\b)\b', re.I), 'US-CT'),
    (re.compile(r'\b(?:delaware|de\b)\b', re.I), 'US-DE'),
    (re.compile(r'\b(?:florida|fl\b)\b', re.I), 'US-FL'),
    (re.compile(r'\b(?:georgia|ga\b)\b', re.I), 'US-GA'),
    (re.compile(r'\b(?:hawaii|hi\b)\b', re.I), 'US-HI'),
    (re.compile(r'\b(?:idaho|id\b)\b', re.I), 'US-ID'),
    (re.compile(r'\b(?:illinois|il\b)\b', re.I), 'US-IL'),
    (re.compile(r'\b(?:indiana|in\b)\b', re.I), 'US-IN'),
    (re.compile(r'\b(?:iowa|ia\b)\b', re.I), 'US-IA'),
    (re.compile(r'\b(?:kansas|ks\b)\b', re.I), 'US-KS'),
    (re.compile(r'\b(?:kentucky|ky\b)\b', re.I), 'US-KY'),
    (re.compile(r'\b(?:louisiana|la\b)\b', re.I), 'US-LA'),
    (re.compile(r'\b(?:maine|me\b)\b', re.I), 'US-ME'),
    (re.compile(r'\b(?:maryland|md\b)\b', re.I), 'US-MD'),
    (re.compile(r'\b(?:massachusetts|ma\b)\b', re.I), 'US-MA'),
    (re.compile(r'\b(?:michigan|mi\b)\b', re.I), 'US-MI'),
    (re.compile(r'\b(?:minnesota|mn\b)\b', re.I), 'US-MN'),
    (re.compile(r'\b(?:mississippi|ms\b)\b', re.I), 'US-MS'),
    (re.compile(r'\b(?:missouri|mo\b)\b', re.I), 'US-MO'),
    (re.compile(r'\b(?:montana|mt\b)\b', re.I), 'US-MT'),
    (re.compile(r'\b(?:nebraska|ne\b)\b', re.I), 'US-NE'),
    (re.compile(r'\b(?:nevada|nv\b)\b', re.I), 'US-NV'),
    (re.compile(r'\b(?:new\s+hampshire|nh\b)\b', re.I), 'US-NH'),
    (re.compile(r'\b(?:new\s+jersey|nj\b)\b', re.I), 'US-NJ'),
    (re.compile(r'\b(?:new\s+mexico|nm\b)\b', re.I), 'US-NM'),
    (re.compile(r'\b(?:new\s+york|ny\b)\b', re.I), 'US-NY'),
    (re.compile(r'\b(?:north\s+carolina|nc\b)\b', re.I), 'US-NC'),
    (re.compile(r'\b(?:north\s+dakota|nd\b)\b', re.I), 'US-ND'),
    (re.compile(r'\b(?:ohio|oh\b)\b', re.I), 'US-OH'),
    (re.compile(r'\b(?:oklahoma|ok\b)\b', re.I), 'US-OK'),
    (re.compile(r'\b(?:oregon|or\b)\b', re.I), 'US-OR'),
    (re.compile(r'\b(?:pennsylvania|pa\b)\b', re.I), 'US-PA'),
    (re.compile(r'\b(?:rhode\s+island|ri\b)\b', re.I), 'US-RI'),
    (re.compile(r'\b(?:south\s+carolina|sc\b)\b', re.I), 'US-SC'),
    (re.compile(r'\b(?:south\s+dakota|sd\b)\b', re.I), 'US-SD'),
    (re.compile(r'\b(?:tennessee|tn\b)\b', re.I), 'US-TN'),
    (re.compile(r'\b(?:texas|tx\b)\b', re.I), 'US-TX'),
    (re.compile(r'\b(?:utah|ut\b)\b', re.I), 'US-UT'),
    (re.compile(r'\b(?:vermont|vt\b)\b', re.I), 'US-VT'),
    (re.compile(r'\b(?:virginia|va\b)\b', re.I), 'US-VA'),
    (re.compile(r'\b(?:washington|wa\b)\b', re.I), 'US-WA'),
    (re.compile(r'\b(?:west\s+virginia|wv\b)\b', re.I), 'US-WV'),
    (re.compile(r'\b(?:wisconsin|wi\b)\b', re.I), 'US-WI'),
    (re.compile(r'\b(?:wyoming|wy\b)\b', re.I), 'US-WY'),
]


def detect_context_countries(ctx: str) -> set[str]:
    """Detect country codes mentioned in the given context text.

    Returns a set of ISO country codes (e.g., {'US', 'GB', 'RU'}).
    Used to disambiguate multi-country city names by matching context.
    """
    if not ctx:
        return set()
    countries: set[str] = set()
    for pattern, code in _COUNTRY_CONTEXT_PATTERNS:
        if pattern.search(ctx):
            countries.add(code)
    return countries


def detect_context_states(ctx: str) -> set[str]:
    """Detect US state mentions in the given context text.

    Returns a set of US state abbreviations (e.g., {'US-ID', 'US-OH'}).
    Used to disambiguate US city names by matching state context.
    """
    if not ctx:
        return set()
    states: set[str] = set()
    for pattern, abbrev in _US_STATE_PATTERNS:
        if pattern.search(ctx):
            states.add(abbrev)
    return states


def _ambiguous_city_countries() -> dict[str, set[str]]:
    """Build a map of city name -> set of country codes where this city exists.

    This is cached and lazily built from the database on first call.
    Only includes cities that exist in 2+ countries.
    """
    if not hasattr(_ambiguous_city_countries, '_cache'):
        try:
            from .db import connect
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    SELECT LOWER(name) AS name, country_code
                    FROM world_cities
                    WHERE name IS NOT NULL
                    GROUP BY LOWER(name), country_code
                    HAVING COUNT(*) > 0
                """)
                rows = cur.fetchall()

            # Build name -> set of countries
            city_countries: dict[str, set[str]] = {}
            for row in rows:
                name = row['name'].lower()
                cc = row['country_code']
                if name not in city_countries:
                    city_countries[name] = set()
                city_countries[name].add(cc)

            # Filter to only cities in 2+ countries
            _ambiguous_city_countries._cache = {
                name: countries for name, countries in city_countries.items()
                if len(countries) >= 2
            }
        except Exception:
            # If DB is unavailable, return empty dict
            _ambiguous_city_countries._cache = {}

    return _ambiguous_city_countries._cache
