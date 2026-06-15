"use client";

// Shared "save / apply preset" bar for an effect chain (1.4.0). Dropped into both
// the voice-changer EffectChainEditor and the per-clip SoundFxEditor — they pass
// the CURRENT effects array + an onApply callback that writes the cloned chain
// back to the right place (setSourceEffects / setSoundEffects). Backed by the
// shared device-local preset list (lib/fx-presets.ts).

import { useState } from "react";
import { Save, Check, X } from "lucide-react";
import { type EffectConfig } from "@/lib/voice-fx";
import { useFxPresets, addPreset, deletePreset, cloneEffects } from "@/lib/fx-presets";
import { Select } from "@/components/Select";

export function FxPresetBar({
  effects,
  onApply,
}: {
  effects: EffectConfig[];
  onApply: (effects: EffectConfig[]) => void;
}) {
  const presets = useFxPresets();
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  const selected = presets.find((p) => p.id === selectedId) ?? null;

  const apply = () => {
    if (!selected) return;
    onApply(cloneEffects(selected.effects)); // fresh ids per apply
  };
  const remove = () => {
    if (!selected) return;
    deletePreset(selected.id);
    setSelectedId("");
  };
  const confirmSave = () => {
    addPreset(name, effects);
    setName("");
    setSaving(false);
  };

  return (
    <div className="grid gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-2">
      <div className="flex items-center gap-1.5">
        <Select
          className="flex-1 !py-1.5 text-xs"
          aria-label="Apply preset"
          value={selectedId}
          placeholder="Presets…"
          onChange={setSelectedId}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
        />
        <button type="button" className="btn-ghost text-xs" onClick={apply} disabled={!selected} title="Apply preset to this chain">
          Apply
        </button>
        <button type="button" className="btn-ghost text-xs !px-1.5 text-red-300/80 hover:text-red-300 disabled:opacity-30" onClick={remove} disabled={!selected} title="Delete preset" aria-label="Delete preset">
          <X size={14} />
        </button>
      </div>

      {saving ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            className="input !py-1.5 text-xs flex-1"
            placeholder="Preset name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirmSave(); if (e.key === "Escape") { setSaving(false); setName(""); } }}
          />
          <button type="button" className="btn-ghost text-xs !px-1.5 text-emerald-300" onClick={confirmSave} title="Save" aria-label="Save preset">
            <Check size={14} />
          </button>
          <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => { setSaving(false); setName(""); }} title="Cancel" aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost text-xs self-start disabled:opacity-30"
          onClick={() => setSaving(true)}
          disabled={effects.length === 0}
          title="Save the current chain as a preset"
        >
          <Save size={14} className="mr-1" /> Save as preset…
        </button>
      )}
    </div>
  );
}
