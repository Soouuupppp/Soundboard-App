import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  primaryKey,
  unique,
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
  // ver/1.4.1 Profiles: per-user override of the max number of profiles (null →
  // fall back to role.profileLimit → env DEFAULT_PROFILE_LIMIT). See lib/profiles.ts.
  profileLimitOverride: integer("profileLimitOverride"),
  // ver/1.4.1 Paid AI voice: per-user overrides (null → role default → env) +
  // monthly usage tracking. Quota unit = seconds of AI audio, unified across
  // providers, reset each calendar month. `aiSecondsUsed` is the running total
  // for the period named by `aiUsagePeriod` ("YYYY-MM", UTC); a new month resets
  // it lazily on the next consume. See lib/ai-quota.ts. BYO-key calls don't meter.
  aiQuotaSecondsOverride: integer("aiQuotaSecondsOverride"),
  canUseAiOverride: boolean("canUseAiOverride"),
  aiSecondsUsed: integer("aiSecondsUsed").notNull().default(0),
  aiUsagePeriod: text("aiUsagePeriod"),
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
  // ver/1.4.1 Profiles: per-role default cap on the number of profiles a member
  // may create (null → fall back to env DEFAULT_PROFILE_LIMIT). See lib/profiles.ts.
  profileLimit: integer("profileLimit"),
  // ver/1.4.1 Paid AI voice: per-role default monthly AI quota (seconds; null →
  // env DEFAULT_AI_QUOTA_SECONDS) + whether the role may use AI voice at all.
  // The global appSettings.aiEnabled master toggle still gates everything. See
  // lib/ai-quota.ts.
  aiQuotaSecondsMonthly: integer("aiQuotaSecondsMonthly"),
  canUseAi: boolean("canUseAi").notNull().default(true),
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
  // Admin MOTD banner (shown to signed-in users). motdUpdatedAt is the dismissal
  // version token — bumped only when the MOTD content changes (see
  // lib/app-settings.ts), NOT the row-wide updatedAt.
  motdEnabled: boolean("motdEnabled").notNull().default(false),
  motdMessage: text("motdMessage").notNull().default(""),
  motdLinkLabel: text("motdLinkLabel"),
  motdLinkUrl: text("motdLinkUrl"),
  motdSeverity: text("motdSeverity").notNull().default("info"), // info | warning | success
  motdUpdatedAt: timestamp("motdUpdatedAt"),
  // ver/1.4.1 Paid AI voice: master on/off for all AI voice features + the hard
  // auto-stop cap (seconds) on a continuous live session (Respeecher). See
  // lib/ai-quota.ts. App provider keys live in env, never here.
  aiEnabled: boolean("aiEnabled").notNull().default(false),
  aiLiveSessionCapSec: integer("aiLiveSessionCapSec").notNull().default(60),
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

// ver/1.4.1: a sharable DSP effect-chain preset. Owned by a user; `effects` is a
// serialized EffectConfig[] (lib/voice-fx). User-published presets are public
// immediately (no approval); admins can delete any and flag any as `isOfficial`
// (the curated/featured set). DSP chains only — no AI voice configs are shared.
export const sharedPresets = pgTable("sharedPreset", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("ownerId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Serialized EffectConfig[] JSON. Re-validated on publish; the client re-clones
  // with fresh effect ids on apply, so stored ids are not trusted.
  effects: text("effects").notNull(),
  // Admin/featured flag — official presets sort first and show a badge.
  isOfficial: boolean("isOfficial").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ver/1.4.1: a sharable AI voice config (the parallel of sharedPreset for voices).
// `engine` is the AI engine ("rvc_zero" | "elevenlabs" | "respeecher"); `config`
// is a serialized JSON payload of the voice identity (rvc_zero: model/index URL +
// pitch; paid: provider voice id). User-published voices are public immediately;
// admins flag `isOfficial` and can delete any. The UI keeps a "use only voices you
// have the rights to" reminder by the publish/apply affordances.
export const sharedVoices = pgTable("sharedVoice", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("ownerId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  engine: text("engine").notNull(),
  // Serialized voice config JSON ({ voiceId, custom?, customVoiceId? }). Re-validated
  // on publish; the client treats it as opaque config to feed into setAi.
  config: text("config").notNull(),
  isOfficial: boolean("isOfficial").notNull().default(false),
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
  // Optional Valve Index controller bind, e.g. "VR:RightHand:A". Independent of
  // keybind so an entry can be triggered by keyboard and controller at once.
  controllerBind: text("controllerBind"),
  position: integer("position").notNull().default(0),
  // ver/1.3.0: Saved vs Board split. Every entry is part of the user's library
  // ("Saved"); only entries with onBoard=true appear on the playable board and
  // get keybinds/positions. New entries default to saved-only — the user
  // explicitly adds them to the board. (bootstrap.sql backfills pre-existing
  // entries to true so current boards aren't wiped.)
  //
  // ver/1.4.1 Profiles: the board-placement columns below (label/keybind/
  // controllerBind/position/onBoard) are NOW ORPHANED — board placement moved
  // per-profile into `profilePlacement`. boardEntry is purely the GLOBAL Saved-
  // library membership row (userId, soundId). The columns are kept (not dropped)
  // per the additive idempotent-bootstrap convention; new code reads/writes the
  // placement instead. The 1.4.1 migration copies the old on-board values into the
  // Default profile's placements.
  onBoard: boolean("onBoard").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ver/1.4.1 Profiles: a named profile bundling a per-profile board layout
// (profilePlacement rows), the voice-changer mic chain + AI config (voiceFx), and
// applied per-clip sound effects (soundFx). The Saved library (boardEntry) + FX
// preset libraries stay GLOBAL. One "Default" profile (isDefault) is seeded per
// user; `position` orders them in the switcher.
export const profiles = pgTable("profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  isDefault: boolean("isDefault").notNull().default(false),
  // Serialized voice-changer config (audio-output.ts VoiceFxMap: the primary-mic
  // source's { effects, ai }). JSON text; null/"" = empty.
  voiceFx: text("voiceFx"),
  // Serialized per-clip Sound Effects map ({ [soundId]: EffectConfig[] }). JSON text.
  soundFx: text("soundFx"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ver/1.4.1 Profiles: a sound's board placement WITHIN one profile. A row exists
// only for sounds touched per-profile (promoted to board / bound / reordered);
// absence = saved-only in that profile (onBoard false, no binds). Unique per
// (profileId, soundId). FK on soundId (not boardEntry.id) so deleting the global
// Saved row removes placements app-side across every profile.
export const profilePlacements = pgTable(
  "profilePlacement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profileId").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    soundId: uuid("soundId").notNull().references(() => sounds.id, { onDelete: "cascade" }),
    onBoard: boolean("onBoard").notNull().default(true),
    position: integer("position").notNull().default(0),
    label: text("label"),
    keybind: text("keybind"),
    controllerBind: text("controllerBind"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (p) => ({ uniq: unique("profilePlacement_profile_sound_uniq").on(p.profileId, p.soundId) }),
);
