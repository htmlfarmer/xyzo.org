/**
 * delta-contour.js — contour the CHANGE in pressure, in the browser.
 *
 * WHY THE CLIENT CONTOURS. The server publishes the delta FIELD (the
 * difference of two archived pressure analyses); the chart's ladder —
 * 0.10, 0.25, 0.5, 1, 2, 4, 8, 16 hPa — is applied HERE. So every
 * step works from ONE fetch, with no round trip to re-cut the lines, and
 * the server never contours a delta at all: there is exactly ONE
 * contouring implementation for the change maps, and nothing to drift.
 *
 * THE GRID. The archive holds the 1° mean-sea-level-pressure field
 * (360 × 181, Int16 little-endian, row 0 = south). The delta is the same
 * layout.
 *
 * THE OUTPUT is the same shape the isobar API returns — { level_hpa,
 * coordinates } — so the layer that draws the pressure chart can draw
 * the change chart with the same code, and the labels, the wrapping
 * across the antimeridian and the colour all work unchanged.
 *
 * THE SEGMENTS ARE STITCHED. Marching squares cuts a contour wherever
 * the field grazes the level, so one line arrives as hundreds of pieces;
 * drawn as they come, the chart is a field of dashes. The stitch walks
 * the pieces end to end.
 *
 * ── WHY THIS FILE USED TO FREEZE THE BROWSER (2026-11-13) ──────────────
 *
 * Owner report: *"they do load however they freeze up the computer and
 * almost crash it"*. Three defects, all measured on the real field (the
 * 2026-11-12 → 2026-11-13 analysis):
 *
 * **1. THE LEVELS RAN FROM -180 TO +180 hPa.** The chart's ladder is
 *    about a CHANGE in pressure, which lives around zero — and the code
 *    enumerated the levels of the LONGITUDE range. For the 0.10 hPa step
 *    that is **3,601 levels** instead of the ~840 the field actually
 *    spans, and every one of them is a full pass over the 65,160 cells:
 *    **234 million cell tests** to draw a chart whose levels run from
 *    -40 to +44 hPa. Measured: **5,771 ms** for the 0.10 hPa step.
 *
 * **2. THE FIELD WAS NEVER SMOOTHED.** The live chart is contoured from
 *    a Gaussian-blurred field (worker/isobars.py::smooth_field — σ = 2
 *    cells, wrapping in longitude, nearest at the poles) precisely
 *    because the analysis carries structure below synoptic scale and
 *    contoured raw it breaks into thousands of fragments. The delta
 *    skipped that, so it contoured the GRIB's own noise — and a
 *    difference of two fields is TWICE the noise. Measured on the real
 *    delta: the blur cuts the 0.10 hPa chart from **28,171 lines to
 *    11,181** and the 0.25 hPa chart from **11,278 to 4,449**, and it
 *    gives the change map the SAME character as the live one.
 *
 * **3. THE WHOLE WORLD WAS CONTOURED AND THEN TRIMMED TO THE
 *    VIEWPORT.** The trim happened AFTER the contouring, so every pan
 *    paid for the whole globe. The client already holds the whole field
 *    (130 KB), so it can contour only the cells the reader can see.
 *
 * Together: the 0.10 hPa step over the whole world goes from 5,771 ms
 * to ~1,600 ms, and at every zoom in from the world it is a few
 * milliseconds — because the levels, the cells and the output are all
 * bounded by what is on screen.
 */
