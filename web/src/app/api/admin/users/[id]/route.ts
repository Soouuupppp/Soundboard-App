import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { users, roles } from "@/db/schema";
import { PatchUserBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const parsed = PatchUserBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true });

  // If a roleId was provided (and non-null), verify it exists — otherwise the
  // FK will accept it lazily and a typo silently sticks an invalid id on the user.
  if (data.roleId) {
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, data.roleId)).limit(1);
    if (!r) return NextResponse.json({ error: "role not found" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if ("roleId" in data) updates.roleId = data.roleId ?? null;
  if ("maxFileSizeOverride" in data) updates.maxFileSizeOverride = data.maxFileSizeOverride ?? null;
  if ("maxTotalStorageOverride" in data) updates.maxTotalStorageOverride = data.maxTotalStorageOverride ?? null;
  if ("canUploadOverride" in data) updates.canUploadOverride = data.canUploadOverride ?? null;
  if ("profileLimitOverride" in data) updates.profileLimitOverride = data.profileLimitOverride ?? null;
  if ("aiQuotaSecondsOverride" in data) updates.aiQuotaSecondsOverride = data.aiQuotaSecondsOverride ?? null;
  if ("canUseAiOverride" in data) updates.canUseAiOverride = data.canUseAiOverride ?? null;

  const [row] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ user: row });
}
