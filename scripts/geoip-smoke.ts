// Smoke-test the multi-provider geoip chain from the API side.
//
// For each public IP in TEST_IPS, call geoip.lookup() directly
// (bypassing /api/geoip's localhost short-circuit) and print which
// provider answered. Catches chain breaks and slow providers without
// needing to deploy.
//
// Run: bun scripts/geoip-smoke.ts

import { lookup, _resetCacheForTesting } from "../api/src/geoip";

const TEST_IPS = [
  "8.8.8.8",        // Google DNS, US
  "1.1.1.1",        // Cloudflare, US
  "208.67.222.222", // OpenDNS, US
];

_resetCacheForTesting();

console.log(`Testing ${TEST_IPS.length} IPs with provider chain:`);
const order = (process.env.NEWSIUM_GEOIP_PROVIDERS ?? "maxmind,ipwho.is,ipapi.is,ip-api.com")
  .split(",").map(s => s.trim()).filter(Boolean);
for (const name of order) console.log(`  - ${name}`);
console.log();

for (const ip of TEST_IPS) {
  const t0 = Date.now();
  const r = await lookup(ip);
  const dt = Date.now() - t0;
  if (r) {
    console.log(`OK  ${ip.padEnd(16)} ${r.source.padEnd(12)} ${(r.city ?? "-").padEnd(20)} ${r.country ?? "-"} (${dt}ms)`);
  } else {
    console.log(`FAIL ${ip.padEnd(16)} NO PROVIDER ANSWERED (${dt}ms)`);
  }
  // Force per-lookups to actually exercise the chain (bypass the cache).
  _resetCacheForTesting();
}
