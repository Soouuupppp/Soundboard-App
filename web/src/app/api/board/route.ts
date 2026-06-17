import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { boardEntries, profilePlacements, sounds, users } from "@/db/schema";
import { PostBoardEntryBody } from "@/lib/validation";
import { getTagsForSounds } from "@/lib/tags";
import { resolveProfile } from "@/lib/profiles";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/board?profileId=X — the caller's Saved library (global boardEntry rows)
// merged with profile X's per-profile placement (onBoard/position/label/keybind/
// controllerBind). entry.id stays the boardEntry id (stable Saved id); a sound with
// no placement in this profile reads as saved-only (onBoard false, no binds).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const profileId = new URL(req.url).searchParams.get("profileId");
  const profile = await resolveProfile(session.user.id, profileId);

  const rows = await db
    .select({
      entry: boardEntries,
      sound: sounds,
      ownerName: users.name,
    })
    .from(boardEntries)
    .innerJoin(sounds, eq(sounds.id, boardEntries.soundId))
    .innerJoin(users, eq(users.id, sounds.ownerId))
    .where(eq(boardEntries.userId, session.user.id));

  // Per-profile placements for this profile, keyed by soundId.
  const placements = await db
    .select()
    .from(profilePlacements)
    .where(eq(profilePlacements.profileId, profile.id));
  const placeBySound = new Map(placements.map((p) => [p.soundId, p]));

  const tagMap = await getTagsForSounds(rows.map((r) => r.sound.id));
  const entries = rows.map((r) => {
    const p = placeBySound.get(r.sound.id);
    return {
      entry: {
        id: r.entry.id,
        soundId: r.sound.id,
        label: p?.label ?? null,
        keybind: p?.keybind ?? null,
        controllerBind: p?.controllerBind ?? null,
        position: p?.position ?? 0,
        onBoard: p?.onBoard ?? false,
      },
      sound: r.sound,
      ownerName: r.ownerName,
      tags: tagMap.get(r.sound.id) ?? [],
    };
  });
  // Stable order for the Saved grid; the Board grid re-sorts by position client-side.
  entries.sort((a, b) => a.entry.position - b.entry.position);

  return NextResponse.json({ entries, profileId: profile.id });
}

// POST /api/board — add an existing sound to the user's Saved library (own or
// public). Membership is GLOBAL (not per-profile); no placement is created, so a
// newly saved clip is saved-only in every profile until promoted to a board.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, {
    capacity: 60,
    refillPerSec: 2,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const parsed = PostBoardEntryBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { soundId, label, keybind } = parsed.data;

  const [s] = await db.select().from(sounds).where(eq(sounds.id, soundId)).limit(1);
  if (!s) return NextResponse.json({ error: "sound not found" }, { status: 404 });
  if (s.ownerId !== session.user.id && !s.isPublic) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Authors already own their clips — they shouldn't re-add them via the
  // public browser. They can still upload and have it auto-placed on their
  // own board through the regular upload flow.
  if (s.ownerId === session.user.id) {
    return NextResponse.json({ error: "cannot add your own clip from public" }, { status: 400 });
  }

  // A Saved library is a *set* of references — adding the same clip twice is a
  // no-op. Return the existing entry idempotently instead of creating a dupe.
  const [dupe] = await db
    .select()
    .from(boardEntries)
    .where(and(eq(boardEntries.userId, session.user.id), eq(boardEntries.soundId, s.id)))
    .limit(1);
  if (dupe) return NextResponse.json({ entry: dupe });

  const [row] = await db
    .insert(boardEntries)
    .values({
      userId: session.user.id,
      soundId: s.id,
      label: label ?? null,
      keybind: keybind ?? null,
    })
    .returning();
  return NextResponse.json({ entry: row });
}
