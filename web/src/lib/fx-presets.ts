"use client";

// Shared DSP effect-chain presets (1.4.0) — one device-local list reused by BOTH
// the voice-changer mic chain and the per-clip Sound Effects editors, so a preset
// saved in either appears in both. No DB; localStorage only.
//
// On every write we dispatch a window CustomEvent so any open editor (via
// useFxPresets) refreshes immediately, and we also listen to the cross-tab
// `storage` event.

import { type EffectConfig, makeEffect } from "./voice-fx";
import { useEffect, useState } from "react";

const KEY = "soundboard:fxPresets";
const EVENT = "soundboard:fxPresets-changed";

export type FxPreset = { id: string; name: string; effects: EffectConfig[] };

export function readPresets(): FxPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as FxPreset[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writePresets(list: FxPreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore quota/serialisation errors */
  }
}

// Deep-clone an effect chain with FRESH ids so applying a preset never collides
// with an existing live chain's ids (EffectConfig.id must be unique per chain).
export function cloneEffects(effects: EffectConfig[]): EffectConfig[] {
  return effects.map((e) => ({ ...makeEffect(e.kind), params: { ...e.params } }));
}

export function addPreset(name: string, effects: EffectConfig[]): FxPreset {
  const preset: FxPreset = {
    id: `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Preset",
    effects: cloneEffects(effects), // store a private copy with its own ids
  };
  writePresets([...readPresets(), preset]);
  return preset;
}

export function deletePreset(id: string) {
  writePresets(readPresets().filter((p) => p.id !== id));
}

export function renamePreset(id: string, name: string) {
  writePresets(readPresets().map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)));
}

// Subscribe to the preset list, refreshing on local writes (CustomEvent) and
// cross-tab writes (storage event).
export function useFxPresets(): FxPreset[] {
  const [presets, setPresets] = useState<FxPreset[]>([]);
  useEffect(() => {
    const sync = () => setPresets(readPresets());
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
