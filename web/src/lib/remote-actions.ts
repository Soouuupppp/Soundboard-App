"use client";

// Shared dispatch for remote triggers that aren't keybinds: the Stream Deck plugin
// and the VRChat avatar panel run the SAME code here, so a "play sound" or "next
// profile" behaves identically from either. Like Stream Deck, these ignore the
// master keybinds switch (they can't be pressed by typing).

import { useCallback, useRef } from "react";
import { useLivepad } from "@/components/LivepadProvider";

export type RemoteSavedSound = { entryId: string; soundId: string; name: string; onBoard: boolean };

export type RemoteAction =
  | { type: "play"; soundId: string }
  | { type: "cancelAll" }
  | { type: "livepadCapture" }
  | { type: "livepadPlayLatest" }
  | { type: "livepadPlay"; slot?: number; captureId?: string }
  | { type: "profile"; profileId: string }
  | { type: "profileCycle" };

export type RemoteResult = { ok: true } | { ok: false; error: "not-found" | "unavailable" };

export type RemoteDeps = {
  sounds: RemoteSavedSound[];
  // Sorted by `position`, so cycling follows the switcher's order.
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  setActiveProfile: (id: string) => void;
  playEntry: (entryId: string, soundId: string) => void;
  cancelAll: () => void;
  triggerLivepadCapture: () => void;
};

const OK: RemoteResult = { ok: true };
const NOT_FOUND: RemoteResult = { ok: false, error: "not-found" };

/** Returns a stable `run(action)` that always sees the latest deps. */
export function useRemoteActions(deps: RemoteDeps) {
  const { captures, playCapture } = useLivepad();
  const live = useRef({ ...deps, captures, playCapture });
  live.current = { ...deps, captures, playCapture };

  return useCallback((a: RemoteAction): RemoteResult => {
    const l = live.current;
    switch (a.type) {
      case "play": {
        const s = l.sounds.find((x) => x.soundId === a.soundId);
        if (!s) return NOT_FOUND;
        l.playEntry(s.entryId, s.soundId);
        return OK;
      }
      case "cancelAll":
        l.cancelAll();
        return OK;
      case "livepadCapture":
        l.triggerLivepadCapture();
        return OK;
      case "profile":
        if (!l.profiles.some((x) => x.id === a.profileId)) return NOT_FOUND;
        l.setActiveProfile(a.profileId);
        return OK;
      case "profileCycle": {
        // Last wraps to first. One profile = nothing to switch to, still a success.
        if (l.profiles.length < 2) return OK;
        const i = l.profiles.findIndex((x) => x.id === l.activeProfileId);
        l.setActiveProfile(l.profiles[(i + 1) % l.profiles.length].id);
        return OK;
      }
      case "livepadPlayLatest":
      case "livepadPlay": {
        // playCapture restarts a card that's already playing, like the grid's button.
        const c =
          a.type === "livepadPlayLatest"
            ? l.captures[0]
            : a.captureId
              ? l.captures.find((x) => x.id === a.captureId)
              : a.slot
                ? l.captures[a.slot - 1]
                : undefined;
        if (!c) return NOT_FOUND;
        void l.playCapture(c);
        return OK;
      }
    }
  }, []);
}
