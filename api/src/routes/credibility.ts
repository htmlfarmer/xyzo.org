import { Hono } from "hono";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";

export const credibilityRoute = new Hono();

const credibilityLimiter = new RateLimiter({ max: 30, windowMs: 60 * 1000 });

const LEGAL_DISCLAIMER = "This analysis shows observable credibility factors only. It is not a credibility score, verdict, or truth claim. Evaluate the factors yourself. This tool is for informational purposes only and does not constitute legal, medical, or professional advice.";

const SIGNAL_LABELS: Record<string, { positive: string; negative: string }> = {
    source_historical_accuracy: {
        positive: "Source has strong historical accuracy",
        negative: "Source has limited accuracy track record"
    },
    source_citations: {
        positive: "Article cites credible external sources",
        negative: "Article lacks external source citations"
    },
    no_citations: {
        positive: "",
        negative: "Article does not cite external sources"
    },
    factual_density: {
        positive: "Article contains specific factual details",
        negative: "Article lacks specific verifiable details"
    },
    emotional_language: {
        positive: "",
        negative: "Article uses high emotional language"
    },
    sensationalism: {
        positive: "",
        negative: "Article shows sensationalist writing style"
    },
    source_transparency: {
        positive: "Source is transparent about methodology",
        negative: "Source has limited transparency"
    },
    source_expertise: {
        positive: "Source frequently covers this topic",
        negative: "Source rarely covers this topic"
    },
    cross_source: {
        positive: "Story confirmed by multiple credible sources",
        negative: "Story not verified by other sources"
    },
    attribution: {
        positive: "Article has proper author attribution",
        negative: ""
    }
};

function assessVerdict(factor: Record<string, unknown>): string {
    const verdict = factor.verdict as string;
    if (verdict === "positive") return "✅ " + (SIGNAL_LABELS[factor.factor as string]?.positive || factor.label);
    if (verdict === "concern") return "⚠️ " + (SIGNAL_LABELS[factor.factor as string]?.negative || factor.label);
    return "ℹ️ " + (factor.label as string);
}

credibilityRoute.get("/articles/:id/credibility", async (c) => {
    const ip = getClientIp(c.req.raw);
    const limit = credibilityLimiter.check(ip);
    if (!limit.allowed) {
        return c.json({
            error: "rate_limited",
            retry_after_ms: limit.retryAfterMs
        }, 429);
    }

    const articleId = parseInt(c.req.param("id"));
    if (isNaN(articleId)) {
        return c.json({ error: "invalid_article_id" }, 400);
    }

    const sql = getDb();

    const [article] = await sql<{
        id: number;
        title: string;
        body: string;
        url: string | null;
        source_id: number | null;
        published_at: Date | null;
        credibility_signals: Record<string, unknown> | null;
    }[]>`
        SELECT
            id,
            title,
            body,
            url,
            source_id,
            published_at,
            credibility_signals
        FROM news_articles
        WHERE id = ${articleId}
    `;

    if (!article) {
        return c.json({ error: "article_not_found" }, 404);
    }

    if (article.credibility_signals) {
        let signals = article.credibility_signals;
        if (typeof signals === 'string') {
            try {
                signals = JSON.parse(signals);
            } catch {
                signals = null;
            }
        }
        if (!signals) {
            return c.json({
                article_id: articleId,
                disclaimer: LEGAL_DISCLAIMER,
                factors: [],
                summary: "Credibility analysis data corrupted. Please recompute.",
                note: LEGAL_DISCLAIMER,
                cached: false,
                generated_at: null
            });
        }
        const factors = (signals as Record<string, unknown>).factors as Array<Record<string, unknown>> || [];

        return c.json({
            article_id: articleId,
            disclaimer: LEGAL_DISCLAIMER,
            factors: factors.map(f => ({
                factor: f.factor,
                label: f.label,
                value: f.value,
                description: f.description,
                weight: f.weight,
                verdict: f.verdict,
                icon: f.verdict === "positive" ? "positive" : f.verdict === "concern" ? "concern" : "neutral"
            })),
            summary: factors.map(f => assessVerdict(f)).filter(Boolean).join("\n\n") || "No specific credibility factors detected",
            note: signals.note as string || LEGAL_DISCLAIMER,
            cached: true,
            generated_at: signals.generated_at || null
        });
    }

    return c.json({
        article_id: articleId,
        disclaimer: LEGAL_DISCLAIMER,
        factors: [],
        summary: "Credibility analysis not yet computed. POST to /api/articles/:id/credibility/compute to generate.",
        note: "This article's credibility factors have not been analyzed yet. Send a POST request to compute them.",
        cached: false,
        generated_at: null
    });
});

