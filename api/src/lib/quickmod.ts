// ── quickmod.ts — deterministic pre-moderation for user submissions ──────
//
// Stage 1 of the two-stage submission gate (POST /api/pins). Pure TS, no
// I/O, sub-millisecond: runs BEFORE anything is stored and BEFORE any LLM
// token is spent. Goals (owner spec 2026-09-28):
//
//   1. Reject obvious spam / gibberish / abuse in ANY language.
//   2. Classify the submission into the 12-category taxonomy with a
//      multilingual keyword pass and hand the submitter a plain-language
//      "we read this as …" summary (shown in the UI immediately).
//   3. Emit signals for the deferred deep check (worker/pin_moderate.py)
//      without ever blocking on it.
//
// Non-goals: NO violence/disaster word blocking — this is a NEWS map, so
// "bomb", "flood", "protest" are legitimate content. The blocklist is
// commercial spam, adult content, scam patterns, and slurs only.
//
// Stage 2 (queue → Python) does langdetect, doc_type, URL robots/fetch +
// frequency analysis, ocean/land coordinate validation, and the
// breaker-gated LLM verdict. Keep this file dependency-free and fast.

export type Script =
  | "latin" | "cyrillic" | "arabic" | "hebrew" | "devanagari"
  | "bengali" | "cjk" | "hangul" | "kana" | "thai" | "other";

export interface TopicGuess {
  category: string;
  confidence: number;       // 0..1
  matched: string[];        // keywords that fired (for transparency)
  lang_hint: string;        // best-guess language of the matches
}

export interface FastScanResult {
  pass: boolean;
  reasons: string[];        // fatal → reject with these
  signals: string[];        // non-fatal observations for stage 2 / audit
  script: Script;
  topic: TopicGuess;
  topic_summary: string;    // human-readable, shown back to the submitter
}

// ── Normalization ────────────────────────────────────────────────────────

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export function normalizeText(raw: string): string {
  return raw
    .replace(ZERO_WIDTH, "")            // ban-evasion invisibles
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // control chars
    .replace(/\s+/g, " ")
    .trim();
}

// ── Script detection (cheap, range-based) ───────────────────────────────

const SCRIPT_RANGES: Array<[Script, RegExp]> = [
  ["cyrillic", /[\u0400-\u04FF]/],
  ["arabic", /[\u0600-\u06FF\u0750-\u077F]/],
  ["hebrew", /[\u0590-\u05FF]/],
  ["devanagari", /[\u0900-\u097F]/],
  ["bengali", /[\u0980-\u09FF]/],
  ["thai", /[\u0E00-\u0E7F]/],
  ["hangul", /[\uAC00-\uD7AF\u1100-\u11FF]/],
  ["kana", /[\u3040-\u30FF]/],
  ["cjk", /[\u4E00-\u9FFF]/],
  ["latin", /[A-Za-z\u00C0-\u024F]/],
];

export function detectScript(text: string): Script {
  const counts = new Map<Script, number>();
  for (const ch of text) {
    for (const [script, re] of SCRIPT_RANGES) {
      if (re.test(ch)) {
        counts.set(script, (counts.get(script) || 0) + 1);
        break;
      }
    }
  }
  let best: Script = "other";
  let bestN = 0;
  for (const [s, n] of counts) {
    if (n > bestN) { best = s; bestN = n; }
  }
  return best;
}

// ── Spam / abuse blocklist (multilingual) ───────────────────────────────
//
// Substring match on lowercased text. Deliberately narrow: commercial
// spam, scams, adult content, and slurs. NEVER topical news words.

