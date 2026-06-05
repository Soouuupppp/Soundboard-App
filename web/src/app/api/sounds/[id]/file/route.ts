import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { openReadStream, statStorageFile } from "@/lib/storage";
import type { ReadStream } from "node:fs";

export const runtime = "nodejs";

// Streams the audio file. Access rule:
//   - Owner can always access.
//   - Anyone logged in can access if the sound is public.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("unauthorized", { status: 401 });
  const { id } = await params;

  const [row] = await db.select().from(sounds).where(eq(sounds.id, id)).limit(1);
  if (!row) return new Response("not found", { status: 404 });
  if (row.ownerId !== session.user.id && !row.isPublic) {
    return new Response("forbidden", { status: 403 });
  }

  let stat;
  try {
    stat = statStorageFile(row.storagePath);
  } catch {
    return new Response("file missing", { status: 410 });
  }

  const stream = openReadStream(row.storagePath);
  // Convert Node Readable to web ReadableStream
  const web = nodeToWeb(stream);

  return new Response(web, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

function nodeToWeb(stream: ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}
