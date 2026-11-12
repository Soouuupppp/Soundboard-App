"use client";

// Dashboard side of the Stream Deck bridge (desktop app only). Renders nothing: it
// attaches while the dashboard is mounted, publishes what the plugin needs (Saved
// sounds, profiles, what's playing, PTT state), and runs presses through the same
// trigger functions the keybinds use. Stream Deck buttons deliberately ignore the
// master keybinds switch — they can't be pressed by typing.

import { useEffect, useMemo, useRef } from "react";
import { getStreamDeckBridge, type StreamDeckPress, type StreamDeckState } from "@/lib/streamdeck";

type SavedSound = { entryId: string; soundId: string; name: string; onBoard: boolean };

export function StreamDeckBridge({
  sounds,
  profiles,
  activeProfileId,
  setActiveProfile,
  playingSoundIds,
  aiPttRecording,
  playEntry,
  cancelAll,
  startAiPtt,
  stopAiPtt,
  replayLastConversion,
  triggerLivepadCapture,
}: {
  sounds: SavedSound[];
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  setActiveProfile: (id: string) => void;
  playingSoundIds: Set<string>;
  aiPttRecording: boolean;
  playEntry: (entryId: string, soundId: string) => void;
  cancelAll: () => void;
  startAiPtt: () => void;
  stopAiPtt: () => void;
  replayLastConversion: () => void;
  triggerLivepadCapture: () => void;
}) {
  // Latest values for the press handler, so attaching happens once per mount.
  const live = useRef({ sounds, profiles, setActiveProfile, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion, triggerLivepadCapture });
  live.current = { sounds, profiles, setActiveProfile, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion, triggerLivepadCapture };
  const pttHeldRef = useRef(false);

  useEffect(() => {
    const bridge = getStreamDeckBridge();
    if (!bridge) return;
    const onPress = (p: StreamDeckPress) => {
      const l = live.current;
      const ok = () => bridge.result(p.id, true);
      switch (p.action) {
        case "play": {
          if (p.edge !== "down") return ok();
          const s = l.sounds.find((x) => x.soundId === p.soundId);
          if (!s) return bridge.result(p.id, false, "not-found");
          l.playEntry(s.entryId, s.soundId);
          return ok();
        }
        case "cancelAll":
          if (p.edge === "down") l.cancelAll();
          return ok();
        case "aiPtt":
          if (p.edge === "down" && !pttHeldRef.current) {
            pttHeldRef.current = true;
            l.startAiPtt();
          } else if (p.edge === "up" && pttHeldRef.current) {
            pttHeldRef.current = false;
            l.stopAiPtt();
          }
          return ok();
        case "aiReplay":
          if (p.edge === "down") l.replayLastConversion();
          return ok();
        case "livepad":
          if (p.edge === "down") l.triggerLivepadCapture();
          return ok();
        case "profile": {
          if (p.edge !== "down") return ok();
          if (!l.profiles.some((x) => x.id === p.profileId)) return bridge.result(p.id, false, "not-found");
          l.setActiveProfile(p.profileId!);
          return ok();
        }
        default:
          return bridge.result(p.id, false, "unavailable");
      }
    };
    const detach = bridge.attach(onPress);
    return () => {
      detach();
      // A hold started from the Stream Deck must not outlive the dashboard.
      if (pttHeldRef.current) {
        pttHeldRef.current = false;
        live.current.stopAiPtt();
      }
    };
  }, []);

  const state = useMemo<StreamDeckState>(
    () => ({
      sounds: sounds.map(({ soundId, name, onBoard }) => ({ soundId, name, onBoard })),
      profiles,
      activeProfileId,
      playing: [...playingSoundIds],
      aiPtt: aiPttRecording,
    }),
    [sounds, profiles, activeProfileId, playingSoundIds, aiPttRecording],
  );

  useEffect(() => {
    getStreamDeckBridge()?.publishState(state);
  }, [state]);

  return null;
}