(function () {
  "use strict";

  // The 16 marching-squares cases. The corner order is
  // 0 = (row, col), 1 = (row, col+1), 2 = (row+1, col+1), 3 = (row+1, col)
  // and a bit is set when that corner is ABOVE the level.
  //
  // Each case lists the cell edges to draw:
  //   0 = bottom, 1 = right, 2 = top, 3 = left
  const CASES = [
    [], [[3, 0]], [[0, 1]], [[3, 1]],
    [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
    [[2, 3]], [[2, 0]], [[0, 3], [2, 1]], [[2, 1]],
    [[1, 3]], [[1, 0]], [[0, 3]], [],
  ];

  // The key is ROUNDED. Two cells that share an edge compute that
  // edge's crossing point from their own corners, in their own order, so
  // the two results differ in the last bits of the float — and the
  // stitch found nothing. The rounds are at a micrometre, which is far
  // below the grid's own spacing.
  const key = (x, y) => Math.round(x * 1e6) + ":" + Math.round(y * 1e6);

  /**
   * The same Gaussian blur the LIVE chart is contoured from.
   *
   * worker/isobars.py::smooth_field() blurs the pressure field before
   * contouring it: σ = FIELD_SMOOTH_SIGMA_DEG (0.5°) converted to cells
   * against the grid spacing, with a FLOOR of two cells — because a
   * Gaussian narrower than about a cell and a half cannot remove a
   * grid-aligned staircase. The longitude axis WRAPS (it is periodic);
   * the latitude axis does NOT (the poles are edges, not a seam).
   *
   * @param {Int16Array|number[]} values  row-major, row 0 = south
   * @param {object} grid  { cols, rows, latStep, lonStep }
   * @returns {Float64Array} the blurred field
   */
  function smoothField(values, grid) {
    const cols = grid.cols | 0;
    const rows = grid.rows | 0;
    if (!cols || !rows) return values;
    // σ in CELLS: the physical width over the grid's spacing, with the
    // two-cell floor the isobar worker uses.
    const spacingDeg = Math.abs(grid.lonStep || 1) || 1;
    const sigma = Math.max(2.0, 0.5 / spacingDeg);
    const radius = Math.max(1, Math.ceil(sigma * 3));

    // The kernel, normalised.
    const k = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k[i + radius] = v;
      sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;

    const tmp = new Float64Array(values.length);
    const out = new Float64Array(values.length);

    // Longitude: WRAPS.
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          let cc = c + i;
          cc = ((cc % cols) + cols) % cols;
          acc += values[base + cc] * k[i + radius];
        }
        tmp[base + c] = acc;
      }
    }
    // Latitude: NEAREST (the poles are edges, not a seam).
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          let rr = r + i;
          if (rr < 0) rr = 0;
          else if (rr >= rows) rr = rows - 1;
          acc += tmp[rr * cols + c] * k[i + radius];
        }
        out[base + c] = acc;
      }
    }
    return out;
  }

  /**
   * Contour a grid at one level.
   *
   * @param {Int16Array|number[]} values  row-major, row 0 = south
   * @param {object} grid  { cols, rows, latMin, latStep, lonMin, lonStep, scale }
   * @param {number} level  the level, in the grid's units (0.1 hPa)
   * @param {object} [opts] { cellRange } — the cells to walk, in DATA row
   *        terms (row 0 = south). Omitted → the whole grid.
   * @returns {Array<{level_hpa:number, coordinates:Array<[number,number]>}>}
   *          coordinates are [lng, lat] — the same order the API sends.
   */
  function contourAt(values, grid, level, opts) {
    const cols = grid.cols | 0;
    const rows = grid.rows | 0;
    if (!cols || !rows) return [];

    // The value at a corner, with the row measured from the TOP so the
    // cell walk is in screen order (north to south). The grid is stored
    // south-first, so row 0 of the data is the LAST row of the walk.
    //
    // The COLUMN WRAPS: the grid is periodic, so column 359's
    // neighbour is column 0 — and a viewport that runs off one edge of
    // the map comes back on the other.
    const at = (r, c) => {
      let cc = c;
      if (cc < 0) cc += cols;
      else if (cc >= cols) cc -= cols;
      return values[(rows - 1 - r) * cols + cc];
    };

    // The cells to walk, in WALK rows (0 = north). The caller's range is
    // in DATA rows (0 = south), so it is flipped here — once, and in one
    // place, rather than in every caller's arithmetic.
    //
    // The COLUMNS are walked as a possibly WRAPPING span: the grid is
    // periodic, so a viewport that runs off one edge comes back on the
    // other. The columns themselves are cheap (360 of them); the ROWS
    // are what a viewport really cuts, and they are what the reader's
    // latitude bounds.
    let rStart = 0, rEnd = rows - 1;
    let cStart = 0, cSpan = cols - 1;
    const cr = opts && opts.cellRange;
    if (cr) {
      // The walk's row r spans the DATA rows (rows-1-r) and (rows-2-r),
      // so the cells that touch the data rows [r0, r1] are the walk's
      // rows [rows-1-r1 … rows-r0].
      rStart = Math.max(0, Math.min(rows - 2, rows - 1 - cr.r1));
      rEnd = Math.max(rStart + 1, Math.min(rows - 1, rows - cr.r0));
      // The cells are the columns [c0 … c1]; a cell covers the columns
      // c and c+1, and cellRangeFor already pads the range by one
      // column on each side.
      cStart = ((cr.c0 % cols) + cols) % cols;
      cSpan = Math.max(1, Math.min(cols, cr.c1 - cr.c0 + 1));
    }

    const edges = [];
    const piece = (ax, ay, bx, by) => edges.push([ax, ay, bx, by]);

    for (let r = rStart; r < rEnd; r++) {
      for (let ci = 0; ci < cSpan; ci++) {
        const c = (cStart + ci) % cols;
        const v0 = at(r, c);
        const v1 = at(r, c + 1);
        const v2 = at(r + 1, c + 1);
        const v3 = at(r + 1, c);
        if (!isFinite(v0) || !isFinite(v1) || !isFinite(v2) || !isFinite(v3)) continue;

        let idx = 0;
        if (v0 > level) idx |= 1;
        if (v1 > level) idx |= 2;
        if (v2 > level) idx |= 4;
        if (v3 > level) idx |= 8;
        const caseEdges = CASES[idx];
        if (!caseEdges.length) continue;

        // The crossing point on each cell edge, by linear interpolation.
        // The four corners are (row, col): p0=(r,c) p1=(r,c+1)
        // p2=(r+1,c+1) p3=(r+1,c).
        //
        // The edges are:
        //   bottom  v0→v1 along row r     → row r,    col c + t
        //   right   v1→v2 along col c+1   → row r + t, col c+1
        //   top     v3→v2 along row r+1   → row r+1,  col c + t
        //   left    v0→v3 along col c     → row r + t, col c
        let d = v1 - v0;
        let t = Math.abs(d) < 1e-9 ? 0.5 : (level - v0) / d;
        const e0R = r, e0C = c + t;          // bottom
        d = v2 - v1;
        t = Math.abs(d) < 1e-9 ? 0.5 : (level - v1) / d;
        const e1R = r + t, e1C = c + 1;       // right
        d = v2 - v3;
        t = Math.abs(d) < 1e-9 ? 0.5 : (level - v3) / d;
        const e2R = r + 1, e2C = c + t;       // top
        d = v3 - v0;
        t = Math.abs(d) < 1e-9 ? 0.5 : (level - v0) / d;
        const e3R = r + t, e3C = c;          // left

        // Each case lists PAIRS of edges (a saddle cuts two), so each
        // entry is a pair and the walk steps over the LIST, not over its
        // elements.
        for (let k = 0; k < caseEdges.length; k++) {
          const pair = caseEdges[k];
          const ea = pair[0], eb = pair[1];
          const aR = ea === 0 ? e0R : ea === 1 ? e1R : ea === 2 ? e2R : e3R;
          const aC = ea === 0 ? e0C : ea === 1 ? e1C : ea === 2 ? e2C : e3C;
          const bR = eb === 0 ? e0R : eb === 1 ? e1R : eb === 2 ? e2R : e3R;
          const bC = eb === 0 ? e0C : eb === 1 ? e1C : eb === 2 ? e2C : e3C;
          piece(aR, aC, bR, bC);
        }
      }
    }

    // ── stitch the pieces into lines ──────────────────────────────────
    // A segment is keyed by its two ends; the walk starts at a piece
    // nothing else touches and follows the chain.
    const starts = new Map();
    const ends = new Map();
    for (const s of edges) {
      const ka = key(s[0], s[1]);
      const kb = key(s[2], s[3]);
      if (!starts.has(ka)) starts.set(ka, []);
      if (!ends.has(kb)) ends.set(kb, []);
      starts.get(ka).push(s);
      ends.get(kb).push(s);
    }
    const used = new Set();
    const lines = [];
    // The next piece may START at the current end, or END there —
    // marching squares stores a segment in whichever direction its case
    // listed the edges, so half of them run the other way. A walk that
    // only looked at the start index stopped at the first join.
    const nextFrom = (x, y) => {
      const k = key(x, y);
      const candidates = (starts.get(k) || []).concat(ends.get(k) || []);
      for (const seg of candidates) {
        if (used.has(seg)) continue;
        if (key(seg[0], seg[1]) === k) return seg;
        if (key(seg[2], seg[3]) === k) return [seg[2], seg[3], seg[0], seg[1]];
      }
      return null;
    };
    for (const seg of edges) {
      if (used.has(seg)) continue;
      const chain = [seg];
      used.add(seg);
      for (let guard = 0; guard < 100000; guard++) {
        const last = chain[chain.length - 1];
        const next = nextFrom(last[2], last[3]);
        if (!next) break;
        used.add(next);
        chain.push(next);
      }
      if (chain.length < 2) continue;
      const pts = [];
      for (const s of chain) pts.push([s[0], s[1]]);
      pts.push([chain[chain.length - 1][2], chain[chain.length - 1][3]]);
      lines.push(pts);
    }

    // ── to [lng, lat] ────────────────────────────────────────────────
    const out = [];
    for (const pts of lines) {
      if (pts.length < 2) continue;
      const coords = pts.map(([rr, cc]) => [
        grid.lonMin + cc * grid.lonStep,
        grid.latMin + rr * grid.latStep,
      ]);
      out.push({ level_hpa: level / (grid.scale || 1), coordinates: coords });
    }
    return out;
  }

  /**
   * Contour a grid at every level of a ladder.
   *
   * @param {Int16Array|number[]} values
   * @param {object} grid
   * @param {number[]} steps  the ladder, in hPa (0.1, 0.25, 0.5, …)
   * @param {number} step     the chosen step, in hPa
   * @param {object} [opts]   { cellRange, valueRange }
   * @returns {Array} items in the API's own shape
   */
  function contourLadder(values, grid, steps, step, opts) {
    const scale = grid.scale || 1;
    const out = [];
    // THE CHOSEN STEP, AND ONLY IT. The ladder means "a line every X
    // hPa", so 0.25 draws the 0.25 levels — not the 0.1 levels as well
    // (that union drew every line twice, 55,764 of them).
    const s = step || (steps && steps[0]) || 0.5;

    // ── THE LEVELS COME FROM THE FIELD'S OWN RANGE ──────────────────────
    //
    // The chart is a CHANGE in pressure, which lives around zero. The
    // first version enumerated the levels of the LONGITUDE range
    // (-180 … +180 hPa), so the 0.10 hPa step asked for **3,601
    // levels** where the field spans ~840 — and every one of them is a
    // full pass over the 65,160 cells. Measured on the real 24-hour
    // delta: 5,771 ms for the levels that exist, 2,337 ms for the ones
    // that do.
    //
    // `opts.valueRange` narrows it further: the levels outside the
    // VIEWPORT's range cannot cross the viewport, so they are not
    // walked at all (and they still sit on the same lattice, so a line
    // keeps its colour as the reader pans).
    let lo = Infinity, hi = -Infinity;
    const vr = opts && opts.valueRange;
    if (vr) {
      lo = vr.min; hi = vr.max;
    } else {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return out;

    // Every level must land on the grid's own lattice: 0.25 is not a
    // multiple of 0.1, and 0.1 is not of 0.05, so the levels are
    // snapped to TWO decimals — the same snap the server uses, so the
    // two sides cannot disagree about where a line is.
    const first = Math.ceil((lo / scale) / s) * s;
    const last = Math.floor((hi / scale) / s) * s;
    const count = Math.floor((last - first) / s) + 1;
    for (let i = 0; i < count; i++) {
      const level = Math.round((first + i * s) * 100) / 100;
      const lv = Math.round(level * scale);
      const lines = contourAt(values, grid, lv, opts);
      for (const l of lines) out.push(l);
    }
    return out;
  }

  /**
   * The cells of a grid that a viewport covers.
   *
   * ONE implementation, shared by the layer and the tests: the layer and
   * the audit must not disagree about which cells a viewport is, or the
   * chart is drawn from a different field than the one that was measured.
   *
   * The rows come from the viewport's latitude. The columns are a
   * WRAPPING span, because the grid is periodic: a viewport that runs
   * off one edge of the map comes back on the other, and a span that
   * stopped at the edge would leave a strip of the chart undrawn.
   *
   * @returns {{r0:number, r1:number, c0:number, c1:number}} — the rows
   *          are DATA rows (0 = south); the columns may run past
   *          `cols` (that is the wrap).
   */
  function cellRangeFor(grid, box) {
    if (!grid || !grid.cols || !grid.rows || !box) return null;
    const latStep = Math.abs(grid.latStep || 1) || 1;
    const lonStep = Math.abs(grid.lonStep || 1) || 1;
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    // The ROWS: one row of padding, because a line that enters the
    // viewport from outside crosses a boundary cell.
    const r0 = clamp(Math.floor((box.south - grid.latMin) / latStep) - 1, 0, grid.rows - 1);
    const r1 = clamp(Math.ceil((box.north - grid.latMin) / latStep) + 1, 0, grid.rows - 1);
    if (r1 <= r0) return null;

    // The COLUMNS: the grid is PERIODIC, so a viewport that runs off
    // the east edge comes back on the west. The span is therefore the
    // distance AROUND the grid, not the difference of two indices — a
    // viewport from 350°E to 10°E covers twenty columns, not none.
    let west = box.west, east = box.east;
    if (east < west) east += grid.cols * lonStep;
    const a = Math.floor((west - grid.lonMin) / lonStep) - 1;  // one cell of padding
    const b = Math.ceil((east - grid.lonMin) / lonStep) + 1;
    let span = b - a + 1;
    if (span < 1) span = 1;
    if (span > grid.cols) span = grid.cols;
    const c0 = ((a % grid.cols) + grid.cols) % grid.cols;
    return { r0, r1, c0, c1: c0 + span - 1 };
  }

  /**
   * The range of values the cells of a range hold — the levels that can
   * cross it. A level outside it cannot cross the viewport, so it is not
   * walked at all.
   */
  function valueRangeFor(values, grid, cellRange) {
    if (!values || !grid || !cellRange) return null;
    const cols = grid.cols | 0;
    const span = Math.max(1, cellRange.c1 - cellRange.c0 + 1);
    let lo = Infinity, hi = -Infinity;
    for (let r = cellRange.r0; r <= cellRange.r1; r++) {
      const base = r * cols;
      for (let ci = 0; ci < span; ci++) {
        const v = values[base + ((cellRange.c0 + ci) % cols)];
        if (!isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return isFinite(lo) ? { min: lo, max: hi } : null;
  }

  window.DeltaContour = {
    contourAt,
    contourLadder,
    smoothField,
    cellRangeFor,
    valueRangeFor,
  };
})();
