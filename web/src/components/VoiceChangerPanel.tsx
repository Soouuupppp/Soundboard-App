"use client";

// Voice changer popover body (1.4.0) — PRIMARY MIC ONLY. The selected input
// device (audio.inputDeviceId) is the single voice-changer source; its DSP effect
// chain + AI voice config are keyed by that deviceId in the engine's voiceFx map.
// Effects + AI only take effect with Virtual Mic mode on and the mic open.
//
// The AI push-to-talk bind state lives in VoiceChangerProvider (shared with
// Dashboard's matcher). The VR bind PICKER renders in Dashboard — opening it here
// sets `capturingAiPttVr`, which Dashboard reacts to while it's mounted.

import { useState } from "react";
import { Sliders, Sparkles, X, ArrowUp, ArrowDown, Plus, Wand2, ShieldAlert, Mic, Keyboard, Gamepad2, Repeat } from "lucide-react";
import type { AudioOutput, AiConfig } from "@/lib/audio-output";
import { type EffectKind, type EffectConfig, EFFECT_DEFS, makeEffect, effectLabel } from "@/lib/voice-fx";
import { AI_PRESETS, AI_CUSTOM_ID, AI_MODEL_CREDIT, AI_PRIVACY_NOTICE, type AiVoice } from "@/lib/voice-ai";
import { getProfileBind, setProfileBind, type VrProfile } from "@/lib/vr-bind";
import { Select } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { VrBindChips } from "@/components/VrBindChips";
import { FxPresetBar } from "@/components/FxPresetBar";
import { useVoiceChanger } from "@/components/VoiceChangerProvider";

// The VR controller profile + desktop-app presence are device-local; the popover
// reads them directly (Dashboard owns the live profile dropdown / SteamVR status).
function readControllerProfile(): VrProfile {
  if (typeof window === "undefined") return "index";
  try {
    const p = localStorage.getItem("soundboard:controllerProfile");
    return p === "quest" ? "quest" : "index";
  } catch {
    return "index";
  }
}
const hasDesktopApp = () => typeof window !== "undefined" && "soundboard" in window;

export function VoiceChangerPanel({ audio }: { audio: AudioOutput }) {
  const sourceKey = audio.inputDeviceId;

  if (!sourceKey) {
    return (
      <div className="space-y-2 text-sm">
        <h3 className="font-medium">Voice changer</h3>
        <p className="text-xs text-muted">
          Pick an Input device (mic) in Settings to add effects or an AI voice to it.
        </p>
      </div>
    );
  }

  const active = audio.virtualMicMode;
  const effects = audio.voiceFx[sourceKey]?.effects ?? [];

  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Voice changer</h3>
      <p className="text-xs text-muted">
        Real-time effects + an optional AI voice on your mic. They feed the virtual-mic cable, so they
        only take effect with Virtual Mic mode on.
      </p>
      {!active && (
        <p className="text-xs text-amber-300/90">
          Virtual Mic mode is off — settings are saved but won&apos;t be heard until you enable it in Settings.
        </p>
      )}
      {audio.aiError && <p className="text-xs text-red-400">AI voice error: {audio.aiError}</p>}

      <div className="flex items-center gap-2">
        <Sliders size={14} className="text-accent shrink-0" />
        <span className="text-sm font-medium">Effects</span>
      </div>
      <EffectChainEditor sourceKey={sourceKey} effects={effects} audio={audio} />

      <AiSection sourceKey={sourceKey} audio={audio} />
    </div>
  );
}

