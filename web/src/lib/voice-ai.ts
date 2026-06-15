"use client";

// voice-ai.ts — the AI voice-conversion path for the 1.4.0 voice changer.
//
// Provider: the `r3gm/rvc_zero` Hugging Face Space (RVC⚡ZERO, MIT source), driven
// BROWSER-DIRECT via @gradio/client. We hold NO HF token; calling the Space from
// the browser means each user spends their own per-IP ZeroGPU quota (HF's edge
// injects an X-IP-Token for the browser session). This is push-to-talk, best-
// effort, preset-voices-only — see docs/voice-changer-research.md §4b.
//
// ⚠️ PRIVACY: the recorded mic audio is UPLOADED to a third-party Space (Hugging
// Face) for conversion. The UI MUST disclose this wherever AI is enabled.
//
// @gradio/client is a browser-only dependency (declared in web/package.json,
// installed via pnpm). It is imported lazily so it's only pulled when AI is used,
// and the import is ts-ignored so the engine typechecks before `pnpm install`.

// One confirmed-safe, license-clean original model (MIT, attribution required).
// Bundled presets are just pitch variants of it, so there's zero impersonation
// risk; anything else is the user's own custom model URL.
const DEFAULT_MODEL =
  "https://huggingface.co/PhoenixStormJr/RVC-V2-default-voice/resolve/main/default.pth";
const DEFAULT_INDEX =
  "https://huggingface.co/PhoenixStormJr/RVC-V2-default-voice/resolve/main/added_IVF511_Flat_nprobe_1_default_v2.index";

// Credit line shown in the UI (MIT requires attribution for the bundled model).
export const AI_MODEL_CREDIT = "Default voice: PhoenixStormJr/RVC-V2-default-voice (MIT)";
// Disclosure shown wherever AI is enabled.
export const AI_PRIVACY_NOTICE =
  "Audio is sent to Hugging Face (r3gm/rvc_zero) for conversion — it leaves your machine.";
export const AI_SPACE = "r3gm/rvc_zero";

export type AiVoice = { modelUrl: string; indexUrl: string; pitch: number };

export type AiPreset = AiVoice & { id: string; label: string };

// The hybrid preset list: three pitch variants of the one safe model + a sentinel
// "custom" id the UI expands into a model/index URL + pitch form.
export const AI_PRESETS: AiPreset[] = [
  { id: "neutral", label: "Neutral", modelUrl: DEFAULT_MODEL, indexUrl: DEFAULT_INDEX, pitch: 0 },
  { id: "deep", label: "Deeper", modelUrl: DEFAULT_MODEL, indexUrl: DEFAULT_INDEX, pitch: -7 },
  { id: "high", label: "Higher", modelUrl: DEFAULT_MODEL, indexUrl: DEFAULT_INDEX, pitch: 7 },
];
export const AI_CUSTOM_ID = "custom";

export function presetById(id: string): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.id === id);
}

// Resolve a stored AI selection (preset id, or "custom" + a custom voice) to the
// concrete { modelUrl, indexUrl, pitch } we send to rvc_zero.
export function resolveVoice(voiceId: string, custom?: AiVoice | null): AiVoice | null {
  if (voiceId === AI_CUSTOM_ID) {
    if (custom && custom.modelUrl && custom.indexUrl) return custom;
    return null;
  }
  const p = presetById(voiceId);
  return p ? { modelUrl: p.modelUrl, indexUrl: p.indexUrl, pitch: p.pitch } : null;
}

// Minimal shape of the @gradio/client surface we touch (the real package supplies
// its own types once installed; this keeps us honest without it). `handle_file`
// wraps a URL/path/Blob into the FileData structure Gradio file inputs require.
type GradioClient = {
  predict: (
    endpoint: string | number,
    payload: unknown[] | Record<string, unknown>,
  ) => Promise<{ data?: unknown[] }>;
};
type GradioModule = {
  Client: { connect: (id: string) => Promise<GradioClient> };
  handle_file: (f: Blob | string) => unknown;
};

