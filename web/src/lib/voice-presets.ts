"use client";

// Device-local AI voice-config presets (ver/1.4.1) — the voice parallel of
// lib/fx-presets.ts. A preset names an AI voice identity (engine + voiceId, plus
// the rvc_zero custom model/index URL + pitch or a paid custom voice id) so a user
// can save and re-apply it. Reused by the AI section's VoicePresetBar alongside the
// server-shared library (lib/shared-voices.ts). No DB; localStorage only.
//
// On every write we dispatch a window CustomEvent so an open editor refreshes, and
// we listen to the cross-tab `storage` event.

import { useEffect, useState } from "react";
import type { AiEngine } from "./audio-output";

const KEY = "soundboard:voicePresets";
const EVENT = "soundboard:voicePresets-changed";

// The voice identity a preset captures (a subset of AiConfig). `custom` is the
// rvc_zero model/index/pitch; `customVoiceId` is a paid provider voice id.
export type VoiceConfig = {
  voiceId: string;
  customVoiceId?: string;
  custom?: { modelUrl: string; indexUrl: string; pitch: number } | null;
};

export type VoicePreset = { id: string; name: string; engine: AiEngine; config: VoiceConfig };

export function readVoicePresets(): VoicePreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as VoicePreset[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeVoicePresets(list: VoicePreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore quota/serialisation errors */
  }
}

export function addVoicePreset(name: string, engine: AiEngine, config: VoiceConfig): VoicePreset {
  const preset: VoicePreset = {
    id: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Voice",
    engine,
    config: { ...config },
  };
  writeVoicePresets([...readVoicePresets(), preset]);
  return preset;
}

export function deleteVoicePreset(id: string) {
  writeVoicePresets(readVoicePresets().filter((p) => p.id !== id));
}

// Subscribe to the local voice-preset list (local + cross-tab writes).
export function useVoicePresets(): VoicePreset[] {
  const [presets, setPresets] = useState<VoicePreset[]>([]);
  useEffect(() => {
    const sync = () => setPresets(readVoicePresets());
    sync();
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) sync(); };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return presets;
}
