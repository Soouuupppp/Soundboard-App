// Runs at container start. Creates tables if missing, then seeds the default roles.
// Idempotent: safe to run on every boot.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Silence Postgres NOTICEs — the bootstrap is intentionally idempotent
// (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so every re-run would
// otherwise spam "relation already exists, skipping" on boot.
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  const bootstrapPath = join(__dirname, "bootstrap.sql");
  const ddl = readFileSync(bootstrapPath, "utf8");
  await sql.unsafe(ddl);

  // Seed system roles.
  const defaultFile = Number(process.env.DEFAULT_MAX_FILE_SIZE ?? 5 * 1024 * 1024);
  const defaultTotal = Number(process.env.DEFAULT_MAX_TOTAL_STORAGE ?? 50 * 1024 * 1024);

  // Three system roles:
  //   user        — default; can browse/use public clips but NOT upload.
  //   whitelisted — same quotas as user, but allowed to upload their own clips.
  //   admin       — full access.
  // ON CONFLICT DO NOTHING keeps this idempotent and never clobbers an admin's
  // later toggles. (Existing pre-canUpload deployments keep user.canUpload=TRUE
  // via the bootstrap backfill; flip it off in /admin to enforce the whitelist.)
  await sql`
    INSERT INTO "role" ("name", "defaultMaxFileSize", "defaultMaxTotalStorage", "isSystem", "canUpload")
    VALUES
      ('user',        ${defaultFile},     ${defaultTotal},      true, false),
      ('whitelisted', ${defaultFile},     ${defaultTotal},      true, true),
      ('admin',       ${defaultFile * 4}, ${defaultTotal * 20}, true, true)
    ON CONFLICT ("name") DO NOTHING
  `;

  console.log("[migrate] ok");
  await sql.end();
}

main().catch(async (e) => {
  console.error("[migrate] failed:", e);
  await sql.end();
  process.exit(1);
});
