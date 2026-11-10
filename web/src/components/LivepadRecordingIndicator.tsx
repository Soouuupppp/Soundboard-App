"use client";

// Shown in the header on every page while Livepad is recording. Its own file so the
// layout doesn't pull the editor (wavesurfer, lamejs) in with the header.

import { Circle } from "lucide-react";
import { useLivepad } from "@/components/LivepadProvider";

export function LivepadRecordingIndicator() {
  const { armed, waitingFor } = useLivepad();
  if (!armed) return null;
  if (waitingFor) {
    return (
      <span className="chip text-amber-300" title={`Livepad is waiting for ${waitingFor} and isn't recording`}>
        <Circle size={10} className="mr-1.5 text-amber-400" />
        Livepad waiting
      </span>
    );
  }
  return (
    <span className="chip text-red-300" title="Livepad is recording your selected source">
      <Circle size={10} className="mr-1.5 text-red-500 fill-red-500 animate-pulse" />
      Livepad
    </span>
  );
}
