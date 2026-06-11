import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { openReadStream, statStorageFile } from "@/lib/storage";
import { isUuid } from "@/lib/validation";

export const runtime = "nodejs";

// Streams the audio file. Access rule:
//   - Owner can always access.
//   - Anyone logged in can access if the sound is public.
//   - Admins can access any sound (needed to preview content for moderation).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return new Response("not found", { status: 404 });

  const [row] = await db.select().from(sounds).where(eq(sounds.id, id)).limit(1);
  if (!row) return new Response("not found", { status: 404 });
  if (row.ownerId !== session.user.id && !row.isPublic && !isAdminSession(session)) {
    return new Response("forbidden", { status: 403 });
  }

  let stat;
  try {
    stat = statStorageFile(row.storagePath);
  } catch {
    return new Response("file missing", { status: 410 });
  }

  const stream = openReadStream(row.storagePath);
  // Readable.toWeb honors backpressure (and propagates cancel → destroy), so a
  // slow client can't make us buffer the whole file in memory.
  const web = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

  return new Response(web, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
