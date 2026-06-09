"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Play, Trash2, Upload, Keyboard, Globe, Lock, Volume2, Settings, X, Square, Mic, ChevronDown, Youtube } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { useAudioOutput } from "@/lib/audio-output";

type Sound = {
  id: string;
  name: string;
  originalFilename: string;
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
  canUpload,
  user,
  yt,
}: {
  limits: Limits;
  canUpload: boolean;
  user: { name: string; role: string | null };
  yt: { enabled: boolean; maxDurationSec: number };
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  // Which "add a sound" panel is open below the button group (null = collapsed).
  const [addTab, setAddTab] = useState<"upload" | "youtube" | null>(null);

  const refresh = useCallback(async () => {
    const b = await fetch("/api/board").then((r) => r.json());
    setEntries(b.entries ?? []);
    // Let the nav-bar storage meter refetch its usage.
    window.dispatchEvent(new CustomEvent("soundboard:storage-changed"));
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

  // --- Keybind enable state (persisted in localStorage, this device only) ---
  // `keybindsEnabled` is the master switch; `keybindEnabled[entryId]` is the
  // per-clip switch (missing = on). A clip's keybind fires only when both are on.
  const [keybindsEnabled, setKeybindsEnabledState] = useState(true);
  const [keybindEnabled, setKeybindEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const g = localStorage.getItem("soundboard:keybindsEnabled");
      if (g != null) setKeybindsEnabledState(g === "true");
      const raw = localStorage.getItem("soundboard:keybindEnabled");
      if (raw) setKeybindEnabled(JSON.parse(raw));
    } catch {}
  }, []);
  const setKeybindsEnabled = useCallback((on: boolean) => {
    setKeybindsEnabledState(on);
    try { localStorage.setItem("soundboard:keybindsEnabled", String(on)); } catch {}
  }, []);
  const toggleEntryKeybind = useCallback((entryId: string, on: boolean) => {
    setKeybindEnabled((prev) => {
      const next = { ...prev, [entryId]: on };
      try { localStorage.setItem("soundboard:keybindEnabled", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // --- In-browser keybind capture and listener ---
  // The map drives the in-app listener, the Electron global-key handler, and the
  // Electron registration call below — so gating it here disables a keybind
  // everywhere at once. Disabled keybinds (global off, or per-clip off) are omitted.
  const keybindByCombo = useMemo(() => {
    const map = new Map<string, { entryId: string; soundId: string }>(); // combo -> entry
    if (!keybindsEnabled) return map;
    for (const e of entries) {
      if (e.entry.keybind && keybindEnabled[e.entry.id] !== false) {
        map.set(normalizeCombo(e.entry.keybind), { entryId: e.entry.id, soundId: e.sound.id });
      }
    }
    return map;
  }, [entries, keybindsEnabled, keybindEnabled]);

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
  const [clipName, setClipName] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);

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
    // Blank name → server falls back to the filename (sans .mp3).
    const name = clipName.trim();
    if (name) fd.append("name", name);
    const res = await fetch("/api/sounds", { method: "POST", body: fd });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Upload failed");
      return;
    }
    if (fileRef.current) fileRef.current.value = "";
    setClipName("");
    setFileName(null);
    setMakePublic(false);
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

      {!canUpload ? (
        <section className="card flex items-start gap-3">
          <Lock size={16} className="text-muted mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold">Uploading is limited</h2>
            <p className="text-sm text-muted mt-1">
              Your account isn&apos;t whitelisted for uploads yet. You can still{" "}
              <Link href="/public" className="text-accent hover:underline">
                browse public sounds
              </Link>{" "}
              and add them to your board.
            </p>
          </div>
        </section>
      ) : (
      <section className="card">
        <div className="flex gap-2">
          <AddTabButton
            icon={<Upload size={18} />}
            label="Upload a sound"
            active={addTab === "upload"}
            onClick={() => setAddTab((t) => (t === "upload" ? null : "upload"))}
          />
          {yt.enabled && (
            <AddTabButton
              icon={<Youtube size={18} />}
              label="Import from YouTube"
              active={addTab === "youtube"}
              onClick={() => setAddTab((t) => (t === "youtube" ? null : "youtube"))}
            />
          )}
        </div>
        <Collapsible open={addTab !== null}>
          <div className="mt-4 pt-4 border-t border-white/10">
            {addTab === "upload" && (
              <>
                <p className="text-sm text-muted mb-4">
                  Add an .mp3 to your board. Give it a name, or we&apos;ll use the file name.
                </p>
                <form onSubmit={onUpload} className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-xs text-muted mb-1">Audio file</span>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/mpeg,.mp3"
                      onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                      className="input w-full file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white file:text-xs"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs text-muted mb-1">Clip name</span>
                    <input
                      className="input w-full"
                      value={clipName}
                      onChange={(e) => setClipName(e.target.value)}
                      placeholder={fileName ? fileName.replace(/\.mp3$/i, "") : "My epic clip"}
                      maxLength={200}
                    />
                  </label>
                  <div className="flex items-center justify-between gap-4 sm:col-span-2">
                    <label className="flex items-center gap-3 text-sm select-none">
                      <Toggle
                        checked={makePublic}
                        onChange={setMakePublic}
                        label="Share this clip publicly"
                      />
                      <span className="flex items-center gap-1.5">
                        {makePublic ? <Globe size={14} /> : <Lock size={14} />}
                        {makePublic ? "Public — others can find and add it" : "Private — only you can use it"}
                      </span>
                    </label>
                    <button className="btn-primary" disabled={busy}>
                      <Upload size={16} className="mr-1" /> {busy ? "Uploading…" : "Upload"}
                    </button>
                  </div>
                </form>
                {err && <p className="text-red-300 text-sm mt-3">{err}</p>}
              </>
            )}
            {addTab === "youtube" && yt.enabled && (
              <YouTubeImport maxDurationSec={yt.maxDurationSec} onImported={refresh} />
            )}
          </div>
        </Collapsible>
      </section>
      )}

      <section>
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <h2 className="section-title">Your board</h2>
          <label className="flex items-center gap-2.5 text-sm select-none" title="When off, no keybinds trigger playback (in-app or global hotkeys)">
            <Keyboard size={15} className={keybindsEnabled ? "text-accent" : "text-muted"} />
            <span className={keybindsEnabled ? "" : "text-muted"}>
              Keybinds {keybindsEnabled ? "on" : "off"}
            </span>
            <Toggle
              checked={keybindsEnabled}
              onChange={setKeybindsEnabled}
              label="Toggle all keybinds"
            />
          </label>
        </div>
        {entries.length === 0 ? (
          <p className="text-muted">
            No sounds yet. {canUpload ? "Upload one above or browse" : "Browse"} the public list.
          </p>
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
                keybindsGloballyEnabled={keybindsEnabled}
                keybindEnabled={keybindEnabled[e.entry.id] !== false}
                onToggleKeybind={(on) => toggleEntryKeybind(e.entry.id, on)}
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

// One segment of the "add a sound" button group. Pressed = its panel is shown
// in the shared content area below the group.
function AddTabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 flex items-center justify-center gap-2 rounded-xl border px-4 py-3 font-medium transition ${
        active
          ? "border-accent bg-accent/10 text-white"
          : "border-white/10 text-muted hover:bg-white/5 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Paste a YouTube link → server fetches, trims, and transcodes it to an mp3 as
// a background job. We enqueue, then poll the job until it's done or errors.
function YouTubeImport({
  maxDurationSec,
  onImported,
}: {
  maxDurationSec: number;
  onImported: () => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [makePublic, setMakePublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cancel any in-flight poll loop if the component unmounts.
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  async function poll(jobId: string) {
    // ~3 min ceiling at 2s intervals; the server caps each job at 180s anyway.
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled.current) return;
      const res = await fetch(`/api/sounds/youtube/${jobId}`);
      if (!res.ok) {
        setErr("Lost track of the conversion. Refresh and check your board.");
        setBusy(false);
        return;
      }
      const j = await res.json();
      if (j.status === "done") {
        setBusy(false);
        setUrl("");
        setName("");
        setMakePublic(false);
        onImported();
        return;
      }
      if (j.status === "error") {
        setErr(j.error ?? "Conversion failed");
        setBusy(false);
        return;
      }
    }
    setErr("Conversion is taking too long. Check your board in a moment.");
    setBusy(false);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (!url.trim()) return;
    setBusy(true);
    const res = await fetch("/api/sounds/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.trim(),
        isPublic: makePublic,
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Couldn't start the conversion");
      setBusy(false);
      return;
    }
    const { jobId } = await res.json();
    poll(jobId);
  }

  return (
    <>
      <p className="text-sm text-muted mb-4">
        Paste a YouTube link and we&apos;ll turn it into a clip on your board. Audio is trimmed to
        the first {formatDuration(maxDurationSec)}.
      </p>
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-muted mb-1">YouTube link</span>
          <input
            className="input w-full"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            inputMode="url"
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">Clip name</span>
          <input
            className="input w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Defaults to the video title"
            maxLength={200}
            disabled={busy}
          />
        </label>
        <div className="flex items-center justify-between gap-4 sm:col-span-2">
          <label className="flex items-center gap-3 text-sm select-none">
            <Toggle checked={makePublic} onChange={setMakePublic} label="Share this clip publicly" />
            <span className="flex items-center gap-1.5">
              {makePublic ? <Globe size={14} /> : <Lock size={14} />}
              {makePublic ? "Public — others can find and add it" : "Private — only you can use it"}
            </span>
          </label>
          <button className="btn-primary" disabled={busy}>
            <Youtube size={16} className="mr-1" /> {busy ? "Converting…" : "Import"}
          </button>
        </div>
      </form>
      {busy && (
        <p className="text-muted text-sm mt-3">
          Fetching and converting — this can take up to a couple of minutes. You can keep using the
          board.
        </p>
      )}
      {err && <p className="text-red-300 text-sm mt-3">{err}</p>}
    </>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} seconds`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m} minute${m > 1 ? "s" : ""}` : `${m}m ${s}s`;
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
  keybindsGloballyEnabled: boolean;
  keybindEnabled: boolean;
  onToggleKeybind: (on: boolean) => void;
}) {
  const { entry, capturing } = props;
  const { sound, ownerName } = entry;
  const hasKeybind = !!entry.entry.keybind;

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
      <div className="text-xs text-muted truncate" title={sound.originalFilename}>
        {sound.originalFilename}
      </div>
      <div className="text-[11px] text-muted/70 truncate">by {ownerName ?? "unknown"}</div>

      <div className="flex items-center gap-2 mt-1">
        {hasKeybind && !capturing && (
          <Toggle
            size="sm"
            checked={props.keybindEnabled}
            disabled={!props.keybindsGloballyEnabled}
            onChange={props.onToggleKeybind}
            label={`Toggle keybind for ${entry.entry.label || sound.name}`}
          />
        )}
        <button
          className="btn-ghost flex-1 text-xs min-w-0"
          onClick={capturing ? props.onCaptureCancel : props.onCaptureStart}
          title={
            hasKeybind && !props.keybindsGloballyEnabled
              ? "Keybinds are globally off"
              : hasKeybind && !props.keybindEnabled
                ? "This keybind is off"
                : "Click then press a key combination"
          }
        >
          <Keyboard size={14} className="mr-1 shrink-0" />
          <span
            className={`truncate ${
              hasKeybind && (!props.keybindEnabled || !props.keybindsGloballyEnabled)
                ? "line-through text-muted"
                : ""
            }`}
          >
            {capturing ? "Press keys…" : entry.entry.keybind || "Set keybind"}
          </span>
        </button>
        {hasKeybind && !capturing && (
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

// The slide toggle switch. `size="sm"` is a compact variant for tight spots
// like sound cards. `disabled` dims it and blocks interaction.
function Toggle({
  checked,
  onChange,
  label,
  size = "md",
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  size?: "md" | "sm";
  disabled?: boolean;
}) {
  const sm = size === "sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
        sm ? "h-5 w-9" : "h-6 w-11"
      } ${checked ? "bg-accent" : "bg-white/15"}`}
    >
      <span
        className={`inline-block transform rounded-full bg-white shadow transition-transform duration-200 ${
          sm
            ? `h-3.5 w-3.5 ${checked ? "translate-x-[18px]" : "translate-x-1"}`
            : `h-4 w-4 ${checked ? "translate-x-6" : "translate-x-1"}`
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
          <PeakMeter getPeak={audio.getCablePeak} active={on} />
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

// Live meter of the cable sum (what the virtual mic sends). Polls the mixer's
// pre-limiter peak each frame with a short peak-hold decay. Red = past 0 dBFS
// (the limiter is clamping it); amber = into the limiter threshold (-1 dBFS).
function PeakMeter({ getPeak, active }: { getPeak: () => number; active: boolean }) {
  const [level, setLevel] = useState(0);
  const heldRef = useRef(0);

  useEffect(() => {
    if (!active) {
      heldRef.current = 0;
      setLevel(0);
      return;
    }
    let raf = 0;
    let mounted = true;
    const tick = () => {
      const p = getPeak();
      heldRef.current = Math.max(p, heldRef.current * 0.92); // peak-hold + decay
      if (mounted) setLevel(heldRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
  }, [active, getPeak]);

  const pct = Math.min(100, level * 100);
  const clipping = level >= 1.0;
  const hot = level >= 0.89; // limiter threshold (-1 dBFS) in linear terms
  const color = clipping ? "bg-red-500" : hot ? "bg-amber-400" : "bg-emerald-500";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm">Mic output level</label>
        {clipping && <span className="text-xs text-red-400 font-medium">Clipping — limiter active</span>}
      </div>
      <div className="h-2.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full ${color} transition-[width] duration-75`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted mt-1">
        The summed signal feeding the virtual mic. The limiter stops it hard-clipping, but if it
        sits in the red the audio still sounds squashed to listeners — lower your mic or clip volumes.
      </p>
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
