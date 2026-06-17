"use client";

// Shared "save / apply voice" bar for the AI voice config (ver/1.4.1) — the voice
// parallel of FxPresetBar. Dropped into the AI section; it passes the CURRENT
// engine + voice config + an onApply callback that writes the chosen config back
// onto the AI section (engine + voiceId + custom/customVoiceId). Backed by the
// device-local list (lib/voice-presets) plus the server-shared library
// (lib/shared-voices).

import { useState } from "react";
import { Save, Check, X, Share2, Upload } from "lucide-react";
import type { AiEngine } from "@/lib/audio-output";
import { useVoicePresets, addVoicePreset, deleteVoicePreset, type VoiceConfig } from "@/lib/voice-presets";
import { Select } from "@/components/Select";
import { SharedVoicesModal } from "@/components/SharedVoicesModal";
import { publishSharedVoice } from "@/lib/shared-voices";
import { useToast } from "@/components/Toast";

export function VoicePresetBar({
  engine,
  config,
  onApply,
}: {
  engine: AiEngine;
  config: VoiceConfig;
  onApply: (engine: AiEngine, config: VoiceConfig) => void;
}) {
  const toast = useToast();
  const presets = useVoicePresets();
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"local" | "shared">("local");
  const [publishing, setPublishing] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const selected = presets.find((p) => p.id === selectedId) ?? null;

  const apply = () => {
    if (!selected) return;
    onApply(selected.engine, selected.config);
  };
  const remove = () => {
    if (!selected) return;
    deleteVoicePreset(selected.id);
    setSelectedId("");
  };
  const confirmSave = async () => {
    if (mode === "local") {
      addVoicePreset(name, engine, config);
      setName("");
      setSaving(false);
      return;
    }
    setPublishing(true);
    const res = await publishSharedVoice(name, engine, config);
    setPublishing(false);
    if (!res.ok) return toast.fromResponse(res, "Couldn't publish voice.");
    toast.success(`Published "${name.trim() || "Voice"}" to shared voices`);
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
          aria-label="Apply saved voice"
          value={selectedId}
          placeholder="Saved voices…"
          onChange={setSelectedId}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
        />
        <button type="button" className="btn-ghost text-xs" onClick={apply} disabled={!selected} title="Apply saved voice">
          Apply
        </button>
        <button type="button" className="btn-ghost text-xs !px-1.5 text-red-300/80 hover:text-red-300 disabled:opacity-30" onClick={remove} disabled={!selected} title="Delete saved voice" aria-label="Delete saved voice">
          <X size={14} />
        </button>
      </div>

      {saving ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            className="input !py-1.5 text-xs flex-1"
            placeholder={mode === "shared" ? "Shared voice name" : "Voice name"}
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
          <button type="button" className="btn-ghost text-xs" onClick={() => beginSave("local")} title="Save the current voice locally">
            <Save size={14} className="mr-1" /> Save voice…
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => beginSave("shared")} title="Publish the current voice to the shared library">
            <Upload size={14} className="mr-1" /> Publish to shared…
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setBrowsing(true)} title="Browse shared voices">
            <Share2 size={14} className="mr-1" /> Browse shared
          </button>
        </div>
      )}
      <p className="text-[11px] text-muted">Use only voices you have the rights to.</p>

      {browsing && <SharedVoicesModal onApply={onApply} onClose={() => setBrowsing(false)} />}
    </div>
  );
}
