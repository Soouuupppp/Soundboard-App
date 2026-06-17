"use client";

// ver/1.4.1 Paid AI voice — CLIENT helpers. The browser talks ONLY to our own
// same-origin proxy (/api/ai/sts, /api/ai/tts), which holds the app key or forwards
// the user's BYO key. So there's no CSP change and the app key never reaches here.
//
// The BYO key is the one piece of AI config that stays DEVICE-LOCAL (a secret, not
// per-profile, not synced): localStorage `soundboard:aiKeys`, per provider. It's
// sent on each request as the `x-ai-key` header and never persisted server-side.

export type PaidProvider = "elevenlabs" | "respeecher";

const KEYS_KEY = "soundboard:aiKeys";

export type AiKeys = { elevenlabs?: string; respeecher?: string };

export function readAiKeys(): AiKeys {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEYS_KEY);
    return raw ? (JSON.parse(raw) as AiKeys) : {};
  } catch {
    return {};
  }
}

export function writeAiKeys(k: AiKeys) {
  try {
    localStorage.setItem(KEYS_KEY, JSON.stringify(k));
  } catch {
    /* private mode / quota — keys just won't persist */
  }
}

export function byoKeyFor(provider: PaidProvider): string | undefined {
  const k = readAiKeys()[provider]?.trim();
  return k || undefined;
}

// Per-provider privacy disclosures (extend the rvc_zero AI_PRIVACY_NOTICE pattern).
export const PAID_PRIVACY: Record<PaidProvider, string> = {
  elevenlabs: "Audio/text is sent to ElevenLabs (via this server) for conversion — it leaves your machine.",
  respeecher: "Audio is sent to Respeecher (via this server) for conversion — it leaves your machine.",
};
export const RESPEECHER_LIVE_PRIVACY =
  "Live mode streams your microphone continuously to Respeecher (via this server) for as long as it's on — a larger exposure than push-to-talk.";

export const PROVIDER_LABEL: Record<PaidProvider, string> = {
  elevenlabs: "ElevenLabs",
  respeecher: "Respeecher",
};

// Curated safe preset voices. ElevenLabs' own default library voices (public,
// safe to reference). Respeecher voice ids are account-specific → custom only.
export type PaidVoice = { id: string; label: string };
export const PAID_CUSTOM_ID = "custom";

export const PAID_VOICES: Record<PaidProvider, PaidVoice[]> = {
  elevenlabs: [
    { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
    { id: "pNInz6obpgDQGcFmaJgB", label: "Adam" },
    { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella" },
    { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
  ],
  respeecher: [],
};

// Resolve a stored selection (preset id or "custom" + a custom voice id) to the
// concrete provider voice id to send.
export function resolvePaidVoiceId(voiceId: string, customVoiceId?: string | null): string | null {
  if (voiceId === PAID_CUSTOM_ID) return customVoiceId?.trim() || null;
  return voiceId || null;
}

async function errorFrom(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error ?? `request failed (${res.status})`;
  } catch {
    return `request failed (${res.status})`;
  }
}

// Speech-to-speech via the proxy. `seconds` is the input-duration hint used for
// metering. Throws on failure (caller shows a toast / surfaces aiError).
export async function convertStsViaProxy(
  audio: Blob,
  opts: { provider: PaidProvider; voiceId: string; seconds?: number },
): Promise<Blob> {
  const form = new FormData();
  form.append("audio", audio, "input.webm");
  form.append("provider", opts.provider);
  form.append("voiceId", opts.voiceId);
  if (opts.seconds != null) form.append("seconds", String(Math.round(opts.seconds)));
  const byo = byoKeyFor(opts.provider);
  const res = await fetch("/api/ai/sts", {
    method: "POST",
    headers: byo ? { "x-ai-key": byo } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.blob();
}

// Text-to-speech via the proxy (the synth half of "re-speak").
export async function ttsViaProxy(
  text: string,
  opts: { provider: PaidProvider; voiceId: string },
): Promise<Blob> {
  const byo = byoKeyFor(opts.provider);
  const res = await fetch("/api/ai/tts", {
    method: "POST",
    headers: { "content-type": "application/json", ...(byo ? { "x-ai-key": byo } : {}) },
    body: JSON.stringify({ provider: opts.provider, voiceId: opts.voiceId, text }),
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.blob();
}
