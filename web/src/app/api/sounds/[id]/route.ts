import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { deleteStorageFile } from "@/lib/storage";
import { PatchSoundBody } from "@/lib/validation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// PATCH: rename, toggle public
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`sound-mut:${clientKey(req, session.user.id)}`, {
    capacity: 30,
    refillPerSec: 1,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  const parsed = PatchSoundBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const updates = parsed.data;
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
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`sound-mut:${clientKey(req, session.user.id)}`, {
    capacity: 30,
    refillPerSec: 1,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

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
