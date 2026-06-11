import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { PatchRoleBody, isUuid } from "@/lib/validation";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = PatchRoleBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ ok: true });

  // System roles (`user`, `admin`) are looked up by name elsewhere — admin
  // detection (isAdminSession) keys on "admin", first-login seeding on "user".
  // Renaming one would silently lock out all admins / break seeding with no
  // in-app recovery, so refuse name edits on protected roles (their quotas and
  // upload/YT settings stay editable).
  if (parsed.data.name !== undefined) {
    const [existing] = await db
      .select({ isSystem: roles.isSystem })
      .from(roles)
      .where(eq(roles.id, id))
      .limit(1);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (existing.isSystem) {
      return NextResponse.json({ error: "cannot rename a system role" }, { status: 400 });
    }
  }

  const [row] = await db.update(roles).set(parsed.data).where(eq(roles.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ role: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Disallow deleting system roles.
  await db.delete(roles).where(and(eq(roles.id, id), eq(roles.isSystem, false)));
  return NextResponse.json({ ok: true });
}
