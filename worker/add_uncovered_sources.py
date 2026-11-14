"""Add news sources for countries with large cities but zero coverage.

This script adds RSS feeds for priority countries that currently have no active
news sources. It uses known reliable sources for each country.

Usage:
    python -m worker.add_uncovered_sources --dry-run  # preview what would be added
    python -m worker.add_uncovered_sources           # actually add sources
"""
from __future__ import annotations

import argparse
import logging
from .db import connect
from . import explore_region

log = logging.getLogger("xyzo.add_uncovered_sources")

# Known RSS feeds for priority uncovered countries
# Format: country_code -> list of {name, feed_url, language}
KNOWN_COUNTRY_FEEDS: dict[str, list[dict]] = {
    "CZ": [
        {"name": "ČTK Czech News Agency", "feed_url": "https://www.ctzn.cz/rss", "language": "cs"},
        {"name": "Deník.cz", "feed_url": "https://www.denik.cz/rss.html", "language": "cs"},
        {"name": "iDNES.cz", "feed_url": "https://www.idnes.cz/rss.aspx?c=zpravodaj", "language": "cs"},
        {"name": "Novinky.cz", "feed_url": "https://www.novinky.cz/rss", "language": "cs"},
        {"name": "Seznam Zprávy", "feed_url": "https://www.seznam.cz/rss/zpravy", "language": "cs"},
        {"name": "Echo24.cz", "feed_url": "https://echo24.cz/rss", "language": "cs"},
        {"name": "ParlamentniListy.cz", "feed_url": "https://www.parlamentnilisty.cz/rss.aspx", "language": "cs"},
    ],
    "BE": [
        {"name": "RTBF Info", "feed_url": "https://www.rtbf.be/info/rss", "language": "fr"},
        {"name": "Le Soir", "feed_url": "https://www.lesoir.be/rss", "language": "fr"},
        {"name": "De Standaard", "feed_url": "https://www.standaard.be/rss", "language": "nl"},
        {"name": "Het Laatste Nieuws", "feed_url": "https://www.hln.be/rss", "language": "nl"},
        {"name": "Flanders News", "feed_url": "https://www.flandersnews.be/rss", "language": "en"},
        {"name": "Brussels Times", "feed_url": "https://www.brusselstimes.com/rss", "language": "en"},
        {"name": "The Brussels Times", "feed_url": "https://www.brusselstimes.com/feed", "language": "en"},
    ],
    "RO": [
        {"name": "Digi24", "feed_url": "https://www.digi24.ro/rss", "language": "ro"},
        {"name": "HotNews.ro", "feed_url": "https://www.hotnews.ro/rss", "language": "ro"},
        {"name": "Mediafax", "feed_url": "https://www.mediafax.ro/rss", "language": "ro"},
        {"name": "Adevărul", "feed_url": "https://adevarul.ro/rss", "language": "ro"},
        {"name": "Gândul", "feed_url": "https://www.gandul.info/rss", "language": "ro"},
        {"name": "Romania TV", "feed_url": "https://romaniatv.net/rss", "language": "ro"},
        {"name": "PRO TV", "feed_url": "https://stirileprotv.ro/rss", "language": "ro"},
    ],
    "PT": [
        {"name": "Público", "feed_url": "https://www.publico.pt/rss", "language": "pt"},
        {"name": "Jornal de Notícias", "feed_url": "https://www.jn.pt/rss", "language": "pt"},
        {"name": "Correio da Manhã", "feed_url": "https://www.cmjornal.pt/rss", "language": "pt"},
        {"name": "SIC Notícias", "feed_url": "https://sicnoticias.pt/rss", "language": "pt"},
        {"name": "TSF", "feed_url": "https://www.tsf.pt/rss", "language": "pt"},
        {"name": "Observador", "feed_url": "https://observador.pt/rss", "language": "pt"},
        {"name": "Diário de Notícias", "feed_url": "https://www.dn.pt/rss", "language": "pt"},
    ],
    "DO": [
        {"name": "Listín Diario", "feed_url": "https://www.listindiario.com/rss", "language": "es"},
        {"name": "El Día", "feed_url": "https://www.eldia.com.do/rss", "language": "es"},
        {"name": "Diario Libre", "feed_url": "https://www.diariolibre.com/rss", "language": "es"},
        {"name": "Acento", "feed_url": "https://acentodiario.com/rss", "language": "es"},
        {"name": "El Nacional", "feed_url": "https://elnacional.com.do/rss", "language": "es"},
        {"name": "Hoy", "feed_url": "https://www.hoy.com.do/rss", "language": "es"},
    ],
    "BO": [
        {"name": "Los Tiempos", "feed_url": "https://www.lostiempos.com/rss", "language": "es"},
        {"name": "El Deber", "feed_url": "https://www.eldeber.com.bo/rss", "language": "es"},
        {"name": "La Razón", "feed_url": "https://www.la-razon.com/rss", "language": "es"},
        {"name": "Bolivia TV", "feed_url": "https://www.bo.tv/rss", "language": "es"},
        {"name": "Erbol", "feed_url": "https://www.erbol.com.bo/rss", "language": "es"},
    ],
    "GT": [
        {"name": "Prensa Libre", "feed_url": "https://www.prensalibre.com/rss/", "language": "es"},
        {"name": "Siglo XXI", "feed_url": "https://siglo21.net/rss", "language": "es"},
        {"name": "La Hora", "feed_url": "https://lahora.gt/rss", "language": "es"},
        {"name": "Emisoras Unidas", "feed_url": "https://emisorasunidas.com/feed/", "language": "es"},
        {"name": "Cerro Grande News", "feed_url": "https://www.cerrograndenews.com/feed/", "language": "es"},
    ],
    "HN": [
        {"name": "La Prensa Honduras", "feed_url": "https://www.laprensa.hn/rss/", "language": "es"},
        {"name": "El Heraldo", "feed_url": "https://www.elheraldo.hn/rss", "language": "es"},
        {"name": "Diez HN", "feed_url": "https://www.diez.hn/rss", "language": "es"},
        {"name": "Proceso Digital", "feed_url": "https://proceso.hn/rss", "language": "es"},
        {"name": "Tiempo Honduras", "feed_url": "https://www.tiempo.hn/rss", "language": "es"},
    ],
    "PY": [
        {"name": "ABC Color", "feed_url": "https://www.abc.com.py/rss", "language": "es"},
        {"name": "La Nación Paraguay", "feed_url": "https://www.lanacion.com.py/rss", "language": "es"},
        {"name": "Ultima Hora", "feed_url": "https://www.ultimahora.com/rss", "language": "es"},
        {"name": "Paraguay.com", "feed_url": "https://www.paraguay.com/rss", "language": "es"},
        {"name": "IP Paraguay", "feed_url": "https://www.ip.gov.py/rss", "language": "es"},
    ],
    "NI": [
        {"name": "Confidencial", "feed_url": "https://confidencial.com.ni/feed/", "language": "es"},
        {"name": "La Prensa Nicaragua", "feed_url": "https://www.laprensa.com.ni/rss/", "language": "es"},
        {"name": "El Nuevo Diario", "feed_url": "https://www.elnuevodiario.com.ni/rss/", "language": "es"},
        {"name": "Canal 4 Nicaragua", "feed_url": "https://www.canal4.com.ni/feed/", "language": "es"},
        {"name": "Radio La Primerísima", "feed_url": "https://www.laprimerisima.com/feed/", "language": "es"},
    ],
    "CU": [
        # Cuba has limited RSS availability, state media often doesn't have public RSS
        {"name": "Cubadebate", "feed_url": "http://www.cubadebate.com/feed/", "language": "es"},
        {"name": "Granma", "feed_url": "http://www.granma.cu/rss/fe.xml", "language": "es"},
        {"name": "Cuban News Agency", "feed_url": "http://www.ain.cu/feed", "language": "es"},
    ],
    "KP": [
        # North Korea has no public RSS feeds - skip
    ],
    "SY": [
        # Syria has limited RSS availability
        {"name": "SANA", "feed_url": "http://sana.sy/?lang=en", "language": "en"},
    ],
    "CI": [
        {"name": "Fraternité Matin", "feed_url": "https://www.fratmat.ci/rss", "language": "fr"},
        {"name": "Le Pays", "feed_url": "https://www.lepays.com.rss", "language": "fr"},
        {"name": "L'Inter", "feed_url": "https://www.linter.cd/rss", "language": "fr"},
        {"name": "Abidjan.net", "feed_url": "https://news.abidjan.net/rss", "language": "fr"},
    ],
    "EC": [
        {"name": "El Comercio", "feed_url": "https://www.elcomercio.com/rss", "language": "es"},
        {"name": "El Universo", "feed_url": "https://www.eluniverso.com/rss", "language": "es"},
        {"name": "Teleamazonas", "feed_url": "https://www.teleamazonas.com/feed/", "language": "es"},
        {"name": "Ecuador TV", "feed_url": "https://www.ecuador.tv/feed/", "language": "es"},
        {"name": "Primicias", "feed_url": "https://www.primicias.ec/rss", "language": "es"},
    ],
    "BY": [
        {"name": "Belarusian News", "feed_url": "https://belarusiannews.com/rss", "language": "en"},
        {"name": "Telegraf.by", "feed_url": "https://telegraf.by/rss", "language": "ru"},
        {"name": "Onliner.by", "feed_url": "https://people.onliner.by/feed", "language": "ru"},
        # Belteleradio has no public RSS
    ],
    "JO": [
        {"name": "Jordan Times", "feed_url": "https://www.jordantimes.com/rss", "language": "en"},
        {"name": "Al Mamlaka", "feed_url": "https://www.almamlaka.com/rss", "language": "en"},
        {"name": "Roya News", "feed_url": "https://en.royanews.com/rss", "language": "en"},
        {"name": "Ammann News", "feed_url": "https://www.ammann.net/rss", "language": "en"},
        {"name": "Alrai", "feed_url": "https://www.alraimedia.com/rss", "language": "ar"},
    ],
    "SE": [
        # Sweden might already have sources but let's add more
        {"name": "SVT News", "feed_url": "https://www.svt.se/rss", "language": "sv"},
        {"name": "DN.se", "feed_url": "https://www.dn.se/rss", "language": "sv"},
        {"name": "Aftonbladet", "feed_url": "https://www.aftonbladet.se/rss", "language": "sv"},
        {"name": "Expressen", "feed_url": "https://www.expressen.se/rss", "language": "sv"},
    ],
    "NO": [
        # Norway has limited RSS feeds
        {"name": "NRK News", "feed_url": "https://www.nrk.no/toppsaker.rss", "language": "no"},
        {"name": "VG", "feed_url": "https://www.vg.no/rss", "language": "no"},
        {"name": "Aftenposten", "feed_url": "https://www.aftenposten.no/rss", "language": "no"},
        {"name": "Dagbladet", "feed_url": "https://www.dagbladet.no/rss", "language": "no"},
    ],
    "CH": [
        # Switzerland
        {"name": "Swissinfo", "feed_url": "https://www.swissinfo.ch/rss", "language": "en"},
        {"name": "SRF News", "feed_url": "https://www.srf.ch/news/rss", "language": "de"},
        {"name": "Le Matin", "feed_url": "https://www.lematin.ch/rss", "language": "fr"},
        {"name": "Corriere del Ticino", "feed_url": "https://www.cdt.ch/rss", "language": "it"},
    ],
    "AT": [
        # Austria
        {"name": "Der Standard", "feed_url": "https://www.derstandard.at/rss", "language": "de"},
        {"name": "Kronen Zeitung", "feed_url": "https://www.krone.at/rss", "language": "de"},
        {"name": "ORF News", "feed_url": "https://apa.at/feed", "language": "de"},
        {"name": "Die Presse", "feed_url": "https://www.diepresse.com/rss", "language": "de"},
    ],
    "DK": [
        # Denmark
        {"name": "DR News", "feed_url": "https://www.dr.dk/rss", "language": "da"},
        {"name": "Politiken", "feed_url": "https://politiken.dk/rss", "language": "da"},
        {"name": "Jyllands-Posten", "feed_url": "https://jyllands-posten.dk/rss", "language": "da"},
        {"name": "Information", "feed_url": "https://www.information.dk/rss", "language": "da"},
    ],
    "FI": [
        # Finland
        {"name": "YLE News", "feed_url": "https://feeds.yle.fi/uutiset/rss", "language": "fi"},
        {"name": "Helsingin Sanomat", "feed_url": "https://www.hs.fi/rss", "language": "fi"},
        {"name": "Iltalehti", "feed_url": "https://www.iltalehti.fi/rss", "language": "fi"},
        {"name": "Savon Sanomat", "feed_url": "https://www.savonsanomat.fi/rss", "language": "fi"},
    ],
    "IE": [
        # Ireland
        {"name": "RTÉ News", "feed_url": "https://www.rte.ie/rss/news.xml", "language": "en"},
        {"name": "The Irish Times", "feed_url": "https://www.irishtimes.com/rss", "language": "en"},
        {"name": "The Journal", "feed_url": "https://www.thejournal.ie/feed", "language": "en"},
        {"name": "Irish Examiner", "feed_url": "https://www.irishexaminer.com/rss", "language": "en"},
    ],
    "GR": [
        # Greece
        {"name": "ERT News", "feed_url": "https://www.ert.gr/feed/", "language": "el"},
        {"name": "To Vima", "feed_url": "https://www.tovima.gr/rss", "language": "el"},
        {"name": "Kathimerini", "feed_url": "https://www.kathimerini.gr/rss", "language": "el"},
        {"name": "Naftemporiki", "feed_url": "https://www.naftemporiki.gr/rss", "language": "el"},
    ],
    "CL": [
        # Chile
        {"name": "El Mercurio", "feed_url": "https://www.elmercurio.com/rss", "language": "es"},
        {"name": "La Tercera", "feed_url": "https://www.latercera.com/rss", "language": "es"},
        {"name": "BioBioChile", "feed_url": "https://www.biobiochile.cl/rss", "language": "es"},
        {"name": "Cooperativa", "feed_url": "https://www.cooperativa.cl/rss", "language": "es"},
    ],
    "PE": [
        # Peru
        {"name": "El Comercio", "feed_url": "https://elcomercio.pe/rss", "language": "es"},
        {"name": "Perú21", "feed_url": "https://peru21.pe/rss", "language": "es"},
        {"name": "La República", "feed_url": "https://www.larepublica.pe/rss", "language": "es"},
        {"name": "Gestión", "feed_url": "https://gestion.pe/rss", "language": "es"},
    ],
    "VE": [
        # Venezuela
        {"name": "El Nacional", "feed_url": "https://www.el-nacional.com/rss", "language": "es"},
        {"name": "Tal Cual", "feed_url": "https://talcualvirtual.com/rss", "language": "es"},
        {"name": "RunRun.es", "feed_url": "https://runrun.es/rss", "language": "es"},
        {"name": "Efecto Cocuyo", "feed_url": "https://efectococuyo.com/feed/", "language": "es"},
    ],
    "CO": [
        # Colombia
        {"name": "El Tiempo", "feed_url": "https://www.eltiempo.com/rss", "language": "es"},
        {"name": "El Espectador", "feed_url": "https://www.elespectador.com/rss", "language": "es"},
        {"name": "Publimetro", "feed_url": "https://www.publimetro.co/rss", "language": "es"},
        {"name": "RCN Radio", "feed_url": "https://www.rcnradio.com/rss", "language": "es"},
    ],
    "HU": [
        # Hungary
        {"name": "Magyar Hírlap", "feed_url": "https://www.magyarhirlap.hu/rss", "language": "hu"},
        {"name": "Népszava", "feed_url": "https://nepszava.hu/rss", "language": "hu"},
        {"name": "Index.hu", "feed_url": "https://index.hu/rss", "language": "hu"},
        {"name": "Hvg.hu", "feed_url": "https://hvg.hu/rss", "language": "hu"},
    ],
    "BG": [
        # Bulgaria
        {"name": "Dnevnik", "feed_url": "https://www.dnevnik.bg/rss", "language": "bg"},
        {"name": "Capital", "feed_url": "https://www.capital.bg/rss", "language": "bg"},
        {"name": "Mediapool", "feed_url": "https://www.mediapool.bg/rss", "language": "bg"},
        {"name": "Offnews", "feed_url": "https://offnews.bg/rss", "language": "bg"},
    ],
    "RS": [
        # Serbia
        {"name": "Blic", "feed_url": "https://www.blic.rs/rss", "language": "sr"},
        {"name": "Politika", "feed_url": "https://www.politika.rs/rss", "language": "sr"},
        {"name": "Danas", "feed_url": "https://www.danas.rs/rss", "language": "sr"},
        {"name": "N1 Belgrade", "feed_url": "https://n1info.com/rss/", "language": "sr"},
    ],
    "UA": [
        # Ukraine - might already have some
        {"name": "Ukrainska Pravda", "feed_url": "https://www.pravda.com.ua/rss", "language": "uk"},
        {"name": "UNIAN", "feed_url": "https://www.unian.net/rss", "language": "ru"},
        {"name": "Korrespondent", "feed_url": "https://korrespondent.net/rss/", "language": "ru"},
        {"name": "Segodnya", "feed_url": "https://www.segodnya.ua/rss", "language": "ru"},
    ],
    "KZ": [
        # Kazakhstan
        {"name": "Khabar", "feed_url": "https://www.khabar.kz/rss", "language": "kk"},
        {"name": "Tengrinews", "feed_url": "https://tengrinews.kz/rss/", "language": "ru"},
        {"name": "Kazinform", "feed_url": "https://www.inform.kz/rss", "language": "en"},
    ],
    "UZ": [
        # Uzbekistan - limited
        {"name": "Uzbekistan Daily", "feed_url": "https://uza.uz/en/rss", "language": "en"},
        {"name": "Kun.uz", "feed_url": "https://kun.uz/rss", "language": "uz"},
    ],
    "TH": [
        # Thailand - might already have some
        {"name": "Bangkok Post", "feed_url": "https://www.bangkokpost.com/rss", "language": "en"},
        {"name": "The Nation", "feed_url": "https://www.nationthailand.com/feed", "language": "en"},
        {"name": "Thai PBS", "feed_url": "https://news.thaipbs.or.th/rss", "language": "th"},
        {"name": "Prachathai", "feed_url": "https://prachatai.com/rss", "language": "th"},
    ],
    "MM": [
        # Myanmar
        {"name": "Myanmar Times", "feed_url": "https://www.mmtimes.com/rss", "language": "en"},
        {"name": "Eleven Media", "feed_url": "https://elevenmedia.com.mm/rss", "language": "en"},
        {"name": "DVB", "feed_url": "https://www.dvb.no/rss", "language": "en"},
    ],
    "KH": [
        # Cambodia
        {"name": "Phnom Penh Post", "feed_url": "https://www.phnompenhpost.com/rss", "language": "en"},
        {"name": "Cambodia Daily", "feed_url": "https://www.cambodiadaily.com/rss", "language": "en"},
        {"name": "Khmer Times", "feed_url": "https://www.khmertimeskh.com/feed", "language": "en"},
    ],
    "NP": [
        # Nepal
        {"name": "Kathmandu Post", "feed_url": "https://tkpo.st/rss", "language": "en"},
        {"name": "Online Khabar", "feed_url": "https://www.onlinekhabar.com/rss", "language": "en"},
        {"name": "Naya Patra", "feed_url": "https://www.nayapatra.com.np/rss", "language": "en"},
    ],
    "BD": [
        # Bangladesh - might already have some
        {"name": "The Daily Star", "feed_url": "https://www.thedailystar.net/rss", "language": "en"},
        {"name": "Bangladesh Daily", "feed_url": "https://bdnewsportal.com/rss", "language": "en"},
        {"name": " prothom alo", "feed_url": "https://www.prothomalo.com/rss", "language": "bn"},
    ],
    "LK": [
        # Sri Lanka
        {"name": "Ada Derana", "feed_url": "https://www.adaderana.lk/rss", "language": "en"},
        {"name": "Colombo Gazette", "feed_url": "https://colombogazette.com/rss", "language": "en"},
        {"name": "Sri Lanka Mirror", "feed_url": "https://www.srilankamirror.com/rss", "language": "en"},
    ],
    "PK": [
        # Pakistan - might already have some
        {"name": "Dawn", "feed_url": "https://www.dawn.com/rss", "language": "en"},
        {"name": "The News International", "feed_url": "https://www.thenews.com.pk/rss", "language": "en"},
        {"name": "GEO TV", "feed_url": "https://www.geo.tv/rss", "language": "en"},
        {"name": "ARY News", "feed_url": "https://www.arynews.tv/rss", "language": "en"},
    ],
    "MA": [
        # Morocco - might already have some
        {"name": "Hespress", "feed_url": "https://www.hespress.com/rss", "language": "ar"},
        {"name": "Le360", "feed_url": "https://fr.le360.ma/rss", "language": "fr"},
        {"name": "Medi1SAT", "feed_url": "https://www.medi1sat.com/rss", "language": "ar"},
    ],
    "DZ": [
        # Algeria
        {"name": "Ennahar", "feed_url": "https://www.ennahar.com/rss", "language": "ar"},
        {"name": "El Khabar", "feed_url": "https://www.elkhabar.com/rss", "language": "ar"},
        {"name": "TSA", "feed_url": "https://www.tsa-algerie.com/rss", "language": "fr"},
    ],
    "TN": [
        # Tunisia
        {"name": "Al Chourouk", "feed_url": "https://www.alchourouk.com/rss", "language": "ar"},
        {"name": "Nawaat", "feed_url": "https://nawaat.org/feed/", "language": "fr"},
        {"name": "Tunisia Daily News", "feed_url": "https://www.tunisie-focus.com/rss", "language": "fr"},
    ],
    "EG": [
        # Egypt - might already have some
        {"name": "Ahram Online", "feed_url": "https://english.ahram.org.eg/rss", "language": "en"},
        {"name": "Egyptian Streets", "feed_url": "https://egyptianstreets.com/feed/", "language": "en"},
        {"name": "Mada", "feed_url": "https://www.madamasr.com/rss", "language": "ar"},
    ],
    "NG": [
        # Nigeria - might already have some
        {"name": "Punch", "feed_url": "https://punchng.com/rss/", "language": "en"},
        {"name": "The Guardian", "feed_url": "https://guardian.ng/rss", "language": "en"},
        {"name": "Vanguard", "feed_url": "https://www.vanguardngr.com/rss", "language": "en"},
        {"name": "Daily Post", "feed_url": "https://dailypost.ng/feed/", "language": "en"},
    ],
    "KE": [
        # Kenya - might already have some
        {"name": "Standard Media", "feed_url": "https://www.standardmedia.co.ke/rss", "language": "en"},
        {"name": "Nation Africa", "feed_url": "https://nation.africa/rss", "language": "en"},
        {"name": "The Star Kenya", "feed_url": "https://www.the-star.co.ke/rss", "language": "en"},
    ],
    "GH": [
        # Ghana
        {"name": "GhanaWeb", "feed_url": "https://www.ghanaweb.com/rss", "language": "en"},
        {"name": "Graphic Online", "feed_url": "https://www.graphic.com.gh/rss", "language": "en"},
        {"name": "Citi News", "feed_url": "https://citinewsroom.com/feed/", "language": "en"},
    ],
    "TZ": [
        # Tanzania
        {"name": "The Citizen", "feed_url": "https://www.thecitizen.co.tz/rss", "language": "en"},
        {"name": "Daily News", "feed_url": "https://dailynews TZ.com/rss", "language": "en"},
        {"name": "Mwananchi", "feed_url": "https://www.mwananchi.co.tz/rss", "language": "en"},
    ],
    "UG": [
        # Uganda
        {"name": "Daily Monitor", "feed_url": "https://www.monitor.co.ug/rss", "language": "en"},
        {"name": "Red Pepper", "feed_url": "https://www.redpepper.co.ug/feed/", "language": "en"},
        {"name": "Nilepost", "feed_url": "https://nilepost.co.ug/rss", "language": "en"},
    ],
    "ET": [
        # Ethiopia
        {"name": "Addis Standard", "feed_url": "https://addisstandard.com/feed/", "language": "en"},
        {"name": "Ethiopian News Agency", "feed_url": "https://www.ena.et/rss", "language": "en"},
        {"name": "The Reporter Ethiopia", "feed_url": "https://www.thereportereth.com/feed/", "language": "en"},
    ],
    "ZA": [
        # South Africa - might already have some
        {"name": "News24", "feed_url": "https://www.news24.com/rss", "language": "en"},
        {"name": "Mail & Guardian", "feed_url": "https://mg.co.za/rss", "language": "en"},
        {"name": "EWN", "feed_url": "https://ewn.co.za/rss", "language": "en"},
        {"name": "IOL", "feed_url": "https://www.iol.co.za/rss", "language": "en"},
    ],
    "SD": [
        # Sudan
        {"name": "Al Sharq", "feed_url": "https://al-sharq.com/rss", "language": "ar"},
        {"name": "Sudan Tribune", "feed_url": "https://sudantribune.com/rss", "language": "en"},
        {"name": "Dabanga", "feed_url": "https://www.dabangasudan.org/rss", "language": "en"},
    ],
    "IR": [
        # Iran - limited RSS availability
        {"name": "IRNA", "feed_url": "https://en.irna.ir/rss", "language": "en"},
        {"name": "Tehran Times", "feed_url": "https://www.tehrantimes.com/rss", "language": "en"},
        {"name": "Press TV", "feed_url": "https://www.presstv.com/rss", "language": "en"},
    ],
    "IQ": [
        # Iraq
        {"name": "Iraqi News", "feed_url": "https://www.iraqinews.com/feed/", "language": "en"},
        {"name": "Al-Monitor", "feed_url": "https://www.al-monitor.com/rss", "language": "en"},
        {"name": "RUDAW", "feed_url": "https://www.rudaw.net/rss", "language": "en"},
    ],
    "AF": [
        # Afghanistan
        {"name": "Tolo News", "feed_url": "https://www.tolonews.com/rss", "language": "en"},
        {"name": "Pajhwok", "feed_url": "https://www.pajhwok.com/rss", "language": "en"},
        {"name": "Ayeneh", "feed_url": "https://www.ayene.org/rss", "language": "en"},
    ],
}


