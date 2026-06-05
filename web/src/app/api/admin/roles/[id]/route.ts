import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { PatchRoleBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const parsed = PatchRoleBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db.update(roles).set(parsed.data).where(eq(roles.id, id)).returning();
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
