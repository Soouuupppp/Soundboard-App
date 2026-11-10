"use client";

// Editor for one Livepad capture (1.5.0): the shared ClipEditor for cuts and volume,
// plus reverse, tape-style speed, and baked-in FX. The decoded audio is held in RAM
// only while this is mounted; the capture itself stays a file on disk.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Globe, Lock, Sliders } from "lucide-react";
import { useAudio } from "@/components/AudioProvider";
import { ClipEditor, type ClipEdit } from "@/components/ClipEditor";
import { EffectChainBuilder } from "@/components/EffectChainBuilder";
import { FxPresetBar } from "@/components/FxPresetBar";
import { useLivepad } from "@/components/LivepadProvider";
import { Popover } from "@/components/Popover";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { TagEditor } from "@/components/Tags";
import { analytics } from "@/lib/analytics";
import { decodeAudio, encodeMp3Segments } from "@/lib/audio-edit";
import { LIVEPAD_PREVIEW_KEY, audioBufferToWav, renderCapture } from "@/lib/livepad";
import type { LivepadCapture } from "@/lib/livepad-store";
import { formatBytes } from "@/lib/utils";
import type { EffectConfig } from "@/lib/voice-fx";

const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const SPEED_STEP = 0.05;
// encodeMp3Segments' default constant bitrate, 128 kbps.
const MP3_BYTES_PER_SEC = 16000;

const FX_NAME_SUFFIX = " (FX)";
const MAX_CAPTURE_NAME = 200;

function effectCardName(name: string) {
  if (name.endsWith(FX_NAME_SUFFIX)) return name;
  return name.slice(0, MAX_CAPTURE_NAME - FX_NAME_SUFFIX.length) + FX_NAME_SUFFIX;
}

// True when the render would just reproduce the file, so nothing should be marked Edited.
function isUnchanged(edit: ClipEdit, duration: number, reverse: boolean, speed: number, effects: EffectConfig[]) {
  const whole =
    edit.segments.length === 1 && edit.segments[0].start <= 0 && edit.segments[0].end >= duration;
  return whole && edit.volume === 1 && !reverse && speed === 1 && effects.length === 0;
}

