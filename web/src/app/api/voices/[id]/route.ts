import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sharedVoices } from "@/db/schema";
import { isUuid } from "@/lib/validation";

export const runtime = "nodejs";

// DELETE /api/voices/[id] — remove a shared voice. Owner can delete their own;
// admins can delete any (moderation). Mirrors /api/presets/[id].
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [row] = await db.select().from(sharedVoices).where(eq(sharedVoices.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (row.ownerId !== session.user.id && !isAdminSession(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.delete(sharedVoices).where(eq(sharedVoices.id, id));
  return NextResponse.json({ ok: true });
}
