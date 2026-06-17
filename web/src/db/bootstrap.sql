-- Idempotent bootstrap. Hand-maintained; mirrors src/db/schema.ts.

CREATE TABLE IF NOT EXISTS "role" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "defaultMaxFileSize" BIGINT NOT NULL,
  "defaultMaxTotalStorage" BIGINT NOT NULL,
  "canUpload" BOOLEAN NOT NULL DEFAULT TRUE,
  "ytEnabledOverride" BOOLEAN,
  "ytMaxDurationSecOverride" INTEGER,
  "ytMaxFileSizeOverride" BIGINT,
  "ytConcurrencyOverride" INTEGER,
  "profileLimit" INTEGER,
  "aiQuotaSecondsMonthly" INTEGER,
  "canUseAi" BOOLEAN NOT NULL DEFAULT TRUE,
  "isSystem" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Added after initial release; backfill existing deployments. Existing roles
-- default to TRUE so current users aren't suddenly blocked from uploading.
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "canUpload" BOOLEAN NOT NULL DEFAULT TRUE;
-- ver/1.3.0: per-role YouTube-import overrides (NULL = inherit the global
-- appSettings value). Backfill for DBs created before these columns existed.
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "ytEnabledOverride" BOOLEAN;
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "ytMaxDurationSecOverride" INTEGER;
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "ytMaxFileSizeOverride" BIGINT;
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "ytConcurrencyOverride" INTEGER;
-- ver/1.4.1 Profiles: per-role default profile cap (NULL = env DEFAULT_PROFILE_LIMIT).
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "profileLimit" INTEGER;
-- ver/1.4.1 Paid AI voice: per-role default monthly AI quota (seconds; NULL = env
-- DEFAULT_AI_QUOTA_SECONDS) + whether the role may use AI voice. Existing roles
-- default to TRUE (the global aiEnabled master toggle still gates everything).
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "aiQuotaSecondsMonthly" INTEGER;
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "canUseAi" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT,
  "email" TEXT UNIQUE,
  "emailVerified" TIMESTAMP,
  "image" TEXT,
  "discordId" TEXT UNIQUE,
  "roleId" UUID REFERENCES "role"("id") ON DELETE SET NULL,
  "maxFileSizeOverride" BIGINT,
  "maxTotalStorageOverride" BIGINT,
  "canUploadOverride" BOOLEAN,
  "profileLimitOverride" INTEGER,
  "aiQuotaSecondsOverride" INTEGER,
  "canUseAiOverride" BOOLEAN,
  "aiSecondsUsed" INTEGER NOT NULL DEFAULT 0,
  "aiUsagePeriod" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Added after initial release; backfill existing deployments (NULL = inherit role).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "canUploadOverride" BOOLEAN;
-- ver/1.4.1 Profiles: per-user profile-cap override (NULL = inherit role → env).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "profileLimitOverride" INTEGER;
-- ver/1.4.1 Paid AI voice: per-user quota override + permission override (NULL =
-- inherit role → env) and the monthly usage counter (seconds, reset lazily when
-- "aiUsagePeriod" no longer matches the current YYYY-MM). See lib/ai-quota.ts.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "aiQuotaSecondsOverride" INTEGER;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "canUseAiOverride" BOOLEAN;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "aiSecondsUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "aiUsagePeriod" TEXT;

CREATE TABLE IF NOT EXISTS "account" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "refresh_token" TEXT,
  "access_token" TEXT,
  "expires_at" INTEGER,
  "token_type" TEXT,
  "scope" TEXT,
  "id_token" TEXT,
  "session_state" TEXT,
  PRIMARY KEY ("provider", "providerAccountId")
);

