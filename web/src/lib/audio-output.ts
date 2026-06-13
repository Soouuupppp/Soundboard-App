"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicMixer, type MixerInputState, SOUNDBOARD_KEY } from "./audio-mixer";

const LS_KEY = "soundboard:output";

// Lightweight tagged logger so audio routing is easy to trace in DevTools.
const alog = (...args: unknown[]) =>
  console.log("%c[sb-audio]", "color:#5865F2;font-weight:bold", ...args);
const awarn = (...args: unknown[]) =>
  console.warn("%c[sb-audio]", "color:#e0a000;font-weight:bold", ...args);

type Stored = {
  deviceId?: string;
  masterVolume?: number;
  virtualMicMode?: boolean;
  inputs?: MixerInputState[];
  monitorDeviceId?: string;
  monitored?: string[]; // legacy binary monitor selection (migrated → monitorSends)
  monitorSends?: Record<string, number>; // per-source monitor level, 0..1
  micOutputVolume?: number; // master cable gain
  soundboardVolume?: number; // soundboard cable-send
};

type AudioWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

type SinkCapableContext = AudioContext & {
  setSinkId?: (id: string) => Promise<void>;
};

type Active = {
  // Normal mode: the only element (plays to the selected output device).
  // Virtual Mic mode: null — playback is fully owned by the mixer (`cable`).
  monitorAudio: AudioWithSink | null;
  // Normal mode (metered path only): the element's tap into the OutputGraph, so
  // it can be disconnected when the clip ends. Null on the fallback path.
  outSource: MediaElementAudioSourceNode | null;
  // Virtual Mic mode only: the clip's injection into the soundboard mix. The
  // mixer fans it out to the cable and every enabled output (monitor) line.
  cable: { gain: GainNode; stop: () => void } | null;
  soundId: string;
  entryId?: string;
  perEntryVolume: number;
};

// OutputGraph — a tiny Web Audio graph for NORMAL-mode playback (Virtual Mic
// mode off). It exists so the soundboard's output can be metered globally:
//
//   <audio>.play() ─► MediaElementSource ─► master ─► analyser ─► ctx.destination ─►(setSinkId) output device
//
// Output-device routing moves to ctx.setSinkId here, because
// createMediaElementSource consumes the element's own output (its .setSinkId no
// longer routes). Requires AudioContext.setSinkId (Chromium 110+); callers fall
// back to a plain <audio>.setSinkId path (no meter) when it's unavailable.
class OutputGraph {
  private ctx: SinkCapableContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private peakBuf: Float32Array<ArrayBuffer> | null = null;

  // Build the graph on first use and (re)apply the output device. Synchronous so
  // a clip can attach + play in the same tick; sink/resume settle in the
  // background. (The AudioContext constructor and node wiring are synchronous.)
  ensure(deviceId: string) {
    if (!this.ctx) {
      const ctx = new AudioContext() as SinkCapableContext;
      const master = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      master.connect(analyser);
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.analyser = analyser;
      this.peakBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    }
    void this.applySink(deviceId);
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  private async applySink(deviceId: string) {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.setSinkId !== "function") return;
    const target = deviceId && deviceId !== "default" ? deviceId : "";
    await ctx.setSinkId(target).catch(() => {});
  }

  async setDevice(deviceId: string) {
    await this.applySink(deviceId);
  }

  // Route a playing element through the graph; returns its source node (to
  // disconnect on cleanup), or null if the graph isn't ready.
  attach(el: HTMLMediaElement): MediaElementAudioSourceNode | null {
    if (!this.ctx || !this.master) return null;
    const src = this.ctx.createMediaElementSource(el);
    src.connect(this.master);
    return src;
  }

  getPeak(): number {
    const a = this.analyser;
    const buf = this.peakBuf;
    if (!a || !buf) return 0;
    a.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  async close() {
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* ignore */ }
    }
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this.peakBuf = null;
  }
}

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

function clamp(v: number) { return Math.max(0, Math.min(1, v)); }

