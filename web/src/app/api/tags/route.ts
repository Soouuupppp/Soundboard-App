import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listAllTagNames } from "@/lib/tags";

export const runtime = "nodejs";

// GET /api/tags — every tag name in the system, for the dashboard tag
// autocomplete and the public tag-filter row. Any signed-in user may read it.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const names = await listAllTagNames();
  return NextResponse.json({ tags: names });
}
