"use client";

// Render a stored VR controller bind as wrapping per-action pills, steps
// separated by "→". Handles sequences + down/up edges; long binds wrap instead of
// truncating. Shared by the sound cards, cancel-all, and the voice-changer AI-PTT
// bind UI. (Extracted from Dashboard so the header voice-changer popover reuses it.)

import { parseVrBind, formatVrAction } from "@/lib/vr-bind";

export function VrBindChips({ value }: { value: string }) {
  const bind = parseVrBind(value);
  if (!bind) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 min-w-0">
      {bind.steps.map((step, si) => (
        <span key={si} className="inline-flex flex-wrap items-center gap-1">
          {si > 0 && <span className="px-0.5 text-[10px] text-muted/60">→</span>}
          <span className="inline-flex flex-wrap items-center gap-0.5">
            {step.map((a, ai) => (
              <span
                key={ai}
                className="inline-flex items-center rounded bg-black/25 px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap"
              >
                {formatVrAction(a)}
              </span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
