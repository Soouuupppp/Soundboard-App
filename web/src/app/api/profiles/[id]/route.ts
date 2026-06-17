import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { PatchProfileBody, isUuid } from "@/lib/validation";
import { getOwnedProfile, getProfileCount } from "@/lib/profiles";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// PATCH /api/profiles/[id] — rename / reorder (position) / persist voiceFx|soundFx
// config. All fields optional; only the caller's own profile is editable.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, { capacity: 60, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = PatchProfileBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const owned = await getOwnedProfile(session.user.id, id);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const data = parsed.data;
  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.position !== undefined) updates.position = data.position;
  if ("voiceFx" in data) updates.voiceFx = data.voiceFx ?? null;
  if ("soundFx" in data) updates.soundFx = data.soundFx ?? null;
  if (Object.keys(updates).length === 0) return NextResponse.json({ profile: owned });

  const [row] = await db
    .update(profiles)
    .set(updates)
    .where(and(eq(profiles.id, id), eq(profiles.userId, session.user.id)))
    .returning();
  return NextResponse.json({ profile: row });
}

// DELETE /api/profiles/[id] — remove a profile (cascades its placements). Refuses
// when it's the user's only profile; the client switches active if it was active.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, { capacity: 60, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const owned = await getOwnedProfile(session.user.id, id);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const count = await getProfileCount(session.user.id);
  if (count <= 1) {
    return NextResponse.json({ error: "cannot delete your only profile" }, { status: 400 });
  }

  await db.delete(profiles).where(and(eq(profiles.id, id), eq(profiles.userId, session.user.id)));
  return NextResponse.json({ ok: true });
}
