import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { deleteStorageFile } from "@/lib/storage";
import { PatchSoundBody, isUuid } from "@/lib/validation";
import { setSoundTags } from "@/lib/tags";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// PATCH: rename, toggle public, set tags
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`sound-mut:${clientKey(req, session.user.id)}`, {
    capacity: 30,
    refillPerSec: 1,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = PatchSoundBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  // Tags live in a join table, not on the sound row, so split them out. A
  // tags-only edit touches no sound column, so we check ownership explicitly
  // rather than leaning on the UPDATE's WHERE to 404.
  const { tags: nextTags, ...updates } = parsed.data;
  if (Object.keys(updates).length === 0 && nextTags === undefined) {
    return NextResponse.json({ ok: true });
  }

  const [owned] = await db
    .select({ id: sounds.id })
    .from(sounds)
    .where(and(eq(sounds.id, id), eq(sounds.ownerId, session.user.id)))
    .limit(1);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (nextTags !== undefined) await setSoundTags(id, nextTags);

  let row;
  if (Object.keys(updates).length > 0) {
    [row] = await db.update(sounds).set(updates).where(eq(sounds.id, id)).returning();
  } else {
    [row] = await db.select().from(sounds).where(eq(sounds.id, id)).limit(1);
  }
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
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
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
