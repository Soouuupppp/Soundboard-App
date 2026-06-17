import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { profiles, profilePlacements } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { ensureDefaultProfile, getOwnedProfile, getProfileLimit } from "@/lib/profiles";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// POST /api/profiles/[id]/clone — deep-copy a profile (its placements + voiceFx +
// soundFx) into a new profile named "<name> clone", appended at the end. 409 at cap.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, { capacity: 60, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const src = await getOwnedProfile(session.user.id, id);
  if (!src) return NextResponse.json({ error: "not found" }, { status: 404 });

  const existing = await ensureDefaultProfile(session.user.id);
  const limit = await getProfileLimit(session.user.id);
  if (existing.length >= limit) {
    return NextResponse.json({ error: "profile limit reached", limit }, { status: 409 });
  }

  const nextPos = existing.reduce((m, p) => Math.max(m, p.position), -1) + 1;
  const [clone] = await db
    .insert(profiles)
    .values({
      userId: session.user.id,
      name: `${src.name} clone`.slice(0, 60),
      position: nextPos,
      isDefault: false,
      voiceFx: src.voiceFx,
      soundFx: src.soundFx,
    })
    .returning();

  // Deep-copy the source profile's placements into the clone (new ids).
  const srcPlacements = await db
    .select()
    .from(profilePlacements)
    .where(eq(profilePlacements.profileId, src.id));
  if (srcPlacements.length) {
    await db.insert(profilePlacements).values(
      srcPlacements.map((p) => ({
        profileId: clone.id,
        soundId: p.soundId,
        onBoard: p.onBoard,
        position: p.position,
        label: p.label,
        keybind: p.keybind,
        controllerBind: p.controllerBind,
      })),
    );
  }

  return NextResponse.json({ profile: clone });
}
