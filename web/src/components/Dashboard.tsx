"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Play, Trash2, Upload, Keyboard, Globe, Lock, Volume2, Settings, X, Square, Mic, ChevronDown } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { useAudioOutput } from "@/lib/audio-output";

type Sound = {
  id: string;
  name: string;
  sizeBytes: number;
  isPublic: boolean;
  ownerId: string;
};
type Entry = {
  entry: { id: string; soundId: string; label: string | null; keybind: string | null; position: number };
  sound: Sound;
  ownerName: string | null;
};
type Limits = { maxFileSize: number; maxTotalStorage: number };

export function Dashboard({
  limits,
  used: initialUsed,
  user,
}: {
  limits: Limits;
  used: number;
  user: { name: string; role: string | null };
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [used, setUsed] = useState(initialUsed);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [b, s] = await Promise.all([
      fetch("/api/board").then((r) => r.json()),
      fetch("/api/sounds").then((r) => r.json()),
    ]);
    setEntries(b.entries ?? []);
    setUsed(s.used ?? 0);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // --- Per-entry volume (persisted in localStorage) ---
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem("soundboard:volumes");
      if (raw) setVolumes(JSON.parse(raw));
    } catch {}
  }, []);
  // --- Audio playback (allows overlap: new Audio per trigger) ---
  const audio = useAudioOutput();
  const { play: audioPlay, updateEntryVolume } = audio;
  const setVolume = useCallback((entryId: string, v: number) => {
    setVolumes((prev) => {
      const next = { ...prev, [entryId]: v };
      try { localStorage.setItem("soundboard:volumes", JSON.stringify(next)); } catch {}
      return next;
    });
    updateEntryVolume(entryId, v);
  }, [updateEntryVolume]);

  const playEntry = useCallback((entryId: string, soundId: string) => {
    audioPlay(soundId, volumes[entryId] ?? 1, entryId);
  }, [audioPlay, volumes]);

  // --- In-browser keybind capture and listener ---
  const keybindByCombo = useMemo(() => {
    const map = new Map<string, { entryId: string; soundId: string }>(); // combo -> entry
    for (const e of entries) {
      if (e.entry.keybind) map.set(normalizeCombo(e.entry.keybind), { entryId: e.entry.id, soundId: e.sound.id });
    }
    return map;
  }, [entries]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (capturingFor) return; // don't trigger while capturing
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const combo = comboFromEvent(ev);
      const hit = keybindByCombo.get(combo);
      if (hit) {
        ev.preventDefault();
        playEntry(hit.entryId, hit.soundId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keybindByCombo, capturingFor, playEntry]);

  // Listen for OS-level global shortcut events forwarded by the Electron preload.
  useEffect(() => {
    function onGlobal(ev: Event) {
      const detail = (ev as CustomEvent<{ combo: string }>).detail;
      const hit = keybindByCombo.get(normalizeCombo(detail.combo));
      if (hit) playEntry(hit.entryId, hit.soundId);
    }
    window.addEventListener("soundboard:globalKey", onGlobal as EventListener);
    return () => window.removeEventListener("soundboard:globalKey", onGlobal as EventListener);
  }, [keybindByCombo, playEntry]);

  // Tell the Electron host (if any) which keybinds to register globally.
  useEffect(() => {
    const api = (window as unknown as { soundboard?: { registerKeybinds?: (combos: string[]) => void } }).soundboard;
    if (api?.registerKeybinds) {
      api.registerKeybinds([...keybindByCombo.keys()]);
    }
  }, [keybindByCombo]);

  // --- Upload ---
  const fileRef = useRef<HTMLInputElement>(null);
  const [makePublic, setMakePublic] = useState(false);

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    if (f.size > limits.maxFileSize) {
      setErr(`File too large. Max ${formatBytes(limits.maxFileSize)}.`);
      return;
    }
    setBusy(true);
    const fd = new FormData();
    fd.append("file", f);
    fd.append("isPublic", String(makePublic));
    const res = await fetch("/api/sounds", { method: "POST", body: fd });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Upload failed");
      return;
    }
    if (fileRef.current) fileRef.current.value = "";
    refresh();
  }

  async function setKeybind(entryId: string, combo: string | null) {
    await fetch(`/api/board/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keybind: combo }),
    });
    refresh();
  }

  async function removeEntry(entryId: string) {
    await fetch(`/api/board/${entryId}`, { method: "DELETE" });
    refresh();
  }

  async function deleteSound(soundId: string) {
    if (!confirm("Delete this sound? It will be removed from every board.")) return;
    await fetch(`/api/sounds/${soundId}`, { method: "DELETE" });
    refresh();
  }

  async function togglePublic(soundId: string, next: boolean) {
    await fetch(`/api/sounds/${soundId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic: next }),
    });
    refresh();
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Hey, {user.name.split(" ")[0]} 👋
        </h1>
        <p className="text-muted mt-1">Trigger your sounds, organize your board, and tweak playback.</p>
      </div>

      <ControlPanel audio={audio} />
      <section className="card">
        <div className="flex flex-wrap gap-6 items-end">
          <div className="flex-1 min-w-[240px]">
            <h2 className="font-semibold mb-1 flex items-center gap-2">Storage</h2>
            <p className="text-sm text-muted">
              <span className="text-white font-medium">{formatBytes(used)}</span>
              <span className="mx-1">/</span>
              {formatBytes(limits.maxTotalStorage)} used
              <span className="ml-3 chip">Max per file: {formatBytes(limits.maxFileSize)}</span>
            </p>
            <div className="w-full h-2 bg-white/[0.06] rounded-full mt-3 overflow-hidden">
              <div
                className="h-full bg-accent-grad transition-[width] duration-500"
                style={{ width: `${Math.min(100, (used / limits.maxTotalStorage) * 100)}%` }}
              />
            </div>
          </div>
          <form onSubmit={onUpload} className="flex flex-wrap items-center gap-2 ml-auto">
            <input ref={fileRef} type="file" accept="audio/mpeg,.mp3" className="input max-w-xs file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white file:text-xs" />
            <label className="text-sm flex items-center gap-2 chip !text-white">
              <input type="checkbox" checked={makePublic} onChange={(e) => setMakePublic(e.target.checked)} />
              Public
            </label>
            <button className="btn-primary" disabled={busy}>
              <Upload size={16} className="mr-1" /> {busy ? "Uploading…" : "Upload"}
            </button>
          </form>
        </div>
        {err && <p className="text-red-300 text-sm mt-3">{err}</p>}
      </section>

      <section>
        <h2 className="section-title mb-4">Your board</h2>
        {entries.length === 0 ? (
          <p className="text-muted">No sounds yet. Upload one above or browse the public list.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {entries.map((e) => (
              <SoundCard
                key={e.entry.id}
                entry={e}
                isOwner={e.sound.ownerId === e.entry.soundId /* not used */}
                capturing={capturingFor === e.entry.id}
                isPlaying={audio.playingSoundIds.has(e.sound.id)}
                onPlay={() => playEntry(e.entry.id, e.sound.id)}
                onCancel={() => audio.cancelSound(e.sound.id)}
                volume={volumes[e.entry.id] ?? 1}
                onVolumeChange={(v) => setVolume(e.entry.id, v)}
                onCaptureStart={() => setCapturingFor(e.entry.id)}
                onCaptureCancel={() => setCapturingFor(null)}
                onCaptured={(combo) => {
                  setCapturingFor(null);
                  setKeybind(e.entry.id, combo);
                }}
                onClearKey={() => setKeybind(e.entry.id, null)}
                onRemove={() => removeEntry(e.entry.id)}
                onDeleteSound={() => deleteSound(e.sound.id)}
                onTogglePublic={(next) => togglePublic(e.sound.id, next)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SoundCard(props: {
  entry: Entry;
  isOwner: boolean;
  capturing: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onCancel: () => void;
  onCaptureStart: () => void;
  onCaptureCancel: () => void;
  onCaptured: (combo: string) => void;
  onClearKey: () => void;
  onRemove: () => void;
  onDeleteSound: () => void;
  onTogglePublic: (next: boolean) => void;
  volume: number;
  onVolumeChange: (v: number) => void;
}) {
  const { entry, capturing } = props;
  const { sound, ownerName } = entry;

  // Capture next keypress
  useEffect(() => {
    if (!capturing) return;
    function onKey(ev: KeyboardEvent) {
      ev.preventDefault();
      if (ev.key === "Escape") {
        props.onCaptureCancel();
        return;
      }
      // Ignore modifier-only presses
      if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) return;
      const combo = comboFromEvent(ev);
      const risk = comboRisk(combo);
      if (risk) {
        const ok = window.confirm(
          `"${combo}" ${risk}\n\n` +
            `It still won't block other apps (we listen passively), but every ` +
            `time you press it the soundboard will fire too. Use it anyway?`
        );
        if (!ok) {
          props.onCaptureCancel();
          return;
        }
      }
      props.onCaptured(combo);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, props]);

  return (
    <div className="card flex flex-col gap-2">
      <div className="flex">
        <button
          className="btn-primary flex-1 text-left rounded-r-none min-w-0"
          onClick={props.onPlay}
        >
          <Play size={16} className="mr-1 shrink-0" />
          <span className="truncate">{entry.entry.label || sound.name}</span>
        </button>
        {props.isPlaying && (
          <button
            className="btn-primary rounded-l-none border-l border-black/30 px-2"
            onClick={(e) => { e.stopPropagation(); props.onCancel(); }}
            title="Stop all instances of this clip"
            aria-label="Stop clip"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="text-xs text-muted truncate">by {ownerName ?? "unknown"}</div>

      <div className="flex items-center gap-2 mt-1">
        <button
          className="btn-ghost flex-1 text-xs"
          onClick={capturing ? props.onCaptureCancel : props.onCaptureStart}
          title="Click then press a key combination"
        >
          <Keyboard size={14} className="mr-1" />
          {capturing ? "Press keys…" : entry.entry.keybind || "Set keybind"}
        </button>
        {entry.entry.keybind && !capturing && (
          <button className="btn-ghost text-xs" onClick={props.onClearKey} title="Clear">×</button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-1" title={`Volume ${Math.round(props.volume * 100)}%`}>
        <Volume2 size={14} className="text-muted shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={props.volume}
          onChange={(e) => props.onVolumeChange(Number(e.target.value))}
          className="flex-1 accent-accent"
          aria-label="Volume"
        />
        <span className="text-xs text-muted w-8 text-right">{Math.round(props.volume * 100)}</span>
      </div>

      <div className="flex items-center justify-between mt-1">
        <button
          className="btn-ghost text-xs"
          onClick={() => props.onTogglePublic(!sound.isPublic)}
          title="Toggle public"
        >
          {sound.isPublic ? <Globe size={14} /> : <Lock size={14} />}
          <span className="ml-1">{sound.isPublic ? "Public" : "Private"}</span>
        </button>
        <div className="flex gap-1">
          <button className="btn-ghost text-xs" onClick={props.onRemove} title="Remove from board">
            Remove
          </button>
          <button className="btn-danger text-xs" onClick={props.onDeleteSound} title="Delete the file">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ControlPanel({ audio }: { audio: ReturnType<typeof useAudioOutput> }) {
  const [open, setOpen] = useState(true);
  const labelsHidden = audio.devices.some((d) => !d.label);

  return (
    <section className="card">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-left min-w-0"
          aria-expanded={open}
        >
          <Settings size={16} />
          <h2 className="font-semibold">Control Panel</h2>
          <ChevronDown
            size={16}
            className={`text-muted transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          />
        </button>
        <button
          className="btn-ghost text-xs ml-auto disabled:opacity-50"
          onClick={() => audio.cancelAll()}
          disabled={!audio.anyPlaying}
          title="Stop every sound that's currently playing"
        >
          <Square size={14} className="mr-1" />
          Cancel all sounds
        </button>
      </div>

      <Collapsible open={open}>
        <div className="space-y-3 mt-3">
          <Section title="Output & volume" icon={<Volume2 size={15} className="text-muted shrink-0" />}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm block mb-1">Output device</label>
                {audio.supportsSinkId ? (
                  <>
                    <select
                      className="input w-full"
                      value={audio.deviceId}
                      onChange={(e) => audio.setDeviceId(e.target.value)}
                    >
                      <option value="default">System default</option>
                      {audio.devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                        </option>
                      ))}
                    </select>
                    {labelsHidden && (
                      <button
                        type="button"
                        className="btn-ghost text-xs mt-2"
                        onClick={() => audio.requestLabelsPermission()}
                      >
                        Show device names (grants mic permission once)
                      </button>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted">
                    This browser doesn&apos;t support per-element output selection. Use OS audio settings.
                  </p>
                )}
                <p className="text-xs text-muted mt-1">
                  {audio.virtualMicMode
                    ? "In Virtual Mic mode this is the cable the soundboard + mics feed into — pick its recording side as your mic in-game."
                    : "Where the soundboard plays so you can hear it."}
                </p>
              </div>
              <div>
                <label className="text-sm block mb-1" title={`Master volume ${Math.round(audio.masterVolume * 100)}%`}>
                  Master volume
                </label>
                <div className="flex items-center gap-2">
                  <Volume2 size={14} className="text-muted shrink-0" />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={audio.masterVolume}
                    onChange={(e) => audio.setMasterVolume(Number(e.target.value))}
                    className="flex-1 accent-accent"
                    aria-label="Master volume"
                  />
                  <span className="text-xs text-muted w-8 text-right">
                    {Math.round(audio.masterVolume * 100)}
                  </span>
                </div>
                <p className="text-xs text-muted mt-2">Applied on top of each sound&apos;s per-button volume.</p>
              </div>
            </div>
          </Section>

          {audio.supportsSinkId && (
            <Section
              title="Virtual Mic mode"
              icon={<Mic size={15} className="text-muted shrink-0" />}
              right={
                <Toggle
                  checked={audio.virtualMicMode}
                  onChange={audio.setVirtualMicMode}
                  label="Toggle Virtual Mic mode"
                />
              }
            >
              <VirtualMicPanel audio={audio} />
            </Section>
          )}
        </div>
      </Collapsible>
    </section>
  );
}

// Animated show/hide using a 0fr↔1fr grid row (no fixed height needed).
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid transition-all duration-200 ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

// A collapsible control-panel section with a chevron header. An optional `right`
// node (e.g. a toggle) sits outside the header button so it doesn't collapse.
function Section({
  title,
  icon,
  right,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-white/10 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          aria-expanded={open}
        >
          <ChevronDown
            size={14}
            className={`text-muted shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          />
          {icon}
          <span className="font-semibold text-sm truncate">{title}</span>
        </button>
        {right}
      </div>
      <Collapsible open={open}>
        <div className="pt-3">{children}</div>
      </Collapsible>
    </div>
  );
}

// The slide toggle switch.
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
        checked ? "bg-accent" : "bg-white/15"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function VirtualMicPanel({ audio }: { audio: ReturnType<typeof useAudioOutput> }) {
  const on = audio.virtualMicMode;
  const labelsHidden =
    audio.inputDevices.length === 0 || audio.inputDevices.some((d) => !d.label);

  // The lines actually going through the virtual mic right now — these are the
  // only things the monitor lets you tick on/off.
  const monitorLines: { key: string; label: string }[] = [
    { key: audio.soundboardKey, label: "Soundboard" },
    ...audio.inputDevices
      .filter((d) => audio.inputs.find((i) => i.deviceId === d.deviceId)?.enabled)
      .map((d) => ({ key: d.deviceId, label: d.label || `Capture ${d.deviceId.slice(0, 6)}` })),
  ];

  return (
    <div>
      <p className="text-xs text-muted">
        Mix your capture devices (mics, virtual cables, GoXLR buses) and the soundboard into a
        virtual audio cable, then pick that cable as your mic in-game. Choose a monitor device to
        also hear it locally.
      </p>

      {!audio.supportsContextSink && on && (
        <p className="text-xs text-red-400 mt-2">
          This build can&apos;t route Web Audio to a specific device (needs Chromium 110+).
        </p>
      )}
      {audio.mixerError && on && (
        <p className="text-xs text-red-400 mt-2">Mixer error: {audio.mixerError}</p>
      )}

      <Collapsible open={on}>
        <div className="space-y-5 pt-3">
          {!audio.secureContext && (
            <p className="text-xs text-red-400">
              Microphone access needs a secure context (HTTPS or localhost). Your server URL is
              plain HTTP, so the browser blocks mic capture.
            </p>
          )}
          {labelsHidden && (
            <div>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => audio.requestLabelsPermission()}
              >
                Show device names (grants mic permission once)
              </button>
              {audio.labelsError && (
                <p className="text-xs text-red-400 mt-1">Couldn&apos;t access mic: {audio.labelsError}</p>
              )}
            </div>
          )}

          <div>
            <label className="text-sm block">Sources → virtual mic</label>
            <p className="text-xs text-muted mb-2">
              Every capture device Windows reports — mics, plus virtual cables (VB-Audio,
              VoiceMeeter) and GoXLR buses (e.g. Broadcast Stream Mix) whose recording side shows up
              here. Tick what the game should hear. To route an app&apos;s audio in, send it to a
              cable / GoXLR bus in Windows and it&apos;ll appear in this list.
            </p>
            <DeviceLineList
              emptyLabel="No capture devices detected."
              fallbackName="Capture"
              devices={audio.inputDevices}
              isOn={(id) => audio.inputs.find((i) => i.deviceId === id)?.enabled ?? false}
              volumeOf={(id) => audio.inputs.find((i) => i.deviceId === id)?.volume ?? 1}
              onToggle={audio.setInputEnabled}
              onVolume={audio.setInputVolume}
            />
          </div>

          <div>
            <label className="text-sm block mb-1">Monitor</label>
            <select
              className="input w-full"
              value={audio.monitorDeviceId}
              onChange={(e) => audio.setMonitorDeviceId(e.target.value)}
            >
              <option value="default">System default</option>
              {audio.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1 mb-2">
              The device you hear locally. Tick which of the live mic lines to monitor — your mic is
              off by default so you don&apos;t echo yourself.
            </p>
            <div className="space-y-1.5">
              {monitorLines.map((line) => (
                <label key={line.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={audio.monitored.includes(line.key)}
                    onChange={(e) => audio.setMonitored(line.key, e.target.checked)}
                  />
                  <span className="truncate" title={line.label}>{line.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Collapsible>
    </div>
  );
}

function DeviceLineList({
  emptyLabel,
  fallbackName,
  devices,
  isOn,
  volumeOf,
  onToggle,
  onVolume,
}: {
  emptyLabel: string;
  fallbackName: string;
  devices: MediaDeviceInfo[];
  isOn: (deviceId: string) => boolean;
  volumeOf: (deviceId: string) => number;
  onToggle: (deviceId: string, enabled: boolean) => void;
  onVolume: (deviceId: string, volume: number) => void;
}) {
  return (
    <>
      {devices.length === 0 ? (
        <p className="text-xs text-muted">{emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {devices.map((d) => {
            const enabled = isOn(d.deviceId);
            const vol = volumeOf(d.deviceId);
            return (
              <div key={d.deviceId} className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm w-1/2 min-w-0">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => onToggle(d.deviceId, e.target.checked)}
                  />
                  <span className="truncate" title={d.label || d.deviceId}>
                    {d.label || `${fallbackName} ${d.deviceId.slice(0, 6)}`}
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={vol}
                  disabled={!enabled}
                  onChange={(e) => onVolume(d.deviceId, Number(e.target.value))}
                  className="flex-1 accent-accent disabled:opacity-40"
                  aria-label={`Volume for ${d.label || d.deviceId}`}
                />
                <span className="text-xs text-muted w-8 text-right">
                  {Math.round(vol * 100)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// --- Key combo helpers ---

function comboFromEvent(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.ctrlKey) parts.push("Ctrl");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.metaKey) parts.push("Meta");
  let key = ev.key;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

function normalizeCombo(s: string): string {
  return s
    .split("+")
    .map((p) => p.trim())
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join("+");
}

// Returns a short human description of *why* a combo is risky, or null if it's
// safe. "Risky" = no modifier and the main key is something the user almost
// certainly uses for normal typing or system shortcuts.
const SYSTEM_KEYS = new Set([
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);
function comboRisk(combo: string): string | null {
  const parts = combo.split("+").map((p) => p.trim());
  const hasModifier = parts.some((p) => p === "Ctrl" || p === "Alt" || p === "Shift" || p === "Meta");
  if (hasModifier) return null;
  const main = parts[parts.length - 1];
  if (!main) return null;
  if (/^[A-Za-z0-9]$/.test(main)) {
    return `is just a normal typing key — it'll trigger every time you type "${main}".`;
  }
  if (SYSTEM_KEYS.has(main)) {
    return `is a system key — most apps use it for navigation or editing.`;
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(main)) {
    return `is a plain function key — apps like browsers and editors use these too.`;
  }
  return null;
}
