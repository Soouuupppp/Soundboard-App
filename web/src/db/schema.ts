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
  // Per-role YouTube-import overrides. null → fall back to the global
  // appSettings value. The global ytEnabled master toggle still gates
  // everything; these only narrow/widen the per-role behaviour beneath it.
  ytEnabledOverride: boolean("ytEnabledOverride"),
  ytMaxDurationSecOverride: integer("ytMaxDurationSecOverride"),
  ytMaxFileSizeOverride: bigint("ytMaxFileSizeOverride", { mode: "number" }),
  ytConcurrencyOverride: integer("ytConcurrencyOverride"),
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

// Global, admin-editable app settings. Single row keyed by a fixed id
// ("singleton"); read/upserted lazily via lib/app-settings.ts. Currently holds
// the YouTube-import knobs (master toggle, limits, host allowlist).
export const appSettings = pgTable("appSettings", {
  id: text("id").primaryKey().default("singleton"),
  ytEnabled: boolean("ytEnabled").notNull().default(false),
  ytMaxDurationSec: integer("ytMaxDurationSec").notNull().default(300),
  ytMaxFileSize: bigint("ytMaxFileSize", { mode: "number" }).notNull().default(20 * 1024 * 1024),
  ytConcurrency: integer("ytConcurrency").notNull().default(1),
  // Comma-separated bare hostnames an imported URL must match exactly.
  ytAllowedHosts: text("ytAllowedHosts")
    .notNull()
    .default("youtube.com,youtu.be,www.youtube.com,m.youtube.com,music.youtube.com"),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

// A YouTube→soundbite conversion request. The client enqueues one and polls it
// until status is "done" (soundId set) or "error". Conversion runs in-process
// (see lib/yt-convert.ts); stale running/pending rows are failed on restart.
export const conversionJobs = pgTable("conversionJob", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | done | error
  error: text("error"),
  soundId: uuid("soundId").references(() => sounds.id, { onDelete: "set null" }),
  requestedName: text("requestedName"),
  isPublic: boolean("isPublic").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

// A global, normalized tag. Names are stored lowercased + trimmed and are
// unique, so the same label is one shared tag across every clip. Renaming or
// deleting a tag (admin tag management) therefore affects all clips at once.
export const tags = pgTable("tag", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Join table: which tags are on which sound. Tags live on the sound (not the
// board entry), so they're visible to everyone who sees the clip. The app caps
// this at 3 rows per sound; the DB just enforces uniqueness of the pair.
export const soundTags = pgTable(
  "soundTag",
  {
    soundId: uuid("soundId").notNull().references(() => sounds.id, { onDelete: "cascade" }),
    tagId: uuid("tagId").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (st) => ({ pk: primaryKey({ columns: [st.soundId, st.tagId] }) })
);

// An entry on a user's personal board. Always references a sound (own or public).
export const boardEntries = pgTable("boardEntry", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  soundId: uuid("soundId").notNull().references(() => sounds.id, { onDelete: "cascade" }),
  // Optional override label and keybind for this entry.
  label: text("label"),
  keybind: text("keybind"), // e.g. "Ctrl+Shift+1" or "F5"
  // Optional Valve Index controller bind, e.g. "VR:RightHand:A". Independent of
  // keybind so an entry can be triggered by keyboard and controller at once.
  controllerBind: text("controllerBind"),
  position: integer("position").notNull().default(0),
  // ver/1.3.0: Saved vs Board split. Every entry is part of the user's library
  // ("Saved"); only entries with onBoard=true appear on the playable board and
  // get keybinds/positions. New entries default to saved-only — the user
  // explicitly adds them to the board. (bootstrap.sql backfills pre-existing
  // entries to true so current boards aren't wiped.)
  onBoard: boolean("onBoard").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
