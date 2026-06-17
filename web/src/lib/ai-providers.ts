import "server-only";

// ver/1.4.1 Paid AI voice — SERVER-side provider clients (ElevenLabs + Respeecher)
// for the same-origin proxy routes (/api/ai/sts, /api/ai/tts). The browser never
// talks to a provider directly, so NO CSP connect-src widening is needed and the
// app key (env) never reaches the client.
//
// Keys: each call takes an `apiKey` resolved by the route — the user's BYO key
// (request header, never persisted) if present, else the app key from env
// (ELEVENLABS_API_KEY / RESPEECHER_API_KEY). App-key calls are metered against the
// per-user quota; BYO calls are not (see lib/ai-quota.ts).
//
// Respeecher's REST surface depends on the account/plan, so its endpoints are
// env-configurable (RESPEECHER_STS_URL / RESPEECHER_TTS_URL); without them the
// route returns a clear "not configured" error rather than guessing.

export type AiProvider = "elevenlabs" | "respeecher";

const ELEVEN_BASE = process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io/v1";
const ELEVEN_STS_MODEL = process.env.ELEVENLABS_STS_MODEL ?? "eleven_english_sts_v2";
const ELEVEN_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2";

// The app-owned key for a provider (env). Trimmed so a stray space/newline in the
// .env can't corrupt the key; an empty value → undefined (→ "not configured" 503,
// rather than sending a blank key the provider rejects as invalid).
export function appKeyFor(provider: AiProvider): string | undefined {
  const raw = provider === "elevenlabs"
    ? process.env.ELEVENLABS_API_KEY
    : process.env.RESPEECHER_API_KEY;
  return raw?.trim() || undefined;
}

export type ProviderResult = { audio: ArrayBuffer; contentType: string };

// A provider call failed — carries an HTTP status the route can surface (a 4xx
// usually means a bad voice id / key; a 5xx the provider being down/overloaded).
export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

async function readError(r: Response): Promise<string> {
  try {
    const t = await r.text();
    return t.slice(0, 300);
  } catch {
    return r.statusText;
  }
}

// --- Speech-to-speech (voice conversion, preserves delivery) ---
export async function providerSts(
  provider: AiProvider,
  args: { audio: Blob; voiceId: string; apiKey: string },
): Promise<ProviderResult> {
  if (provider === "elevenlabs") {
    // ElevenLabs Voice Changer (speech-to-speech): multipart, returns audio/mpeg.
    const form = new FormData();
    form.append("audio", args.audio, "input.webm");
    form.append("model_id", ELEVEN_STS_MODEL);
    const r = await fetch(`${ELEVEN_BASE}/speech-to-speech/${encodeURIComponent(args.voiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": args.apiKey, accept: "audio/mpeg" },
      body: form,
    });
    if (!r.ok) throw new ProviderError(`ElevenLabs STS failed: ${await readError(r)}`, r.status >= 500 ? 502 : r.status);
    return { audio: await r.arrayBuffer(), contentType: r.headers.get("content-type") ?? "audio/mpeg" };
  }

  // Respeecher S2S (file). Endpoint is account-specific → env-configured.
  const url = process.env.RESPEECHER_STS_URL;
  if (!url) throw new ProviderError("Respeecher STS endpoint not configured (set RESPEECHER_STS_URL)", 503);
  const form = new FormData();
  form.append("audio", args.audio, "input.webm");
  form.append("voice_id", args.voiceId);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}` },
    body: form,
  });
  if (!r.ok) throw new ProviderError(`Respeecher STS failed: ${await readError(r)}`, r.status >= 500 ? 502 : r.status);
  return { audio: await r.arrayBuffer(), contentType: r.headers.get("content-type") ?? "audio/wav" };
}

// --- Text-to-speech ---
export async function providerTts(
  provider: AiProvider,
  args: { text: string; voiceId: string; apiKey: string },
): Promise<ProviderResult> {
  if (provider === "elevenlabs") {
    const r = await fetch(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(args.voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": args.apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({ text: args.text, model_id: ELEVEN_TTS_MODEL }),
    });
    if (!r.ok) throw new ProviderError(`ElevenLabs TTS failed: ${await readError(r)}`, r.status >= 500 ? 502 : r.status);
    return { audio: await r.arrayBuffer(), contentType: r.headers.get("content-type") ?? "audio/mpeg" };
  }

  const url = process.env.RESPEECHER_TTS_URL;
  if (!url) throw new ProviderError("Respeecher TTS endpoint not configured (set RESPEECHER_TTS_URL)", 503);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ text: args.text, voice_id: args.voiceId }),
  });
  if (!r.ok) throw new ProviderError(`Respeecher TTS failed: ${await readError(r)}`, r.status >= 500 ? 502 : r.status);
  return { audio: await r.arrayBuffer(), contentType: r.headers.get("content-type") ?? "audio/wav" };
}
