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
import { useRemoteActions, type RemoteAction, type RemoteSavedSound } from "@/lib/remote-actions";

// livepad:<captureId> keys in playingSoundIds; the editor's "livepad:preview" is not a card.
const LIVEPAD_PREFIX = livepadPlaybackKey("");


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
  sounds: RemoteSavedSound[];
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
  const { captures } = useLivepad();
  const audio = useAudio();
  const aiEnabled = !!audio.voiceFx[audio.inputDeviceId]?.ai?.enabled;

  // Shared with the VRChat avatar panel (lib/remote-actions.ts).
  const run = useRemoteActions({ sounds, profiles, activeProfileId, setActiveProfile, playEntry, cancelAll, triggerLivepadCapture });

  // Latest values for the press handler, so attaching happens once per mount.
  const live = useRef({ audio, aiEnabled, run, startAiPtt, stopAiPtt, replayLastConversion });
  live.current = { audio, aiEnabled, run, startAiPtt, stopAiPtt, replayLastConversion };
  const pttHeldRef = useRef(false);

  useEffect(() => {
    const bridge = getStreamDeckBridge();
    if (!bridge) return;
    const onPress = (p: StreamDeckPress) => {
      const l = live.current;
      const ok = () => bridge.result(p.id, true);
      const runDown = (a: RemoteAction) => {
        if (p.edge !== "down") return ok();
        const r = l.run(a);
        return r.ok ? ok() : bridge.result(p.id, false, r.error);
      };
      switch (p.action) {
        case "play":
          return runDown({ type: "play", soundId: p.soundId ?? "" });
        case "cancelAll":
          return runDown({ type: "cancelAll" });
        case "livepad":
          return runDown({ type: "livepadCapture" });
        case "profile":
          return runDown({ type: "profile", profileId: p.profileId ?? "" });
        case "profileCycle":
          return runDown({ type: "profileCycle" });
        case "livepadPlayLatest":
          return runDown({ type: "livepadPlayLatest" });
        case "livepadPlay":
          return runDown({ type: "livepadPlay", slot: p.slot, captureId: p.captureId });
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
        case "aiToggle":
          if (p.edge !== "down") return ok();
          // No mic selected → nothing to turn AI on for.
          return setAiVoiceEnabled(l.audio, !l.aiEnabled) ? ok() : bridge.result(p.id, false, "unavailable");
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
