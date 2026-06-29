"use client";

// Header audio controls. In the 1.4.1 navbar refactor these split across the
// header's three zones: the global output meter + Voice changer + Sound Effects
// popovers live CENTER (`CenterControls`), while the Settings cog moved to the
// RIGHT cluster next to the user + profile dropdowns (`SettingsControl`). Both are
// CONTROLLED by a single `panel` state owned by <AppHeader>, so the three popovers
// still enforce one-open-at-a-time even though they no longer sit together.
//
// (Pre-1.4.1 this was one self-contained <HeaderControls> in the left zone.)

import { Settings, Wand2, Sparkles, SlidersHorizontal } from "lucide-react";
import { useAudio } from "@/components/AudioProvider";
import { Popover } from "@/components/Popover";
import { LevelMeter } from "@/components/LevelMeter";
import { SettingsPanel } from "@/components/SettingsPanel";
import { VoiceChangerPanel } from "@/components/VoiceChangerPanel";
import { AiVoicePanel } from "@/components/AiVoicePanel";
import { SoundEffectsPickerPanel } from "@/components/SoundEffectsModal";

export type Panel = "settings" | "voice" | "ai" | "fx" | null;

type ControlsProps = {
  panel: Panel;
  toggle: (p: Exclude<Panel, null>) => void;
  close: () => void;
};

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

// CENTER zone: output meter → Voice changer → Sound Effects. The voice + fx
// popovers need the always-on engine (AudioContext setSinkId); without it only
// Settings (device + master volume) is meaningful, so they're hidden here.
export function CenterControls({ panel, toggle, close }: ControlsProps) {
  const audio = useAudio();
  const engine = audio.supportsSinkId;

  return (
    <div className="flex items-center gap-2">
      {audio.supportsOutputMeter && (
        <LevelMeter
          getPeak={audio.getOutputPeak}
          active={audio.anyPlaying || audio.virtualMicMode}
          className="h-1.5 w-16 md:w-28 mr-1"
        />
      )}

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
        <Popover
          open={panel === "ai"}
          onClose={close}
          align="left"
          panelClassName="w-[23rem] max-w-[calc(100vw-1.5rem)] max-h-[80vh] overflow-y-auto p-3"
          trigger={
            <HeaderButton active={panel === "ai"} onClick={() => toggle("ai")} title="AI voice">
              <Sparkles size={16} />
            </HeaderButton>
          }
        >
          <AiVoicePanel audio={audio} />
        </Popover>
      )}

      {engine && (
        <Popover
          open={panel === "fx"}
          onClose={close}
          align="left"
          panelClassName="w-[34rem] max-w-[calc(100vw-1.5rem)] max-h-[80vh] overflow-y-auto p-3"
          trigger={
            <HeaderButton active={panel === "fx"} onClick={() => toggle("fx")} title="Sound Effects">
              <SlidersHorizontal size={16} />
            </HeaderButton>
          }
        >
          <SoundEffectsPickerPanel audio={audio} onClose={close} />
        </Popover>
      )}
    </div>
  );
}

// RIGHT cluster: the Settings cog — a square chip matching the center buttons,
// sitting beside the profile/user + quota stack. Anchored right so the panel
// doesn't overflow.
export function SettingsControl({ panel, toggle, close }: ControlsProps) {
  const audio = useAudio();
  return (
    <Popover
      open={panel === "settings"}
      onClose={close}
      align="right"
      panelClassName="w-[21rem] max-w-[calc(100vw-1.5rem)] max-h-[80vh] overflow-y-auto p-3"
      trigger={
        <HeaderButton active={panel === "settings"} onClick={() => toggle("settings")} title="Settings">
          <Settings size={16} />
        </HeaderButton>
      }
    >
      <SettingsPanel audio={audio} />
    </Popover>
  );
}
