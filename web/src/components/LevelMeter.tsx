"use client";

// Shared audio level meters (extracted from the old inline Control Panel so the
// header output meter + the Settings / Voice-changer popovers can all reuse them).
// Both meters paint the bar straight to the DOM each animation frame (width +
// color via a ref) so a continuously-running meter never forces a React
// re-render 60×/sec — which matters because several can run for a whole session.

import { useEffect, useRef, useState } from "react";

// Peak-meter color for a linear level (red past 0 dBFS, amber into the limiter
// threshold at -1 dBFS, else green). Shared by LevelMeter + PeakMeter.
export function meterColor(level: number): string {
  return level >= 1.0 ? "bg-red-500" : level >= 0.89 ? "bg-amber-400" : "bg-emerald-500";
}

// Drives a meter bar straight to the DOM each animation frame (width + color via
// a ref). `active` gates the rAF loop so idle meters cost nothing. Returns
// nothing; the caller renders the bar element with `barRef`.
export function useMeterBar(
  barRef: React.RefObject<HTMLDivElement | null>,
  getPeak: () => number,
  active: boolean,
  onLevel?: (level: number) => void,
) {
  const heldRef = useRef(0);
  const lastColorRef = useRef("");
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  useEffect(() => {
    const bar = barRef.current;
    const paint = (level: number) => {
      if (bar) {
        bar.style.width = `${Math.min(100, level * 100)}%`;
        const color = meterColor(level);
        if (color !== lastColorRef.current) {
          lastColorRef.current = color;
          bar.className = `h-full ${color} transition-[width] duration-75`;
        }
      }
      onLevelRef.current?.(level);
    };
    if (!active) {
      heldRef.current = 0;
      paint(0);
      return;
    }
    let raf = 0;
    let last = 0;
    // 30fps is smooth enough for a level meter and halves the work vs. painting
    // every frame. (rAF still auto-pauses when the window is hidden/occluded, so
    // a backgrounded soundboard costs nothing.) Decay is squared to keep the same
    // wall-clock peak-hold falloff at the lower update rate.
    const FRAME_MS = 1000 / 30;
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      if (ts - last < FRAME_MS) return;
      last = ts;
      heldRef.current = Math.max(getPeak(), heldRef.current * 0.846); // peak-hold + decay
      paint(heldRef.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, getPeak, barRef]);
}

// Compact pill meter: a thin bar that fills green / amber (nearing the limiter) /
// red (clipping). Used for the header global-output meter + per-source rows.
export function LevelMeter({
  getPeak,
  active,
  className = "",
}: {
  getPeak: () => number;
  active: boolean;
  className?: string;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  useMeterBar(barRef, getPeak, active);
  return (
    <div className={`shrink-0 overflow-hidden rounded-full bg-white/10 ${className}`}>
      <div ref={barRef} className="h-full bg-emerald-500 transition-[width] duration-75" style={{ width: "0%" }} />
    </div>
  );
}

// Larger labelled meter of the cable/output sum. Polls the pre-limiter peak each
// frame with a short peak-hold decay; flips a "Clipping" label when past 0 dBFS.
export function PeakMeter({ getPeak, active }: { getPeak: () => number; active: boolean }) {
  const barRef = useRef<HTMLDivElement | null>(null);
  // The bar is painted straight to the DOM (no per-frame re-render); only the
  // "Clipping" label is React state, and it flips at most when crossing 0 dBFS.
  const [clipping, setClipping] = useState(false);
  const clippingRef = useRef(false);
  useMeterBar(barRef, getPeak, active, (level) => {
    const clip = level >= 1.0;
    if (clip !== clippingRef.current) {
      clippingRef.current = clip;
      setClipping(clip);
    }
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm">Output level</label>
        {clipping && <span className="text-xs text-red-400 font-medium">Clipping — limiter active</span>}
      </div>
      <div className="h-2.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div ref={barRef} className="h-full bg-emerald-500 transition-[width] duration-75" style={{ width: "0%" }} />
      </div>
    </div>
  );
}
