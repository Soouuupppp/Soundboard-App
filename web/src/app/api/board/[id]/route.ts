import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { boardEntries, profiles, profilePlacements } from "@/db/schema";
import { PatchBoardEntryBody, isUuid } from "@/lib/validation";
import { getOwnedProfile, resolveProfile } from "@/lib/profiles";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// PATCH /api/board/[id] — [id] is the boardEntry (Saved) id. The keybind / label /
// controllerBind / position / onBoard edit is PER-PROFILE: it upserts the
// placement for (profileId from body | default, this entry's sound). Returns the
// merged entry shape (entry.id = boardEntry.id) so the client state stays stable.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, {
    capacity: 60,
    refillPerSec: 2,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = PatchBoardEntryBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  // The Saved row must belong to the caller; we need its soundId to key the placement.
  const [be] = await db
    .select()
    .from(boardEntries)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)))
    .limit(1);
  if (!be) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Resolve the target profile (validate ownership when an explicit id is sent).
  const data = parsed.data;
  const profile = data.profileId
    ? await getOwnedProfile(session.user.id, data.profileId)
    : await resolveProfile(session.user.id, null);
  if (!profile) return NextResponse.json({ error: "profile not found" }, { status: 404 });

  // Build the set of fields the caller is actually changing.
  const set: Record<string, unknown> = {};
  if ("keybind" in data) set.keybind = data.keybind ?? null;
  if ("controllerBind" in data) set.controllerBind = data.controllerBind ?? null;
  if ("label" in data) set.label = data.label ?? null;
  if (data.position !== undefined) set.position = data.position;
  if (data.onBoard !== undefined) set.onBoard = data.onBoard;

  // Read the existing placement (if any) so we can return a fully-merged entry
  // even when nothing changed.
  const [existing] = await db
    .select()
    .from(profilePlacements)
    .where(and(eq(profilePlacements.profileId, profile.id), eq(profilePlacements.soundId, be.soundId)))
    .limit(1);

  let placement = existing ?? null;
  if (Object.keys(set).length > 0) {
    // Upsert: a new placement defaults to saved-only (onBoard false, pos 0) unless
    // the edit says otherwise, so setting just a keybind doesn't put it on a board.
    const [row] = await db
      .insert(profilePlacements)
      .values({
        profileId: profile.id,
        soundId: be.soundId,
        onBoard: (set.onBoard as boolean | undefined) ?? existing?.onBoard ?? false,
        position: (set.position as number | undefined) ?? existing?.position ?? 0,
        label: (("label" in set ? set.label : existing?.label) as string | null) ?? null,
        keybind: (("keybind" in set ? set.keybind : existing?.keybind) as string | null) ?? null,
        controllerBind:
          (("controllerBind" in set ? set.controllerBind : existing?.controllerBind) as string | null) ?? null,
      })
      .onConflictDoUpdate({
        target: [profilePlacements.profileId, profilePlacements.soundId],
        set,
      })
      .returning();
    placement = row;
  }

  return NextResponse.json({
    entry: {
      id: be.id,
      soundId: be.soundId,
      label: placement?.label ?? null,
      keybind: placement?.keybind ?? null,
      controllerBind: placement?.controllerBind ?? null,
      position: placement?.position ?? 0,
      onBoard: placement?.onBoard ?? false,
    },
  });
}

// DELETE /api/board/[id] — removes the GLOBAL Saved row and, app-side, that
// sound's placements across every profile the caller owns (placements FK soundId,
// not boardEntry.id, so they don't cascade off the boardEntry delete).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, {
    capacity: 60,
    refillPerSec: 2,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [be] = await db
    .select({ soundId: boardEntries.soundId })
    .from(boardEntries)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)))
    .limit(1);

  await db
    .delete(boardEntries)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)));

  if (be) {
    const owned = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.userId, session.user.id));
    const ids = owned.map((p) => p.id);
    if (ids.length) {
      await db
        .delete(profilePlacements)
        .where(and(eq(profilePlacements.soundId, be.soundId), inArray(profilePlacements.profileId, ids)));
    }
  }

  return NextResponse.json({ ok: true });
}