def get_region_for_country(cc: str) -> str:
    """Map country code to region."""
    regions = {
        "CZ": "europe", "BE": "europe", "RO": "europe", "PT": "europe",
        "SE": "europe", "NO": "europe", "CH": "europe", "AT": "europe",
        "DK": "europe", "FI": "europe", "IE": "europe", "GR": "europe",
        "HU": "europe", "BG": "europe", "RS": "europe", "UA": "europe",
        "BY": "europe", "SK": "europe", "SI": "europe", "HR": "europe",
        "BA": "europe", "ME": "europe", "MK": "europe", "AL": "europe",
        "DO": "central-america", "BO": "south-america", "GT": "central-america",
        "HN": "central-america", "PY": "south-america", "NI": "central-america",
        "CU": "caribbean", "EC": "south-america", "CL": "south-america",
        "PE": "south-america", "VE": "south-america", "CO": "south-america",
        "JO": "middle-east", "SY": "middle-east", "CI": "west-africa",
        "TH": "southeast-asia", "MM": "southeast-asia", "KH": "southeast-asia",
        "NP": "south-asia", "LK": "south-asia",
    }
    return regions.get(cc, "global")


def add_sources_for_country(cc: str, dry_run: bool = False) -> dict:
    """Add known RSS feeds for a country."""
    feeds = KNOWN_COUNTRY_FEEDS.get(cc, [])
    if not feeds:
        return {"country": cc, "found": 0, "added": 0, "feeds": []}

    results = {"country": cc, "found": len(feeds), "added": 0, "feeds": []}

    if dry_run:
        for feed in feeds:
            results["feeds"].append({**feed, "status": "would_add"})
        return results

    with connect() as conn, conn.cursor() as cur:
        # Get existing feed URLs to avoid duplicates
        cur.execute("SELECT feed_url FROM news_sources")
        existing_urls = {r["feed_url"] for r in cur.fetchall()}

        for feed in feeds:
            if feed["feed_url"] in existing_urls:
                results["feeds"].append({**feed, "status": "duplicate"})
                continue

            try:
                cur.execute("""
                    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
                    VALUES (%s, %s, %s, %s, %s, 'rss', TRUE)
                    ON CONFLICT (feed_url) DO NOTHING
                    RETURNING id
                """, (
                    feed["name"],
                    feed["feed_url"],
                    cc,
                    feed.get("language", "en"),
                    get_region_for_country(cc),
                ))
                row = cur.fetchone()
                if row:
                    results["added"] += 1
                    results["feeds"].append({**feed, "status": "added", "id": row["id"]})
                    log.info("Added source: %s (%s)", feed["name"], cc)
                else:
                    results["feeds"].append({**feed, "status": "duplicate"})
            except Exception as e:
                log.debug("Failed to add %s: %s", feed["feed_url"], e)
                results["feeds"].append({**feed, "status": "error", "error": str(e)})

        conn.commit()

    return results


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="Add news sources for uncovered countries")
    p.add_argument("--dry-run", action="store_true", help="Preview what would be added")
    p.add_argument("--country", type=str, help="Add sources for specific country code only")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    countries = [args.country] if args.country else list(KNOWN_COUNTRY_FEEDS.keys())

    total_found = 0
    total_added = 0

    for cc in countries:
        result = add_sources_for_country(cc, dry_run=args.dry_run)
        total_found += result["found"]
        total_added += result["added"]
        status = "Would add" if args.dry_run else "Added"
        print(f"{cc}: {status} {result['added']}/{result['found']} feeds")
        for feed in result["feeds"]:
            if feed["status"] in ("added", "would_add"):
                print(f"  + {feed['name']}: {feed['feed_url']}")
            elif feed["status"] == "duplicate":
                print(f"  = {feed['name']}: {feed['feed_url']} (exists)")
            elif feed["status"] == "error":
                print(f"  ! {feed['name']}: {feed['error']}")

    print(f"\nTotal: {total_added}/{total_found} sources {('would be ' if args.dry_run else '')}added")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
