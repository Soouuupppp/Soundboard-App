import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { boardEntries } from "@/db/schema";

export const runtime = "nodejs";

// PATCH /api/board/[id] — update keybind / label / position
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if ("keybind" in body) updates.keybind = body.keybind || null;
  if ("label" in body) updates.label = body.label || null;
  if (typeof body.position === "number") updates.position = body.position;
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db
    .update(boardEntries)
    .set(updates)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)))
    .returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ entry: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  await db
    .delete(boardEntries)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)));
  return NextResponse.json({ ok: true });
}
