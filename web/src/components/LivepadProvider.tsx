"use client";

// Livepad state (1.5.0). Mounted above the routes so recording survives tab and
// route changes. Armed state is deliberately never persisted: Livepad is off on
// every app start and reload, and only records while the user has it switched on.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LivepadTap } from "@/lib/audio-mixer";
import { analytics } from "@/lib/analytics";
import { useAudio } from "@/components/AudioProvider";
import { useToast } from "@/components/Toast";
import { useChordCapture, useLocalBind } from "@/components/VoiceChangerProvider";
import { useVr } from "@/components/VrProvider";
import { VrBindPicker } from "@/components/VrBindPicker";
import { getProfileBind, setProfileBind } from "@/lib/vr-bind";
import {
  NATIVE_SAMPLE_RATE,
  getNativeCapture,
  isNativeDeviceId,
  isNativeSourceId,
  nativeKeyOf,
  nativeSourceId,
  pcmFromBytes,
  playbackDeviceMatchesOutput,
  type NativeEvent,
  type NativeOpenResult,
  type NativeSources,
} from "@/lib/livepad-native";
import {
  LIVEPAD_DEFAULT_LENGTH_SEC,
  LIVEPAD_MAX_LENGTH_SEC,
  PcmRing,
  clampLengthSec,
  defaultCaptureName,
  encodeWav16,
  livepadPlaybackKey,
  looksLikeSelfCapture,
} from "@/lib/livepad";
import {
  LIVEPAD_DEFAULT_MAX_BYTES,
  LivepadStore,
  clampMaxBytes,
  isQuotaError,
  livepadStoreSupported,
  pickEvictions,
  type LivepadCapture,
} from "@/lib/livepad-store";

const SOURCE_KEY = "soundboard:livepadSource";
const LENGTH_KEY = "soundboard:livepadLengthSec";
const MAX_BYTES_KEY = "soundboard:livepadMaxBytes";
const CHIME_KEY = "soundboard:livepadChime";
// A focused press reaches both the in-app keydown and the OS hook.
const CAPTURE_COALESCE_MS = 200;

type SoundboardBridge = { onAppClosing?: (fn: () => Promise<void>) => () => void };

export type LivepadApi = {
  sourceId: string;
  setSourceId: (id: string) => void;
  lengthSec: number;
  setLengthSec: (sec: number) => void;
  armed: boolean;
  arming: boolean;
  setArmed: (on: boolean) => void;
  selfCaptureRisk: boolean;
  // Desktop only: per-app and playback-device sources from the native helper.
  nativeAvailable: boolean;
  perAppSupported: boolean;
  nativeSources: NativeSources;
  // Tell the helper whether the source picker is on screen.
  setSourcePickerOpen: (open: boolean) => void;
  // Name of the source being waited for while armed but disconnected from it.
  waitingFor: string | null;
  // Name of the armed native source, so the picker can show it while it's gone.
  armedNativeName: string | null;
  // Temp captures on disk, newest first.
  captures: LivepadCapture[];
  storeReady: boolean;
  usedBytes: number;
  maxBytes: number;
  setMaxBytes: (bytes: number) => void;
  // Snapshot the last `lengthSec` seconds into a new card.
  capture: () => Promise<LivepadCapture | null>;
  // Object URL for a capture's current file, created on demand.
  getCaptureUrl: (capture: LivepadCapture) => Promise<string>;
  removeCapture: (id: string) => Promise<void>;
  clearCaptures: () => Promise<void>;
  playCapture: (capture: LivepadCapture) => Promise<void>;
  stopCapture: (id: string) => void;
  setCaptureVolume: (id: string, volume: number) => void;
  renameCapture: (id: string, name: string) => Promise<void>;
  getCaptureFile: (capture: LivepadCapture) => Promise<File>;
  // Overwrite a capture's audio with an edited result. False if it couldn't be saved.
  applyCaptureEdit: (
    id: string,
    wav: Blob,
    fields: { durationSec: number; sampleRate: number; savedSoundId?: string | null; name?: string },
  ) => Promise<boolean>;
  // Add an edited result as a new card, leaving the source capture as it was.
  addEditedCapture: (
    source: LivepadCapture,
    wav: Blob,
    fields: { durationSec: number; sampleRate: number; name: string; savedSoundId?: string | null },
  ) => Promise<boolean>;
  // Record an upload of a capture whose audio didn't change.
  markCaptureSaved: (id: string, savedSoundId: string, name: string) => Promise<void>;
  // Marks the capture open in the editor so the size limit can't remove it.
  setEditingCapture: (id: string | null) => void;
};

