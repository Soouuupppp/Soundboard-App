import { NextResponse } from "next/server";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { roles } from "@/db/schema";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await db.select().from(roles);
  return NextResponse.json({ roles: rows });
}

// POST: { name, defaultMaxFileSize, defaultMaxTotalStorage }
export async function POST(req: Request) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json();
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const [row] = await db
    .insert(roles)
    .values({
      name,
      defaultMaxFileSize: Number(body.defaultMaxFileSize),
      defaultMaxTotalStorage: Number(body.defaultMaxTotalStorage),
    })
    .returning();
  return NextResponse.json({ role: row });
}
