# Why our maps look different from windy.com — measured, 2026-11-04

**Owner ask:** *"im not really following why our maps look so different from windy.. shouldnt tehy be very similar or betteR?"* and *"can we get new data say every 10 min so we have really accurate temp/pressure weather maps?"*

Everything below is a MEASUREMENT, not an opinion. Every number was
taken from the running site or from the raw GRIB messages.

---

## 1. The short answer

| | windy.com (default) | ours — before | ours — after |
|---|---|---|---|
| pressure | **ECMWF 9 km** | GFS 0.25° | **either** — the reader picks |
| temperature | ECMWF 9 km | GFS **1°** | GFS **0.25°** |
| wind | ECMWF 9 km | GFS **1°** | GFS **0.25°** |
| how old | the newest cycle | up to **6 h** behind it | **≤ 15 min** behind it |

Three things were different, and all three are now fixed or
choosable:

1. **THE MODEL.** windy.com draws **ECMWF 9 km** — read straight off
   its own model selector ("ECMWF 9km | GFS 22km | ICON 13km"). We
   drew **GFS**, because the API picks the newest analysis covering the
   viewport. There is now an **analysis picker** in the isobar legend
   (**Auto · ECMWF · GFS · HRRR**), and the choice travels with the
   link.
2. **THE RESOLUTION.** Our wind and temperature were published at
   **1°** — the isobars had always been 0.25°. They are now 0.25°.
3. **THE FRESHNESS.** The workers polled every **6 hours**, so the map
   could sit on a stale cycle for hours — and if NOMADS published a run
   late, the map would **miss that cycle entirely**. They now poll every
   **15 minutes**.

## 2. "New data every 10 minutes" — what is actually possible

**There is no global analysis at 10-minute cadence.** The GFS and the
ECMWF IFS analyses are **6-hourly** (00/06/12/18Z); HRRR is **hourly**
and covers North America only. Ten-minute cadence belongs to *nowcasts*
(radar assimilation), not to a global analysis.

What **is** achievable — and is what we did — is to stop sitting on a
stale cycle:

* the three GFS workers now poll **every 15 minutes** instead of every
  six hours, so a new cycle is picked up within minutes of NOMADS
  publishing it rather than up to six hours later;
* each worker compares the **cycle AND the product** before fetching,
  so the poll is nearly free when nothing has changed (the isobar
  worker went from **5 minutes to 1 second** on a no-op tick, and the
  ECMWF fetch — four minutes of work for a twice-daily product — is
  skipped entirely);
* the product comparison matters: comparing the cycle alone would have
  declared "already published" when the **resolution** changed, and
  the new 0.25° grid would never have shipped.

**The real accuracy lever is the SOURCE, not the cadence.** Our
isobars are already 0.25°; the ECMWF IFS 0.1° copy is published beside
them and is now one chip away.

## 3. Why the LINES looked different even though the numbers agreed

This is the part that is genuinely counter-intuitive, so it is worth
setting out.

**At a point, the two models agree closely.** GFS vs ECMWF, the same
hour, twelve points:

| | median | worst |
|---|---|---|
| wind direction | **7°** | 36° |
| temperature | **0.6 °C** | 2.2 °C |
| sea-level pressure | **0.6 hPa** | 5.4 hPa |

**But the LINES are far apart.** The *same* pressure level drawn by
both models — 1000, 1008, 1012, 1016 and 1020 hPa — was measured at:

| level | median apart | p95 | max |
|---|---|---|---|
| 1000 hPa | **233 km** | 2,111 km | 3,499 km |
| 1008 hPa | **234 km** | 2,692 km | 3,295 km |
| 1012 hPa | **223 km** | 2,249 km | 3,345 km |
| 1016 hPa | **202 km** | 2,427 km | 3,440 km |
| 1020 hPa | **185 km** | 2,852 km | 3,633 km |

**Why:** in a weak gradient (a few hPa over a thousand kilometres), a
0.6 hPa difference moves an isobar a couple of hundred kilometres. Over
a deep low the models disagree about the low's *shape*, and the lines
separate by thousands of kilometres. The **weather** is the same; the
**line** is somewhere else.

