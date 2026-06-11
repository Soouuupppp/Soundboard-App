import { NextResponse } from "next/server";
import { auth, isAdminSession } from "@/lib/auth";
import { PatchTagBody } from "@/lib/validation";
import { renameTag, deleteTag } from "@/lib/tags";
import { isUuid } from "@/lib/validation";

export const runtime = "nodejs";

// PATCH /api/admin/tags/[id] — rename a tag globally (merges into an existing
// tag if the new name collides). Affects every clip using it.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = PatchTagBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const res = await renameTag(id, parsed.data.name);
  if (!res.ok) return NextResponse.json({ error: res.error ?? "rename failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/tags/[id] — remove a tag from every clip and the pool.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteTag(id);
  return NextResponse.json({ ok: true });
}
