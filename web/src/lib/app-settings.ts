import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

const SINGLETON_ID = "singleton";

export type AppSettings = typeof appSettings.$inferSelect;

// Read the single settings row, inserting defaults on first access. The
// bootstrap seeds this row too; the lazy insert just covers fresh dev DBs.
export async function getAppSettings(): Promise<AppSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, SINGLETON_ID)).limit(1);
  if (row) return row;
  const [created] = await db
    .insert(appSettings)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost a race with a concurrent insert — re-read.
  const [again] = await db.select().from(appSettings).where(eq(appSettings.id, SINGLETON_ID)).limit(1);
  return again;
}

export async function updateAppSettings(
  patch: Partial<Omit<AppSettings, "id" | "updatedAt">>
): Promise<AppSettings> {
  await getAppSettings(); // ensure the row exists
  const [row] = await db
    .update(appSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(appSettings.id, SINGLETON_ID))
    .returning();
  return row;
}

// Split the stored comma list into trimmed, lowercased bare hostnames.
export function parseAllowedHosts(csv: string): string[] {
  return csv
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
