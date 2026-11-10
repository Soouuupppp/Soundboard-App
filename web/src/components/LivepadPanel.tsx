"use client";

// The Livepad dashboard tab (1.5.0): pick a capture line, arm it, and snapshot the
// last X seconds into a grid of temp cards. All the state lives in LivepadProvider,
// so this can unmount freely; leaving the tab only drops the open editor.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Circle, Gamepad2, Info, Keyboard, Pencil, Play, Radio, Save, Square, Trash2, Volume2 } from "lucide-react";
import { useAudio } from "@/components/AudioProvider";
import { CaptureEditor } from "@/components/CaptureEditor";
import { useLivepad, useLivepadBinds } from "@/components/LivepadProvider";
import { Select } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { VrBindChips } from "@/components/VrBindChips";
import { useVr } from "@/components/VrProvider";
import { getProfileBind, setProfileBind } from "@/lib/vr-bind";
import { formatBytes } from "@/lib/utils";
import {
  LIVEPAD_MAX_LENGTH_SEC,
  LIVEPAD_MIN_LENGTH_SEC,
  formatClipDuration,
  livepadPlaybackKey,
} from "@/lib/livepad";
import { livepadStoreSupported, type LivepadCapture } from "@/lib/livepad-store";
import { isNativeDeviceId, nativeSourceId } from "@/lib/livepad-native";

const MB = 1024 * 1024;
const LIMIT_OPTIONS = [50, 100, 250, 500, 1024, 2048, 5120].map((mb) => ({
  value: String(mb * MB),
  label: formatBytes(mb * MB),
}));

// Outside the component so a capture is only auto-opened once: closing its editor and
// leaving the tab doesn't bring it back, but a hotkey capture made elsewhere still opens.
let lastAutoOpenedAt = 0;

