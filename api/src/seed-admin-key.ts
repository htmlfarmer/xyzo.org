import { getDb, closeDb } from "./db";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  const name = arg("name");
  const role = arg("role") as "editorial" | "rss_ingest" | "super" | null;
  if (!name || !role || !["editorial", "rss_ingest", "super"].includes(role)) {
    console.error("Usage: bun run src/seed-admin-key.ts -- --name <name> --role <editorial|rss_ingest|super>");
    process.exit(1);
  }

  const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
  const keyId = `nk_live_${randomBytes(9)}`;
  const secret = randomBytes(32);
  const fullSecret = `${keyId}.${secret}`;

  const hash = await Bun.password.hash(fullSecret, { algorithm: "bcrypt", cost: 12 });
  const sql = getDb();
  await sql`
    INSERT INTO admin_keys (key_id, name, key_hash, role)
    VALUES (${keyId}, ${name}, ${hash}, ${role})
  `;

  console.log("============================================================");
  console.log("SAVE THIS KEY NOW — it will NOT be shown again.");
  console.log(`Name: ${name}`);
  console.log(`Role: ${role}`);
  console.log(`X-Admin-Key: ${fullSecret}`);
  console.log("============================================================");

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });