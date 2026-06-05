import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds, boardEntries } from "@/db/schema";
import { ensureUserDir } from "@/lib/storage";
import { getUserLimits, getUsedBytes } from "@/lib/quota";

export const runtime = "nodejs";

// GET /api/sounds — list current user's owned sounds.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(sounds)
    .where(eq(sounds.ownerId, session.user.id))
    .orderBy(desc(sounds.createdAt));

  const limits = await getUserLimits(session.user.id);
  const used = await getUsedBytes(session.user.id);
  return NextResponse.json({ sounds: rows, limits, used });
}

// POST /api/sounds — multipart upload. Fields: file (mp3), name?, isPublic? ("true"/"false")
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id || !session.user.discordId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });

  // Validate mp3.
  const okMime = file.type === "audio/mpeg" || file.type === "audio/mp3";
  const okExt = file.name.toLowerCase().endsWith(".mp3");
  if (!okMime || !okExt) {
    return NextResponse.json({ error: "only .mp3 files are allowed" }, { status: 415 });
  }

  // Quota checks.
  const limits = await getUserLimits(session.user.id);
  if (file.size > limits.maxFileSize) {
    return NextResponse.json(
      { error: `file too large (max ${limits.maxFileSize} bytes)` },
      { status: 413 }
    );
  }
  const used = await getUsedBytes(session.user.id);
  if (used + file.size > limits.maxTotalStorage) {
    return NextResponse.json(
      { error: `would exceed total storage (used ${used}, limit ${limits.maxTotalStorage})` },
      { status: 413 }
    );
  }

  // Write file.
  const dir = await ensureUserDir(session.user.discordId);
  const id = randomUUID();
  const storageRel = `${session.user.discordId}/${id}.mp3`;
  const abs = join(dir, `${id}.mp3`);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(abs, buf);

  const name = String(form.get("name") ?? file.name.replace(/\.mp3$/i, ""));
  const isPublic = String(form.get("isPublic") ?? "false") === "true";

  const [row] = await db
    .insert(sounds)
    .values({
      id,
      ownerId: session.user.id,
      name,
      originalFilename: file.name,
      storagePath: storageRel,
      sizeBytes: file.size,
      isPublic,
    })
    .returning();

  // Auto-add to the uploader's own board.
  await db.insert(boardEntries).values({
    userId: session.user.id,
    soundId: row.id,
  });

  return NextResponse.json({ sound: row });
}
