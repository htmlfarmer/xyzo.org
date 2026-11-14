#!/usr/bin/env bun
// api-health-check.js — API endpoint health check with baseline tracking
//
// Usage:
//   bun run api-health-check.js                    # check endpoints against baseline
//   bun run api-health-check.js --update           # update baseline with current responses
//   bun run api-health-check.js --force            # force update even if endpoints fail
//
// The baseline stores expected response shapes and key values. When endpoints
// change intentionally, run with --update to refresh the baseline.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const API_BASE = process.env.XYZO_API_URL ?? "http://localhost:3008";
const BASELINE_FILE = join(import.meta.dir, ".api-baseline.json");

const CRITICAL_ENDPOINTS = [
  { name: "health", path: "/api/health", method: "GET" },
  { name: "stats", path: "/api/stats", method: "GET" },
  { name: "pins/stats", path: "/api/pins/stats", method: "GET" },
  { name: "pins/map", path: "/api/pins/map?bbox=-180,-85,180,85&limit=1", method: "GET" },
  { name: "cities/search", path: "/api/cities/search?q=london&limit=1", method: "GET" },
  { name: "sources/stats", path: "/api/sources/stats", method: "GET" },
  { name: "story-links/stats", path: "/api/story-links/stats", method: "GET" },
  { name: "city-value/top", path: "/api/city-value/top?limit=3", method: "GET" },
  { name: "city-value/surging", path: "/api/city-value/surging?limit=3", method: "GET" },
  { name: "city-value/stats", path: "/api/city-value/stats", method: "GET" },
  { name: "locations/search", path: "/api/locations/search?q=chicago&limit=1", method: "GET" },
];

const UPDATE_FLAG = process.argv.includes("--update");
const FORCE_FLAG = process.argv.includes("--force");

function hashResponse(obj) {
  const str = JSON.stringify(obj, Object.keys(obj ?? {}).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function extractKeyValues(obj, prefix = "") {
  if (obj === null || obj === undefined) return {};
  if (typeof obj !== "object") return {};

  const result = {};

  if (Array.isArray(obj)) {
    if (obj.length > 0) {
      const first = obj[0];
      if (typeof first === "object" && first !== null) {
        const itemPrefix = prefix ? `${prefix}[0].` : "[0].";
        Object.assign(result, extractKeyValues(first, itemPrefix));
      }
      result[prefix ? `${prefix}[]` : "[]"] = obj.length;
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}${key}` : key;

      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        Object.assign(result, extractKeyValues(value, `${newKey}.`));
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        result[newKey] = value;
      }
    }
  }

  return result;
}

async function checkEndpoint(name, path, method) {
  const url = `${API_BASE}${path}`;
  const start = Date.now();

  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(10000) });
    const responseTime = Date.now() - start;
    const text = await res.text();

    let response;
    try {
      response = JSON.parse(text);
    } catch {
      response = text;
    }

    return {
      name,
      status: res.status,
      ok: res.status >= 200 && res.status < 400,
      responseTime,
      error: null,
      response,
    };
  } catch (error) {
    return {
      name,
      status: 0,
      ok: false,
      responseTime: Date.now() - start,
      error: String(error),
      response: null,
    };
  }
}

async function main() {
  console.log(`\n=== API Health Check ===`);
  console.log(`API: ${API_BASE}`);
  console.log(`Mode: ${UPDATE_FLAG ? "UPDATE baseline" : "CHECK against baseline"}`);
  console.log();

  const results = [];

  for (const endpoint of CRITICAL_ENDPOINTS) {
    process.stdout.write(`Checking ${endpoint.name}... `);
    const result = await checkEndpoint(endpoint.name, endpoint.path, endpoint.method);
    results.push(result);

    if (result.ok) {
      console.log(`✓ ${result.status} (${result.responseTime}ms)`);
    } else {
      console.log(`✗ ${result.status} - ${result.error ?? "failed"}`);
    }
  }

  console.log();

  // Load baseline
  let baseline = null;
  if (existsSync(BASELINE_FILE)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    } catch {
      console.warn("Warning: Could not parse baseline file, ignoring");
    }
  }

  if (UPDATE_FLAG) {
    const newBaseline = {
      version: 1,
      updatedAt: new Date().toISOString(),
      endpoints: {},
    };

    // Carry over the previous entry for endpoints we could not measure
    // this run (a slow endpoint under load must not silently drop out of
    // the baseline).
    const previous = baseline?.endpoints || {};

    let hasFailures = false;
    for (const result of results) {
      if (!result.ok) {
        console.error(`✗ Cannot update baseline for ${result.name}: endpoint failed (${result.status})`);
        hasFailures = true;
        if (previous[result.name]) {
          newBaseline.endpoints[result.name] = previous[result.name];
          console.error(`  (kept the previous baseline entry for ${result.name})`);
        }
        continue;
      }

      newBaseline.endpoints[result.name] = {
        status: result.status,
        responseHash: hashResponse(result.response),
        keyValues: extractKeyValues(result.response),
      };
    }

    if (hasFailures && !FORCE_FLAG) {
      console.error("\nAborted: Some endpoints failed. Use --force to update baseline anyway.");
      process.exit(1);
    }

    writeFileSync(BASELINE_FILE, JSON.stringify(newBaseline, null, 2));
    console.log(`✓ Baseline updated: ${BASELINE_FILE}`);
    console.log(`  Updated at: ${newBaseline.updatedAt}`);
    console.log(`  Endpoints tracked: ${Object.keys(newBaseline.endpoints).length}`);

    if (hasFailures) {
      console.warn("\n⚠ Some endpoints were skipped due to failures");
    }

    return;
  }

  // Check against baseline
  if (!baseline) {
    console.error("No baseline found. Run with --update to create one.");
    process.exit(1);
  }

  console.log(`Baseline: ${baseline.updatedAt}`);
  console.log();

  let passed = 0;
  let failed = 0;
  let changed = 0;

  for (const result of results) {
    const expected = baseline.endpoints[result.name];

    if (!expected) {
      console.warn(`⚠ ${result.name}: no baseline entry`);
      continue;
    }

    if (!result.ok) {
      console.error(`✗ ${result.name}: endpoint returned ${result.status} (expected ${expected.status})`);
      failed++;
      continue;
    }

    const currentHash = hashResponse(result.response);

    if (currentHash !== expected.responseHash) {
      console.error(`✗ ${result.name}: response changed`);

      const currentKeys = extractKeyValues(result.response);
      const addedKeys = Object.keys(currentKeys).filter(k => !expected.keyValues[k]);
      const removedKeys = Object.keys(expected.keyValues).filter(k => !currentKeys[k]);

      if (addedKeys.length > 0) {
        console.error(`  Added keys: ${addedKeys.join(", ")}`);
      }
      if (removedKeys.length > 0) {
        console.error(`  Removed keys: ${removedKeys.join(", ")}`);
      }

      changed++;
    } else {
      console.log(`✓ ${result.name}: unchanged`);
      passed++;
    }
  }

  console.log();
  console.log(`=== Results: ${passed} passed, ${changed} changed, ${failed} failed ===`);

  if (changed > 0) {
    console.log();
    console.log("Some endpoint responses have changed. Options:");
    console.log("  1. If this is intentional, run: bun run api-health-check.js --update");
    console.log("  2. If this is a bug, fix the endpoint and re-run without --update");
  }

  if (failed > 0) {
    console.log();
    console.log("Some endpoints are failing. Fix them before continuing.");
    process.exit(1);
  }

  if (changed > 0) {
    process.exit(1);
  }
}

main();