export type AudioOutput = {
  deviceId: string;
  masterVolume: number;
  devices: MediaDeviceInfo[];
  setDeviceId: (id: string) => void;
  setMasterVolume: (v: number) => void;
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
  // Enable (open + mix) a capture line — its own switch.
  setInputEnabled: (deviceId: string, enabled: boolean) => void;
  // Cable-send level for a capture line (independent of the enable switch).
  setInputVolume: (deviceId: string, volume: number) => void;
  // Master "mic output volume" (cable sum) and the soundboard's cable-send.
  micOutputVolume: number;
  setMicOutputVolume: (v: number) => void;
  soundboardVolume: number;
  setSoundboardVolume: (v: number) => void;
  // Local monitoring: one device + a per-source send level (0..1, 0 = off).
  monitorDeviceId: string;
  setMonitorDeviceId: (id: string) => void;
  monitorSends: Record<string, number>;
  setMonitorSend: (key: string, level: number) => void;
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
};

export function useAudioOutput(): AudioOutput {
  const [deviceId, setDeviceIdState] = useState<string>("default");
  const [masterVolume, setMasterVolumeState] = useState<number>(1);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [playingSoundIds, setPlayingSoundIds] = useState<Set<string>>(new Set());

  const [virtualMicMode, setVirtualMicModeState] = useState(false);
  const [inputs, setInputs] = useState<MixerInputState[]>([]);
  const [monitorDeviceId, setMonitorDeviceIdState] = useState("default");
  // Per-source monitor level (0..1; 0 = not monitored). Default: monitor the
  // soundboard at unity so the mode isn't silent locally.
  const [monitorSends, setMonitorSendsState] = useState<Record<string, number>>({
    [SOUNDBOARD_KEY]: 1,
  });
  // Master "mic output volume" (cable sum) and the soundboard's cable-send.
  const [micOutputVolume, setMicOutputVolumeState] = useState(1);
  const [soundboardVolume, setSoundboardVolumeState] = useState(1);
  const [mixerError, setMixerError] = useState<string | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);

  const activeRef = useRef<Active[]>([]);
  const masterRef = useRef(masterVolume);
  masterRef.current = masterVolume;

  const mixerRef = useRef<MicMixer | null>(null);
  // Normal-mode output graph (lazily created on first normal-mode play) so the
  // soundboard output can be metered when Virtual Mic mode is off.
  const outGraphRef = useRef<OutputGraph | null>(null);
  const virtualMicModeRef = useRef(virtualMicMode);
  virtualMicModeRef.current = virtualMicMode;
  // Read the current monitor device inside play() without rebuilding the callback.
  const monitorDeviceIdRef = useRef(monitorDeviceId);
  monitorDeviceIdRef.current = monitorDeviceId;

  useEffect(() => {
    const s = read();
    if (typeof s.deviceId === "string") setDeviceIdState(s.deviceId);
    if (typeof s.masterVolume === "number") setMasterVolumeState(s.masterVolume);
    if (typeof s.virtualMicMode === "boolean") setVirtualMicModeState(s.virtualMicMode);
    if (Array.isArray(s.inputs)) setInputs(s.inputs);
    if (typeof s.monitorDeviceId === "string") setMonitorDeviceIdState(s.monitorDeviceId);
    if (typeof s.micOutputVolume === "number") setMicOutputVolumeState(s.micOutputVolume);
    if (typeof s.soundboardVolume === "number") setSoundboardVolumeState(s.soundboardVolume);
    if (s.monitorSends && typeof s.monitorSends === "object") {
      setMonitorSendsState(s.monitorSends);
    } else if (Array.isArray(s.monitored)) {
      // Migrate the legacy binary selection: each monitored key → full send.
      setMonitorSendsState(Object.fromEntries(s.monitored.map((k) => [k, 1])));
    }
  }, []);

  // Live-update every playing clip when master volume changes (both copies).
  useEffect(() => {
    for (const a of activeRef.current) {
      const v = clamp(a.perEntryVolume * masterVolume);
      if (a.monitorAudio) a.monitorAudio.volume = v;
      if (a.cable) a.cable.gain.gain.value = v;
    }
  }, [masterVolume]);

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

  const setMasterVolume = useCallback((v: number) => {
    const c = clamp(v);
    setMasterVolumeState(c);
    write({ ...read(), masterVolume: c });
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
    const c = clamp(v);
    setMicOutputVolumeState(c);
    mixerRef.current?.setMicOutputVolume(c);
    write({ ...read(), micOutputVolume: c });
  }, []);

  const setSoundboardVolume = useCallback((v: number) => {
    const c = clamp(v);
    setSoundboardVolumeState(c);
    mixerRef.current?.setSoundboardVolume(c);
    write({ ...read(), soundboardVolume: c });
  }, []);

  const setMonitorSend = useCallback((key: string, level: number) => {
    const v = clamp(level);
    setMonitorSendsState((prev) => {
      const next = { ...prev, [key]: v };
      // Apply live immediately; the effect also reconciles but this is snappier.
      mixerRef.current?.setMonitorSend(key, v);
      write({ ...read(), monitorSends: next });
      return next;
    });
  }, []);

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

  // Start/stop the mixer when the mode toggles. Initial cable + input sync
  // happens here (after start) so it isn't lost to the not-yet-ready guards in
  // the cable/inputs effects below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (virtualMicMode) {
        if (!mixerRef.current) mixerRef.current = new MicMixer();
        try {
          // The app's Output device doubles as the cable target in this mode.
          if (!mixerRef.current.isReady()) await mixerRef.current.start(deviceId);
          if (cancelled) return;
          mixerRef.current.setMicOutputVolume(micOutputVolume);
          mixerRef.current.setSoundboardVolume(soundboardVolume);
          mixerRef.current.setMonitorSends(monitorSends);
          await mixerRef.current.setMonitorDevice(monitorDeviceId);
          await mixerRef.current.syncInputs(inputs);
          setMixerError(null);
        } catch (e) {
          setMixerError(String((e as Error)?.message || e));
        }
      } else {
        const m = mixerRef.current;
        mixerRef.current = null;
        if (m) await m.stop();
        setMixerError(null);
      }
    })();
    return () => { cancelled = true; };
    // Only react to the toggle here; the inputs/system/monitor effects below
    // reconcile their own slices once the mixer is running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualMicMode]);

  // React to output-device changes while running. In Virtual Mic mode this is
  // the cable target; in normal mode it reroutes the metered output graph.
  useEffect(() => {
    if (virtualMicModeRef.current) {
      if (!mixerRef.current?.isReady()) return;
      mixerRef.current.setCableDevice(deviceId).catch((e) => {
        setMixerError(String((e as Error)?.message || e));
      });
    } else {
      outGraphRef.current?.setDevice(deviceId).catch(() => {});
    }
  }, [deviceId]);

  // React to input selection/volume changes while the mode is already running.
  useEffect(() => {
    if (!virtualMicModeRef.current || !mixerRef.current?.isReady()) return;
    mixerRef.current.syncInputs(inputs).catch(() => {});
  }, [inputs]);

  // React to monitor device / selection changes while the mode is running.
  useEffect(() => {
    if (!virtualMicModeRef.current || !mixerRef.current?.isReady()) return;
    mixerRef.current.setMonitorDevice(monitorDeviceId).catch(() => {});
  }, [monitorDeviceId]);

  useEffect(() => {
    if (!virtualMicModeRef.current || !mixerRef.current?.isReady()) return;
    mixerRef.current.setMonitorSends(monitorSends);
  }, [monitorSends]);

  // Tear the mixer + output graph down on unmount so mic capture and the
  // output AudioContext stop cleanly.
  useEffect(() => {
    return () => {
      const m = mixerRef.current;
      mixerRef.current = null;
      m?.stop();
      const g = outGraphRef.current;
      outGraphRef.current = null;
      g?.close();
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
    const vol = clamp(perEntryVolume * masterRef.current);

    // A preview only needs special handling in Virtual Mic mode, where the
    // "output device" IS the cable: there it plays locally on the MONITOR device
    // so it neither leaks into the game mic nor is inaudible to you. In normal
    // mode there's no cable, so a preview is just ordinary output-device playback
    // — it falls through to the metered normal path below (output device, on the
    // global meter), which is what you'd expect.
    if (preview && virtualMicModeRef.current && mixerRef.current?.isReady()) {
      const el = new Audio(url) as AudioWithSink;
      el.volume = vol;
      const entry: Active = { monitorAudio: el, outSource: null, cable: null, soundId, entryId, perEntryVolume };
      activeRef.current.push(entry);
      recomputePlaying();
      const cleanup = () => removeActive(entry);
      el.addEventListener("ended", cleanup);
      el.addEventListener("error", cleanup);
      const mon = monitorDeviceIdRef.current;
      const start = () => el.play().catch(cleanup);
      if (supportsSinkId && el.setSinkId && mon && mon !== "default") {
        el.setSinkId(mon).then(start).catch(start);
      } else {
        start();
      }
      return;
    }

    // Virtual-Mic-mode previews returned above; everything below is board/normal
    // playback (plus normal-mode previews, which behave like ordinary output).
    const useMixer =
      virtualMicModeRef.current && mixerRef.current?.isReady();

    if (useMixer) {
      // The mixer owns playback in this mode: it fans the clip out to the cable
      // (what the game hears) and every enabled output line (what you monitor).
      const entry: Active = { monitorAudio: null, outSource: null, cable: null, soundId, entryId, perEntryVolume };
      activeRef.current.push(entry);
      recomputePlaying();
      const cleanup = () => removeActive(entry);
      entry.cable = mixerRef.current!.injectClip(url, vol, cleanup);
      if (!entry.cable) cleanup();
      return;
    }

    // Normal mode: single element to the selected output device.
    const mon = new Audio(url) as AudioWithSink;
    mon.volume = vol;
    const entry: Active = { monitorAudio: mon, outSource: null, cable: null, soundId, entryId, perEntryVolume };
    activeRef.current.push(entry);
    recomputePlaying();

    const cleanup = () => {
      try { entry.outSource?.disconnect(); } catch {/* ignore */}
      removeActive(entry);
    };
    mon.addEventListener("ended", cleanup);
    mon.addEventListener("error", cleanup);

    if (supportsContextSink) {
      // Metered path: route through the output graph (it owns device routing via
      // ctx.setSinkId, so don't also call mon.setSinkId). attach() consuming the
      // element's output is what lets the analyser meter it.
      if (!outGraphRef.current) outGraphRef.current = new OutputGraph();
      outGraphRef.current.ensure(deviceId);
      entry.outSource = outGraphRef.current.attach(mon);
      mon.play().catch(cleanup);
    } else {
      // Fallback (no AudioContext.setSinkId): play the element directly to the
      // chosen device. No global meter in this build.
      const start = () => mon.play().catch(cleanup);
      if (supportsSinkId && deviceId && deviceId !== "default" && mon.setSinkId) {
        mon.setSinkId(deviceId).then(start).catch(start);
      } else {
        start();
      }
    }
  }, [deviceId, supportsSinkId, supportsContextSink, recomputePlaying, removeActive]);

  const updateEntryVolume = useCallback((entryId: string, perEntryVolume: number) => {
    for (const a of activeRef.current) {
      if (a.entryId === entryId) {
        a.perEntryVolume = perEntryVolume;
        const v = clamp(perEntryVolume * masterRef.current);
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
    try { entry.outSource?.disconnect(); } catch {/* ignore */}
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

  const getCablePeak = useCallback(() => mixerRef.current?.getCablePeak() ?? 0, []);
  // Global output: cable sum in Virtual Mic mode, else the normal-mode graph.
  const getOutputPeak = useCallback(
    () =>
      (virtualMicModeRef.current
        ? mixerRef.current?.getCablePeak()
        : outGraphRef.current?.getPeak()) ?? 0,
    [],
  );
  const getInputPeak = useCallback(
    (id: string) => mixerRef.current?.getInputPeak(id) ?? 0,
    [],
  );

  return {
    deviceId,
    masterVolume,
    devices,
    setDeviceId,
    setMasterVolume,
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
    setInputEnabled,
    setInputVolume,
    micOutputVolume,
    setMicOutputVolume,
    soundboardVolume,
    setSoundboardVolume,
    monitorDeviceId,
    setMonitorDeviceId,
    monitorSends,
    setMonitorSend,
    soundboardKey: SOUNDBOARD_KEY,
    getCablePeak,
    getOutputPeak,
    getInputPeak,
    supportsOutputMeter: supportsContextSink,
    mixerError,
    labelsError,
    supportsContextSink,
    secureContext: typeof window !== "undefined" ? window.isSecureContext : false,
  };
}
