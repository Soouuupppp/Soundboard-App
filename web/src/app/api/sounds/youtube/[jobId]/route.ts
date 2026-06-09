import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { conversionJobs } from "@/db/schema";

export const runtime = "nodejs";

// GET /api/sounds/youtube/[jobId] — poll a conversion's status. Owner only.
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { jobId } = await params;
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