export function CaptureEditor({
  capture,
  saveMode,
  allTags,
  maxFileSize,
  onSaved,
  onClose,
  onDirtyChange,
}: {
  capture: LivepadCapture;
  // Save opens the same editor with the library fields shown.
  saveMode: boolean;
  allTags: string[];
  maxFileSize: number;
  onSaved: (soundId: string) => void;
  onClose: () => void;
  // True while replacing this editor would lose work the user has put in.
  onDirtyChange: (dirty: boolean) => void;
}) {
  const audio = useAudio();
  const livepad = useLivepad();
  const toast = useToast();
  const { getCaptureFile, getCaptureUrl, setEditingCapture } = livepad;
  const { cancelSound, playCapturePreview } = audio;

  const [loaded, setLoaded] = useState<{ buffer: AudioBuffer; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [effects, setEffects] = useState<EffectConfig[]>([]);
  const [name, setName] = useState(capture.name);
  const [tags, setTags] = useState<string[]>([]);
  const [isPublic, setIsPublic] = useState(false);
  const [triedSave, setTriedSave] = useState(false);

  const mountedRef = useRef(true);
  const previewUrlRef = useRef<string | null>(null);

  const stopPreview = useCallback(() => cancelSound(LIVEPAD_PREVIEW_KEY), [cancelSound]);

  const [clipDirty, setClipDirty] = useState(false);
  const dirty = saveMode || busy || clipDirty || reverse || speed !== 1 || effects.length > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const [fxOpen, setFxOpen] = useState(false);
  const closeFx = useCallback(() => setFxOpen(false), []);
  // ClipEditor stops Escape at the window, so Popover's own listener wouldn't see it.
  useEffect(() => {
    if (!fxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFxOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fxOpen]);

  useEffect(() => {
    mountedRef.current = true;
    setEditingCapture(capture.id);
    return () => {
      mountedRef.current = false;
      setEditingCapture(null);
      stopPreview();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, [capture.id, setEditingCapture, stopPreview]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    (async () => {
      try {
        const file = await getCaptureFile(capture);
        const [buffer, url] = await Promise.all([
          file.arrayBuffer().then(decodeAudio),
          getCaptureUrl(capture),
        ]);
        if (!cancelled) setLoaded({ buffer, url });
      } catch {
        if (cancelled) return;
        toast.error("Couldn't open that capture.");
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only a different file needs a reload, not a rename or a volume change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.id, capture.fileName]);

  // What's playing no longer matches the settings.
  useEffect(() => stopPreview(), [reverse, speed, effects, stopPreview]);

  const hasEffects = effects.length > 0;
  const applyLabel = hasEffects ? "Add new clip" : "Apply";

  const render = (edit: ClipEdit) => renderCapture(loaded!.buffer, { ...edit, reverse, speed, effects });

  const reportFailure = (e: unknown) =>
    toast.error((e as Error)?.message || "Couldn't process that capture.");

  const togglePreview = async (edit: ClipEdit) => {
    if (busy) return; // Space still reaches this while the buttons are disabled
    if (audio.playingSoundIds.has(LIVEPAD_PREVIEW_KEY)) {
      stopPreview();
      return;
    }
    setBusy(true);
    try {
      const wav = audioBufferToWav(await render(edit));
      if (!mountedRef.current) return;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = URL.createObjectURL(wav);
      playCapturePreview(previewUrlRef.current);
    } catch (e) {
      reportFailure(e);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const apply = async (edit: ClipEdit) => {
    setBusy(true);
    try {
      const result = await render(edit);
      const wav = audioBufferToWav(result);
      const fields = { durationSec: result.duration, sampleRate: result.sampleRate };
      // Effects make a new card, so the untouched original stays available.
      const name = effectCardName(capture.name);
      const ok = hasEffects
        ? await livepad.addEditedCapture(capture, wav, { ...fields, name })
        : await livepad.applyCaptureEdit(capture.id, wav, fields);
      if (ok && hasEffects) toast.success(`Added "${name}".`);
      if (ok) onClose();
    } catch (e) {
      reportFailure(e);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const save = async (edit: ClipEdit) => {
    const finalName = name.trim() || capture.name;
    const reportTooLarge = (bytes: number) =>
      toast.error(
        `That clip would be about ${formatBytes(bytes)}, over your ${formatBytes(maxFileSize)} limit. Cut it down or raise the speed.`,
      );
    // Catch the obvious case before spending time on the render. FX tails aren't
    // known yet, so the real size is checked again after encoding.
    const keptSec = edit.segments.reduce((n, s) => n + (s.end - s.start), 0);
    const estimate = (keptSec / speed) * MP3_BYTES_PER_SEC;
    if (estimate > maxFileSize) {
      reportTooLarge(estimate);
      return;
    }
    setBusy(true);
    try {
      const result = await render(edit);
      const mp3 = encodeMp3Segments({
        buffer: result,
        segments: [{ start: 0, end: result.duration }],
        volume: 1, // already baked in by the render
      });
      if (mp3.size > maxFileSize) {
        reportTooLarge(mp3.size);
        return;
      }
      const fd = new FormData();
      fd.append("file", new File([mp3], `${finalName}.mp3`, { type: "audio/mpeg" }));
      fd.append("isPublic", String(isPublic));
      fd.append("name", finalName);
      fd.append("tags", JSON.stringify(tags));
      let res: Response;
      try {
        res = await fetch("/api/sounds", { method: "POST", body: fd });
      } catch {
        toast.error("Network error during upload. Check your connection.");
        return;
      }
      if (!res.ok) {
        await toast.fromResponse(res, "Couldn't save that clip.");
        return;
      }
      const j = (await res.json()) as { sound: { id: string } };
      onSaved(j.sound.id);
      analytics.livepadSave();
      toast.success(`Saved "${finalName}" to your library.`);
      // The clip is uploaded now, so close either way: retrying would upload it twice.
      if (isUnchanged(edit, loaded!.buffer.duration, reverse, speed, effects)) {
        await livepad.markCaptureSaved(capture.id, j.sound.id, finalName);
      } else if (hasEffects) {
        await livepad.addEditedCapture(capture, audioBufferToWav(result), {
          durationSec: result.duration,
          sampleRate: result.sampleRate,
          savedSoundId: j.sound.id,
          name: finalName,
        });
      } else {
        await livepad.applyCaptureEdit(capture.id, audioBufferToWav(result), {
          durationSec: result.duration,
          sampleRate: result.sampleRate,
          savedSoundId: j.sound.id,
          name: finalName,
        });
      }
      onClose();
    } catch (e) {
      reportFailure(e);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  if (!loaded) {
    return <div className="card p-4 text-sm text-muted">Loading {capture.name}…</div>;
  }

  const missingTag = tags.length === 0;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{saveMode ? "Saving" : "Editing"} {capture.name}</h3>
      <ClipEditor
        buffer={loaded.buffer}
        objectUrl={loaded.url}
        busy={busy}
        confirmLabel={saveMode ? "Save to library" : applyLabel}
        confirmDisabled={saveMode && missingTag}
        onConfirmBlocked={() => setTriedSave(true)}
        onConfirmEdit={(edit) => void (saveMode ? save(edit) : apply(edit))}
        secondaryAction={saveMode ? { label: hasEffects ? applyLabel : "Apply only", onClick: (edit) => void apply(edit) } : undefined}
        onCancel={onClose}
        onDirtyChange={setClipDirty}
        toolbarExtra={
          <Popover
            open={fxOpen}
            onClose={closeFx}
            align="left"
            portal
            panelClassName="w-[30rem] max-w-[calc(100vw-1.5rem)] max-h-[70vh] overflow-y-auto p-3 space-y-2"
            trigger={
              <button
                type="button"
                className={`btn-ghost text-sm ${fxOpen || effects.length > 0 ? "text-accent" : ""}`}
                onClick={() => setFxOpen((o) => !o)}
                aria-expanded={fxOpen}
                title="Effects baked into this capture"
              >
                <Sliders size={14} className="mr-1" />
                Effects{effects.length > 0 ? ` (${effects.length})` : ""}
                <ChevronDown size={14} className={`ml-1 transition ${fxOpen ? "rotate-180" : ""}`} />
              </button>
            }
          >
            <FxPresetBar effects={effects} onApply={setEffects} />
            <EffectChainBuilder effects={effects} onChange={setEffects} />
          </Popover>
        }
        externalPreview={{
          playing: audio.playingSoundIds.has(LIVEPAD_PREVIEW_KEY),
          onToggle: (edit) => void togglePreview(edit),
          onStop: stopPreview,
        }}
      >
        {saveMode && (
          <div className="grid gap-4 sm:grid-cols-2 items-start">
            <label className="block text-sm">
              <span className="block text-xs text-muted mb-1">Clip name</span>
              <input
                className="input w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
              />
            </label>
            <div>
              <span className="block text-xs text-muted mb-1">
                Tags <span className="text-muted/60">(at least one required)</span>
              </span>
              <TagEditor value={tags} suggestions={allTags} onChange={setTags} invalid={triedSave && missingTag} />
              {triedSave && missingTag && (
                <p className="text-[11px] text-amber-300/80 mt-1">Add at least one tag before saving.</p>
              )}
            </div>
            <label className="flex items-center gap-3 text-sm select-none">
              <Toggle checked={isPublic} onChange={setIsPublic} label="Share this clip publicly" />
              <span className="flex items-center gap-1.5">
                {isPublic ? <Globe size={14} /> : <Lock size={14} />}
                {isPublic ? "Public" : "Private"}
              </span>
            </label>
          </div>
        )}
        <div className="flex items-center gap-x-6 gap-y-2 flex-wrap text-sm">
          <label className="flex items-center gap-2 select-none">
            <span className="text-muted">Reverse</span>
            <Toggle size="sm" checked={reverse} onChange={setReverse} label="Reverse the clip" />
          </label>
          <label className="flex items-center gap-2 flex-1 min-w-[14rem]">
            <span className="text-muted shrink-0">Speed</span>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SPEED_STEP}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="flex-1 accent-accent"
              aria-label="Playback speed"
            />
            <span className="w-12 text-right tabular-nums">{speed.toFixed(2)}x</span>
          </label>
        </div>
        <p className="text-xs text-muted">
          Speed also changes the pitch.{" "}
          {hasEffects
            ? "With effects, a new clip is added and this one stays as it is."
            : "Apply replaces this capture and can't be undone."}
        </p>
      </ClipEditor>
    </div>
  );
}
