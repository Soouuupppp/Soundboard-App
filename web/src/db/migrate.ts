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

const sql = postgres(url, { max: 1 });

async function main() {
  const bootstrapPath = join(__dirname, "bootstrap.sql");
  const ddl = readFileSync(bootstrapPath, "utf8");
  await sql.unsafe(ddl);

  // Seed system roles.
  const defaultFile = Number(process.env.DEFAULT_MAX_FILE_SIZE ?? 5 * 1024 * 1024);
  const defaultTotal = Number(process.env.DEFAULT_MAX_TOTAL_STORAGE ?? 50 * 1024 * 1024);

  await sql`
    INSERT INTO "role" ("name", "defaultMaxFileSize", "defaultMaxTotalStorage", "isSystem")
    VALUES
      ('user',  ${defaultFile}, ${defaultTotal}, true),
      ('admin', ${defaultFile * 4}, ${defaultTotal * 20}, true)
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
