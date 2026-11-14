import postgres from "postgres";

let sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!sql) {
    const url = process.env.XYZO_DB_URL ?? process.env.NEWSIUM_DB_URL;
    if (!url) throw new Error("XYZO_DB_URL (or NEWSIUM_DB_URL legacy alias) is not set");
    sql = postgres(url, {
      max: 10,
      idle_timeout: 30,
      statement_timeout: 30000,
      lock_timeout: 10000,
      types: {
        bigint: postgres.BigInt,
      },
    });
  }
  return sql;
}

// Intentionally a no-op. bun test runs test files in parallel by
// default (max-concurrency 20) and shares the module-level `sql`
// singleton across files. The first afterAll() that calls closeDb()
// would .end() the shared connection mid-query for any sibling file.
// The process exits at end-of-suite so the OS reaps the socket.
// Production code never calls this — tests do, and only to satisfy
// "clean shutdown" habits from Node-era testing patterns.
export async function closeDb(): Promise<void> {
  // no-op
}
