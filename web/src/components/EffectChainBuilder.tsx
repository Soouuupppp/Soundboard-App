"use client";

// Controlled, OFFLINE effect-chain editor (ver/1.4.1) — operates on a plain
// EffectConfig[] + onChange, with no live mixer node. Used by the admin "Presets"
// tab to author official presets. (The voice-changer popover keeps its own
// EffectChainEditor in VoiceChangerPanel, which uses the live no-rebuild param
// path `updateSourceEffectParams`; that behavior matters for live audio, so this
// is a sibling rather than a refactor of it.)

import { Sparkles, X, ArrowUp, ArrowDown, Plus } from "lucide-react";
import { type EffectKind, type EffectConfig, EFFECT_DEFS, makeEffect, effectLabel } from "@/lib/voice-fx";
import { Select } from "@/components/Select";

export function EffectChainBuilder({
  effects,
  onChange,
}: {
  effects: EffectConfig[];
  onChange: (effects: EffectConfig[]) => void;
}) {
  const move = (index: number, dir: -1 | 1) => {
    const next = effects.slice();
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    onChange(next);
  };
  const remove = (index: number) => onChange(effects.filter((_, i) => i !== index));
  const add = (kind: EffectKind) => onChange([...effects, makeEffect(kind)]);
  const setParam = (index: number, key: string, value: number) =>
    onChange(effects.map((fx, i) => (i === index ? { ...fx, params: { ...fx.params, [key]: value } } : fx)));

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
                    onChange={(e) => setParam(i, p.key, Number(e.target.value))}
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
        aria-label="Add effect"
        value=""
        placeholder={<span className="inline-flex items-center gap-1"><Plus size={12} /> Add effect…</span>}
        onChange={(v) => add(v as EffectKind)}
        options={EFFECT_DEFS.map((d) => ({ value: d.kind, label: d.label }))}
      />
    </div>
  );
}
