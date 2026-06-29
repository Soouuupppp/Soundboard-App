import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { TOS_VERSION } from "@/lib/tos";

export const runtime = "nodejs";

// POST /api/tos/accept — record that the signed-in user accepted the current TOS
// version. Returns { ok, firstTime } where firstTime is true only when they had
// never accepted before (drives the unique "new_user" analytics event).
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [prev] = await db
    .select({ tosAcceptedVersion: users.tosAcceptedVersion })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const firstTime = prev?.tosAcceptedVersion == null;

  await db
    .update(users)
    .set({ tosAcceptedVersion: TOS_VERSION, tosAcceptedAt: new Date() })
    .where(eq(users.id, session.user.id));

  return NextResponse.json({ ok: true, firstTime });
}
