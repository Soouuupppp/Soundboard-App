"use client";

// Browse the server-side shared DSP-preset library (ver/1.4.1). Opened from the
// "Browse shared" button in FxPresetBar (so both effect editors get it). Official
// presets sort first with a badge; user presets show the owner's display name.
// Apply clones the chain into the working editor; "Save to mine" also drops a
// device-local copy (lib/fx-presets) so it shows in the local dropdown next time.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Star, Trash2, Download, Plus, X, Search } from "lucide-react";
import { type EffectConfig, effectLabel } from "@/lib/voice-fx";
import { addPreset, cloneEffects } from "@/lib/fx-presets";
import {
  type SharedPreset,
  fetchSharedPresets,
  deleteSharedPreset,
} from "@/lib/shared-presets";
import { useToast } from "@/components/Toast";

export function SharedPresetsModal({
  onApply,
  onClose,
}: {
  onApply: (effects: EffectConfig[]) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<SharedPreset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = async () => {
    try {
      setError(null);
      setList(await fetchSharedPresets());
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const presets = await fetchSharedPresets();
        if (!cancelled) setList(presets);
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

  const apply = (p: SharedPreset) => {
    onApply(cloneEffects(p.effects)); // fresh ids
    toast.success(`Applied "${p.name}"`);
    onClose();
  };

  const saveToMine = (p: SharedPreset) => {
    addPreset(p.name, p.effects); // cloneEffects happens inside addPreset
    toast.success(`Saved "${p.name}" to your presets`);
  };

  const remove = async (p: SharedPreset) => {
    const res = await deleteSharedPreset(p.id);
    if (!res.ok) return toast.fromResponse(res, "Couldn't delete preset.");
    toast.success("Preset removed");
    load();
  };

  const filtered = (list ?? []).filter(
    (p) =>
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      (p.ownerName ?? "").toLowerCase().includes(q.toLowerCase())
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Shared presets"
      onClick={onClose}
    >
      <div className="card w-full max-w-lg max-h-[92vh] overflow-y-auto overflow-x-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-lg font-bold tracking-tight">Shared presets</h2>
          <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="relative mb-3">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input !pl-8 text-sm w-full"
            placeholder="Search presets or authors…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-sm text-red-300/90">
            Couldn&apos;t load shared presets. <button className="underline" onClick={load}>Retry</button>
          </p>
        )}
        {!error && list === null && <p className="text-sm text-muted">Loading…</p>}
        {!error && list !== null && filtered.length === 0 && (
          <p className="text-sm text-muted">No shared presets yet.</p>
        )}

        <ul className="grid gap-1.5">
          {filtered.map((p) => (
            <li key={p.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {p.isOfficial && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 bg-amber-400/10 border border-amber-400/20"
                        title="Official / featured preset"
                      >
                        <Star size={10} /> Official
                      </span>
                    )}
                    <span className="font-medium text-sm truncate">{p.name}</span>
                  </div>
                  <p className="text-xs text-muted truncate">
                    {p.effects.length} effect{p.effects.length === 1 ? "" : "s"}
                    {p.effects.length > 0 && <> · {p.effects.map((e) => effectLabel(e.kind)).join(", ")}</>}
                    {!p.isOfficial && p.ownerName && <> · by {p.ownerName}</>}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" className="btn-ghost text-xs" onClick={() => apply(p)} title="Apply to the current chain">
                    <Download size={14} className="mr-1" /> Apply
                  </button>
                  <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => saveToMine(p)} title="Save a copy to your local presets" aria-label="Save to my presets">
                    <Plus size={14} />
                  </button>
                  {p.mine && (
                    <button
                      type="button"
                      className="btn-ghost text-xs !px-1.5 text-red-300/80 hover:text-red-300"
                      onClick={() => remove(p)}
                      title="Delete your shared preset"
                      aria-label="Delete shared preset"
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
