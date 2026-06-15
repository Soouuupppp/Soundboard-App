"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicMixer, type MixerInputState, SOUNDBOARD_KEY } from "./audio-mixer";
import { type EffectConfig, type EffectParams } from "./voice-fx";
import { type AiVoice, convertVoice, resolveVoice } from "./voice-ai";

const LS_KEY = "soundboard:output";
// Voice changer (1.4.0) — device-local per-source DSP chains + AI config. Kept in
// its own key so it doesn't churn the audio-settings blob above.
const VOICEFX_KEY = "soundboard:voicefx";
// Per-clip Sound Effects (1.4.0) — device-local DSP chain keyed by sound id.
const SOUNDFX_KEY = "soundboard:soundfx";
// Cap a single push-to-talk capture so a stuck bind can't record forever.
const MAX_PTT_MS = 15000;

// Lightweight tagged logger so audio routing is easy to trace in DevTools.
const alog = (...args: unknown[]) =>
  console.log("%c[sb-audio]", "color:#5865F2;font-weight:bold", ...args);
const awarn = (...args: unknown[]) =>
  console.warn("%c[sb-audio]", "color:#e0a000;font-weight:bold", ...args);

type Stored = {
  deviceId?: string;
  virtualMicMode?: boolean;
  inputs?: MixerInputState[];
  monitorDeviceId?: string;
  monitored?: string[]; // legacy binary monitor selection (migrated → monitorSends)
  monitorSends?: Record<string, number>; // legacy per-source monitor level, 0..1
  micOutputVolume?: number; // mic sub-bus level (0..2)
  soundboardVolume?: number; // soundboard sub-bus level (0..2)
  globalVolume?: number; // global master on output+monitor (0..2)
  monitorMic?: boolean; // add the mic to the local monitor
};

type AudioWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

type Active = {
  // Fallback path only (no AudioContext.setSinkId): the <audio> element playing
  // directly to the chosen device. Null on the engine path.
  monitorAudio: AudioWithSink | null;
  // Engine path: the clip's injection into the unified graph (soundboard sub-bus
  // for board plays, monitor bus for previews).
  cable: { gain: GainNode; stop: () => void } | null;
  soundId: string;
  entryId?: string;
  perEntryVolume: number;
};

function read(): Stored {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function write(s: Stored) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

// --- Debounced localStorage persist (FX param drags) ----------------------
// FX param sliders re-serialize the whole voicefx/soundfx map on every tick. We
// keep React state + the live mixer update synchronous (responsive audio/UI) but
// coalesce the localStorage writes into one trailing write per key (~250ms). A
// pending value is flushed on demand (unmount / beforeunload) so an interrupted
// drag isn't lost. An IMMEDIATE write (structural add/remove/reorder) cancels any
// pending debounced write for the same key so a stale value can't clobber it.
const FX_PERSIST_DEBOUNCE_MS = 250;
const fxPending = new Map<string, string>();
const fxTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushFxWrite(key: string) {
  const t = fxTimers.get(key);
  if (t) { clearTimeout(t); fxTimers.delete(key); }
  const v = fxPending.get(key);
  if (v === undefined) return;
  fxPending.delete(key);
  try { localStorage.setItem(key, v); } catch {}
}

function flushAllFxWrites() {
  for (const key of Array.from(fxPending.keys())) flushFxWrite(key);
}

// Write the latest value now, cancelling any pending debounced write for the key.
function writeFxNow(key: string, value: string) {
  fxPending.set(key, value);
  flushFxWrite(key);
}

// Schedule a trailing write; resets the timer so rapid ticks coalesce into one.
function writeFxDebounced(key: string, value: string) {
  fxPending.set(key, value);
  const existing = fxTimers.get(key);
  if (existing) clearTimeout(existing);
  fxTimers.set(key, setTimeout(() => flushFxWrite(key), FX_PERSIST_DEBOUNCE_MS));
}

// --- Voice changer state (per source key) ---
export type AiConfig = { enabled: boolean; voiceId: string; custom?: AiVoice | null };
export type SourceFx = { effects: EffectConfig[]; ai?: AiConfig };
export type VoiceFxMap = Record<string, SourceFx>;

function readVoiceFx(): VoiceFxMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(VOICEFX_KEY);
    return raw ? (JSON.parse(raw) as VoiceFxMap) : {};
  } catch {
    return {};
  }
}

// Structural voicefx change → persist immediately (cancels a pending param write).
function writeVoiceFx(v: VoiceFxMap) {
  writeFxNow(VOICEFX_KEY, JSON.stringify(v));
}
// Param drag → debounced persist.
function writeVoiceFxDebounced(v: VoiceFxMap) {
  writeFxDebounced(VOICEFX_KEY, JSON.stringify(v));
}