CREATE TABLE IF NOT EXISTS "session" (
  "sessionToken" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "expires" TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "verificationToken" (
  "identifier" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "expires" TIMESTAMP NOT NULL,
  PRIMARY KEY ("identifier", "token")
);

CREATE TABLE IF NOT EXISTS "sound" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "isPublic" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "sound_owner_idx" ON "sound" ("ownerId");
CREATE INDEX IF NOT EXISTS "sound_public_idx" ON "sound" ("isPublic") WHERE "isPublic" = TRUE;

CREATE TABLE IF NOT EXISTS "boardEntry" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "soundId" UUID NOT NULL REFERENCES "sound"("id") ON DELETE CASCADE,
  "label" TEXT,
  "keybind" TEXT,
  "controllerBind" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "boardEntry_user_idx" ON "boardEntry" ("userId");
-- Added after initial release: Valve Index controller bind, independent of
-- keybind. ALTER is for DBs created before this column existed (CREATE TABLE
-- IF NOT EXISTS above won't add it to an existing table).
ALTER TABLE "boardEntry" ADD COLUMN IF NOT EXISTS "controllerBind" TEXT;
-- ver/1.3.0: Saved vs Board split. Add the column with DEFAULT TRUE so existing
-- entries (which predate the split) are backfilled onto the board and current
-- boards aren't wiped; then flip the default to FALSE so newly saved entries
-- land in Saved only until the user explicitly adds them to the board. Both
-- statements are idempotent: once the column exists ADD won't re-apply the
-- TRUE default, and SET DEFAULT FALSE is a no-op thereafter.
ALTER TABLE "boardEntry" ADD COLUMN IF NOT EXISTS "onBoard" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "boardEntry" ALTER COLUMN "onBoard" SET DEFAULT FALSE;

-- ver/1.3.0: global, normalized tags. Names are lowercased + trimmed and unique,
-- so a label is one shared tag across all clips (rename/delete cascades).
CREATE TABLE IF NOT EXISTS "tag" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Which tags are on which sound. Tags live on the sound, so everyone who sees
-- the clip sees them. App caps at 3 per sound; the composite PK dedupes pairs.
CREATE TABLE IF NOT EXISTS "soundTag" (
  "soundId" UUID NOT NULL REFERENCES "sound"("id") ON DELETE CASCADE,
  "tagId" UUID NOT NULL REFERENCES "tag"("id") ON DELETE CASCADE,
  PRIMARY KEY ("soundId", "tagId")
);
CREATE INDEX IF NOT EXISTS "soundTag_tag_idx" ON "soundTag" ("tagId");

-- ver/1.3.0: every sound must carry at least one tag. Seed the default `misc`
-- tag, then backfill it onto any existing sound that has no tags yet (leaves
-- already-tagged sounds untouched). Idempotent.
INSERT INTO "tag" ("name") VALUES ('misc') ON CONFLICT ("name") DO NOTHING;
INSERT INTO "soundTag" ("soundId", "tagId")
SELECT s."id", t."id"
FROM "sound" s
CROSS JOIN "tag" t
WHERE t."name" = 'misc'
  AND NOT EXISTS (SELECT 1 FROM "soundTag" st WHERE st."soundId" = s."id")
ON CONFLICT DO NOTHING;

-- Global app settings: single row keyed by id='singleton'. Holds the
-- admin-editable YouTube-import knobs. INSERT seeds defaults; ON CONFLICT keeps
-- it idempotent and never clobbers an admin's saved values.
CREATE TABLE IF NOT EXISTS "appSettings" (
  "id" TEXT PRIMARY KEY DEFAULT 'singleton',
  "ytEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "ytMaxDurationSec" INTEGER NOT NULL DEFAULT 300,
  "ytMaxFileSize" BIGINT NOT NULL DEFAULT 20971520,
  "ytConcurrency" INTEGER NOT NULL DEFAULT 1,
  "ytAllowedHosts" TEXT NOT NULL DEFAULT 'youtube.com,youtu.be,www.youtube.com,m.youtube.com,music.youtube.com',
  -- Admin MOTD banner (shown to signed-in users). "motdUpdatedAt" is the
  -- dismissal version token, bumped only when the MOTD content changes
  -- (lib/app-settings.ts), NOT the row-wide "updatedAt".
  "motdEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "motdMessage" TEXT NOT NULL DEFAULT '',
  "motdLinkLabel" TEXT,
  "motdLinkUrl" TEXT,
  "motdSeverity" TEXT NOT NULL DEFAULT 'info',
  "motdUpdatedAt" TIMESTAMP,
  "aiEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "aiLiveSessionCapSec" INTEGER NOT NULL DEFAULT 60,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO "appSettings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- MOTD columns: backfill for DBs created before they existed.
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "motdEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "motdMessage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "motdLinkLabel" TEXT;
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "motdLinkUrl" TEXT;
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "motdSeverity" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "motdUpdatedAt" TIMESTAMP;
-- ver/1.4.1 Paid AI voice: master toggle + live-session auto-stop cap (seconds).
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "appSettings" ADD COLUMN IF NOT EXISTS "aiLiveSessionCapSec" INTEGER NOT NULL DEFAULT 60;

-- YouTube→soundbite conversion jobs. Polled by the client until done/error.
CREATE TABLE IF NOT EXISTS "conversionJob" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "soundId" UUID REFERENCES "sound"("id") ON DELETE SET NULL,
  "requestedName" TEXT,
  "isPublic" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "conversionJob_user_idx" ON "conversionJob" ("userId");

-- Any job left mid-flight by a previous process can never resume (the in-process
-- queue is gone), so fail them on boot. Safe & idempotent.
UPDATE "conversionJob" SET "status" = 'error', "error" = 'interrupted by server restart', "updatedAt" = NOW()
  WHERE "status" IN ('pending', 'running');

-- ver/1.4.1: sharable DSP effect-chain presets. `effects` is serialized
-- EffectConfig[] JSON (lib/voice-fx). User presets are public immediately;
-- `isOfficial` flags the admin-curated/featured set. Brand-new table → no backfill.
CREATE TABLE IF NOT EXISTS "sharedPreset" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "effects" TEXT NOT NULL,
  "isOfficial" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "sharedPreset_owner_idx" ON "sharedPreset" ("ownerId");

-- ver/1.4.1: sharable AI voice configs (the parallel of sharedPreset for voices).
-- `engine` is the AI engine; `config` is serialized voice-identity JSON. User
-- voices are public immediately; `isOfficial` flags the curated set. New table → no
-- backfill.
CREATE TABLE IF NOT EXISTS "sharedVoice" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "engine" TEXT NOT NULL,
  "config" TEXT NOT NULL,
  "isOfficial" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "sharedVoice_owner_idx" ON "sharedVoice" ("ownerId");

-- ver/1.4.1 Profiles: per-user named profiles. Each bundles a per-profile board
-- layout (profilePlacement), the voice-changer mic chain + AI config (voiceFx),
-- and applied per-clip Sound Effects (soundFx). Saved library (boardEntry) + FX
-- presets stay global. Brand-new tables → no column backfill needed.
CREATE TABLE IF NOT EXISTS "profile" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "isDefault" BOOLEAN NOT NULL DEFAULT FALSE,
  "voiceFx" TEXT,
  "soundFx" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "profile_user_idx" ON "profile" ("userId");

-- A sound's board placement within ONE profile. A row exists only for sounds
-- touched per-profile; absence = saved-only in that profile. Unique per
-- (profileId, soundId). soundId FK cascades so deleting the global Saved row's
-- sound removes placements everywhere.
CREATE TABLE IF NOT EXISTS "profilePlacement" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "profileId" UUID NOT NULL REFERENCES "profile"("id") ON DELETE CASCADE,
  "soundId" UUID NOT NULL REFERENCES "sound"("id") ON DELETE CASCADE,
  "onBoard" BOOLEAN NOT NULL DEFAULT TRUE,
  "position" INTEGER NOT NULL DEFAULT 0,
  "label" TEXT,
  "keybind" TEXT,
  "controllerBind" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "profilePlacement_profile_sound_uniq" UNIQUE ("profileId", "soundId")
);
CREATE INDEX IF NOT EXISTS "profilePlacement_profile_idx" ON "profilePlacement" ("profileId");

-- Migration: seed a "Default" profile for every user that has none (idempotent —
-- skips users who already have a profile). position 0, isDefault TRUE.
INSERT INTO "profile" ("userId", "name", "position", "isDefault")
SELECT u."id", 'Default', 0, TRUE
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "profile" p WHERE p."userId" = u."id");

-- Migration: copy each ON-BOARD boardEntry's placement (onBoard/position/label/
-- keybind/controllerBind) into the owner's Default profile. Idempotent: only
-- inserts when no placement row exists yet for (defaultProfile, sound).
INSERT INTO "profilePlacement" ("profileId", "soundId", "onBoard", "position", "label", "keybind", "controllerBind")
SELECT p."id", be."soundId", be."onBoard", be."position", be."label", be."keybind", be."controllerBind"
FROM "boardEntry" be
JOIN "profile" p ON p."userId" = be."userId" AND p."isDefault" = TRUE
WHERE be."onBoard" = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "profilePlacement" pp
    WHERE pp."profileId" = p."id" AND pp."soundId" = be."soundId"
  );
