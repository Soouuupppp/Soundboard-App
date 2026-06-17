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

// ver/1.4.1 Paid AI voice: a monthly AI quota in seconds. 0 = no quota; capped
// at ~115 days so the int column can't be stuffed.
const AI_SECONDS_MAX = 10_000_000;
export const aiQuotaSeconds = z.number().int().min(0).max(AI_SECONDS_MAX);

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
    // ver/1.4.1 Profiles: the placement edit targets THIS profile (the active one).
    // Omitted → the route resolves the user's default profile.
    profileId: uuid.optional(),
  })
  .strict();

// ver/1.4.1 Profiles. Profile names are short printable strings.
export const profileName = printable(60).pipe(z.string().min(1));

// Serialized per-profile config blobs (voice-changer + per-clip FX maps). Bounded
// so the column can't be stuffed; the client serializes them, the server stores
// the JSON text verbatim (parsed defensively on read).
const profileConfigJson = printable(100_000);

export const PostProfileBody = z.object({ name: profileName }).strict();

export const PatchProfileBody = z
  .object({
    name: profileName.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    voiceFx: profileConfigJson.nullable().optional(),
    soundFx: profileConfigJson.nullable().optional(),
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
    // ver/1.4.1 Profiles: per-role default profile cap (null → env default).
    profileLimit: z.number().int().min(1).max(100).nullable().optional(),
    // ver/1.4.1 Paid AI voice: per-role monthly AI quota (seconds; null → env
    // default) + whether the role may use AI voice at all.
    aiQuotaSecondsMonthly: aiQuotaSeconds.nullable().optional(),
    canUseAi: z.boolean().optional(),
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
    // ver/1.4.1 Profiles: per-user profile-cap override (null → inherit role).
    profileLimitOverride: z.number().int().min(1).max(100).nullable().optional(),
    // ver/1.4.1 Paid AI voice: per-user quota + permission overrides (null →
    // inherit role → env). Usage counters are server-managed, not patchable.
    aiQuotaSecondsOverride: aiQuotaSeconds.nullable().optional(),
    canUseAiOverride: z.boolean().nullable().optional(),
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

// MOTD link URL: when present (non-null), must be a bounded https URL.
const motdLinkUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => u.startsWith("https://"), "link must be https")
  .nullable();

export const PatchAppSettingsBody = z
  .object({
    ytEnabled: z.boolean().optional(),
    ytMaxDurationSec: z.number().int().min(1).max(3600).optional(),
    ytMaxFileSize: quotaBytes.optional(),
    ytConcurrency: z.number().int().min(1).max(4).optional(),
    ytAllowedHosts: allowedHostsCsv.optional(),
    // --- Admin MOTD banner ---
    motdEnabled: z.boolean().optional(),
    motdMessage: printable(500).optional(),
    motdLinkLabel: printable(80).nullable().optional(),
    motdLinkUrl: motdLinkUrl.optional(),
    motdSeverity: z.enum(["info", "warning", "success"]).optional(),
    // ver/1.4.1 Paid AI voice: master toggle + live-session auto-stop cap (5–600s).
    aiEnabled: z.boolean().optional(),
    aiLiveSessionCapSec: z.number().int().min(5).max(600).optional(),
  })
  .strict();

// Shared DSP-preset publish (ver/1.4.1). Keep EFFECT_KINDS in sync with the
// EffectKind union in lib/voice-fx.ts (that module is "use client", so we don't
// import it into server code — we mirror the kind list here). The client re-clones
// effects with fresh ids on apply, so we don't trust/validate ids; we bound the
// chain length + param shape so the DB can't be stuffed.
const EFFECT_KINDS = [
  "robot", "echo", "reverb", "distortion", "telephone", "tremolo",
  "lowpass", "highpass", "bitcrusher", "chorus", "flanger", "phaser",
  "vibrato", "compressor", "megaphone", "noisegate", "pitch",
] as const;

const effectConfig = z
  .object({
    kind: z.enum(EFFECT_KINDS),
    // Numeric param map; cap key count + require finite values. Ranges are
    // clamped client-side per EFFECT_DEFS — here we only keep it sane/bounded.
    params: z.record(z.string().max(40), z.number().finite()).refine(
      (o) => Object.keys(o).length <= 12,
      "too many params"
    ),
  })
  .strict();

export const PostSharedPresetBody = z
  .object({
    name: soundName.pipe(z.string().min(1).max(80)),
    effects: z.array(effectConfig).min(1).max(12),
    // Admin-only; the route ignores it for non-admins (publish as official).
    isOfficial: z.boolean().optional(),
  })
  .strict();

// Shared AI voice publish (ver/1.4.1) — the voice parallel of PostSharedPresetBody.
// `engine` is the AI engine; `config` is the opaque voice identity. We bound every
// field so the DB can't be stuffed; URLs (rvc custom model/index) must be https.
const sharedVoiceEngine = z.enum(["rvc_zero", "elevenlabs", "respeecher"]);
const httpsUrl = z.string().url().max(2048).startsWith("https://", "must be https");
const sharedVoiceConfig = z
  .object({
    voiceId: printable(120).pipe(z.string().min(1)),
    customVoiceId: printable(200).optional(),
    custom: z
      .object({
        modelUrl: httpsUrl,
        indexUrl: httpsUrl,
        pitch: z.number().finite().min(-24).max(24),
      })
      .strict()
      .nullish(),
  })
  .strict();

export const PostSharedVoiceBody = z
  .object({
    name: soundName.pipe(z.string().min(1).max(80)),
    engine: sharedVoiceEngine,
    config: sharedVoiceConfig,
    // Admin-only; the route ignores it for non-admins.
    isOfficial: z.boolean().optional(),
  })
  .strict();

// ver/1.4.1 Paid AI voice proxy bodies. Provider is the paid engine; voiceId is a
// provider voice id (bounded printable). STS is multipart (validated field-wise in
// the route); TTS is JSON. Text is capped so a single re-speak can't be huge.
export const aiProvider = z.enum(["elevenlabs", "respeecher"]);
export const aiVoiceId = printable(120).pipe(z.string().min(1));

export const PostAiTtsBody = z
  .object({
    provider: aiProvider,
    voiceId: aiVoiceId,
    text: printable(1000).pipe(z.string().min(1)),
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
