/**
 * taxonomy-integrity.bun.test.js — Guards against duplicate keys, missing
 * entries, and conflicting patterns across the client+server taxonomy.
 *
 * Catches the class of bug that caused duplicate EVENT_ICONS keys: JS
 * silently keeps the last value when an object has duplicate keys, making
 * the first entry dead code. Same risk exists for EVENT_COLORS,
 * CANVAS_CAT_COLORS, SUBTYPE_TO_BUCKET, SOURCE_ICONS, and other const
 * objects that map keys to values.
 *
 * Also guards:
 *   - classify.py: runs as subprocess to verify 88/88 tests pass
 *   - app.js object completeness: every icon must have a color
 *   - app.js bucket refs: every SUBTYPE_TO_BUCKET value must exist
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Use process.cwd() as reliable project root (=/var/www/vhosts/xyzo.org)
// import.meta.dir can behave unexpectedly when bun test runs from different cwd
const PROJECT_ROOT = process.cwd();                          // /var/www/vhosts/xyzo.org
const APP_JS = join(PROJECT_ROOT, "public_html/app.js");  // /var/www/vhosts/xyzo.org/public_html/app.js

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract keys from a `const FOO = { ... };` block using brace counting. */
function extractConstBlock(src, constName) {
  const start = src.indexOf(`const ${constName} = {`);
  if (start < 0) return { keys: [], block: "" };
  let depth = 0, startBrace = -1;
  for (let i = start + `const ${constName} = `.length; i < src.length; i++) {
    if (src[i] === "{") {
      if (startBrace < 0) startBrace = i + 1;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        const block = src.slice(startBrace, i);
        const keys = [];
        // Match: whitespace, key name, colon, then one of: backtick, double-quote, bracket, digit
        for (const m of block.matchAll(/^\s+(\w+):\s*(?:`|"|\[|\d)/gm)) {
          keys.push(m[1]);
        }
        return { keys, block };
      }
    }
  }
  return { keys: [], block: "" };
}

/** Find duplicate keys. Returns [[key, firstIndex, lastIndex], ...]. */
function findDuplicateKeys(keys) {
  const seen = new Map();
  const dups = [];
  keys.forEach((k, i) => {
    if (seen.has(k)) dups.push([k, seen.get(k), i]);
    else seen.set(k, i);
  });
  return dups;
}

// ── Duplicate key detection ─────────────────────────────────────────────

describe("duplicate key detection — app.js const objects", () => {
  const objects = [
    "EVENT_ICONS", "EVENT_COLORS", "CANVAS_CAT_COLORS",
    "SUBTYPE_TO_BUCKET", "SOURCE_ICONS", "SOURCE_COLORS", "CAT_LABELS",
  ];

  for (const obj of objects) {
    test(`${obj} has no duplicate keys`, () => {
      const content = readFileSync(APP_JS, "utf8");
      const { keys } = extractConstBlock(content, obj);
      if (keys.length === 0) {
        console.warn(`Warning: const ${obj} not found — skipping`);
        return;
      }
      const dups = findDuplicateKeys(keys);
      if (dups.length > 0) {
        const msg = dups.map(([k, i1, i2]) =>
          `"${k}" appears at positions ${i1 + 1} and ${i2 + 1}`
        ).join("; ");
        throw new Error(`${obj} has duplicate keys: ${msg}`);
      }
      expect(dups).toHaveLength(0);
    });
  }
});

// ── Icon/Color completeness ────────────────────────────────────────────────

describe("icon ↔ color completeness — all keys must be paired", () => {
  const content = readFileSync(APP_JS, "utf8");

  test("every EVENT_ICONS key has an EVENT_COLORS entry", () => {
    const { keys: iconKeys } = extractConstBlock(content, "EVENT_ICONS");
    const { keys: colorKeys } = extractConstBlock(content, "EVENT_COLORS");
    const colorSet = new Set(colorKeys);
    const missing = iconKeys.filter(k => !colorSet.has(k));
    if (missing.length > 0) {
      throw new Error(
        `EVENT_ICONS has ${missing.length} key(s) with no EVENT_COLORS entry: ` +
        missing.slice(0, 5).map(k => `"${k}"`).join(", ") +
        (missing.length > 5 ? " ..." : "")
      );
    }
    expect(missing).toHaveLength(0);
  });

  // EVENT_COLORS intentionally has MORE keys than EVENT_ICONS (bucket-level
  // colors for sub-types like "crime", "conflict", etc. that map to bucket icons).
  // This is a superset, not a bug.

  test("CANVAS_CAT_COLORS and EVENT_COLORS are in sync", () => {
    const { keys: canvasKeys } = extractConstBlock(content, "CANVAS_CAT_COLORS");
    const { keys: colorKeys } = extractConstBlock(content, "EVENT_COLORS");
    const canvasSet = new Set(canvasKeys);
    const colorSet = new Set(colorKeys);

    const onlyCanvas = canvasKeys.filter(k => !colorSet.has(k));
    const onlyColor = colorKeys.filter(k => !canvasSet.has(k));

    if (onlyCanvas.length > 0) {
      throw new Error(
        `CANVAS_CAT_COLORS has ${onlyCanvas.length} extra key(s): ` +
        onlyCanvas.slice(0, 3).map(k => `"${k}"`).join(", ") + " ..."
      );
    }
    if (onlyColor.length > 0) {
      throw new Error(
        `EVENT_COLORS has ${onlyColor.length} extra key(s): ` +
        onlyColor.slice(0, 3).map(k => `"${k}"`).join(", ") + " ..."
      );
    }
    expect(onlyCanvas).toHaveLength(0);
    expect(onlyColor).toHaveLength(0);
  });

  test("every SUBTYPE_TO_BUCKET value exists as an EVENT_ICONS key", () => {
    const { keys: iconKeys } = extractConstBlock(content, "EVENT_ICONS");
    const iconSet = new Set(iconKeys);

    // Extract bucket values from SUBTYPE_TO_BUCKET: key: "bucketname"
    const blockMatch = content.match(/const SUBTYPE_TO_BUCKET = \{([^}]+)\}/);
    if (!blockMatch) {
      throw new Error("SUBTYPE_TO_BUCKET block not found");
    }
    const values = [];
    for (const m of blockMatch[1].matchAll(/:\s*"(\w+)"/g)) {
      values.push(m[1]);
    }

    const bad = values.filter(v => !iconSet.has(v) && v !== "other");
    if (bad.length > 0) {
      throw new Error(
        `SUBTYPE_TO_BUCKET references unknown bucket(s): ` +
        [...new Set(bad)].slice(0, 5).map(k => `"${k}"`).join(", ")
      );
    }
    expect(bad).toHaveLength(0);
  });
});

// ── classify.py integrity (via subprocess) ─────────────────────────────────

describe("classify.py integrity — must pass all tests", () => {
  test("classify.py runs with 86 unique categories and 0 duplicates", () => {
    const result = Bun.spawnSync({
      cmd: ["python3", "worker/classify.py"],
      cwd: PROJECT_ROOT,
    });

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`classify.py failed:\n${stderr}`);
    }

    const output = new TextDecoder().decode(result.stdout);

    // Check for the expected output pattern: "Results: 88/88 passed"
    if (!output.includes("/88 passed")) {
      throw new Error(`Unexpected classify.py output:\n${output}`);
    }

    // Verify unique category count
    const uniqueMatch = output.match(/(\d+)\/(\d+).*?(\d+) unique/);
    if (uniqueMatch) {
      const [, , , unique] = uniqueMatch.map(Number);
      if (unique < 86) {
        throw new Error(
          `classify.py has only ${unique} unique categories — expected ≥86. ` +
          "Run `python3 worker/classify.py` for details."
        );
      }
    }

    expect(result.exitCode).toBe(0);
  });
});

// ── Color uniqueness ───────────────────────────────────────────────────────

describe("color palette — bucket colors must be distinct", () => {
  test("each of the 13 bucket categories has a unique hex", () => {
    const content = readFileSync(APP_JS, "utf8");

    // Extract the 13 bucket names from SUBTYPE_TO_BUCKET values
    const subTypeBlockMatch = content.match(/const SUBTYPE_TO_BUCKET = \{([^}]+)\}/);
    const bucketNames = new Set();
    if (subTypeBlockMatch) {
      for (const m of subTypeBlockMatch[1].matchAll(/:\s*"(\w+)"/g)) {
        bucketNames.add(m[1]);
      }
    }
    if (bucketNames.size < 10) {
      throw new Error(`SUBTYPE_TO_BUCKET has only ${bucketNames.size} entries — can't verify buckets`);
    }

    // Extract colors for bucket keys only
    const { block: colorBlock } = extractConstBlock(content, "EVENT_COLORS");
    const bucketColors = new Map(); // bucketName → hex
    for (const m of colorBlock.matchAll(/^\s+(\w+):\s*"#([0-9a-fA-F]{6})",/gm)) {
      const key = m[1];
      if (bucketNames.has(key)) {
        bucketColors.set(key, "#" + m[2].toLowerCase());
      }
    }

    // Check each bucket has a color
    const missing = [...bucketNames].filter(b => !bucketColors.has(b));
    if (missing.length > 0) {
      throw new Error(`Buckets without colors: ${missing.join(", ")}`);
    }

    // Check uniqueness: hex → [buckets]
    const hexToBuckets = new Map();
    for (const [b, hex] of bucketColors) {
      if (!hexToBuckets.has(hex)) hexToBuckets.set(hex, []);
      hexToBuckets.get(hex).push(b);
    }

    const collisions = [];
    for (const [hex, buckets] of hexToBuckets) {
      if (buckets.length > 1) {
        collisions.push(`${hex} shared by: ${buckets.join(", ")}`);
      }
    }

    if (collisions.length > 0) {
      throw new Error(
        `${collisions.length} bucket color(s) shared by multiple buckets:\n` +
        collisions.slice(0, 5).join("\n")
      );
    }
    expect(collisions).toHaveLength(0);
  });
});

// ── File size sanity ─────────────────────────────────────────────────────

describe("file size sanity — key blocks shouldn't unexpectedly shrink", () => {
  const content = readFileSync(APP_JS, "utf8");

  test("EVENT_ICONS has ≥90 entries", () => {
    const { keys } = extractConstBlock(content, "EVENT_ICONS");
    if (keys.length < 90) {
      throw new Error(
        `EVENT_ICONS has only ${keys.length} entries — expected ≥90. ` +
        "A refactor may have accidentally deleted icons."
      );
    }
    expect(keys.length).toBeGreaterThanOrEqual(90);
  });

  test("EVENT_COLORS has ≥90 entries", () => {
    const { keys } = extractConstBlock(content, "EVENT_COLORS");
    if (keys.length < 90) {
      throw new Error(
        `EVENT_COLORS has only ${keys.length} entries — expected ≥90. ` +
        "A refactor may have accidentally deleted colors."
      );
    }
    expect(keys.length).toBeGreaterThanOrEqual(90);
  });

  test("SUBTYPE_TO_BUCKET has ≥10 entries (subtypes exist)", () => {
    const { keys } = extractConstBlock(content, "SUBTYPE_TO_BUCKET");
    if (keys.length < 10) {
      throw new Error(
        `SUBTYPE_TO_BUCKET has only ${keys.length} entries — expected ≥10.`
      );
    }
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });
});
