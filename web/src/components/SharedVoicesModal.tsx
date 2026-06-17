"use client";

// Browse the server-side shared AI-voice library (ver/1.4.1) — the voice parallel
// of SharedPresetsModal. Opened from the "Browse shared" button in VoicePresetBar.
// Official voices sort first with a badge; user voices show the owner's name. Apply
// loads the config into the AI section; "Save to mine" also drops a device-local
// copy so it shows in the local dropdown next time.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Star, Trash2, Download, Plus, X, Search } from "lucide-react";
import type { AiEngine } from "@/lib/audio-output";
import { addVoicePreset, type VoiceConfig } from "@/lib/voice-presets";
import { type SharedVoice, fetchSharedVoices, deleteSharedVoice } from "@/lib/shared-voices";
import { useToast } from "@/components/Toast";

const ENGINE_LABEL: Record<AiEngine, string> = {
  rvc_zero: "RVC⚡ZERO",
  elevenlabs: "ElevenLabs",
  respeecher: "Respeecher",
};

export function SharedVoicesModal({
  onApply,
  onClose,
}: {
  onApply: (engine: AiEngine, config: VoiceConfig) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<SharedVoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = async () => {
    try {
      setError(null);
      setList(await fetchSharedVoices());
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const voices = await fetchSharedVoices();
        if (!cancelled) setList(voices);
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const apply = (v: SharedVoice) => {
    if (!v.config) return toast.error("This voice's config is unavailable.");
    onApply(v.engine, v.config);
    toast.success(`Applied "${v.name}"`);
    onClose();
  };

  const saveToMine = (v: SharedVoice) => {
    if (!v.config) return;
    addVoicePreset(v.name, v.engine, v.config);
    toast.success(`Saved "${v.name}" to your voices`);
  };

  const remove = async (v: SharedVoice) => {
    const res = await deleteSharedVoice(v.id);
    if (!res.ok) return toast.fromResponse(res, "Couldn't delete voice.");
    toast.success("Voice removed");
    load();
  };

  const filtered = (list ?? []).filter(
    (v) =>
      v.name.toLowerCase().includes(q.toLowerCase()) ||
      (v.ownerName ?? "").toLowerCase().includes(q.toLowerCase())
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Shared voices"
      onClick={onClose}
    >
      <div className="card w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-lg font-bold tracking-tight">Shared voices</h2>
          <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="relative mb-3">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input !pl-8 text-sm w-full"
            placeholder="Search voices or authors…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-sm text-red-300/90">
            Couldn&apos;t load shared voices. <button className="underline" onClick={load}>Retry</button>
          </p>
        )}
        {!error && list === null && <p className="text-sm text-muted">Loading…</p>}
        {!error && list !== null && filtered.length === 0 && (
          <p className="text-sm text-muted">No shared voices yet.</p>
        )}

        <ul className="grid gap-1.5">
          {filtered.map((v) => (
            <li key={v.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {v.isOfficial && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 bg-amber-400/10 border border-amber-400/20"
                        title="Official / featured voice"
                      >
                        <Star size={10} /> Official
                      </span>
                    )}
                    <span className="font-medium text-sm truncate">{v.name}</span>
                  </div>
                  <p className="text-xs text-muted truncate">
                    {ENGINE_LABEL[v.engine] ?? v.engine}
                    {!v.isOfficial && v.ownerName && <> · by {v.ownerName}</>}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" className="btn-ghost text-xs" onClick={() => apply(v)} title="Apply to the AI voice">
                    <Download size={14} className="mr-1" /> Apply
                  </button>
                  <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => saveToMine(v)} title="Save a copy to your local voices" aria-label="Save to my voices">
                    <Plus size={14} />
                  </button>
                  {v.mine && (
                    <button
                      type="button"
                      className="btn-ghost text-xs !px-1.5 text-red-300/80 hover:text-red-300"
                      onClick={() => remove(v)}
                      title="Delete your shared voice"
                      aria-label="Delete shared voice"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
}
