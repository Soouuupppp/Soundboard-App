import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sharedPresets, users } from "@/db/schema";
import { PostSharedPresetBody } from "@/lib/validation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Per-user cap on published presets — keeps one account from flooding the library.
const MAX_PER_USER = 50;

// GET /api/presets — the shared preset library. Official (admin-curated) first,
// then newest. Joins the owner for a display name/avatar but, like
// /api/public/sounds, never leaks the internal owner UUID — a `mine` flag is all
// the client needs and it's resolved here.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: sharedPresets.id,
      name: sharedPresets.name,
      effects: sharedPresets.effects,
      isOfficial: sharedPresets.isOfficial,
      createdAt: sharedPresets.createdAt,
      ownerId: sharedPresets.ownerId,
      ownerName: users.name,
      ownerImage: users.image,
    })
    .from(sharedPresets)
    .innerJoin(users, eq(users.id, sharedPresets.ownerId))
    .orderBy(desc(sharedPresets.isOfficial), desc(sharedPresets.createdAt));

  const out = rows.map(({ ownerId, effects, ...r }) => ({
    ...r,
    mine: ownerId === session.user!.id,
    // Parse defensively — a malformed row shouldn't 500 the whole list.
    effects: safeParseEffects(effects),
  }));

  return NextResponse.json({ presets: out });
}

function safeParseEffects(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// POST /api/presets — publish the current effect chain to the shared library.
// `isOfficial` is honored only for admins (lets an admin author/publish a
// featured preset in one call); regular users always publish a normal preset.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`preset-mut:${clientKey(req, session.user.id)}`, {
    capacity: 30,
    refillPerSec: 1,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const parsed = PostSharedPresetBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const mine = await db
    .select({ id: sharedPresets.id })
    .from(sharedPresets)
    .where(eq(sharedPresets.ownerId, session.user.id));
  if (mine.length >= MAX_PER_USER) {
    return NextResponse.json(
      { error: `You can publish at most ${MAX_PER_USER} presets. Delete one first.` },
      { status: 409 }
    );
  }

  const isOfficial = parsed.data.isOfficial === true && isAdminSession(session);

  const [row] = await db
    .insert(sharedPresets)
    .values({
      ownerId: session.user.id,
      name: parsed.data.name,
      effects: JSON.stringify(parsed.data.effects),
      isOfficial,
    })
    .returning();

  return NextResponse.json({ preset: { id: row.id, name: row.name, isOfficial: row.isOfficial } });
}