// Ordered, stackable effect chain for the mic. Add via the Select, reorder with
// up/down, remove with ×, tweak params with sliders (live, no rebuild).
function EffectChainEditor({
  sourceKey,
  effects,
  audio,
}: {
  sourceKey: string;
  effects: EffectConfig[];
  audio: AudioOutput;
}) {
  const move = (index: number, dir: -1 | 1) => {
    const next = effects.slice();
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    audio.setSourceEffects(sourceKey, next);
  };
  const remove = (index: number) => {
    audio.setSourceEffects(sourceKey, effects.filter((_, i) => i !== index));
  };
  const add = (kind: EffectKind) => {
    audio.setSourceEffects(sourceKey, [...effects, makeEffect(kind)]);
  };

  return (
    <div className="grid gap-2">
      {effects.length === 0 && <p className="text-xs text-muted">No effects — add one below.</p>}
      {effects.map((fx, i) => {
        const def = EFFECT_DEFS.find((d) => d.kind === fx.kind);
        return (
          <div key={fx.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
            <div className="flex items-center gap-2 mb-1.5">
              <Sparkles size={12} className="text-accent shrink-0" />
              <span className="text-sm truncate min-w-0">{effectLabel(fx.kind)}</span>
              <span className="ml-auto inline-flex items-center gap-0.5">
                <button type="button" className="btn-ghost !px-1.5 disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label={`Move ${effectLabel(fx.kind)} up`}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="btn-ghost !px-1.5 disabled:opacity-30" onClick={() => move(i, 1)} disabled={i === effects.length - 1} title="Move down" aria-label={`Move ${effectLabel(fx.kind)} down`}>
                  <ArrowDown size={14} />
                </button>
                <button type="button" className="btn-ghost !px-1.5 text-red-300/80 hover:text-red-300" onClick={() => remove(i)} title="Remove effect" aria-label={`Remove ${effectLabel(fx.kind)}`}>
                  <X size={14} />
                </button>
              </span>
            </div>
            <div className="grid gap-1.5">
              {(def?.params ?? []).map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <span className="text-xs text-muted w-20 shrink-0 truncate" title={p.label}>{p.label}</span>
                  <input
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={fx.params[p.key] ?? p.default}
                    onChange={(e) => audio.updateSourceEffectParams(sourceKey, i, { ...fx.params, [p.key]: Number(e.target.value) })}
                    className="flex-1 accent-accent"
                    aria-label={`${effectLabel(fx.kind)} ${p.label}`}
                  />
                  <span className="text-xs text-muted w-12 text-right tabular-nums">
                    {(fx.params[p.key] ?? p.default)}{p.unit ? ` ${p.unit}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <Select
        className="w-full !py-1.5 text-xs"
        aria-label="Add effect to mic"
        value=""
        placeholder={<span className="inline-flex items-center gap-1"><Plus size={12} /> Add effect…</span>}
        onChange={(v) => add(v as EffectKind)}
        options={EFFECT_DEFS.map((d) => ({ value: d.kind, label: d.label }))}
      />
      <FxPresetBar effects={effects} onApply={(fx) => audio.setSourceEffects(sourceKey, fx)} />
    </div>
  );
}

// AI voice section for the mic: enable (mutes the raw mic), pick a preset (or
// custom RVC model), push-to-talk (button + hotkeys), with the required HF privacy
// disclosure and model attribution. PTT bind state comes from VoiceChangerProvider.
function AiSection({ sourceKey, audio }: { sourceKey: string; audio: AudioOutput }) {
  const vc = useVoiceChanger();
  const ai = audio.voiceFx[sourceKey]?.ai;
  const enabled = !!ai?.enabled;
  const voiceId = ai?.voiceId ?? AI_PRESETS[0].id;
  const custom = ai?.custom ?? null;
  const recording = audio.pttRecording.has(sourceKey);

  // Device-local profile + desktop presence (read once per popover open).
  const [controllerProfile] = useState<VrProfile>(readControllerProfile);
  const hasDesktop = hasDesktopApp();

  const setAi = (next: Partial<AiConfig>) => {
    audio.setSourceAi(sourceKey, { enabled, voiceId, custom, ...next });
  };
  const setCustom = (patch: Partial<AiVoice>) => {
    const base: AiVoice = custom ?? { modelUrl: "", indexUrl: "", pitch: 0 };
    setAi({ voiceId: AI_CUSTOM_ID, custom: { ...base, ...patch } });
  };

  const profBind = getProfileBind(vc.aiPttControllerBind, controllerProfile);
  const replayBind = getProfileBind(vc.aiReplayControllerBind, controllerProfile);

  return (
    <div className="mt-1 rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/[0.04] px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm">
          <Wand2 size={13} className="text-fuchsia-300 shrink-0" /> AI voice
        </span>
        <Toggle size="sm" checked={enabled} onChange={(b) => setAi({ enabled: b })} label="Toggle AI voice for the mic" />
      </div>

      {enabled && (
        <div className="grid gap-2 mt-2">
          {/* Required disclosure — mic audio leaves the machine. */}
          <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
            <ShieldAlert size={13} className="shrink-0 mt-0.5" />
            <span>{AI_PRIVACY_NOTICE}</span>
          </p>
          <p className="text-xs text-muted">
            Enabling AI removes your raw mic from the cable — only converted push-to-talk bursts pass.
          </p>

          <Select
            className="w-full !py-1.5 text-xs"
            aria-label="AI voice preset"
            value={voiceId}
            onChange={(v) => (v === AI_CUSTOM_ID ? setCustom({}) : setAi({ voiceId: v, custom }))}
            options={[...AI_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: AI_CUSTOM_ID, label: "Custom…" }]}
          />

          {voiceId === AI_CUSTOM_ID && (
            <div className="grid gap-1.5">
              <input className="input !py-1.5 text-xs" placeholder="Model URL (.pth)" value={custom?.modelUrl ?? ""} onChange={(e) => setCustom({ modelUrl: e.target.value })} />
              <input className="input !py-1.5 text-xs" placeholder="Index URL (.index)" value={custom?.indexUrl ?? ""} onChange={(e) => setCustom({ indexUrl: e.target.value })} />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted w-16 shrink-0">Pitch</span>
                <input type="range" min={-12} max={12} step={1} value={custom?.pitch ?? 0} onChange={(e) => setCustom({ pitch: Number(e.target.value) })} className="flex-1 accent-accent" aria-label="Custom voice pitch" />
                <span className="text-xs text-muted w-8 text-right tabular-nums">{custom?.pitch ?? 0}</span>
              </div>
              <p className="text-xs text-muted">Use only voices you have the rights to.</p>
            </div>
          )}

          {/* Push-to-talk: hold the button (or the bound hotkey) to record. */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={`btn-ghost text-xs ${recording ? "!border-fuchsia-400/50 !bg-fuchsia-500/20 text-white" : ""}`}
              onPointerDown={(e) => { e.preventDefault(); audio.startPtt(sourceKey); }}
              onPointerUp={() => audio.stopPtt(sourceKey)}
              onPointerLeave={() => { if (recording) audio.stopPtt(sourceKey); }}
              title="Hold to record, release to convert"
            >
              <Mic size={14} className="mr-1" />
              {recording ? "Recording… release to convert" : "Hold to talk"}
            </button>
            {audio.aiBusy && <span className="text-xs text-fuchsia-300">Converting…</span>}
          </div>

          {/* Hotkeys (one global PTT bind, editable here). */}
          <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-white/10 bg-white/[0.03] p-1">
            <span className="text-xs text-muted px-1">PTT hotkey</span>
            <button
              type="button"
              className={`btn-ghost text-xs ${vc.capturingAiPtt ? "text-accent" : ""}`}
              onClick={() => vc.setCapturingAiPtt(!vc.capturingAiPtt)}
              title="Set a keyboard push-to-talk hotkey"
            >
              <Keyboard size={14} className="mr-1" />
              {vc.capturingAiPtt ? "Hold keys…" : vc.aiPttKeybind || "Set keybind"}
            </button>
            {vc.aiPttKeybind && !vc.capturingAiPtt && (
              <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => vc.setAiPttKeybind(null)} title="Clear PTT keybind">
                ×
              </button>
            )}
            {hasDesktop && (
              <>
                <span className="h-4 w-px bg-white/10" aria-hidden />
                <button type="button" className="btn-ghost text-xs" onClick={() => vc.setCapturingAiPttVr(true)} title="Set a controller push-to-talk bind">
                  <Gamepad2 size={14} className="mr-1" />
                  {profBind ? <VrBindChips value={profBind} /> : "Set controller"}
                </button>
                {profBind && (
                  <button
                    type="button"
                    className="btn-ghost text-xs !px-1.5"
                    onClick={() => vc.setAiPttControllerBind(setProfileBind(vc.aiPttControllerBind, controllerProfile, null))}
                    title="Clear PTT controller bind"
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>

          {/* Replay: re-inject the last converted clip (button + hotkeys). */}
          <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-white/10 bg-white/[0.03] p-1">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => audio.replayLastConversion()}
              title="Replay the last converted clip"
            >
              <Repeat size={14} className="mr-1" /> Replay last
            </button>
            <button
              type="button"
              className={`btn-ghost text-xs ${vc.capturingAiReplay ? "text-accent" : ""}`}
              onClick={() => vc.setCapturingAiReplay(!vc.capturingAiReplay)}
              title="Set a keyboard replay hotkey"
            >
              <Keyboard size={14} className="mr-1" />
              {vc.capturingAiReplay ? "Hold keys…" : vc.aiReplayKeybind || "Set keybind"}
            </button>
            {vc.aiReplayKeybind && !vc.capturingAiReplay && (
              <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => vc.setAiReplayKeybind(null)} title="Clear replay keybind">
                ×
              </button>
            )}
            {hasDesktop && (
              <>
                <span className="h-4 w-px bg-white/10" aria-hidden />
                <button type="button" className="btn-ghost text-xs" onClick={() => vc.setCapturingAiReplayVr(true)} title="Set a controller replay bind">
                  <Gamepad2 size={14} className="mr-1" />
                  {replayBind ? <VrBindChips value={replayBind} /> : "Set controller"}
                </button>
                {replayBind && (
                  <button
                    type="button"
                    className="btn-ghost text-xs !px-1.5"
                    onClick={() => vc.setAiReplayControllerBind(setProfileBind(vc.aiReplayControllerBind, controllerProfile, null))}
                    title="Clear replay controller bind"
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>

          <p className="text-[11px] text-muted">{AI_MODEL_CREDIT}</p>
        </div>
      )}
    </div>
  );
}
