import { NextResponse } from "next/server";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { PostRoleBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await db.select().from(roles);
  return NextResponse.json({ roles: rows });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = PostRoleBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const [row] = await db.insert(roles).values(parsed.data).returning();
  return NextResponse.json({ role: row });
}
