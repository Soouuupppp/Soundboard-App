import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sounds, users, boardEntries } from "@/db/schema";
import { getTagsForSounds } from "@/lib/tags";

export const runtime = "nodejs";

// GET /api/admin/sounds — every uploaded sound across all users, with owner
// info and how many boards reference it (the uploader's own board included).
export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = await db
    .select({
      id: sounds.id,
      name: sounds.name,
      originalFilename: sounds.originalFilename,
      sizeBytes: sounds.sizeBytes,
      isPublic: sounds.isPublic,
      createdAt: sounds.createdAt,
      ownerId: sounds.ownerId,
      ownerName: users.name,
      ownerImage: users.image,
      ownerDiscordId: users.discordId,
      // count(boardEntry.id) is 0 when there are no references (left join nulls).
      boardCount: sql<number>`count(${boardEntries.id})`.mapWith(Number),
    })
    .from(sounds)
    .leftJoin(users, eq(users.id, sounds.ownerId))
    .leftJoin(boardEntries, eq(boardEntries.soundId, sounds.id))
    .groupBy(sounds.id, users.id)
    .orderBy(desc(sounds.createdAt));

  const tagMap = await getTagsForSounds(rows.map((r) => r.id));
  const out = rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));

  return NextResponse.json({ sounds: out });
}
