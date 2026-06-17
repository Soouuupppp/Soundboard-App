import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sharedPresets } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";

const PatchBody = z.object({ isOfficial: z.boolean() }).strict();

// PATCH /api/admin/presets/[id] — admin-only: promote/demote the official flag on
// any shared preset. (Deletion goes through DELETE /api/presets/[id]'s admin-any
// branch.) Mirrors /api/admin/sounds/[id]'s admin moderation pattern.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: sharedPresets.id })
    .from(sharedPresets)
    .where(eq(sharedPresets.id, id))
    .limit(1);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.update(sharedPresets).set({ isOfficial: parsed.data.isOfficial }).where(eq(sharedPresets.id, id));
  return NextResponse.json({ ok: true });
}
