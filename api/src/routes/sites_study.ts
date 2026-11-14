// ── sites_study.ts ───────────────────────────────────────────────────
//
// Per-URL investigation endpoint that returns the full picture of a
// website: HTTP response, headers, page meta, RSS autodiscovery,
// sitemap URLs, JSON-LD structured data, robots verdict, and the
// legal-policy verdict (cached + refreshed on demand).
//
//   GET /api/sites/study?url=...&browser=true&legal=true
//   POST /api/sites/legal-scan   body: { host: "example.com" }
//
// `legal=true` runs the legal scanner in-process and persists the
// verdict to legal_policies. The scanner is gated by the network
// fetch cost (≤6 page probes + optional Claude escalation), so it's
// only invoked when the caller asks for it explicitly.

import { Hono } from "hono";
import { spawn } from "node:child_process";
import { getDb } from "../db";
import { adminAuth } from "../auth";

export const sitesStudyRoute = new Hono();

function isSafePublicUrl(rawUrl: string): boolean {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        const h = u.hostname.toLowerCase();
        if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254.169.254", "metadata.google.internal"].includes(h)) return false;
        if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h) || /^127\./.test(h) || /^169\.254\./.test(h)) return false;
        return true;
    } catch {
        return false;
    }
}

function jsonSafe(c: any, body: any, status = 200) {
    const text = JSON.stringify(body, (_k, v) =>
        typeof v === "bigint" ? Number(v) : v);
    return c.text(text, status, {
        "Content-Type": "application/json; charset=utf-8",
    });
}

function runPython(script: string, args: string[], timeoutMs = 30_000
                   ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("/usr/bin/python3.11", ["-c", script, ...args], {
            cwd: "/var/www/vhosts/xyzo.org/worker",
            env: { ...process.env, PYTHONPATH: "/var/www/vhosts/xyzo.org/worker" },
        });
        let stdout = "", stderr = "";
        const killTimer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
        proc.stdout.on("data", d => stdout += d.toString());
        proc.stderr.on("data", d => stderr += d.toString());
        proc.on("close", code => {
            clearTimeout(killTimer);
            resolve({ code: code ?? -1, stdout, stderr });
        });
        proc.on("error", reject);
    });
}

// ── /api/sites/study ─────────────────────────────────────────────────
sitesStudyRoute.get("/sites/study", async (c) => {
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const q = c.req.query();
    const url = q.url;
    if (!url) {
        return jsonSafe(c, { ok: false, error: "url required" }, 400);
    }
    if (!isSafePublicUrl(url)) {
        return jsonSafe(c, { ok: false, error: "invalid_or_private_url" }, 400);
    }
    const browser = q.browser === "true" || q.browser === "1";
    const legal = q.legal === "true" || q.legal === "1";

    // 1. Run study_url() in the worker process so we can use the
    //    shared RobotsCache. We marshal via a JSON stdout line.
    const script = `
import json, sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org/worker')
from site_study import study_url
result = study_url(${JSON.stringify(url)}, force_browser=${browser ? "True" : "False"})
print("__RESULT_JSON__" + json.dumps(result.to_dict(), default=str))
`;
    let study: any = null;
    let studyErr = "";
    try {
        const r = await runPython(script, [], 35_000);
        studyErr = r.stderr;
        const line = r.stdout.split("\n").find(l => l.startsWith("__RESULT_JSON__"));
        if (line) {
            study = JSON.parse(line.slice("__RESULT_JSON__".length));
        }
    } catch (e: any) {
        return jsonSafe(c, {
            ok: false, error: "study-failed", detail: String(e),
        }, 500);
    }
    if (!study) {
        return jsonSafe(c, {
            ok: false, error: "study-no-result", stderr: studyErr,
        }, 502);
    }

    // 2. Optionally run legal scan
    let legalVerdict: any = null;
    if (legal && study.politeness_tier) {
        try {
            const host = new URL(study.final_url || url).hostname;
            const legalScript = `
import json, sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org/worker')
from legal_scan import scan_host, persist_verdict
v = scan_host(${JSON.stringify(host)})
try:
    persist_verdict(v)
except Exception as e:
    pass
print("__LEGAL_JSON__" + json.dumps(v.to_dict(), default=str))
`;
            const r = await runPython(legalScript, [], 60_000);
            const line = r.stdout.split("\n")
                .find(l => l.startsWith("__LEGAL_JSON__"));
            if (line) {
                legalVerdict = JSON.parse(line.slice("__LEGAL_JSON__".length));
            }
        } catch (e: any) {
            legalVerdict = { error: String(e) };
        }
    }

    return jsonSafe(c, {
        ok: true,
        url,
        study,
        legal: legalVerdict,
    });
});

