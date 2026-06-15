"use client";

// VrProvider (1.4.0 follow-up) — shared VR controller state lifted out of
// Dashboard so any page (notably the header Voice-changer popover) can read the
// controller profile + SteamVR status and open the bind picker. It owns:
//   • controllerProfile (Index vs Quest/Touch) — device-local, mirrors the enable
//     switches; the single writer of `soundboard:controllerProfile`.
//   • vrConnected — SteamVR status from the native bridge (`soundboard:vrStatus`).
//   • hasDesktop — whether the Electron wrapper (`window.soundboard`) is present.
// It also RENDERS the AI push-to-talk + AI-replay bind pickers, driven by the
// VoiceChangerProvider capture flags, so "Set controller" works from the header
// popover on any page (not just while the dashboard is mounted). Mounted in
// app/layout.tsx INSIDE VoiceChangerProvider (it consumes useVoiceChanger()).

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { VrBindPicker } from "@/components/VrBindPicker";
import { useVoiceChanger } from "@/components/VoiceChangerProvider";
import { getProfileBind, setProfileBind, type VrProfile } from "@/lib/vr-bind";

type VrCtx = {
  controllerProfile: VrProfile;
  setControllerProfile: (p: VrProfile) => void;
  vrConnected: boolean;
  hasDesktop: boolean;
};

const Ctx = createContext<VrCtx | null>(null);

export function VrProvider({ children }: { children: ReactNode }) {
  // Controller hardware profile (Index vs Quest/Touch) — relabels the bind UI;
  // tokens are unchanged. Device-local, mirrors the enable switches.
  const [controllerProfile, setControllerProfileState] = useState<VrProfile>("index");
  const [vrConnected, setVrConnected] = useState(false);
  const [hasDesktop, setHasDesktop] = useState(false);

  useEffect(() => {
    try {
      const prof = localStorage.getItem("soundboard:controllerProfile");
      if (prof === "index" || prof === "quest") setControllerProfileState(prof);
    } catch {}
    setHasDesktop(!!(window as unknown as { soundboard?: unknown }).soundboard);
  }, []);

  const setControllerProfile = useCallback((p: VrProfile) => {
    setControllerProfileState(p);
    try { localStorage.setItem("soundboard:controllerProfile", p); } catch {}
  }, []);

  // SteamVR connection status from the native bridge.
  useEffect(() => {
    function onVrStatus(ev: Event) {
      const detail = (ev as CustomEvent<{ steamvr: boolean }>).detail;
      setVrConnected(!!detail?.steamvr);
    }
    window.addEventListener("soundboard:vrStatus", onVrStatus as EventListener);
    return () => window.removeEventListener("soundboard:vrStatus", onVrStatus as EventListener);
  }, []);

  const vc = useVoiceChanger();

  return (
    <Ctx.Provider value={{ controllerProfile, setControllerProfile, vrConnected, hasDesktop }}>
      {children}
      {/* AI push-to-talk controller bind editor (portals to body) — rendered here
          so it opens from the header popover on any page, not just the dashboard. */}
      {vc.capturingAiPttVr && (
        <VrBindPicker
          initial={getProfileBind(vc.aiPttControllerBind, controllerProfile)}
          initialHolds={null}
          vrConnected={vrConnected}
          profile={controllerProfile}
          onCancel={() => vc.setCapturingAiPttVr(false)}
          onConfirm={(serialized) => {
            vc.setCapturingAiPttVr(false);
            vc.setAiPttControllerBind(setProfileBind(vc.aiPttControllerBind, controllerProfile, serialized));
          }}
        />
      )}
      {/* AI replay controller bind editor (portals to body). */}
      {vc.capturingAiReplayVr && (
        <VrBindPicker
          initial={getProfileBind(vc.aiReplayControllerBind, controllerProfile)}
          initialHolds={null}
          vrConnected={vrConnected}
          profile={controllerProfile}
          onCancel={() => vc.setCapturingAiReplayVr(false)}
          onConfirm={(serialized) => {
            vc.setCapturingAiReplayVr(false);
            vc.setAiReplayControllerBind(setProfileBind(vc.aiReplayControllerBind, controllerProfile, serialized));
          }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useVr(): VrCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useVr must be used within a VrProvider");
  return ctx;
}