export function LivepadPanel({
  canUpload,
  allTags,
  maxFileSize,
  onSaved,
}: {
  canUpload: boolean;
  allTags: string[];
  maxFileSize: number;
  onSaved: (soundId: string) => void;
}) {
  const audio = useAudio();
  const livepad = useLivepad();
  const [editing, setEditing] = useState<{ id: string; save: boolean } | null>(null);
  // Looked up live, so deleting the open card closes its editor.
  const editingCapture = livepad.captures.find((c) => c.id === editing?.id) ?? null;

  // Show the newest capture's waveform, unless that would discard work in progress.
  const editorDirtyRef = useRef(false);
  const onEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
  }, []);
  const newest = livepad.captures[0];
  useEffect(() => {
    if (!newest || newest.createdAt <= lastAutoOpenedAt) return;
    lastAutoOpenedAt = newest.createdAt;
    if (!editorDirtyRef.current) setEditing({ id: newest.id, save: false });
  }, [newest]);

  const { setSourcePickerOpen } = livepad;
  useEffect(() => {
    setSourcePickerOpen(true);
    return () => setSourcePickerOpen(false);
  }, [setSourcePickerOpen]);

  if (!audio.supportsContextSink || !livepadStoreSupported()) {
    return (
      <div className="card p-4 text-sm text-muted">
        Livepad needs a Chromium browser (version 110 or newer) or the desktop app, because it
        relies on audio routing and private file storage that this browser doesn&apos;t provide.
      </div>
    );
  }

  const hasLabels = audio.inputDevices.some((d) => !!d.label);
  const native = livepad.nativeAvailable;
  const sourceOptions: { value: string; label: string; group?: string }[] = [
    ...livepad.nativeSources.apps.map((s) => ({ value: nativeSourceId(s.key), label: s.name, group: "Apps" })),
    ...livepad.nativeSources.devices.map((s) => ({
      value: nativeSourceId(s.key),
      label: s.default ? `${s.name} (default)` : s.name,
      group: "Playback devices",
    })),
    ...audio.inputDevices.map((d, i) => ({
      value: d.deviceId,
      label: d.label || `Input ${i + 1}`,
      group: native ? "Recording devices" : undefined,
    })),
  ];
  // A lost source drops off the list but is still what Livepad is waiting for.
  if (livepad.armedNativeName && !sourceOptions.some((o) => o.value === livepad.sourceId)) {
    sourceOptions.unshift({
      value: livepad.sourceId,
      label: `${livepad.armedNativeName} (not running)`,
      group: isNativeDeviceId(livepad.sourceId) ? "Playback devices" : "Apps",
    });
  }
  const waiting = livepad.armed && !!livepad.waitingFor;
  const sourceHelp = `${
    native
      ? "Livepad records one source at a time. Apps appear here once they've made sound. A playback device records everything playing on it."
      : "Livepad records one capture device. To capture just a game or a voice chat, send that app to a virtual cable or GoXLR bus in Windows, then pick the cable here."
  } Captures are temporary and are deleted when you close the app.`;

  const clearAll = () => {
    if (window.confirm("Delete every Livepad capture? This can't be undone.")) void livepad.clearCaptures();
  };

  return (
    <div className="space-y-4">
      <div className="card p-3 space-y-2.5">
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
          <div className="basis-[30rem] min-w-[14rem] text-sm">
            <Select
              aria-label="Livepad audio source"
              value={livepad.sourceId}
              onChange={livepad.setSourceId}
              options={sourceOptions}
              placeholder={native ? "Pick an app or device…" : "Pick a capture device…"}
            />
          </div>
          <label className="flex flex-1 min-w-[12rem] items-center gap-2 text-sm" title="How much audio each capture keeps">
            <span className="text-muted">Length</span>
            <input
              type="range"
              min={LIVEPAD_MIN_LENGTH_SEC}
              max={LIVEPAD_MAX_LENGTH_SEC}
              step={1}
              value={livepad.lengthSec}
              onChange={(e) => livepad.setLengthSec(Number(e.target.value))}
              className="flex-1 min-w-0 accent-accent"
              aria-label="Capture length in seconds"
            />
            <span className="w-9 text-right tabular-nums">{livepad.lengthSec}s</span>
          </label>
          <label className="flex items-center gap-2 text-sm select-none">
            {waiting ? (
              <Circle size={12} className="text-amber-400" />
            ) : livepad.armed ? (
              <Circle size={12} className="text-red-500 fill-red-500 animate-pulse" />
            ) : (
              <Circle size={12} className="text-muted" />
            )}
            <span className={waiting ? "text-amber-300" : livepad.armed ? "" : "text-muted"}>
              {waiting ? `Waiting for ${livepad.waitingFor}` : livepad.armed ? "Recording" : livepad.arming ? "Starting…" : "Off"}
            </span>
            <Toggle
              checked={livepad.armed}
              onChange={livepad.setArmed}
              label="Toggle Livepad recording"
              disabled={livepad.arming || (!livepad.sourceId && !livepad.armed)}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={!livepad.armed}
            onClick={() => void livepad.capture()}
            title={livepad.armed ? undefined : "Turn recording on first"}
          >
            <Radio size={16} className="mr-1.5" />
            Capture last {livepad.lengthSec}s
          </button>
        </div>

        {!hasLabels && audio.inputDevices.length > 0 && (
          <button type="button" className="btn-ghost text-xs" onClick={() => void audio.requestLabelsPermission()}>
            Show device names
          </button>
        )}

        {livepad.selfCaptureRisk && (
          <p className="flex items-start gap-2 text-xs text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {isNativeDeviceId(livepad.sourceId)
                ? "This playback device looks like your output or monitor, so captures will include your own soundboard clips."
                : "This source may be on the same device as your output or monitor. If it is, captures will include your own soundboard."}
            </span>
          </p>
        )}

        <div className="flex items-center justify-between gap-x-4 gap-y-2 flex-wrap text-sm">
          <CaptureBindRow />
          <div className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-xs text-muted">Temp {formatBytes(livepad.usedBytes)} of</span>
            <Select
              className="!py-1 text-xs min-w-[6rem]"
              aria-label="Livepad temp storage limit"
              value={String(livepad.maxBytes)}
              onChange={(v) => livepad.setMaxBytes(Number(v))}
              options={LIMIT_OPTIONS}
            />
            {livepad.captures.length > 0 && (
              <button type="button" className="btn-ghost whitespace-nowrap text-xs !py-1 !px-2" onClick={clearAll}>
                Clear all
              </button>
            )}
            <span className="text-muted" title={sourceHelp} role="img" aria-label={sourceHelp}>
              <Info size={14} />
            </span>
          </div>
        </div>

        {native && !livepad.perAppSupported && (
          <p className="text-xs text-muted">
            Recording individual apps isn&apos;t available on this version of Windows. It needs
            Windows 10 version 2004 or newer. Playback and recording devices still work.
          </p>
        )}
      </div>

      {editingCapture && (
        <CaptureEditor
          key={editingCapture.id}
          capture={editingCapture}
          saveMode={!!editing?.save}
          allTags={allTags}
          maxFileSize={maxFileSize}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
          onDirtyChange={onEditorDirtyChange}
        />
      )}

      {livepad.captures.length === 0 ? (
        <p className="text-sm text-muted">No captures yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
          {livepad.captures.map((c) => (
            <LivepadCard
              key={c.id}
              capture={c}
              playing={audio.playingSoundIds.has(livepadPlaybackKey(c.id))}
              canUpload={canUpload}
              onEdit={() => setEditing({ id: c.id, save: false })}
              onSave={() => setEditing({ id: c.id, save: true })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Keyboard + controller bind setup for the capture trigger, plus the chime switch.
function CaptureBindRow() {
  const binds = useLivepadBinds();
  const { controllerProfile, hasDesktop } = useVr();
  const profileBind = getProfileBind(binds.controllerBind, controllerProfile);
  return (
    <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-sm">
      <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-white/10 bg-white/[0.03] p-1">
        <span className="text-xs text-muted px-1">Capture hotkey</span>
        <button
          type="button"
          className={`btn-ghost text-xs !py-1 !px-2 ${binds.capturingKey ? "text-accent" : ""}`}
          onClick={() => binds.setCapturingKey(!binds.capturingKey)}
          title="Set a keyboard hotkey for capturing"
        >
          <Keyboard size={14} className="mr-1" />
          {binds.capturingKey ? "Hold keys…" : binds.keybind || "Set keybind"}
        </button>
        {binds.keybind && !binds.capturingKey && (
          <button
            type="button"
            className="btn-ghost text-xs !py-1 !px-1.5"
            onClick={() => binds.setKeybind(null)}
            aria-label="Clear capture keybind"
          >
            ×
          </button>
        )}
        {hasDesktop && (
          <>
            <span className="h-4 w-px bg-white/10" aria-hidden />
            <button
              type="button"
              className="btn-ghost text-xs !py-1 !px-2"
              onClick={() => binds.setCapturingVr(true)}
              title="Set a controller bind for capturing"
            >
              <Gamepad2 size={14} className="mr-1" />
              {profileBind ? <VrBindChips value={profileBind} /> : "Set controller"}
            </button>
            {profileBind && (
              <button
                type="button"
                className="btn-ghost text-xs !py-1 !px-1.5"
                onClick={() => binds.setControllerBind(setProfileBind(binds.controllerBind, controllerProfile, null))}
                aria-label="Clear capture controller bind"
              >
                ×
              </button>
            )}
          </>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted select-none">
        Chime
        <Toggle size="sm" checked={binds.chimeEnabled} onChange={binds.setChimeEnabled} label="Toggle capture chime" />
      </label>
    </div>
  );
}

function LivepadCard({
  capture,
  playing,
  canUpload,
  onEdit,
  onSave,
}: {
  capture: LivepadCapture;
  playing: boolean;
  canUpload: boolean;
  onEdit: () => void;
  onSave: () => void;
}) {
  const livepad = useLivepad();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(capture.name);

  const commitRename = () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== capture.name) void livepad.renameCapture(capture.id, name);
    else setDraft(capture.name);
  };

  const when = new Date(capture.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary !p-2 shrink-0"
          aria-label={playing ? `Stop ${capture.name}` : `Play ${capture.name}`}
          onClick={() => (playing ? livepad.stopCapture(capture.id) : void livepad.playCapture(capture))}
        >
          {playing ? <Square size={14} /> : <Play size={14} />}
        </button>
        {renaming ? (
          <input
            autoFocus
            className="input !py-1 text-sm min-w-0 flex-1"
            value={draft}
            maxLength={200}
            aria-label="Capture name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(capture.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-accent"
            title="Rename"
            onClick={() => {
              setDraft(capture.name);
              setRenaming(true);
            }}
          >
            {capture.name}
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted">
        <span className="tabular-nums">{formatClipDuration(capture.durationSec)}</span>
        <span>·</span>
        <span className="tabular-nums">{when}</span>
        {capture.edited && <span className="chip !py-0">Edited</span>}
        {capture.savedSoundId && <span className="chip !py-0 text-emerald-300">Saved</span>}
      </div>

      <label className="flex items-center gap-2">
        <Volume2 size={14} className="text-muted shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={capture.volume}
          onChange={(e) => livepad.setCaptureVolume(capture.id, Number(e.target.value))}
          className="flex-1 min-w-0 accent-accent"
          aria-label={`Volume for ${capture.name}`}
        />
      </label>

      <div className="flex items-center gap-1">
        <button type="button" className="btn-ghost !px-2 !py-1 text-xs flex-1" onClick={onEdit}>
          <Pencil size={12} className="mr-1" />
          Edit
        </button>
        <button
          type="button"
          className="btn-ghost !px-2 !py-1 text-xs flex-1"
          onClick={onSave}
          disabled={!canUpload}
          title={canUpload ? undefined : "Your account can't upload sounds, so captures can't be saved."}
        >
          <Save size={12} className="mr-1" />
          Save
        </button>
        <button
          type="button"
          className="btn-ghost !px-2 !py-1 text-xs"
          aria-label={`Delete ${capture.name}`}
          onClick={() => void livepad.removeCapture(capture.id)}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}