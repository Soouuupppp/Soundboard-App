import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// --- Auth.js core tables (drizzle adapter shape) ---

export const users = pgTable("user", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),

  // App fields:
  // Discord user ID (snowflake) — captured from the OAuth account, mirrored here for fast lookups.
  discordId: text("discordId").unique(),
  roleId: uuid("roleId").references(() => roles.id, { onDelete: "set null" }),
  // Per-user overrides (null → fall back to role default → env default).
  maxFileSizeOverride: bigint("maxFileSizeOverride", { mode: "number" }),
  maxTotalStorageOverride: bigint("maxTotalStorageOverride", { mode: "number" }),
  // Per-user upload permission override (null → fall back to role's canUpload).
  canUploadOverride: boolean("canUploadOverride"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (a) => ({ pk: primaryKey({ columns: [a.provider, a.providerAccountId] }) })
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({ pk: primaryKey({ columns: [vt.identifier, vt.token] }) })
);

// --- App tables ---

export const roles = pgTable("role", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  // Defaults applied to all users with this role, unless they have an override.
  defaultMaxFileSize: bigint("defaultMaxFileSize", { mode: "number" }).notNull(),
  defaultMaxTotalStorage: bigint("defaultMaxTotalStorage", { mode: "number" }).notNull(),
  // Whether members of this role may upload their own sounds. When false they
  // can still browse and add public clips to their board — just not upload.
  canUpload: boolean("canUpload").notNull().default(true),
  isSystem: boolean("isSystem").notNull().default(false), // protects system roles from deletion
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const sounds = pgTable("sound", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("ownerId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  originalFilename: text("originalFilename").notNull(),
  // Path relative to UPLOADS_DIR, e.g. "<discordId>/<uuid>.mp3"
  storagePath: text("storagePath").notNull(),
  sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
  isPublic: boolean("isPublic").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// An entry on a user's personal board. Always references a sound (own or public).
export const boardEntries = pgTable("boardEntry", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  soundId: uuid("soundId").notNull().references(() => sounds.id, { onDelete: "cascade" }),
  // Optional override label and keybind for this entry.
  label: text("label"),
  keybind: text("keybind"), // e.g. "Ctrl+Shift+1" or "F5"
  position: integer("position").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
