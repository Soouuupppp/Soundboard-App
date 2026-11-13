import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, roles } from "@/db/schema";
import { ensureDefaultProfile } from "@/lib/profiles";

// The single user every request runs as when AUTH_DISABLED=true (local testing).
// An ordinary `user` row with no `account` row, so nobody can log into it once
// auth is turned back on. The discordId is a fixed NUMERIC string because
// lib/storage.ts only accepts `^\d{5,30}$` as an upload folder name; uploads land
// in data_public/0000000000/ with no change to path safety.
export const SYSTEM_USER_ID = "system";
export const SYSTEM_USER_NAME = "System";
export const SYSTEM_DISCORD_ID = "0000000000";

let ready: Promise<void> | null = null;

// Seed the system user once per process (lazily, from auth()), so turning auth
// off needs no migration step. Gives it the admin role only when it has no role
// yet, so a role changed in /admin sticks.
export function ensureSystemUser(): Promise<void> {
  if (!ready) {
    ready = seed().catch((err) => {
      ready = null; // retry on the next request (e.g. DB not up yet)
      throw err;
    });
  }
  return ready;
}

async function seed() {
  await db
    .insert(users)
    .values({ id: SYSTEM_USER_ID, name: SYSTEM_USER_NAME, discordId: SYSTEM_DISCORD_ID })
    .onConflictDoNothing();

  const [row] = await db
    .select({ roleId: users.roleId })
    .from(users)
    .where(eq(users.id, SYSTEM_USER_ID))
    .limit(1);
  if (row && !row.roleId) {
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "admin")).limit(1);
    if (adminRole) await db.update(users).set({ roleId: adminRole.id }).where(eq(users.id, SYSTEM_USER_ID));
  }

  await ensureDefaultProfile(SYSTEM_USER_ID);
}
