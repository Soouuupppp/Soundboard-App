"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LS_KEY = "soundboard:output";

type Stored = { deviceId?: string; masterVolume?: number };

type AudioWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

type Active = {
  audio: AudioWithSink;
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
};

export function useAudioOutput(): AudioOutput {
  const [deviceId, setDeviceIdState] = useState<string>("default");
  const [masterVolume, setMasterVolumeState] = useState<number>(1);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [playingSoundIds, setPlayingSoundIds] = useState<Set<string>>(new Set());

  const activeRef = useRef<Active[]>([]);
  const masterRef = useRef(masterVolume);
  masterRef.current = masterVolume;

  useEffect(() => {
    const s = read();
    if (typeof s.deviceId === "string") setDeviceIdState(s.deviceId);
    if (typeof s.masterVolume === "number") setMasterVolumeState(s.masterVolume);
  }, []);

  // Live-update every playing clip when master volume changes.
  useEffect(() => {
    for (const a of activeRef.current) {
      a.audio.volume = clamp(a.perEntryVolume * masterVolume);
    }
  }, [masterVolume]);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === "audiooutput"));
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

  const requestLabelsPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshDevices();
    } catch {/* user declined */}
  }, [refreshDevices]);

  const supportsSinkId =
    typeof window !== "undefined" && "setSinkId" in HTMLAudioElement.prototype;

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
    const a = new Audio(`/api/sounds/${soundId}/file`) as AudioWithSink;
    a.volume = clamp(perEntryVolume * masterRef.current);
    const entry: Active = { audio: a, soundId, entryId, perEntryVolume };
    activeRef.current.push(entry);
    recomputePlaying();

    const cleanup = () => removeActive(entry);
    a.addEventListener("ended", cleanup);
    a.addEventListener("error", cleanup);

    const start = () => a.play().catch(cleanup);
    if (supportsSinkId && deviceId && deviceId !== "default" && a.setSinkId) {
      a.setSinkId(deviceId).then(start).catch(start);
    } else {
      start();
    }
  }, [deviceId, supportsSinkId, recomputePlaying, removeActive]);

  const updateEntryVolume = useCallback((entryId: string, perEntryVolume: number) => {
    for (const a of activeRef.current) {
      if (a.entryId === entryId) {
        a.perEntryVolume = perEntryVolume;
        a.audio.volume = clamp(perEntryVolume * masterRef.current);
      }
    }
  }, []);

  const stopEntry = useCallback((entry: Active) => {
    try {
      entry.audio.pause();
      entry.audio.currentTime = 0;
    } catch {/* ignore */}
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
  };
}
