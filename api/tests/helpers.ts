import { getDb, closeDb } from "../src/db";

export { closeDb };

export async function truncateAll(): Promise<void> {
  const url = process.env.XYZO_DB_URL ?? process.env.NEWSIUM_DB_URL ?? "";
  const isTestEnv = process.env.NODE_ENV === "test";
  const isTestDb = /test/i.test(url) || url.endsWith("/test") || url.includes("_test");
  if (!isTestEnv || !isTestDb) {
    throw new Error(
      `SAFETY ERROR: Refusing to truncate database! NODE_ENV must be 'test' and database URL must contain 'test'. Current URL: ${url.replace(/:[^:@]+@/, ":***@")}`
    );
  }
  const sql = getDb();
  await sql`TRUNCATE pins, editorial_details, community_details, rss_details, admin_keys, news_articles, news_locations
            RESTART IDENTITY CASCADE`;
}

export async function seedAdminKey(name: string, role: "editorial" | "rss_ingest" | "super" = "editorial"): Promise<string> {
  const sql = getDb();
  const keyId = `nk_test_${Math.random().toString(36).slice(2, 11)}`;
  const secret = Math.random().toString(36).slice(2, 34);
  const fullSecret = `${keyId}.${secret}`;
  const hash = await Bun.password.hash(fullSecret, { algorithm: "bcrypt", cost: 4 });
  await sql`
    INSERT INTO admin_keys (key_id, name, key_hash, role)
    VALUES (${keyId}, ${name}, ${hash}, ${role})
  `;
  return fullSecret;
}

export async function withCleanup<T>(body: () => Promise<T>): Promise<T> {
  await truncateAll();
  try {
    return await body();
  } finally {
    await truncateAll();
    await closeDb();
  }
}
