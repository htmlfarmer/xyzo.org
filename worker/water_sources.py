"""Water source discovery, verification and registration.

WHY THIS EXISTS
---------------
Water is a global news category on XYZO: drinking-water contamination,
droughts, river disputes, floods, groundwater depletion, desalination,
ocean pollution. The candidate list that started this was 200 names —
and the list itself said what it was: "candidate public sources, not
200 individually verified live feeds."

That distinction is the whole job. A source added to `news_sources`
is fetched every 15 minutes by a worker that will never stop trying.
A dead feed is not a no-op: it is a source that logs an error, burns a
lease, retries, and eventually shows up in the high-error report that
`docs/source_blocking_patterns.json` exists to explain. The site
already carries 1,330 sources with more than 100 errors each.

So nothing is added on the strength of a name. Every candidate goes
through:

  1. DISCOVERY  — the homepage is fetched and its
     `<link rel="alternate" type="application/rss+xml">` is followed;
     if there is none, the conventional paths are tried.
  2. VALIDATION — the feed is fetched and parsed. A feed with no
     entries is not a feed, it is a placeholder.
  3. ROBOTS     — the feed path must be allowed by the host's
     robots.txt for the tier the fetcher would use. A feed the
     robots file disallows is not added.

Only what survives all three is registered.

THE COUNTRY RULE
----------------
`news_sources.country` must be a real country the source publishes
from — ISO-2. A global or regional organisation carries country =
NULL and a region, because "ME" is Montenegro, not the Middle East,
and an "EU" country code is not a country at all. That mistake is
what put 41,000 stories on Podgorica (see
docs/SESSION_NOTES_2026-10-22-BAMAKO_PILEUP.md).

Usage
-----
    python3 -m worker.water_sources --report        # verify, print, add nothing
    python3 -m worker.water_sources --apply          # verify and register
    python3 -m worker.water_sources --apply --only water-news
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

import httpx
import feedparser

from .db import connect
from .fetch import user_agent_for
from .robots import RobotsCache, tier_for_url

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("xyzo.water_sources")

FEEDS_FILE = Path(__file__).parent / "feeds.json"
REGISTRY_FILE = Path(__file__).parent / "water_sources_data.json"

USER_AGENT = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"

# The longest the PROBE will wait for a host's declared Crawl-delay. The
# real fetcher enforces the full delay at fetch time; a one-off
# verification probe only has to stay polite.
MAX_PROBE_DELAY_S = 2.0

# The canonical region vocabulary (worker/build_global_sources.py).
REGIONS = {
    "americas", "central-africa", "central-asia", "east-africa", "east-asia",
    "eurasia", "europe", "middle-east", "north-africa", "oceania",
    "south-america", "south-asia", "southeast-asia", "southern-africa",
    "west-africa", "global",
}

# The conventional feed paths, tried in order when the homepage does
# not advertise one.
COMMON_PATHS = [
    "/feed", "/rss", "/feed/", "/rss/", "/feed.xml", "/rss.xml",
    "/index.xml", "/atom.xml", "/feeds/posts/default",
    "/news/feed", "/news/rss", "/blog/rss", "/blog/feed",
    "/rss/index.xml", "/rss/all.xml", "/feed.xml/", "/news/feed.xml",
    "/en/rss", "/en/feed", "/latest/rss", "/news/rss.xml",
]


@dataclass
class Candidate:
    """One source the list proposes, before anything has been checked."""
    name: str
    urls: list[str] = field(default_factory=list)
    country: Optional[str] = None      # ISO-2, or None for a global body
    region: str = "global"
    language: str = "en"
    subcategory: str = "water-news"     # one of the eight water topics
    note: str = ""


# ── The candidate list ────────────────────────────────────────────────
# Mirrors the proposed list, with the homepages. Where a body's feed
# lives on a newsroom rather than the institutional site, both are
# listed: discovery takes the first that yields a valid feed.

CANDIDATES: list[Candidate] = [
    # ── 1. Specialist water journalism ───────────────────────────────
    Candidate("Circle of Blue", ["https://www.circleofblue.org/feed/"], "US", "americas", "en", "drinking-water"),
    Candidate("Water Desk", ["https://waterdesk.org/feed/"], "US", "americas", "en", "water-news"),
    Candidate("Water Education Foundation", ["https://www.watereducation.org/feed/"], "US", "americas", "en", "water-management"),
    Candidate("Aquafornia", ["https://aquafornia.com/feed/"], "US", "americas", "en", "water-news"),
    Candidate("Western Water", ["https://www.water.ca.gov/Home/News/RSS"], "US", "americas", "en", "rivers-lakes"),
    Candidate("Water Online", ["https://www.wateronline.com/feed/"], "US", "global", "en", "water-infrastructure"),
    Candidate("WaterWorld", ["https://www.waterworldonline.com/rss.xml"], "US", "global", "en", "water-infrastructure"),
    Candidate("Water & Wastes Digest", ["https://www.waterandwastesdigest.com/rss.xml"], "US", "americas", "en", "water-infrastructure"),
    Candidate("Water Finance & Management", ["https://www.waterfinance.com/feed/"], "US", "americas", "en", "water-infrastructure"),
    Candidate("H2O Global News", ["https://www.h2oglobalnews.com/feed/"], "GB", "global", "en", "water-infrastructure"),
    Candidate("Aquatech Online", ["https://www.aquatechonline.com/rss.xml"], "US", "global", "en", "water-infrastructure"),
    Candidate("Global Water Intelligence", ["https://www.globalwaterintel.com/feed/"], "GB", "global", "en", "water-infrastructure"),
    Candidate("The Water Report", ["https://thewaterreport.com/feed/"], "US", "americas", "en", "water-management"),
    Candidate("Water Currents", ["https://www.nationalgeographic.com/feed/rss/current.xml"], "US", "global", "en", "rivers-lakes"),
    Candidate("High Country News", ["https://www.hcn.org/rss.xml"], "US", "americas", "en", "rivers-lakes"),
    Candidate("Aspen Journalism", ["https://www.aspenjournalism.org/feed/"], "US", "americas", "en", "water-news"),
    Candidate("Maven's Notebook", ["https://www.mavensnotebook.com/feed/"], "US", "americas", "en", "water-management"),
    Candidate("Fresh Water News", ["https://www.freshwaternews.com/feed/"], "US", "americas", "en", "water-management"),
    Candidate("Inkstain", ["https://www.inkstain.com/feed/"], "US", "americas", "en", "water-management"),
    Candidate("American Rivers", ["https://www.americanrivers.org/feed/"], "US", "americas", "en", "rivers-lakes"),
    Candidate("River Network", ["https://www.rivernetwork.org/feed/"], "US", "americas", "en", "rivers-lakes"),
    Candidate("The Revelator", ["https://www.therevelator.net/feed/"], "US", "global", "en", "pollution"),
    Candidate("Ensia", ["https://ensia.org/feed/"], "US", "global", "en", "water-science"),
    Candidate("The Narwhal", ["https://thenarwhal.ca/feed/"], "CA", "americas", "en", "water-science"),
    Candidate("The Guardian Environment", ["https://www.theguardian.com/environment/water/rss"], "GB", "global", "en", "water-news"),
    Candidate("The Conversation", ["https://theconversation.com/global/environment/articles.atom"], "GB", "global", "en", "water-science"),
    Candidate("ProPublica", ["https://www.propublica.org/feeds/propublica/environment"], "US", "americas", "en", "water-news"),

    # ── 2. UN and international water organisations ───────────────────
    Candidate("UN-Water", ["https://www.unwater.org/rss.xml"], None, "global", "en", "water-management"),
    Candidate("UNESCO IHP", ["https://www.unesco.org/en/ihp/rss.xml"], None, "global", "en", "water-science"),
    Candidate("UNESCO World Water Assessment Programme", ["https://www.unesco.org/wwap/en/rss.xml"], None, "global", "en", "water-management"),
    Candidate("UNEP", ["https://www.unep.org/rss.xml"], None, "global", "en", "water-science"),
    Candidate("WHO", ["https://www.who.int/rss-feeds/news-english.xml"], None, "global", "en", "drinking-water"),
    Candidate("UNICEF WASH", ["https://www.unicef.org/press-releases/rss.xml"], None, "global", "en", "drinking-water"),
    Candidate("World Bank Water", ["https://www.worldbank.org/en/news/rss"], None, "global", "en", "water-infrastructure"),
    Candidate("Asian Development Bank Water", ["https://www.adb.org/rss/news-releases"], "PH", "southeast-asia", "en", "water-infrastructure"),
    Candidate("African Development Bank Water", ["https://www.afdb.org/en/rss/news-and-events"], "CI", "west-africa", "en", "water-infrastructure"),
    Candidate("IDB Water and Sanitation", ["https://www.iadb.org/en/rss/news.xml"], "US", "americas", "en", "water-infrastructure"),
    Candidate("European Environment Agency", ["https://www.eea.europa.eu/rss/news_en.xml"], None, "europe", "en", "water-science"),
    Candidate("Global Water Partnership", ["https://www.gwp.org/en/rss.xml"], None, "global", "en", "water-management"),
    Candidate("International Water Association", ["https://iwa-network.org/feed/"], None, "global", "en", "water-infrastructure"),
    Candidate("IWMI", ["https://www.iwmi.cgiar.org/feed/"], "LK", "south-asia", "en", "water-agriculture"),
    Candidate("ICIMOD", ["https://www.icimod.org/feed/"], "NP", "south-asia", "en", "water-science"),
    Candidate("IGRAC", ["https://www.igrac.net/rss.xml"], None, "global", "en", "groundwater"),
    Candidate("INBO", ["https://www.inbo.fr/rss.xml"], None, "global", "en", "rivers-lakes"),
    Candidate("ICPDR", ["https://www.icpdr.org/rss/news"], None, "europe", "en", "rivers-lakes"),
    Candidate("ICPR", ["https://www.iksr.org/rss.xml"], None, "europe", "en", "rivers-lakes"),
    Candidate("Mekong River Commission", ["https://www.mrcmekong.org/rss.xml"], None, "southeast-asia", "en", "rivers-lakes"),
    Candidate("Nile Basin Initiative", ["https://nilebasin.org/feed/"], None, "east-africa", "en", "rivers-lakes"),
    Candidate("Lake Chad Basin Commission", ["https://www.lcbc.org/feed/"], None, "central-africa", "en", "rivers-lakes"),
    Candidate("Ramsar Convention on Wetlands", ["https://www.ramsar.org/rss.xml"], "CH", "global", "en", "water-science"),
    Candidate("European Commission Environment", ["https://environment.ec.europa.eu/rss_en"], None, "europe", "en", "water-management"),

    # ── 3. United States agencies and research ───────────────────────
    Candidate("USGS Water Resources", ["https://www.usgs.gov/programs/water-resources/rss.xml"], "US", "americas", "en", "rivers-lakes"),
    Candidate("USGS Water Data", ["https://waterdata.usgs.gov/rss.xml"], "US", "americas", "en", "rivers-lakes"),
    Candidate("US EPA Water", ["https://www.epa.gov/newsreleases/rss.xml"], "US", "americas", "en", "drinking-water"),
    Candidate("NOAA Ocean Service", ["https://oceanservice.noaa.gov/rss.xml"], "US", "americas", "en", "oceans-coasts"),
    Candidate("NOAA National Weather Service", ["https://www.weather.gov/rss/nws_rss.php"], "US", "americas", "en", "floods-drought"),
    Candidate("NOAA NIDIS", ["https://www.drought.gov/rss.xml"], "US", "americas", "en", "floods-drought"),
    Candidate("NOAA NCEI", ["https://www.ncei.noaa.gov/rss.xml"], "US", "global", "en", "water-science"),
    Candidate("NOAA Fisheries", ["https://www.fisheries.noaa.gov/rss.xml"], "US", "americas", "en", "oceans-coasts"),
    Candidate("US Army Corps of Engineers", ["https://www.usace.army.mil/rss/"], "US", "americas", "en", "water-infrastructure"),
    Candidate("Bureau of Reclamation", ["https://www.usbr.gov/rss/news.xml"], "US", "americas", "en", "water-management"),
    Candidate("NOAA National Water Center", ["https://water.noaa.gov/rss.xml"], "US", "americas", "en", "floods-drought"),
    Candidate("BOEM", ["https://www.boem.gov/rss-feed.xml"], "US", "americas", "en", "oceans-coasts"),
    Candidate("BOEM Environmental Studies", ["https://www.boem.gov/boem-newsroom/rss.xml"], "US", "americas", "en", "oceans-coasts"),
    Candidate("US Fish and Wildlife Service", ["https://www.fws.gov/rss/news-releases.xml"], "US", "americas", "en", "water-science"),
    Candidate("National Park Service", ["https://www.nps.gov/aboutus/news/feed.htm"], "US", "americas", "en", "water-science"),
    Candidate("USDA Agricultural Research Service", ["https://www.ars.usda.gov/rss/rssnews.xml"], "US", "americas", "en", "water-agriculture"),
    Candidate("USDA NRCS", ["https://www.nrcs.usda.gov/rss/news-releases"], "US", "americas", "en", "water-agriculture"),
    Candidate("DOE Water Power Technologies Office", ["https://www.energy.gov/eere/water/rss.xml"], "US", "americas", "en", "water-infrastructure"),
    Candidate("NSF", ["https://www.nsf.gov/rss/rss_news.xml"], "US", "global", "en", "water-science"),
    Candidate("Woods Hole Oceanographic Institution", ["https://www.whoi.edu/rss/"], "US", "americas", "en", "oceans-coasts"),
    Candidate("Scripps Institution of Oceanography", ["https://scripps.ucsd.edu/rss.xml"], "US", "americas", "en", "oceans-coasts"),
    Candidate("MBARI", ["https://www.mbari.org/feed/"], "US", "americas", "en", "oceans-coasts"),
    Candidate("Great Lakes Commission", ["https://www.greatlakes.net/rss.xml"], "US", "americas", "en", "rivers-lakes"),
    Candidate("Great Lakes Observing System", ["https://glos.ugoo.edu/rss.xml"], "US", "americas", "en", "rivers-lakes"),
    Candidate("Great Lakes Echo", ["https://greatlakesecho.com/feed/"], "US", "americas", "en", "rivers-lakes"),
    Candidate("Pacific Institute", ["https://www.pacinst.org/feed/"], "US", "global", "en", "water-management"),
    Candidate("Water Research Foundation", ["https://www.waterrf.org/feed/"], "US", "global", "en", "drinking-water"),
    Candidate("Water Environment Federation", ["https://www.wef.org/rss.xml"], "US", "global", "en", "water-infrastructure"),
    Candidate("AWWA", ["https://www.awwa.org/rss.xml"], "US", "global", "en", "drinking-water"),
    Candidate("ASDWA", ["https://www.asdwa.org/feed/"], "US", "americas", "en", "drinking-water"),

    # ── 4. Canada, Mexico, Central America ──────────────────────────
    Candidate("Environment and Climate Change Canada", ["https://www.canada.ca/en/environment-climate-change/rss.xml"], "CA", "americas", "en", "water-science"),
    Candidate("Water Survey of Canada", ["https://wateroffice.ca/rss.xml"], "CA", "americas", "en", "rivers-lakes"),
    Candidate("Fisheries and Oceans Canada", ["https://www.dfo-mpo.gc.ca/rss.xml"], "CA", "americas", "en", "oceans-coasts"),
    Candidate("Canada Water Agency", ["https://www.canada.ca/en/water-canada/rss.xml"], "CA", "americas", "en", "water-management"),
    Candidate("International Joint Commission", ["https://www.ijc.org/rss.xml"], "US", "americas", "en", "rivers-lakes"),
    Candidate("Living Lakes Canada", ["https://livinglakes.ca/feed/"], "CA", "americas", "en", "rivers-lakes"),
    Candidate("Freshwater Future", ["https://freshwaterfuture.org/feed/"], "CA", "americas", "en", "rivers-lakes"),
    Candidate("Council of Canadians Water Campaign", ["https://www.councilofcanadians.org/feed/"], "CA", "americas", "en", "drinking-water"),
    Candidate("Water Rangers", ["https://waterrangers.ca/feed/"], "CA", "americas", "en", "water-science"),
    Candidate("Canadian Water Network", ["https://www.canadianwaternetwork.org/feed/"], "CA", "americas", "en", "water-management"),
    Candidate("CONAGUA Mexico", ["https://www.gob.mx/conagua/rss"], "MX", "americas", "es", "water-management"),
    Candidate("IMTA Mexico", ["https://www.imta.gob.mx/rss.xml"], "MX", "americas", "es", "water-science"),
    Candidate("INECC Mexico", ["https://www.inecc.gob.mx/rss.xml"], "MX", "americas", "es", "water-science"),
    Candidate("UNAM", ["https://www.unam.mx/rss.xml"], "MX", "americas", "es", "water-science"),
    Candidate("AyA Costa Rica", ["https://www.aya.go.cr/rss.xml"], "CR", "americas", "es", "drinking-water"),
    Candidate("MiAmbiente Panama", ["https://miambiente.gob.pa/rss.xml"], "PA", "americas", "es", "rivers-lakes"),
    Candidate("Panama Canal Authority", ["https://www.pancanal.com/en/rss/"], "PA", "americas", "en", "water-infrastructure"),
    Candidate("ANA Peru", ["https://www.gob.pe/ana/rss.xml"], "PE", "south-america", "es", "water-management"),
    Candidate("Guatemala Government Portal", ["https://www.gob.gt/rss.xml"], "GT", "americas", "es", "water-management"),
    Candidate("CCCCC", ["https://caribbeanclimatechange.org/feed/"], None, "americas", "en", "floods-drought"),

    # ── 5. South America ─────────────────────────────────────────────
    Candidate("ANA Brasil", ["https://www.gov.br/ana/pt-br/rss"], "BR", "south-america", "pt", "water-management"),
    Candidate("INPE Brazil", ["https://www.gov.br/inpe/pt-br/rss"], "BR", "south-america", "pt", "water-science"),
    Candidate("SGB Brazil", ["https://www.sgb.gov.br/rss.xml"], "BR", "south-america", "pt", "groundwater"),
    Candidate("IBAMA", ["https://www.gov.br/ibama/pt-br/rss"], "BR", "south-america", "pt", "pollution"),
    Candidate("INUMET Uruguay", ["https://www.inumet.gub.uy/rss.xml"], "UY", "south-america", "es", "floods-drought"),
    Candidate("INA Argentina", ["https://www.ina.gob.ar/rss.xml"], "AR", "south-america", "es", "rivers-lakes"),
    Candidate("ERAS Argentina", ["https://www.eras.gob.ar/rss.xml"], "AR", "south-america", "es", "water-management"),
    Candidate("DGA Chile", ["https://www.dga.gob.cl/rss.xml"], "CL", "south-america", "es", "rivers-lakes"),
    Candidate("Dirección Meteorológica de Chile", ["https://www.meteochile.gob.cl/rss.xml"], "CL", "south-america", "es", "floods-drought"),
    Candidate("IDEAM Colombia", ["https://www.ideam.gov.co/rss.xml"], "CO", "south-america", "es", "floods-drought"),
    Candidate("MinAmbiente Colombia", ["https://www.minambiente.gov.co/rss.xml"], "CO", "south-america", "es", "water-management"),
    Candidate("Ecuador Government Portal", ["https://www.gob.ec/rss.xml"], "EC", "south-america", "es", "water-management"),
    Candidate("SENAMHI Peru", ["https://www.senamhi.gob.pe/rss.xml"], "PE", "south-america", "es", "floods-drought"),
    Candidate("SENAMHI Bolivia", ["https://www.senamhi.gob.bo/rss.xml"], "BO", "south-america", "es", "floods-drought"),
    Candidate("Guyana Hydrometeorological Service", ["https://www.hids.gov.gy/rss.xml"], "GY", "south-america", "en", "floods-drought"),
    Candidate("Suriname Meteorological Service", ["https://www.meteobio.com/feed/"], "SR", "south-america", "nl", "floods-drought"),
    Candidate("INPA Brazil", ["https://www.gov.br/inpa/pt-br/rss"], "BR", "south-america", "pt", "water-science"),
    Candidate("ACTO Amazon", ["https://otca.org/feed/"], None, "south-america", "es", "rivers-lakes"),
    Candidate("Amazon Waters Initiative", ["https://www.wawaters.org/feed/"], None, "south-america", "en", "rivers-lakes"),
    Candidate("Humboldt Institute", ["https://www.humboldt.org.co/rss.xml"], "CO", "south-america", "es", "water-science"),

    # ── 6. Europe ────────────────────────────────────────────────────
    Candidate("UK Environment Agency", ["https://www.gov.uk/government/organisations/environment-agency.atom"], "GB", "europe", "en", "pollution"),
    Candidate("UK Centre for Ecology & Hydrology", ["https://www.ceh.ac.uk/rss.xml"], "GB", "europe", "en", "water-science"),
    Candidate("The Rivers Trust", ["https://www.riverstrust.org.uk/feed/"], "GB", "europe", "en", "rivers-lakes"),
    Candidate("SEPA", ["https://www.sepa.org.uk/rss.xml"], "GB", "europe", "en", "water-science"),
    Candidate("Natural Resources Wales", ["https://naturalresources.wales/rss.xml"], "GB", "europe", "en", "water-science"),
    Candidate("UK Met Office", ["https://www.metoffice.gov.uk/rss/index.xml"], "GB", "global", "en", "floods-drought"),
    Candidate("NVE Norway", ["https://www.nve.no/rss.xml"], "NO", "europe", "no", "rivers-lakes"),
    Candidate("SMHI Sweden", ["https://www.smhi.se/feed/"], "SE", "europe", "sv", "rivers-lakes"),
    Candidate("Syke Finland", ["https://www.syke.fi/en/rss.xml"], "FI", "europe", "en", "water-science"),
    Candidate("Danish EPA", ["https://mst.dk/rss.xml"], "DK", "europe", "da", "pollution"),
    Candidate("Delta Programme", ["https://english.deltaprogramma.nl/rss.xml"], "NL", "europe", "en", "floods-drought"),
    Candidate("Deltares", ["https://www.deltares.nl/en/rss.xml"], "NL", "europe", "en", "water-science"),
    Candidate("Dutch Water Authorities", ["https://www.unievanwaterbedrijven.nl/feed/"], "NL", "europe", "nl", "water-management"),
    Candidate("BfG Germany", ["https://www.bafg.de/rss.xml"], "DE", "europe", "de", "rivers-lakes"),
    Candidate("Umweltbundesamt Germany", ["https://www.umweltbundesamt.de/rss.xml"], "DE", "europe", "de", "pollution"),
    Candidate("OFB France", ["https://www.ofb.fr/rss.xml"], "FR", "europe", "fr", "water-science"),
    Candidate("BRGM France", ["https://www.brgm.fr/rss.xml"], "FR", "europe", "fr", "groundwater"),
    Candidate("ISPRA Italy", ["https://www.ispra.gov.it/rss.xml"], "IT", "europe", "it", "water-science"),
    Candidate("MITECO Spain", ["https://www.miteco.gob.es/rss.xml"], "ES", "europe", "es", "water-management"),
    Candidate("APA Portugal", ["https://www.apambiente.pt/rss.xml"], "PT", "europe", "pt", "water-management"),
    Candidate("FOEN Switzerland", ["https://www.bafu.admin.ch/rss.xml"], "CH", "europe", "de", "water-science"),
    Candidate("Umweltbundesamt Austria", ["https://www.umweltbundesamt.at/rss.xml"], "AT", "europe", "de", "water-science"),
    Candidate("IMGW-PIB Poland", ["https://www.imgw.pl/rss.xml"], "PL", "europe", "pl", "floods-drought"),
    Candidate("European Drought Observatory", ["https://edo.jrc.ec.europa.eu/rss.xml"], None, "europe", "en", "floods-drought"),
    Candidate("EFAS", ["https://www.efas.eu/rss.xml"], None, "europe", "en", "floods-drought"),

    # ── 7. Africa ────────────────────────────────────────────────────
    Candidate("South Africa DWS", ["https://www.dws.gov.za/rss.xml"], "ZA", "southern-africa", "en", "drinking-water"),
    Candidate("South Africa WRC", ["https://www.wrc.org.za/feed/"], "ZA", "southern-africa", "en", "water-science"),
    Candidate("South African Weather Service", ["https://www.weathersa.co.za/rss.xml"], "ZA", "southern-africa", "en", "floods-drought"),
    Candidate("Kenya Water Resources Authority", ["https://www.wra.go.ke/rss.xml"], "KE", "east-africa", "en", "water-management"),
    Candidate("Kenya Meteorological Department", ["https://meteo.go.ke/rss.xml"], "KE", "east-africa", "en", "floods-drought"),
    Candidate("Tanzania Ministry of Water", ["https://www.majiwa.go.tz/rss.xml"], "TZ", "east-africa", "en", "water-management"),
    Candidate("Uganda Ministry of Water and Environment", ["https://www.mwe.go.ug/rss.xml"], "UG", "east-africa", "en", "water-management"),
    Candidate("Ethiopia Ministry of Water and Energy", ["https://www.moe.gov.et/rss.xml"], "ET", "east-africa", "en", "water-infrastructure"),
    Candidate("Niger Basin Authority", ["https://www.abao.org/rss.xml"], None, "west-africa", "en", "rivers-lakes"),
    Candidate("Volta Basin Authority", ["https://www.volta-au.org/feed/"], None, "west-africa", "en", "rivers-lakes"),
    Candidate("Lake Victoria Basin Commission", ["https://www.lvbcom.org/feed/"], None, "east-africa", "en", "rivers-lakes"),
    Candidate("AMCOW", ["https://www.amcow.org/feed/"], "ZM", "southern-africa", "en", "water-management"),
    Candidate("Sahara and Sahel Observatory", ["https://www.ossobservatory.org/rss.xml"], "BF", "west-africa", "fr", "groundwater"),

    # ── 8. Asia and the Middle East ──────────────────────────────────
    Candidate("India Central Water Commission", ["https://cwc.gov.in/rss.xml"], "IN", "south-asia", "en", "floods-drought"),
    Candidate("India Central Ground Water Board", ["https://cgwb.gov.in/rss.xml"], "IN", "south-asia", "en", "groundwater"),
    Candidate("India Ministry of Jal Shakti", ["https://jalshakti-ddws.gov.in/rss.xml"], "IN", "south-asia", "en", "water-management"),
    Candidate("Namami Gange", ["https://namamigange.gov.in/rss.xml"], "IN", "south-asia", "en", "pollution"),
    Candidate("Bangladesh Water Development Board", ["https://www.bwdb.gov.bd/rss.xml"], "BD", "south-asia", "en", "floods-drought"),
    Candidate("Bangladesh WARPO", ["https://warpo.gov.bd/rss.xml"], "BD", "south-asia", "en", "water-management"),
    Candidate("BCAS Bangladesh", ["https://www.bcas.org/feed/"], "BD", "south-asia", "en", "water-science"),
    Candidate("Pakistan PCRWR", ["https://pcrwr.gov.pk/rss.xml"], "PK", "south-asia", "en", "groundwater"),
    Candidate("Pakistan IRSA", ["https://irsa.gov.pk/rss.xml"], "PK", "south-asia", "en", "rivers-lakes"),
    Candidate("DHM Nepal", ["https://dhm.gov.np/rss.xml"], "NP", "south-asia", "en", "floods-drought"),
    Candidate("Japan Water Agency", ["https://www.mlit.go.jp/sekiguchi/english/rss.xml"], "JP", "east-asia", "en", "water-infrastructure"),
    Candidate("Japan Meteorological Agency", ["https://www.jma.go.jp/rss/"], "JP", "east-asia", "ja", "floods-drought"),
    Candidate("K-eco Korea", ["https://www.keco.or.kr/en/rss.xml"], "KR", "east-asia", "en", "pollution"),
    Candidate("K-water Korea", ["https://www.kwater.or.kr/eng/rss.xml"], "KR", "east-asia", "en", "water-infrastructure"),
    Candidate("ONWR Thailand", ["https://www.onwr.go.th/rss.xml"], "TH", "southeast-asia", "en", "water-management"),
    Candidate("Indonesia Ministry of Public Works", ["https://pu.go.id/rss.xml"], "ID", "southeast-asia", "id", "water-infrastructure"),
    Candidate("Philippines DENR", ["https://denr.gov.rss.xml"], "PH", "southeast-asia", "en", "water-science"),
    Candidate("PUB Singapore", ["https://www.pub.gov.sg/rss.xml"], "SG", "southeast-asia", "en", "drinking-water"),

    # ── 9. Oceania ────────────────────────────────────────────────────
    Candidate("Australian Bureau of Meteorology", ["https://www.bom.gov.au/rss/"], "AU", "oceania", "en", "floods-drought"),
    Candidate("Australian DCCEEW", ["https://www.dcceew.gov.au/rss.xml"], "AU", "oceania", "en", "water-management"),
    Candidate("Murray-Darling Basin Authority", ["https://www.mdba.gov.au/rss.xml"], "AU", "oceania", "en", "rivers-lakes"),
    Candidate("WSAA", ["https://www.water.org.au/feed/"], "AU", "oceania", "en", "water-infrastructure"),
    Candidate("Water New Zealand", ["https://www.waternz.org.nz/feed/"], "NZ", "oceania", "en", "water-infrastructure"),
    Candidate("New Zealand Ministry for the Environment", ["https://www.mfe.govt.nz/rss.xml"], "NZ", "oceania", "en", "water-management"),
    Candidate("NIWA", ["https://www.niwa.co.nz/feed/"], "NZ", "oceania", "en", "water-science"),
    Candidate("Pacific Community", ["https://www.spc.int/rss.xml"], None, "oceania", "en", "drinking-water"),
    Candidate("Pacific Islands Forum", ["https://www.forumsec.org/feed/"], None, "oceania", "en", "floods-drought"),
    Candidate("SPREP", ["https://www.sprep.org/rss.xml"], None, "oceania", "en", "oceans-coasts"),

    # ── 10. Global water-quality, ocean and scientific data ──────────
    Candidate("GEMStat", ["https://www.gemstat.org/rss.xml"], None, "global", "en", "water-science"),
    Candidate("Global Runoff Data Centre", ["https://www.grdc.bafg.de/rss.xml"], "DE", "global", "en", "water-science"),
    Candidate("World Meteorological Organization", ["https://wmo.int/rss.xml"], None, "global", "en", "floods-drought"),
    Candidate("Copernicus Marine Service", ["https://marine.copernicus.eu/rss.xml"], None, "global", "en", "oceans-coasts"),
    Candidate("NASA Earth Observatory", ["https://earthobservatory.nasa.gov/feeds/earth-observatory.rss"], "US", "global", "en", "water-science"),
]


# ── Feed discovery ───────────────────────────────────────────────────

_LINK_RE = re.compile(
    r"<link[^>]+>", re.I | re.S,
)

_HREF_FEED_RE = re.compile(
    r'href\s*=\s*["\']([^"\']*(?:rss|feed|atom|\.xml)[^"\']*)["\']',
    re.I,
)


def _alternate_links(html: str, base: str) -> list[str]:
    """Every feed-ish link on a page, in order.

    Two passes, because publishers use two conventions and only one of
    them is standard:
      1. `<link rel="alternate" type="application/rss+xml">` — the
         proper declaration, which most CMSes emit.
      2. a plain `href` that looks like a feed. This is what
         Drupal, Joomla and hand-built government sites do, and it is
         where BOEM's feed lives.
    """
    out: list[str] = []
    for tag in _LINK_RE.findall(html or ""):
        low = tag.lower()
        if "alternate" not in low:
            continue
        if "rss" not in low and "atom" not in low and "xml" not in low:
            continue
        m = re.search(r'href\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if not m:
            continue
        href = urljoin(base, m.group(1).strip())
        if href.startswith("http"):
            out.append(href)

    for m in _HREF_FEED_RE.finditer(html or ""):
        href = urljoin(base, m.group(1).strip())
        if href.startswith("http"):
            out.append(href)

    seen: set[str] = set()
    deduped: list[str] = []
    for u in out:
        if u not in seen:
            seen.add(u)
            deduped.append(u)
    return deduped


def feed_candidates(client: httpx.Client, url: str) -> list[str]:
    """The feed URLs to try for one candidate URL.

    The URL ITSELF comes first: a candidate list that names
    ".../environment/water/rss" means that feed, and the discovery
    that follows it must not demote it to the site's generic
    ".../rss". Then the feeds the page declares, then the
    conventional paths.
    """
    out: list[str] = [url]

    base = url
    try:
        resp = client.get(url, follow_redirects=True,
                          headers={"User-Agent": user_agent_for(url)})
        if resp.status_code < 400:
            ctype = resp.headers.get("content-type", "").lower()
            # An XML document is already a feed; there is nothing to
            # discover inside it.
            if "xml" not in ctype and "rss" not in ctype and "atom" not in ctype:
                out.extend(_alternate_links(resp.text, str(resp.url)))
            base = str(resp.url)
            m = re.search(r"<base[^>]+href\s*=\s*['\"]([^'\"]+)['\"]", resp.text, re.I)
            if m:
                base = urljoin(base, m.group(1).strip())
    except Exception:
        pass

    parsed = urlparse(base)
    if parsed.scheme and parsed.netloc:
        origin = f"{parsed.scheme}://{parsed.netloc}"
        for path in COMMON_PATHS:
            out.append(origin + path)

    seen: set[str] = set()
    deduped: list[str] = []
    for u in out:
        if u not in seen:
            seen.add(u)
            deduped.append(u)
    return deduped


def validate_feed(client: httpx.Client, url: str, min_entries: int = 3,
                  headers: Optional[dict] = None) -> dict:
    """Fetch and parse a feed.

    A feed with no entries is not a feed, it is a placeholder. A feed
    with ONE entry is a placeholder that has been updated once — the
    fetcher will poll it every fifteen minutes for a story that is
    already weeks old, so the minimum is three.
    """
    try:
        resp = client.get(url, follow_redirects=True, headers=headers or None)
        if resp.status_code >= 400:
            return {"valid": False, "error": f"HTTP {resp.status_code}"}
        ctype = resp.headers.get("content-type", "")
        parsed = feedparser.parse(resp.content)
        entries = parsed.entries or []
        if not entries:
            # An HTML page served at a feed path is a 404 in disguise.
            if parsed.bozo and not parsed.version:
                return {"valid": False, "error": "not a feed (HTML)"}
            return {"valid": False, "error": "no entries"}
        if len(entries) < min_entries:
            return {"valid": False, "error": f"only {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}"}
        title = ""
        try:
            title = parsed.feed.get("title", "") or ""
        except Exception:
            title = ""
        return {
            "valid": True,
            "title": title[:200],
            "entry_count": len(entries),
            "error": None,
            "content_type": ctype,
        }
    except Exception as e:
        return {"valid": False, "error": str(e)[:200]}


# ── The run ──────────────────────────────────────────────────────────

# Sections a publisher's feed usually hangs off. The homepage often
# declares no feed at all; the NEWS section does.
SECTION_PATHS = [
    "", "/news", "/news/", "/news-releases", "/newsroom", "/newsroom/news-release",
    "/press-releases", "/press", "/media", "/media-centre", "/media-center",
    "/blog", "/updates", "/announcements", "/bulletins", "/articles",
    "/en/news", "/en/news-and-events", "/news-and-events", "/latest-news",
    "/publications", "/stories", "/features",
]


def hunt(client: httpx.Client, candidate: Candidate, max_pages: int = 6,
         max_feeds: int = 4) -> dict:
    """Deep discovery: look on the candidate's own sections for a feed.

    The homepage often declares no feed at all — the NEWS section does.
    This walks a handful of plausible sections, collects every feed-ish
    link it finds, and validates them.
    """
    robots = RobotsCache()
    out = {"name": candidate.name, "feed_url": None, "title": None,
           "entry_count": 0, "checked": [], "reason": ""}
    tried_feeds: set[str] = set()

    for base in candidate.urls:
        parsed = urlparse(base)
        if not parsed.scheme or not parsed.netloc:
            continue
        origin = f"{parsed.scheme}://{parsed.netloc}"
        # The candidate's own path first, then the conventional sections.
        paths = [parsed.path or "/"] + SECTION_PATHS

        pages = 0
        for path in paths:
            if pages >= max_pages:
                break
            page_url = origin + path
            if page_url in out["checked"]:
                continue
            out["checked"].append(page_url)
            pages += 1
            try:
                resp = client.get(page_url, follow_redirects=True,
                                  headers={"User-Agent": user_agent_for(page_url)})
            except Exception:
                continue
            if resp.status_code >= 400:
                continue
            ctype = resp.headers.get("content-type", "").lower()
            if "xml" in ctype or "rss" in ctype or "atom" in ctype:
                links = [str(resp.url)]
            else:
                links = _alternate_links(resp.text, str(resp.url))

            for feed_url in links:
                if feed_url in tried_feeds or len(tried_feeds) >= max_feeds:
                    continue
                tried_feeds.add(feed_url)
                try:
                    verdict = robots.is_allowed(feed_url, tier_for_url(feed_url))
                    if not bool(getattr(verdict, "allowed", verdict)):
                        continue
                except Exception:
                    pass
                v = validate_feed(client, feed_url, min_entries=3,
                                  headers={"User-Agent": user_agent_for(feed_url)})
                if v.get("valid"):
                    out.update({
                        "feed_url": feed_url,
                        "title": v.get("title"),
                        "entry_count": v.get("entry_count", 0),
                    })
                    return out
    out["reason"] = "no feed found on any section"
    return out


def verify(
    candidates: list[Candidate],
    max_feed_tries: int = 8,
    delay: float = 0.4,
    min_entries: int = 3,
) -> list[dict]:
    """Verify every candidate. Returns one result row per candidate."""
    robots = RobotsCache()
    results: list[dict] = []
    # A feed that answers for four different agencies is a portal feed,
    # not four agency feeds. Registering it four times would put the
    # same general news on the map four times under four names.
    seen_feeds: dict[str, str] = {}
    # The last time each host was touched, so the probe is as polite as
    # the fetcher will be.
    last_hit: dict[str, float] = {}

    with httpx.Client(timeout=20, follow_redirects=True) as client:
        for c in candidates:
            row = {
                "name": c.name,
                "candidate_urls": c.urls,
                "country": c.country,
                "region": c.region,
                "language": c.language,
                "subcategory": c.subcategory,
                "feed_url": None,
                "title": None,
                "entry_count": 0,
                "ok": False,
                "reason": "",
            }

            tried = 0
            found = False
            for candidate_url in c.urls:
                for feed_url in feed_candidates(client, candidate_url):
                    if tried >= max_feed_tries:
                        break
                    tried += 1

                    # The UA the FETCHER will use, not one of our own:
                    # a feed this probe can read but the fetcher cannot
                    # is still a broken source. .gov and .edu hosts get
                    # the polite UA (worker/fetch.py:user_agent_for).
                    ua = user_agent_for(feed_url)
                    headers = {"User-Agent": ua}

                    host = (urlparse(feed_url).hostname or "").lower()
                    gap = time.time() - last_hit.get(host, 0.0)
                    if gap < delay:
                        time.sleep(delay - gap)

                    # Robots first: never fetch a path the host forbids.
                    tier = tier_for_url(feed_url)
                    try:
                        verdict = robots.is_allowed(feed_url, tier)
                        allowed = bool(getattr(verdict, "allowed", verdict))
                        crawl_delay = getattr(verdict, "crawl_delay_s", None)
                    except Exception:
                        allowed, crawl_delay = True, None
                    if not allowed:
                        row["reason"] = f"robots disallows {feed_url}"
                        continue

                    v = validate_feed(client, feed_url, min_entries=min_entries,
                               headers=headers)
                    last_hit[host] = time.time()
                    if v.get("valid"):
                        prior = seen_feeds.get(feed_url)
                        if prior and prior != c.name:
                            row.update({
                                "feed_url": feed_url,
                                "title": v.get("title"),
                                "entry_count": v.get("entry_count", 0),
                                "ok": False,
                                "reason": f"same feed as {prior}",
                            })
                            found = True
                            break
                        seen_feeds[feed_url] = c.name
                        row.update({
                            "feed_url": feed_url,
                            "title": v.get("title"),
                            "entry_count": v.get("entry_count", 0),
                            "ok": True,
                            "reason": "",
                        })
                        found = True
                        break
                    if not row["reason"]:
                        row["reason"] = v.get("error") or "invalid"
                    # A host that asks for a slower crawl gets it — up to
                    # a point. robots.txt on a .gov site can declare
                    # Crawl-delay: 60, and honouring that verbatim would
                    # turn a 192-candidate probe into an overnight run.
                    # The FETCHER enforces the real delay at fetch time;
                    # the probe only has to stay polite.
                    wait = min(MAX_PROBE_DELAY_S, max(delay, float(crawl_delay or 0)))
                    if wait > delay:
                        time.sleep(wait - delay)
                if found:
                    break

            if not found and not row["reason"]:
                row["reason"] = "no working feed found"
            results.append(row)
            log.info(
                "%-46s %s %s",
                c.name[:46],
                "OK  " if row["ok"] else "FAIL",
                (row["feed_url"] or row["reason"])[:90],
            )
    return results


def existing_feed_urls() -> set[str]:
    with connect() as conn:
        rows = conn.execute("SELECT feed_url FROM news_sources").fetchall()
    return {r["feed_url"] for r in rows if r["feed_url"]}


def register(rows: list[dict], dry_run: bool = True) -> dict:
    """Register the verified sources into feeds.json and news_sources.

    The country/region rules are the ones from AGENTS.md, applied:

    · `country` is a real ISO-2 country the source publishes from, or
      NULL for a global or regional body. "ME" is Montenegro, not the
      Middle East, and "EU" is not a country.
    · `region` is from the canonical vocabulary.
    · `locality` marks the country-less ones as 'regional' or
      'international', so the single-city fallback cannot put a global
      organisation's whole output on one capital — the Bamako pileup.
    · `topics` carries the water vertical and the subcategory, so the
      vertical is identifiable in the database and queryable.
    """
    known = existing_feed_urls()
    added, skipped = [], []

    for r in rows:
        if not r["ok"] or not r["feed_url"]:
            continue
        if r["feed_url"] in known:
            skipped.append({"name": r["name"], "reason": "already in news_sources"})
            continue
        if r["region"] not in REGIONS:
            skipped.append({"name": r["name"], "reason": f"bad region {r['region']}"})
            continue
        if r["country"] is not None and not re.fullmatch(r"[A-Z]{2}", r["country"]):
            skipped.append({"name": r["name"], "reason": f"bad country {r['country']}"})
            continue

        # A body with no country publishes from somewhere but covers
        # somewhere else; the locality marker says so explicitly.
        locality = None if r["country"] else (
            "international" if r["region"] == "global" else "regional"
        )
        topics = ["water", r["subcategory"]]
        coverage = "global" if r["region"] == "global" else "regional"

        if dry_run:
            added.append({**r, "locality": locality, "topics": topics})
            continue

        with connect() as conn:
            row = conn.execute(
                """
                INSERT INTO news_sources
                    (name, feed_url, homepage_url, country, language, region,
                     source_type, active, poll_interval_s, topics, locality,
                     geographic_coverage, license)
                VALUES (%s, %s, %s, %s, %s, %s, 'rss', TRUE, 900, %s, %s, %s, 'open')
                ON CONFLICT (feed_url) DO NOTHING
                RETURNING id
                """,
                (r["name"], r["feed_url"], r["candidate_urls"][0] if r["candidate_urls"] else None,
                 r["country"], r["language"], r["region"], topics, locality, coverage),
            ).fetchone()
        if row:
            added.append({**r, "source_id": row["id"], "locality": locality, "topics": topics})
            known.add(r["feed_url"])
        else:
            skipped.append({"name": r["name"], "reason": "duplicate feed_url"})

    if added and not dry_run:
        # Keep the curated registry in step with the database.
        try:
            with FEEDS_FILE.open() as f:
                data = json.load(f)
            existing = {f["feed_url"] for f in data.get("feeds", [])}
            for r in added:
                if r["feed_url"] in existing:
                    continue
                data.setdefault("feeds", []).append({
                    "name": r["name"],
                    "feed_url": r["feed_url"],
                    "country": r["country"] or "",
                    "language": r["language"],
                    "region": r["region"],
                    "source_type": "rss",
                    "enabled": True,
                })
            with FEEDS_FILE.open("w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log.warning("could not update feeds.json: %s", e)

        # The durable, auditable registry — the same shape as
        # worker/science_sources_data.json, so the water vertical has a
        # source list that can be read without the database.
        try:
            registry = {
                "vertical": "water",
                "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "note": (
                    "Sources verified by worker/water_sources.py: the feed was "
                    "fetched with the User-Agent the fetcher uses, parsed with "
                    "feedparser, required to carry at least three entries, and "
                    "checked against the host's robots.txt. The rejections and "
                    "their reasons are in the verification report."
                ),
                "sources": [
                    {
                        "name": r["name"],
                        "domain": (urlparse(r["feed_url"]).hostname or "").removeprefix("www."),
                        "url": r["candidate_urls"][0] if r["candidate_urls"] else None,
                        "feed_url": r["feed_url"],
                        "feed_title": r.get("title"),
                        "entries_at_verification": r.get("entry_count"),
                        "country": r["country"],
                        "region": r["region"],
                        "language": r["language"],
                        "locality": r.get("locality"),
                        "subcategory": r["subcategory"],
                        "topics": r.get("topics", ["water", r["subcategory"]]),
                    }
                    for r in added
                ],
            }
            REGISTRY_FILE.write_text(json.dumps(registry, indent=2, ensure_ascii=False))
        except Exception as e:
            log.warning("could not write the water registry: %s", e)

    return {"added": added, "skipped": skipped}


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Verify and register water news sources")
    ap.add_argument("--report", action="store_true", help="verify and print, add nothing")
    ap.add_argument("--apply", action="store_true", help="verify and register")
    ap.add_argument("--json-out", help="write the verification report here")
    ap.add_argument("--max-feed-tries", type=int, default=8)
    ap.add_argument("--hunt", action="store_true",
                    help="deep-discovery pass over the REJECTED candidates")
    ap.add_argument("--hunt-out", help="write the deep-discovery results here")
    args = ap.parse_args(argv)

    if not (args.report or args.apply):
        args.report = True

    log.info("verifying %d water source candidates", len(CANDIDATES))
    rows = verify(CANDIDATES, max_feed_tries=args.max_feed_tries)

    ok = [r for r in rows if r["ok"]]
    bad = [r for r in rows if not r["ok"]]
    print()
    print(f"VERIFIED  {len(ok)} / {len(rows)}")
    print(f"REJECTED  {len(bad)}")
    print()
    print("── verified ──────────────────────────────────────────────────────")
    for r in ok:
        print(f"  {r['name'][:44]:46s} {str(r['country'] or '--'):3s} {r['region']:15s} "
              f"{r['entry_count']:>3d} entries  {r['feed_url'][:70]}")
    print()
    print("── rejected ─────────────────────────────────────────────────────")
    for r in bad:
        print(f"  {r['name'][:44]:46s} {(r['reason'] or 'unknown')[:80]}")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(rows, indent=2, ensure_ascii=False))
        print(f"\nreport written to {args.json_out}")

    if args.hunt:
        log.info("hunting %d rejected candidates", len(bad))
        hunted = []
        with httpx.Client(timeout=25, follow_redirects=True) as client:
            for c in CANDIDATES:
                row = next((r for r in rows if r["name"] == c.name), None)
                if row is None or row["ok"]:
                    continue
                h = hunt(client, c)
                hunted.append(h)
                log.info("%-46s %s %s", c.name[:46],
                         "HUNT" if h["feed_url"] else "----",
                         (h["feed_url"] or h["reason"])[:90])
        found = [h for h in hunted if h["feed_url"]]
        print(f"\nHUNTED {len(found)} of {len(hunted)} rejected candidates")
        for h in found:
            print(f"  {h['name'][:44]:46s} {h['entry_count']:>4}  {h['feed_url'][:74]}")
        if args.hunt_out:
            Path(args.hunt_out).write_text(json.dumps(hunted, indent=2, ensure_ascii=False))
            print(f"hunt report written to {args.hunt_out}")

    if args.apply:
        res = register(rows, dry_run=False)
        print(f"\nREGISTERED {len(res['added'])} sources")
        for a in res["added"]:
            print(f"  + {a['name'][:50]:52s} id={a.get('source_id')}")
        for s in res["skipped"]:
            print(f"  - {s['name'][:50]:52s} {s['reason']}")
    else:
        res = register(rows, dry_run=True)
        print(f"\n(would register {len(res['added'])} sources; pass --apply to write them)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
