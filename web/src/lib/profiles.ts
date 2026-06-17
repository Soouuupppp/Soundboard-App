import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles, roles, users } from "@/db/schema";

// ver/1.4.1 Profiles: a profile bundles a per-profile board layout, voice-changer
// config + applied per-clip FX. The cap on how many a user may create resolves
// user override → role default → env, mirroring lib/quota.ts.

export const DEFAULT_PROFILE_LIMIT = Number(process.env.DEFAULT_PROFILE_LIMIT ?? 5);

export type ProfileRow = typeof profiles.$inferSelect;

// Resolve the per-user max number of profiles: user.profileLimitOverride →
// role.profileLimit → env DEFAULT_PROFILE_LIMIT.
export async function getProfileLimit(userId: string): Promise<number> {
  const [u] = await db
    .select({ override: users.profileLimitOverride, roleId: users.roleId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.override != null) return u.override;
  if (u?.roleId) {
    const [r] = await db
      .select({ limit: roles.profileLimit })
      .from(roles)
      .where(eq(roles.id, u.roleId))
      .limit(1);
    if (r?.limit != null) return r.limit;
  }
  return DEFAULT_PROFILE_LIMIT;
}

// All of a user's profiles, ordered by position (then createdAt as a tiebreak).
export async function getUserProfiles(userId: string): Promise<ProfileRow[]> {
  return db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .orderBy(asc(profiles.position), asc(profiles.createdAt));
}

export async function getProfileCount(userId: string): Promise<number> {
  const rows = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  return rows.length;
}

// Ensure a user has at least one profile (a "Default"). New users created after
// the bootstrap migration ran won't have one yet, so any read path lazily seeds
// it. Returns the user's profiles (ordered), guaranteed non-empty.
export async function ensureDefaultProfile(userId: string): Promise<ProfileRow[]> {
  const existing = await getUserProfiles(userId);
  if (existing.length > 0) return existing;
  await db
    .insert(profiles)
    .values({ userId, name: "Default", position: 0, isDefault: true })
    .onConflictDoNothing();
  return getUserProfiles(userId);
}

// Resolve which profile a request targets: the given id if it exists and belongs
// to the user, otherwise the user's default (seeding one if the user has none).
export async function resolveProfile(userId: string, profileId?: string | null): Promise<ProfileRow> {
  const list = await ensureDefaultProfile(userId);
  if (profileId) {
    const found = list.find((p) => p.id === profileId);
    if (found) return found;
  }
  return list.find((p) => p.isDefault) ?? list[0];
}

// Verify a profile id belongs to the caller (used by every per-profile write).
export async function getOwnedProfile(userId: string, profileId: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.userId, userId)))
    .limit(1);
  return row ?? null;
}
