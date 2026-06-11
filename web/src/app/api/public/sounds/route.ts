import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds, users } from "@/db/schema";
import { getTagsForSounds } from "@/lib/tags";

export const runtime = "nodejs";

// GET /api/public/sounds — every public sound with uploader info + tags. The
// viewer's own public clips are included (flagged via `mine`) so the page can
// show them in their own "your clips" row; the client splits the two groups.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: sounds.id,
      name: sounds.name,
      sizeBytes: sounds.sizeBytes,
      createdAt: sounds.createdAt,
      ownerId: sounds.ownerId,
      ownerName: users.name,
      ownerImage: users.image,
    })
    .from(sounds)
    .innerJoin(users, eq(users.id, sounds.ownerId))
    .where(eq(sounds.isPublic, true))
    .orderBy(desc(sounds.createdAt));

  const tagMap = await getTagsForSounds(rows.map((r) => r.id));
  // Don't leak the internal owner UUID to the client — `mine` is all the UI
  // needs, and it's resolved here server-side.
  const out = rows.map(({ ownerId, ...r }) => ({
    ...r,
    mine: ownerId === session.user!.id,
    tags: tagMap.get(r.id) ?? [],
  }));

  return NextResponse.json({ sounds: out });
}
