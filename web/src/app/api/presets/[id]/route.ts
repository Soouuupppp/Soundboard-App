import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sharedPresets } from "@/db/schema";
import { isUuid } from "@/lib/validation";

export const runtime = "nodejs";

// DELETE /api/presets/[id] — remove a shared preset. Owner can delete their own;
// admins can delete any (moderation). Mirrors the owner/admin split used for
// sounds (owner route vs /api/admin/sounds/[id]).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [row] = await db.select().from(sharedPresets).where(eq(sharedPresets.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (row.ownerId !== session.user.id && !isAdminSession(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.delete(sharedPresets).where(eq(sharedPresets.id, id));
  return NextResponse.json({ ok: true });
}