// Lazily import the package once (cached). Browser-only optional dep; ts-ignored
// so the engine typechecks before `pnpm install`.
let modulePromise: Promise<GradioModule> | null = null;
function loadModule(): Promise<GradioModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // @ts-ignore — resolved at runtime after install
      const mod = await import("@gradio/client");
      return mod as unknown as GradioModule;
    })().catch((e) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

// Lazily connect once and cache the client. On failure the cache is cleared so a
// later attempt can retry (ZeroGPU Spaces sleep / rate-limit / restart).
let clientPromise: Promise<GradioClient> | null = null;

async function getClient(): Promise<GradioClient> {
  if (!clientPromise) {
    clientPromise = loadModule()
      .then((m) => m.Client.connect(AI_SPACE))
      .catch((e) => {
        clientPromise = null;
        throw e;
      });
  }
  return clientPromise;
}

// Pull a Blob out of a Gradio predict result. rvc_zero returns an output audio
// file as a FileData-like object ({ url } / { path }); since its audio I/O is
// multi-file, the output can also be wrapped one or two arrays deep. Dig through
// arrays to the first FileData/url, then fetch the bytes.
type FileLike = { url?: string; path?: string };
function urlFromNode(node: unknown): string | undefined {
  if (!node) return undefined;
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const n of node) {
      const u = urlFromNode(n);
      if (u) return u;
    }
    return undefined;
  }
  if (typeof node === "object") {
    const f = node as FileLike;
    return f.url ?? f.path;
  }
  return undefined;
}

async function blobFromResult(data: unknown[] | undefined): Promise<Blob> {
  if (!data || data.length === 0) throw new Error("AI conversion returned no output");
  const url = urlFromNode(data);
  if (!url) throw new Error("AI conversion output had no audio url");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching converted audio failed (${res.status})`);
  return res.blob();
}

export type ConvertOpts = {
  // rvc_zero pitch-extraction algorithm (pm/harvest/dio/crepe/rmvpe/rmvpe+…).
  f0Method?: string;
  indexRate?: number; // index_inf — feature index influence (0..1)
  respiration?: number; // r_m_f — respiration median filtering
  envelopeRatio?: number; // e_r — envelope ratio
  consonantProtection?: number; // c_b_p — consonant/breath protection
  noiseReduce?: boolean; // active_noise_reduce
  outputFormat?: string; // type_output — wav/mp3/…
};

// Convert a recorded clip with the chosen voice. Throws on any failure (caller
// shows a toast / falls back).
//
// Mapped to rvc_zero's `/run` endpoint via its published NAMED-parameter API
// (the Space's "Use via API" page). audio_files / file_m / file_index are File
// inputs (URLs/Blobs wrapped with handle_file); audio_files is multi-file so it
// must be a LIST. The extra flags (active_noise_reduce, audio_effects,
// type_output, steps) are required — omitting them left them None server-side and
// crashed the Space ("'<' not supported between NoneType and int"). audio_effects
// is forced off since we run our own DSP chain on the injected result.
export async function convertVoice(
  audio: Blob,
  voice: AiVoice,
  opts: ConvertOpts = {},
): Promise<Blob> {
  const [client, mod] = await Promise.all([getClient(), loadModule()]);
  const file = mod.handle_file;
  const result = await client.predict("/run", {
    audio_files: [file(audio)], // multi-file → list
    file_m: file(voice.modelUrl), // model (.pth)
    pitch_alg: opts.f0Method ?? "rmvpe+",
    pitch_lvl: voice.pitch, // semitones
    file_index: file(voice.indexUrl), // feature index (.index)
    index_inf: opts.indexRate ?? 0.75,
    r_m_f: opts.respiration ?? 3,
    e_r: opts.envelopeRatio ?? 0.25,
    c_b_p: opts.consonantProtection ?? 0.5,
    active_noise_reduce: opts.noiseReduce ?? false,
    audio_effects: false, // our own DSP chain handles effects
    type_output: opts.outputFormat ?? "wav",
    steps: 1,
  });
  return blobFromResult(result.data);
}

// Probe connectivity so the UI can show AI as available / "coming soon".
export async function checkAiAvailable(): Promise<boolean> {
  try {
    await getClient();
    return true;
  } catch {
    return false;
  }
}
