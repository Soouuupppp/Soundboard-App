import NextAuth, { type Session } from "next-auth";
import { redirect } from "next/navigation";
import Discord from "next-auth/providers/discord";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, roles } from "@/db/schema";
import { ensureSystemUser, SYSTEM_USER_ID, SYSTEM_USER_NAME, SYSTEM_DISCORD_ID } from "@/lib/system-user";

// AUTH_DISABLED=true turns login off entirely (local testing): every request runs
// as one seeded "system" admin user. Runtime env, so one image starts either way.
// This file is the ONLY switch point — every caller keeps using auth()/signIn/
// signOut/handlers unchanged. Nothing reads the session any other way (no
// SessionProvider/useSession), so this covers the whole app.
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

if (AUTH_DISABLED) {
  console.warn(
    [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "!! AUTH_DISABLED=true — authentication is OFF.                        !!",
      "!! Everyone who can reach this server is the admin \"system\" user.    !!",
      "!! Use this for local testing only. Never expose this server.         !!",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n"),
  );
}

const adminIds = (process.env.DISCORD_ADMIN_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// The real Auth.js instance — not constructed at all when auth is off, so the
// Discord vars and AUTH_SECRET aren't needed.
const nextAuth = AUTH_DISABLED ? null : NextAuth({
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
      // Discord now returns an RFC 9207 `iss` on the callback; without an explicit
      // issuer Auth.js falls back to "https://authjs.dev" and oauth4webapi rejects
      // the mismatch. The provider's explicit token/userinfo URLs mean this does
      // NOT trigger OIDC discovery — it only fixes the issuer check.
      issuer: "https://discord.com",
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

// Same shape the `session` callback builds; role read from the DB on every call
// so a role change made in /admin shows up immediately.
async function systemAuth(): Promise<Session> {
  await ensureSystemUser();
  const [row] = await db
    .select({ roleId: users.roleId, name: users.name, image: users.image })
    .from(users)
    .where(eq(users.id, SYSTEM_USER_ID))
    .limit(1);
  let roleName: string | null = null;
  if (row?.roleId) {
    const [r] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, row.roleId)).limit(1);
    roleName = r?.name ?? null;
  }
  return {
    expires: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    user: {
      id: SYSTEM_USER_ID,
      name: row?.name ?? SYSTEM_USER_NAME,
      image: row?.image ?? null,
      discordId: SYSTEM_DISCORD_ID,
      role: roleName,
    },
  };
}

const notFound = () => new Response("Not found", { status: 404 });

export const handlers = nextAuth?.handlers ?? { GET: notFound, POST: notFound };
export const auth: () => Promise<Session | null> = nextAuth ? nextAuth.auth : systemAuth;
// With auth off there's no session to create or end: "sign in" lands on the
// dashboard and "sign out" (incl. TOS Reject) just goes back to "/", which
// redirects to the dashboard / TOS gate again.
export const signIn: (provider?: string, opts?: { redirectTo?: string }) => Promise<unknown> = nextAuth
  ? nextAuth.signIn
  : async () => redirect("/dashboard");
export const signOut: (opts?: { redirectTo?: string }) => Promise<unknown> = nextAuth
  ? nextAuth.signOut
  : async () => redirect("/");

export function isAdminSession(s: { user?: { role?: string | null } } | null) {
  return s?.user?.role === "admin";
}
