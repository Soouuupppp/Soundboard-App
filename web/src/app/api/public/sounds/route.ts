import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds, users } from "@/db/schema";

export const runtime = "nodejs";

// GET /api/public/sounds — list every public sound with uploader info.
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

  return NextResponse.json({ sounds: rows });
}
