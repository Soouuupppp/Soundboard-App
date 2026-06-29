"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, Check, X, Volume2, Scissors, RotateCcw } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { encodeMp3Segments, keepSegments, mergeRanges } from "@/lib/audio-edit";
import { useToast } from "@/components/Toast";

type Range = { start: number; end: number };

// Pre-upload editor: a wavesurfer waveform with the Regions plugin for a
// multi-segment **delete** model — you mark spans to remove and the export is
// whatever's left, concatenated. Keyboard: Space = play/pause, drag = select a
// span, Del/Backspace = delete the selected span. A default volume is baked into
// the re-encoded mp3 handed back via onConfirm. The original file is never stored.
export function ClipEditor({
  buffer,
  objectUrl,
  busy,
  confirmLabel = "Use this clip",
  confirmDisabled = false,
  onConfirmBlocked,
  onConfirm,
  onCancel,
}: {
  buffer: AudioBuffer;
  objectUrl: string;
  busy?: boolean;
  confirmLabel?: string;
  // Extra gate on the confirm button (e.g. the upload form requires a tag).
  confirmDisabled?: boolean;
  // Fired when the user clicks the confirm button while it's blocked by
  // confirmDisabled — lets the parent reveal the missing required field.
  onConfirmBlocked?: () => void;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const dur = buffer.duration;
  const toast = useToast();
  const [vol, setVol] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [encoding, setEncoding] = useState(false);
  // Deleted spans (delete model). Kept audio = complement over [0, dur].
  const [cuts, setCuts] = useState<Range[]>([]);
  const [hasSelection, setHasSelection] = useState(false);
  // Position (original-clip seconds) of the live preview cursor, or null when not
  // previewing. We draw our own cursor rather than use wavesurfer's media-element
  // playhead, because the preview plays the *edited* audio (see startPreview).
  const [previewPos, setPreviewPos] = useState<number | null>(null);
  // Index (into `cuts`) of a deleted segment the user clicked to select, so it can
  // be restored individually. `cuts` is kept merged/disjoint, so the index is stable.
  const [selectedCut, setSelectedCut] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  // The single live drag-selection region (one at a time).
  const selectionRef = useRef<{ start: number; end: number; remove: () => void } | null>(null);
  // Mirrors so the (long-lived) wavesurfer/keydown handlers read fresh values.
  const cutsRef = useRef<Range[]>([]);
  cutsRef.current = cuts;
  const volRef = useRef(1);
  volRef.current = vol;
  // Web Audio preview: the kept segments are concatenated and played through our
  // own AudioContext (sample-accurate, identical to the export) instead of seeking
  // the media element, whose mp3 seeks snap to frame boundaries and drift.
  const previewCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // --- Build the wavesurfer instance once for this clip ---
  useEffect(() => {
    if (!containerRef.current) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: objectUrl,
      height: 96,
      waveColor: "rgba(124,140,255,0.55)",
      progressColor: "rgba(124,140,255,0.9)",
      // Hide wavesurfer's own playhead — we never play its media element. Preview
      // runs through Web Audio and draws its own cursor, so the cursor always
      // matches the edited audio you actually hear.
      cursorWidth: 0,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    ws.on("ready", () => {
      setReady(true);
      // Drag across the waveform to mark a span (the live selection).
      regions.enableDragSelection({ color: "rgba(124,140,255,0.25)" });
    });

    // Keep only the most recent drag region as the active selection.
    regions.on("region-created", (region) => {
      const prev = selectionRef.current;
      if (prev && prev !== region) prev.remove();
      selectionRef.current = region;
      setHasSelection(true);
    });
    regions.on("region-updated", (region) => {
      selectionRef.current = region;
      setHasSelection(true);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      selectionRef.current = null;
    };
    // objectUrl identifies the clip; rebuild only if it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectUrl]);

  // Live-apply the default-volume slider to an in-flight preview.
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = vol;
  }, [vol]);

  // Commit the current selection to the cut list (delete that span).
  function deleteSelection() {
    const sel = selectionRef.current;
    if (!sel) return;
    const span = { start: sel.start, end: sel.end };
    sel.remove();
    selectionRef.current = null;
    setHasSelection(false);
    if (span.end > span.start) {
      setCuts((c) => mergeRanges([...c, span]));
      setSelectedCut(null);
    }
  }

  // Cancel the live drag-selection (and deselect any selected cut) without
  // deleting anything — bound to Esc.
  function clearSelection() {
    const sel = selectionRef.current;
    if (sel) {
      sel.remove();
      selectionRef.current = null;
    }
    setHasSelection(false);
    setSelectedCut(null);
  }

  // Restore a single deleted segment (drop just that cut). `cuts` stays merged, so
  // removing one element re-opens exactly that gap.
  function restoreCut(index: number) {
    setCuts((cs) => cs.filter((_, i) => i !== index));
    setSelectedCut(null);
  }

  // --- Web Audio preview of the edited result -------------------------------
  // Concatenate the kept segments and play them through our own AudioContext, so
  // what you hear is exactly what gets exported. A rAF loop maps elapsed edited
  // time back to a position on the original waveform to drive the cursor. Always
  // starts from the beginning of the kept audio (so re-pressing Preview restarts).
  function stopPreview() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const node = sourceRef.current;
    if (node) {
      node.onended = null;
      try { node.stop(); } catch {}
      try { node.disconnect(); } catch {}
      sourceRef.current = null;
    }
    gainRef.current = null;
    setPlaying(false);
    setPreviewPos(null);
  }

  function startPreview() {
    if (sourceRef.current) { stopPreview(); return; } // toggle: already playing

    const segs = keepSegments(cutsRef.current, dur);
    const sr = buffer.sampleRate;
    const chCount = buffer.numberOfChannels;
    const ranges = segs
      .map((s) => ({ a: Math.max(0, Math.floor(s.start * sr)), b: Math.min(buffer.length, Math.floor(s.end * sr)) }))
      .filter((r) => r.b > r.a);
    const total = ranges.reduce((n, r) => n + (r.b - r.a), 0);
    if (total <= 0) return;

    let ctx = previewCtxRef.current;
    if (!ctx) { ctx = new AudioContext(); previewCtxRef.current = ctx; }
    if (ctx.state === "suspended") void ctx.resume();

    // Build the kept buffer — the same concatenation the exporter does.
    const out = ctx.createBuffer(chCount, total, sr);
    for (let c = 0; c < chCount; c++) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      let off = 0;
      for (const r of ranges) {
        dst.set(src.subarray(r.a, r.b), off);
        off += r.b - r.a;
      }
    }

    const gain = ctx.createGain();
    gain.gain.value = volRef.current;
    const node = ctx.createBufferSource();
    node.buffer = out;
    node.connect(gain).connect(ctx.destination);
    gainRef.current = gain;
    sourceRef.current = node;

    const startedAt = ctx.currentTime;
    node.onended = () => { if (sourceRef.current === node) stopPreview(); };
    node.start();
    setPlaying(true);

    const tick = () => {
      const c = previewCtxRef.current;
      if (sourceRef.current !== node || !c) return;
      const elapsed = c.currentTime - startedAt;
      // Map edited elapsed time back to a position on the original waveform.
      let acc = 0;
      let orig = segs.length ? segs[segs.length - 1].end : 0;
      for (const s of segs) {
        const len = s.end - s.start;
        if (elapsed < acc + len) { orig = s.start + (elapsed - acc); break; }
        acc += len;
      }
      setPreviewPos(orig);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // Editing the cut set changes what would play — stop any in-flight preview so it
  // can't keep playing stale segments.
  useEffect(() => {
    stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuts]);

  // Tear down audio on unmount.
  useEffect(() => {
    return () => {
      stopPreview();
      previewCtxRef.current?.close().catch(() => {});
      previewCtxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Keyboard shortcuts (capture phase + stopPropagation so they don't also
  // trigger the dashboard's global play-on-keypress listener). ---
  useEffect(() => {
    if (!ready) return;
    function onKey(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const k = ev.key;
      if (k === " " || k === "Spacebar") {
        ev.preventDefault();
        ev.stopPropagation();
        startPreview();
      } else if (k === "Delete" || k === "Backspace") {
        ev.preventDefault();
        ev.stopPropagation();
        deleteSelection();
      } else if (k === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        clearSelection();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const keep = keepSegments(cuts, dur);
  const keptDur = keep.reduce((n, s) => n + (s.end - s.start), 0);
  const working = busy || encoding;
  const nothingLeft = keptDur < 0.05;

  async function confirm() {
    if (nothingLeft) return;
    setEncoding(true);
    await new Promise((r) => setTimeout(r, 0)); // let the spinner paint
    try {
      onConfirm(encodeMp3Segments({ buffer, segments: keep, volume: vol }));
    } catch {
      toast.error("Couldn't process the clip — try a shorter selection or re-importing.");
    } finally {
      setEncoding(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Scissors size={15} className="text-accent" /> Cut &amp; adjust
        </div>
        <div
          className="text-[11px] text-muted"
          title="Space: play/pause · drag across the waveform to select a span · Del: delete the selected span · click a red cut to select it, then Restore"
        >
          <kbd className="px-1">Space</kbd> play · <kbd className="px-1">drag</kbd> select ·{" "}
          <kbd className="px-1">Del</kbd> delete · <kbd className="px-1">click</kbd> a cut to restore
        </div>
      </div>

      <div className="relative">
        <div ref={containerRef} className="w-full rounded-lg bg-black/30" />
        {/* Committed cuts — red overlays. Click one to select it, then Restore to
            bring just that section back. `cuts` is kept merged, so i is a stable id. */}
        {dur > 0 &&
          cuts.map((c, i) => {
            const selected = selectedCut === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setSelectedCut((s) => (s === i ? null : i))}
                title={selected ? "Selected — press Restore to bring this section back" : "Click to select this deleted section"}
                className={`absolute inset-y-0 z-20 cursor-pointer transition ${
                  selected
                    ? "bg-red-500/40 border-x-2 border-red-300 ring-1 ring-inset ring-red-300/70"
                    : "bg-red-500/30 border-x border-red-400/60 hover:bg-red-500/45"
                }`}
                style={{ left: `${(c.start / dur) * 100}%`, width: `${((c.end - c.start) / dur) * 100}%` }}
              />
            );
          })}
        {/* Live preview cursor — driven by Web Audio playback, aligned to the
            same [0, dur] domain as the red cut overlays. */}
        {previewPos != null && dur > 0 && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-white"
            style={{ left: `${Math.min(100, Math.max(0, (previewPos / dur) * 100))}%` }}
          />
        )}
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted">Loading waveform…</div>
        )}
      </div>

      <div className="flex items-center gap-2" title={`Default volume ${Math.round(vol * 100)}%`}>
        <Volume2 size={14} className="text-muted shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={vol}
          onChange={(e) => setVol(Number(e.target.value))}
          className="flex-1 accent-accent"
          aria-label="Default volume"
        />
        <span className="text-xs text-muted w-8 text-right">{Math.round(vol * 100)}</span>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost text-sm" onClick={startPreview} disabled={working || !ready}>
            {playing ? <Pause size={15} className="mr-1" /> : <Play size={15} className="mr-1" />}
            {playing ? "Pause" : "Preview"}
          </button>
          <button
            type="button"
            className="btn-ghost text-sm disabled:opacity-50"
            onClick={deleteSelection}
            disabled={working || !hasSelection}
            title="Delete the selected span"
          >
            <Scissors size={14} className="mr-1" /> Delete span
          </button>
          {selectedCut != null && (
            <button
              type="button"
              className="btn-ghost text-sm !text-emerald-300 !border-emerald-400/30"
              onClick={() => restoreCut(selectedCut)}
              disabled={working}
              title="Bring the selected deleted section back"
            >
              <RotateCcw size={14} className="mr-1" /> Restore
            </button>
          )}
          {cuts.length > 0 && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => { setCuts([]); setSelectedCut(null); }}
              disabled={working}
              title="Undo all cuts"
            >
              Reset cuts
            </button>
          )}
        </div>
        <span className="text-xs text-muted">
          Keeping {keptDur.toFixed(2)}s of {dur.toFixed(2)}s
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost text-sm" onClick={onCancel} disabled={working}>
            <X size={15} className="mr-1" /> Cancel
          </button>
          {/* Wrapper catches clicks while the button is disabled by confirmDisabled
              (a disabled .btn has pointer-events:none) so the parent can reveal
              which required field is missing. */}
          <span onClick={() => { if (confirmDisabled && !working) onConfirmBlocked?.(); }}>
            <button type="button" className="btn-primary text-sm" onClick={confirm} disabled={working || !ready || nothingLeft || confirmDisabled}>
              <Check size={15} className="mr-1" /> {working ? "Processing…" : confirmLabel}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
