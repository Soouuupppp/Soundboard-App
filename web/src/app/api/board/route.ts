import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { boardEntries, sounds, users } from "@/db/schema";

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

  return NextResponse.json({ entries: rows });
}

// POST /api/board — add an existing sound to the user's board (own or public).
// Body: { soundId: string, keybind?: string, label?: string }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const soundId = String(body.soundId ?? "");
  if (!soundId) return NextResponse.json({ error: "missing soundId" }, { status: 400 });

  const [s] = await db.select().from(sounds).where(eq(sounds.id, soundId)).limit(1);
  if (!s) return NextResponse.json({ error: "sound not found" }, { status: 404 });
  if (s.ownerId !== session.user.id && !s.isPublic) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [row] = await db
    .insert(boardEntries)
    .values({
      userId: session.user.id,
      soundId: s.id,
      label: typeof body.label === "string" ? body.label : null,
      keybind: typeof body.keybind === "string" ? body.keybind : null,
    })
    .returning();
  return NextResponse.json({ entry: row });
}
