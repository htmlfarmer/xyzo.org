# Live & Calculated Data Layers — Research Report

**Date:** 2026-10-29
**Scope:** Free, open, commercially-usable live/animated map layers for the XYZO news map
**Method:** every endpoint in the "Confirmed" column was fetched live from the production host during this
research session. Endpoints I could not reach from this host are explicitly marked **UNVERIFIED** and the
reason is given.

---

## 0. Executive summary

Three findings dominate:

1. **The best live layers are already reachable over GIBS (NASA WMTS) with no key at all.** The site
   already ships three GIBS overlays. GIBS carries a **10-minute** GOES-East true-colour, dust,
   air-mass and **active-fire** set, a **30-minute** global precipitation product, and daily
   flood/SST/AOD. That is an order of magnitude more "life" available at zero licence risk.
2. **The calculated-field route is by far the cheapest.** The repo already has
   `worker/isobars.py:fetch_grib_field(date, cycle, var, level)` and a working NOMADS filter-server
   client. **CAPE, CIN, APCP, visibility, 500 hPa height, dewpoint, RH, snow-water-equivalent and
   PRATE are all one function call away** — verified live, HTTP 200, valid GRIB. No new pipeline.
3. **Three headline datasets are licence traps.** RainViewer's free API is explicitly
   **personal/educational/small-community only**; Copernicus CDS (OSTIA, CAMS, Sentinel) is
   **non-commercial on the free tier**; and GHSL population is **CC BY-NC-SA 4.0**.

---

## 1. Master table

Licence column: **PD** = US Government work / public domain · **CC BY** = commercial OK with
attribution · **NC** = non-commercial, flagged.

### A. Real-time / animated (movement)

