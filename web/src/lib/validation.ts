import { z } from "zod";
import { isValidControllerBindString } from "@/lib/vr-bind";

// Broad-but-safe caps. Generous enough that no real user notices, tight enough
// that the DB can't be stuffed with megabyte-long strings or weird control chars.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const printable = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), "control characters not allowed");

export const soundName = printable(200);
export const originalFilename = printable(255);
export const boardLabel = printable(120);

// Keybind grammar: a chord of up to 6 tokens joined by "+", each token is
// [A-Za-z0-9] up to 16 chars (covers Ctrl, Shift, Alt, Meta, Space, F1..F24,
// single letters/digits). Multiple non-modifier keys form a held-together chord.
export const keybind = z
  .string()
  .max(96)
  .regex(/^[A-Za-z0-9]+(\+[A-Za-z0-9]+){0,5}$/, "invalid keybind");

// Controller bind: a single bind (legacy "+"-chord or JSON step/sequence) or a
// per-profile map {"index":…,"quest":…} of those. lib/vr-bind.ts owns the
// grammar + caps; we just bound the raw length here (a map holds up to two binds).
export const controllerBind = z
  .string()
  .max(4096)
  .refine(isValidControllerBindString, "invalid controller bind");

export const uuid = z.string().uuid();

// Guard for dynamic route params that index a uuid column: true only for a
// well-formed uuid. Routes use it to 404 early instead of letting Postgres throw
// "invalid input syntax for type uuid" (which surfaces as an unhandled 500).
export function isUuid(v: string): boolean {
  return uuid.safeParse(v).success;
}

// Quota values — non-negative integers, capped at ~1 PiB so nobody fat-fingers
// a 20-digit number into the admin form and corrupts the bigint column.
const QUOTA_MAX = 2 ** 50;
export const quotaBytes = z.number().int().min(0).max(QUOTA_MAX);
export const quotaBytesNullable = quotaBytes.nullable();

export const roleName = printable(60).pipe(z.string().min(1));

// Request body shapes ------------------------------------------------------

// Tags as sent by the client — loosely bounded here (≤6 raw entries, each
// ≤40 chars); lib/tags.ts does the real normalize/dedupe/cap-at-3.
export const tagList = z.array(z.string().max(40)).max(6);

export const PatchSoundBody = z
  .object({
    name: soundName.optional(),
    isPublic: z.boolean().optional(),
    tags: tagList.optional(),
  })
  .strict();

export const PatchBoardEntryBody = z
  .object({
    keybind: keybind.nullable().optional(),
    controllerBind: controllerBind.nullable().optional(),
    label: boardLabel.nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    // Saved vs Board: move this entry on/off the playable board.
    onBoard: z.boolean().optional(),
  })
  .strict();

export const PostBoardEntryBody = z
  .object({
    soundId: uuid,
    keybind: keybind.nullable().optional(),
    label: boardLabel.nullable().optional(),
  })
  .strict();

export const PostRoleBody = z
  .object({
    name: roleName,
    defaultMaxFileSize: quotaBytes,
    defaultMaxTotalStorage: quotaBytes,
    canUpload: z.boolean().optional(),
  })
  .strict();

export const PatchRoleBody = z
  .object({
    name: roleName.optional(),
    defaultMaxFileSize: quotaBytes.optional(),
    defaultMaxTotalStorage: quotaBytes.optional(),
    canUpload: z.boolean().optional(),
    // Per-role YouTube-import overrides — null clears the override (inherit the
    // global appSettings value).
    ytEnabledOverride: z.boolean().nullable().optional(),
    ytMaxDurationSecOverride: z.number().int().min(1).max(3600).nullable().optional(),
    ytMaxFileSizeOverride: quotaBytesNullable.optional(),
    ytConcurrencyOverride: z.number().int().min(1).max(4).nullable().optional(),
  })
  .strict();

// Admin tag rename. The real normalize/cap lives in lib/tags.ts.
export const PatchTagBody = z.object({ name: z.string().max(40) }).strict();

export const PatchUserBody = z
  .object({
    roleId: uuid.nullable().optional(),
    maxFileSizeOverride: quotaBytesNullable.optional(),
    maxTotalStorageOverride: quotaBytesNullable.optional(),
    canUploadOverride: z.boolean().nullable().optional(),
  })
  .strict();

// Comma-separated list of bare hostnames (no scheme/path/port). Empty list is
// allowed — it simply means no host passes the allowlist (feature is closed).
const allowedHostsCsv = z
  .string()
  .max(1000)
  .refine(
    (s) =>
      s
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean)
        .every((h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h)),
    "each host must be a bare hostname like youtube.com"
  );

export const PatchAppSettingsBody = z
  .object({
    ytEnabled: z.boolean().optional(),
    ytMaxDurationSec: z.number().int().min(1).max(3600).optional(),
    ytMaxFileSize: quotaBytes.optional(),
    ytConcurrency: z.number().int().min(1).max(4).optional(),
    ytAllowedHosts: allowedHostsCsv.optional(),
  })
  .strict();

// A YouTube import request from the dashboard. The URL host is checked against
// the admin allowlist server-side; this just bounds the shape.
export const PostYoutubeBody = z
  .object({
    url: z.string().url().max(2048),
    name: soundName.optional(),
    isPublic: z.boolean().optional(),
  })
  .strict();
