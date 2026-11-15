"use client";

// Navbar chips beside the Livepad indicator: "AI voice" while AI voice is on for the
// selected mic (pulsing while a push-to-talk clip records or converts), and
// "Effects" while the mic has DSP effects AND Virtual Mic mode is on — the mic (and
// so its effect chain) is only open in Virtual Mic mode.

import { Sliders, Sparkles } from "lucide-react";
import { useAudio } from "@/components/AudioProvider";

export function VoiceChangerIndicators() {
  const audio = useAudio();
  const fx = audio.voiceFx[audio.inputDeviceId];
  const aiOn = !!fx?.ai?.enabled;
  const effectsOn = audio.virtualMicMode && (fx?.effects?.length ?? 0) > 0;
  const busy = audio.pttRecording.size > 0 || audio.aiBusy;
  if (!aiOn && !effectsOn) return null;
  return (
    <>
      {aiOn && (
        <span className="chip text-violet-200" title="AI voice is on for your mic">
          <Sparkles size={12} className={`xl:mr-1.5 text-violet-400 ${busy ? "animate-pulse" : ""}`} />
          <span className="sr-only xl:not-sr-only">AI voice</span>
        </span>
      )}
      {effectsOn && (
        <span className="chip text-sky-200" title="Voice effects are on for your mic">
          <Sliders size={12} className="xl:mr-1.5 text-sky-400" />
          <span className="sr-only xl:not-sr-only">Effects</span>
        </span>
      )}
    </>
  );
}
