import { NextResponse } from "next/server";
import { auth, isAdminSession } from "@/lib/auth";
import { getAppSettings, updateAppSettings } from "@/lib/app-settings";
import { PatchAppSettingsBody } from "@/lib/validation";

export const runtime = "nodejs";

// GET /api/admin/settings — current global settings.
export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const settings = await getAppSettings();
  return NextResponse.json({ settings });
}

// PATCH /api/admin/settings — update global settings.
export async function PATCH(req: Request) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = PatchAppSettingsBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const settings = await updateAppSettings(parsed.data);
  return NextResponse.json({ settings });
}
