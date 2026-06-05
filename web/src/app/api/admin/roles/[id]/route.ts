import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { roles } from "@/db/schema";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (body.defaultMaxFileSize != null) updates.defaultMaxFileSize = Number(body.defaultMaxFileSize);
  if (body.defaultMaxTotalStorage != null)
    updates.defaultMaxTotalStorage = Number(body.defaultMaxTotalStorage);
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db.update(roles).set(updates).where(eq(roles.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ role: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  // Disallow deleting system roles.
  await db.delete(roles).where(and(eq(roles.id, id), eq(roles.isSystem, false)));
  return NextResponse.json({ ok: true });
}