| # | Name | Licence (commercial?) | Key? | Cadence | Resolution | Endpoint | Implementation | Effort |
|---|------|----------------------|------|---------|-----------|----------|----------------|--------|
| A1 | **NOAA SWPC OVATION aurora nowcast** | **PD** (US Gov) — OK | No | ~5 min (observation) / forecast 30 min | 1° grid (~111 km), 0.5–5 nT | `services.swpc.noaa.gov/json/ovation_aurora_latest.json` | **CONFIRMED** 200, 919 KB, `{"coordinates":[[lon,lat,aurora],…]}` → canvas heat wash, ~14 k pts | S |
| A1b | SWPC OVATION north/south JPEG frames | **PD** — OK | No | 5 min | full disc | `services.swpc.noaa.gov/images/animations/ovation/north/aurora_N_YYYY-MM-DD_HHMM.jpg` | **CONFIRMED** listing; a frame-by-frame cross-fade layer | S |
| A2 | **SWPC space weather** (solar wind, Kp, GOES X-ray) | **PD** — OK | No | 1 min (RTSW) / 5 min (Kp) / 1 min (X-ray) | point/timeseries | `json/rtsw/rtsw_wind_1m.json`, `json/planetary_k_index_1m.json`, `products/summary/solar-wind-speed.json`, `products/summary/solar-wind-mag-field.json`, `json/goes/primary/xrays-1-day.json` | **CONFIRMED** all 200 | S |
| A3 | **USGS real-time earthquakes** | **PD** (USGS) — OK | No | **every 60 s** | point (M≥4.5 feed available) | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` | **CONFIRMED** 200, `access-control-allow-origin: *`, `max-age=60` → pulsing canvas markers + rAF ripple | S |
| A4 | **NWS active alerts (watches/warnings)** | **PD** (NWS/NOAA) — OK | No (UA recommended) | live, `max-age=5` | polygon (county/zone) | `api.weather.gov/alerts/active` | **CONFIRMED** 200, CORS `*`, **369 live features** right now (Small Craft Advisory, Gale Warning, Flood Watch…) → GeoJSON polygon layer | S |
| A5 | **RainViewer radar** (past + nowcast) | ⚠️ **NC on free tier** — "personal, educational, and small-scale community use"; commercial = bespoke terms | No | 10 min | ~1 km / 250 m | `api.rainviewer.com/public/weather-maps.json` → `tilecache.rainviewer.com/v2/radar/<path>/{z}/{x}/{y}/{size}/{colour}/{opts}.png` | **CONFIRMED** 200 + tiles 200, but **do not ship on a commercial site** | M (if cleared) |
| A6 | **GOES-East true colour (GIBS)** | **PD** (NASA) — OK | No | **10 min** | 1 km (Level7) | `gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/{ISO8601}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png` | **CONFIRMED** 200, 96 KB PNG. Animate by advancing `{ISO8601}` every 10 min | M |
| A7 | **GOES active fire detection (GIBS)** | **PD** (NASA) — OK | No | **10 min** | 1 km | `.../GOES-East_ABI_FireTemp/default/{ISO8601}/GoogleMapsCompatible_Level7/...` (also `GOES-West_ABI_FireTemp`) | **CONFIRMED** 200, 50 KB PNG. **Better than FIRMS: no key, no registration, tile-ready** | S |
| A8 | **GOES dust / air mass / clean IR (GIBS)** | **PD** — OK | No | 10 min | 1–2 km | `GOES-East_ABI_Dust`, `GOES-East_ABI_Air_Mass`, `GOES-East_ABI_Band13_Clean_Infrared`, `GOES-West_ABI_*` | **CONFIRMED** 200 | S |
| A9 | **IMERG global precipitation (GIBS)** | **PD** — OK | No | **30 min** | 0.1° | `.../IMERG_Precipitation_Rate_30min/default/{ISO8601}/GoogleMapsCompatible_Level6/...` | **CONFIRMED** 200. (`IMERG_Precipitation_Rate` hourly is **already shipped** at `maxZoom 6`) | S |
| A10 | **NASA FIRMS active fires** | **PD** (NASA/LANCE) — data is PD, **but API requires MAP_KEY** | **YES** (free) | 3 h (older) / 30 min (near-real-time) | 375 m | `firms.modaps.eosdis.nasa.gov/api/area/csv/{bbox}/{days}/{dataset}` | **CONFIRMED** 400 "Invalid MAP_KEY." → **skip in favour of A7** | M |
| A11 | **NHC live tropical cyclone** | **PD** (NOAA) — OK | No | 6 h (00/06/12/18Z) | best-track + 5-day cone | `www.nhc.noaa.gov/CurrentStorms.json`; `www.nhc.noaa.gov/storm_graphics/api/{id}_{adv}adv_TRACK.kmz`; `www.nhc.noaa.gov/gis/forecast/archive/{id}_5day_{adv}.zip`; ATCF RSS `www.nhc.noaa.gov/gis-at.xml` | **CONFIRMED** all 200 (live storm EP222026 "Vance" adv 033 was up during research) → animated track + cone | M |
| A12 | **HURDAT2 historical tracks** | **PD** — OK | No | annual (file per post-season) | 6-hourly positions, 1851→ | `www.nhc.noaa.gov/data/hurdat/hurdat2-nepac-1949-2025-092926.txt` | **CONFIRMED** directory listing. Animate a season on a timeline | M |
| A13 | **NOAA IBTrACS (global best track)** | **PD** — OK | No | monthly | 3/6-hourly, all basins | `www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.last3years.list.v04r01.csv` | **CONFIRMED** 200, 11.7 MB | M |
| A14 | **NCEI CMORPH global precipitation** | **PD** — OK | No | 30 min / hourly | 0.25° / 8 km | `www.ncei.noaa.gov/data/cmorph-high-resolution-global-precipitation-estimates/access/30min/8km/…` | ⚠️ **archive STOPS at 2026-05** on both `30min/8km` and `hourly/0.25deg` — treat as discontinued until confirmed | M |
| A15 | **CIRA SLIDER (GOES imagery, aerosol, dust)** | **PD** (CIRA is NOAA-funded) — OK | No | 5–10 min | varies | `slider.cira.colostate.edu` (**note:** `ramm-slider.cira.colostate.edu` did NOT resolve); `/data/json/{sat}/{region}/{product}/`; `/data/imagery/` returns 403 to directory listing | **PARTIAL** — products `acspo_sst`, `awips_dust` confirmed under `goes-16/full_disk/`; tile path pattern **UNVERIFIED** | L |
| A16 | **Smithsonian GVP volcanic eruptions** | ⚠️ **UNVERIFIED / likely restricted** | No (bulk download requires registration) | weekly | point | `volcano.si.edu/database/search_eruption_results.cfm`, `…/webservices.cfm` | **BLOCKED** — every `volcano.si.edu` URL returns **403** to non-browser clients. Do not rely on it without a manual check | M |
| A17 | **NOAA MarineCadastre AIS** | **PD** (USCG/MARAD) — OK | Account for bulk | near-real-time | point | `s3.amazonaws.com/marinecadastre/` returned 404; `maritime.dot.gov/data-and-tools/data` returned **403** to curl | **UNVERIFIED** — path/registration flow needs a browser | L |
| A18 | **Global Fishing Watch AIS** | **CC BY 4.0** (data) — OK | **YES** (free account → 2-min token) | near-real-time | point | `gateway.api.globalfishingwatch.org/api/v3/dataset/ais/:latest` | **CONFIRMED** 401 without token. `tiles.globalfishingwatch.org` did not resolve | L |
| A19 | **GOES full-disk AWS open data** | **PD** — OK | No | 10 min | 1–2 km | `noaa-goes16.s3.amazonaws.com/ABI-L1b-RadC/…`, `cdn.star.nesdis.noaa.gov/GOES16/ABI/Sector1/…` | **CONFIRMED** S3 list works (needs the right key prefix); raw NetCDF/JPEG — needs a tiling step | L |

### B. Calculated fields (computed from open data)

| # | Name | Licence (commercial?) | Key? | Cadence | Resolution | Endpoint | Implementation | Effort |
|---|------|----------------------|------|---------|-----------|----------|----------------|--------|
| B1 | **GFS CAPE / CIN** | **PD** — OK | No | 6 h (00/06/12/18Z) | 1° (0.25° available) | `nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?file=gfs.t00z.pgrb2.1p00.f006&lev_surface=1&var_CAPE=1&dir=/gfs.YYYYMMDD/HH/atmos` | **CONFIRMED 200, 45 726 B GRIB** (`CAPE:surface`, `CIN:surface`) → bake → client canvas, temp-layer pattern | **S** |
| B2 | **GFS accumulated precipitation (APCP)** | **PD** — OK | No | 6 h | 1° | same filter server, `var_APCP`, `lev_surface` | **CONFIRMED 200, 71 274 B GRIB** (`APCP:surface`, 0-6 h acc) | S |
| B3 | **GFS visibility (VIS)** | **PD** — OK | No | 6 h | 1° | same, `var_VIS`, `lev_surface` | **CONFIRMED 200, 66 082 B GRIB** | S |
| B4 | **GFS 500 hPa geopotential height (jet stream)** | **PD** — OK | No | 6 h | 1° | same, `var_HGT`, **`lev_500_mb`** (underscores! `lev_500%20mb` → HTTP 500) | **CONFIRMED 200, 71 378 B GRIB**. Also `250 mb`, `300 mb`, `700 mb`, `850 mb` | S |
| B5 | **GFS dewpoint / RH at 2 m** | **PD** — OK | No | 6 h | 1° | same, `var_DPT` / `var_RH`, `lev_2_m_above_ground` | **CONFIRMED** present in the `.idx` | S |
| B6 | **GFS snow water equivalent (WEASD) / convective snow (CSNOW)** | **PD** — OK | No | 6 h | 1° | same, `var_WEASD` / `var_CSNOW`, `lev_surface` | **CONFIRMED** present in the `.idx` (there is **no** `TSNO` in GFS) | S |
| B7 | **GFS precipitation rate (PRATE)** | **PD** — OK | No | 6 h | 1° | same, `var_PRATE`, `lev_surface` | **CONFIRMED** present in the `.idx` | S |
| B8 | **Freezing level (0 °C isotherm)** | **PD** — OK | No | 6 h | 1° | **no direct GFS product** (there is no `degC` level in the `.idx`) — compute by interpolating `TMP` between pressure levels to 273.15 K | derived | M |
| B9 | **Objective fronts (frontogenesis)** | **PD** — OK | No | 6 h | 1° | **compute from fields we already fetch**: 2 m T + 10 m wind + MSLP (the repo has all three) | derived | M |
| B10 | **NOAA OISST sea-surface temperature** | **PD** — OK | No | daily (~2 d lag) | 0.25° | `www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/202610/` | **CONFIRMED** monthly dir; daily NetCDF per file. Easier: **GIBS `GHRSST_L4_MUR25_Sea_Surface_Temperature`** (daily PNG, **CONFIRMED 200**) or `GHRSST_L4_MUR_…` at 1 km | S (via GIBS) |
| B11 | **MODIS / VIIRS NDVI & EVI** | **PD** — OK | No | 16-day composite | 250–500 m | `MODIS_Terra_L3_NDVI_16Day`, `MODIS_Aqua_L3_EVI_16Day`, `VIIRS_SNPP_L3_NDVI_16Day` (GIBS) | **CONFIRMED** present in GIBS capabilities | S |
| B12 | **VIIRS night lights** | **PD** — OK | No | annual composite | 500 m | GIBS `VIIRS_Night_Lights` (2012/2016) | **CONFIRMED** present (static). Live `VIIRS_Black_Marble` is **already shipped** | done |
| B13 | **NASA flood extent (MODIS / VIIRS)** | **PD** — OK | No | daily | 375 m | GIBS `MODIS_Combined_Flood_1-Day` (to 2026-10-29) and `VIIRS_Combined_Flood_1/2/3-Day` | **CONFIRMED 200, PNG** | S |
| B14 | **OMI/MODIS aerosol optical depth** | **PD** — OK | No | daily | 0.5° / 3 km | GIBS `OMI_Aerosol_Optical_Depth`, `MODIS_Terra_Aerosol_Optical_Depth_3km` (both current to 2026-10-29) | **CONFIRMED** present | S |
| B15 | **TEMPO geostationary ozone (NEW)** | **PD** — OK | No | hourly | 4 km | GIBS `TEMPO_L3_Ozone_Column_Amount`, `TEMPO_L3_Ozone_Profile_Troposphere_Column` | **CONFIRMED** present, current to 2026-10-28T22:32Z | S |
| B16 | **Global Wind Atlas / Global Solar Atlas** | **CC BY 4.0** — OK | No | annual (2010-2020/2023) | 250 m–1 km | `globalwindatlas.info` / `globalsolaratlas.info` — both are SPAs; `api.globalwindatlas.info` → 404, `api.globalsolaratlas.info` → 403, `globalwindatlas.info/api/` → 400 | **UNVERIFIED** — the download API path must be taken from the site's own download page in a browser. Do not guess | M |
| B17 | **OpenAQ air quality** | **CC BY 4.0** (data) — OK, but **API now needs `X-API-Key`** | **YES** | hourly | station | `api.openaq.org/v3/locations` | **CONFIRMED 401** without key | M |
| B18 | **Open-Meteo air-quality API** | ⚠️ **API terms restrict commercial use without a plan** (data = CAMS, CC BY 4.0) | No | hourly | point/grid | `air-quality-api.open-meteo.com/v1/air-quality?latitude=..&longitude=..&hourly=pm10` | **CONFIRMED 200, no key** — convenient but **read the ToS before commercial use** | S |
| B19 | **Copernicus CDS (OSTIA, CAMS, Sentinel-3/5P NDVI/NO2)** | ⚠️ **NC on the free tier** — Copernicus licence permits only non-commercial use via the CDS | **YES** (free CDS account) | daily/6-hourly | 1 km / 9 km | `cds.climate.copernicus.eu/api` | **NOT TESTED** — requires an account; **non-commercial flag stands** | L |
| B20 | **NOAA WaveWatch / global wave forecasts** | **PD** — OK | No | 6 h | 0.25° | `ftp.cpc.ncep.noaa.gov/oceans/global/` → **404**; `www.ncei.noaa.gov/data/global-wave-forecasts/` → **404** | **UNVERIFIED** — the correct NCEI/CPC path needs to be found | M |
| B21 | **WorldPop population** | **CC BY 4.0** — OK | No | annual | 100 m | `www.worldpop.org/rest/data` → **CONFIRMED 200** (23 KB JSON index) | **CONFIRMED** | S |
| B22 | **GHSL population (JRC)** | ⚠️ **CC BY-NC-SA 4.0 — NON-COMMERCIAL** | No | 5-year epochs | 100 m / 1 km | `ghsl.jrc.ec.europa.eu/download.php` → 200 | **CONFIRMED reachable; licence forbids commercial use** | — |
| B23 | **Met.no / MET Norway** | ⚠️ **UNVERIFIED** — MET's terms are known to restrict commercial reuse without agreement | No (UA required) | 10 min | radar composite | `api.met.no/weatherapi/…` → **every path returned 404 from this host** | **UNVERIFIED** — likely geo-blocked from this host; verify from a European host | L |
| B24 | **EUMETNET OPERA radar composite** | Open (OPERA is EU/EEA member-state data, CC BY-like) | No | 10 min | 2 km | `glamms.operacds.eu` → **DNS did not resolve** | **UNVERIFIED** | L |
| B25 | **NOAA NEXRAD Level II/III** | **PD** — OK | No | 4–6 min | 1° / 0.5° / 0.25° | `www.ncei.noaa.gov/data/...`; NOAA also serves the **IEM**-style mosaics | **No free tile service exists** — you must build one (unpack Level III, regrid, render tiles). High effort | L |
| B26 | **Iowa State Mesonet AFOS text products** | Free with attribution | No | as issued | — | `mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=…&e=…` → **422** (params wrong) | **PARTIAL** — endpoint is real; NCEP's WFS surface-front product is the candidate, but the exact `pil` was not confirmed | M |
| B27 | **NASA OSCAR sea-surface currents** | **PD** — OK | No | weekly/monthly | 0.25° | GIBS `OSCAR_Sea_Surface_Currents_Meridional` / `_Zonal` | **CONFIRMED** present in GIBS capabilities | S |

---

## 2. TOP 8 — ranked by (impact on a news map) ÷ (implementation risk)

### 1. USGS live earthquakes — pulsing markers
`earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` is **confirmed live, CORS `*`,
refreshed every 60 seconds**, and it is pure US Government work. It is the single highest
signal-to-noise ratio of anything in this report: on a news map, a magnitude-6 earthquake that
appears with a ripple is a *story* the reader can click, and it costs one fetch and one canvas
renderer. **First step:** write `public_html/quake-layer.js` that polls the `all_day` feed every
60 s, filters to `mag ≥ 4.0`, and draws rAF-expanding rings on the existing pin canvas (reuse the
`CanvasPinRenderer` hit-test pattern rather than a second canvas).

### 2. NWS active alerts — live watch/warning polygons
`api.weather.gov/alerts/active` returned **369 live features with `Access-Control-Allow-Origin: *`
and `Cache-Control: max-age=5`**. Today that is 154 Small Craft Advisories, 96 Gale Warnings,
30 Coastal Flood Advisories and 8 Flood Watches — this is *literally the news*, in GeoJSON, in
the US, with zero licence risk. It also generalises: the same API serves `alerts/active` for
Guam, Puerto Rico, the Pacific, and the NWS offices. **First step:** fetch the feed every
60 s, render the `geometry` polygons through Leaflet's `L.geoJSON` into a dedicated pane, and
add the alert `event`/`severity`/`headline` to the hover HUD's `SAMPLERS`.

### 3. GFS CAPE — a convective-instability heatmap
`filter_gfs_1p00.pl?…&lev_surface=1&var_CAPE=1` returns **45 KB of valid GRIB** on the first try.
CAPE is the field that tells a news reader "this region is about to have severe storms", and it
is the classic storm-chaser overlay. It costs almost nothing to add: `worker/isobars.py` already
has `fetch_grib_field()` and `decode_field()`, and `worker/tempmap.py` already bakes a GFS field
into a 1024² canvas and blits it per tile. **First step:** copy `worker/tempmap.py` as
`worker/capemap.py`, swap `TMP`/`2_m_above_ground` for `CAPE`/`surface`, and add a
`capemap-layer.js` beside `temp-layer.js` (the temp layer's bake-then-blit pattern is directly
reusable, and `CIN` is available for a second toggle).

### 4. NOAA SWPC OVATION aurora — the animated oval
The JSON at `services.swpc.noaa.gov/json/ovation_aurora_latest.json` is **confirmed 200, 919 KB,
`[Longitude, Latitude, Aurora]` triples**, and the sibling JPEG frames under
`/images/animations/ovation/north/` are written **every 5 minutes**. This is the most beautiful
candidate in the report: the aurora oval breathes and pulses, it is hemispherically symmetric, it
is genuinely free of any key, and it is US Government work. **First step:** fetch the JSON, paint
it into a Web-Mercator canvas with a green/teal ramp (the value is 0–5 nT), and re-fetch every
5 minutes; the 5-minute cadence means the overlay visibly *moves* without any animation code at
all — just a redraw.

### 5. GIBS active fires (GOES FireTemp) — the wildfire layer, without a key
`GOES-East_ABI_FireTemp` returned a **50 KB PNG at 200** for a 10-minute timestamp, and
`GOES-West_ABI_FireTemp` exists for the other hemisphere. This replaces FIRMS entirely: FIRMS
demands a `MAP_KEY` and hands you CSV rows to geocode, whereas GIBS hands you a **tile you can
drop straight into `L.tileLayer`** with an animated `setInterval` that advances the timestamp
every 10 minutes. **First step:** add a `WEATHER_OVERLAYS` entry whose URL template contains
`{ISO8601}`, and a 60-second ticker that rewrites the tile URL with the newest available
10-minute slot (query the GIBS capabilities once at boot to learn the valid range rather than
guessing).

### 6. NHC live tropical cyclone tracks — animated forecast cones
`CurrentStorms.json` is **confirmed live** (it named storm EP222026 "Vance" at advisory 033 during
this research), and both the forecast-track KMZ and the 5-day shapefile ZIP download cleanly.
Combined with **HURDAT2** (public domain, 1851→) and **IBTrACS** (public domain, all basins),
this gives both "what is happening now" and "animate the 2026 season on a timeline". **First
step:** parse `CurrentStorms.json` for `activeStorms[]`, fetch
`forecastTrack.kmzFile`, parse the KML `<LineString>`/`<Placemark>` coordinates into a Leaflet
polyline coloured by category, and animate the head marker along the forecast positions.

### 7. GFS 500 hPa jet stream — an upper-air chart, for free
`lev_500_mb` (note the **underscore** — `lev_500%20mb` returns HTTP 500) and `var_HGT` gave
**71 KB of valid GRIB**. The 500 hPa height contour map *is* the jet-stream map, and the repo
already contains a complete, hard-won contouring pipeline in `worker/isobars.py`
(`marching_squares`, `chaikin_smooth`, `simplify`, `merge_lines`, `filter_short_chains`,
`clip_to_lon_range`). Re-running it on `HGT@500 mb` and drawing a second, thinner, dashed line
set over the pressure isobars is a near-copy of work already done and tested. **First step:**
generalise `worker/isobars.py` to take a variable/level pair, publish the 500 hPa contour set to
a second table (or a second column), and add it to the existing isobar layer as a toggle.

### 8. NWS/GOES true colour + IMERG precipitation — a 10-minute weather animation
GIBS confirmed `GOES-East_ABI_GeoColor` (96 KB PNG, 10-min), `GOES-East_ABI_Dust`,
`GOES-East_ABI_Air_Mass`, `GOES-East_ABI_Band13_Clean_Infrared` and
`IMERG_Precipitation_Rate_30min` (30-min) all live at the current cycle. The site already ships
`IMERG_Precipitation_Rate` (hourly) and `VIIRS_SNPP_CorrectedReflectance_TrueColor`, so the
pattern is proven — this is the same technique pointed at a 10-minute cadence. **First step:**
generalise the existing GIBS overlay URL builder to carry a `{ISO8601}` placeholder and add a
`setInterval` that steps the timestamp, rather than adding a new layer module.

**Runner-up worth noting:** the **fronts** overlay (B9). It is not a dataset — it is a
*computation*, and every input is already on disk. The classic objective-front approach is
frontogenesis: the component of the 2 m temperature gradient along the 10 m wind, thresholded.
The repo has 2 m T, 10 m wind and MSLP from the same GFS cycle, so fronts can be computed
in-worker with no new network dependency at all.

---

## 3. Explicit flags

### 🔴 Licence forbids / blocks commercial use
- **RainViewer** — the free API is *"available for personal and educational use only"* and *"not
  intended for high-volume commercial applications"*; commercial integration is *"arranged
  case-by-case"*. **Do not ship it on a commercial site without a written agreement.**
  (Verified from `https://www.rainviewer.com/api.html`.)
