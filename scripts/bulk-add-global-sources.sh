#!/usr/bin/env bash
# ── bulk-add-global-sources.sh ──────────────────────────────────────
# Adds RSS news sources for major cities worldwide.
# Run: ./scripts/bulk-add-global-sources.sh [--dry-run]

set -euo pipefail

WORKDIR="/var/www/vhosts/xyzo.org"
DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
DRY_RUN="${1:-}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

runpsql() {
  psql "$DB_DSN" -t -A -c "$1" 2>&1
}

add_source() {
  local name="$1" feed_url="$2" country="$3" homepage_url="$4"
  
  # Check if already exists
  local exists
  exists=$(runpsql "SELECT id FROM news_sources WHERE feed_url='$feed_url';" 2>/dev/null || echo "")
  if [[ -n "$exists" ]]; then
    return 0
  fi
  
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    log "  DRY RUN: Would add $name ($country) - $feed_url"
    return 0
  fi
  
  # Insert into news_sources
  runpsql "
    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active, homepage_url)
    VALUES ('$name', '$feed_url', '$country', 'en', 'global', 'rss', TRUE, '$homepage_url')
    ON CONFLICT (feed_url) DO NOTHING;
  " >/dev/null 2>&1 || true
  
  # Insert into feeds.json
  cd "$WORKDIR"
  python3 -c "
import json
from pathlib import Path

feeds_file = Path('worker/feeds.json')
try:
    data = json.loads(feeds_file.read_text())
except:
    data = {'feeds': []}

# Check if already exists
urls = {f.get('feed_url') for f in data['feeds']}
if '$feed_url' not in urls:
    data['feeds'].append({
        'name': '$name',
        'feed_url': '$feed_url',
        'country': '$country',
        'language': 'en',
        'enabled': True
    })
    feeds_file.write_text(json.dumps(data, indent=2, ensure_ascii=False))
" 2>/dev/null || true
  
  log "  ✓ Added: $name ($country)"
}

log "═══ BULK ADD GLOBAL SOURCES ═══"
log ""

# ── Major Wire Services (Global) ────────────────────────────────────
log "── Wire Services ──"
add_source "Reuters" "https://www.reutersagency.com/feed/" "US" "https://www.reuters.com"
add_source "Associated Press" "https://rsshub.app/apnews/topics/apf-topnews" "US" "https://apnews.com"
add_source "AFP" "https://www.france24.com/en/rss" "FR" "https://www.france24.com"
add_source "Al Jazeera" "https://www.aljazeera.com/xml/rss/all.xml" "QA" "https://www.aljazeera.com"
add_source "BBC World" "https://feeds.bbci.co.uk/news/world/rss.xml" "GB" "https://www.bbc.com/news/world"
add_source "CNN International" "http://rss.cnn.com/rss/edition_world.rss" "US" "https://www.cnn.com"
add_source "Deutsche Welle" "https://rss.dw.com/rdf/rss-en-all" "DE" "https://www.dw.com"
add_source "France 24" "https://www.france24.com/en/rss" "FR" "https://www.france24.com"
add_source "NHK World" "https://www3.nhk.or.jp/nhkworld/en/news/feeds/" "JP" "https://www3.nhk.or.jp/nhkworld/"
add_source "CNA" "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml" "SG" "https://www.channelnewsasia.com"

# ── North America ───────────────────────────────────────────────────
log "── North America ──"
add_source "New York Times" "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" "US" "https://www.nytimes.com"
add_source "Washington Post" "https://feeds.washingtonpost.com/rss/world" "US" "https://www.washingtonpost.com"
add_source "LA Times" "https://www.latimes.com/world/rss2.0.xml" "US" "https://www.latimes.com"
add_source "NPR" "https://feeds.npr.org/1001/rss.xml" "US" "https://www.npr.org"
add_source "CBC Canada" "https://rss.cbc.ca/lineup/topstories.xml" "CA" "https://www.cbc.ca"
add_source "Toronto Star" "https://www.thestar.com/rss" "CA" "https://www.thestar.com"
add_source "Globe and Mail" "https://www.theglobeandmail.com/arc/outboundfeeds/rss/" "CA" "https://www.theglobeandmail.com"
add_source "Mexico News Daily" "https://mexiconewsdaily.com/feed/" "MX" "https://mexiconewsdaily.com"
add_source "El Universal" "https://www.eluniversal.com.mx/rss.xml" "MX" "https://www.eluniversal.com.mx"

