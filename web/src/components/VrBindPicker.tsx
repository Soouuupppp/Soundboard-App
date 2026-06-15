"use client";

// VrBindPicker (1.4.0 follow-up) — the full-screen drag-flow controller-bind
// builder, lifted out of Dashboard so it can be opened from any page (the header
// Voice-changer popover, cancel-all, per-entry cards). Depends only on
// lib/vr-bind.ts + the shared Select + lucide. Renders into <body> via a portal.

import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { createPortal } from "react-dom";
import { Gamepad2, X, Plus, Check } from "lucide-react";
import { Select, type SelectOption } from "@/components/Select";
import {
  VrBindPreview,
  parseVrBind,
  serializeVrBind,
  applyHolds,
  bindHolds,
  formatVrAction,
  vrInputsByHand,
  HOLD_PRESETS_SEC,
  MAX_HOLD_MS,
  parseToken,
  MAX_STEPS,
  MAX_ACTIONS_PER_STEP,
  type VrEdge,
  type VrAction,
  type VrStep,
  type VrBind,
  type VrBindMode,
  type VrProfile,
  type VrPreviewProgress,
} from "@/lib/vr-bind";

// A removable action chip inside the bind builder / a committed step.
function VrActionChip({ a, onRemove }: { a: VrAction; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/15 px-2 py-1 text-xs whitespace-nowrap">
      {formatVrAction(a)}
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted hover:text-white" aria-label="Remove action">
          <X size={12} />
        </button>
      )}
    </span>
  );
}

// One palette entry: a press (↓) / release (↑) pair for a single input. Each is
// drag-and-droppable into the builder's current-step zone, and click-to-add as a
// fallback. The edge arrow distinguishes down from up.
function VrPaletteRow({ input, onAdd }: { input: string; onAdd: (a: VrAction) => void }) {
  const p = parseToken(input);
  const dragHandlers = (edge: VrEdge) => ({
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ input, edge }));
      e.dataTransfer.effectAllowed = "copy";
    },
  });
  const btn =
    "rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs hover:bg-white/[0.09] active:scale-95 cursor-grab transition";
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1">
      <span className="truncate text-xs text-muted">{p?.key ?? input}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" className={btn} title="Press (down)" onClick={() => onAdd({ input, edge: "down" })} {...dragHandlers("down")}>
          ↓
        </button>
        <button type="button" className={btn} title="Release (up)" onClick={() => onAdd({ input, edge: "up" })} {...dragHandlers("up")}>
          ↑
        </button>
      </span>
    </div>
  );
}

