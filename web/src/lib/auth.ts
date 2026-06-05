import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, roles } from "@/db/schema";

const adminIds = (process.env.DISCORD_ADMIN_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "database" },
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
    }),
  ],
  events: {
    async signIn({ user, account, profile }) {
      if (!user?.id || account?.provider !== "discord") return;
      const discordId = account.providerAccountId ?? (profile?.id as string | undefined);
      if (!discordId) return;

      // Look up current user state so we don't clobber custom role assignments.
      const [current] = await db
        .select({ roleId: users.roleId })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);

      const isEligibleAdmin = adminIds.includes(discordId);
      let nextRoleId: string | undefined;

      if (isEligibleAdmin) {
        // Promote to admin if eligible — overrides whatever they had.
        const [adminRole] = await db.select().from(roles).where(eq(roles.name, "admin")).limit(1);
        if (adminRole && current?.roleId !== adminRole.id) nextRoleId = adminRole.id;
      } else if (!current?.roleId) {
        // First-time user with no role yet — seed default "user".
        const [defaultRole] = await db.select().from(roles).where(eq(roles.name, "user")).limit(1);
        if (defaultRole) nextRoleId = defaultRole.id;
      }
      // Otherwise: leave roleId alone (preserves custom roles assigned via admin UI).

      await db
        .update(users)
        .set({
          discordId,
          ...(nextRoleId ? { roleId: nextRoleId } : {}),
        })
        .where(eq(users.id, user.id));
    },
  },
  callbacks: {
    async session({ session, user }) {
      // Expose role + quotas on session for the client.
      const [row] = await db
        .select({
          id: users.id,
          discordId: users.discordId,
          roleId: users.roleId,
          maxFileSizeOverride: users.maxFileSizeOverride,
          maxTotalStorageOverride: users.maxTotalStorageOverride,
        })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);

      let roleName: string | null = null;
      if (row?.roleId) {
        const [r] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, row.roleId)).limit(1);
        roleName = r?.name ?? null;
      }

      return {
        ...session,
        user: {
          ...session.user,
          id: user.id,
          discordId: row?.discordId ?? null,
          role: roleName,
        },
      };
    },
  },
});

export function isAdminSession(s: { user?: { role?: string | null } } | null) {
  return s?.user?.role === "admin";
}
