import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sharedVoices } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";

const PatchBody = z.object({ isOfficial: z.boolean() }).strict();

// PATCH /api/admin/voices/[id] — admin-only: promote/demote the official flag on any
// shared voice. (Deletion goes through DELETE /api/voices/[id]'s admin-any branch.)
// Mirrors /api/admin/presets/[id].
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
    .select({ id: sharedVoices.id })
    .from(sharedVoices)
    .where(eq(sharedVoices.id, id))
    .limit(1);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.update(sharedVoices).set({ isOfficial: parsed.data.isOfficial }).where(eq(sharedVoices.id, id));
  return NextResponse.json({ ok: true });
}
