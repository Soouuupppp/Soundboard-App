import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// `postgres` is lazy — it does not open a TCP connection until a query runs.
// That means we can safely construct the client at module-load even when
// DATABASE_URL is missing (e.g. during `next build`'s page-data collection
// step). We fall back to a harmless placeholder URL in that case.
const url = process.env.DATABASE_URL || "postgres://build:build@localhost:5432/build";

const globalForDb = globalThis as unknown as { _pg?: ReturnType<typeof postgres> };
const client = globalForDb._pg ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb._pg = client;

export const db = drizzle(client, { schema });
export { schema };
