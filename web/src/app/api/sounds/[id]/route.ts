import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { deleteStorageFile } from "@/lib/storage";

export const runtime = "nodejs";

// PATCH: rename, toggle public
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.isPublic === "boolean") updates.isPublic = body.isPublic;
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db
    .update(sounds)
    .set(updates)
    .where(and(eq(sounds.id, id), eq(sounds.ownerId, session.user.id)))
    .returning();

  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ sound: row });
}

// DELETE: remove sound (and via cascade, any board entries referencing it)
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const [row] = await db
    .select()
    .from(sounds)
    .where(and(eq(sounds.id, id), eq(sounds.ownerId, session.user.id)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.delete(sounds).where(eq(sounds.id, id));
  try {
    await deleteStorageFile(row.storagePath);
  } catch {
    // best-effort
  }
  return NextResponse.json({ ok: true });
}
