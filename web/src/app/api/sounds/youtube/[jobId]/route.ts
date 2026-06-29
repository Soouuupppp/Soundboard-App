import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { conversionJobs } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { cancelConversion } from "@/lib/yt-convert";

export const runtime = "nodejs";

// GET /api/sounds/youtube/[jobId] — poll a conversion's status. Owner only.
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { jobId } = await params;
  if (!isUuid(jobId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [job] = await db
    .select({
      status: conversionJobs.status,
      error: conversionJobs.error,
      soundId: conversionJobs.soundId,
    })
    .from(conversionJobs)
    .where(and(eq(conversionJobs.id, jobId), eq(conversionJobs.userId, session.user.id)))
    .limit(1);

  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(job);
}

// DELETE /api/sounds/youtube/[jobId] — cancel a conversion (stop yt-dlp, drop the
// temp files, and remove any sound that already landed). Owner only, idempotent.
export async function DELETE(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { jobId } = await params;
  if (!isUuid(jobId)) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Confirm ownership before touching the job.
  const [job] = await db
    .select({ id: conversionJobs.id })
    .from(conversionJobs)
    .where(and(eq(conversionJobs.id, jobId), eq(conversionJobs.userId, session.user.id)))
    .limit(1);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  await cancelConversion(jobId);
  return NextResponse.json({ ok: true });
}