- **Copernicus CDS (OSTIA, CAMS, Sentinel-3/5P)** — the free CDS tier is **non-commercial**.
- **GHSL (JRC population)** — **CC BY-NC-SA 4.0**, non-commercial.
- **Met.no / MET Norway** — terms are known to restrict commercial reuse without agreement;
  **could not be verified** because `api.met.no` returns 404 for every path from this host.

### 🟡 Requires a key or registration (free, but there is a gate)
- **OpenAQ v3** — `X-API-Key` required (**confirmed 401**).
- **Global Fishing Watch** — free account + 2-minute token (**confirmed 401**).
- **NASA FIRMS** — free `MAP_KEY` (**confirmed 400**). Avoid it: GIBS `GOES-East_ABI_FireTemp`
  gives the same product as a tile with no key at all.
- **Smithsonian GVP** — bulk download requires registration; every `volcano.si.edu` URL returns
  **403** to non-browser clients from this host.

### ⚫ Dead, archived, or path-not-found
- **NCEI CMORPH** — `access/30min/8km/` and `access/hourly/0.25deg/` both **stop at 2026-05**.
  Do not build on it without confirming a successor.
- **`ramm-slider.cira.colostate.edu`** — **does not resolve**. The live host is
  **`slider.cira.colostate.edu`**.