credibilityRoute.post("/articles/:id/credibility/compute", async (c) => {
    const articleId = parseInt(c.req.param("id"));
    if (isNaN(articleId)) {
        return c.json({ error: "invalid_article_id" }, 400);
    }

    const sql = getDb();

    const [article] = await sql<{
        id: number;
        title: string;
        body: string;
        url: string | null;
        source_id: number | null;
        published_at: Date | null;
        source_reliability_score: number | null;
        source_error_count: number | null;
        source_created_at: Date | null;
        source_name: string | null;
    }[]>`
        SELECT
            a.id, a.title, a.body, a.url, a.source_id, a.published_at,
            s.reliability_score as source_reliability_score,
            s.error_count as source_error_count,
            s.created_at as source_created_at,
            s.name as source_name
        FROM news_articles a
        LEFT JOIN news_sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
    `;

    if (!article) {
        return c.json({ error: "article_not_found" }, 404);
    }

    const factors = computeCredibilityFactors(article);

    try {
        await sql`
            UPDATE news_articles
            SET credibility_signals = ${JSON.stringify({
                factors,
                note: "Observable credibility factors only. Not a truth claim.",
                generated_at: new Date().toISOString()
            })}
            WHERE id = ${articleId}
        `;
    } catch (e) {
        console.error("Failed to cache credibility signals:", e);
    }

    return c.json({
        article_id: articleId,
        disclaimer: LEGAL_DISCLAIMER,
        factors,
        summary: factors.map(f => assessVerdict(f)).filter(Boolean).join("\n\n"),
        note: LEGAL_DISCLAIMER,
        generated_at: new Date().toISOString()
    });
});

interface ArticleRow {
    id: number;
    title: string;
    body: string;
    url: string | null;
    source_id: number | null;
    published_at: Date | null;
    source_reliability_score: number | null;
    source_error_count: number | null;
    source_created_at: Date | null;
    source_name: string | null;
}

function computeCredibilityFactors(article: ArticleRow): Array<Record<string, unknown>> {
    const factors: Array<Record<string, unknown>> = [];

    const title = article.title || "";
    const body = article.body || "";
    const fullText = `${title} ${body}`;

    const sourceAccuracy = article.source_reliability_score ?? 0.5;
    factors.push({
        factor: "source_historical_accuracy",
        label: "Source Reliability Score",
        value: `${Math.round(sourceAccuracy * 100)}%`,
        description: sourceAccuracy > 0.7 ? "Source has strong reliability rating" : sourceAccuracy > 0.4 ? "Source has moderate reliability" : "Source has limited reliability data",
        weight: "high",
        verdict: sourceAccuracy > 0.7 ? "positive" : sourceAccuracy > 0.4 ? "neutral" : "concern"
    });

    const citations = extractCitations(body);
    if (citations.length > 0) {
        const citationQuality = citations.reduce((sum, c) => sum + getCitationCredibility(c), 0) / citations.length;
        factors.push({
            factor: "source_citations",
            label: "Sources Cited",
            value: `${citations.length} sources`,
            description: `Cites external sources with ${Math.round(citationQuality * 100)}% average credibility`,
            weight: "high",
            verdict: citationQuality > 0.6 ? "positive" : citationQuality > 0.3 ? "neutral" : "concern"
        });
    } else {
        factors.push({
            factor: "no_citations",
            label: "No External Sources",
            value: "No citations found",
            description: "Article does not cite external sources - claims cannot be easily verified",
            weight: "high",
            verdict: "concern"
        });
    }

    const factualDensity = calculateFactualDensity(fullText);
    factors.push({
        factor: "factual_density",
        label: "Factual Specificity",
        value: `${Math.round(factualDensity * 100)}%`,
        description: "Ratio of specific facts (numbers, dates, names) to general claims",
        weight: "medium",
        verdict: factualDensity > 0.15 ? "positive" : factualDensity > 0.05 ? "neutral" : "concern"
    });

    const emotionalRatio = calculateEmotionalRatio(fullText);
    if (emotionalRatio > 0.03) {
        factors.push({
            factor: "emotional_language",
            label: "Emotional Language",
            value: `${Math.round(emotionalRatio * 100)}%`,
            description: "High emotional language may indicate opinion over fact",
            weight: "medium",
            verdict: emotionalRatio > 0.08 ? "concern" : "neutral"
        });
    }

    const sensationalism = calculateSensationalism(title, body);
    if (sensationalism > 0.2) {
        factors.push({
            factor: "sensationalism",
            label: "Sensationalist Style",
            value: `${Math.round(sensationalism * 100)}%`,
            description: "Uses ALL CAPS, excessive punctuation, or clickbait phrases",
            weight: "medium",
            verdict: "concern"
        });
    }

    const transparency = calculateTransparency(
        article.source_reliability_score ?? 0.5,
        article.source_error_count ?? 0,
        article.source_created_at
    );
    factors.push({
        factor: "source_transparency",
        label: "Source Transparency",
        value: `${Math.round(transparency * 100)}%`,
        description: transparency > 0.6 ? "Source is transparent about methodology" : "Source has limited transparency",
        weight: "medium",
        verdict: transparency > 0.6 ? "positive" : transparency > 0.3 ? "neutral" : "concern"
    });

    const hasAuthor = /by\s+[A-Z][a-z]+/i.test(body.slice(0, 500));
    const hasDateline = /\b(Reuters|AP|AFP|Bloomberg)\b/i.test(body.slice(0, 500));
    if (hasAuthor || hasDateline) {
        factors.push({
            factor: "attribution",
            label: "Proper Attribution",
            value: [hasAuthor ? "Author" : null, hasDateline ? "Dateline" : null].filter(Boolean).join(" + "),
            description: "Article has named author and/or publication dateline",
            weight: "low",
            verdict: "positive"
        });
    }

    const wordCount = body.split(/\s+/).length;
    if (wordCount > 0) {
        factors.push({
            factor: "article_depth",
            label: "Article Depth",
            value: wordCount < 300 ? "Brief" : wordCount < 800 ? "Standard" : wordCount < 1500 ? "Detailed" : "In-Depth",
            description: `${wordCount} words - ${wordCount < 300 ? "may lack detail" : wordCount > 800 ? "comprehensive coverage" : "standard length"}`,
            weight: "low",
            verdict: wordCount > 300 ? "positive" : "neutral"
        });
    }

    return factors.sort((a, b) => {
        const weightOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        return (weightOrder[a.weight as string] || 3) - (weightOrder[b.weight as string] || 3);
    });
}

