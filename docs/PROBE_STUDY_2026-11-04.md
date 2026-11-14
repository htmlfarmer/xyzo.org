# The probe study — one readout, under the cursor

**Date:** 2026-11-04
**Owner ask:** *"also can we study how to get a better 'tool top' or probe… can you make sure it looks correct as you move the mouse around on playwrite… the tooltip or 'probe' is kinda overlapping various data and now showing all the info correct"*
**Study:** `scripts/probe_audit.py` (the live measurement)

---

## 1. What the reader actually saw

The owner opened a map with eleven overlays on — including **both** wind
layers — and moved the pointer around. What came up was three boxes,
stacked on the same 14 pixels, and two numbers for the same air.

Measured with Playwright on the live site, pointer at (800, 500):

```
.wind-probe        [814, 514, 196, 44]   "2.3 m/s · 8 km/h · 4 kt   from SE (145°)"
#wind-speed-probe  [814, 514, 139, 26]   "2.4 m/s · 9 km/h"          <- ON TOP
.climate-probe     [914, 574, 205, 30]   "Aw  Tropical - Savannah"    <- ON TOP
```

Three separate defects, which look like one:

| # | the defect | why it happened |
|---|---|---|
| **A** | the boxes cover each other | every layer positioned its OWN box at `containerPoint + 14px` — the same 14px |
| **B** | two wind numbers, and they disagree | the wind animation and the wind-SPEED field are the same u/v pair, but one interpolated `u` and `v` and took the magnitude, and the other interpolated a pre-derived magnitude grid. `bilinear(u,v) → hypot` is **not** `bilinear(hypot(u,v))`. |
| **C** | the units were wrong for the reader | m/s everywhere; the owner asked for miles/hour, knots and km/h. |

There was a fourth, found while measuring: **the wind-SPEED field was
absent from the hover card entirely.** With the animation off and the
speed field on, "Everything" mode said nothing at all about the wind.

---

## 2. What the DATA said (the other half of the question)

The owner's separate worry — *"our maps don't look correct, they show
different pressure lines and wind direction than windy.com"* — was
checked before anything was changed.

### The wind is right

| check | result |
|---|---|
| published `grid.bin` vs the raw GRIB message, cell by cell | **65,160 cells, max diff 0.0042 m/s, 0 cells over tolerance** |
| the browser's reading vs the grid, sampled independently in Python | **51 pointer positions, every bearing within 22.5°** (the compass point's own width) |
| vs Open-Meteo's GFS (a completely different code path, same NOAA analysis) | 6.93 vs 6.76 m/s, from 237.6° vs 262° at 40.9N 64.7W |
| the wind against the pressure field (geostrophic balance) | median **24.1°** off the geostrophic wind; **85.4 %** of the flow has a component towards the low |
| the wind against the temperature field (advection) | **59.5 %** advecting cold air |
| **the control** — a deliberately mirrored wind field | **detected** (52.0° vs 24.1°) |

The bearing arithmetic is right: `from = atan2(−u, −v)` with `u`
eastward and `v` northward, and on a Web Mercator screen the direction
of a ground vector is **`(u, −v)`** — the `cos(lat)` in the geographic
displacement and the `1/cos(lat)` of the Mercator y-axis cancel.

### The isobars are right

The isobars the map serves are contours of a **0.5°-blurred** GFS
0.25° MSLP field, and the check compares the pressure read at a point
**on** a served line with that line's own level:

| against | mean | median \|e\| | p95 \|e\| | max \|e\| |
|---|---|---|---|---|
| the field the isobars were cut from (0.25° GFS) | **+0.005 hPa** | **0.001 hPa** | **0.029 hPa** | 0.271 hPa |
| a 1° GFS field (what the audit used) | −0.052 hPa | 0.398 hPa | 1.355 hPa | 4.696 hPa |

So the isobars are accurate to **three hundredths of a hPa** — and the
audit was measuring them against the wrong field, which made GFS look a
hundred times worse than ECMWF. (Fixed in `worker/gfs_verify.py`; see
the README row.)

### So why do they differ from windy.com?

Four reasons, none of them a bug — and one of them was a **missing
feature**:

1. **Different model.** windy.com draws **ECMWF** by default. The map
   drew **GFS**, because the API's `auto` picks the newest analysis
   that covers the viewport — and GFS lands ~3.5 h after its run while
   ECMWF lands ~8.5 h, so GFS is usually the fresher one.
2. **Different analysis time.** Even the same model is a different
   picture six hours later.
3. **Different contour interval.** windy.com draws 2 or 4 hPa; the
   map can draw 1, 2, 4, 8 or 16 — the owner's own link asked for
   `iso=1`, which is 1,122 lines against ~270.
4. **A different interpolation.** The map's field is Gaussian-blurred
   by 0.5° before it is contoured (that is what removes the
   analysis-grid staircase), so a line sits a fraction of a degree
   from where an unblurred contour would.

**The missing feature:** the API has always supported
`source=ecmwf|gfs|hrrr`, and the reader had **no way to ask for one**.
A choice the reader cannot make is a mystery, and a mystery is a bug
report. So there is now a picker — see §4.

---

## 3. The probe fix — ONE positioner

New file: **`public_html/probe-stack.js`**.

Every readout on the map now goes through one positioner:

```
.wind-probe          ┐
#wind-speed-probe    │  the layer probes, in the map container
.climate-probe       │  → container points
.temp-probe          │
.field-probe         ┘
.hover-hud           ──  the hover card, fixed on <body> → viewport points
```

* the column starts at **cursor + 14px** (the house offset) and each box
  is placed below the previous one, **3px** apart;
