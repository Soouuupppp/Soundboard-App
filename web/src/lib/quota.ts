import { eq, sum } from "drizzle-orm";
import { db } from "@/db";
import { sounds, users, roles } from "@/db/schema";

const ENV_FILE = Number(process.env.DEFAULT_MAX_FILE_SIZE ?? 5 * 1024 * 1024);
const ENV_TOTAL = Number(process.env.DEFAULT_MAX_TOTAL_STORAGE ?? 50 * 1024 * 1024);

export type Limits = { maxFileSize: number; maxTotalStorage: number };

export async function getUserLimits(userId: string): Promise<Limits> {
  const [u] = await db
    .select({
      override_file: users.maxFileSizeOverride,
      override_total: users.maxTotalStorageOverride,
      roleId: users.roleId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  let roleFile: number | null = null;
  let roleTotal: number | null = null;
  if (u?.roleId) {
    const [r] = await db
      .select({
        f: roles.defaultMaxFileSize,
        t: roles.defaultMaxTotalStorage,
      })
      .from(roles)
      .where(eq(roles.id, u.roleId))
      .limit(1);
    roleFile = r?.f ?? null;
    roleTotal = r?.t ?? null;
  }

  return {
    maxFileSize: u?.override_file ?? roleFile ?? ENV_FILE,
    maxTotalStorage: u?.override_total ?? roleTotal ?? ENV_TOTAL,
  };
}

export async function getUsedBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sum(sounds.sizeBytes) })
    .from(sounds)
    .where(eq(sounds.ownerId, userId));
  return Number(row?.total ?? 0);
}
