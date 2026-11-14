#!/usr/bin/env python3
"""Stress test benchmark for Xyzo API concurrency (10 to 100 simultaneous users).

Simulates multiple concurrent users fetching pins with varied bounding boxes
and measures:
  - Throughput (Requests per second)
  - Average & p95 latency (ms)
  - Success rate
  - Dynamic concurrency limits & guardrails

Usage:
    python3 scripts/stress_test_pins.py --users 10
    python3 scripts/stress_test_pins.py --users 50
    python3 scripts/stress_test_pins.py --users 100
"""

import argparse
import asyncio
import time
import urllib.request
import json
import statistics

API_URL = "http://localhost:3008/api/pins"

BBOXES = [
    "-180,-90,180,90",         # World view
    "-125,24,-66,49",           # US view
    "-10,35,30,60",            # Europe view
    "68,6,97,35",              # India view
    "120,20,150,50",           # Japan / East Asia view
    "-74.1,40.6,-73.8,40.9",   # New York City view
    "-0.2,51.4,0.1,51.6",      # London view
    "139.6,35.5,140.0,35.8",   # Tokyo view
]

async def fetch_worker(worker_id: int, num_requests: int, results: list):
    loop = asyncio.get_event_loop()
    for i in range(num_requests):
        bbox = BBOXES[(worker_id + i) % len(BBOXES)]
        url = f"{API_URL}?bbox={bbox}&limit=500"
        
        t0 = time.perf_counter()
        try:
            def sync_fetch():
                req = urllib.request.Request(url, headers={"User-Agent": f"StressWorker/{worker_id}"})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.read()
            
            raw = await loop.run_in_executor(None, sync_fetch)
            elapsed_ms = (time.perf_counter() - t0) * 1000
            data = json.loads(raw)
            count = data.get("count", 0)
            guardrail = data.get("guardrail")
            results.append({
                "worker": worker_id,
                "status": 200,
                "elapsed_ms": elapsed_ms,
                "count": count,
                "guardrail": bool(guardrail),
            })
        except Exception as e:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            results.append({
                "worker": worker_id,
                "status": 500,
                "elapsed_ms": elapsed_ms,
                "error": str(e),
            })

async def main():
    parser = argparse.ArgumentParser(description="Xyzo API Concurrency Stress Test")
    parser.add_argument("--users", type=int, default=10, help="Number of concurrent simulated users")
    parser.add_argument("--requests-per-user", type=int, default=5, help="Requests per user")
    args = parser.parse_args()

    total_requests = args.users * args.requests_per_user
    print(f"\n🚀 Starting Xyzo Concurrency Benchmark")
    print(f"   Simulated Concurrent Users: {args.users}")
    print(f"   Requests per User:          {args.requests_per_user}")
    print(f"   Total Requests:             {total_requests}")
    print(f"   Target Endpoint:            {API_URL}\n")

    results = []
    t_start = time.perf_counter()

    tasks = [
        fetch_worker(worker_id=i, num_requests=args.requests_per_user, results=results)
        for i in range(args.users)
    ]
    await asyncio.gather(*tasks)

    t_total = time.perf_counter() - t_start
    successful = [r for r in results if r["status"] == 200]
    failed = [r for r in results if r["status"] != 200]
    latencies = [r["elapsed_ms"] for r in successful]

    rps = len(results) / t_total
    avg_lat = statistics.mean(latencies) if latencies else 0
    p95_lat = statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20 else (max(latencies) if latencies else 0)

    print("=" * 65)
    print(f"  BENCHMARK RESULTS ({args.users} Concurrent Users)")
    print("=" * 65)
    print(f"  Total Duration:      {t_total:.2f} s")
    print(f"  Total Requests:      {len(results)}")
    print(f"  Successful Requests: {len(successful)} ({len(successful)/len(results)*100:.1f}%)")
    print(f"  Failed Requests:     {len(failed)}")
    print(f"  Throughput (RPS):    {rps:.1f} req/sec")
    print(f"  Avg Latency:         {avg_lat:.2f} ms")
    print(f"  p95 Latency:         {p95_lat:.2f} ms")
    print("=" * 65 + "\n")

if __name__ == "__main__":
    asyncio.run(main())
