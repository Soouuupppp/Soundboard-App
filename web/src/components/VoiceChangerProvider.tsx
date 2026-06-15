"use client";

// VoiceChangerProvider (1.4.0) — shared AI push-to-talk BIND state so the
// voice-changer popover (header, outside Dashboard) and Dashboard's VR/keyboard
// matcher both read/write the same device-local binds. Mounted alongside
// AudioProvider in app/layout.tsx for signed-in users.
//
// What lives here: the AI-PTT keyboard combo + per-profile controller bind
// (device-local, mirrors cancel-all), the two capture flags, AND the keyboard
// chord-capture effect (so "Set keybind" works from the popover on any page). The
// VR bind PICKER still renders in Dashboard (it owns controllerProfile + the
// SteamVR status) — opening it from the popover sets `capturingAiPttVr` here and
// Dashboard renders the editor while it's mounted.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { canonicalKeyCombo, isModToken, keyTokenFromEvent, modsFromEvent, type Mods } from "@/lib/chord";

type VoiceChangerCtx = {
  aiPttKeybind: string | null;
  setAiPttKeybind: (combo: string | null) => void;
  aiPttControllerBind: string | null;
  setAiPttControllerBind: (bind: string | null) => void;
  capturingAiPtt: boolean;
  setCapturingAiPtt: (v: boolean) => void;
  capturingAiPttVr: boolean;
  setCapturingAiPttVr: (v: boolean) => void;
  // AI replay bind (re-injects the last converted clip) — same device-local model.
  aiReplayKeybind: string | null;
  setAiReplayKeybind: (combo: string | null) => void;
  aiReplayControllerBind: string | null;
  setAiReplayControllerBind: (bind: string | null) => void;
  capturingAiReplay: boolean;
  setCapturingAiReplay: (v: boolean) => void;
  capturingAiReplayVr: boolean;
  setCapturingAiReplayVr: (v: boolean) => void;
};

// A device-local string bind (localStorage key) with state + setter + a one-time
// load. Used for both the PTT and Replay keyboard/controller binds.
function useLocalBind(key: string): [string | null, (v: string | null) => void] {
  const [val, setVal] = useState<string | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v) setVal(v);
    } catch {}
  }, [key]);
  const set = useCallback((v: string | null) => {
    setVal(v);
    try {
      if (v) localStorage.setItem(key, v);
      else localStorage.removeItem(key);
    } catch {}
  }, [key]);
  return [val, set];
}

// Capture a keyboard chord into `setCombo` while `capturing` is true (largest
// chord held, confirmed on full release). Escape cancels. Shared by PTT + Replay.
function useChordCapture(
  capturing: boolean,
  setCapturing: (v: boolean) => void,
  setCombo: (combo: string) => void,
) {
  useEffect(() => {
    if (!capturing) return;
    const held = new Set<string>();
    let peakKeys: string[] = [];
    let peakMods: Mods = { ctrl: false, alt: false, shift: false, meta: false };
    let peakSize = 0;
    const sizeOf = (m: Mods, keys: number) =>
      keys + (m.ctrl ? 1 : 0) + (m.alt ? 1 : 0) + (m.shift ? 1 : 0) + (m.meta ? 1 : 0);
    function onKeyDown(ev: KeyboardEvent) {
      ev.preventDefault();
      if (ev.key === "Escape") { setCapturing(false); return; }
      const token = keyTokenFromEvent(ev);
      if (!token || isModToken(token)) return;
      if (!ev.repeat) held.add(token);
      const mods = modsFromEvent(ev);
      const s = sizeOf(mods, held.size);
      if (s > peakSize) { peakSize = s; peakKeys = [...held]; peakMods = mods; }
    }
    function onKeyUp(ev: KeyboardEvent) {
      const token = keyTokenFromEvent(ev);
      if (token && !isModToken(token)) held.delete(token);
      if (held.size > 0 || peakKeys.length === 0) return;
      setCombo(canonicalKeyCombo(peakMods, peakKeys));
      setCapturing(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturing, setCapturing, setCombo]);
}

const Ctx = createContext<VoiceChangerCtx | null>(null);

export function VoiceChangerProvider({ children }: { children: ReactNode }) {
  // Device-local binds, same pattern as cancel-all. `null` = unbound.
  const [aiPttKeybind, setAiPttKeybind] = useLocalBind("soundboard:aiPttKeybind");
  const [aiPttControllerBind, setAiPttControllerBind] = useLocalBind("soundboard:aiPttControllerBind");
  const [capturingAiPtt, setCapturingAiPtt] = useState(false);
  const [capturingAiPttVr, setCapturingAiPttVr] = useState(false);

  const [aiReplayKeybind, setAiReplayKeybind] = useLocalBind("soundboard:aiReplayKeybind");
  const [aiReplayControllerBind, setAiReplayControllerBind] = useLocalBind("soundboard:aiReplayControllerBind");
  const [capturingAiReplay, setCapturingAiReplay] = useState(false);
  const [capturingAiReplayVr, setCapturingAiReplayVr] = useState(false);

  // Keyboard chord-capture lives here (not Dashboard) so the popover's "Set
  // keybind" works on any page, even where the playback matcher isn't mounted.
  useChordCapture(capturingAiPtt, setCapturingAiPtt, setAiPttKeybind);
  useChordCapture(capturingAiReplay, setCapturingAiReplay, setAiReplayKeybind);

  return (
    <Ctx.Provider
      value={{
        aiPttKeybind,
        setAiPttKeybind,
        aiPttControllerBind,
        setAiPttControllerBind,
        capturingAiPtt,
        setCapturingAiPtt,
        capturingAiPttVr,
        setCapturingAiPttVr,
        aiReplayKeybind,
        setAiReplayKeybind,
        aiReplayControllerBind,
        setAiReplayControllerBind,
        capturingAiReplay,
        setCapturingAiReplay,
        capturingAiReplayVr,
        setCapturingAiReplayVr,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useVoiceChanger(): VoiceChangerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useVoiceChanger must be used within a VoiceChangerProvider");
  return ctx;
}
