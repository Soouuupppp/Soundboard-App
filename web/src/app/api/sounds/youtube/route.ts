import { NextResponse } from "next/server";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { conversionJobs } from "@/db/schema";
import { canUserUpload } from "@/lib/quota";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { PostYoutubeBody } from "@/lib/validation";
import { getAppSettings, parseAllowedHosts } from "@/lib/app-settings";
import { enqueueConversion, hostAllowed } from "@/lib/yt-convert";

export const runtime = "nodejs";

// POST /api/sounds/youtube — enqueue a conversion. Body: { url, name?, isPublic? }.
// Returns { jobId }; poll GET /api/sounds/youtube/[jobId] for the result.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id || !session.user.discordId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const settings = await getAppSettings();
  if (!settings.ytEnabled) {
    return NextResponse.json({ error: "YouTube import is disabled" }, { status: 403 });
  }

  if (!isAdminSession(session) && !(await canUserUpload(session.user.id))) {
    return NextResponse.json(
      { error: "uploads are limited to whitelisted accounts" },
      { status: 403 }
    );
  }

  // Conversion is far heavier than an upload — keep this tight: 2 burst, ~1/min.
  const rl = rateLimit(`yt:${clientKey(req, session.user.id)}`, {
    capacity: 2,
    refillPerSec: 1 / 60,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const parsed = PostYoutubeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  if (!hostAllowed(parsed.data.url, parseAllowedHosts(settings.ytAllowedHosts))) {
    return NextResponse.json({ error: "link isn't from an allowed site" }, { status: 400 });
  }

  const [job] = await db
    .insert(conversionJobs)
    .values({
      userId: session.user.id,
      url: parsed.data.url,
      requestedName: parsed.data.name ?? null,
      isPublic: parsed.data.isPublic ?? false,
    })
    .returning();

  enqueueConversion(job.id);
  return NextResponse.json({ jobId: job.id });
}