const BLOCKLIST: Array<[string, string[]]> = [
  ["en", [
    "buy now", "click here to win", "free bitcoin", "bitcoin miner",
    "crypto signal", "crypto pump", "forex robot", "earn money fast",
    "cash app flip", "wire transfer fee", "lottery winner",
    "casino bonus", "online casino", "slot machine jackpot",
    "escort service", "xxx video", "porn video", "sex video",
    "dm me on", "message me on whatsapp", "chat me on telegram",
    "onlyfans", "sugar daddy", "payday loan instant",
    "weight loss pill", "male enhancement", "pharmacy no prescription",
    "replica watches", "cheap jerseys wholesale",
    "guaranteed winner", "fixed match", "bet tipster vip",
  ]],
  ["es", [
    "compra ahora", "dinero rapido", "dinero rápido", "casino en linea",
    "casino en línea", "apuestas gratis", "prestamo inmediato",
    "préstamo inmediato", "aumente su pene", "videos xxx",
    "whatsapp caliente", "loteria ganadora", "lotería ganadora",
  ]],
  ["pt", [
    "ganhe dinheiro", "dinheiro rapido", "dinheiro rápido",
    "aposta gratis", "aposta grátis", "cassino online",
    "emprestimo imediato", "empréstimo imediato", "videos xxx",
    "whatsapp quente", "jogo do bicho premiado",
  ]],
  ["fr", [
    "argent rapide", "casino en ligne", "gagner au loto",
    "prets entre particuliers", "prêts entre particuliers",
    "videos xxx", "rencontre coquines",
  ]],
  ["de", [
    "schnell geld verdienen", "online casino", "sofortkredit",
    "xxx videos", "lotto gewinner",
  ]],
  ["it", [
    "soldi facili", "casino online", "vinci subito", "prestito immediato",
  ]],
  ["ru", [
    "заработок в интернете", "казино бонус", "быстрый займ",
    "интим услуги", "выигрыш в лотерею", "купить подписчиков",
  ]],
  ["uk", ["казино бонус", "швидкий заробіток", "інтим послуги"]],
  ["ar", [
    "كسب المال", "قمار اونلاين", "كازينو", "ربح المال بسهولة",
    "خدمات جنسية",
  ]],
  ["hi", ["पैसा कमाएं", "जुआ ऑनलाइन", "लोन तुरंत"]],
  ["ur", ["پیسہ کمائیں", "جوئے کی سائٹ"]],
  ["id", [
    "judi online", "slot gacor", "pinjol cair", "situs togel",
    "bokep", "deposit pulsa",
  ]],
  ["ms", ["judi online", "slot gacor", "kasin dalam talian"]],
  ["tr", ["bahis sitesi", "canlı casino", "kolay para kazan"]],
  ["sw", ["kucheza kamari", "pesa haraka"]],
];

// Slurs: hard-reject list (worst offenders only; kept small and lowercase).
const SLURS = [
  "n1gger", "nigg3r",
  "chuchwa prasad", "paki ", "kike ", "faggot",
  "coon bait", "raghead",
];

const SCAM_PATTERNS: RegExp[] = [
  /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy)\//i, // shorteners
  /\+?\d[\d\s\-()]{8,}\s*(?:whats\s*app|whatsapp|telegram|wa\s*me)/i,     // contact-harvest
  /(?:whatsapp|telegram|wa)\s*[:#]?\s*\+?\d[\d\s\-()]{8,}/i,
  /\b(?:usdt|btc|eth)\s*(?:wallet|address|payment)\b/i,
  /\b(?:naira|peso|rupee|rupiah|dirham)\s*\d{3,}\s*(?:daily|per day|a day)\b/i,
  /\b(?:100%|100 ?percent)\s*(?:guarantee|win|profit)\b/i,
  /(.)\1{7,}/, // 8+ repeated chars — "gooooaaall" survives (6), spam runs don't
];

// ── Gibberish heuristics (script-aware) ─────────────────────────────────

const VOWELS: Record<string, string> = {
  latin: "aeiouy\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E6\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF\u00F2\u00F3\u00F4\u00F5\u00F6\u00F8\u00F9\u00FA\u00FB\u00FC",
  cyrillic: "\u0430\u0435\u0451\u0438\u043E\u0443\u044B\u044D\u044E\u044F",
};

function isGibberishToken(token: string, script: Script): boolean {
  if (token.length < 5) return false;
  const vowels = VOWELS[script];
  if (!vowels) return false; // no vowel model for this script — never flag
  let vowelCount = 0;
  let maxRun = 0;
  let run = 0;
  for (const ch of token) {
    if (vowels.includes(ch)) { vowelCount++; run = 0; }
    else { run++; if (run > maxRun) maxRun = run; }
  }
  const ratio = vowelCount / token.length;
  return ratio < 0.12 || maxRun >= 8;
}

export function gibberishScore(text: string, script: Script): number {
  const tokens = text.toLowerCase().split(/[^A-Za-z\u00C0-\u024F\u0400-\u04FF]+/).filter((t) => t.length >= 5);
  if (tokens.length === 0) return 0;
  const bad = tokens.filter((t) => isGibberishToken(t, script)).length;
  return bad / tokens.length;
}

// ── Lite multilingual topic classifier ──────────────────────────────────
//
// 12-category taxonomy (api/src/validate.ts CATEGORIES). High-signal
// keywords per language; matching is substring-based on lowercase text so
// inflections mostly ride along ("protesta"/"protestas", "election"/
// "elections"). Confidence is deliberately conservative — the deep stage
// refines it.

