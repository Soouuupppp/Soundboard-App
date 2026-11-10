// Livepad (1.5.0): the rolling capture buffer plus the small pure helpers around
// it. The ring lives on the main thread (see livepad-capture-processor.js for why)
// and always holds the full 120s while armed, so moving the length slider up takes
// effect immediately against audio that has already been recorded.

import { type EffectConfig, createEffect, ensureWorkletModules } from "./voice-fx";

export const LIVEPAD_MIN_LENGTH_SEC = 1;
export const LIVEPAD_MAX_LENGTH_SEC = 120;
export const LIVEPAD_DEFAULT_LENGTH_SEC = 30;

// A capture's id in the engine's active-playback list (shared with Board sound ids).
export const livepadPlaybackKey = (captureId: string) => `livepad:${captureId}`;
// The editor's single monitor-only preview, tracked the same way.
export const LIVEPAD_PREVIEW_KEY = "livepad:preview";

export const LIVEPAD_MAX_RESULT_SEC = 240;
// lamejs only has the MPEG sample rates, which stop at 48 kHz.
const MAX_OUTPUT_RATE = 48000;
const FX_TAIL_SEC = 3;
const TAIL_SILENCE_LINEAR = Math.pow(10, -60 / 20);

export type CaptureEdit = {
  segments: { start: number; end: number }[]; // kept ranges, in seconds
  volume: number;
  reverse: boolean;
  speed: number; // tape-style: changes pitch too
  effects: EffectConfig[];
};

// The destructive edit pipeline. The order is deliberate: cuts are chosen on the
// original waveform, so they come first, and FX run last so a reversed or sped-up
// clip gets a normal-sounding reverb tail rather than a backwards one.
export async function renderCapture(source: AudioBuffer, edit: CaptureEdit): Promise<AudioBuffer> {
  const sr = source.sampleRate;
  const data = source.getChannelData(0);
  const ranges = edit.segments
    .map((s) => ({ a: Math.max(0, Math.floor(s.start * sr)), b: Math.min(source.length, Math.floor(s.end * sr)) }))
    .filter((r) => r.b > r.a);
  const total = ranges.reduce((n, r) => n + (r.b - r.a), 0);
  if (total === 0) throw new Error("There's no audio left to process.");

  const kept = new Float32Array(total);
  let off = 0;
  for (const r of ranges) {
    for (let i = r.a; i < r.b; i++) kept[off++] = data[i] * edit.volume;
  }
  if (edit.reverse) kept.reverse();

  const baseSec = total / sr / edit.speed;
  if (baseSec > LIVEPAD_MAX_RESULT_SEC) {
    throw new Error(`That result would be over ${LIVEPAD_MAX_RESULT_SEC / 60} minutes long. Cut it down or raise the speed.`);
  }

  const outRate = Math.min(sr, MAX_OUTPUT_RATE);
  const baseFrames = Math.ceil(baseSec * outRate);
  // The tail is clipped so a max-length result stays within the cap.
  const tailSec = edit.effects.length ? Math.min(FX_TAIL_SEC, LIVEPAD_MAX_RESULT_SEC - baseSec) : 0;
  const offline = new OfflineAudioContext(1, baseFrames + Math.ceil(tailSec * outRate), outRate);
  // Awaited, and allowed to throw: a silently bypassed effect must not get baked in.
  await ensureWorkletModules(offline, edit.effects);

  const buffer = offline.createBuffer(1, total, sr);
  buffer.copyToChannel(kept, 0);
  const node = offline.createBufferSource();
  node.buffer = buffer;
  node.playbackRate.value = edit.speed;
  const effects = edit.effects.map((c) => createEffect(offline, c));
  let tail: AudioNode = node;
  for (const e of effects) {
    tail.connect(e.input);
    tail = e.output;
  }
  tail.connect(offline.destination);
  node.start();
  const rendered = await offline.startRendering();
  for (const e of effects) {
    try { e.dispose(); } catch { /* ignore */ }
  }
  if (tailSec === 0) return rendered;

  // Drop the part of the tail that rendered to silence, never the clip itself.
  const out = rendered.getChannelData(0);
  let end = rendered.length;
  while (end > baseFrames && Math.abs(out[end - 1]) < TAIL_SILENCE_LINEAR) end--;
  if (end === rendered.length) return rendered;
  const trimmed = new AudioBuffer({ length: end, numberOfChannels: 1, sampleRate: outRate });
  trimmed.copyToChannel(out.subarray(0, end), 0);
  return trimmed;
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const data = buffer.getChannelData(0);
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return encodeWav16(pcm, buffer.sampleRate);
}