// --- Per-clip Sound Effects state (keyed by sound id) ---
export type SoundFxMap = Record<string, EffectConfig[]>;

function readSoundFx(): SoundFxMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SOUNDFX_KEY);
    return raw ? (JSON.parse(raw) as SoundFxMap) : {};
  } catch {
    return {};
  }
}

// Per-clip Sound Effects: the editor re-saves the whole chain on every param tick
// (no live mixer node), so debounce the persist; the next play reads it fresh.
function writeSoundFx(v: SoundFxMap) {
  writeFxDebounced(SOUNDFX_KEY, JSON.stringify(v));
}

function clamp(v: number) { return Math.max(0, Math.min(1, v)); }
// Bus/master gains run 0..2 (0–200%); per-clip / per-input volumes stay 0..1.
function clamp2(v: number) { return Math.max(0, Math.min(2, v)); }

export type AudioOutput = {
  deviceId: string;
  devices: MediaDeviceInfo[];
  setDeviceId: (id: string) => void;
  refreshDevices: () => Promise<void>;
  requestLabelsPermission: () => Promise<void>;
  supportsSinkId: boolean;
  // `preview` keeps a play local — it never feeds the virtual-mic cable. In
  // normal mode that's just the selected output device (metered); in Virtual Mic
  // mode it routes to the monitor device instead of the cable. So Saved / public
  // / admin previews don't leak into the game mic.
  play: (soundId: string, perEntryVolume?: number, entryId?: string, preview?: boolean) => void;
  cancelSound: (soundId: string) => void;
  cancelAll: () => void;
  updateEntryVolume: (entryId: string, perEntryVolume: number) => void;
  playingSoundIds: Set<string>;
  anyPlaying: boolean;
  // --- Virtual Mic mode ---
  virtualMicMode: boolean;
  setVirtualMicMode: (on: boolean) => void;
  inputDevices: MediaDeviceInfo[];
  inputs: MixerInputState[];
  // Single primary mic (1.4.0 UI): the mixer keeps multi-source in code, but the
  // UI exposes ONE input device. `inputDeviceId` is the selected mic ("" = none);
  // setting it replaces `inputs` with that single enabled entry.
  inputDeviceId: string;
  setInputDeviceId: (deviceId: string) => void;
  // Enable (open + mix) a capture line — its own switch.
  setInputEnabled: (deviceId: string, enabled: boolean) => void;
  // Cable-send level for a capture line (independent of the enable switch).
  setInputVolume: (deviceId: string, volume: number) => void;
  // Volume hierarchy (all 0..2): global master + the two sub-buses. micOutputVolume
  // is the mic sub-bus; soundboardVolume the soundboard sub-bus; globalVolume the
  // master on the combined output+monitor sum.
  micOutputVolume: number;
  setMicOutputVolume: (v: number) => void;
  soundboardVolume: number;
  setSoundboardVolume: (v: number) => void;
  globalVolume: number;
  setGlobalVolume: (v: number) => void;
  // Add the mic to the local monitor (single toggle; replaces per-source sends).
  monitorMic: boolean;
  setMonitorMic: (on: boolean) => void;
  // Local monitoring device (the monitor-mic toggle adds the mic to it).
  monitorDeviceId: string;
  setMonitorDeviceId: (id: string) => void;
  soundboardKey: string;
  // Current peak level of the cable sum (linear, 0..1+; >1 = driving the limiter
  // into clipping). Returns 0 when the mixer isn't running.
  getCablePeak: () => number;
  // Global output peak (linear, 0..1+): the cable sum in Virtual Mic mode, else
  // the normal-mode output graph. 0 when nothing is playing / metering is
  // unavailable (no AudioContext.setSinkId in normal mode).
  getOutputPeak: () => number;
  // Per-input peak (linear, 0..1+) for a capture line, post its volume. 0 unless
  // that input is live in the mixer. Lets each source row show its own meter.
  getInputPeak: (deviceId: string) => number;
  // True when normal-mode output can be metered (AudioContext.setSinkId present).
  supportsOutputMeter: boolean;
  mixerError: string | null;
  labelsError: string | null;
  supportsContextSink: boolean;
  secureContext: boolean;
  // --- Voice changer (1.4.0) ---
  // Per-source DSP effect chains + optional AI config, keyed by deviceId /
  // SOUNDBOARD_KEY. Persisted device-local; applied live to the mixer.
  voiceFx: VoiceFxMap;
  setSourceEffects: (key: string, effects: EffectConfig[]) => void;
  // Live param tweak for one effect (smooth slider drags — no chain rebuild).
  updateSourceEffectParams: (key: string, index: number, params: EffectParams) => void;
  // AI config only makes sense on a capture device (mutes its raw mic when on).
  setSourceAi: (key: string, ai: AiConfig | undefined) => void;
  // --- Per-clip Sound Effects (1.4.0), keyed by sound id ---
  // The DSP chain applied to a soundboard clip on EVERY play (board/keybind/VR/
  // preview). Persisted device-local; read at trigger time, built fresh per play.
  soundFx: SoundFxMap;
  setSoundEffects: (soundId: string, effects: EffectConfig[]) => void;
  // Push-to-talk: start recording the device's mic; stop → convert → inject the
  // converted clip into that source's chain. No-op if no AI voice is configured.
  startPtt: (deviceId: string) => void;
  stopPtt: (deviceId: string) => void;
  // Re-inject the last converted AI clip (AI replay bind). No-op if none yet.
  replayLastConversion: () => void;
  // Which devices are currently recording (for the hold-button UI) + conversion
  // in-flight state + the last AI error message.
  pttRecording: Set<string>;
  aiBusy: boolean;
  aiError: string | null;
};