// Controller-bind editor — a full-screen drag-flow builder. Palette of all 32
// actions (16 inputs × press/release) at the top; drag (or click) them into the
// builder's "current step" group. In Sequence mode "Add as next step" commits a
// group and starts the next, building an ordered combo; Simultaneous mode is a
// single group held together. A live test area shows progress as you physically
// perform the bind. Persists the serialized VrBind via onConfirm (see
// lib/vr-bind.ts).
export function VrBindPicker({
  initial,
  initialHolds = null,
  vrConnected,
  profile = "index",
  onCancel,
  onConfirm,
}: {
  initial: string | null;
  // Device-local per-action min-holds aligned to `initial`'s steps (or null).
  initialHolds?: number[][] | null;
  vrConnected: boolean;
  profile?: VrProfile;
  onCancel: () => void;
  onConfirm: (serialized: string, holds: number[][]) => void;
}) {
  // Seed the builder from any existing bind: earlier steps become committed,
  // the last step stays editable as the "current" group. Stored min-holds (a
  // runtime-only field) are re-attached so re-opening the editor preserves them.
  const seedBase = initial ? parseVrBind(initial) : null;
  const seed = seedBase ? applyHolds(seedBase, initialHolds) : null;
  const [mode, setMode] = useState<VrBindMode>(seed?.mode ?? "simul");
  const [steps, setSteps] = useState<VrStep[]>(seed ? seed.steps.slice(0, -1) : []);
  const [current, setCurrent] = useState<VrStep>(seed ? seed.steps[seed.steps.length - 1] : []);
  const [dragOver, setDragOver] = useState(false);

  const allSteps: VrStep[] = [...steps, ...(current.length ? [current] : [])];
  const totalActions = allSteps.reduce((n, s) => n + s.length, 0);
  const canSave = totalActions > 0;
  const bind: VrBind = { mode, steps: allSteps };
  const previewKey = canSave ? serializeVrBind(bind) : "";
  // serializeVrBind drops holdMs, so track the hold matrix separately to keep the
  // live preview's gate in sync as holds change.
  const holdsKey = canSave ? JSON.stringify(bindHolds(bind)) : "";

  // --- builder ops ---
  const addToCurrent = (a: VrAction) =>
    setCurrent((prev) => {
      if (prev.some((x) => x.input === a.input && x.edge === a.edge)) return prev;
      if (prev.length >= MAX_ACTIONS_PER_STEP) return prev;
      return [...prev, a];
    });
  const removeCurrent = (i: number) => setCurrent((c) => c.filter((_, idx) => idx !== i));
  const removeFromStep = (si: number, ai: number) =>
    setSteps((s) => s.map((st, idx) => (idx === si ? st.filter((_, j) => j !== ai) : st)).filter((st) => st.length));
  // Set/clear a down-action's min-hold (ms). `si` indexes allSteps: committed
  // steps first, then the editable current group.
  const withHold = (a: VrAction, ms: number): VrAction =>
    ms > 0 ? { input: a.input, edge: a.edge, holdMs: ms } : { input: a.input, edge: a.edge };
  const setHold = (si: number, ai: number, ms: number) => {
    if (si < steps.length) {
      setSteps((s) => s.map((st, i) => (i === si ? st.map((a, j) => (j === ai ? withHold(a, ms) : a)) : st)));
    } else {
      setCurrent((c) => c.map((a, j) => (j === ai ? withHold(a, ms) : a)));
    }
  };
  const commitStep = () => {
    if (!current.length || steps.length >= MAX_STEPS - 1) return;
    setSteps((s) => [...s, current]);
    setCurrent([]);
  };
  const clearAll = () => {
    setSteps([]);
    setCurrent([]);
  };
  const switchMode = (next: VrBindMode) => {
    if (next === mode) return;
    if (next === "simul") {
      // Flatten every action into the single group (dedupe, cap respected).
      const merged: VrStep = [];
      for (const a of [...steps.flat(), ...current]) {
        if (merged.length >= MAX_ACTIONS_PER_STEP) break;
        if (!merged.some((x) => x.input === a.input && x.edge === a.edge)) merged.push(a);
      }
      setSteps([]);
      setCurrent(merged);
    }
    setMode(next);
  };

  // --- live test/preview ---
  const previewRef = useRef<VrBindPreview | null>(null);
  if (!previewRef.current) previewRef.current = new VrBindPreview(bind);
  const [progress, setProgress] = useState<VrPreviewProgress | null>(null);
  const [fired, setFired] = useState(false);
  const firedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const parsed = previewKey ? parseVrBind(previewKey) : null;
    const b = parsed ? applyHolds(parsed, holdsKey ? (JSON.parse(holdsKey) as number[][]) : null) : null;
    previewRef.current!.setBind(b ?? { mode: "simul", steps: [] });
    setProgress(b ? previewRef.current!.snapshot() : null);
  }, [previewKey, holdsKey]);

  useEffect(() => {
    function onVrInput(ev: Event) {
      const d = (ev as CustomEvent<{ token: string; pressed: boolean }>).detail;
      if (!d?.token) return;
      const p = previewRef.current!.feed(d.token, d.pressed ? "down" : "up", performance.now());
      setProgress(p);
      if (p.justFired) {
        setFired(true);
        window.clearTimeout(firedTimer.current);
        firedTimer.current = window.setTimeout(() => {
          setFired(false);
          setProgress(previewRef.current!.snapshot());
        }, 900);
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onCancel();
    }
    window.addEventListener("soundboard:vrInput", onVrInput as EventListener);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("soundboard:vrInput", onVrInput as EventListener);
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(firedTimer.current);
    };
  }, [onCancel]);

  const onDropCurrent = (e: ReactDragEvent) => {
    e.preventDefault();
    setDragOver(false);
    try {
      const a = JSON.parse(e.dataTransfer.getData("text/plain")) as VrAction;
      if (a && typeof a.input === "string" && (a.edge === "down" || a.edge === "up")) addToCurrent(a);
    } catch {
      /* not one of our drags */
    }
  };

  // Render a committed (read-only-ish) step group with per-action removal.
  const StepGroup = ({ step, onRemoveAction }: { step: VrStep; onRemoveAction: (ai: number) => void }) => (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1.5">
      {step.map((a, ai) => (
        <VrActionChip key={ai} a={a} onRemove={() => onRemoveAction(ai)} />
      ))}
    </div>
  );

  // Portal to <body>: the card ancestor uses backdrop-filter (.glass), which
  // creates a containing block for position:fixed — without the portal the modal
  // is trapped inside the card grid instead of covering the viewport.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Controller bind editor"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-3xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header + mode toggle */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
              <Gamepad2 size={18} /> Controller bind
            </h2>
            <p className="text-xs text-muted mt-1">
              Drag actions into the bar below (or click them).{" "}
              {!vrConnected && "SteamVR isn’t detected — you can still build the bind now."}
            </p>
          </div>
          <button type="button" className="btn-ghost !px-2" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 mb-4 text-xs">
          {(["simul", "seq"] as VrBindMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`rounded-md px-3 py-1 transition ${
                mode === m ? "bg-accent/20 text-white" : "text-muted hover:text-white"
              }`}
            >
              {m === "simul" ? "Simultaneous" : "Sequence"}
            </button>
          ))}
          <span className="self-center px-2 text-[11px] text-muted/70">
            {mode === "simul" ? "hold together" : "in order, step by step"}
          </span>
        </div>

        {/* Palette */}
        <div className="grid grid-cols-2 gap-3">
          {vrInputsByHand(profile).map((group) => (
            <div key={group.hand} className="flex flex-col gap-1">
              <div className="px-0.5 text-[11px] font-medium text-muted">{group.label}</div>
              {group.inputs.map((input) => (
                <VrPaletteRow key={input} input={input} onAdd={addToCurrent} />
              ))}
            </div>
          ))}
        </div>

        {/* Builder bar */}
        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted/70">Bind</div>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-2">
            {steps.map((step, si) => (
              <div key={si} className="flex items-center gap-2">
                <StepGroup step={step} onRemoveAction={(ai) => removeFromStep(si, ai)} />
                <span className="text-muted/60">→</span>
              </div>
            ))}

            {/* Current-step drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDropCurrent}
              className={`flex min-h-[2.75rem] min-w-[10rem] flex-1 flex-wrap items-center gap-1 rounded-lg border-2 border-dashed p-1.5 transition ${
                dragOver ? "border-accent/70 bg-accent/10" : "border-white/15 bg-white/[0.02]"
              }`}
            >
              {current.length === 0 && (
                <span className="px-1 text-xs text-muted/60">
                  {steps.length ? "Drop the next step’s actions here" : "Drag or click actions to add them"}
                </span>
              )}
              {current.map((a, i) => (
                <VrActionChip key={i} a={a} onRemove={() => removeCurrent(i)} />
              ))}
            </div>

            {mode === "seq" && (
              <button
                type="button"
                className="btn-ghost text-xs whitespace-nowrap"
                onClick={commitStep}
                disabled={!current.length || steps.length >= MAX_STEPS - 1}
                title="Commit this group and start the next step"
              >
                <Plus size={14} className="mr-1" /> Add as next step
              </button>
            )}
          </div>
        </div>

        {/* Per-action min-hold. Only down-edge actions can carry a hold — it
            latches on release once the button has been held >= the duration. */}
        {allSteps.some((step) => step.some((a) => a.edge === "down")) && (
          <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted/70">
              Minimum hold (optional)
            </div>
            <div className="flex flex-col gap-1.5">
              {allSteps.flatMap((step, si) =>
                step
                  .map((a, ai) => ({ a, ai }))
                  .filter(({ a }) => a.edge === "down")
                  .map(({ a, ai }) => (
                    <div key={`${si}-${ai}`} className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted min-w-0">
                        {mode === "seq" && allSteps.length > 1 && (
                          <span className="text-[10px] text-muted/60">Step {si + 1}</span>
                        )}
                        <span className="rounded bg-black/25 px-1.5 py-0.5 text-[11px] whitespace-nowrap">
                          {formatVrAction(a)}
                        </span>
                      </span>
                      <HoldControl ms={a.holdMs ?? 0} onChange={(ms) => setHold(si, ai, ms)} />
                    </div>
                  )),
              )}
            </div>
          </div>
        )}

        {/* Live test / preview */}
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted/70">Test it</span>
            {fired ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                <Check size={13} /> Matched!
              </span>
            ) : (
              <span className="text-[11px] text-muted/60">
                {vrConnected ? "perform the bind to verify" : "connect SteamVR to test"}
              </span>
            )}
          </div>
          {progress && canSave ? (
            <div className="flex flex-wrap items-center gap-2">
              {allSteps.map((step, si) => (
                <div key={si} className="flex items-center gap-2">
                  <div
                    className={`flex flex-wrap items-center gap-1 rounded-lg border p-1.5 transition ${
                      si === progress.stepIdx && !fired
                        ? "border-accent/70 bg-accent/10"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    {step.map((a, ai) => {
                      const ok = progress.satisfied[si]?.[ai];
                      return (
                        <span
                          key={ai}
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap transition ${
                            ok ? "bg-emerald-500/25 text-emerald-200" : "bg-black/25 text-muted"
                          }`}
                        >
                          {formatVrAction(a)}
                        </span>
                      );
                    })}
                  </div>
                  {si < allSteps.length - 1 && <span className="text-muted/60">→</span>}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted/60">Add at least one action to build a bind.</span>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between">
          <button type="button" className="btn-ghost text-xs" onClick={clearAll} disabled={!canSave}>
            Clear
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost text-sm" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={() => onConfirm(serializeVrBind(bind), bindHolds(bind))}
              disabled={!canSave}
            >
              Save bind
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Per-action min-hold picker: presets + "Other…" → a custom seconds input
// (capped below the step timeout). ms === 0 means no hold.
function HoldControl({ ms, onChange }: { ms: number; onChange: (ms: number) => void }) {
  const presetMs = HOLD_PRESETS_SEC.map((s) => Math.round(s * 1000));
  const matchesPreset = ms > 0 && presetMs.includes(ms);
  const [otherOpen, setOtherOpen] = useState(ms > 0 && !matchesPreset);
  const value = otherOpen ? "other" : matchesPreset ? String(ms) : "0";
  const options: SelectOption[] = [
    { value: "0", label: "No hold" },
    ...HOLD_PRESETS_SEC.map((s) => ({ value: String(Math.round(s * 1000)), label: `${s}s` })),
    { value: "other", label: "Other…" },
  ];
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Select
        value={value}
        onChange={(v) => {
          if (v === "other") {
            setOtherOpen(true);
          } else {
            setOtherOpen(false);
            onChange(Number(v));
          }
        }}
        options={options}
        className="!py-1 text-xs"
        aria-label="Minimum hold duration"
      />
      {otherOpen && (
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0.1}
            max={MAX_HOLD_MS / 1000}
            step={0.1}
            value={ms > 0 ? ms / 1000 : ""}
            onChange={(e) => {
              const sec = Number(e.target.value);
              if (!Number.isFinite(sec) || sec <= 0) return onChange(0);
              onChange(Math.min(Math.round(sec * 1000), MAX_HOLD_MS));
            }}
            className="input !py-1 w-16 text-xs"
            aria-label="Custom hold seconds"
          />
          <span className="text-[10px] text-muted/60">s</span>
        </div>
      )}
    </div>
  );
}