export function clampLengthSec(v: number): number {
  if (!Number.isFinite(v)) return LIVEPAD_DEFAULT_LENGTH_SEC;
  return Math.max(LIVEPAD_MIN_LENGTH_SEC, Math.min(LIVEPAD_MAX_LENGTH_SEC, Math.round(v)));
}

// Fixed-capacity circular buffer of mono 16-bit frames.
export class PcmRing {
  private readonly buf: Int16Array;
  private writeAt = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  get available(): number {
    return this.filled;
  }

  push(chunk: Int16Array) {
    // A chunk bigger than the ring only needs its tail.
    const src = chunk.length > this.capacity ? chunk.subarray(chunk.length - this.capacity) : chunk;
    const firstPart = Math.min(src.length, this.capacity - this.writeAt);
    this.buf.set(src.subarray(0, firstPart), this.writeAt);
    if (firstPart < src.length) this.buf.set(src.subarray(firstPart), 0);
    this.writeAt = (this.writeAt + src.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + src.length);
  }

  clear() {
    this.writeAt = 0;
    this.filled = 0;
  }

  // Copy of the newest `frames` frames, oldest first. Shorter than requested when
  // the ring hasn't filled that far yet (armed for less than X: no silence padding).
  latest(frames: number): Int16Array {
    const n = Math.max(0, Math.min(Math.floor(frames), this.filled));
    const out = new Int16Array(n);
    if (n === 0) return out;
    const start = (this.writeAt - n + this.capacity) % this.capacity;
    const firstPart = Math.min(n, this.capacity - start);
    out.set(this.buf.subarray(start, start + firstPart), 0);
    if (firstPart < n) out.set(this.buf.subarray(0, n - firstPart), firstPart);
    return out;
  }
}

// Wrap mono 16-bit PCM in a canonical 44-byte RIFF/WAVE header.
export function encodeWav16(pcm: Int16Array, sampleRate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
  };
  const dataBytes = pcm.length * 2;
  ascii(0, "RIFF");
  header.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // byte rate
  header.setUint16(32, 2, true); // block align
  header.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  header.setUint32(40, dataBytes, true);
  // Blob copies its parts, and every platform this runs on is little-endian like WAV.
  return new Blob([header.buffer, pcm as Int16Array<ArrayBuffer>], { type: "audio/wav" });
}

export function formatClipDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function defaultCaptureName(at: Date): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const ss = String(at.getSeconds()).padStart(2, "0");
  return `Capture ${hh}.${mm}.${ss}`;
}

// The hardware/driver part of a Windows device label: the outermost parenthesised
// group, for example "VB-Audio Virtual Cable" in "CABLE Output (VB-Audio Virtual
// Cable)". Chromium may append a USB "(046d:0825)" id, which is not the name.
function deviceFamily(label: string): string | null {
  const clean = label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "");
  const open = clean.indexOf("(");
  const close = clean.lastIndexOf(")");
  if (open === -1 || close <= open) return null;
  const family = clean.slice(open + 1, close).trim().toLowerCase();
  return family || null;
}

// Best effort: does this capture line look like the far side of a device the app
// is playing into? If so, a capture would include the board's own output.
export function looksLikeSelfCapture(sourceLabel: string, outputLabels: string[]): boolean {
  const source = deviceFamily(sourceLabel);
  if (!source) return false;
  return outputLabels.some((l) => deviceFamily(l) === source);
}