// ── POST /api/sites/legal-scan ───────────────────────────────────────
sitesStudyRoute.post("/sites/legal-scan", async (c) => {
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return jsonSafe(c, { ok: false, error: "invalid json" }, 400);
    }
    const host = (body.host || "").toLowerCase().trim();
    if (!host) {
        return jsonSafe(c, { ok: false, error: "host required" }, 400);
    }
    const refresh = body.refresh === true;

    // Serve from cache unless refresh=true.
    if (!refresh) {
        const sql = getDb();
        const rows = await sql<Record<string, unknown>[]>`
            SELECT * FROM legal_policies
            WHERE host = ${host}
              AND scanned_at > now() - interval '7 days'
            LIMIT 1
        `;
        if (rows.length > 0) {
            return jsonSafe(c, { ok: true, cached: true, verdict: rows[0] });
        }
    }

    try {
        const script = `
import json, sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org/worker')
from legal_scan import scan_host, persist_verdict
v = scan_host(${JSON.stringify(host)})
try:
    persist_verdict(v)
except Exception as e:
    pass
print("__LEGAL_JSON__" + json.dumps(v.to_dict(), default=str))
`;
        const r = await runPython(script, [], 60_000);
        const line = r.stdout.split("\n")
            .find(l => l.startsWith("__LEGAL_JSON__"));
        if (!line) {
            return jsonSafe(c, {
                ok: false, error: "scan-no-result", stderr: r.stderr,
            }, 502);
        }
        const verdict = JSON.parse(line.slice("__LEGAL_JSON__".length));
        return jsonSafe(c, { ok: true, cached: false, verdict });
    } catch (e: any) {
        return jsonSafe(c, {
            ok: false, error: "scan-failed", detail: String(e),
        }, 500);
    }
});

// ── GET /api/sites/legal/:host ───────────────────────────────────────
sitesStudyRoute.get("/sites/legal/:host", async (c) => {
    const host = c.req.param("host").toLowerCase();
    const sql = getDb();
    const rows = await sql<Record<string, unknown>[]>`
        SELECT * FROM legal_policies WHERE host = ${host} LIMIT 1
    `;
    if (rows.length === 0) {
        return jsonSafe(c, { ok: false, error: "no-verdict-yet", host }, 404);
    }
    return jsonSafe(c, { ok: true, verdict: rows[0] });
});

// ── POST /api/sites/crawl ────────────────────────────────────────────
//
// BFS-crawl a domain. Body:
//   { url: "https://example.com", max_pages?: 50, max_depth?: 3,
//     use_ai?: false, persist?: true }
//
// `persist=true` writes the crawl result to site_crawl_results,
// discovered_pages, crawl_events. The returned JSON includes the
// `crawl_id` so the caller can fetch details later.

