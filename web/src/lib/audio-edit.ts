// Client-side mp3 editing for the pre-upload step: decode → trim → apply gain →
// re-encode a fresh mp3. The Web Audio API can decode mp3 but not encode it, so
// we hand the trimmed PCM to lamejs (pure-JS encoder). Browser-only — import
// from "use client" components.

import { Mp3Encoder } from "@breezystack/lamejs";

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  // Lazily create one shared context; decoding doesn't need it running.
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

// Decode mp3 bytes into an AudioBuffer. decodeAudioData detaches its input, so
// we hand it a copy and keep the caller's ArrayBuffer intact.
export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  return audioCtx().decodeAudioData(data.slice(0));
}

// Float [-1,1] → Int16 PCM with gain applied and hard-clamped.
function toInt16(input: Float32Array, gain: number): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i] * gain;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Trim `buffer` to [start, end] seconds, multiply by `volume`, and encode to an
// mp3 Blob at `kbps`. Up to stereo; mono stays mono.
export function encodeMp3(opts: {
  buffer: AudioBuffer;
  start: number;
  end: number;
  volume: number;
  kbps?: number;
}): Blob {
  const { buffer, start, end, volume, kbps = 128 } = opts;
  const sr = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);

  const startSample = Math.max(0, Math.floor(start * sr));
  const endSample = Math.min(buffer.length, Math.floor(end * sr));
  const len = Math.max(0, endSample - startSample);

  const left = toInt16(buffer.getChannelData(0).subarray(startSample, endSample), volume);
  const right =
    channels > 1 ? toInt16(buffer.getChannelData(1).subarray(startSample, endSample), volume) : null;

  const enc = new Mp3Encoder(channels, sr, kbps);
  const chunks: Uint8Array[] = [];
  const BLOCK = 1152; // one MP3 frame's worth of samples
  for (let i = 0; i < len; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const buf = right
      ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK))
      : enc.encodeBuffer(l);
    if (buf.length) chunks.push(buf);
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);

  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}

// Multi-segment variant for the cut editor's delete-model: `segments` are the
// KEEP ranges (in order), concatenated into one continuous clip with `volume`
// baked in, then encoded. (Callers compute keep-ranges as the complement of the
// deleted regions.) Concatenating in the PCM domain before encoding avoids
// frame-boundary glitches between segments.
export function encodeMp3Segments(opts: {
  buffer: AudioBuffer;
  segments: { start: number; end: number }[];
  volume: number;
  kbps?: number;
}): Blob {
  const { buffer, segments, volume, kbps = 128 } = opts;
  const sr = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  const ch0 = buffer.getChannelData(0);
  const ch1 = channels > 1 ? buffer.getChannelData(1) : null;

  // Resolve each segment to sample bounds and total the kept length.
  const ranges = segments
    .map((s) => {
      const a = Math.max(0, Math.floor(s.start * sr));
      const b = Math.min(buffer.length, Math.floor(s.end * sr));
      return { a, b, len: Math.max(0, b - a) };
    })
    .filter((r) => r.len > 0);
  const total = ranges.reduce((n, r) => n + r.len, 0);

  const left = new Int16Array(total);
  const right = ch1 ? new Int16Array(total) : null;
  let off = 0;
  for (const r of ranges) {
    left.set(toInt16(ch0.subarray(r.a, r.b), volume), off);
    if (right && ch1) right.set(toInt16(ch1.subarray(r.a, r.b), volume), off);
    off += r.len;
  }

  const enc = new Mp3Encoder(channels, sr, kbps);
  const chunks: Uint8Array[] = [];
  const BLOCK = 1152;
  for (let i = 0; i < total; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const buf = right ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
    if (buf.length) chunks.push(buf);
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);

  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}

// Merge overlapping/touching [start,end] ranges (seconds), sorted by start.
export function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// Complement of `cuts` over [0, duration] — i.e. the audio that survives a
// delete-model edit. Returns the kept segments in order.
export function keepSegments(cuts: { start: number; end: number }[], duration: number): { start: number; end: number }[] {
  const merged = mergeRanges(cuts);
  const keep: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start > cursor) keep.push({ start: cursor, end: Math.min(c.start, duration) });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });
  return keep;
}
