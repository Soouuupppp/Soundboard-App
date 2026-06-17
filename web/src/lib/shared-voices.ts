"use client";

// Client wrappers for the server-side shared AI-voice library (ver/1.4.1) — the
// voice parallel of lib/shared-presets.ts. Voices published here are visible to
// everyone, official ones flagged by an admin. The custom-URL entitlement reminder
// stays on the publish/apply affordances (impersonation/legal concern).

import type { AiEngine } from "./audio-output";
import type { VoiceConfig } from "./voice-presets";

export type SharedVoice = {
  id: string;
  name: string;
  engine: AiEngine;
  config: VoiceConfig | null;
  isOfficial: boolean;
  createdAt: string;
  ownerName: string | null;
  ownerImage: string | null;
  mine: boolean;
};

// Throws on a non-OK response so callers can route it through a toast.
export async function fetchSharedVoices(): Promise<SharedVoice[]> {
  const r = await fetch("/api/voices");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return (data.voices ?? []) as SharedVoice[];
}

// Publish a voice config. `isOfficial` is only honored server-side for admins.
// Returns the raw Response for `toast.fromResponse`.
export function publishSharedVoice(
  name: string,
  engine: AiEngine,
  config: VoiceConfig,
  opts?: { isOfficial?: boolean }
): Promise<Response> {
  return fetch("/api/voices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      engine,
      config,
      ...(opts?.isOfficial ? { isOfficial: true } : {}),
    }),
  });
}

export function deleteSharedVoice(id: string): Promise<Response> {
  return fetch(`/api/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Admin-only: toggle the official/featured flag.
export function setSharedVoiceOfficial(id: string, isOfficial: boolean): Promise<Response> {
  return fetch(`/api/admin/voices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOfficial }),
  });
}