sitesStudyRoute.post("/sites/crawl", async (c) => {
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return jsonSafe(c, { ok: false, error: "invalid json" }, 400);
    }
    const url = (body.url || "").trim();
    if (!url) {
        return jsonSafe(c, { ok: false, error: "url required" }, 400);
    }
    if (!isSafePublicUrl(url)) {
        return jsonSafe(c, { ok: false, error: "invalid_or_private_url" }, 400);
    }
    const max_pages = Math.min(Math.max(Number(body.max_pages ?? 30), 1), 200);
    const max_depth = Math.min(Math.max(Number(body.max_depth ?? 3), 0), 6);
    const use_ai = body.use_ai === true;
    const persist = body.persist !== false;
    const max_seconds = Math.min(Math.max(Number(body.max_seconds ?? 90),
                                           10), 600);

    const script = `
import json, sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org/worker')
from site_crawl import crawl_site
r = crawl_site(${JSON.stringify(url)},
               max_pages=${max_pages},
               max_depth=${max_depth},
               use_ai=${use_ai ? "True" : "False"},
               max_seconds=${max_seconds})
print("__CRAWL_JSON__" + json.dumps(r.to_dict(), default=str))
`;
    let crawl: any = null;
    try {
        const r = await runPython(script, [], max_seconds * 1000 + 15_000);
        const line = r.stdout.split("\n")
            .find(l => l.startsWith("__CRAWL_JSON__"));
        if (line) {
            crawl = JSON.parse(line.slice("__CRAWL_JSON__".length));
        }
    } catch (e: any) {
        return jsonSafe(c, {
            ok: false, error: "crawl-failed", detail: String(e),
        }, 500);
    }
    if (!crawl) {
        return jsonSafe(c, { ok: false, error: "crawl-no-result" }, 502);
    }

    let crawlId: number | null = null;
    if (persist) {
        try {
            const persistScript = `
import json, sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org/worker')
from db import connect
from psycopg.types.json import Json
data = json.loads(${JSON.stringify(JSON.stringify(crawl))})
with connect() as conn, conn.cursor() as cur:
    cur.execute(
        """
        INSERT INTO site_crawl_results (
            seed_url, host, politeness_tier, started_at, finished_at,
            max_pages, max_depth, pages_crawled, events_found,
            feeds_found, sitemaps_found, robots_verdict, robots_note,
            error
        )
        VALUES (%s, %s, %s, to_timestamp(%s), to_timestamp(%s),
                %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            data["seed_url"], data["host"], data["politeness_tier"],
            data["started_at"], data["finished_at"],
            data["max_pages"], data["max_depth"],
            data["stats"]["pages_crawled"], data["stats"]["events_found"],
            data["stats"]["feeds_found"], data["stats"]["sitemaps_found"],
            data["robots_verdict"], data["robots_note"], data["error"],
        ),
    )
    crawl_id = cur.fetchone()["id"]
    for p in data["pages"]:
        cur.execute(
            """
            INSERT INTO discovered_pages (
                crawl_id, url, final_url, parent_url, depth, priority,
                status, content_type, title, html_lang, bytes,
                rss_links, json_ld_events, heuristic_events, og_tags,
                out_links_count, signals, error
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                    %s, %s, %s)
            RETURNING id
            """,
            (
                crawl_id, p["url"], p["final_url"], p["parent_url"],
                p["depth"], p["priority"], p["status"], p["content_type"],
                p["title"], p["html_lang"], p["bytes"],
                Json(p["rss_links"]), Json(p["json_ld_events"]),
                Json(p["heuristic_events"]), Json(p["og_tags"]),
                p["out_links_count"], p["signals"], p["error"],
            ),
        )
        page_id = cur.fetchone()["id"]
        for e in p["json_ld_events"] + p["heuristic_events"] + p["ai_events"]:
            cur.execute(
                """
                INSERT INTO crawl_events (
                    crawl_id, page_id, source_url, title, description,
                    starts_at, ends_at, venue_name, city, country_code,
                    lat, lng, image_url, price_min, price_max, currency,
                    is_free, is_online, event_url, organizer_name,
                    extraction, confidence, content_hash, raw
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s::jsonb)
                """,
                (
                    crawl_id, page_id, p["url"], e.get("title"),
                    e.get("description"),
                    e.get("starts_at"), e.get("ends_at"),
                    e.get("venue_name"), e.get("city"),
                    e.get("country_code"), e.get("lat"), e.get("lng"),
                    e.get("image_url"), e.get("price_min"),
                    e.get("price_max"), e.get("currency"),
                    e.get("is_free"), e.get("is_online", False),
                    e.get("event_url"), e.get("organizer_name"),
                    e.get("extraction"), e.get("confidence"),
                    e.get("content_hash"), Json(e),
                ),
            )
print("__CRAWL_ID__" + str(crawl_id))
`;
            const r = await runPython(persistScript, [], 30_000);
            const line = r.stdout.split("\n")
                .find(l => l.startsWith("__CRAWL_ID__"));
            if (line) {
                const idStr = line.slice("__CRAWL_ID__".length).trim();
                crawlId = parseInt(idStr, 10) || null;
            }
        } catch (e: any) {
            return jsonSafe(c, {
                ok: true,
                crawl,
                persisted: false,
                persist_error: String(e),
            });
        }
    }

    return jsonSafe(c, {
        ok: true,
        crawl,
        crawl_id: crawlId,
        persisted: crawlId !== null,
    });
});

// ── GET /api/sites/crawl/:id ─────────────────────────────────────────
sitesStudyRoute.get("/sites/crawl/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) {
        return jsonSafe(c, { ok: false, error: "invalid id" }, 400);
    }
    const sql = getDb();
    const rows = await sql<Record<string, unknown>[]>`
        SELECT * FROM site_crawl_results WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) {
        return jsonSafe(c, { ok: false, error: "not-found" }, 404);
    }
    const pages = await sql<Record<string, unknown>[]>`
        SELECT id, url, final_url, parent_url, depth, priority, status,
               title, signals, json_ld_events, heuristic_events, og_tags,
               error
        FROM discovered_pages
        WHERE crawl_id = ${id}
        ORDER BY priority DESC, depth ASC, id ASC
    `;
    const events = await sql<Record<string, unknown>[]>`
        SELECT id, source_url, title, description, starts_at, ends_at,
               venue_name, city, country_code, is_free, is_online,
               event_url, organizer_name, extraction, confidence
        FROM crawl_events
        WHERE crawl_id = ${id}
        ORDER BY starts_at ASC NULLS LAST, confidence DESC
        LIMIT 500
    `;
    return jsonSafe(c, {
        ok: true,
        crawl: rows[0],
        pages,
        events,
    });
});
