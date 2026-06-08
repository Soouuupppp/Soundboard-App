import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, isAdminSession } from "@/lib/auth";
import { db } from "@/db";
import { users, roles } from "@/db/schema";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      discordId: users.discordId,
      roleId: users.roleId,
      roleName: roles.name,
      roleCanUpload: roles.canUpload,
      maxFileSizeOverride: users.maxFileSizeOverride,
      maxTotalStorageOverride: users.maxTotalStorageOverride,
      canUploadOverride: users.canUploadOverride,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId));
  return NextResponse.json({ users: rows });
}
