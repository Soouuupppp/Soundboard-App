import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAppSettings } from "@/lib/app-settings";

export const runtime = "nodejs";
// Always evaluated per-request (it reads the session + the live settings row).
export const dynamic = "force-dynamic";

// GET /api/motd — the current MOTD for signed-in users. The banner polls this so
// an admin's edit appears without a page refresh. Logged-out clients get nothing.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ motd: null }, { status: 401 });
  const s = await getAppSettings();
  return NextResponse.json({
    motd: {
      enabled: s.motdEnabled,
      message: s.motdMessage,
      linkLabel: s.motdLinkLabel,
      linkUrl: s.motdLinkUrl,
      severity: s.motdSeverity,
      version: s.motdUpdatedAt ? String(s.motdUpdatedAt.getTime()) : "",
    },
  });
}
