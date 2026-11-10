"use client";

// Livepad's desktop-only sources: individual apps and playback devices, recorded by
// the native audio-capture.exe through the Electron main process. PCM arrives already
// at 48 kHz mono 16-bit, so it feeds the same PcmRing as the browser capture tap.

export const NATIVE_SAMPLE_RATE = 48000;
const NATIVE_ID_PREFIX = "native:";

export type NativeSource = { key: string; name: string; default?: boolean };
export type NativeSources = { apps: NativeSource[]; devices: NativeSource[] };

export type NativeOpenResult = NativeSources & { available: boolean; perApp: boolean };

export type NativeArmResult =
  | { ok: true; name: string; sampleRate: number }
  | { ok: false; error: "forbidden" | "unavailable" | "denied" };

export type NativeEvent =
  | { t: "status"; available: boolean; perApp: boolean }
  | ({ t: "sources" } & NativeSources)
  | { t: "state"; state: "capturing" | "waiting"; key: string }
  | { t: "revoked" };

export type NativeCaptureBridge = {
  open: () => Promise<NativeOpenResult>;
  close: () => Promise<void>;
  arm: (key: string) => Promise<NativeArmResult>;
  disarm: () => Promise<void>;
  onEvent: (fn: (e: NativeEvent) => void) => () => void;
  onPcm: (fn: (pcm: Uint8Array) => void) => () => void;
};

export function getNativeCapture(): NativeCaptureBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { soundboard?: { nativeCapture?: NativeCaptureBridge } };
  return w.soundboard?.nativeCapture ?? null;
}

// Livepad's source id is a Chromium device id or one of these prefixed keys.
export const nativeSourceId = (key: string) => NATIVE_ID_PREFIX + key;
export const isNativeSourceId = (id: string) => id.startsWith(NATIVE_ID_PREFIX);
export const nativeKeyOf = (id: string) => id.slice(NATIVE_ID_PREFIX.length);
export const isNativeDeviceId = (id: string) => isNativeSourceId(id) && nativeKeyOf(id).startsWith("device:");

// Own copy, because the incoming view's offset may not be Int16-aligned.
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.slice().buffer as ArrayBuffer, 0, bytes.byteLength >> 1);
}

// Chromium prefixes the labels of the two default-device entries.
function normalizeEndpointName(label: string): string {
  return label.replace(/^(default|communications)\s*-\s*/i, "").trim().toLowerCase();
}

// A playback device is captured whole, so this asks whether the soundboard plays there.
export function playbackDeviceMatchesOutput(name: string, outputLabels: string[]): boolean {
  const source = normalizeEndpointName(name);
  return outputLabels.some((l) => normalizeEndpointName(l) === source);
}