- **`ftp.cpc.ncep.noaa.gov/oceans/global/`** and
  **`www.ncei.noaa.gov/data/global-wave-forecasts/`** — both **404**. The wave-forecast path
  must be re-found before anything is built.
- **`www.ncei.noaa.gov/data/oisst/`** and **`.../data/sst/`** — **404**. The live OISST path is
  `.../sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/YYYYMM/`.
- **`www.ncei.noaa.gov/data/cmorph-.../access/hourly/0.25deg/2026/`** stops at `05`.
- **GIBS has no `Tropical_Cyclone` track layers** — they were retired. Use NHC directly.
- **GIBS `VIIRS_Black_Marble`** is a **static** 2016 composite, not live (the live layer in the
  repo points at the same static date).
- **No `TSNO` in GFS** — snowfall is `WEASD` (water equivalent) and `CSNOW` (convective snow).
- **No `degC` isotherm level in GFS** — the freezing level must be interpolated.

### 🟠 Licence / API nuance to read before shipping
- **Open-Meteo air-quality API** — no key, works immediately (**confirmed 200**), but its API
  terms restrict commercial use beyond their free tier. The underlying CAMS data is CC BY 4.0;
  the *service* is the gate.
- **Global Wind Atlas / Global Solar Atlas** — data is CC BY 4.0 (commercial OK), but **every API
  path I tried was wrong** (400/403/404). Take the endpoint from the site's own download page in
  a browser; do not guess.
