"use client";

// Sound Effects modal (1.4.0) — a per-clip DSP effect chain keyed by sound id,
// backed by the device-local `soundboard:soundfx` map (audio.soundFx /
// setSoundEffects). Unlike the voice-changer chain, a per-clip chain is NOT a
// live mixer source — it's rebuilt from the saved config on every play — so ALL
// edits (add/remove/reorder/param) just persist via setSoundEffects and the next
// play (board/keybind/VR/preview) picks them up.
//
// Two entry points (both render this modal): a per-card button on each SoundCard
// (fixed soundId) and a global header picker (choose a board/saved sound first).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Sparkles, ArrowUp, ArrowDown, Plus, Play, Search } from "lucide-react";
import type { AudioOutput } from "@/lib/audio-output";
import { type EffectKind, type EffectConfig, EFFECT_DEFS, makeEffect, effectLabel } from "@/lib/voice-fx";
import { Select } from "@/components/Select";
import { FxPresetBar } from "@/components/FxPresetBar";

// The chain editor for one sound id. Every mutation rebuilds the array immutably
// and persists through setSoundEffects (no live mixer node to tweak in place).
export function SoundFxEditor({ audio, soundId }: { audio: AudioOutput; soundId: string }) {
  const effects = audio.soundFx[soundId] ?? [];
  const commit = (next: EffectConfig[]) => audio.setSoundEffects(soundId, next);

  const move = (index: number, dir: -1 | 1) => {
    const next = effects.slice();
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    commit(next);
  };
  const remove = (index: number) => commit(effects.filter((_, i) => i !== index));
  const add = (kind: EffectKind) => commit([...effects, makeEffect(kind)]);
  const setParam = (index: number, key: string, value: number) =>
    commit(effects.map((fx, i) => (i === index ? { ...fx, params: { ...fx.params, [key]: value } } : fx)));

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
      <FxPresetBar effects={effects} onApply={(fx) => commit(fx)} />
    </div>
  );
}

// Shared full-screen portal shell (overlay + Esc / click-outside close).
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="card w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// Per-card entry point: the effect editor for a single, already-known sound.
export function SoundEffectsModal({
  audio,
  soundId,
  name,
  onClose,
}: {
  audio: AudioOutput;
  soundId: string;
  name: string;
  onClose: () => void;
}) {
  return (
    <ModalShell title="Sound effects" onClose={onClose}>
      <FxEditorHeader name={name} audio={audio} soundId={soundId} onClose={onClose} />
      <SoundFxEditor audio={audio} soundId={soundId} />
    </ModalShell>
  );
}

// Header + preview/close controls shared by both modals once a sound is chosen.
function FxEditorHeader({ name, audio, soundId, onClose }: { name: string; audio: AudioOutput; soundId: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3">
      <div className="min-w-0">
        <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">Sound effects</h2>
        <p className="text-xs text-muted mt-1 break-words">{name}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => audio.play(soundId, 1, undefined, true)}
          title="Preview on the monitor device"
        >
          <Play size={14} className="mr-1" /> Preview
        </button>
        <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

type PickEntry = { soundId: string; name: string; onBoard: boolean };

// Global header entry point: pick a board/saved sound, then edit its chain.
export function SoundEffectsPickerModal({ audio, onClose }: { audio: AudioOutput; onClose: () => void }) {
  const [entries, setEntries] = useState<PickEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<PickEntry | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/board");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        // Dedupe by sound id (the saved set may reference the same sound once).
        const seen = new Set<string>();
        const list: PickEntry[] = [];
        for (const e of data.entries ?? []) {
          const id = e?.sound?.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          list.push({
            soundId: id,
            name: e?.entry?.label || e?.sound?.originalFilename || "Untitled",
            onBoard: !!e?.entry?.onBoard,
          });
        }
        list.sort((a, b) => a.name.localeCompare(b.name));
        setEntries(list);
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (chosen) {
    return (
      <ModalShell title="Sound effects" onClose={onClose}>
        <button type="button" className="btn-ghost text-xs mb-2" onClick={() => setChosen(null)}>
          ← All sounds
        </button>
        <FxEditorHeader name={chosen.name} audio={audio} soundId={chosen.soundId} onClose={onClose} />
        <SoundFxEditor audio={audio} soundId={chosen.soundId} />
      </ModalShell>
    );
  }

  const filtered = (entries ?? []).filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <ModalShell title="Sound effects" onClose={onClose}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <h2 className="text-lg font-bold tracking-tight">Sound effects</h2>
        <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <p className="text-xs text-muted mb-2">Pick a clip to add a per-clip effect chain. Effects apply to every play of that clip.</p>

      <div className="relative mb-2">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input className="input !py-1.5 text-sm w-full !pl-8" placeholder="Search sounds…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <p className="text-xs text-red-400">Couldn&apos;t load sounds: {error}</p>}
      {!entries && !error && <p className="text-xs text-muted">Loading…</p>}
      {entries && filtered.length === 0 && <p className="text-xs text-muted">No matching sounds.</p>}

      <div className="grid gap-1 max-h-[55vh] overflow-y-auto">
        {filtered.map((e) => {
          const count = (audio.soundFx[e.soundId] ?? []).length;
          return (
            <button
              key={e.soundId}
              type="button"
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2 text-left hover:bg-white/[0.05]"
              onClick={() => setChosen(e)}
            >
              <span className="truncate min-w-0 text-sm">{e.name}</span>
              {e.onBoard && <span className="chip text-[10px] shrink-0">Board</span>}
              {count > 0 && (
                <span className="ml-auto chip !border-accent/30 !bg-accent/10 !text-accent text-[10px] shrink-0">
                  {count} fx
                </span>
              )}
            </button>
          );
        })}
      </div>
    </ModalShell>
  );
}