const CATEGORY_KEYWORDS: Record<string, Record<string, string[]>> = {
  politics: {
    en: ["election", "vote", "parliament", "senate", "congress", "president", "prime minister", "minister", "mayor", "government", "law", "bill", "sanction", "diplomat", "campaign", "political party", "protest", "coup", "impeach", "referendum"],
    es: ["eleccion", "elección", "presidente", "gobierno", "congreso", "senado", "alcalde", "ley", "partido", "manifestacion", "manifestación", "protesta", "golpe de estado"],
    pt: ["eleicao", "eleição", "presidente", "governo", "congresso", "senado", "prefeito", "lei", "partido", "manifestacao", "manifestação", "protesto"],
    fr: ["election", "élection", "president", "gouvernement", "parlement", "maire", "loi", "parti", "manifestation", "protestation", "coup d'etat", "coup d'état"],
    de: ["wahl", "präsident", "regierung", "parlament", "buergermeister", "bürgermeister", "gesetz", "partei", "demonstration", "protest"],
    ru: ["выборы", "президент", "правительство", "парламент", "мэр", "закон", "партия", "протест", "санкции", "дума"],
    ar: ["انتخابات", "رئيس", "حكومة", "برلمان", "قانون", "حزب", "احتجاج", "مظاهرات", "عقوبات"],
    hi: ["चुनाव", "राष्ट्रपति", "सरकार", "संसद", "कानून", "पार्टी", "प्रदर्शन"],
    ur: ["الیکشن", "صدر", "حکومت", "پارلیمنٹ", "قانون", "احتجاج"],
    id: ["pemilu", "presiden", "pemerintah", "parlemen", "dpr", "undang-undang", "partai", "demonstrasi", "protes"],
    tr: ["secim", "seçim", "cumhurbaskani", "cumhurbaşkanı", "hukumet", "hükümet", "parlamento", "yasa", "protesto"],
    it: ["elezioni", "presidente", "governo", "parlamento", "sindaco", "legge", "partito", "protesta"],
    zh: ["选举", "总统", "政府", "议会", "法律", "抗议"],
  },
  conflict: {
    en: ["war", "military", "army", "troops", "strike", "missile", "drone", "ceasefire", "invasion", "bombing", "airstrike", "soldier", "border clash", "shelling", "militant", "truce"],
    es: ["guerra", "ejercito", "ejército", "militar", "misil", "bombardeo", "alto el fuego", "invasion", "invasión", "soldado", "tregua"],
    pt: ["guerra", "exercito", "exército", "militar", "missil", "míssil", "bombardeio", "cessar-fogo", "invasao", "invasão", "soldado"],
    fr: ["guerre", "armee", "armée", "militaire", "missile", "bombardement", "cessez-le-feu", "invasion", "soldat", "tregue", "trêve"],
    de: ["krieg", "armee", "militär", "rakete", "bombardierung", "waffenruhe", "invasion", "soldat"],
    ru: ["война", "армия", "военные", "ракета", "бомбардировка", "перемирие", "вторжение", "солдат", "обстрел"],
    ar: ["حرب", "جيش", "عسكري", "صاروخ", "قصف", "هدنة", "غزو", "جنود", "اشتباكات"],
    hi: ["युद्ध", "सेना", "मिसाइल", "बमबारी", "युद्धविराम", "सैनिक"],
    ur: ["جنگ", "فوج", "میزائل", "بمباری", "فوجی"],
    id: ["perang", "militer", "tentara", "rudal", "pengeboman", "gencatan senjata", "invasi", "konflik bersenjata"],
    tr: ["savas", "savaş", "ordu", "asker", "fuze", "füze", "bombardiman", "ateskes", "ateşkes"],
    it: ["guerra", "esercito", "militare", "missile", "bombardamento", "cessate il fuoco", "soldato"],
    zh: ["战争", "军队", "导弹", "轰炸", "停火", "士兵"],
  },
  crime: {
    en: ["police", "arrest", "murder", "kidnap", "robbery", "theft", "court", "judge", "prison", "jail", "drug bust", "trafficking", "fraud", "charged with", "homicide", "assault", "stolen"],
    es: ["policia", "policía", "arresto", "asesinato", "secuestro", "robo", "tribunal", "juez", "prision", "prisión", "trafico de drogas", "tráfico de drogas", "fraude", "acusado"],
    pt: ["policia", "polícia", "prisao", "prisão", "assassinato", "sequestro", "roubo", "tribunal", "juiz", "trafico", "tráfico", "fraude", "acusado"],
    fr: ["police", "arrestation", "meurtre", "enlevement", "vol", "tribunal", "juge", "prison", "trafic", "fraude", "inculpe", "inculpé"],
    de: ["polizei", "verhaftung", "mord", "entfuehrung", "raub", "gericht", "richter", "gefaengnis", "gefängnis", "drogenhandel", "betrug"],
    ru: ["полиция", "арест", "убийство", "похищение", "кража", "суд", "судья", "тюрьма", "наркотики", "мошенничество"],
    ar: ["شرطة", "اعتقال", "قتل", "خطف", "سرقة", "محكمة", "قاضي", "سجن", "مخدرات", "احتيال"],
    hi: ["पुलिस", "गिरफ्तार", "हत्या", "अपहरण", "चोरी", "अदालत", "जेल", "धोखाधड़ी"],
    ur: ["پولیس", "گرفتار", "قتل", "اغوا", "چوری", "عدالت", "جیل"],
    id: ["polisi", "penangkapan", "pembunuhan", "penculikan", "pencurian", "pengadilan", "penjara", "narkoba", "penipuan"],
    tr: ["polis", "tutuklama", "cinayet", "kidnapping", "hirsizlik", "hırsızlık", "mahkeme", "hapishane", "uyusturucu", "uyuşturucu", "dolandiricilik"],
    it: ["polizia", "arresto", "omicidio", "rapimento", "furto", "tribunale", "giudice", "prigione", "droga", "truffa"],
    zh: ["警察", "逮捕", "谋杀", "绑架", "抢劫", "法院", "监狱", "毒品", "诈骗"],
  },
  weather: {
    en: ["storm", "hurricane", "cyclone", "typhoon", "flood", "drought", "heatwave", "heat wave", "blizzard", "tornado", "rainfall", "monsoon", "wildfire weather", "cold snap", "forecast"],
    es: ["tormenta", "huracan", "huracán", "inundacion", "inundación", "sequia", "sequía", "ola de calor", "tornado", "lluvias", "monzon", "monzón"],
    pt: ["tempestade", "furacão", "enchente", "inundacao", "seca", "onda de calor", "tornado", "chuvas"],
    fr: ["tempete", "tempête", "ouragan", "inondation", "secheresse", "canicule", "tornade", "pluies"],
    de: ["sturm", "hurrikan", "ueberschwemmung", "dürre", "hitzewelle", "tornado"],
    ru: ["шторм", "ураган", "наводнение", "засуха", "жара", "торнадо", "снегопад"],
    ar: ["عاصفة", "إعصار", "فيضانات", "جفاف", "موجة حر", "أمطار"],
    hi: ["तूफान", "चक्रवात", "बाढ़", "सूखा", "लू", "मानसून"],
    ur: ["طوفان", "سیلاب", "خشک سالی", "بارشیں"],
    id: ["badai", "topan", "banjir", "kekeringan", "gelombang panas", "cuaca ekstrem"],
    tr: ["firtina", "fırtına", "sel", "kuraklik", "sicak hava dalgasi"],
    zh: ["风暴", "台风", "洪水", "干旱", "热浪"],
  },
  environment: {
    en: ["climate", "pollution", "deforestation", "emissions", "endangered", "conservation", "ocean plastic", "carbon", "renewable energy", "solar farm", "wind farm", "wildlife", "ecosystem"],
    es: ["clima", "contaminacion", "contaminación", "deforestacion", "deforestación", "emisiones", "especie en peligro", "energia renovable", "energía renovable", "vida silvestre"],
    pt: ["clima", "poluicao", "poluição", "desmatamento", "emissoes", "emissões", "energia renovavel", "energia renovável"],
    fr: ["climat", "pollution", "deforestation", "émissions", "espece menacee", "energie renouvelable", "énergie renouvelable"],
    de: ["klima", "verschmutzung", "abholzung", "emissionen", "erneuerbare energie"],
    ru: ["климат", "загрязнение", "вырубка леса", "выбросы", "возобновляемая энергия"],
    ar: ["المناخ", "تلوث", "إزالة الغابات", "انبعاثات", "طاقة متجددة"],
    hi: ["जलवायु", "प्रदूषण", "वन कटाई", "उत्सर्जन", "नवीकरणीय ऊर्जा"],
    id: ["iklim", "polusi", "deforestasi", "emisi", "energi terbarukan", "satwa liar"],
    tr: ["iklim", "kirlilik", "orman kesimi", "emisyon", "yenilenebilir enerji"],
    zh: ["气候", "污染", "森林砍伐", "排放", "可再生能源"],
  },
  health: {
    en: ["hospital", "outbreak", "vaccine", "virus", "disease", "cholera", "malaria", "dengue", "ebola", "pandemic", "infection", "health ministry", "patients", "medical", "mental health"],
    es: ["hospital", "brote", "vacuna", "virus", "enfermedad", "colera", "malaria", "dengue", "pandemia", "infeccion", "ministerio de salud", "pacientes"],
    pt: ["hospital", "surto", "vacina", "virus", "vírus", "doenca", "doença", "dengue", "pandemia", "infeccao", "ministerio da saude", "pacientes"],
    fr: ["hopital", "hôpital", "epidemie", "épidémie", "vaccin", "virus", "maladie", "cholera", "paludisme", "dengue", "pandemie", "patients"],
    de: ["krankenhaus", "ausbruch", "impfstoff", "virus", "krankheit", "pandemie", "patienten"],
    ru: ["больница", "вспышка", "вакцина", "вирус", "болезнь", "холера", "пандемия", "пациенты"],
    ar: ["مستشفى", "تفشي", "لقاح", "فيروس", "مرض", "كوليرا", "ملاريا", "جائحة", "مرضى"],
    hi: ["अस्पताल", "टीका", "वायरस", "बीमारी", "महामारी", "मरीज", "स्वास्थ्य"],
    ur: ["ہسپتال", "ویکسین", "وائرس", "بیماری", "وبا"],
    id: ["rumah sakit", "wabah", "vaksin", "virus", "penyakit", "kolera", "demam berdarah", "pandemi", "pasien"],
    tr: ["hastane", "salgin", "aşı", "virus", "hastalik", "salgın", "hastalar"],
    zh: ["医院", "疫情", "疫苗", "病毒", "疾病", "大流行"],
  },
  business: {
    en: ["stock market", "shares", "inflation", "interest rate", "central bank", "startup", "funding", "merger", "acquisition", "layoffs", "gdp", "currency", "exports", "imports", "factory", "oil price", "economy", "trade deal", "ipo"],
    es: ["bolsa", "inflacion", "inflación", "tasas de interes", "banco central", "startup", "financiamiento", "fusion", "despidos", "pib", "moneda", "economia", "economía", "precio del petroleo"],
    pt: ["bolsa", "inflacao", "inflação", "juros", "banco central", "startup", "financiamento", "fusao", "demissoes", "pib", "moeda", "economia", "preco do petroleo"],
    fr: ["bourse", "inflation", "taux d'interet", "banque centrale", "startup", "financement", "fusion", "licenciements", "pib", "monnaie", "economie", "économie"],
    de: ["börse", "inflation", "zinsen", "zentralbank", "startup", "fusion", "entlassungen", "bip", "wirtschaft"],
    ru: ["биржа", "инфляция", "процентная ставка", "центральный банк", "стартап", "слияние", "ввп", "валюта", "экономика", "цена нефти"],
    ar: ["البورصة", "تضخم", "سعر الفائدة", "البنك المركزي", "شركة ناشئة", "اندماج", "ناتج محلي", "عملة", "اقتصاد", "سعر النفط"],
    hi: ["शेयर बाजार", "मुद्रास्फीति", "ब्याज दर", "केंद्रीय बैंक", "स्टार्टअप", "जीडीपी", "अर्थव्यवस्था", "तेल की कीमत"],
    ur: ["اسٹاک مارکیٹ", "افراط زر", "مرکزی بینک", "معیشت"],
    id: ["bursa saham", "inflasi", "suku bunga", "bank sentral", "startup", "pendanaan", "merger", "phk", "pdb", "mata uang", "ekonomi", "harga minyak"],
    tr: ["borsa", "enflasyon", "faiz", "merkez bankasi", "merkez bankası", "girisim", "girişim", "birlesme", "birleşme", "gsyh", "ekonomi"],
    zh: ["股市", "通胀", "利率", "央行", "创业公司", "并购", "国内生产总值", "经济", "油价"],
  },
  technology: {
    en: ["ai model", "artificial intelligence", "chip", "semiconductor", "software", "cyberattack", "data breach", "app launch", "quantum", "5g", "6g", "robot", "satellite internet", "open source", "cloud", "encryption", "tech giant"],
    es: ["inteligencia artificial", "semiconductor", "software", "ciberataque", "filtracion de datos", "cuantico", "robot", "satelite", "codigo abierto", "nube"],
    pt: ["inteligencia artificial", "inteligência artificial", "software", "ciberataque", "vazamento de dados", "quantico", "robo", "robô", "satelite", "codigo aberto", "nuvem"],
    fr: ["intelligence artificielle", "logiciel", "cyberattaque", "fuite de donnees", "quantique", "robot", "satellite", "code source ouvert", "cloud"],
    de: ["kuenstliche intelligenz", "halbleiter", "software", "cyberangriff", "datenleck", "quanten", "roboter", "cloud"],
    ru: ["искусственный интеллект", "полупроводник", "программное обеспечение", "кибератака", "утечка данных", "квантовый", "робот", "спутник"],
    ar: ["الذكاء الاصطناعي", "أشباه الموصلات", "برمجيات", "هجوم إلكتروني", "تسريب بيانات", "روبوت", "قمر صناعي"],
    hi: ["कृत्रिम बुद्धिमत्ता", "चिप", "सॉफ्टवेयर", "साइबर हमला", "डेटा लीक", "रोबोट", "उपग्रह"],
    id: ["kecerdasan buatan", "semikonduktor", "perangkat lunak", "serangan siber", "kebocoran data", "robot", "satelit", "cloud"],
    tr: ["yapay zeka", "çip", "yazilim", "yazılım", "siber saldiri", "siber saldırı", "veri ihlali", "robot"],
    zh: ["人工智能", "芯片", "半导体", "软件", "网络攻击", "数据泄露", "量子", "机器人", "卫星"],
  },
  science: {
    en: ["research", "scientists", "discovery", "study finds", "nasa", "space telescope", "fossil", "gene", "crispr", "particle", "archaeology", "lab", "peer-reviewed", "species discovered", "vaccine trial"],
    es: ["investigacion", "investigación", "cientificos", "científicos", "descubrimiento", "estudio", "fosil", "fósil", "genes", "arqueologia", "arqueología", "laboratorio", "especie descubierta"],
    pt: ["pesquisa", "cientistas", "descoberta", "estudo", "fossil", "genes", "arqueologia", "laboratorio", "laboratório"],
    fr: ["recherche", "scientifiques", "decouverte", "étude", "fosse", "gènes", "archeologie", "laboratoire"],
    de: ["forschung", "wissenschaftler", "entdeckung", "studie", "fossil", "gene", "archaologie", "labor"],
    ru: ["исследование", "ученые", "открытие", "ископаемое", "гены", "археология", "лаборатория"],
    ar: ["بحث علمي", "علماء", "اكتشاف", "دراسة", "أحفورة", "جينات", "آثار", "مختبر"],
    hi: ["शोध", "वैज्ञानिक", "खोज", "जीवाश्म", "जीन", "पुरातत्व", "प्रयोगशाला"],
    id: ["penelitian", "ilmuwan", "penemuan", "fosil", "gen", "arkeologi", "laboratorium"],
    tr: ["arastirma", "araştırma", "bilim insani", "bilim insanı", "kesif", "keşif", "fosil", "gen", "arkeoloji"],
    zh: ["研究", "科学家", "发现", "化石", "基因", "考古", "实验室"],
  },
  sports: {
    en: ["match", "league", "championship", "world cup", "olympics", "football", "soccer", "cricket", "basketball", "tennis", "goal", "coach", "team wins", "finals", "medal", "transfer window", "premier league", "la liga", "serie a", "bundesliga", "nba", "fifa"],
    es: ["partido", "liga", "campeonato", "mundial", "olimpicos", "olímpicos", "futbol", "fútbol", "baloncesto", "tenis", "gol", "entrenador", "equipo gana", "medalla"],
    pt: ["partida", "liga", "campeonato", "copa do mundo", "olimpiadas", "olimpíadas", "futebol", "basquete", "tenis", "gol", "tecnico", "técnico", "medalha"],
    fr: ["match", "ligue", "championnat", "coupe du monde", "olympiques", "football", "basket", "tennis", "but", "entraineur", "entraîneur", "medaille", "médaille"],
    de: ["spiel", "liga", "meisterschaft", "weltmeisterschaft", "olympia", "fussball", "fußball", "basketball", "tennis", "tor", "trainer", "medaille"],
    ru: ["матч", "лига", "чемпионат", "кубок мира", "олимпиада", "футбол", "баскетбол", "теннис", "гол", "тренер", "медаль"],
    ar: ["مباراة", "دوري", "بطولة", "كأس العالم", "الأولمبياد", "كرة القدم", "كرة السلة", "تنس", "هدف", "مدرب", "ميدالية"],
    hi: ["मैच", "लीग", "चैंपियनशिप", "विश्व कप", "ओलंपिक", "क्रिकेट", "फुटबॉल", "हॉकी", "कोच", "मेडल"],
    ur: ["میچ", "لیگ", "ورلڈ کپ", "کرکٹ", "فٹ بال", "ہاکی", "کپتان"],
    id: ["pertandingan", "liga", "kejuaraan", "piala dunia", "olimpiade", "sepak bola", "bulu tangkis", "basket", "tenis", "pelatih", "medali"],
    tr: ["mac", "maç", "lig", "sampiyona", "şampiyona", "dunya kupasi", "dünya kupası", "futbol", "basketbol", "tenis", "gol", "antrenor", "madalya"],
    zh: ["比赛", "联赛", "锦标赛", "世界杯", "奥运会", "足球", "篮球", "网球", "教练", "奖牌"],
  },
  culture: {
    en: ["festival", "concert", "museum", "exhibition", "film", "movie premiere", "album", "heritage", "unesco", "art gallery", "theatre", "theater", "book fair", "carnival", "cultural"],
    es: ["festival", "concierto", "museo", "exposicion", "exposición", "pelicula", "película", "album", "patrimonio", "galeria de arte", "teatro", "carnaval", "feria del libro"],
    pt: ["festival", "show", "museu", "exposicao", "exposição", "filme", "album", "patrimonio", "patrimônio", "galeria de arte", "teatro", "carnaval"],
    fr: ["festival", "concert", "musee", "exposition", "film", "patrimoine", "galerie", "theatre", "carnaval"],
    de: ["festival", "konzert", "museum", "ausstellung", "film", "kulturerbe", "galerie", "theater", "karneval"],
    ru: ["фестиваль", "концерт", "музей", "выставка", "фильм", "наследие", "галерея", "театр", "карнавал"],
    ar: ["مهرجان", "حفل موسيقي", "متحف", "معرض", "فيلم", "تراث", "معرض فني", "مسرح"],
    hi: ["उत्सव", "समारोह", "संग्रहालय", "प्रदर्शनी", "फिल्म", "विरासत", "नाटक", "कार्निवाल"],
    id: ["festival", "konser", "museum", "pameran", "film", "warisan budaya", "galeri", "teater", "karnaval"],
    tr: ["festival", "konser", "muze", "sergi", "film", "miras", "galeri", "tiyatro"],
    zh: ["节日", "音乐会", "博物馆", "展览", "电影", "遗产", "画廊", "剧院"],
  },
  // NOTE: bucket key is 'earthquake' because that's the valid pins.category
  // sub-type (schema-icons.sql) covering disasters; the frontend maps it to
  // the 'disaster' parent icon/color. Generic accidents (crashes, collapses)
  // live here too — stage 2 can refine to a narrower sub-type.
  earthquake: {
    en: ["earthquake", "landslide", "building collapse", "explosion", "train derailment", "plane crash", "ship capsized", "death toll", "rescue operation", "aftershock", "eruption", "tsunami", "ferry capsized"],
    es: ["terremoto", "deslizamiento", "colapso de edificio", "explosion", "descarrilamiento", "accidente aereo", "accidente aéreo", "muertos", "rescate", "replica sismica", "erupcion", "tsunami"],
    pt: ["terremoto", "deslizamento", "desabamento", "explosao", "explosão", "acidente aereo", "acidente aéreo", "mortos", "resgate", "erupcao", "tsunami"],
    fr: ["seisme", "séisme", "glissement de terrain", "effondrement", "explosion", "accident d'avion", "morts", "secours", "eruption", "tsunami"],
    de: ["erdbeben", "erdrutsch", "einsturz", "explosion", "flugzeugabsturz", "tote", "rettung", "ausbruch", "tsunami"],
    ru: ["землетрясение", "оползень", "обрушение", "взрыв", "крушение", "погибшие", "спасательная операция", "извержение", "цунами"],
    ar: ["زلزال", "انهيار أرضي", "انهيار مبنى", "انفجار", "تحطم طائرة", "قتلى", "إنقاذ", "انفجار بركاني", "تسونامي"],
    hi: ["भूकंप", "भूस्खलन", "इमारत गिरना", "विस्फोट", "विमान दुर्घटना", "मृतक", "बचाव अभियान", "सुनामी"],
    ur: ["زلزلہ", "تودہ گِرنا", "عمارت گرنا", "دھماکہ", "طیارہ حادثہ", "ہلاک", "امدادی کارروائی"],
    id: ["gempa", "tanah longsor", "gedung runtuh", "ledakan", "pesawat jatuh", "korban jiwa", "operasi penyelamatan", "letusan", "tsunami"],
    tr: ["deprem", "toprak kaymasi", "bina çökmesi", "patlama", "ucak kazasi", "can kaybi", "can kaybı", "kurtarma", "tsunami"],
    zh: ["地震", "山体滑坡", "楼房倒塌", "爆炸", "坠机", "遇难", "救援", "海啸"],
  },
};

