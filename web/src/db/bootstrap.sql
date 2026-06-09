-- Idempotent bootstrap. Hand-maintained; mirrors src/db/schema.ts.

CREATE TABLE IF NOT EXISTS "role" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "defaultMaxFileSize" BIGINT NOT NULL,
  "defaultMaxTotalStorage" BIGINT NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

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
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

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
