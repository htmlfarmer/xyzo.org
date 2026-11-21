# Data licences and attribution

Every dataset this site renders, where it came from, what licence it
carries, what we display, and what is still open. Written because
"we found it on the internet" is not a licence.

**Rule of thumb used here:** a dataset is safe to publish only if (a) its
licence permits the use we are making of it, (b) we carry the
attribution the licence asks for, and (c) we say what the numbers mean.
Anything that fails (a) or (b) is flagged **ACTION** below.

---

## 1. The overlay layers

| Layer | Source | Licence | We display | Status |
|---|---|---|---|---|
| ⚡ Lightning density | WWLLN Global Lightning Climatology (Zenodo 20277101), 2020-2022 | **CC BY 4.0** | "WWLLN / ARVE Research" + DOI + licence in the legend foot | OK |
| 🦠 Phytoplankton | MIT Darwin Project / MITgcm / ECCO-2 global simulation, 1994-1999 (NASA MAP) | **MIT Licence** for the model and its output; NASA imagery public domain | "MIT Darwin Project / MITgcm / ECCO-2 (NASA MAP)" + "MIT Licence" in the legend foot | OK |
| 🌍 Köppen climate | *currently* Peel et al. 2007 via Gerrit Hendriksen's KML | **CC BY-NC-SA 2.5** — NonCommercial **and** ShareAlike | "Köppen-Geiger: Peel et al. (2007)" | **ACTION** — see §4 |
| 🧭 Magnetic field | WMM2025 (NOAA NCEI / British Geological Survey) | US Government work — public domain | "NOAA NCEI / BGS (WMM2025)" | OK |
| 🌡️ Temperature | NOAA NCEP GFS | US Government work — public domain | "NOAA NCEP GFS" | OK |
| 💨 Wind | NOAA NCEP GFS | US Government work — public domain | "NOAA NCEP GFS" | OK |
| ⛅ Isobars | NOAA NCEP GFS `PRMSL` | US Government work — public domain | "NOAA NCEP GFS" | OK |
| ⛅ Isobars (**ECMWF path**) | **ECMWF IFS open data, 0.1°** — served by `/api/weather/isobars` when the viewport is outside the HRRR domain and ECMWF is available (`source: "ecmwf"`), and **since 2026-11-04 selectable by the reader** (the isobar legend's analysis picker: **Auto · ECMWF · GFS · HRRR**) | **CC BY 4.0 — attribution required** | "ECMWF IFS" | **GAP 2026-10-30**, partly addressed 2026-11-04 — served live (~2,300 lines in the current cycle, published at 1 hPa since 11-02) and now named in the map's attribution bar (`isobar-layer.js`'s `SOURCE_ATTRIBUTIONS`, "… European Centre for Medium-Range Weather Forecasts (ECMWF) — CC BY 4.0") and reachable by the reader through the analysis picker, but the licence *audit* still does not check that string and `pickSource()` / `HRRR_DOMAIN_QUAD` still have no unit test of their own. See README Known Issues 0f. |
| ⛅ Isobars (HRRR path) | NOAA HRRR CONUS, 3 km — used only when the whole viewport sits inside the HRRR quad | US Government work — public domain | "NOAA HRRR" | OK |
| ⛅ Relief (ETOPO) | NOAA NCEI ETOPO 2022 v1 | US Government work — public domain | "NOAA NCEI ETOPO 2022 v1 — public domain" | OK — `license` **added to `etopo_build.py` 2026-10-30** (the meta.json was missing it) |
| 🌊 Wave height & power | NOAA NCEP GFS Wave (`gfswave`) + Open-Meteo marine grids | US Government work — public domain | "NOAA NCEP GFS Wave (gfswave)" | OK |
| ⛈️ CAPE / 🌊 IVT | NOAA NCEP GFS | US Government work — public domain | "NOAA NCEP GFS" | OK — note these two were **unreachable until 2026-10-30** (never registered in `app.js`) |
| 🟫 Soil | ISRIC SoilGrids 2.0 | **CC BY 4.0** | "SoilGrids 2.0 (ISRIC) — CC BY 4.0" | OK |
| 🟫 Soil — USDA orders chip | OpenLandMap-soildb (OpenGeoHub Foundation), 12 orders of the USDA Soil Taxonomy at 30 m — hotlinked COG read by window | **CC BY 4.0** — attribution only | "OpenLandMap-soildb (OpenGeoHub Foundation) — CC BY 4.0" | OK — added 2026-11-05. The credit FOLLOWS the active property (`PROP_ATTRIBUTION`/`attributionFor(key)`): the nine SoilGrids properties still credit ISRIC, and the export surface uses getters so an exported file names whichever source was on screen. Enforced by `data-licences.bun.test.js` (must name OpenLandMap) and `soil-layer.bun.test.js`. ESSD DOI 10.5194/essd-18-989-2026. |
| 🟫 Soil type (HWSD v2.2) | FAO & IIASA, Harmonized World Soil Database v2.2 (`data.apps.fao.org`, GAEZ V5) — hotlinked WMTS | **CC BY 4.0** — attribution only | "Soil type: FAO & IIASA, Harmonized World Soil Database v2.2 (HWSD) — CC BY 4.0" | OK — added 2026-11-05. Enforced by `data-licences.bun.test.js` (two entries: publisher pair + licence) and printed in Leaflet's attribution bar. No NonCommercial, no ShareAlike. |
| 🌾 Cropland / Land cover | ESA WorldCover 10 m v200 (2021) | **CC BY 4.0** | "ESA WorldCover 10 m v200 (2021) — CC BY 4.0" | OK |
| 💧 Rivers | Natural Earth 10m Rivers + Lake Centerlines | public domain | "Natural Earth (public domain)" | OK |
| 🌊 **Rivers (FAO 2026)** | FAO AQUASTAT, **"Rivers (Global, edition 2026)"** (published 2026-06-15, revised 2026-07-16), from **HydroRIVERS** / HydroSHEDS — **hotlinked FAO WMS** (`aquamaps/wms`, layer `river_network`), not baked. The river **names** come from the same publisher's classic rivers layer (`rivers_world_47950`) | **CC BY 4.0 — attribution required** | "FAO AQUASTAT — Rivers (Global, 2026 ed.), from HydroRIVERS · CC BY 4.0" (in `options.attribution`, so Leaflet prints it in the map's attribution bar) | OK — added 2026-11-05. **The cartography is ours** (the client sends its own SLD, because the publisher's published style is dark-on-light and its main stems vanish on the default dark basemap), but the DATA is the publisher's and the credit says so. The names are a **derived** work of the classic layer, redistributed as anchor points under the same CC BY 4.0 terms. Depends on a third-party service: ~2 s/tile cold (now cached by our own proxy, `api/src/routes/faoRiversProxy.ts`), no self-hosted fallback yet (README Known Issues Q-N-1) |
| 🌊 Hydrological basins | FAO AQUASTAT — **two sources**, both HydroSHEDS-derived: **(a)** "Major hydrological basins of the world" (2012, `bas_wrld_38047`) for the 235 named basins; **(b)** "Hydrological basins of the world" (v2, 2022, `hydrobasins_world.zip`) for the **281 internally drained (endorheic) sub-basins** — selected by the publisher's own `TO_BAS = -888` sentinel, which only source (b) carries | **CC BY-SA 4.0** (both) | "FAO — Major hydrological basins of the world (CC BY-SA 4.0)" in `options.attribution`, **plus the Exhibit B upstream statement and the 2008 citation in `meta.json`** | OK — attribution **added 2026-10-28**; **the Exhibit B obligation CLOSED 2026-11-21** (`upstream` / `upstream_attribution` / `upstream_citation` written by the builder itself, so a rebuild cannot drop them). Source (b) is a **CC BY-SA 4.0** redistribution of the same HydroSHEDS v1 core, so the stricter upstream terms govern both — see the table above. Both files are served as the map's own layer data, not offered as a downloadable dataset |
| 🪨 Geology | Macrostrat (UW Macrostrat Lab / NSF) | **CC BY 4.0** | linked "Macrostrat (CC BY 4.0, UW Macrostrat Lab)" | OK |
| 🗺️ Geologic contacts | USGS / GSC world geology WMS | public domain (Open File 2915) | "USGS / GSC (Open File 2915)" | OK |
| 🛰️ NASA Satellite / Rain / Night | NASA GIBS | US Government work — public domain | "© NASA GIBS / …" | OK |
| 🛰️ Human Transportation | NOAA SOS "Human Transportation" (Anthropocene composite) | US Government work — public domain | "NOAA NESDIS / Science On a Sphere — Human Transportation" | OK |
| 🧂 Sea surface salinity | NOAA GFDL CM2.6 via NOAA SOS "Sea Surface Salinity" (frame 0 of 1,094) | US Government work — public domain | "NOAA GFDL (CM2.6) … via NOAA Science On a Sphere (public domain)" | OK |
| 🌊 Ocean Currents (ECCO) | NASA ECCO-2 via NOAA SOS "Ocean Currents - Temperature" (frame at t=60 s) | US Government work — public domain | "NOAA NESDIS / Science On a Sphere — Ocean Currents - Temperature (NASA ECCO-2)" | OK |
| 🌊 **Ocean currents (live)** | OSCAR Sea Surface Velocity (ESR / NASA PO.DAAC), five-day composite, served through **NOAA CoastWatch's ERDDAP** | US Government work — public domain | "OSCAR Sea Surface Velocity (ESR / NASA PO.DAAC) via NOAA CoastWatch" | OK — added 2026-11-04. **The composite NOAA CoastWatch carries ends 2014-09-26**; the NRT product is behind a NASA Earthdata login and the ICDC copy is institutional-only, so the field's vintage is recorded in `meta.json` and named in the legend. Not a redistribution of a restricted source — OSCAR itself is public domain. |
| 🌐 **Earthquakes** | USGS Earthquake Hazards Program — ComCat GeoJSON summary feeds (all_hour / all_day / all_week / all_month) | US Government work — public domain | "U.S. Geological Survey, Earthquake Hazards Program (public domain)" | OK — added 2026-11-04. USGS asks to be credited; the attribution is in `meta.json` and in the map's attribution line. The site serves its **own copy** (refreshed every 10 minutes by `xyzo-earthquakes.timer`) so a reader never polls the USGS feed. |
| 🪨 **Tectonic faults** | USGS **Quaternary Fault and Fold Database** + USGS global plate boundaries (KML, from the Earthquake Hazards KML page) | US Government work — public domain | "USGS Earthquake Hazards Program — public domain" | OK — added 2026-11-04. The KML layers are redistributed as our own GeoJSON with the USGS attribution carried in `meta.json` and in the map's attribution line. |
| 🌍 **Language regions** | Glottolog (Max Planck Institute for Geoanthropology) territories × Natural Earth 50 m admin-0 countries | Glottolog **CC BY-SA 4.0**; Natural Earth public domain | "Glottolog (CC BY-SA 4.0) · Natural Earth (public domain)" | OK — added 2026-11-04. Both licences are carried separately in `meta.json` (`regions.attribution` / `regions.license`), because the two products have two different terms. Share-alike is satisfied: the published GeoJSON is a derived work of a CC BY-SA 4.0 dataset and is offered under the same terms. |
| 🧍 **Population density (WorldPop, 1 km)** | WorldPop Global 2 (R2025A v1), Univ. of Southampton — **hotlinked FAO WMTS**, not baked | **CC BY 4.0** | "Population density: WorldPop, University of Southampton — CC BY 4.0" (in `options.attribution`) | OK — attribution added with the layer (2026-11-01). **Tiles are FAO's pre-coloured rendering of WorldPop's data**, so the credit names WorldPop as origin rather than only the tile server. Depends on a third-party service: ~1.5–2 s/tile cold, no self-hosted fallback |


### The upstream HydroSHEDS licence — it is NOT CC BY, and it has three conditions

The FAO labels the 2026 layer **CC BY 4.0**. The product it is
derived from — **HydroRIVERS**, and the **HydroSHEDS version 1** core
layers it was extracted from — carries its **own licence agreement**,
reproduced in **Appendix A of the HydroSHEDS Technical Documentation
v1.4** (`data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v1_4.pdf`).
**CC BY 4.0 does not cover it, so the stricter terms govern.** What
Appendix A actually grants:

| clause | what it says | what we must do |
|---|---|---|
| **§2.1.1 / §2.1.2** | the data is free for **non-commercial AND commercial use**; the licensee may **use, reproduce, display** it, integrate it into **Derivative Works**, and **distribute those Derivative Works to end users** (under an end-user licence at least as protective) | the site's ads and any paid use are **fine**; our tiles/vector layer are a Derivative Work |
| **§2.1.2, last line** | *"In no event shall Licensee license or distribute the Licensed Materials **as a stand-alone product**"* | we must **not** offer the data itself for download, and the safe reading is: **do not serve the raw source data as a browsable API**. Serving it **as map tiles** is a Derivative Work — which is what the layer does |
| **§2.2 + Exhibit B** | the attribution in **Exhibit B** must be *"displayed with, attached to or embodied in (in a reasonably prominent manner) the documentation or metadata of any Licensee Product or Program provided to an End User"* | the exact WWF/HydroSHEDS statement — including *"WWF has not evaluated the data as altered and incorporated within [our product]"* — plus the **Lehner, Verdin & Jarvis (2008) Eos citation**, must travel with the layer's **metadata** |
| **§1.4** | the "Licensed Materials" are the **HydroSHEDS version 1** layers of Exhibit A, *"not including any later versions or modifications"* | the **2026 edition is a FAO product derived from HydroRIVERS** (with FAO's own flow-regime classification added), so the **stricter upstream terms are the safe reading** for the geometry and attributes |

**HydroSHEDS version 2** (2026) is under **CC BY 4.0** with a request
rather than a restriction: *"we ask users to refrain from redistributing
the data in whole in its original format on other websites without the
explicit written permission from the authors"*. So if we ever move to v2,
the same rule applies in spirit: **rendered, not raw**.

**WHAT THIS MEANS FOR US, IN PRACTICE**

1. **We may download the 2026 edition and serve it ourselves.** The
   FAO's CC BY 4.0 permits it outright, and the upstream terms permit
   it too — with the three conditions above. There is **no
   non-commercial clause**, so nothing about the site's funding model
   is in question.
2. **We must carry the Exhibit B attribution** in the layer's metadata
   — not just the FAO credit. The FAO credit is already in
   `options.attribution`. **CLOSED 2026-11-21**, when the internal
   (endorheic) basin levels were added from a second HydroSHEDS-derived
   source and the obligation could no longer be deferred: all three
   strings — `upstream`, `upstream_attribution` (the WWF statement
   including *"WWF has not evaluated the data as altered and
   incorporated within this product"*) and `upstream_citation` (Lehner,
   Verdin & Jarvis 2008) — are now written into
   `public_html/data/basins/meta.json` **by `scripts/basin_build.py`
   itself**. They live in the builder, not only here, because the
   builder OVERWRITES meta.json: a licence text that exists only in a
   document disappears the next time anyone rebuilds (the exact failure
   `river_network_build.py` records for its own upstream text).
   Pinned by `public_html/tests/basin-detail-level.bun.test.js`, which
   asserts both that the strings are *defined* and that they are
   *written*.
3. **We must not distribute the data as a stand-alone product** — so
   the pre-render plan (our own tile pyramid) is exactly the RIGHT
   shape, and a "download the river network" link would not be.

**AND THE SIZE, WHICH IS THE ACTUAL REASON TO DO IT**

- the FAO's 2026 layer is **≥ 1,090,000 reaches** (measured: the WFS
  pages past `startIndex=900000`, and it only pages with a **stable
  sort** — `sortBy=hyriv_id`; without it the server throws an
  `IOException`);
- the upstream **HydroRIVERS product is 8.5 million reaches**,
  35.9 million km of rivers, in a **544 MB** global shapefile (618 MB
  geodatabase);
- and **the 2026 edition is published as a SERVICE only** — the FAO
  catalogue lists a WMS, a PDF and a JPEG, **no shapefile** — so
  "downloading it" means **paging the WFS**, which works (a few hours
  of fetching) but is not a file download.

**The 2026 edition is the one to fetch**: it carries the flow-regime
classification (`cls_a`…`cls_e`, `smooth_50/100/200`) that the
published style draws on, and the upstream v1 shapefile does not.

## 2. Basemaps and tiles

| Layer | Source | Terms | Status |
|---|---|---|---|
| 🗺️ Street | OpenStreetMap tiles | **ODbL** — attribution required; the tile usage policy also caps heavy use | OK — attributed |
| 🗺️ Topo | OpenTopoMap | OSM data **ODbL** + SRTM; style **CC BY-SA** | OK — attributed |
| 🛰️ Satellite / Streets / NatGeo / Terrain / Dark / Light | Esri ArcGIS Online services | Esri's terms: attribution required, and the services are licensed for the basemap use, not for bulk redistribution | **OK — CACHE ONLY, owner-approved 2026-11-07** — since 2026-11-08 these are served through our own tile mirror (`api/src/routes/tileMirror.ts`). That is a **request-driven cache, not a mirror**: a tile is fetched only because a reader asked for it, kept for at most 45 days under a 3 GB ceiling, and **revalidated against Esri on a TTL** (`If-Modified-Since`; 304 keeps the bytes, 200 replaces them, an origin outage serves the last good copy). There is **no pre-download, no crawl and no world pyramid on disk** — which is what "bulk redistribution" would mean — and the origin is asked at most once per tile per day. Attribution is unchanged and still prints in the corner. Owner, on being shown the cost: *"we don't want to save it permanently, we just want to cache it so we have live data ready when people need it"* |
| Night-lights basemap (globe) | Esri World Imagery | as above | as above — the globe's basemap goes through the same mirror (`/api/tile/mirror/esri-imagery/…`) |

## 3. Rejected: Vaisala GLD360 "Lightning Detection, Jun 2011 – Aug 2012"

### 3a. Accepted: the MIT Darwin Project phytoplankton model

For completeness, the *other* lightning-adjacent dataset we were asked
about — the phytoplankton model — **is** accepted, and its terms are:

- **MITgcm and the Darwin model are under the MIT licence.** MITgcm's
  own `LICENSE.txt`: *"Permission is hereby granted, free of charge, to
  any person obtaining a copy … to deal in the Software without
  restriction, including without limitation the rights to use, copy,
  modify, merge, publish, distribute, sublicense, and/or sell copies …
  subject to the following conditions: The above copyright notice and
  this permission notice shall be included in all copies."* That
  permits redistribution, and requires the notice.
- **The NASA side is public domain.** NASA's media usage guidelines:
  NASA content *"generally are not subject to copyright in the United
  States"*, *"News outlets, schools, and text-book authors may use NASA
  content without needing explicit permission"*, and *"NASA should be
  acknowledged as the source of the material."*
- **We publish only the extracted ocean model field.** The source
  frames carry a photographic background (the Blue Marble), and **none
  of that imagery is redistributed** — the coastline is masked out with
  Natural Earth (public domain) and only the model field is published.
  So no imagery licence is inherited.

The one thing to be careful about is the MIT notice: it must travel with
the data. The legend foot carries "MIT Darwin Project … MIT Licence" and
the attribution control prints "MIT Darwin Project / MITgcm / ECCO-2
(NASA MAP)".

### 3b. The Vaisala dataset, rejected
Offered as a second lightning dataset from NOAA's Science On a Sphere
catalogue. **Recommendation: do not add it.** The reasons, in order of
weight:

1. **There is no data.** The published files are `2160.mp4` (a 4K
   *video*), `colorbar.png`, `labels.txt` (15 month labels), a 192×192
   PNG thumbnail and an SOS playlist. The monthly maps exist only
   *baked into the video*. There is no grid and no numbers, so there
   could be no probe, no per-month values and no legend — the layer
   would be Vaisala's artwork, re-hosted, and to build it we would have
   to decode video frames and invert a colour bar.

2. **The licence is the weakest of anything we use.** The dataset's
   creator is **Vaisala** — a commercial company. NOAA's own copyright
   page says third-party media on the SOS servers "have agreed to make
   their digital media available for **educational, journalistic, and
   personal uses**, but restrictions may be placed on other uses
   (commercial or otherwise). To obtain permission for use of the
   digital media, contact the digital media creator directly."
   Every other dataset we ship carries an explicit open licence
   (CC BY 4.0, public domain) that permits any use with attribution.

3. **It is strictly worse than what we already ship.** WWLLN WGLC is
   **CC BY 4.0**, **5 arc-minutes (9.3 km) per cell**, **2020-2022**,
   with real gridded numbers and thirteen periods. GLD360 is 2011-2012,
   has an unknown grid and no numbers at all.

The one thing GLD360 has that we do not is **independence**: it is a
different network (Vaisala's VLF array) from WWLLN, so it would be a
genuine cross-check on the climatology. That value needs the numeric
data, which is not published.

## 4. RESOLVED — the Köppen climate layer's licence (fixed 2026-10-29)

### What the exposure was

The climate overlay was derived from the world map in:

> Peel, M. C., Finlayson, B. L., and McMahon, T. A.: *Updated world map
> of the Köppen-Geiger climate classification*, Hydrol. Earth Syst.
> Sci., 11, 1633–1644, <https://doi.org/10.5194/hess-11-1633-2007>, 2007.

That article is licensed **CC BY-NC-SA 2.5** — NonCommercial *and*
ShareAlike. We reached it through Gerrit Hendriksen's KML digitisation
of the published figure, and the KML itself carried no licence
statement. Our raster tiles were a derivative of a ShareAlike work,
published under no licence at all. It was the **only** dataset in the
project with a restriction beyond attribution.

### What we replaced it with

> Beck, H. E., Zimmermann, N. E., McVicar, T. R., Vergopolan, N., Berg,
> A., and Wood, E. F.: *Present and future Köppen-Geiger climate
> classification maps at 1-km resolution*, Scientific Data 5, 180214,
> <https://doi.org/10.6084/m9.figshare.6396959>, 2018. **CC BY 4.0.**

The same classification, peer reviewed, under an unrestricted licence —
and **thirty times finer**: Beck's present-day map is 1/12° ≈ 920 m per
cell against the 0.5° ≈ 55 km grid the old KML was derived from.

`scripts/koppen_build.py` reads Beck's `Beck_KG_V1_present_0p0083.tif`
(43200×21600, unsigned byte, 1..30 with 0 = ocean), cached at
`worker/data/koppen/`. The colours, descriptions and criteria in
`BECK_CLASSES` are the ones the map already used, so the 30-class key in
the layers dropdown did not change; only the classification data is
Beck's. Two places changed their meaning:

- The Amazon interior is now **Af** (rainforest) where the Peel map
  said **Am** (monsoon). The probe was updated, and an Am probe was
  added on India's monsoon coast (13°N, 75°E).
- Beck has a **Csc** class the older map did not carry, bringing the
  total from 29 to 30.

The attribution printed on the map is now
"Köppen-Geiger: Beck et al. (2018), CC BY 4.0" and the legend foot
says "Beck et al. (2018) · CC BY 4.0 · 1 km".

### Verification

`python3 scripts/koppen_build.py` runs an 11-point probe against both
the plate carrée grid and the Web Mercator warp: the Sahara, the Congo
basin, the Amazon interior, the Arabian desert, Moscow, Siberia, the
Australian outback, the US Great Plains, Antarctica, Svalbard and
India's monsoon coast. All 11 pass in both.

The licence test in `data-licences.bun.test.js` now asserts
`license === "CC BY 4.0"` and that it does **not** contain "NC",
"NonCommercial" or "ShareAlike" — so the exposure cannot come back
silently.

## 5. What is enforced, not just written down

`public_html/tests/data-licences.bun.test.js` fails the build if:

- any overlay's published `meta.json` loses its `license` or
  `attribution`;
- any overlay layer stops carrying an `attribution` string (Leaflet's
  `L.Layer.getAttribution()` puts it in the bottom-right corner);
- a licence-bearing dataset's attribution drops the licence itself.

Attribution is therefore a thing the tests know about, not a thing that
quietly disappears in a refactor.

## 6. Exports — the licence travels with the file

An export is a **derivative**. It leaves the site, and the terms of
every dataset in it travel with it:

- **CC BY 4.0** (Köppen/Beck, SoilGrids, HWSD v2.2, OpenLandMap-soildb, ESA WorldCover, Natural
  Earth, Macrostrat, WWLLN lightning) — attribution is **required**.
  The attribution string is printed on the PNG and written into the
  GeoTIFF's `GDAL_METADATA`, the GeoJSON's foreign members and the
  KML's `<description>`.
- **CC BY-SA 4.0** (the FAO hydrological basins, Glottolog) — the
  derivative is **share-alike**. A GeoJSON containing basin polygons
  or language points must carry the ShareAlike terms, and so must
  anything derived from it.
- **Public domain / US Government work** (NOAA GFS, NOAA ETOPO, NOAA
  SOS, WMM2025) — no obligation, but the source is still named.

Every ZIP export contains a `LICENSE.txt` that lists every dataset in
the archive with its attribution and its licence, plus a `README.md`
that says where the files came from.

**The story pins** are the site's own data, but the *stories* behind
them belong to their publishers. Every export that includes pins says
so, and each pin carries its publisher's URL.

### What is enforced

`public_html/tests/data-licences.bun.test.js` now also asserts that:

- every registered **export surface** carries an `attribution` and a
  `licence` (16 surfaces across 13 layer modules);
- the CC BY-SA surfaces (basins, languages) declare `CC BY-SA 4.0`;
- **no** export surface carries a NonCommercial clause;
- the writers put the attribution and the licence into the file
  (`GDAL_METADATA`, GeoJSON foreign members), and the bundle always
  writes a `LICENSE.txt`.

### The basemap is deliberately NOT exported

The PNG draws the **overlays**, not a third-party basemap. A
whole-world PNG assembled from OSM or Esri tiles would be a bulk
download, and neither tile policy allows that. Every dataset the
export does draw is ours, or is fetched from a source whose terms
permit redistribution.

`public_html/tests/export-contract.bun.test.js` pins the rest: the
contract loads before the layer modules, every layer registers, and
the attribution block names every dataset.

---

## 7. Pipeline inputs — and what the repository itself redistributes (2026-11-14)

Sections 1–6 are about what the **map renders**. This one is about two
things that are **not overlays** and were never in the table: build
inputs the pipeline reads, and the question of what the *source
repository* is allowed to hand out.

**The audit gap:** both inputs below were **committed inside the
repository** — 808 MB of it — with no entry in this file at all. The
audit covers rendered overlays and basemaps, and these are read by
workers and by the API, so neither was ever looked at. Both are
**untracked now** (2026-11-14), so nothing from either is redistributed
to GitHub, and the rows are written so the answer survives the next
question.

| Input | Read by | Licence | Status |
|---|---|---|---|
| **GeoNames `alternateNamesV2`** (`data/alternateNamesV2.txt` + `.zip`, 744 MB + 194 MB) | `worker/import_city_names.py` → the `city_names` table (search synonyms/alternate spellings) | **CC BY 4.0** — GeoNames asks for attribution and a link to geonames.org | **Not redistributed.** It also exceeds GitHub's **100 MB per-file hard limit**, so it could not be published even if we wanted to. The loader prints `https://download.geonames.org/export/dump/alternateNamesV2.zip` when it is absent. **No `verify()` gate** — the import has never checked that the row counts or the language split look sane (open). |
| **MaxMind GeoLite2 City** (`geoip/GeoLite2-City.mmdb`, 62 MB) | `api/src/geoip.ts` — offline city lookup, with `ipwho.is` / `ip-api.com` as network fallbacks | **MaxMind's own GeoLite2 terms** — free to use, requires crediting MaxMind, redistribution governed by *their* agreement, **not ours to relicense** | **Not redistributed.** Refreshed weekly by `scripts/update-geolite.sh`, which pulls from a public mirror and validates the file. **No attribution string is printed for it today** because the API does not expose geolocation as a rendered layer — if a user-visible feature ever surfaces GeoLite2-derived city names, MaxMind credit must appear with it (open). |

**The repository's own code is GPL-3.0** as of 2026-11-14 (`LICENSE`).
That covers *our* source only. It does not relicense anything in
sections 1–6: a CC BY dataset stays CC BY, CC BY-SA stays share-alike,
and US Government work stays public domain. The rule of thumb at the top
of this file still decides what may be published — the licence of a
dataset is never inherited from the licence of the code beside it.