export function useAudioOutput(): AudioOutput {
  const [deviceId, setDeviceIdState] = useState<string>("default");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [playingSoundIds, setPlayingSoundIds] = useState<Set<string>>(new Set());

  const [virtualMicMode, setVirtualMicModeState] = useState(false);
  const [inputs, setInputs] = useState<MixerInputState[]>([]);
  const [monitorDeviceId, setMonitorDeviceIdState] = useState("default");
  // Volume hierarchy (0..2): mic sub-bus, soundboard sub-bus, global master.
  const [micOutputVolume, setMicOutputVolumeState] = useState(1);
  const [soundboardVolume, setSoundboardVolumeState] = useState(1);
  const [globalVolume, setGlobalVolumeState] = useState(1);
  // Add the mic to the local monitor (single toggle).
  const [monitorMic, setMonitorMicState] = useState(false);
  const [mixerError, setMixerError] = useState<string | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);

  // Voice changer state (device-local). voiceFxRef mirrors it so PTT (outside
  // React) can read the current AI config without a stale closure.
  const [voiceFx, setVoiceFxState] = useState<VoiceFxMap>({});
  const voiceFxRef = useRef<VoiceFxMap>(voiceFx);
  voiceFxRef.current = voiceFx;

  // Per-clip Sound Effects (device-local). soundFxRef mirrors it so play()
  // (outside React) reads the current chain without a stale closure.
  const [soundFx, setSoundFxState] = useState<SoundFxMap>({});
  const soundFxRef = useRef<SoundFxMap>(soundFx);
  soundFxRef.current = soundFx;
  const [pttRecording, setPttRecording] = useState<Set<string>>(new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const activeRef = useRef<Active[]>([]);

  const mixerRef = useRef<MicMixer | null>(null);
  // Active push-to-talk recorders, keyed by capture deviceId.
  const pttRef = useRef<
    Map<string, { recorder: MediaRecorder; chunks: Blob[]; ownStream: MediaStream | null; timer: number | null }>
  >(new Map());
  const virtualMicModeRef = useRef(virtualMicMode);
  virtualMicModeRef.current = virtualMicMode;
  // Read the current monitor device inside play() without rebuilding the callback.
  const monitorDeviceIdRef = useRef(monitorDeviceId);
  monitorDeviceIdRef.current = monitorDeviceId;
  // Current open inputs, so the Virtual-Mic toggle effect can sync them without
  // depending on `inputs` (which has its own reconcile effect).
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  useEffect(() => {
    const s = read();
    if (typeof s.deviceId === "string") setDeviceIdState(s.deviceId);
    if (typeof s.virtualMicMode === "boolean") setVirtualMicModeState(s.virtualMicMode);
    if (Array.isArray(s.inputs)) {
      // Migrate the legacy MULTI-source array to the single primary mic the 1.4.0
      // UI exposes: if more than one input was enabled, keep just the first and
      // persist the collapsed shape. (The mixer still supports multi-source in
      // code; only the UI is single-mic.)
      const enabled = s.inputs.filter((i) => i.enabled);
      if (enabled.length > 1) {
        const collapsed: MixerInputState[] = [{ deviceId: enabled[0].deviceId, enabled: true, volume: 1 }];
        setInputs(collapsed);
        write({ ...read(), inputs: collapsed });
      } else {
        setInputs(s.inputs);
      }
    }
    if (typeof s.monitorDeviceId === "string") setMonitorDeviceIdState(s.monitorDeviceId);
    if (typeof s.micOutputVolume === "number") setMicOutputVolumeState(s.micOutputVolume);
    if (typeof s.soundboardVolume === "number") setSoundboardVolumeState(s.soundboardVolume);
    if (typeof s.globalVolume === "number") setGlobalVolumeState(s.globalVolume);
    if (typeof s.monitorMic === "boolean") {
      setMonitorMicState(s.monitorMic);
    } else if (s.monitorSends && typeof s.monitorSends === "object") {
      // Migrate the legacy per-source monitor sends: any mic send > 0 → monitor-mic on.
      const micOn = Object.entries(s.monitorSends).some(([k, v]) => k !== SOUNDBOARD_KEY && v > 0);
      setMonitorMicState(micOn);
    } else if (Array.isArray(s.monitored)) {
      setMonitorMicState(s.monitored.some((k) => k !== SOUNDBOARD_KEY));
    }
    setVoiceFxState(readVoiceFx());
    setSoundFxState(readSoundFx());
  }, []);

  // Flush any pending debounced FX persist on unmount / before unload so a param
  // drag interrupted by a close or navigation isn't lost.
  useEffect(() => {
    const onBeforeUnload = () => flushAllFxWrites();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      flushAllFxWrites();
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      awarn("refreshDevices: navigator.mediaDevices.enumerateDevices unavailable");
      return;
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    alog(
      "enumerateDevices ->",
      all.map((d) => ({
        kind: d.kind,
        label: d.label || "(blank)",
        deviceId: d.deviceId ? d.deviceId.slice(0, 8) : "(empty)",
      })),
    );
    const outs = all.filter((d) => d.kind === "audiooutput");
    const ins = all.filter((d) => d.kind === "audioinput");
    alog(`device counts: ${outs.length} output(s), ${ins.length} input(s); labels populated: ${all.some((d) => !!d.label)}`);
    setDevices(outs);
    setInputDevices(ins);
  }, []);

  useEffect(() => {
    refreshDevices();
    const md = navigator?.mediaDevices;
    if (!md?.addEventListener) return;
    const handler = () => refreshDevices();
    md.addEventListener("devicechange", handler);
    return () => md.removeEventListener("devicechange", handler);
  }, [refreshDevices]);

  const setDeviceId = useCallback((id: string) => {
    setDeviceIdState(id);
    write({ ...read(), deviceId: id });
  }, []);

  const setVirtualMicMode = useCallback((on: boolean) => {
    setVirtualMicModeState(on);
    write({ ...read(), virtualMicMode: on });
  }, []);

  // Enable (open + mix) a capture line — its own switch, independent of volume.
  const setInputEnabled = useCallback((id: string, enabled: boolean) => {
    setInputs((prev) => {
      const found = prev.find((i) => i.deviceId === id);
      const next = found
        ? prev.map((i) => (i.deviceId === id ? { ...i, enabled } : i))
        : [...prev, { deviceId: id, enabled, volume: 1 }];
      write({ ...read(), inputs: next });
      return next;
    });
  }, []);

  // Single primary mic: the selected input is the first enabled entry; setting it
  // collapses `inputs` to just that device (the multi-source plumbing stays in the
  // mixer for a future UI). "" clears the mic entirely.
  const inputDeviceId = inputs.find((i) => i.enabled)?.deviceId ?? "";
  const setInputDeviceId = useCallback((id: string) => {
    setInputs(() => {
      const next: MixerInputState[] = id ? [{ deviceId: id, enabled: true, volume: 1 }] : [];
      write({ ...read(), inputs: next });
      return next;
    });
  }, []);

  // Cable-send level for a capture line (independent of its enable switch).
  const setInputVolume = useCallback((id: string, volume: number) => {
    const v = clamp(volume);
    // Apply to the live node immediately for a smooth slider; persist the state.
    mixerRef.current?.setInputVolume(id, v);
    setInputs((prev) => {
      const found = prev.find((i) => i.deviceId === id);
      const next = found
        ? prev.map((i) => (i.deviceId === id ? { ...i, volume: v } : i))
        : [...prev, { deviceId: id, enabled: false, volume: v }];
      write({ ...read(), inputs: next });
      return next;
    });
  }, []);

  const setMonitorDeviceId = useCallback((id: string) => {
    setMonitorDeviceIdState(id);
    write({ ...read(), monitorDeviceId: id });
  }, []);

  const setMicOutputVolume = useCallback((v: number) => {
    const c = clamp2(v);
    setMicOutputVolumeState(c);
    mixerRef.current?.setMicVolume(c);
    write({ ...read(), micOutputVolume: c });
  }, []);

  const setSoundboardVolume = useCallback((v: number) => {
    const c = clamp2(v);
    setSoundboardVolumeState(c);
    mixerRef.current?.setSoundboardVolume(c);
    write({ ...read(), soundboardVolume: c });
  }, []);

  const setGlobalVolume = useCallback((v: number) => {
    const c = clamp2(v);
    setGlobalVolumeState(c);
    mixerRef.current?.setGlobalVolume(c);
    write({ ...read(), globalVolume: c });
  }, []);

  const setMonitorMic = useCallback((on: boolean) => {
    setMonitorMicState(on);
    mixerRef.current?.setMonitorMic(on);
    write({ ...read(), monitorMic: on });
  }, []);

  // --- Voice changer accessors ---------------------------------------------

  // Replace a source's DSP effect chain (persist + apply live to the mixer).
  const setSourceEffects = useCallback((key: string, effects: EffectConfig[]) => {
    setVoiceFxState((prev) => {
      const next = { ...prev, [key]: { ...prev[key], effects } };
      writeVoiceFx(next);
      return next;
    });
    mixerRef.current?.setSourceEffects(key, effects);
  }, []);

  // Live-tweak one effect's params (smooth slider; no chain rebuild).
  const updateSourceEffectParams = useCallback((key: string, index: number, params: EffectParams) => {
    setVoiceFxState((prev) => {
      const effects = (prev[key]?.effects ?? []).map((e, i) => (i === index ? { ...e, params } : e));
      const next = { ...prev, [key]: { ...prev[key], effects } };
      writeVoiceFxDebounced(next); // param drag — coalesce the persist
      return next;
    });
    mixerRef.current?.updateEffectParams(key, index, params);
  }, []);

  // Set/clear a capture device's AI config. Enabling it mutes the device's raw
  // mic (only converted PTT clips pass); clearing it unmutes.
  const setSourceAi = useCallback((key: string, ai: AiConfig | undefined) => {
    setVoiceFxState((prev) => {
      const next = { ...prev, [key]: { effects: prev[key]?.effects ?? [], ai } };
      writeVoiceFx(next);
      return next;
    });
    mixerRef.current?.setSourceAiMuted(key, !!ai?.enabled);
  }, []);

  // Set a clip's per-id Sound Effects chain (persist + preload any worklet deps so
  // the next play builds the real nodes). Read fresh at trigger time in play().
  const setSoundEffects = useCallback((soundId: string, effects: EffectConfig[]) => {
    setSoundFxState((prev) => {
      const next = { ...prev };
      if (effects.length) next[soundId] = effects;
      else delete next[soundId]; // empty chain → drop the key so the map stays lean
      writeSoundFx(next);
      return next;
    });
    mixerRef.current?.preloadEffects(effects);
  }, []);

  // The last converted AI clip, kept alive (not revoked on end) so an AI-replay
  // bind can re-inject it. The previous one is revoked when a new conversion
  // replaces it, and the survivor is revoked on unmount.
  const lastConvRef = useRef<{ url: string; deviceId: string } | null>(null);

  // Short "conversion ready" chime on the MONITOR device (local-only, like a
  // preview) so you know a PTT conversion landed without watching the screen.
  const playReadyChime = useCallback(() => {
    try {
      const el = new Audio("/conversion-ready.wav") as AudioWithSink;
      el.volume = 0.6;
      const mon = monitorDeviceIdRef.current;
      const start = () => el.play().catch(() => {});
      if (typeof el.setSinkId === "function" && mon && mon !== "default") {
        el.setSinkId(mon).then(start).catch(start);
      } else {
        start();
      }
    } catch {
      /* chime is best-effort */
    }
  }, []);

  // Re-inject the last converted clip into its source's chain (AI replay bind).
  const replayLastConversion = useCallback(() => {
    const last = lastConvRef.current;
    if (!last) return;
    // Keep the url alive — onEnded is a no-op so it stays replayable.
    mixerRef.current?.injectClipToSource(last.deviceId, last.url, 1, () => {});
  }, []);

  // Convert a recorded PTT clip with the device's AI voice and inject it into the
  // source's chain. Best-effort: surfaces ZeroGPU/Space failures via aiError.
  const convertAndInject = useCallback(async (deviceId: string, blob: Blob) => {
    const ai = voiceFxRef.current[deviceId]?.ai;
    if (!ai?.enabled || blob.size === 0) return;
    const voice = resolveVoice(ai.voiceId, ai.custom);
    if (!voice) { setAiError("No AI voice selected."); return; }
    setAiBusy(true);
    setAiError(null);
    try {
      const converted = await convertVoice(blob, voice);
      const url = URL.createObjectURL(converted);
      // Retire the previous "last" clip; keep this one for replay (no revoke on end).
      if (lastConvRef.current) URL.revokeObjectURL(lastConvRef.current.url);
      lastConvRef.current = { url, deviceId };
      mixerRef.current?.injectClipToSource(deviceId, url, 1, () => {});
      playReadyChime();
    } catch (e) {
      setAiError(String((e as Error)?.message || e));
    } finally {
      setAiBusy(false);
    }
  }, [playReadyChime]);

  // Stop a PTT capture, assemble the clip, and convert+inject it.
  const stopPtt = useCallback((deviceId: string) => {
    const rec = pttRef.current.get(deviceId);
    if (!rec) return;
    pttRef.current.delete(deviceId);
    if (rec.timer !== null) clearTimeout(rec.timer);
    setPttRecording((prev) => { const n = new Set(prev); n.delete(deviceId); return n; });
    const { recorder, chunks, ownStream } = rec;
    recorder.onstop = () => {
      // Only stop tracks we opened ourselves — never the mixer's shared stream.
      if (ownStream) ownStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      void convertAndInject(deviceId, blob);
    };
    try { recorder.stop(); } catch { /* already stopped */ }
  }, [convertAndInject]);

  // Start a PTT capture from the device's mic (the mixer's open stream if active,
  // else a fresh capture). Auto-stops at MAX_PTT_MS.
  const startPtt = useCallback((deviceId: string) => {
    if (pttRef.current.has(deviceId)) return; // already recording
    if (typeof MediaRecorder === "undefined") { setAiError("Recording is unavailable here."); return; }
    (async () => {
      try {
        const shared = mixerRef.current?.getSourceStream(deviceId) ?? null;
        let ownStream: MediaStream | null = null;
        let stream = shared;
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
          ownStream = stream;
        }
        // Lost the race (stop arrived, or a second start) — discard.
        if (pttRef.current.has(deviceId)) { ownStream?.getTracks().forEach((t) => t.stop()); return; }
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start();
        const timer = window.setTimeout(() => stopPtt(deviceId), MAX_PTT_MS);
        pttRef.current.set(deviceId, { recorder, chunks, ownStream, timer });
        setPttRecording((prev) => new Set(prev).add(deviceId));
      } catch (e) {
        setAiError(String((e as Error)?.message || e));
      }
    })();
  }, [stopPtt]);

  const requestLabelsPermission = useCallback(async () => {
    alog("requestLabelsPermission: clicked", {
      isSecureContext: typeof window !== "undefined" ? window.isSecureContext : "n/a",
      origin: typeof window !== "undefined" ? window.location.origin : "n/a",
      hasMediaDevices: typeof navigator !== "undefined" && !!navigator.mediaDevices,
      hasGetUserMedia:
        typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
    });
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      awarn("requestLabelsPermission: getUserMedia unavailable");
      setLabelsError("getUserMedia is unavailable in this context.");
      return;
    }
    // Surface the permission state if the API exists (Electron may not implement it).
    try {
      const status = await (navigator.permissions as Permissions | undefined)?.query?.({
        name: "microphone" as PermissionName,
      });
      if (status) alog("permissions.query(microphone) ->", status.state);
    } catch (e) {
      awarn("permissions.query unsupported:", (e as Error)?.message);
    }
    try {
      alog("requestLabelsPermission: calling getUserMedia({audio:true})…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      alog(
        "getUserMedia OK; tracks:",
        stream.getTracks().map((t) => ({ kind: t.kind, label: t.label || "(blank)", state: t.readyState })),
      );
      stream.getTracks().forEach((t) => t.stop());
      setLabelsError(null);
      await refreshDevices();
    } catch (e) {
      const err = e as DOMException;
      // Common cases: NotAllowedError (denied / Electron handler blocked it),
      // NotFoundError (no mic), or a non-secure context where the API is absent.
      console.error("%c[sb-audio]", "color:#ff5555;font-weight:bold", "getUserMedia FAILED:", err?.name, err?.message, e);
      setLabelsError(`${err?.name || "Error"}: ${err?.message || String(e)}`);
    }
  }, [refreshDevices]);

  const supportsSinkId =
    typeof window !== "undefined" && "setSinkId" in HTMLAudioElement.prototype;
  const supportsContextSink =
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    "setSinkId" in AudioContext.prototype;

  // --- Mixer lifecycle ------------------------------------------------------

  // Start the unified engine ONCE on mount (when AudioContext.setSinkId exists)
  // and keep it running in all modes — soundboard plays + the meter live here, so
  // the engine can't be torn down with the Virtual Mic toggle. The mic is NOT
  // opened here (no getUserMedia until Virtual Mic mode turns on). Reads persisted
  // settings directly so the seed is deterministic regardless of state-load order.
  useEffect(() => {
    if (!supportsContextSink) return; // fallback build: no engine, plain <audio>.
    if (!mixerRef.current) mixerRef.current = new MicMixer();
    const m = mixerRef.current;
    (async () => {
      try {
        if (!m.isReady()) {
          const s = read();
          await m.start(typeof s.deviceId === "string" ? s.deviceId : "default");
          m.setGlobalVolume(typeof s.globalVolume === "number" ? s.globalVolume : 1);
          m.setSoundboardVolume(typeof s.soundboardVolume === "number" ? s.soundboardVolume : 1);
          m.setMicVolume(typeof s.micOutputVolume === "number" ? s.micOutputVolume : 1);
          m.setMonitorMic(!!s.monitorMic);
          await m.setMonitorDevice(typeof s.monitorDeviceId === "string" ? s.monitorDeviceId : "default");
          // Seed per-source effect/AI maps so a source builds its chain on open.
          for (const [key, fx] of Object.entries(voiceFxRef.current)) {
            // Soundboard DSP is per-clip now (soundFx), not a voice-changer source.
            if (key === SOUNDBOARD_KEY) continue;
            m.setSourceEffects(key, fx.effects ?? []);
            m.setSourceAiMuted(key, !!fx.ai?.enabled);
          }
          // Preload any worklet deps for per-clip Sound Effects so the first play
          // builds the real nodes (not a passthrough).
          for (const fx of Object.values(soundFxRef.current)) m.preloadEffects(fx);
          // If Virtual Mic mode is already on (persisted), open the mics now.
          if (virtualMicModeRef.current) await m.syncInputs(inputsRef.current);
        }
        setMixerError(null);
      } catch (e) {
        setMixerError(String((e as Error)?.message || e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsContextSink]);

  // Open / close the mic inputs with the Virtual Mic toggle (mic permission is
  // requested only here). The engine itself keeps running either way.
  useEffect(() => {
    const m = mixerRef.current;
    if (!m?.isReady()) return;
    if (virtualMicMode) m.syncInputs(inputsRef.current).catch(() => {});
    else m.syncInputs([]).catch(() => {});
  }, [virtualMicMode]);

  // React to output-device changes while running (always the engine now).
  useEffect(() => {
    if (!mixerRef.current?.isReady()) return;
    mixerRef.current.setOutputDevice(deviceId).catch((e) => {
      setMixerError(String((e as Error)?.message || e));
    });
  }, [deviceId]);

  // Live-apply the volume hierarchy + monitor toggle once the engine exists.
  useEffect(() => { mixerRef.current?.setGlobalVolume(globalVolume); }, [globalVolume]);
  useEffect(() => { mixerRef.current?.setSoundboardVolume(soundboardVolume); }, [soundboardVolume]);
  useEffect(() => { mixerRef.current?.setMicVolume(micOutputVolume); }, [micOutputVolume]);
  useEffect(() => { mixerRef.current?.setMonitorMic(monitorMic); }, [monitorMic]);

  // React to input selection/volume changes while Virtual Mic mode is running.
  useEffect(() => {
    if (!virtualMicModeRef.current || !mixerRef.current?.isReady()) return;
    mixerRef.current.syncInputs(inputs).catch(() => {});
  }, [inputs]);

  // React to monitor-device changes while the engine is running.
  useEffect(() => {
    if (!mixerRef.current?.isReady()) return;
    mixerRef.current.setMonitorDevice(monitorDeviceId).catch(() => {});
  }, [monitorDeviceId]);

  // Tear the engine down on unmount so mic capture + the AudioContext stop cleanly.
  useEffect(() => {
    const ptt = pttRef.current;
    return () => {
      const m = mixerRef.current;
      mixerRef.current = null;
      m?.stop();
      // Stop any in-flight PTT recorders + their own streams.
      for (const rec of ptt.values()) {
        if (rec.timer !== null) clearTimeout(rec.timer);
        try { rec.recorder.stop(); } catch { /* ignore */ }
        rec.ownStream?.getTracks().forEach((t) => t.stop());
      }
      ptt.clear();
      // Free the retained last-conversion clip.
      if (lastConvRef.current) {
        URL.revokeObjectURL(lastConvRef.current.url);
        lastConvRef.current = null;
      }
    };
  }, []);

  // --- Playback -------------------------------------------------------------

  const recomputePlaying = useCallback(() => {
    setPlayingSoundIds(new Set(activeRef.current.map((a) => a.soundId)));
  }, []);

  const removeActive = useCallback((entry: Active) => {
    const i = activeRef.current.indexOf(entry);
    if (i !== -1) {
      activeRef.current.splice(i, 1);
      recomputePlaying();
    }
  }, [recomputePlaying]);

  const play = useCallback((soundId: string, perEntryVolume = 1, entryId?: string, preview = false) => {
    const url = `/api/sounds/${soundId}/file`;
    const vol = clamp(perEntryVolume);

    // Per-clip Sound Effects chain (read fresh at trigger time so an edit applies
    // on the next play). Built per play and torn down with the clip in the mixer.
    const fx = soundFxRef.current[soundId];

    // Engine path (always-on graph): a board play injects into the soundboard
    // sub-bus (output + monitor); a preview injects onto the monitor bus ONLY, so
    // it's heard locally but never leaks into the cable/output device.
    if (mixerRef.current?.isReady()) {
      const entry: Active = { monitorAudio: null, cable: null, soundId, entryId, perEntryVolume };
      activeRef.current.push(entry);
      recomputePlaying();
      const cleanup = () => removeActive(entry);
      entry.cable = preview
        ? mixerRef.current.injectPreview(url, vol, cleanup, fx)
        : mixerRef.current.injectClip(url, vol, cleanup, fx);
      if (!entry.cable) cleanup();
      return;
    }

    // Fallback (no AudioContext.setSinkId): plain <audio> straight to a device.
    // A preview targets the monitor device; a normal play the output device. No
    // global meter in this build.
    const mon = new Audio(url) as AudioWithSink;
    mon.volume = vol;
    const entry: Active = { monitorAudio: mon, cable: null, soundId, entryId, perEntryVolume };
    activeRef.current.push(entry);
    recomputePlaying();
    const cleanup = () => removeActive(entry);
    mon.addEventListener("ended", cleanup);
    mon.addEventListener("error", cleanup);
    const target = preview ? monitorDeviceIdRef.current : deviceId;
    const start = () => mon.play().catch(cleanup);
    if (supportsSinkId && target && target !== "default" && mon.setSinkId) {
      mon.setSinkId(target).then(start).catch(start);
    } else {
      start();
    }
  }, [deviceId, supportsSinkId, recomputePlaying, removeActive]);

  const updateEntryVolume = useCallback((entryId: string, perEntryVolume: number) => {
    for (const a of activeRef.current) {
      if (a.entryId === entryId) {
        a.perEntryVolume = perEntryVolume;
        const v = clamp(perEntryVolume);
        if (a.monitorAudio) a.monitorAudio.volume = v;
        if (a.cable) a.cable.gain.gain.value = v;
      }
    }
  }, []);

  const stopEntry = useCallback((entry: Active) => {
    try {
      if (entry.monitorAudio) {
        entry.monitorAudio.pause();
        entry.monitorAudio.currentTime = 0;
      }
    } catch {/* ignore */}
    try { entry.cable?.stop(); } catch {/* ignore */}
    removeActive(entry);
  }, [removeActive]);

  const cancelSound = useCallback((soundId: string) => {
    const matches = activeRef.current.filter((a) => a.soundId === soundId);
    for (const a of matches) stopEntry(a);
  }, [stopEntry]);

  const cancelAll = useCallback(() => {
    const all = activeRef.current.slice();
    for (const a of all) stopEntry(a);
  }, [stopEntry]);

  const getCablePeak = useCallback(() => mixerRef.current?.getOutputPeak() ?? 0, []);
  // Global output peak — the unified engine's pre-limiter output sum (all modes).
  const getOutputPeak = useCallback(() => mixerRef.current?.getOutputPeak() ?? 0, []);
  const getInputPeak = useCallback(
    (id: string) => mixerRef.current?.getInputPeak(id) ?? 0,
    [],
  );

  return {
    deviceId,
    devices,
    setDeviceId,
    refreshDevices,
    requestLabelsPermission,
    supportsSinkId,
    play,
    cancelSound,
    cancelAll,
    updateEntryVolume,
    playingSoundIds,
    anyPlaying: playingSoundIds.size > 0,
    virtualMicMode,
    setVirtualMicMode,
    inputDevices,
    inputs,
    inputDeviceId,
    setInputDeviceId,
    setInputEnabled,
    setInputVolume,
    micOutputVolume,
    setMicOutputVolume,
    soundboardVolume,
    setSoundboardVolume,
    globalVolume,
    setGlobalVolume,
    monitorMic,
    setMonitorMic,
    monitorDeviceId,
    setMonitorDeviceId,
    soundboardKey: SOUNDBOARD_KEY,
    getCablePeak,
    getOutputPeak,
    getInputPeak,
    supportsOutputMeter: supportsContextSink,
    mixerError,
    labelsError,
    supportsContextSink,
    secureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    voiceFx,
    setSourceEffects,
    updateSourceEffectParams,
    setSourceAi,
    soundFx,
    setSoundEffects,
    startPtt,
    stopPtt,
    replayLastConversion,
    pttRecording,
    aiBusy,
    aiError,
  };
}
