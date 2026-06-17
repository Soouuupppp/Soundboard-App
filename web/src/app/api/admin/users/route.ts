import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { users, roles, profiles } from "@/db/schema";
import { DEFAULT_PROFILE_LIMIT } from "@/lib/profiles";
import { DEFAULT_AI_QUOTA_SECONDS, currentAiPeriod } from "@/lib/ai-quota";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      discordId: users.discordId,
      roleId: users.roleId,
      roleName: roles.name,
      roleCanUpload: roles.canUpload,
      roleProfileLimit: roles.profileLimit,
      maxFileSizeOverride: users.maxFileSizeOverride,
      maxTotalStorageOverride: users.maxTotalStorageOverride,
      canUploadOverride: users.canUploadOverride,
      profileLimitOverride: users.profileLimitOverride,
      // ver/1.4.1 Paid AI voice: overrides + role defaults + raw usage counter.
      roleCanUseAi: roles.canUseAi,
      roleAiQuotaSecondsMonthly: roles.aiQuotaSecondsMonthly,
      aiQuotaSecondsOverride: users.aiQuotaSecondsOverride,
      canUseAiOverride: users.canUseAiOverride,
      aiSecondsUsed: users.aiSecondsUsed,
      aiUsagePeriod: users.aiUsagePeriod,
      // Used profile count (per-user) for the admin's used/cap display.
      profileCount: sql<number>`(SELECT COUNT(*)::int FROM ${profiles} WHERE ${profiles.userId} = ${users.id})`,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId));
  // Resolve the effective caps (override → role → env) for display. The raw usage
  // counter (aiSecondsUsed/aiUsagePeriod) is folded into `aiUsed` and omitted.
  const period = currentAiPeriod();
  const withCap = rows.map((r) => {
    const { aiSecondsUsed, aiUsagePeriod, ...rest } = r;
    return {
      ...rest,
      profileLimit: rest.profileLimitOverride ?? rest.roleProfileLimit ?? DEFAULT_PROFILE_LIMIT,
      aiCap: rest.aiQuotaSecondsOverride ?? rest.roleAiQuotaSecondsMonthly ?? DEFAULT_AI_QUOTA_SECONDS,
      // Stale stored period reads as 0 used (counter resets on next consume).
      aiUsed: aiUsagePeriod === period ? aiSecondsUsed : 0,
    };
  });
  return NextResponse.json({
    users: withCap,
    defaultProfileLimit: DEFAULT_PROFILE_LIMIT,
    defaultAiQuotaSeconds: DEFAULT_AI_QUOTA_SECONDS,
  });
}