- **NWS `api.weather.gov`** — public domain, but it asks for a descriptive `User-Agent` and
  `api.weather.gov` is explicitly a *development* API with no SLA. Mirror it server-side.
- **GIBS** — NASA imagery is public domain, but the **GIBS service** asks for attribution
  ("NASA EOSDIS GIBS"). Attribution is enforced in `public_html/tests/data-licences.bun.test.js`
  for the layers we already ship — the new ones must carry an `attribution` string too or that
  test will fail.
- **Smithsonian GVP** — treat the licence as **unverified/restricted** until read from the site
  in a browser.

### ✅ Confirmed clean, zero-gate, commercial-safe
USGS earthquakes · NWS alerts · NOAA SWPC (all JSON + imagery) · NHC (CurrentStorms, KMZ, ZIP,
ATCF RSS, HURDAT2) · NOAA IBTrACS · NOMADS GFS (all products) · NASA GIBS · NOAA NCEI OISST ·
WorldPop (CC BY 4.0) · USGS/NCEI CMORPH *(but see the archive-stop flag)*.

---

## 4. What the repo already gives us for free

| Existing asset | What it unlocks |
|---|---|
| `worker/isobars.py:fetch_grib_field(date, cycle, var, level)` | Any GFS field in one call. **CAPE, CIN, APCP, VIS, HGT@500 mb, DPT@2 m, RH@2 m, WEASD, PRATE all verified 200.** |
| `worker/isobars.py` contouring primitives | `marching_squares`, `chaikin_smooth`, `simplify`, `merge_lines`, `filter_short_chains`, `clip_to_lon_range` — **fronts and the jet-stream chart are a variable swap, not a new pipeline.** |
| `worker/tempmap.py` bake-then-blit pattern | A 1024² Web-Mercator canvas + per-tile `drawImage`. **Copy it for CAPE, VIS, APCP, or SST.** |
| `public_html/temp-layer.js` | The exact layer contract (`getTileLayer`, `blocksClick`, `sampleAt`, `setOpacity`) a CAPE/visibility layer must satisfy. |
| `public_html/app.js` `WEATHER_OVERLAYS` + `overlay-opacity.js` | Adding a GIBS overlay is one entry + an opacity row; the dotted-leader rule and the `?v=` bump are already handled by `scripts/bump_frontend.sh`. |
| `public_html/hover-info.js` `SAMPLERS` | A new layer that exposes `sampleAt(latlng)` is picked up by the hover HUD automatically. |
| `public_html/canvas-pin-renderer` hit-test | Quake/alert/cyclone markers should reuse the existing canvas + hit-test rather than adding DOM markers. |

