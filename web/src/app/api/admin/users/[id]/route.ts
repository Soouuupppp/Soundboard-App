import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";

export const runtime = "nodejs";

// PATCH: { roleId?: string | null, maxFileSizeOverride?: number | null, maxTotalStorageOverride?: number | null }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if ("roleId" in body) updates.roleId = body.roleId || null;
  if ("maxFileSizeOverride" in body)
    updates.maxFileSizeOverride = body.maxFileSizeOverride === null ? null : Number(body.maxFileSizeOverride);
  if ("maxTotalStorageOverride" in body)
    updates.maxTotalStorageOverride = body.maxTotalStorageOverride === null ? null : Number(body.maxTotalStorageOverride);

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ user: row });
}
