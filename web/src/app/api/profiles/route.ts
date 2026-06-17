import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { PostProfileBody } from "@/lib/validation";
import { ensureDefaultProfile, getProfileLimit, getUserProfiles } from "@/lib/profiles";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/profiles — the caller's profiles (ordered), seeding a Default if none.
// Includes the per-profile voiceFx/soundFx config (small, ≤ profile cap rows) so
// the client can hydrate the active profile without a second round-trip.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const list = await ensureDefaultProfile(session.user.id);
  const limit = await getProfileLimit(session.user.id);
  return NextResponse.json({
    profiles: list.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      isDefault: p.isDefault,
      voiceFx: p.voiceFx,
      soundFx: p.soundFx,
    })),
    limit,
  });
}

// POST /api/profiles — create a new empty profile (appended at the end). 409 at cap.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, { capacity: 60, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const parsed = PostProfileBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const existing = await ensureDefaultProfile(session.user.id);
  const limit = await getProfileLimit(session.user.id);
  if (existing.length >= limit) {
    return NextResponse.json({ error: "profile limit reached", limit }, { status: 409 });
  }

  const nextPos = existing.reduce((m, p) => Math.max(m, p.position), -1) + 1;
  const [row] = await db
    .insert(profiles)
    .values({ userId: session.user.id, name: parsed.data.name, position: nextPos, isDefault: false })
    .returning();
  return NextResponse.json({ profile: row });
}
