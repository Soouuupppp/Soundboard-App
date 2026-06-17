import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAiUsage } from "@/lib/ai-quota";

export const runtime = "nodejs";

// GET /api/ai/usage — the current user's AI quota meter: { used, cap, enabled,
// canUse } (seconds). Drives the voice-changer usage display. Read-only.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const usage = await getAiUsage(session.user.id);
  return NextResponse.json(usage);
}