// Language code → display name for the summary line
const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German",
  it: "Italian", ru: "Russian", uk: "Ukrainian", ar: "Arabic", hi: "Hindi",
  ur: "Urdu", id: "Indonesian", ms: "Malay", tr: "Turkish", zh: "Chinese",
};

// Category → human-facing label (the stored value stays the DB-valid key).
const CATEGORY_DISPLAY: Record<string, string> = {
  earthquake: "disaster/accident",
};

// ── Keyword matcher compilation ─────────────────────────────────────────
//
// Naive substring matching produced false hits ("war" inside "warning"),
// so single-word keywords in lettered scripts get word-boundary regexes:
//   * short words (<5 chars: "war", "law", "ai") → exact boundary match
//   * longer words → boundary + up to 3 trailing letters for inflections
//     ("flood"→"floods/flooding", "protest"→"protests/protesta")
// Multi-word phrases and non-\b-friendly scripts (Arabic, Devanagari, CJK —
// JS \b is ASCII-word based) keep substring matching, which is correct for
// CJK (no word separators) and safe for the multi-word phrases.

interface KwMatcher {
  kw: string;
  weight: number;
  re: RegExp | null;   // null → substring match
}

const LETTERED = /^[A-Za-z\u00C0-\u024F\u0400-\u04FF]+$/;

