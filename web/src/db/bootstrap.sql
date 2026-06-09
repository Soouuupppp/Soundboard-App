-- Idempotent bootstrap. Hand-maintained; mirrors src/db/schema.ts.

CREATE TABLE IF NOT EXISTS "role" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "defaultMaxFileSize" BIGINT NOT NULL,
  "defaultMaxTotalStorage" BIGINT NOT NULL,
  "canUpload" BOOLEAN NOT NULL DEFAULT TRUE,
  "isSystem" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Added after initial release; backfill existing deployments. Existing roles
-- default to TRUE so current users aren't suddenly blocked from uploading.
ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "canUpload" BOOLEAN NOT NULL DEFAULT TRUE;

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
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "boardEntry_user_idx" ON "boardEntry" ("userId");

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
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO "appSettings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

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
