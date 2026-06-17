"use client";

// Voice changer popover body (1.4.0; AI split out in 1.4.1) — PRIMARY MIC ONLY.
// The selected input device (audio.inputDeviceId) is the single voice-changer
// source; its DSP effect chain is keyed by that deviceId in the engine's voiceFx
// map. Effects only take effect with Virtual Mic mode on and the mic open.
//
// The AI voice now lives in its own header popover (components/AiVoicePanel.tsx) —
// this panel is just the real-time DSP effect chain.

import { Sliders, Sparkles, X, ArrowUp, ArrowDown, Plus, Mic } from "lucide-react";
import type { AudioOutput } from "@/lib/audio-output";
import { type EffectKind, type EffectConfig, EFFECT_DEFS, makeEffect, effectLabel } from "@/lib/voice-fx";
import { Select } from "@/components/Select";
import { FxPresetBar } from "@/components/FxPresetBar";

export function VoiceChangerPanel({ audio }: { audio: AudioOutput }) {
  const sourceKey = audio.inputDeviceId;

  if (!sourceKey) {
    // No mic selected yet → let the user pick one right here (not just in Settings)
    // so the popover isn't a dead end. Falls back to a mic-permission prompt when
    // no input devices are enumerated (labels/ids are hidden until granted).
    const noMics = audio.inputDevices.length === 0;
    const labelsHidden = audio.inputDevices.some((d) => !d.label);
    const inputOptions = [
      { value: "", label: "None" },
      ...audio.inputDevices.map((d) => ({ value: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 6)}` })),
    ];
    return (
      <div className="space-y-2 text-sm">
        <h3 className="font-medium">Voice changer</h3>
        <p className="text-xs text-muted">
          Add real-time effects to your mic. Pick your input device to start:
        </p>
        <label className="block">
          <span className="flex items-center gap-1.5 text-xs text-muted mb-1"><Mic size={12} /> Input device (mic)</span>
          <Select
            className="w-full"
            aria-label="Input device"
            value={audio.inputDeviceId}
            onChange={audio.setInputDeviceId}
            options={inputOptions}
          />
        </label>
        {(noMics || labelsHidden) && (
          <button type="button" className="btn-ghost text-xs" onClick={() => audio.requestLabelsPermission()}>
            {noMics ? "Find microphones (grants mic permission)" : "Show device names (grants mic permission once)"}
          </button>
        )}
        <p className="text-[11px] text-muted">This is the same setting as the Input device in Settings.</p>
      </div>
    );
  }

  const active = audio.virtualMicMode;
  const effects = audio.voiceFx[sourceKey]?.effects ?? [];

  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Voice changer</h3>
      <p className="text-xs text-muted">
        Real-time effects on your mic. They feed the virtual-mic cable, so they only take effect with
        Virtual Mic mode on.
      </p>
      {!active && (
        <p className="text-xs text-amber-300/90">
          Virtual Mic mode is off — settings are saved but won&apos;t be heard until you enable it in Settings.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Sliders size={14} className="text-accent shrink-0" />
        <span className="text-sm font-medium">Effects</span>
      </div>
      <EffectChainEditor sourceKey={sourceKey} effects={effects} audio={audio} />
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