* a box that would run off the **right** edge flips to the **left** of
  the cursor;
* a column that would run off the **bottom** flips **above** the
  cursor;
* the **hover card is the top of the column**, so the card never covers
  a layer's reading — it used to sit at the same 14px, so hovering a
  story pin showed the card ON TOP of the wind and climate readings.

The two coordinate systems are handled explicitly: the layer probes are
`position: absolute` inside the map container (container points) and
the card is `position: fixed` on `<body>` (viewport points), so the
stacker writes each back in its own system.

**The layers keep their own boxes.** A climate probe carries a colour
swatch and a class name; a wind probe carries a compass point; the
temperature probe carries a °C/°F pair. Merging them into one card
would mean eleven layers giving up their own probe markup, and the
ARMED (tap-to-read) probes on a touch device are a deliberate
single-layer action with a different life cycle. Stacking fixes the
overlap with one positioner and touches nothing else.

### The two wind readings are now ONE reading

The wind-SPEED field is the **magnitude of the wind animation's own
u/v pair** — the same air. So:

* it now samples the **same vector** the animation samples
  (`WindLayer.sampleVector`), so the number is identical to the digit;
* and it **stands down** when the animation is on, because the
  animation's probe already carries the speed *and* the direction. With
  the animation off, the speed field speaks on its own.

Verified in the browser: the animation says `5 mph · 8 km/h · 4 kt
from SE (145°)` and the speed field, with the animation off, says
`5 mph · 8 km/h · 4 kt` — the same number.

---

## 4. The analysis picker

The isobar legend now carries a third chip row under the detail and
colour rows:

| chip | analysis | note |
|---|---|---|
| **Auto** | the newest that covers the view | the old behaviour; the default |
| **ECMWF** | ECMWF IFS 0.1° | the finer grid, ~8.5 h older — **what windy.com draws** |
| **GFS** | NOAA GFS 0.25° | the fresher global analysis |
| **HRRR** | NOAA HRRR 3 km | hourly, North America only |

The choice travels with the link (`/isoSrc=ecmwf`), with the saved
style and with the presets — the same grammar a shared URL speaks. It
is written **always** when the isobars are on, for the same reason the
step and the colour are: omitting it leaves the *reader's* stored
choice to decide, so a sender looking at ECMWF would hand a receiver on
GFS a link that opens on GFS.

The globe reads it too (`globeIsoSource()`), because the 2D↔3D
handoff passes unknown hash parts through untouched.

**A chip for an analysis that is not published is DISABLED.** There is
**no HRRR worker** — nothing has ever published an HRRR isobar row — so
the layer asks the API what it actually holds
(`/api/weather/isobars/meta`) and greys that chip out. A chip that
offers an analysis and then quietly draws something else is a control
lying about what is on screen, which is the exact failure this repo is
written against. When the API does serve something other than what was
asked for (a link saying `isoSrc=hrrr`, an analysis that is not loaded),
the chip says so — *"the map is drawing NOAA GFS 0.25° instead"* — and
the attribution bar names what was actually drawn.

---

## 5. The units

Owner ask: *"remove m/s and add miles/hr and kt and km/hr"*.

**m/s is gone from every reader-facing wind reading.** It stays the
**data** unit — the published grid, the colour ramp and the export band
names (`wind_u_m/s`, `wind_v_m/s`) are all in m/s, and they must stay
in the unit the source speaks. Only the **display** converts.

```
14 mph · 22 km/h · 12 kt
```

All three are integers, which is what every weather service prints and
what windy.com prints. A calm wind still reads `0 mph · 1 km/h · 1 kt`,
so the light air is never lost.

The legend's scale labels moved with it (`Slow 0 mph · fast 62 mph`).

**Not changed:** the **ocean current** layer still reads m/s. A current
is a different quantity from a wind and m/s is its SI convention; the
owner's ask was about the wind. Flagged here so it is a decision and
not an oversight.

---

## 6. How it is kept true

* **`scripts/probe_audit.py`** — drives a real browser, sweeps the
  pointer over a grid of positions and checks three things: **no two
  readouts overlap**, **nothing runs off the screen**, and **every
  wind reading matches the published grid** (sampled independently in
  Python). It exits non-zero when it finds a problem.

  Current result: **51 positions, 0 overlaps, 0 off-screen, every
  reading matched.**

* **`public_html/tests/probe-stack.bun.test.js`** — the module
  contract: the list of probe classes the stacker knows (a probe class
  it does not know about is a box that is never stacked), the edge
  flips, the two coordinate systems, the load order, and the
  cache-token stamp.

* **`public_html/tests/isobar-source.bun.test.js`** — the analysis
  picker: the choices, the fetch, the requested-vs-served distinction,
  the link grammar, the "applied before the layer is enabled"
  ordering, and the globe's half.

* **`public_html/tests/wind-physics.bun.test.js`** — the units, and a
  test that **m/s is gone** from the readout.

---

## 7. What was NOT changed

* The **hover card's own modes** (Off / Pins / Everything) and its
  per-layer checkbox list. They work, and the card is now the top of
  the probe column rather than a rival to it.
* The **armed (tap-to-read) probes** on touch devices. They are a
  deliberate single-layer action and keep their own behaviour.
* The **leaflet popups** (the basin, language and language-region
  probes) — they are click-driven, not hover-driven, and Leaflet
  positions them.
* The **story-link tooltip** (`xyzo-link-tooltip`), a Leaflet tooltip
  on a specific arc. It can still overlap the column; it is a
  different surface and the two rarely coexist.