# ── Europe ──────────────────────────────────────────────────────────
log "── Europe ──"
add_source "The Guardian" "https://www.theguardian.com/world/rss" "GB" "https://www.theguardian.com"
add_source "The Telegraph" "https://www.telegraph.co.uk/rss.xml" "GB" "https://www.telegraph.co.uk"
add_source "The Independent" "https://www.independent.co.uk/news/world/rss" "GB" "https://www.independent.co.uk"
add_source "Le Monde" "https://www.lemonde.fr/rss/une.xml" "FR" "https://www.lemonde.fr"
add_source "Der Spiegel" "https://www.spiegel.de/international/index.rss" "DE" "https://www.spiegel.de"
add_source "Die Zeit" "https://www.zeit.de/index" "DE" "https://www.zeit.de"
add_source "El Pais" "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada" "ES" "https://elpais.com"
add_source "La Repubblica" "https://www.repubblica.it/rss/homepage/rss2.0.xml" "IT" "https://www.repubblica.it"
add_source "Corriere della Sera" "https://www.corriere.it/rss/homepage.xml" "IT" "https://www.corriere.it"
add_source "NRC" "https://www.nrc.nl/rss/" "NL" "https://www.nrc.nl"
add_source "De Volkskrant" "https://www.volkskrant.nl/rss/" "NL" "https://www.volkskrant.nl"
add_source "Aftonbladet" "https://www.aftonbladet.se/rss.xml" "SE" "https://www.aftonbladet.se"
add_source "Dagens Nyheter" "https://www.dn.se/rss/" "SE" "https://www.dn.se"
add_source "Le Soir" "https://www.lesoir.be/rss" "BE" "https://www.lesoir.be"
add_source "Neue Zürcher Zeitung" "https://www.nzz.ch/rss" "CH" "https://www.nzz.ch"
add_source "Der Standard" "https://www.derstandard.at/rss" "AT" "https://www.derstandard.at"
add_source "Gazeta Wyborcza" "https://wyborcza.pl/pub/rss/rss.xml" "PL" "https://wyborcza.pl"
add_source "Pravda" "https://www.pravda.com.ua/eng/rss/" "UA" "https://www.pravda.com.ua"
add_source "Kathimerini" "https://www.ekathimerini.com/rss/" "GR" "https://www.ekathimerini.com"
add_source "Hurriyet" "https://www.hurriyet.com.tr/rss/gundem" "TR" "https://www.hurriyet.com.tr"
add_source "Daily Sabah" "https://www.dailysabah.com/rssFeed/main" "TR" "https://www.dailysabah.com"
add_source "Irish Times" "https://www.irishtimes.com/cmlink/news-1.1319192" "IE" "https://www.irishtimes.com"
add_source "Politiken" "https://politiken.dk/rss/senestenyt.rss" "DK" "https://politiken.dk"
add_source "Helsingin Sanomat" "https://www.hs.fi/rss/tuoreimmat.xml" "FI" "https://www.hs.fi"

