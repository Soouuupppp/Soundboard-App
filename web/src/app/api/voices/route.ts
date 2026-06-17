import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sharedVoices, users } from "@/db/schema";
import { PostSharedVoiceBody } from "@/lib/validation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Per-user cap on published voices — keeps one account from flooding the library.
const MAX_PER_USER = 50;

// GET /api/voices — the shared AI-voice library (parallel of /api/presets). Official
// (admin-curated) first, then newest. Joins the owner for a display name/avatar but
// never leaks the internal owner UUID — a `mine` flag is resolved here.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: sharedVoices.id,
      name: sharedVoices.name,
      engine: sharedVoices.engine,
      config: sharedVoices.config,
      isOfficial: sharedVoices.isOfficial,
      createdAt: sharedVoices.createdAt,
      ownerId: sharedVoices.ownerId,
      ownerName: users.name,
      ownerImage: users.image,
    })
    .from(sharedVoices)
    .innerJoin(users, eq(users.id, sharedVoices.ownerId))
    .orderBy(desc(sharedVoices.isOfficial), desc(sharedVoices.createdAt));

  const out = rows.map(({ ownerId, config, ...r }) => ({
    ...r,
    mine: ownerId === session.user!.id,
    // Parse defensively — a malformed row shouldn't 500 the whole list.
    config: safeParseConfig(config),
  }));

  return NextResponse.json({ voices: out });
}

function safeParseConfig(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// POST /api/voices — publish an AI voice config to the shared library. `isOfficial`
// is honored only for admins (an admin can author a featured voice in one call);
// regular users always publish a normal voice.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`voice-mut:${clientKey(req, session.user.id)}`, {
    capacity: 30,
    refillPerSec: 1,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const parsed = PostSharedVoiceBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const mine = await db
    .select({ id: sharedVoices.id })
    .from(sharedVoices)
    .where(eq(sharedVoices.ownerId, session.user.id));
  if (mine.length >= MAX_PER_USER) {
    return NextResponse.json(
      { error: `You can publish at most ${MAX_PER_USER} voices. Delete one first.` },
      { status: 409 }
    );
  }

  const isOfficial = parsed.data.isOfficial === true && isAdminSession(session);

  const [row] = await db
    .insert(sharedVoices)
    .values({
      ownerId: session.user.id,
      name: parsed.data.name,
      engine: parsed.data.engine,
      config: JSON.stringify(parsed.data.config),
      isOfficial,
    })
    .returning();

  return NextResponse.json({ voice: { id: row.id, name: row.name, isOfficial: row.isOfficial } });
}