function extractCitations(text: string): string[] {
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const urls = text.match(urlPattern) || [];
    const domainPattern = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi;
    const domains: string[] = [];
    for (const url of urls) {
        const match = domainPattern.exec(url);
        if (match) domains.push(match[1].toLowerCase());
    }
    return [...new Set(domains)];
}

const CITED_DOMAIN_CREDIBILITY: Record<string, number> = {
    'gov': 1.0, 'edu': 1.0, 'org': 0.8,
    'reuters': 1.0, 'apnews': 1.0, 'afp': 0.95,
    'bbc': 0.95, 'nyt': 0.9, 'wsj': 0.9, 'wapo': 0.9,
    'theguardian': 0.85, 'cnn': 0.8, 'nbc': 0.8, 'abc': 0.8, 'cbs': 0.8,
    'npr': 0.9, 'pbs': 0.9, 'bloomberg': 0.85, 'ft': 0.85, 'economist': 0.9,
    'snopes': 0.95, 'politifact': 0.95, 'factcheck': 0.95,
    'wikipedia': 0.4, 'facebook': 0.1, 'twitter': 0.1, 'reddit': 0.15,
    'youtube': 0.15, 'tiktok': 0.1, 'instagram': 0.1
};

function getCitationCredibility(domain: string): number {
    const d = domain.toLowerCase();
    for (const [known, score] of Object.entries(CITED_DOMAIN_CREDIBILITY)) {
        if (d.includes(known)) return score;
    }
    return 0.3;
}

const EMOTIONAL_WORDS = new Set([
    'shocking', 'devastating', 'catastrophic', 'unbelievable', 'outrageous',
    'miracle', 'disaster', 'tragedy', 'explosive', 'breaking', 'urgent',
    'scandal', 'exposed', 'secret', 'conspiracy', 'lie', 'fake', 'hoax'
]);

function calculateEmotionalRatio(text: string): number {
    const words = text.toLowerCase().split(/\s+/);
    if (words.length === 0) return 0;
    const emotionalCount = words.filter(w => EMOTIONAL_WORDS.has(w)).length;
    return Math.min(1, (emotionalCount / words.length) * 10);
}

function calculateSensationalism(title: string, body: string): number {
    let score = 0;
    if (/\b[A-Z]{5,}\b/.test(title)) score += 0.3;
    if (/!{2,}/.test(title)) score += 0.2;
    if (/\b(you won't believe|shocking|explosive|breaking|urgent|just in)\b/i.test(title)) score += 0.3;
    if (/\b[A-Z]{5,}\b/.test(body)) score += 0.1;
    return Math.min(1, score);
}

const FACTUAL_PATTERNS = [
    /\d{4}-\d{2}-\d{2}/,
    /\d{1,2}\/\d{1,2}\/\d{2,4}/,
    /\d+(?:\.\d+)?%/,
    /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\s+(?:million|billion|trillion)?/i,
    /\b(?:governor|senator|president|ceo|director|dr\.|prof\.)\s+[A-Z]/i,
];

function calculateFactualDensity(text: string): number {
    let factCount = 0;
    for (const pattern of FACTUAL_PATTERNS) {
        factCount += (text.match(pattern) || []).length;
    }
    const wordCount = text.split(/\s+/).length;
    return Math.min(1, (factCount / Math.max(1, wordCount)) * 10);
}

function calculateTransparency(
    reliabilityScore: number,
    errorCount: number,
    createdAt: Date | null
): number {
    let score = reliabilityScore * 0.5;
    if (errorCount > 0) score -= Math.min(0.2, errorCount * 0.02);
    if (createdAt) {
        const age = 2026 - createdAt.getFullYear();
        if (age > 10) score += 0.2;
        else if (age > 5) score += 0.1;
        if (age > 20) score += 0.1;
    }
    return Math.max(0, Math.min(1, score));
}
