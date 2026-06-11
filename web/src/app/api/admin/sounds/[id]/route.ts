import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { sounds } from "@/db/schema";
import { deleteStorageFile } from "@/lib/storage";
import { PatchSoundBody, isUuid } from "@/lib/validation";
import { normalizeTags, setSoundTags } from "@/lib/tags";

export const runtime = "nodejs";

// PATCH: moderate any sound — rename, force-(un)publish, or edit its tags.
// Unlike the owner-facing route in /api/sounds/[id], this is not scoped to the
// caller. Tags are applied via setSoundTags with the ≥1-tag invariant (empty →
// the default `misc` tag).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = PatchSoundBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { tags, ...cols } = parsed.data;

  // Confirm the sound exists (the column update below might be a no-op).
  const [existing] = await db.select({ id: sounds.id }).from(sounds).where(eq(sounds.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (Object.keys(cols).length > 0) {
    await db.update(sounds).set(cols).where(eq(sounds.id, id));
  }
  if (tags !== undefined) {
    const clean = normalizeTags(tags);
    await setSoundTags(id, clean.length ? clean : ["misc"]);
  }
  return NextResponse.json({ ok: true });
}

// DELETE: remove any sound, its file, and (via cascade) every board entry that
// references it — including references on other users' boards.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [row] = await db.select().from(sounds).where(eq(sounds.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.delete(sounds).where(eq(sounds.id, id));
  try {
    await deleteStorageFile(row.storagePath);
  } catch {
    // best-effort
  }
  return NextResponse.json({ ok: true });
}