function compileKeyword(kw: string): KwMatcher {
  const weight = kw.includes(" ") ? 2 : 1;
  if (kw.includes(" ") || !LETTERED.test(kw)) {
    return { kw, weight, re: null };
  }
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = kw.length >= 5 ? `[\\p{L}]{0,3}` : "";
  return {
    kw,
    weight,
    re: new RegExp(`(?<![\\p{L}])${esc}${suffix}(?![\\p{L}])`, "iu"),
  };
}

const COMPILED_KEYWORDS: Record<string, Record<string, KwMatcher[]>> = (() => {
  const out: Record<string, Record<string, KwMatcher[]>> = {};
  for (const [cat, perLang] of Object.entries(CATEGORY_KEYWORDS)) {
    out[cat] = {};
    for (const [lang, kws] of Object.entries(perLang)) {
      out[cat][lang] = kws.map(compileKeyword);
    }
  }
  return out;
})();

export function classifyTopic(text: string): TopicGuess {
  const lower = text.toLowerCase();
  let bestCat = "other";
  let bestScore = 0;
  let bestMatched: string[] = [];
  let bestLang = "en";

  for (const [category, perLang] of Object.entries(COMPILED_KEYWORDS)) {
    for (const [lang, matchers] of Object.entries(perLang)) {
      let score = 0;
      const matched: string[] = [];
      for (const m of matchers) {
        const hit = m.re ? m.re.test(lower) : lower.includes(m.kw);
        if (hit) {
          score += m.weight;
          matched.push(m.kw);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestCat = category;
        bestMatched = matched;
        bestLang = lang;
      }
    }
  }

  // Confidence: 1 keyword ≈ 0.45, 2 ≈ 0.65, 3+ ≈ 0.8; phrase matches boost.
  const confidence = bestScore === 0
    ? 0
    : Math.min(0.9, 0.25 + bestScore * 0.2);

  return {
    category: bestScore === 0 ? "other" : bestCat,
    confidence,
    matched: bestMatched.slice(0, 6),
    lang_hint: bestScore === 0 ? "unknown" : bestLang,
  };
}

// ── Main entry point ────────────────────────────────────────────────────

export function fastScan(title: string, note?: string, url?: string): FastScanResult {
  const reasons: string[] = [];
  const signals: string[] = [];

  const cleanTitle = normalizeText(title || "");
  const cleanNote = normalizeText(note || "");
  const full = `${cleanTitle} ${cleanNote}`.trim();
  const lower = full.toLowerCase();

  // Zero-width characters were stripped but their presence is itself a signal.
  if (ZERO_WIDTH.test(title || "") || ZERO_WIDTH.test(note || "")) {
    signals.push("zero_width_chars_stripped");
  }

  const script = detectScript(full);

  // ── Hard rejects ──
  if (cleanTitle.length < 3) {
    reasons.push("title_too_short");
  }
  if (cleanTitle.length > 0 && !/[\p{L}\p{N}]/u.test(cleanTitle)) {
    reasons.push("title_no_letters_or_digits");
  }

  for (const re of SCAM_PATTERNS) {
    if (re.test(lower)) {
      reasons.push("scam_pattern");
      signals.push(`scam_pattern:${re.source.slice(0, 30)}`);
      break;
    }
  }

  blocklist: {
    for (const [lang, terms] of BLOCKLIST) {
      for (const term of terms) {
        if (lower.includes(term)) {
          reasons.push("spam_blocklist");
          signals.push(`blocklist:${lang}:${term}`);
          break blocklist;
        }
      }
    }
  }

  for (const slur of SLURS) {
    if (lower.includes(slur)) {
      reasons.push("abusive_language");
      break;
    }
  }

  // Uppercase spam: >75% caps over a meaningful length.
  const letters = full.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 25) {
    const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
    if (upper / letters.length > 0.75) reasons.push("all_caps");
    else if (upper / letters.length > 0.5) signals.push("heavy_caps");
  }

  // Punctuation / emoji spam
  const bangs = (full.match(/[!?]{4,}/g) || []).length;
  if (bangs > 0) signals.push("punctuation_burst");
  if (bangs >= 3) reasons.push("punctuation_spam");

  const urlCount = (full.match(/https?:\/\//g) || []).length;
  if (urlCount >= 3) reasons.push("too_many_links");
  else if (urlCount >= 1) signals.push(`embedded_links:${urlCount}`);
  if (url) signals.push("canonical_url_present");

  // Gibberish (only for scripts with a vowel model)
  const gib = gibberishScore(lower, script);
  if (gib >= 0.5 && letters.length >= 20) reasons.push("gibberish_text");
  else if (gib >= 0.3) signals.push(`gibberish_score:${gib.toFixed(2)}`);

  // Single repeated token ("free free free free free")
  const tokens = lower.split(" ").filter(Boolean);
  if (tokens.length >= 5) {
    const uniq = new Set(tokens).size / tokens.length;
    if (uniq < 0.3) reasons.push("repetitive_text");
    else if (uniq < 0.5) signals.push("repetitive_text_soft");
  }

  // ── Topic classification (always runs — it's the user-facing summary) ──
  const topic = classifyTopic(full);
  if (topic.confidence === 0) {
    signals.push("no_topic_keywords_matched");
  }

  const langName = LANG_NAMES[topic.lang_hint] || topic.lang_hint;
  let topic_summary: string;
  if (topic.category === "other" || topic.confidence === 0) {
    topic_summary = script === "other"
      ? "We couldn't confidently tell what this is about yet — it will be reviewed."
      : `Logged as a general story (${script} script). A deeper check will refine the topic.`;
  } else {
    const kw = topic.matched.length
      ? ` (matched: "${topic.matched.slice(0, 3).join('", "')}")`
      : "";
    const lang = topic.lang_hint !== "en" ? `, likely ${langName}` : "";
    const catName = CATEGORY_DISPLAY[topic.category] || topic.category;
    topic_summary = `We read this as a ${catName} story${kw}${lang}.`;
  }

  return {
    pass: reasons.length === 0,
    reasons,
    signals,
    script,
    topic,
    topic_summary,
  };
}
