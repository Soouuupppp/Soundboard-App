"use client";

// Dashboard side of the Stream Deck bridge (desktop app only). Renders nothing: it
// attaches while the dashboard is mounted, publishes what the plugin needs (Saved
// sounds, profiles, what's playing, PTT state), and runs presses through the same
// trigger functions the keybinds use. Stream Deck buttons deliberately ignore the
// master keybinds switch — they can't be pressed by typing.

import { useEffect, useMemo, useRef } from "react";
import { useLivepad } from "@/components/LivepadProvider";
import { useAudio } from "@/components/AudioProvider";
import { setAiVoiceEnabled } from "@/components/AiVoicePanel";
import { livepadPlaybackKey } from "@/lib/livepad";
import { getStreamDeckBridge, type StreamDeckPress, type StreamDeckState } from "@/lib/streamdeck";

// livepad:<captureId> keys in playingSoundIds; the editor's "livepad:preview" is not a card.
const LIVEPAD_PREFIX = livepadPlaybackKey("");

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
  // Captures come straight from the Livepad context here, not through Dashboard's
  // props: this component renders nothing, so re-rendering it on every capture
  // change is cheap, while Dashboard stays on useLivepadBinds().
  const { captures, playCapture } = useLivepad();
  const audio = useAudio();
  const aiEnabled = !!audio.voiceFx[audio.inputDeviceId]?.ai?.enabled;

  // Latest values for the press handler, so attaching happens once per mount.
  const live = useRef({ audio, aiEnabled, captures, playCapture, sounds, profiles, activeProfileId, setActiveProfile, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion, triggerLivepadCapture });
  live.current = { audio, aiEnabled, captures, playCapture, sounds, profiles, activeProfileId, setActiveProfile, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion, triggerLivepadCapture };
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
        case "profileCycle": {
          // Next profile in `position` order (the list arrives sorted), wrapping
          // last → first. One profile = nothing to switch to, still a success.
          if (p.edge !== "down" || l.profiles.length < 2) return ok();
          const i = l.profiles.findIndex((x) => x.id === l.activeProfileId);
          l.setActiveProfile(l.profiles[(i + 1) % l.profiles.length].id);
          return ok();
        }
        case "aiToggle":
          if (p.edge !== "down") return ok();
          // No mic selected → nothing to turn AI on for.
          return setAiVoiceEnabled(l.audio, !l.aiEnabled) ? ok() : bridge.result(p.id, false, "unavailable");
        case "livepadPlayLatest":
        case "livepadPlay": {
          if (p.edge !== "down") return ok();
          // playCapture restarts a card that's already playing, like the grid's button.
          const c =
            p.action === "livepadPlayLatest"
              ? l.captures[0]
              : p.captureId
                ? l.captures.find((x) => x.id === p.captureId)
                : p.slot
                  ? l.captures[p.slot - 1]
                  : undefined;
          if (!c) return bridge.result(p.id, false, "not-found");
          void l.playCapture(c);
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
      aiEnabled,
      captures: captures.map((c) => ({ id: c.id, name: c.name, durationSec: c.durationSec })),
      playingCaptures: [...playingSoundIds]
        .filter((k) => k.startsWith(LIVEPAD_PREFIX))
        .map((k) => k.slice(LIVEPAD_PREFIX.length))
        .filter((id) => captures.some((c) => c.id === id)),
    }),
    [sounds, profiles, activeProfileId, playingSoundIds, aiPttRecording, aiEnabled, captures],
  );

  useEffect(() => {
    getStreamDeckBridge()?.publishState(state);
  }, [state]);

  return null;
}
