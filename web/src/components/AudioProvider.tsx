"use client";

// Global audio-engine provider. The engine (useAudioOutput + the MicMixer) is
// mounted ONCE here, above the route segment in app/layout.tsx, so a single
// shared instance survives every route change. Previously Dashboard and
// AdminPanel each instantiated their own useAudioOutput(), so navigating from
// /dashboard to /admin unmounted Dashboard and tore down the virtual mic.
// Teardown now only happens on real app unmount (tab close), not navigation.

import { createContext, useContext, type ReactNode } from "react";
import { useAudioOutput, type AudioOutput } from "@/lib/audio-output";

const AudioOutputContext = createContext<AudioOutput | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
  const audio = useAudioOutput();
  return (
    <AudioOutputContext.Provider value={audio}>
      {children}
    </AudioOutputContext.Provider>
  );
}

export function useAudio(): AudioOutput {
  const ctx = useContext(AudioOutputContext);
  if (!ctx) throw new Error("useAudio must be used within an AudioProvider");
  return ctx;
}
