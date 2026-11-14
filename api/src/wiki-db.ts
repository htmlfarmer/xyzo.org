import postgres from "postgres";

let wikiSql: postgres.Sql | null = null;

export function getWikiDb(): postgres.Sql {
  if (!wikiSql) {
    const url = process.env.XYZO_WIKI_DB_URL;
    if (!url) throw new Error("XYZO_WIKI_DB_URL is required");
    wikiSql = postgres(url, {
      max: 5,
      idle_timeout: 30,
      types: { bigint: postgres.BigInt },
    });
  }
  return wikiSql;
}

export async function closeWikiDb(): Promise<void> {
  if (wikiSql) {
    try {
      await wikiSql.end({ timeout: 5 });
    } catch {
      // ignore shutdown errors
    }
    wikiSql = null;
  }
}
