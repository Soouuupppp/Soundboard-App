import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sounds, boardEntries } from "@/db/schema";
import { ensureUserDir } from "@/lib/storage";
import { canUserUpload, getUserLimits, getUsedBytes } from "@/lib/quota";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { soundName, originalFilename } from "@/lib/validation";

export const runtime = "nodejs";

// Hard ceiling — independent of per-user quota. Stops a misconfigured big
// override from being used to memory-exhaust the process.
const HARD_UPLOAD_CEILING = 100 * 1024 * 1024; // 100 MiB

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

  // Rate limit uploads: 5/minute burst, refill 1/12s (~5/min sustained).
  const rl = rateLimit(`upload:${clientKey(req, session.user.id)}`, {
    capacity: 5,
    refillPerSec: 1 / 12,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  // Upload gate: only whitelisted roles (or admins) may upload their own clips.
  // Everyone can still browse and add public clips to their board.
  if (!isAdminSession(session) && !(await canUserUpload(session.user.id))) {
    return NextResponse.json(
      { error: "uploads are limited to whitelisted accounts" },
      { status: 403 }
    );
  }

  // Reject early on Content-Length before buffering anything. We compare to the
  // user's max-file-size plus a small overhead for multipart framing.
  const limits = await getUserLimits(session.user.id);
  const perRequestCap = Math.min(limits.maxFileSize, HARD_UPLOAD_CEILING);
  const declaredLen = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > perRequestCap + 4096) {
    return NextResponse.json(
      { error: `file too large (max ${limits.maxFileSize} bytes)` },
      { status: 413 }
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });

  // Validate extension + claimed MIME — these are client-controlled but cheap to check.
  const okMime = file.type === "audio/mpeg" || file.type === "audio/mp3";
  const okExt = file.name.toLowerCase().endsWith(".mp3");
  if (!okMime || !okExt) {
    return NextResponse.json({ error: "only .mp3 files are allowed" }, { status: 415 });
  }

  // Re-check actual size now that the body is parsed.
  if (file.size > perRequestCap) {
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

  const buf = Buffer.from(await file.arrayBuffer());

  // Sniff magic bytes — accept ID3 ("ID3") or an MPEG audio sync word
  // (0xFF + 0xEx/Fx). Trim leading null padding some encoders add.
  if (!looksLikeMp3(buf)) {
    return NextResponse.json({ error: "file is not a valid mp3" }, { status: 415 });
  }

  // Validate name + originalFilename via shared schemas.
  const rawName = String(form.get("name") ?? file.name.replace(/\.mp3$/i, ""));
  const nameParsed = soundName.safeParse(rawName);
  if (!nameParsed.success) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const origParsed = originalFilename.safeParse(file.name);
  if (!origParsed.success) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }

  // Write file.
  const dir = await ensureUserDir(session.user.discordId);
  const id = randomUUID();
  const storageRel = `${session.user.discordId}/${id}.mp3`;
  const abs = join(dir, `${id}.mp3`);
  await fs.writeFile(abs, buf);

  const isPublic = String(form.get("isPublic") ?? "false") === "true";

  const [row] = await db
    .insert(sounds)
    .values({
      id,
      ownerId: session.user.id,
      name: nameParsed.data,
      originalFilename: origParsed.data,
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

function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  // ID3v2 tag header.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // MPEG audio sync: 11 high bits set → first byte 0xFF, second byte top 3 bits set.
  // Scan past up to 1KiB of leading zero padding some tools insert.
  for (let i = 0; i < Math.min(buf.length - 1, 1024); i++) {
    if (buf[i] === 0x00) continue;
    return buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0;
  }
  return false;
}
