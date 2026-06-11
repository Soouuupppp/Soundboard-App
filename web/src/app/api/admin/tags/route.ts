import { NextResponse } from "next/server";
import { auth, isAdminSession } from "@/lib/auth";
import { listTagsWithCounts } from "@/lib/tags";

export const runtime = "nodejs";

// GET /api/admin/tags — every tag with its clip-usage count, for the admin
// tag-management table.
export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tags = await listTagsWithCounts();
  return NextResponse.json({ tags });
}
