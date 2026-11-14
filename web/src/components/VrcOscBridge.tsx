"use client";

// Dashboard side of the VRChat avatar panel (desktop app only, 1.5.2 experimental).
// Renders nothing. While the dashboard is mounted and the feature switch is on, it
// attaches to main's OSC service, maps a pressed avatar key (page, key n) to the
// active profile's layout slot, runs the action through the same code as the
// Stream Deck (lib/remote-actions.ts), and publishes each key's Active/Playing
// state plus the current page back to the avatar.
//
// The page is runtime state only: it resets to 0 on an avatar change and on a
// profile switch. Page keys wrap. Like Stream Deck, presses ignore the master
// keybinds switch.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLivepad } from "@/components/LivepadProvider";
import { useOscLayout } from "@/components/ProfileProvider";
import { livepadPlaybackKey } from "@/lib/livepad";
import { useRemoteActions, type RemoteSavedSound } from "@/lib/remote-actions";
import {
  SLOT_COUNT,
  VRC_OSC_ENABLED_EVENT,
  getVrcOscBridge,
  keySlot,
  readVrcOscEnabled,
  type OscKeyAction,
} from "@/lib/osc-board";

// The device-local feature switch, live (the editor flips it via writeVrcOscEnabled).
export function useVrcOscEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(readVrcOscEnabled());
    const h = (e: Event) => setOn(!!(e as CustomEvent<{ on: boolean }>).detail?.on);
    window.addEventListener(VRC_OSC_ENABLED_EVENT, h);
    return () => window.removeEventListener(VRC_OSC_ENABLED_EVENT, h);
  }, []);
  return on;
}

export function VrcOscBridge({
  sounds,
  profiles,
  activeProfileId,
  setActiveProfile,
  playingSoundIds,
  playEntry,
  cancelAll,
  triggerLivepadCapture,
}: {
  sounds: RemoteSavedSound[];
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  setActiveProfile: (id: string) => void;
  playingSoundIds: Set<string>;
  playEntry: (entryId: string, soundId: string) => void;
  cancelAll: () => void;
  triggerLivepadCapture: () => void;
}) {
  const { captures, armed } = useLivepad();
  const { oscLayout } = useOscLayout();
  const enabled = useVrcOscEnabled();
  const [page, setPage] = useState(0);
  const run = useRemoteActions({ sounds, profiles, activeProfileId, setActiveProfile, playEntry, cancelAll, triggerLivepadCapture });

  const pageCount = oscLayout.pages.length;
  const curPage = Math.min(page, pageCount - 1);

  // A profile switch starts on the first page.
  useEffect(() => setPage(0), [activeProfileId]);

  const live = useRef({ layout: oscLayout, page: curPage, run });
  live.current = { layout: oscLayout, page: curPage, run };

  // Bumps after each attach so the full key state is published again.
  const [attachGen, setAttachGen] = useState(0);

  useEffect(() => {
    const bridge = getVrcOscBridge();
    if (!bridge || !enabled) return;
    const onPress = (n: number) => {
      const { layout, page: p, run: go } = live.current;
      const slot = keySlot(layout.grid, n);
      const action = slot === null ? null : layout.pages[p]?.[slot];
      if (!action) return;
      if (action.type === "pageNext" || action.type === "pagePrev") {
        const count = layout.pages.length;
        if (count < 2) return;
        const d = action.type === "pageNext" ? 1 : -1;
        setPage((count + p + d) % count);
        return;
      }
      const remote = toRemote(action);
      if (remote) go(remote);
    };
    const detach = bridge.attach(onPress, undefined, () => setPage(0));
    setAttachGen((g) => g + 1);
    return detach;
  }, [enabled]);

  // Per-key state for all 15 avatar keys (keys outside the grid are simply off).
  const keys = useMemo(() => {
    const soundIds = new Set(sounds.map((s) => s.soundId));
    const captureIds = new Set(captures.map((c) => c.id));
    const isPlayingCapture = (id: string | undefined) => !!id && playingSoundIds.has(livepadPlaybackKey(id));
    const out: { n: number; active: boolean; playing: boolean }[] = [];
    for (let n = 1; n <= SLOT_COUNT; n++) {
      const slot = keySlot(oscLayout.grid, n);
      const a = slot === null ? null : oscLayout.pages[curPage]?.[slot] ?? null;
      let active = false;
      let playing = false;
      if (a) {
        switch (a.type) {
          case "play":
            active = soundIds.has(a.soundId);
            playing = active && playingSoundIds.has(a.soundId);
            break;
          case "cancelAll":
            active = true;
            break;
          case "livepadCapture":
            active = armed;
            break;
          case "livepadPlay": {
            const id = a.mode === "position" ? captures[a.slot - 1]?.id : captureIds.has(a.captureId) ? a.captureId : undefined;
            active = !!id;
            playing = isPlayingCapture(id);
            break;
          }
          case "profile":
            active = a.mode === "cycle" ? profiles.length > 1 : profiles.some((p) => p.id === a.profileId);
            break;
          case "pageNext":
          case "pagePrev":
            active = pageCount > 1;
            break;
        }
      }
      out.push({ n, active, playing });
    }
    return out;
  }, [oscLayout, curPage, pageCount, sounds, captures, armed, profiles, playingSoundIds]);

  useEffect(() => {
    if (!enabled) return;
    const bridge = getVrcOscBridge();
    if (!bridge) return;
    bridge.publishKeys(keys);
    bridge.setPage(curPage);
  }, [enabled, keys, curPage, attachGen]);

  return null;
}

function toRemote(a: OscKeyAction) {
  switch (a.type) {
    case "play":
      return a.soundId ? ({ type: "play", soundId: a.soundId } as const) : null;
    case "cancelAll":
      return { type: "cancelAll" } as const;
    case "livepadCapture":
      return { type: "livepadCapture" } as const;
    case "livepadPlay":
      return a.mode === "position"
        ? ({ type: "livepadPlay", slot: a.slot } as const)
        : a.captureId
          ? ({ type: "livepadPlay", captureId: a.captureId } as const)
          : null;
    case "profile":
      return a.mode === "cycle"
        ? ({ type: "profileCycle" } as const)
        : a.profileId
          ? ({ type: "profile", profileId: a.profileId } as const)
          : null;
    default:
      return null;
  }
}

