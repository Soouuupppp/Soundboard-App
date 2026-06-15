"use client";

// Header audio controls (1.4.0 layout refactor): the global output level meter
// plus three popover buttons — Settings · Voice changer · Sound Effects — that
// replace the old inline Control Panel card. They live in the header (app/
// layout.tsx, inside AudioProvider) and consume the global audio engine.
//
// One-open-at-a-time is enforced by the single `panel` state. The popover BODIES
// are filled by later 1.4.0 tasks: Settings (task 4), Voice changer (task 5),
// Sound Effects (task 7). Until then they show a short placeholder.

import { useState } from "react";
import { Settings, Wand2, SlidersHorizontal } from "lucide-react";
import { useAudio } from "@/components/AudioProvider";
import { Popover } from "@/components/Popover";
import { LevelMeter } from "@/components/LevelMeter";
import { SettingsPanel } from "@/components/SettingsPanel";
import { VoiceChangerPanel } from "@/components/VoiceChangerPanel";
import { SoundEffectsPickerModal } from "@/components/SoundEffectsModal";

type Panel = "settings" | "voice" | null;

function HeaderButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-haspopup="dialog"
      aria-expanded={active}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition ${
        active
          ? "border-accent/40 bg-accent/15 text-white"
          : "border-white/10 bg-white/[0.04] text-muted hover:bg-white/[0.08] hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

export function HeaderControls() {
  const audio = useAudio();
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));
  const close = () => setPanel(null);
  // Sound Effects is a full-screen modal (clip picker), not a popover.
  const [fxOpen, setFxOpen] = useState(false);

  // The voice changer + sound effects need the always-on engine (AudioContext
  // setSinkId). Without it, only Settings (device + master volume) is meaningful.
  const engine = audio.supportsSinkId;

  return (
    <div className="flex items-center gap-2">
      <Popover
        open={panel === "settings"}
        onClose={close}
        align="left"
        panelClassName="w-[21rem] max-w-[calc(100vw-1.5rem)] max-h-[80vh] overflow-y-auto p-3"
        trigger={
          <HeaderButton active={panel === "settings"} onClick={() => toggle("settings")} title="Settings">
            <Settings size={16} />
          </HeaderButton>
        }
      >
        <SettingsPanel audio={audio} />
      </Popover>

      {engine && (
        <Popover
          open={panel === "voice"}
          onClose={close}
          align="left"
          panelClassName="w-[23rem] max-w-[calc(100vw-1.5rem)] max-h-[80vh] overflow-y-auto p-3"
          trigger={
            <HeaderButton active={panel === "voice"} onClick={() => toggle("voice")} title="Voice changer">
              <Wand2 size={16} />
            </HeaderButton>
          }
        >
          <VoiceChangerPanel audio={audio} />
        </Popover>
      )}

      {engine && (
        <HeaderButton
          active={fxOpen}
          onClick={() => { setPanel(null); setFxOpen(true); }}
          title="Sound Effects"
        >
          <SlidersHorizontal size={16} />
        </HeaderButton>
      )}

      {/* Global output meter, last — animates only when something is playing / mixing. */}
      {audio.supportsOutputMeter && (
        <LevelMeter
          getPeak={audio.getOutputPeak}
          active={audio.anyPlaying || audio.virtualMicMode}
          className="hidden sm:block h-1.5 w-16 md:w-28 ml-1"
        />
      )}

      {fxOpen && <SoundEffectsPickerModal audio={audio} onClose={() => setFxOpen(false)} />}
    </div>
  );
}
