import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { boardEntries } from "@/db/schema";
import { PatchBoardEntryBody } from "@/lib/validation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// PATCH /api/board/[id] — update keybind / label / position
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, {
    capacity: 60,
    refillPerSec: 2,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  const parsed = PatchBoardEntryBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const updates: Record<string, unknown> = {};
  if ("keybind" in parsed.data) updates.keybind = parsed.data.keybind ?? null;
  if ("controllerBind" in parsed.data) updates.controllerBind = parsed.data.controllerBind ?? null;
  if ("label" in parsed.data) updates.label = parsed.data.label ?? null;
  if (parsed.data.position !== undefined) updates.position = parsed.data.position;
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const [row] = await db
    .update(boardEntries)
    .set(updates)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)))
    .returning();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ entry: row });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`board-mut:${clientKey(req, session.user.id)}`, {
    capacity: 60,
    refillPerSec: 2,
  });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const { id } = await params;
  await db
    .delete(boardEntries)
    .where(and(eq(boardEntries.id, id), eq(boardEntries.userId, session.user.id)));
  return NextResponse.json({ ok: true });
}
