import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, roles } from "@/db/schema";
import { getAppSettings } from "@/lib/app-settings";

// ver/1.4.1 Paid AI voice quota. Mirrors lib/quota.ts: the per-user cap resolves
// user override → role default → env. The unit is SECONDS of AI audio, unified
// across providers (one pool), reset each calendar month. Usage rides on two
// columns of `user` (aiSecondsUsed + aiUsagePeriod="YYYY-MM"); a new month resets
// the counter lazily on the next consume. BYO-key calls bypass metering entirely
// (the caller passes their own provider key, so they spend their own credits).

export const DEFAULT_AI_QUOTA_SECONDS = Number(process.env.DEFAULT_AI_QUOTA_SECONDS ?? 300);

// Current usage period — calendar month in UTC, "YYYY-MM". UTC so a month
// boundary is unambiguous regardless of where the server runs.
export function currentAiPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type AiUsage = {
  used: number; // seconds consumed this period (0 when the stored period is stale)
  cap: number; // resolved monthly cap (seconds)
  enabled: boolean; // global aiEnabled master toggle
  canUse: boolean; // resolved per-user permission
};

// Resolve a user's monthly AI cap: user override → role default → env default.
export async function getAiQuotaSeconds(userId: string): Promise<number> {
  const [u] = await db
    .select({ override: users.aiQuotaSecondsOverride, roleId: users.roleId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.override != null) return u.override;
  if (u?.roleId) {
    const [r] = await db
      .select({ q: roles.aiQuotaSecondsMonthly })
      .from(roles)
      .where(eq(roles.id, u.roleId))
      .limit(1);
    if (r?.q != null) return r.q;
  }
  return DEFAULT_AI_QUOTA_SECONDS;
}

// Whether a user may use AI voice: user override → role canUseAi → allowed
// (legacy / no-role accounts). The global aiEnabled master toggle is a separate,
// hard gate checked in checkAiQuota.
export async function canUserUseAi(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ override: users.canUseAiOverride, roleId: users.roleId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.override != null) return u.override;
  if (!u?.roleId) return true;
  const [r] = await db
    .select({ canUseAi: roles.canUseAi })
    .from(roles)
    .where(eq(roles.id, u.roleId))
    .limit(1);
  return r?.canUseAi ?? true;
}

// Current period's usage + the resolved cap + the master/permission flags, for
// the UI meter (GET /api/ai/usage) and the quota gate. A stale stored period
// reads as 0 used (the counter resets on the next consume).
export async function getAiUsage(userId: string): Promise<AiUsage> {
  const [settings, cap, canUse] = await Promise.all([
    getAppSettings(),
    getAiQuotaSeconds(userId),
    canUserUseAi(userId),
  ]);
  const [u] = await db
    .select({ used: users.aiSecondsUsed, period: users.aiUsagePeriod })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const used = u && u.period === currentAiPeriod() ? u.used : 0;
  return { used, cap, enabled: settings.aiEnabled, canUse };
}

// Add `seconds` to the user's usage for the current period (resetting the counter
// when the stored period is stale). Atomic via a single conditional UPDATE so a
// month rollover can't double-count under concurrent requests.
export async function consumeAiSeconds(userId: string, seconds: number): Promise<void> {
  const n = Math.max(0, Math.ceil(seconds));
  if (n === 0) return;
  const period = currentAiPeriod();
  await db
    .update(users)
    .set({
      aiSecondsUsed: sql`CASE WHEN ${users.aiUsagePeriod} = ${period} THEN ${users.aiSecondsUsed} + ${n} ELSE ${n} END`,
      aiUsagePeriod: period,
    })
    .where(eq(users.id, userId));
}

export type AiQuotaCheck =
  | { ok: true; remaining: number }
  | { ok: false; status: number; error: string };

// Gate a paid AI request: master toggle → permission → remaining quota. BYO-key
// requests skip the quota check (but still require aiEnabled + permission). The
// returned `status`/`error` map straight onto a NextResponse in the route.
export async function checkAiQuota(
  userId: string,
  opts: { byo?: boolean } = {},
): Promise<AiQuotaCheck> {
  const usage = await getAiUsage(userId);
  if (!usage.enabled) return { ok: false, status: 403, error: "AI voice is disabled" };
  if (!usage.canUse) return { ok: false, status: 403, error: "AI voice is not enabled for your role" };
  if (opts.byo) return { ok: true, remaining: Infinity };
  const remaining = usage.cap - usage.used;
  if (remaining <= 0) return { ok: false, status: 429, error: "Monthly AI quota exhausted" };
  return { ok: true, remaining };
}