// Bind state, in its own context because Dashboard's matchers need it and must not
// re-render on every capture or volume-slider tick.
export type LivepadBindsApi = {
  keybind: string | null;
  setKeybind: (combo: string | null) => void;
  controllerBind: string | null;
  setControllerBind: (bind: string | null) => void;
  capturingKey: boolean;
  setCapturingKey: (v: boolean) => void;
  capturingVr: boolean;
  setCapturingVr: (v: boolean) => void;
  chimeEnabled: boolean;
  setChimeEnabled: (on: boolean) => void;
  // What a keyboard or controller bind fires: captures, never arms and never plays.
  triggerCapture: () => void;
};

const LivepadContext = createContext<LivepadApi | null>(null);
const LivepadBindsContext = createContext<LivepadBindsApi | null>(null);

export function LivepadProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const audio = useAudio();
  const toast = useToast();
  const { startLivepadTap, cancelSound, playCapture: playCaptureUrl, updateEntryVolume, playReadyChime } = audio;
  const { controllerProfile, vrConnected } = useVr();

  const [sourceId, setSourceIdState] = useState("");
  const [lengthSec, setLengthSecState] = useState(LIVEPAD_DEFAULT_LENGTH_SEC);
  const [armed, setArmedState] = useState(false);
  const [arming, setArming] = useState(false);

  const tapRef = useRef<LivepadTap | null>(null);
  const ringRef = useRef<PcmRing | null>(null);
  const armedRef = useRef(false);
  const sourceRef = useRef("");
  // Bumped whenever a start is superseded, so a slow getUserMedia can't revive a
  // tap the user has already turned off or moved away from.
  const genRef = useRef(0);

  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [perAppSupported, setPerAppSupported] = useState(false);
  const [nativeSources, setNativeSources] = useState<NativeSources>({ apps: [], devices: [] });
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [armedNativeName, setArmedNativeName] = useState<string | null>(null);
  const nativeActiveRef = useRef<{ key: string; name: string; waiting: boolean } | null>(null);

  const [captures, setCaptures] = useState<LivepadCapture[]>([]);
  const [storeReady, setStoreReady] = useState(false);
  const [maxBytes, setMaxBytesState] = useState(LIVEPAD_DEFAULT_MAX_BYTES);
  const maxBytesRef = useRef(LIVEPAD_DEFAULT_MAX_BYTES);
  const storeRef = useRef<LivepadStore | null>(null);
  const storeOpeningRef = useRef<Promise<LivepadStore | null> | null>(null);
  const teardownTimerRef = useRef<number | null>(null);
  // The capture open in the editor is never auto-removed.
  const editingIdRef = useRef<string | null>(null);
  const urlsRef = useRef(new Map<string, { fileName: string; url: string }>());
  const lengthRef = useRef(LIVEPAD_DEFAULT_LENGTH_SEC);
  const lastCaptureAtRef = useRef(-Infinity);

  const revokeUrl = useCallback((id: string) => {
    const entry = urlsRef.current.get(id);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    urlsRef.current.delete(id);
  }, []);

  // Everything except the file itself: stop it playing and let go of its URL.
  const releaseCaptures = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        cancelSound(livepadPlaybackKey(id));
        revokeUrl(id);
      }
    },
    [cancelSound, revokeUrl],
  );

  // Open the session's store, restoring the grid after a reload. Teardown is
  // deferred one tick so a Strict Mode remount cancels it instead of deleting the
  // session. A real page reload runs no React cleanup, so the files survive that.
  useEffect(() => {
    if (teardownTimerRef.current !== null) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    } else if (livepadStoreSupported()) {
      storeOpeningRef.current = LivepadStore.open(userId).then(
        (store) => {
          storeRef.current = store;
          setCaptures(store.list());
          setStoreReady(true);
          return store;
        },
        (e) => {
          console.warn("[livepad] temp storage unavailable", (e as Error)?.message);
          toast.error("Livepad couldn't open its temporary storage.");
          return null;
        },
      );
    }
    return () => {
      teardownTimerRef.current = window.setTimeout(() => {
        storeRef.current = null;
        for (const entry of urlsRef.current.values()) URL.revokeObjectURL(entry.url);
        urlsRef.current.clear();
        void storeOpeningRef.current?.then((store) => store?.destroy());
      }, 0);
    };
  }, [userId, toast]);

  // Desktop app: delete the temp files before the window goes away. The main
  // process gives this about a second; anything left is swept on the next launch.
  useEffect(() => {
    const bridge = (window as unknown as { soundboard?: SoundboardBridge }).soundboard;
    return bridge?.onAppClosing?.(async () => {
      genRef.current++;
      const store = await storeOpeningRef.current;
      await store?.destroy();
    });
  }, []);

  const enforceLimit = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    const ids = pickEvictions(store.list(), maxBytesRef.current, editingIdRef.current);
    if (ids.length === 0) return;
    releaseCaptures(ids);
    await store.remove(ids);
    setCaptures(store.list());
    toast.info(
      ids.length === 1
        ? "Removed an older Livepad capture to stay under the temp storage limit."
        : `Removed ${ids.length} older Livepad captures to stay under the temp storage limit.`,
    );
  }, [releaseCaptures, toast]);

  const reportStoreError = useCallback(
    (e: unknown, action: string) => {
      toast.error(
        isQuotaError(e)
          ? "Your browser storage is full, so Livepad couldn't save that. Delete some captures or free up disk space."
          : `Livepad couldn't ${action}: ${(e as Error)?.message || e}`,
      );
    },
    [toast],
  );

  const capture = useCallback(async () => {
    const now = performance.now();
    if (now - lastCaptureAtRef.current < CAPTURE_COALESCE_MS) return null;
    lastCaptureAtRef.current = now;

    const ring = ringRef.current;
    const tap = tapRef.current;
    if (!ring || !tap) {
      toast.info("Livepad isn't recording. Turn it on to capture.");
      return null;
    }
    const store = storeRef.current;
    if (!store) {
      toast.error("Livepad's temporary storage isn't available.");
      return null;
    }
    const pcm = ring.latest(lengthRef.current * tap.sampleRate);
    if (pcm.length === 0) {
      toast.info("Nothing has been recorded yet.");
      return null;
    }
    const createdAt = Date.now();
    try {
      const saved = await store.add(encodeWav16(pcm, tap.sampleRate), {
        id: crypto.randomUUID(),
        createdAt,
        durationSec: pcm.length / tap.sampleRate,
        sampleRate: tap.sampleRate,
        name: defaultCaptureName(new Date(createdAt)),
        volume: 1,
        edited: false,
        savedSoundId: null,
      });
      setCaptures(store.list());
      analytics.livepadCapture();
      await enforceLimit();
      return saved;
    } catch (e) {
      reportStoreError(e, "save that capture");
      return null;
    }
  }, [enforceLimit, reportStoreError, toast]);

  const [keybind, setKeybind] = useLocalBind("soundboard:livepadKeybind");
  const [controllerBind, setControllerBind] = useLocalBind("soundboard:livepadControllerBind");
  const [capturingKey, setCapturingKey] = useState(false);
  const [capturingVr, setCapturingVr] = useState(false);
  const [chimeEnabled, setChimeEnabledState] = useState(true);
  const chimeRef = useRef(true);
  useChordCapture(capturingKey, setCapturingKey, setKeybind);

  useEffect(() => {
    try {
      if (localStorage.getItem(CHIME_KEY) === "off") {
        chimeRef.current = false;
        setChimeEnabledState(false);
      }
    } catch {
      /* default on */
    }
  }, []);

  const setChimeEnabled = useCallback((on: boolean) => {
    chimeRef.current = on;
    setChimeEnabledState(on);
    try {
      localStorage.setItem(CHIME_KEY, on ? "on" : "off");
    } catch {
      /* best effort */
    }
  }, []);

  const triggerCapture = useCallback(() => {
    void capture().then((saved) => {
      if (saved && chimeRef.current) playReadyChime();
    });
  }, [capture, playReadyChime]);

  const getCaptureUrl = useCallback(async (c: LivepadCapture) => {
    const cached = urlsRef.current.get(c.id);
    if (cached?.fileName === c.fileName) return cached.url;
    const store = storeRef.current;
    if (!store) throw new Error("Livepad's temporary storage isn't available.");
    const file = await store.getFile(c);
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(file);
    urlsRef.current.set(c.id, { fileName: c.fileName, url });
    return url;
  }, []);

  const playCapture = useCallback(
    async (c: LivepadCapture) => {
      try {
        playCaptureUrl(c.id, await getCaptureUrl(c), c.volume);
      } catch (e) {
        reportStoreError(e, "play that capture");
      }
    },
    [getCaptureUrl, playCaptureUrl, reportStoreError],
  );

  const stopCapture = useCallback(
    (id: string) => cancelSound(livepadPlaybackKey(id)),
    [cancelSound],
  );

  const setCaptureVolume = useCallback(
    (id: string, volume: number) => {
      const store = storeRef.current;
      if (!store) return;
      store.setVolume(id, volume);
      setCaptures(store.list());
      updateEntryVolume(livepadPlaybackKey(id), volume);
    },
    [updateEntryVolume],
  );

  const renameCapture = useCallback(
    async (id: string, name: string) => {
      const store = storeRef.current;
      if (!store) return;
      try {
        await store.update(id, { name });
      } catch (e) {
        reportStoreError(e, "rename that capture");
      }
      setCaptures(store.list());
    },
    [reportStoreError],
  );

  const getCaptureFile = useCallback(async (c: LivepadCapture) => {
    const store = storeRef.current;
    if (!store) throw new Error("Livepad's temporary storage isn't available.");
    return store.getFile(c);
  }, []);

  const applyCaptureEdit = useCallback<LivepadApi["applyCaptureEdit"]>(
    async (id, wav, fields) => {
      const store = storeRef.current;
      if (!store) return false;
      // The old file goes away below, so nothing may still be reading it.
      releaseCaptures([id]);
      try {
        await store.replaceAudio(id, wav, { edited: true, savedSoundId: null, ...fields });
        setCaptures(store.list());
        await enforceLimit();
        return true;
      } catch (e) {
        reportStoreError(e, "save that edit");
        return false;
      }
    },
    [enforceLimit, releaseCaptures, reportStoreError],
  );

  const addEditedCapture = useCallback<LivepadApi["addEditedCapture"]>(
    async (source, wav, { durationSec, sampleRate, name, savedSoundId = null }) => {
      const store = storeRef.current;
      if (!store) return false;
      try {
        await store.add(wav, {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          durationSec,
          sampleRate,
          name,
          volume: source.volume,
          edited: true,
          savedSoundId,
        });
        setCaptures(store.list());
        await enforceLimit();
        return true;
      } catch (e) {
        reportStoreError(e, "add that clip");
        return false;
      }
    },
    [enforceLimit, reportStoreError],
  );

  const markCaptureSaved = useCallback(
    async (id: string, savedSoundId: string, name: string) => {
      const store = storeRef.current;
      if (!store) return;
      try {
        await store.update(id, { savedSoundId, name });
      } catch (e) {
        reportStoreError(e, "mark that capture as saved");
      }
      setCaptures(store.list());
    },
    [reportStoreError],
  );

  const setEditingCapture = useCallback((id: string | null) => {
    editingIdRef.current = id;
  }, []);

  const removeCaptures = useCallback(
    async (ids: string[]) => {
      const store = storeRef.current;
      if (!store || ids.length === 0) return;
      releaseCaptures(ids);
      try {
        await store.remove(ids);
      } catch (e) {
        reportStoreError(e, "delete that capture");
      }
      setCaptures(store.list());
    },
    [releaseCaptures, reportStoreError],
  );

  const removeCapture = useCallback((id: string) => removeCaptures([id]), [removeCaptures]);
  const clearCaptures = useCallback(
    () => removeCaptures(storeRef.current?.list().map((c) => c.id) ?? []),
    [removeCaptures],
  );

  const setMaxBytes = useCallback(
    (bytes: number) => {
      const clamped = clampMaxBytes(bytes);
      maxBytesRef.current = clamped;
      setMaxBytesState(clamped);
      try {
        localStorage.setItem(MAX_BYTES_KEY, String(clamped));
      } catch {
        /* best effort */
      }
      enforceLimit().catch(() => toast.error("Couldn't remove older Livepad captures."));
    },
    [enforceLimit, toast],
  );

  useEffect(() => {
    try {
      const max = localStorage.getItem(MAX_BYTES_KEY);
      if (max !== null) {
        const clamped = clampMaxBytes(Number(max));
        maxBytesRef.current = clamped;
        setMaxBytesState(clamped);
      }
    } catch {
      /* storage blocked: defaults are fine */
    }
  }, []);

  useEffect(() => {
    try {
      const source = localStorage.getItem(SOURCE_KEY);
      if (source) {
        sourceRef.current = source;
        setSourceIdState(source);
      }
      const length = localStorage.getItem(LENGTH_KEY);
      if (length !== null) {
        lengthRef.current = clampLengthSec(Number(length));
        setLengthSecState(lengthRef.current);
      }
    } catch {
      /* storage blocked: defaults are fine */
    }
  }, []);

  const closeTap = useCallback(() => {
    tapRef.current?.stop();
    tapRef.current = null;
    // Freed, not just cleared: audio is only held while armed.
    ringRef.current = null;
  }, []);

  const disarm = useCallback(() => {
    genRef.current++;
    closeTap();
    armedRef.current = false;
    setArmedState(false);
    setArming(false);
  }, [closeTap]);

  // The arm call may be showing the native approval dialog, so this can take a while.
  const openNativeTap = useCallback(
    async (sourceId: string, gen: number): Promise<boolean> => {
      const bridge = getNativeCapture();
      if (!bridge) {
        disarm();
        toast.error("That Livepad source needs the desktop app.");
        return false;
      }
      const key = nativeKeyOf(sourceId);
      const result = await bridge.arm(key);
      if (gen !== genRef.current) {
        if (result.ok) void bridge.disarm();
        return false;
      }
      if (!result.ok) {
        disarm();
        if (result.error === "denied") toast.info("Livepad wasn't allowed to record that source.");
        else toast.error("That Livepad source isn't available. Check it's still running or pick another one.");
        return false;
      }
      nativeActiveRef.current = { key, name: result.name, waiting: false };
      tapRef.current = {
        sampleRate: NATIVE_SAMPLE_RATE,
        stop: () => {
          nativeActiveRef.current = null;
          setWaitingFor(null);
          setArmedNativeName(null);
          void bridge.disarm();
        },
      };
      ringRef.current = new PcmRing(Math.ceil(NATIVE_SAMPLE_RATE * LIVEPAD_MAX_LENGTH_SEC));
      setArmedNativeName(result.name);
      setArmedState(true);
      setArming(false);
      return true;
    },
    [disarm, toast],
  );

  const openTap = useCallback(
    async (deviceId: string): Promise<boolean> => {
      const gen = ++genRef.current;
      closeTap();
      // Set before the await so a source change while still opening restarts too.
      armedRef.current = true;
      setArming(true);
      if (isNativeSourceId(deviceId)) return openNativeTap(deviceId, gen);
      try {
        const tap = await startLivepadTap(
          deviceId,
          (pcm) => ringRef.current?.push(pcm),
          () => {
            if (gen !== genRef.current) return;
            disarm();
            toast.error("The Livepad source was disconnected, so recording stopped.");
          },
        );
        if (gen !== genRef.current) {
          tap.stop();
          return false;
        }
        tapRef.current = tap;
        ringRef.current = new PcmRing(Math.ceil(tap.sampleRate * LIVEPAD_MAX_LENGTH_SEC));
        setArmedState(true);
        setArming(false);
        return true;
      } catch (e) {
        if (gen !== genRef.current) return false;
        disarm();
        const name = (e as Error)?.name;
        toast.error(
          name === "OverconstrainedError" || name === "NotFoundError"
            ? "That Livepad source isn't available. Check it's connected or pick another one."
            : `Couldn't open the Livepad source: ${(e as Error)?.message || e}`,
        );
        return false;
      }
    },
    [closeTap, disarm, openNativeTap, startLivepadTap, toast],
  );

  const setArmed = useCallback(
    (on: boolean) => {
      if (!on) {
        disarm();
        return;
      }
      if (!sourceRef.current) {
        toast.error("Pick a Livepad source first.");
        return;
      }
      void openTap(sourceRef.current).then((ok) => {
        if (ok) analytics.livepadArm();
      });
    },
    [disarm, openTap, toast],
  );

  const setSourceId = useCallback(
    (id: string) => {
      sourceRef.current = id;
      setSourceIdState(id);
      try {
        localStorage.setItem(SOURCE_KEY, id);
      } catch {
        /* best effort */
      }
      if (!armedRef.current) return;
      if (id) void openTap(id); // new line, new buffer
      else disarm();
    },
    [disarm, openTap],
  );

  // Source list and connection changes from the native helper. A lost source stays
  // armed and keeps its buffer: nothing is added to the ring until the source returns.
  useEffect(() => {
    const bridge = getNativeCapture();
    if (!bridge) return;
    const offEvent = bridge.onEvent((e: NativeEvent) => {
      if (e.t === "status") {
        setNativeAvailable(e.available);
        setPerAppSupported(e.perApp);
      } else if (e.t === "sources") {
        setNativeSources({ apps: e.apps, devices: e.devices });
      } else if (e.t === "revoked") {
        if (nativeActiveRef.current) {
          disarm();
          toast.info("Livepad capture approvals were forgotten, so recording stopped.");
        }
      } else if (e.t === "state") {
        const active = nativeActiveRef.current;
        if (!active || active.key !== e.key) return;
        const waiting = e.state === "waiting";
        if (waiting === active.waiting) return;
        active.waiting = waiting;
        setWaitingFor(waiting ? active.name : null);
        if (waiting) toast.info(`Livepad is waiting for ${active.name}.`);
        else toast.success(`Livepad reattached to ${active.name}.`);
      }
    });
    const offPcm = bridge.onPcm((bytes) => {
      if (nativeActiveRef.current) ringRef.current?.push(pcmFromBytes(bytes));
    });
    return () => {
      offEvent();
      offPcm();
    };
  }, [disarm, toast]);

  const setSourcePickerOpen = useCallback((open: boolean) => {
    const bridge = getNativeCapture();
    if (!bridge) return;
    if (!open) {
      void bridge.close();
      return;
    }
    void bridge.open().then((r: NativeOpenResult) => {
      if (!r.available) return; // not ready yet: the helper's status event follows
      setNativeAvailable(r.available);
      setPerAppSupported(r.perApp);
      setNativeSources({ apps: r.apps, devices: r.devices });
    });
  }, []);

  const setLengthSec = useCallback((sec: number) => {
    const clamped = clampLengthSec(sec);
    lengthRef.current = clamped;
    setLengthSecState(clamped);
    try {
      localStorage.setItem(LENGTH_KEY, String(clamped));
    } catch {
      /* best effort */
    }
  }, []);

  // Stop capturing with the provider (sign-out). The engine would also stop it.
  useEffect(
    () => () => {
      genRef.current++;
      closeTap();
    },
    [closeTap],
  );

  const selfCaptureRisk = useMemo(() => {
    const outputs = [audio.deviceId, audio.monitorDeviceId]
      .map((id) => audio.devices.find((d) => d.deviceId === id)?.label)
      .filter((l): l is string => !!l);
    if (isNativeDeviceId(sourceId)) {
      const device = nativeSources.devices.find((d) => nativeSourceId(d.key) === sourceId);
      return !!device && playbackDeviceMatchesOutput(device.name, outputs);
    }
    const source = audio.inputDevices.find((d) => d.deviceId === sourceId);
    if (!source?.label) return false;
    return looksLikeSelfCapture(source.label, outputs);
  }, [audio.devices, audio.inputDevices, audio.deviceId, audio.monitorDeviceId, nativeSources, sourceId]);

  const usedBytes = useMemo(() => captures.reduce((sum, c) => sum + c.sizeBytes, 0), [captures]);

  const value = useMemo<LivepadApi>(
    () => ({
      sourceId,
      setSourceId,
      lengthSec,
      setLengthSec,
      armed,
      arming,
      setArmed,
      selfCaptureRisk,
      nativeAvailable,
      perAppSupported,
      nativeSources,
      setSourcePickerOpen,
      waitingFor,
      armedNativeName,
      captures,
      storeReady,
      usedBytes,
      maxBytes,
      setMaxBytes,
      capture,
      getCaptureUrl,
      removeCapture,
      clearCaptures,
      playCapture,
      stopCapture,
      setCaptureVolume,
      renameCapture,
      getCaptureFile,
      applyCaptureEdit,
      addEditedCapture,
      markCaptureSaved,
      setEditingCapture,
    }),
    [
      sourceId,
      setSourceId,
      lengthSec,
      setLengthSec,
      armed,
      arming,
      setArmed,
      selfCaptureRisk,
      nativeAvailable,
      perAppSupported,
      nativeSources,
      setSourcePickerOpen,
      waitingFor,
      armedNativeName,
      captures,
      storeReady,
      usedBytes,
      maxBytes,
      setMaxBytes,
      capture,
      getCaptureUrl,
      removeCapture,
      clearCaptures,
      playCapture,
      stopCapture,
      setCaptureVolume,
      renameCapture,
      getCaptureFile,
      applyCaptureEdit,
      addEditedCapture,
      markCaptureSaved,
      setEditingCapture,
    ],
  );

  const bindsValue = useMemo<LivepadBindsApi>(
    () => ({
      keybind,
      setKeybind,
      controllerBind,
      setControllerBind,
      capturingKey,
      setCapturingKey,
      capturingVr,
      setCapturingVr,
      chimeEnabled,
      setChimeEnabled,
      triggerCapture,
    }),
    [keybind, setKeybind, controllerBind, setControllerBind, capturingKey, capturingVr, chimeEnabled, setChimeEnabled, triggerCapture],
  );

  return (
    <LivepadBindsContext.Provider value={bindsValue}>
      <LivepadContext.Provider value={value}>
        {children}
        {capturingVr && (
          <VrBindPicker
            initial={getProfileBind(controllerBind, controllerProfile)}
            initialHolds={null}
            vrConnected={vrConnected}
            profile={controllerProfile}
            onCancel={() => setCapturingVr(false)}
            onConfirm={(serialized) => {
              setCapturingVr(false);
              setControllerBind(setProfileBind(controllerBind, controllerProfile, serialized));
            }}
          />
        )}
      </LivepadContext.Provider>
    </LivepadBindsContext.Provider>
  );
}

export function useLivepadBinds(): LivepadBindsApi {
  const ctx = useContext(LivepadBindsContext);
  if (!ctx) throw new Error("useLivepadBinds must be used within a LivepadProvider");
  return ctx;
}

export function useLivepad(): LivepadApi {
  const ctx = useContext(LivepadContext);
  if (!ctx) throw new Error("useLivepad must be used within a LivepadProvider");
  return ctx;
}
