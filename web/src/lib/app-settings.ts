import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, roles, users } from "@/db/schema";

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

// Effective YouTube-import config for a single user. Each limit resolves
// per-role override → global appSettings default. `enabled` keeps the global
// ytEnabled as a hard master switch: a role can only *disable* below it (a true
// override never enables import while the master is off).
export type YtConfig = {
  enabled: boolean;
  maxDurationSec: number;
  maxFileSize: number;
  concurrency: number;
};

export async function getYtConfigForUser(userId: string): Promise<YtConfig> {
  const settings = await getAppSettings();

  let role:
    | {
        ytEnabledOverride: boolean | null;
        ytMaxDurationSecOverride: number | null;
        ytMaxFileSizeOverride: number | null;
        ytConcurrencyOverride: number | null;
      }
    | null = null;

  const [u] = await db.select({ roleId: users.roleId }).from(users).where(eq(users.id, userId)).limit(1);
  if (u?.roleId) {
    const [r] = await db
      .select({
        ytEnabledOverride: roles.ytEnabledOverride,
        ytMaxDurationSecOverride: roles.ytMaxDurationSecOverride,
        ytMaxFileSizeOverride: roles.ytMaxFileSizeOverride,
        ytConcurrencyOverride: roles.ytConcurrencyOverride,
      })
      .from(roles)
      .where(eq(roles.id, u.roleId))
      .limit(1);
    role = r ?? null;
  }

  return {
    enabled: settings.ytEnabled && (role?.ytEnabledOverride ?? true),
    maxDurationSec: role?.ytMaxDurationSecOverride ?? settings.ytMaxDurationSec,
    maxFileSize: role?.ytMaxFileSizeOverride ?? settings.ytMaxFileSize,
    concurrency: role?.ytConcurrencyOverride ?? settings.ytConcurrency,
  };
}

// Split the stored comma list into trimmed, lowercased bare hostnames.
export function parseAllowedHosts(csv: string): string[] {
  return csv
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