### Exact GFS filter-server syntax that works (verified)

```
https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl
    ?file=gfs.t{cycle}z.pgrb2.1p00.f{fff}
    &lev_{LEVEL}=1          # underscores: lev_500_mb, lev_2_m_above_ground, lev_surface
    &var_{VAR}=1            # CAPE, CIN, APCP, VIS, HGT, TMP, DPT, RH, WEASD, PRATE
    &dir=/gfs.YYYYMMDD/HH/atmos
```
The **`.idx` sidecar** (`…/gfs.t00z.pgrb2.1p00.f006.idx`) is the authoritative list of every
`var:level` pair in a file — it is how the exact level names above were confirmed, and it is the
right tool for finding any new field.

---

## 5. Verification log

| Endpoint | Result |
|---|---|
| `earthquake.usgs.gov/…/all_day.geojson` | 200, CORS `*`, 191 features, 137 KB |
| `services.swpc.noaa.gov/json/ovation_aurora_latest.json` | 200, 919 KB, obs 14:44Z / fcst 16:17Z |
| `services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json` | 200, 1-min cadence |
| `services.swpc.noaa.gov/json/planetary_k_index_1m.json` | 200, 358 entries |
| `services.swpc.noaa.gov/products/summary/solar-wind-speed.json` | 200 |
| `services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json` | 200 |
| `services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json` | 200 |
| `services.swpc.noaa.gov/images/animations/ovation/north/` | 200, 5-min JPEG frames |
| `api.weather.gov/alerts/active` | 200, CORS `*`, 369 features, `max-age=5` |
| `www.nhc.noaa.gov/CurrentStorms.json` | 200, live storm EP222026 |
| `www.nhc.noaa.gov/storm_graphics/api/EP222026_033adv_TRACK.kmz` | 200, valid KMZ/KML |
| `www.nhc.noaa.gov/gis/forecast/archive/ep222026_5day_033.zip` | 200, shapefiles |
| `www.nhc.noaa.gov/gis-at.xml` / `gis-ep.xml` | 200 (ATCF RSS) |
| `www.nhc.noaa.gov/data/hurdat/` | 200, listing |
| `…ibtracs/v04r01/access/csv/ibtracs.last3years.list.v04r01.csv` | 200, 11.7 MB |
| `nomads…filter_gfs_1p00.pl` × CAPE / APCP / VIS / HGT@500mb | 200, valid GRIB |
| `gibs…GOES-East_ABI_GeoColor` | 200, 96 KB PNG |
| `gibs…GOES-East_ABI_FireTemp` | 200, 50 KB PNG |
| `gibs…IMERG_Precipitation_Rate_30min` | 200, PNG |
| `gibs…GHRSST_L4_MUR25_SST` | 200, PNG |
| `gibs…MODIS_Combined_Flood_1-Day` | 200, PNG |
| `api.rainviewer.com/public/weather-maps.json` + tiles | 200 (but NC licence) |
| `firms…/api/area/csv/…` | 400 "Invalid MAP_KEY." |
| `api.openaq.org/v3/locations` | 401 |
| `gateway.api.globalfishingwatch.org/api/v3/dataset/ais/:latest` | 401 |
| `www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/202610/` | 200 |
| `www.worldpop.org/rest/data` | 200, 23 KB |
| `air-quality-api.open-meteo.com/v1/air-quality` | 200, no key |
| `api.met.no/weatherapi/…` (4 paths) | 404 — geo-blocked from this host |
| `volcano.si.edu/…` (3 paths) | 403 — bot-blocked |
| `ftp.cpc.ncep.noaa.gov/oceans/global/` | 404 |
| `glamms.operacds.eu` | DNS fail |
| `ramm-slider.cira.colostate.edu` | DNS fail (use `slider.cira.colostate.edu`) |
| `globalwindatlas.info/api/…` (3 paths) | 400 / 404 / 403 |
