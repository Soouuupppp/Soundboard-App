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
  monitored?: string[];
};

type AudioWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

type Active = {
  // Normal mode: the only element (plays to the selected output device).
  // Virtual Mic mode: null — playback is fully owned by the mixer (`cable`).
  monitorAudio: AudioWithSink | null;
  // Virtual Mic mode only: the clip's injection into the soundboard mix. The
  // mixer fans it out to the cable and every enabled output (monitor) line.
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
  play: (soundId: string, perEntryVolume?: number, entryId?: string) => void;
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
  setInputEnabled: (deviceId: string, enabled: boolean) => void;
  setInputVolume: (deviceId: string, volume: number) => void;
  // Local monitoring: one device + which active mic-lines are heard on it.
  monitorDeviceId: string;
  setMonitorDeviceId: (id: string) => void;
  monitored: string[];
  setMonitored: (key: string, on: boolean) => void;
  soundboardKey: string;
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
  // Default to monitoring the soundboard so the mode isn't silent locally.
  const [monitored, setMonitoredState] = useState<string[]>([SOUNDBOARD_KEY]);
  const [mixerError, setMixerError] = useState<string | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);

  const activeRef = useRef<Active[]>([]);
  const masterRef = useRef(masterVolume);
  masterRef.current = masterVolume;

  const mixerRef = useRef<MicMixer | null>(null);
  const virtualMicModeRef = useRef(virtualMicMode);
  virtualMicModeRef.current = virtualMicMode;

  useEffect(() => {
    const s = read();
    if (typeof s.deviceId === "string") setDeviceIdState(s.deviceId);
    if (typeof s.masterVolume === "number") setMasterVolumeState(s.masterVolume);
    if (typeof s.virtualMicMode === "boolean") setVirtualMicModeState(s.virtualMicMode);
    if (Array.isArray(s.inputs)) setInputs(s.inputs);
    if (typeof s.monitorDeviceId === "string") setMonitorDeviceIdState(s.monitorDeviceId);
    if (Array.isArray(s.monitored)) setMonitoredState(s.monitored);
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

  const setMonitored = useCallback((key: string, on: boolean) => {
    setMonitoredState((prev) => {
      const has = prev.includes(key);
      const next = on ? (has ? prev : [...prev, key]) : prev.filter((k) => k !== key);
      // Apply live immediately; the effect also reconciles but this is snappier.
      mixerRef.current?.setMonitored(next);
      write({ ...read(), monitored: next });
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
          mixerRef.current.setMonitored(monitored);
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

  // React to output-device (cable) changes while the mode is already running.
  useEffect(() => {
    if (!virtualMicModeRef.current || !mixerRef.current?.isReady()) return;
    mixerRef.current.setCableDevice(deviceId).catch((e) => {
      setMixerError(String((e as Error)?.message || e));
    });
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
    mixerRef.current.setMonitored(monitored);
  }, [monitored]);

  // Tear the mixer down on unmount so mic capture stops cleanly.
  useEffect(() => {
    return () => {
      const m = mixerRef.current;
      mixerRef.current = null;
      m?.stop();
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

  const play = useCallback((soundId: string, perEntryVolume = 1, entryId?: string) => {
    const url = `/api/sounds/${soundId}/file`;
    const vol = clamp(perEntryVolume * masterRef.current);
    const useMixer =
      virtualMicModeRef.current && mixerRef.current?.isReady();

    if (useMixer) {
      // The mixer owns playback in this mode: it fans the clip out to the cable
      // (what the game hears) and every enabled output line (what you monitor).
      const entry: Active = { monitorAudio: null, cable: null, soundId, entryId, perEntryVolume };
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
    const entry: Active = { monitorAudio: mon, cable: null, soundId, entryId, perEntryVolume };
    activeRef.current.push(entry);
    recomputePlaying();

    const cleanup = () => removeActive(entry);
    mon.addEventListener("ended", cleanup);
    mon.addEventListener("error", cleanup);

    const start = () => mon.play().catch(cleanup);
    if (supportsSinkId && deviceId && deviceId !== "default" && mon.setSinkId) {
      mon.setSinkId(deviceId).then(start).catch(start);
    } else {
      start();
    }
  }, [deviceId, supportsSinkId, recomputePlaying, removeActive]);

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
    monitorDeviceId,
    setMonitorDeviceId,
    monitored,
    setMonitored,
    soundboardKey: SOUNDBOARD_KEY,
    mixerError,
    labelsError,
    supportsContextSink,
    secureContext: typeof window !== "undefined" ? window.isSecureContext : false,
  };
}