# ── Asia ────────────────────────────────────────────────────────────
log "── Asia ──"
add_source "Times of India" "https://timesofindia.indiatimes.com/rssfeedstopstories.cms" "IN" "https://timesofindia.indiatimes.com"
add_source "Hindustan Times" "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml" "IN" "https://www.hindustantimes.com"
add_source "NDTV" "https://feeds.feedburner.com/ndtvnews-top-stories" "IN" "https://www.ndtv.com"
add_source "The Hindu" "https://www.thehindu.com/news/international/feeder/default.rss" "IN" "https://www.thehindu.com"
add_source "Indian Express" "https://indianexpress.com/feed/" "IN" "https://indianexpress.com"
add_source "Dawn" "https://www.dawn.com/feeds/home" "PK" "https://www.dawn.com"
add_source "The News" "https://www.thenews.com.pk/rss/home" "PK" "https://www.thenews.com.pk"
add_source "Daily Star" "https://www.thedailystar.net/frontpage/rss.xml" "BD" "https://www.thedailystar.net"
add_source "South China Morning Post" "https://www.scmp.com/rss/91/feed" "HK" "https://www.scmp.com"
add_source "Straits Times" "https://www.straitstimes.com/news/world/rss.xml" "SG" "https://www.straitstimes.com"
add_source "Jakarta Post" "https://www.thejakartapost.com/feed" "ID" "https://www.thejakartapost.com"
add_source "Bangkok Post" "https://www.bangkokpost.com/rss/data/topstories.xml" "TH" "https://www.bangkokpost.com"
add_source "Vietnam News" "https://vietnamnews.vn/rss/world.rss" "VN" "https://vietnamnews.vn"
add_source "Philippine Inquirer" "https://newsinfo.inquirer.net/feed" "PH" "https://newsinfo.inquirer.net"
add_source "Malaysiakini" "https://www.malaysiakini.com/en/rss" "MY" "https://www.malaysiakini.com"
add_source "Yonhap" "https://en.yna.co.kr/RSS/news.xml" "KR" "https://en.yna.co.kr"
add_source "Japan Times" "https://www.japantimes.co.jp/feed/" "JP" "https://www.japantimes.co.jp"
add_source "Mainichi" "https://mainichi.jp/rss/etc/eng_mainichi.xml" "JP" "https://mainichi.jp"
add_source "Xinhua" "http://www.news.cn/english/rss/worldrss.xml" "CN" "https://www.news.cn"
add_source "China Daily" "https://www.chinadaily.com.cn/rss/world_rss.xml" "CN" "https://www.chinadaily.com.cn"
add_source "Taipei Times" "https://www.taipeitimes.com/RSS/News" "TW" "https://www.taipeitimes.com"
add_source "Korea Herald" "http://www.koreaherald.com/rss/020200000000.xml" "KR" "http://www.koreaherald.com"

# ── Middle East ─────────────────────────────────────────────────────
log "── Middle East ──"
add_source "Gulf News" "https://gulfnews.com/rss" "AE" "https://gulfnews.com"
add_source "Khaleej Times" "https://www.khaleejtimes.com/rss" "AE" "https://www.khaleejtimes.com"
add_source "Arab News" "https://www.arabnews.com/rss.xml" "SA" "https://www.arabnews.com"
add_source "Haaretz" "https://www.haaretz.com/cmlink/1.628752" "IL" "https://www.haaretz.com"
add_source "Times of Israel" "https://www.timesofisrael.com/feed/" "IL" "https://www.timesofisrael.com"
add_source "Daily Star Lebanon" "https://www.dailystar.com.lb/RSS.aspx" "LB" "https://www.dailystar.com.lb"
add_source "Tehran Times" "https://www.tehrantimes.com/rss" "IR" "https://www.tehrantimes.com"
add_source "Jordan Times" "https://www.jordantimes.com/rss" "JO" "https://www.jordantimes.com"

# ── Africa ──────────────────────────────────────────────────────────
log "── Africa ──"
add_source "Daily Nation Kenya" "https://www.nation.co.ke/kenya/rss" "KE" "https://www.nation.co.ke"
add_source "The East African" "https://www.theeastafrican.co.ke/tea/rss" "KE" "https://www.theeastafrican.co.ke"
add_source "Punch Nigeria" "https://punchng.com/feed/" "NG" "https://punchng.com"
add_source "Vanguard Nigeria" "https://www.vanguardngr.com/feed/" "NG" "https://www.vanguardngr.com"
add_source "Mail & Guardian" "https://mg.co.za/feed/" "ZA" "https://mg.co.za"
add_source "Daily Maverick" "https://www.dailymaverick.co.za/feed/" "ZA" "https://www.dailymaverick.co.za"
add_source "Egypt Independent" "https://egyptindependent.com/feed/" "EG" "https://egyptindependent.com"
add_source "The Citizen Tanzania" "https://www.thecitizen.co.tz/rss" "TZ" "https://www.thecitizen.co.tz"
add_source "Monitor Uganda" "https://www.monitor.co.ug/uganda/rss" "UG" "https://www.monitor.co.ug"
add_source "Ghana Web" "https://www.ghanaweb.com/GhanaHomePage/rss/" "GH" "https://www.ghanaweb.com"
add_source "Ethiopian Monitor" "https://www.ethiopianmonitor.com/feed/" "ET" "https://www.ethiopianmonitor.com"
add_source "Morocco World News" "https://www.moroccoworldnews.com/feed" "MA" "https://www.moroccoworldnews.com"
add_source "Tunisia Live" "https://www.tunisialive.net/feed/" "TN" "https://www.tunisialive.net"

