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
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Added after initial release; backfill existing deployments (NULL = inherit role).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "canUploadOverride" BOOLEAN;

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
