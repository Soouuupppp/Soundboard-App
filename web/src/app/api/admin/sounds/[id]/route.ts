import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { deleteStorageFile } from "@/lib/storage";
import { PatchSoundBody } from "@/lib/validation";

export const runtime = "nodejs";

// PATCH: moderate any sound — rename or force-unpublish. Unlike the owner-facing
// route in /api/sounds/[id], this is not scoped to the caller.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const parsed = PatchSoundBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db.update(sounds).set(updates).where(eq(sounds.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ sound: row });
}

// DELETE: remove any sound, its file, and (via cascade) every board entry that
// references it — including references on other users' boards.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const [row] = await db.select().from(sounds).where(eq(sounds.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.delete(sounds).where(eq(sounds.id, id));
  try {
    await deleteStorageFile(row.storagePath);
  } catch {
    // best-effort
  }
  return NextResponse.json({ ok: true });
}
