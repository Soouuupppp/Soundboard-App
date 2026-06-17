"use client";

// Client wrappers for the server-side shared DSP-preset library (ver/1.4.1).
// The shared library is additive to the device-local `soundboard:fxPresets`
// (lib/fx-presets.ts): presets here are published to the server and visible to
// everyone, official ones flagged by an admin. DSP effect chains only.

import { type EffectConfig } from "./voice-fx";

export type SharedPreset = {
  id: string;
  name: string;
  effects: EffectConfig[];
  isOfficial: boolean;
  createdAt: string;
  ownerName: string | null;
  ownerImage: string | null;
  mine: boolean;
};

// Throws on a non-OK response so callers can route it through a toast.
export async function fetchSharedPresets(): Promise<SharedPreset[]> {
  const r = await fetch("/api/presets");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return (data.presets ?? []) as SharedPreset[];
}

// Publish the current chain. Strips effect ids (the server doesn't trust them;
// the client re-clones with fresh ids on apply). `isOfficial` is only honored
// server-side for admins. Returns the raw Response for `toast.fromResponse`.
export function publishSharedPreset(
  name: string,
  effects: EffectConfig[],
  opts?: { isOfficial?: boolean }
): Promise<Response> {
  return fetch("/api/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      effects: effects.map((e) => ({ kind: e.kind, params: e.params })),
      ...(opts?.isOfficial ? { isOfficial: true } : {}),
    }),
  });
}

export function deleteSharedPreset(id: string): Promise<Response> {
  return fetch(`/api/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Admin-only: toggle the official/featured flag.
export function setSharedPresetOfficial(id: string, isOfficial: boolean): Promise<Response> {
  return fetch(`/api/admin/presets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOfficial }),
  });
}
