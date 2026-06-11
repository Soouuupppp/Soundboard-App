import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { boardEntries, sounds, users } from "@/db/schema";
import { PostBoardEntryBody } from "@/lib/validation";
import { getTagsForSounds } from "@/lib/tags";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/board — entries for current user, joined with the underlying sound + owner info.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      entry: boardEntries,
      sound: sounds,
      ownerName: users.name,
    })
    .from(boardEntries)
    .innerJoin(sounds, eq(sounds.id, boardEntries.soundId))
    .innerJoin(users, eq(users.id, sounds.ownerId))
    .where(eq(boardEntries.userId, session.user.id))
    .orderBy(boardEntries.position);

  const tagMap = await getTagsForSounds(rows.map((r) => r.sound.id));
  const entries = rows.map((r) => ({ ...r, tags: tagMap.get(r.sound.id) ?? [] }));

  return NextResponse.json({ entries });
}

// POST /api/board — add an existing sound to the user's board (own or public).
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