At zoom 3, 215 km is about twenty pixels — plainly visible.

**So: our map was not wrong, and it was not "worse".** It was a
different model at a coarser resolution, showing the same atmosphere.

## 4. The resolution finding — the one that was a real bug

The wind was published at **1°** because the grid is held in the
browser and 0.25° was thought too heavy for "a vector field whose
direction barely changes across a cell".

**That last part is false, and it was measured.** The **same GFS
cycle** at 1° and at 0.25°, at twenty-four points:

| | 1° (published) | 0.25° (truth) |
|---|---|---|
| direction — median | 0° | 0° |
| direction — **p90** | **41°** | 0° |
| direction — **worst** | **78°** | 0° |
| speed — worst | 4.2 m/s | — |

Nineteen of the twenty-four points agree exactly, and then **Nairobi
is 78° out** and **Sydney 41° out** — the two places where the flow has
structure finer than a degree (the Albertine convergence zone and the
Australian sea breeze). A reader pointing at those two places was being
told the wind blew from the north when the analysis said north-east.

**The published 0.25° grid now reads "from NE (47°)" at Nairobi,
where it used to read "from NNW (335°)".** Against Open-Meteo's GFS —
a completely different code path reading the same NOAA analysis — the
same point now agrees to **3.8°** (it was 78°).

The cost: **3.96 MB raw / ~2.8 MB gzipped**, against 255 KB / 196 KB.
It is paid by the readers who switch the wind layer **on**, which is
the right place to pay it. The **globe** keeps a 1° copy — written by
the same run from the same fetch, so the two cannot disagree — because
the globe draws 900 streaks on a sphere and shows no numbers at all.

The **temperature** moved to 0.25° too (1.98 MB raw / ~0.7 MB
gzipped; median error 0.0 °C, worst **2.4 °C** at Sydney), so that all
three GFS overlays are the same resolution as each other.

## 5. What was verified, and how

| check | tool | result |
|---|---|---|
| the published wind IS the GFS analysis | `worker/wind_verify.py` | **1,038,240 cells**, max diff **0.0034 m/s**, 0 over tolerance |
| the published temperature IS the GFS analysis | `worker/gfs_verify.py` | 1,038,240 cells, 0 over tolerance |
| the published isobars ARE contours of the field | `worker/gfs_verify.py` | mean **+0.005 hPa**, p95 **0.029 hPa** |
| the wind runs along the isobars | `worker/gfs_verify.py` | median **22.2°** off geostrophic, **91.5 %** flowing towards the low |
| the wind advects cold air | `worker/gfs_verify.py` | **59.4 %** |
| the **mirrored-wind control** is detected | `worker/gfs_verify.py` | **yes** (50.1° vs 22.2°) |
| the wind vs an independent GFS reader | `worker/wind_verify.py --reference` | Nairobi **3.8°**, London **0.1°**, Tokyo **3.1°** |

## 6. What a reader should do to compare like with like

1. Open the isobar legend and pick **ECMWF** — that is what windy.com
   draws. (Or leave it on **Auto** and accept the fresher GFS.)
2. Set the detail to **4 hPa**, not 1 hPa — 1 hPa is 1,117 lines and a
   hairball; windy.com draws 2 or 4.
3. Compare the **numbers**, not the lines: the probe against windy.com's
   forecast panel should agree within a degree or two.

## 7. What was NOT done, and why

* **HRRR.** The API has always accepted `source=hrrr`, and the
  **isobar picker** offers it — but there is **no HRRR worker**, so
  nothing has ever published an HRRR isobar row. **The chip is
  disabled and says why.** Building it needs a Lambert-projection
  contouring path, because HRRR is not a lat/lon grid. That is the real
  "hourly, 3 km, North America" answer and it is the next piece of
  work, not this one.
* **An ECMWF wind overlay.** The ECMWF IFS u/v is available from the
  same open-data endpoint the isobars already use. It would be the
  closest match to windy.com's default. Not built here: the wind grid
  is a flat file the browser holds, and publishing a second model's
  wind means a second grid, a second export surface and a second set of
  layer controls.
* **A 10-minute cadence.** No such global product exists.