# ── South America ───────────────────────────────────────────────────
log "── South America ──"
add_source "Folha de S.Paulo" "https://feeds.folha.uol.com.br/mundo/rss091.xml" "BR" "https://www.folha.uol.com.br"
add_source "Globo" "https://oglobo.globo.com/rss.xml" "BR" "https://oglobo.globo.com"
add_source "Clarin" "https://www.clarin.com/rss/mundo/" "AR" "https://www.clarin.com"
add_source "La Nacion" "https://www.lanacion.com.ar/arc/outboundfeeds/rss/" "AR" "https://www.lanacion.com.ar"
add_source "El Mercurio" "https://www.emol.com/rss/" "CL" "https://www.emol.com"
add_source "El Tiempo" "https://www.eltiempo.com/rss.xml" "CO" "https://www.eltiempo.com"
add_source "El Comercio" "https://www.elcomercio.com/feed/" "PE" "https://www.elcomercio.com"
add_source "El Nacional" "https://www.elnacional.com/feed/" "VE" "https://www.elnacional.com"
add_source "El Observador" "https://www.elobservador.com.uy/rss" "UY" "https://www.elobservador.com.uy"

# ── Oceania ─────────────────────────────────────────────────────────
log "── Oceania ──"
add_source "Sydney Morning Herald" "https://www.smh.com.au/rss/feed.xml" "AU" "https://www.smh.com.au"
add_source "The Australian" "https://www.theaustralian.com.au/rss" "AU" "https://www.theaustralian.com.au"
add_source "ABC Australia" "https://www.abc.net.au/news/feed/2942460/rss.xml" "AU" "https://www.abc.net.au/news"
add_source "New Zealand Herald" "https://www.nzherald.co.nz/arc/outboundfeeds/rss/" "NZ" "https://www.nzherald.co.nz"
add_source "Stuff NZ" "https://www.stuff.co.nz/rss" "NZ" "https://www.stuff.co.nz"

# ── Central Asia & Caucasus ─────────────────────────────────────────
log "── Central Asia ──"
add_source "Eurasianet" "https://eurasianet.org/rss.xml" "KZ" "https://eurasianet.org"
add_source "Trend AZ" "https://en.trend.az/rss" "AZ" "https://en.trend.az"
add_source "Armenpress" "https://armenpress.am/en/rss/" "AM" "https://armenpress.am"

# ── Caribbean ───────────────────────────────────────────────────────
log "── Caribbean ──"
add_source "Jamaica Gleaner" "https://jamaica-gleaner.com/feed" "JM" "https://jamaica-gleaner.com"
add_source "Trinidad Guardian" "https://guardian.co.tt/rss" "TT" "https://guardian.co.tt"
add_source "Barbados Today" "https://barbadostoday.bb/feed/" "BB" "https://barbadostoday.bb"

# ── Summary ─────────────────────────────────────────────────────────
log ""
log "═══ SUMMARY ═══"

TOTAL=$(runpsql "SELECT COUNT(*) FROM news_sources WHERE active=TRUE;" 2>/dev/null || echo "?")
COUNTRIES=$(runpsql "SELECT COUNT(DISTINCT country) FROM news_sources WHERE active=TRUE;" 2>/dev/null || echo "?")
log "Active sources: $TOTAL"
log "Countries covered: $COUNTRIES"

log ""
log "Top 20 countries by source count:"
runpsql "
  SELECT country, COUNT(*) as cnt 
  FROM news_sources 
  WHERE active=TRUE 
  GROUP BY country 
  ORDER BY cnt DESC 
  LIMIT 20;
" 2>/dev/null | while IFS='|' read -r country cnt; do
  log "  $country: $cnt sources"
done

log ""
log "═══ DONE ═══"
