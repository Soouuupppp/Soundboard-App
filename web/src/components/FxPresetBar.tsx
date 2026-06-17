"use client";

// Shared "save / apply preset" bar for an effect chain (1.4.0). Dropped into both
// the voice-changer EffectChainEditor and the per-clip SoundFxEditor — they pass
// the CURRENT effects array + an onApply callback that writes the cloned chain
// back to the right place (setSourceEffects / setSoundEffects). Backed by the
// shared device-local preset list (lib/fx-presets.ts).

import { useState } from "react";
import { Save, Check, X, Share2, Upload } from "lucide-react";
import { type EffectConfig } from "@/lib/voice-fx";
import { useFxPresets, addPreset, deletePreset, cloneEffects } from "@/lib/fx-presets";
import { Select } from "@/components/Select";
import { SharedPresetsModal } from "@/components/SharedPresetsModal";
import { publishSharedPreset } from "@/lib/shared-presets";
import { useToast } from "@/components/Toast";

export function FxPresetBar({
  effects,
  onApply,
}: {
  effects: EffectConfig[];
  onApply: (effects: EffectConfig[]) => void;
}) {
  const toast = useToast();
  const presets = useFxPresets();
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  // "publish" reuses the same inline name input as local save; mode tracks which.
  const [mode, setMode] = useState<"local" | "shared">("local");
  const [publishing, setPublishing] = useState(false);
  const [browsing, setBrowsing] = useState(false);

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
  const confirmSave = async () => {
    if (mode === "local") {
      addPreset(name, effects);
      setName("");
      setSaving(false);
      return;
    }
    // Publish to the shared server library.
    setPublishing(true);
    const res = await publishSharedPreset(name, effects);
    setPublishing(false);
    if (!res.ok) return toast.fromResponse(res, "Couldn't publish preset.");
    toast.success(`Published "${name.trim() || "Preset"}" to shared presets`);
    setName("");
    setSaving(false);
  };
  const beginSave = (m: "local" | "shared") => {
    setMode(m);
    setSaving(true);
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
            placeholder={mode === "shared" ? "Shared preset name" : "Preset name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirmSave(); if (e.key === "Escape") { setSaving(false); setName(""); } }}
          />
          <button type="button" className="btn-ghost text-xs !px-1.5 text-emerald-300 disabled:opacity-40" onClick={confirmSave} disabled={publishing} title={mode === "shared" ? "Publish" : "Save"} aria-label="Confirm">
            <Check size={14} />
          </button>
          <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => { setSaving(false); setName(""); }} title="Cancel" aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn-ghost text-xs disabled:opacity-30"
            onClick={() => beginSave("local")}
            disabled={effects.length === 0}
            title="Save the current chain as a local preset"
          >
            <Save size={14} className="mr-1" /> Save as preset…
          </button>
          <button
            type="button"
            className="btn-ghost text-xs disabled:opacity-30"
            onClick={() => beginSave("shared")}
            disabled={effects.length === 0}
            title="Publish the current chain to the shared library"
          >
            <Upload size={14} className="mr-1" /> Publish to shared…
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setBrowsing(true)}
            title="Browse shared presets"
          >
            <Share2 size={14} className="mr-1" /> Browse shared
          </button>
        </div>
      )}

      {browsing && (
        <SharedPresetsModal onApply={onApply} onClose={() => setBrowsing(false)} />
      )}
    </div>
  );
}
