"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type DragEvent as ReactDragEvent } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Play, Trash2, Upload, Keyboard, Globe, Lock, Volume2, Settings, X, Square, Mic, ChevronDown, Youtube, Gamepad2, Tag, Pencil, Plus, GripVertical, ListOrdered, LayoutGrid, Bookmark, Search, Check, HelpCircle, Headphones } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { useAudioOutput } from "@/lib/audio-output";
import { TagChips, TagEditor } from "@/components/Tags";
import { ClipEditor } from "@/components/ClipEditor";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/Select";
import { decodeAudio } from "@/lib/audio-edit";
import {
  isModToken,
  keyTokenFromEvent,
  modsFromEvent,
  sameMods,
  parseKeyCombo,
  canonicalKeyCombo,
  pickLargest,
  type Mods,
} from "@/lib/chord";
import {
  VrMatcher,
  VrBindPreview,
  parseVrBind,
  serializeVrBind,
  getProfileBind,
  setProfileBind,
  formatVrAction,
  vrInputsByHand,
  VR_PROFILES,
  parseToken,
  MAX_STEPS,
  MAX_ACTIONS_PER_STEP,
  type VrEdge,
  type VrAction,
  type VrStep,
  type VrBind,
  type VrBindMode,
  type VrProfile,
  type VrPreviewProgress,
} from "@/lib/vr-bind";

type Sound = {
  id: string;
  name: string;
  originalFilename: string;
  sizeBytes: number;
  isPublic: boolean;
  ownerId: string;
};
type Entry = {
  entry: {
    id: string;
    soundId: string;
    label: string | null;
    keybind: string | null;
    controllerBind: string | null;
    position: number;
    onBoard: boolean;
  };
  sound: Sound;
  ownerName: string | null;
  tags: string[];
};
type Limits = { maxFileSize: number; maxTotalStorage: number };

// Sentinel entryId for the board-level "cancel all" keybind, so the shared
// keybind matching/registration can carry it like a normal bind but route it to
// audio.cancelAll() instead of clip playback.
const CANCEL_ALL_BIND = "__cancelAll__";

// "major.minor" of a semver string — the onboarding guide re-shows on a minor (or
// major) bump but not on patch releases (1.3.0 → 1.3.1 keeps the key "1.3").
function minorKey(v: string): string {
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}` : v;
}
const ONBOARDING_LS_KEY = "soundboard:onboarding";

export function Dashboard({
  limits,
  canUpload,
  user,
  yt,
  appVersion,
}: {
  limits: Limits;
  canUpload: boolean;
  user: { id: string; name: string; role: string | null };
  yt: { enabled: boolean; maxDurationSec: number };
  appVersion: string;
}) {
  const toast = useToast();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  // Which "add a sound" panel is open below the button group (null = collapsed).
  const [addTab, setAddTab] = useState<"upload" | "youtube" | "browse" | null>(null);
  // Controller binds are independent of keybinds (separate capture + state).
  const [capturingVrFor, setCapturingVrFor] = useState<string | null>(null);
  // Cancel-all's controller bind editor is open (no entry id — board-level).
  const [capturingCancelAllVr, setCapturingCancelAllVr] = useState(false);
  const [vrConnected, setVrConnected] = useState(false);
  const [hasDesktop, setHasDesktop] = useState(false);

  // --- Board section: Saved (full library) vs Board (the playable subset) ---
  const [boardTab, setBoardTab] = useState<"board" | "saved">("board");
  const [reordering, setReordering] = useState(false);
  const [savedTagFilter, setSavedTagFilter] = useState<string[]>([]);
  // Which card is expanded into full CRUD (only one at a time keeps it tidy).
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  // Drag-reorder state (Board tab only): the entry id being dragged.
  const [dragId, setDragId] = useState<string | null>(null);

  // Cancel-all keybind — a board-level action bound like a clip, but device-local
  // (no boardEntry to hang it on), so it lives in localStorage. `null` = unbound.
  const [cancelAllKeybind, setCancelAllKeybindState] = useState<string | null>(null);
  const [capturingCancelAll, setCapturingCancelAll] = useState(false);
  // Cancel-all's controller bind — same device-local pattern (serialized VrBind).
  const [cancelAllControllerBind, setCancelAllControllerBindState] = useState<string | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem("soundboard:cancelAllKeybind");
      if (v) setCancelAllKeybindState(v);
      const c = localStorage.getItem("soundboard:cancelAllControllerBind");
      if (c) setCancelAllControllerBindState(c);
    } catch {}
  }, []);
  const setCancelAllKeybind = useCallback((combo: string | null) => {
    setCancelAllKeybindState(combo);
    try {
      if (combo) localStorage.setItem("soundboard:cancelAllKeybind", combo);
      else localStorage.removeItem("soundboard:cancelAllKeybind");
    } catch {}
  }, []);
  const setCancelAllControllerBind = useCallback((bind: string | null) => {
    setCancelAllControllerBindState(bind);
    try {
      if (bind) localStorage.setItem("soundboard:cancelAllControllerBind", bind);
      else localStorage.removeItem("soundboard:cancelAllControllerBind");
    } catch {}
  }, []);

  // --- First-run / new-version onboarding overlay ---
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [boardLoaded, setBoardLoaded] = useState(false);
  const onboardingDecidedRef = useRef(false);
  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    try { localStorage.setItem(ONBOARDING_LS_KEY, minorKey(appVersion)); } catch {}
  }, [appVersion]);

  // All tag names in the system — feeds the per-card tag autocomplete.
  const [allTags, setAllTags] = useState<string[]>([]);
  const refreshTags = useCallback(async () => {
    const j = await fetch("/api/tags").then((r) => r.json()).catch(() => ({}));
    setAllTags(j.tags ?? []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/board");
      if (!res.ok) {
        await toast.fromResponse(res, "Couldn't load your board");
        return;
      }
      const b = await res.json();
      setEntries(b.entries ?? []);
      // Let the nav-bar storage meter refetch its usage.
      window.dispatchEvent(new CustomEvent("soundboard:storage-changed"));
    } catch {
      toast.error("Network error loading your board — check your connection.");
    } finally {
      setBoardLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    refreshTags();
  }, [refresh, refreshTags]);

  // Decide once (after the board has loaded) whether to auto-open the guide:
  // first-ever visit with no sounds yet, or a minor/major version bump since the
  // last time it was dismissed. Patch bumps don't re-trigger.
  useEffect(() => {
    if (!boardLoaded || onboardingDecidedRef.current) return;
    onboardingDecidedRef.current = true;
    try {
      const stored = localStorage.getItem(ONBOARDING_LS_KEY);
      const current = minorKey(appVersion);
      if (stored === current) return; // already seen this release line
      if (stored == null) {
        // Brand-new user: only nag when the board is empty; otherwise quietly mark seen.
        if (entries.length === 0) setShowOnboarding(true);
        else localStorage.setItem(ONBOARDING_LS_KEY, current);
      } else {
        setShowOnboarding(true); // minor/major bump → force-show
      }
    } catch {}
  }, [boardLoaded, entries, appVersion]);

  const saveTags = useCallback(async (soundId: string, next: string[]) => {
    let res: Response;
    try {
      res = await fetch(`/api/sounds/${soundId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
    } catch {
      toast.error("Network error — couldn't save tags.");
      return;
    }
    if (!res.ok) {
      await toast.fromResponse(res, "Couldn't save tags");
      return;
    }
    refresh();
    refreshTags();
  }, [refresh, refreshTags, toast]);

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
  const { play: audioPlay, updateEntryVolume, cancelAll } = audio;
  const setVolume = useCallback((entryId: string, v: number) => {
    setVolumes((prev) => {
      const next = { ...prev, [entryId]: v };
      try { localStorage.setItem("soundboard:volumes", JSON.stringify(next)); } catch {}
      return next;
    });
    updateEntryVolume(entryId, v);
  }, [updateEntryVolume]);

  // Coalesce duplicate triggers for the same entry within a short window. In the
  // Electron app a *focused* keypress on a bound key reaches BOTH the in-app
  // keydown listener AND the OS global hook (which fires regardless of focus),
  // so without this guard the clip would play twice. The window is far below
  // human re-press cadence, so intentional spamming still works.
  const lastPlayRef = useRef<Map<string, number>>(new Map());
  const playEntry = useCallback((entryId: string, soundId: string) => {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const last = lastPlayRef.current.get(entryId) ?? 0;
    if (now - last < 60) return;
    lastPlayRef.current.set(entryId, now);
    audioPlay(soundId, volumes[entryId] ?? 1, entryId);
  }, [audioPlay, volumes]);

  // --- Keybind enable state (persisted in localStorage, this device only) ---
  // `keybindsEnabled` is the master switch; `keybindEnabled[entryId]` is the
  // per-clip switch (missing = on). A clip's keybind fires only when both are on.
  const [keybindsEnabled, setKeybindsEnabledState] = useState(true);
  const [keybindEnabled, setKeybindEnabled] = useState<Record<string, boolean>>({});
  // Controller binds: master switch + per-clip switch (missing = on), same
  // device-local pattern. A bind fires only when both are on.
  const [controllersEnabled, setControllersEnabledState] = useState(true);
  const [controllerEnabled, setControllerEnabled] = useState<Record<string, boolean>>({});
  // Controller hardware profile (Index vs Quest/Touch) — relabels the bind UI;
  // tokens are unchanged. Device-local, mirrors the enable switches.
  const [controllerProfile, setControllerProfileState] = useState<VrProfile>("index");
  useEffect(() => {
    try {
      const g = localStorage.getItem("soundboard:keybindsEnabled");
      if (g != null) setKeybindsEnabledState(g === "true");
      const raw = localStorage.getItem("soundboard:keybindEnabled");
      if (raw) setKeybindEnabled(JSON.parse(raw));
      const cg = localStorage.getItem("soundboard:controllersEnabled");
      if (cg != null) setControllersEnabledState(cg === "true");
      const vr = localStorage.getItem("soundboard:controllerEnabled");
      if (vr) setControllerEnabled(JSON.parse(vr));
      const prof = localStorage.getItem("soundboard:controllerProfile");
      if (prof === "index" || prof === "quest") setControllerProfileState(prof);
    } catch {}
  }, []);
  const setControllerProfile = useCallback((p: VrProfile) => {
    setControllerProfileState(p);
    try { localStorage.setItem("soundboard:controllerProfile", p); } catch {}
  }, []);
  const setKeybindsEnabled = useCallback((on: boolean) => {
    setKeybindsEnabledState(on);
    try { localStorage.setItem("soundboard:keybindsEnabled", String(on)); } catch {}
  }, []);
  const setControllersEnabled = useCallback((on: boolean) => {
    setControllersEnabledState(on);
    try { localStorage.setItem("soundboard:controllersEnabled", String(on)); } catch {}
  }, []);
  const toggleEntryKeybind = useCallback((entryId: string, on: boolean) => {
    setKeybindEnabled((prev) => {
      const next = { ...prev, [entryId]: on };
      try { localStorage.setItem("soundboard:keybindEnabled", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const toggleEntryController = useCallback((entryId: string, on: boolean) => {
    setControllerEnabled((prev) => {
      const next = { ...prev, [entryId]: on };
      try { localStorage.setItem("soundboard:controllerEnabled", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // --- Keyboard binds (chords; modifiers strict, other keys subset-matched) ---
  // Honors the enable toggles above: master switch off → no binds; per-clip off
  // → that clip omitted. Gating here disables a keybind everywhere at once (the
  // in-app listener, the Electron global hook, and the registration call below).
  const keyBinds = useMemo(() => {
    if (!keybindsEnabled) return [];
    const binds = entries.flatMap((e) => {
      // Only board entries are playable via keybind; saved-only clips are inert.
      if (!e.entry.onBoard) return [];
      if (!e.entry.keybind || keybindEnabled[e.entry.id] === false) return [];
      const { mods, keys } = parseKeyCombo(e.entry.keybind);
      if (keys.length === 0) return [];
      return [{
        raw: canonicalKeyCombo(mods, keys),
        mods,
        tokens: new Set(keys),
        entryId: e.entry.id,
        soundId: e.sound.id,
      }];
    });
    // Cancel-all is bound like a clip but uses a sentinel entryId so the
    // listeners can route it to audio.cancelAll() instead of playback.
    if (cancelAllKeybind) {
      const { mods, keys } = parseKeyCombo(cancelAllKeybind);
      if (keys.length > 0) {
        binds.push({
          raw: canonicalKeyCombo(mods, keys),
          mods,
          tokens: new Set(keys),
          entryId: CANCEL_ALL_BIND,
          soundId: "",
        });
      }
    }
    return binds;
  }, [entries, keybindsEnabled, keybindEnabled, cancelAllKeybind]);

  // Canonical combo string -> entry, for Electron global-hook lookups + registration.
  const keybindByCombo = useMemo(() => {
    const map = new Map<string, { entryId: string; soundId: string }>();
    for (const b of keyBinds) map.set(b.raw, { entryId: b.entryId, soundId: b.soundId });
    return map;
  }, [keyBinds]);

  // In-browser keyboard matching: track held non-modifier keys, fire on the key
  // that completes a bound chord (largest wins). Modifiers come from event flags.
  const heldKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const token = keyTokenFromEvent(ev);
      if (!token || isModToken(token)) return; // modifiers tracked via flags only
      if (ev.repeat) return; // ignore auto-repeat
      heldKeysRef.current.add(token);
      if (capturingFor || capturingCancelAll) return; // capture handles its own keys
      const mods = modsFromEvent(ev);
      const candidates = keyBinds.filter((b) => sameMods(b.mods, mods));
      const best = pickLargest(heldKeysRef.current, token, candidates);
      if (best) {
        ev.preventDefault();
        if (best.entryId === CANCEL_ALL_BIND) cancelAll();
        else playEntry(best.entryId, best.soundId);
      }
    }
    function onKeyUp(ev: KeyboardEvent) {
      const token = keyTokenFromEvent(ev);
      if (token && !isModToken(token)) heldKeysRef.current.delete(token);
    }
    function clearHeld() { heldKeysRef.current.clear(); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearHeld);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearHeld);
    };
  }, [keyBinds, capturingFor, capturingCancelAll, playEntry, cancelAll]);

  // Capture a chord for the cancel-all keybind: hold keys together, release to
  // confirm (mirrors the per-clip capture in SoundCard). Escape cancels.
  useEffect(() => {
    if (!capturingCancelAll) return;
    const held = new Set<string>();
    let peakKeys: string[] = [];
    let peakMods: Mods = { ctrl: false, alt: false, shift: false, meta: false };
    let peakSize = 0;
    const sizeOf = (m: Mods, keys: number) =>
      keys + (m.ctrl ? 1 : 0) + (m.alt ? 1 : 0) + (m.shift ? 1 : 0) + (m.meta ? 1 : 0);
    function onKeyDown(ev: KeyboardEvent) {
      ev.preventDefault();
      if (ev.key === "Escape") { setCapturingCancelAll(false); return; }
      const token = keyTokenFromEvent(ev);
      if (!token || isModToken(token)) return;
      if (!ev.repeat) held.add(token);
      const mods = modsFromEvent(ev);
      const s = sizeOf(mods, held.size);
      if (s > peakSize) { peakSize = s; peakKeys = [...held]; peakMods = mods; }
    }
    function onKeyUp(ev: KeyboardEvent) {
      const token = keyTokenFromEvent(ev);
      if (token && !isModToken(token)) held.delete(token);
      if (held.size > 0 || peakKeys.length === 0) return; // wait for full release
      setCancelAllKeybind(canonicalKeyCombo(peakMods, peakKeys));
      setCapturingCancelAll(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturingCancelAll, setCancelAllKeybind]);

  // OS-level global shortcut events forwarded by the Electron hook (already
  // chord-matched there); look up the canonical combo and play.
  useEffect(() => {
    function onGlobal(ev: Event) {
      const detail = (ev as CustomEvent<{ combo: string }>).detail;
      if (!detail?.combo) return;
      const { mods, keys } = parseKeyCombo(detail.combo);
      const hit = keybindByCombo.get(canonicalKeyCombo(mods, keys));
      if (hit) {
        if (hit.entryId === CANCEL_ALL_BIND) cancelAll();
        else playEntry(hit.entryId, hit.soundId);
      }
    }
    window.addEventListener("soundboard:globalKey", onGlobal as EventListener);
    return () => window.removeEventListener("soundboard:globalKey", onGlobal as EventListener);
  }, [keybindByCombo, playEntry, cancelAll]);

  // Tell the Electron host (if any) which keybinds to register globally.
  useEffect(() => {
    const api = (window as unknown as { soundboard?: { registerKeybinds?: (combos: string[]) => void } }).soundboard;
    if (api?.registerKeybinds) {
      api.registerKeybinds([...keybindByCombo.keys()]);
    }
  }, [keybindByCombo]);

  // --- Controller (Valve Index) binds: chords, independent of keybinds ---
  useEffect(() => {
    setHasDesktop(!!(window as unknown as { soundboard?: unknown }).soundboard);
  }, []);

  // Step/sequence matcher (lib/vr-bind.ts). One stateful engine for the device;
  // we reconcile its bind set when the board changes and feed it controller
  // edges. entryId → soundId lets the matcher's hit drive playback.
  const vrMatcherRef = useRef<VrMatcher | null>(null);
  if (vrMatcherRef.current === null) vrMatcherRef.current = new VrMatcher();
  const vrSoundByEntry = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) if (e.entry.onBoard) m.set(e.entry.id, e.sound.id);
    return m;
  }, [entries]);
  useEffect(() => {
    const binds = !controllersEnabled
      ? []
      : entries.flatMap((e) => {
          if (!e.entry.onBoard || !e.entry.controllerBind) return [];
          if (controllerEnabled[e.entry.id] === false) return []; // per-clip switch off
          // Only the current profile's bind is active (binds are per-profile).
          const bind = parseVrBind(getProfileBind(e.entry.controllerBind, controllerProfile));
          return bind ? [{ id: e.entry.id, bind }] : [];
        });
    // Cancel-all is a board-level bind routed through the same matcher via the
    // sentinel id (gated only by the master controller switch, like its keybind).
    if (controllersEnabled) {
      const cab = parseVrBind(getProfileBind(cancelAllControllerBind, controllerProfile));
      if (cab) binds.push({ id: CANCEL_ALL_BIND, bind: cab });
    }
    vrMatcherRef.current!.setBinds(binds);
  }, [entries, controllersEnabled, controllerEnabled, cancelAllControllerBind, controllerProfile]);

  // Feed press/release edges to the matcher; play the most-specific bind that
  // completes. Skipped while the bind editor is open (and the matcher is reset
  // on open/close) so editor presses don't leak into playback.
  useEffect(() => {
    function onVrInput(ev: Event) {
      const detail = (ev as CustomEvent<{ token: string; pressed: boolean }>).detail;
      if (!detail?.token || capturingVrFor || capturingCancelAllVr) return;
      const edge: VrEdge = detail.pressed ? "down" : "up";
      const hitId = vrMatcherRef.current!.feed(detail.token, edge, performance.now());
      if (hitId === CANCEL_ALL_BIND) cancelAll();
      else if (hitId) {
        const soundId = vrSoundByEntry.get(hitId);
        if (soundId) playEntry(hitId, soundId);
      }
    }
    window.addEventListener("soundboard:vrInput", onVrInput as EventListener);
    return () => window.removeEventListener("soundboard:vrInput", onVrInput as EventListener);
  }, [capturingVrFor, capturingCancelAllVr, vrSoundByEntry, playEntry, cancelAll]);

  useEffect(() => {
    vrMatcherRef.current!.reset();
  }, [capturingVrFor, capturingCancelAllVr]);

  // SteamVR connection status from the native bridge.
  useEffect(() => {
    function onVrStatus(ev: Event) {
      const detail = (ev as CustomEvent<{ steamvr: boolean }>).detail;
      setVrConnected(!!detail?.steamvr);
    }
    window.addEventListener("soundboard:vrStatus", onVrStatus as EventListener);
    return () => window.removeEventListener("soundboard:vrStatus", onVrStatus as EventListener);
  }, []);

  // --- Upload ---
  const fileRef = useRef<HTMLInputElement>(null);
  const [makePublic, setMakePublic] = useState(false);
  const [clipName, setClipName] = useState("");
  const [uploadTags, setUploadTags] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  // Pre-upload editor: once a file is picked we decode it and show the trim /
  // volume editor; confirming it encodes a fresh mp3 and uploads that.
  const [editBuf, setEditBuf] = useState<AudioBuffer | null>(null);
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);

  function resetUpload() {
    if (fileRef.current) fileRef.current.value = "";
    setClipName("");
    setUploadTags([]);
    setFileName(null);
    setMakePublic(false);
    if (editUrl) URL.revokeObjectURL(editUrl);
    setEditUrl(null);
    setEditBuf(null);
  }

  async function onPickFile(f: File | undefined) {
    setErr(null);
    if (editUrl) URL.revokeObjectURL(editUrl);
    setEditUrl(null);
    setEditBuf(null);
    setFileName(f?.name ?? null);
    if (!f) return;
    if (f.size > limits.maxFileSize) {
      setErr(`File too large. Max ${formatBytes(limits.maxFileSize)}.`);
      return;
    }
    setDecoding(true);
    try {
      const data = await f.arrayBuffer();
      const buf = await decodeAudio(data);
      setEditBuf(buf);
      setEditUrl(URL.createObjectURL(f));
    } catch {
      setErr("Couldn't read that audio file — is it a valid mp3?");
    } finally {
      setDecoding(false);
    }
  }

  async function uploadBlob(blob: Blob) {
    setErr(null);
    setBusy(true);
    const fd = new FormData();
    const base = (fileName ?? "clip.mp3").replace(/\.[^.]+$/, "");
    fd.append("file", new File([blob], `${base}.mp3`, { type: "audio/mpeg" }));
    fd.append("isPublic", String(makePublic));
    // Blank name → server falls back to the filename (sans .mp3).
    const name = clipName.trim();
    if (name) fd.append("name", name);
    // Tags are optional here; the server applies `misc` when none are given.
    if (uploadTags.length) fd.append("tags", JSON.stringify(uploadTags));
    let res: Response;
    try {
      res = await fetch("/api/sounds", { method: "POST", body: fd });
    } catch {
      setBusy(false);
      const msg = "Network error during upload — check your connection.";
      setErr(msg);
      toast.error(msg);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = res.status === 429 ? "Uploading too fast — please wait a moment." : (j.error ?? "Upload failed");
      setErr(msg);
      toast.error(msg);
      return;
    }
    resetUpload();
    toast.success("Clip uploaded.");
    refresh();
  }

  // Fire a board/sound mutation and surface any failure as a toast. Returns true
  // on success so callers can decide whether to refresh / follow up.
  async function mutate(url: string, init: RequestInit, failMsg: string): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      toast.error("Network error — check your connection and try again.");
      return false;
    }
    if (!res.ok) {
      await toast.fromResponse(res, failMsg);
      return false;
    }
    return true;
  }

  const jsonPatch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  async function setKeybind(entryId: string, combo: string | null) {
    if (await mutate(`/api/board/${entryId}`, jsonPatch({ keybind: combo }), "Couldn't update keybind")) refresh();
  }

  async function setControllerBind(entryId: string, token: string | null) {
    if (await mutate(`/api/board/${entryId}`, jsonPatch({ controllerBind: token }), "Couldn't update controller bind")) refresh();
  }

  async function removeEntry(entryId: string) {
    if (await mutate(`/api/board/${entryId}`, { method: "DELETE" }, "Couldn't remove that entry")) refresh();
  }

  async function deleteSound(soundId: string) {
    if (!confirm("Delete this sound? It will be removed from every board.")) return;
    if (await mutate(`/api/sounds/${soundId}`, { method: "DELETE" }, "Couldn't delete that sound")) {
      toast.success("Sound deleted.");
      refresh();
    }
  }

  async function togglePublic(soundId: string, next: boolean) {
    if (await mutate(`/api/sounds/${soundId}`, jsonPatch({ isPublic: next }), "Couldn't change visibility")) refresh();
  }

  // Add/remove an entry from the playable board (it stays in Saved either way).
  async function setOnBoard(entryId: string, on: boolean) {
    const failMsg = on ? "Couldn't add to board" : "Couldn't remove from board";
    if (await mutate(`/api/board/${entryId}`, jsonPatch({ onBoard: on }), failMsg)) refresh();
  }

  // --- Saved / Board derived lists ---
  // Board = the playable subset, ordered by position. Saved = the full library,
  // optionally filtered to clips matching ANY selected tag (OR).
  const boardList = useMemo(
    () => entries.filter((e) => e.entry.onBoard).sort((a, b) => a.entry.position - b.entry.position),
    [entries]
  );
  const savedTagPool = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }, [entries]);
  const savedList = useMemo(() => {
    if (savedTagFilter.length === 0) return entries;
    return entries.filter((e) => e.tags.some((t) => savedTagFilter.includes(t)));
  }, [entries, savedTagFilter]);
  // Sounds already in the library — lets the inline public browser mark/disable
  // clips the user has already saved.
  const savedSoundIds = useMemo(() => new Set(entries.map((e) => e.sound.id)), [entries]);

  // Persist a reordering of the board: rewrite positions 0..n-1 to match the new
  // visual order and PATCH each entry. Optimistically updates local state first.
  const commitOrder = useCallback(async (ordered: Entry[]) => {
    setEntries((prev) => {
      const pos = new Map(ordered.map((e, i) => [e.entry.id, i]));
      return prev.map((e) =>
        pos.has(e.entry.id) ? { ...e, entry: { ...e.entry, position: pos.get(e.entry.id)! } } : e
      );
    });
    const results = await Promise.all(
      ordered.map((e, i) =>
        fetch(`/api/board/${e.entry.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: i }),
        }).catch(() => null)
      )
    );
    if (results.some((r) => !r || !r.ok)) {
      toast.error("Couldn't save the new order — reverting.");
      refresh();
    }
  }, [toast, refresh]);

  // Drop the dragged entry in front of `targetId` and persist the new order.
  const onReorderDrop = useCallback((targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const order = entries.filter((e) => e.entry.onBoard).sort((a, b) => a.entry.position - b.entry.position);
    const from = order.findIndex((e) => e.entry.id === dragId);
    const to = order.findIndex((e) => e.entry.id === targetId);
    if (from === -1 || to === -1) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    setDragId(null);
    void commitOrder(order);
  }, [dragId, entries, commitOrder]);

  // Shared card render for both the Board and Saved grids — keeps the long prop
  // wiring in one place.
  const renderCard = (e: Entry, view: "board" | "saved") => (
    <SoundCard
      key={e.entry.id}
      entry={e}
      view={view}
      isOwner={e.sound.ownerId === user.id}
      tags={e.tags}
      allTags={allTags}
      onTagsChange={(next) => saveTags(e.sound.id, next)}
      capturing={capturingFor === e.entry.id}
      isPlaying={audio.playingSoundIds.has(e.sound.id)}
      onPlay={() => playEntry(e.entry.id, e.sound.id)}
      onCancel={() => audio.cancelSound(e.sound.id)}
      volume={volumes[e.entry.id] ?? 1}
      onVolumeChange={(v) => setVolume(e.entry.id, v)}
      keybindsGloballyEnabled={keybindsEnabled}
      keybindEnabled={keybindEnabled[e.entry.id] !== false}
      onToggleKeybind={(on) => toggleEntryKeybind(e.entry.id, on)}
      controllersGloballyEnabled={controllersEnabled}
      controllerEnabled={controllerEnabled[e.entry.id] !== false}
      onToggleController={(on) => toggleEntryController(e.entry.id, on)}
      controllerProfile={controllerProfile}
      onCaptureStart={() => setCapturingFor(e.entry.id)}
      onCaptureCancel={() => setCapturingFor(null)}
      onCaptured={(combo) => {
        setCapturingFor(null);
        setKeybind(e.entry.id, combo);
      }}
      onClearKey={() => setKeybind(e.entry.id, null)}
      hasDesktop={hasDesktop}
      vrConnected={vrConnected}
      controllerCapturing={capturingVrFor === e.entry.id}
      onControllerCaptureStart={() => setCapturingVrFor(e.entry.id)}
      onControllerCaptureCancel={() => setCapturingVrFor(null)}
      onControllerCaptured={(token) => {
        setCapturingVrFor(null);
        // Merge into this profile's slot, preserving the other profile's bind.
        setControllerBind(e.entry.id, setProfileBind(e.entry.controllerBind, controllerProfile, token));
      }}
      onClearController={() =>
        setControllerBind(e.entry.id, setProfileBind(e.entry.controllerBind, controllerProfile, null))
      }
      onRemove={() => removeEntry(e.entry.id)}
      onDeleteSound={() => deleteSound(e.sound.id)}
      onTogglePublic={(next) => togglePublic(e.sound.id, next)}
      expanded={expandedCard === e.entry.id}
      onToggleExpand={() => setExpandedCard((id) => (id === e.entry.id ? null : e.entry.id))}
      onBoard={e.entry.onBoard}
      onSetOnBoard={(on) => setOnBoard(e.entry.id, on)}
    />
  );

  return (
    <div className="space-y-8">
      {showOnboarding && <OnboardingOverlay onClose={dismissOnboarding} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Hey, {user.name.split(" ")[0]} 👋
          </h1>
          <p className="text-muted mt-1">Trigger your sounds, organize your board, and tweak playback.</p>
        </div>
        <button
          type="button"
          className="btn-ghost text-sm shrink-0"
          onClick={() => setShowOnboarding(true)}
          title="Show the setup guide"
        >
          <HelpCircle size={15} className="mr-1" /> Guide
        </button>
      </div>

      <ControlPanel audio={audio} />

      <section className="card">
        <div className="flex gap-2 flex-wrap">
          {canUpload && (
            <AddTabButton
              icon={<Upload size={18} />}
              label="Upload a sound"
              active={addTab === "upload"}
              onClick={() => setAddTab((t) => (t === "upload" ? null : "upload"))}
            />
          )}
          {canUpload && yt.enabled && (
            <AddTabButton
              icon={<Youtube size={18} />}
              label="Import from YouTube"
              active={addTab === "youtube"}
              onClick={() => setAddTab((t) => (t === "youtube" ? null : "youtube"))}
            />
          )}
          {/* Available to everyone — adding public clips doesn't require upload rights. */}
          <AddTabButton
            icon={<Search size={18} />}
            label="Browse public"
            active={addTab === "browse"}
            onClick={() => setAddTab((t) => (t === "browse" ? null : "browse"))}
          />
        </div>
        {!canUpload && (
          <p className="text-sm text-muted mt-3 flex items-center gap-2">
            <Lock size={14} className="shrink-0" />
            Uploading isn&apos;t enabled for your account yet — but you can browse and save public clips.
          </p>
        )}
        <Collapsible open={addTab !== null}>
          <div className="mt-4 pt-4 border-t border-white/10">
            {addTab === "upload" && canUpload && (
              <>
                <p className="text-sm text-muted mb-4">
                  Add an .mp3 to your board. Give it a name, then trim it and set its volume before it
                  lands.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-xs text-muted mb-1">Audio file</span>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/mpeg,.mp3"
                      onChange={(e) => onPickFile(e.target.files?.[0])}
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
                  <label className="flex items-center gap-3 text-sm select-none sm:col-span-2">
                    <Toggle checked={makePublic} onChange={setMakePublic} label="Share this clip publicly" />
                    <span className="flex items-center gap-1.5">
                      {makePublic ? <Globe size={14} /> : <Lock size={14} />}
                      {makePublic ? "Public — others can find and add it" : "Private — only you can use it"}
                    </span>
                  </label>
                  <div className="sm:col-span-2">
                    <span className="block text-xs text-muted mb-1">
                      Tags <span className="text-muted/60">(optional — defaults to “misc”)</span>
                    </span>
                    <TagEditor value={uploadTags} suggestions={allTags} onChange={setUploadTags} />
                  </div>
                </div>
                {decoding && <p className="text-muted text-sm mt-3">Reading clip…</p>}
                {editBuf && editUrl && (
                  <div className="mt-4">
                    <ClipEditor
                      buffer={editBuf}
                      objectUrl={editUrl}
                      busy={busy}
                      confirmLabel={busy ? "Uploading…" : "Upload to board"}
                      onConfirm={uploadBlob}
                      onCancel={resetUpload}
                    />
                  </div>
                )}
                {err && <p className="text-red-300 text-sm mt-3">{err}</p>}
              </>
            )}
            {addTab === "youtube" && yt.enabled && canUpload && (
              <YouTubeImport maxDurationSec={yt.maxDurationSec} allTags={allTags} onImported={refresh} />
            )}
            {addTab === "browse" && (
              <BrowsePublicPanel
                audio={audio}
                savedSoundIds={savedSoundIds}
                onAdded={() => { refresh(); refreshTags(); }}
              />
            )}
          </div>
        </Collapsible>
      </section>

      <section>
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          {/* Saved / Board pill tabs (mirrors the Control Panel / add-a-sound groups). */}
          <div className="flex items-center gap-2">
            <AddTabButton
              icon={<LayoutGrid size={18} />}
              label="Board"
              active={boardTab === "board"}
              onClick={() => setBoardTab("board")}
            />
            <AddTabButton
              icon={<Bookmark size={18} />}
              label="Saved"
              active={boardTab === "saved"}
              onClick={() => setBoardTab("saved")}
            />
            {hasDesktop && (
              <span
                className={`chip ${vrConnected ? "text-emerald-300" : "text-muted"}`}
                title="Valve Index controller status"
              >
                <Gamepad2 size={12} className="mr-1" />
                {vrConnected ? "SteamVR connected" : "SteamVR not detected"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 flex-wrap">
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
            {hasDesktop && (
              <label className="flex items-center gap-2.5 text-sm select-none" title="When off, no controller binds trigger playback">
                <Gamepad2 size={15} className={controllersEnabled ? "text-accent" : "text-muted"} />
                <span className={controllersEnabled ? "" : "text-muted"}>
                  Controller {controllersEnabled ? "on" : "off"}
                </span>
                <Toggle
                  checked={controllersEnabled}
                  onChange={setControllersEnabled}
                  label="Toggle all controller binds"
                />
              </label>
            )}
            {hasDesktop && (
              <label className="flex items-center gap-2 text-sm select-none" title="Relabels controller binds to match your headset's controllers">
                <span className="text-muted">Controllers</span>
                <Select
                  className="!py-1.5 text-xs min-w-[9rem]"
                  aria-label="Controller profile"
                  value={controllerProfile}
                  onChange={(v) => setControllerProfile(v as VrProfile)}
                  options={VR_PROFILES.map((p) => ({ value: p.value, label: p.label }))}
                />
              </label>
            )}
          </div>
        </div>

        {/* --- Board tab: the playable subset, draggable to reorder --- */}
        {boardTab === "board" && (
          <>
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <p className="text-sm text-muted">
                {boardList.length === 0
                  ? "Nothing on your board yet — add clips from the Saved tab."
                  : `${boardList.length} sound${boardList.length === 1 ? "" : "s"} on your board.`}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Cancel all + its keybind, grouped in one sub-card so it's clear
                    the keybind triggers Cancel all. Board-level action, bindable
                    like a clip. */}
                <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
                  <button
                    type="button"
                    className="btn-ghost text-xs disabled:opacity-50"
                    onClick={() => cancelAll()}
                    disabled={!audio.anyPlaying}
                    title="Stop every sound that's currently playing"
                  >
                    <Square size={14} className="mr-1" />
                    Cancel all
                  </button>
                  <span className="h-4 w-px bg-white/10" aria-hidden />
                  <button
                    type="button"
                    className={`btn-ghost text-xs ${capturingCancelAll ? "text-accent" : ""}`}
                    onClick={() => setCapturingCancelAll((c) => !c)}
                    title={
                      capturingCancelAll
                        ? "Hold one or more keys together, then release"
                        : "Set a keybind for Cancel all"
                    }
                  >
                    <Keyboard size={14} className="mr-1" />
                    {capturingCancelAll ? "Hold keys…" : cancelAllKeybind || "Set keybind"}
                  </button>
                  {cancelAllKeybind && !capturingCancelAll && (
                    <button
                      type="button"
                      className="btn-ghost text-xs !px-1.5"
                      onClick={() => setCancelAllKeybind(null)}
                      title="Clear cancel-all keybind"
                    >
                      ×
                    </button>
                  )}
                  {/* Controller bind for Cancel all — only meaningful in the
                      desktop app (where the VR bridge runs). */}
                  {hasDesktop && (
                    <>
                      <span className="h-4 w-px bg-white/10" aria-hidden />
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setCapturingCancelAllVr(true)}
                        title="Set a controller bind for Cancel all"
                      >
                        <Gamepad2 size={14} className="mr-1" />
                        {getProfileBind(cancelAllControllerBind, controllerProfile) ? (
                          <VrBindChips value={getProfileBind(cancelAllControllerBind, controllerProfile)!} />
                        ) : (
                          "Set controller"
                        )}
                      </button>
                      {getProfileBind(cancelAllControllerBind, controllerProfile) && (
                        <button
                          type="button"
                          className="btn-ghost text-xs !px-1.5"
                          onClick={() =>
                            setCancelAllControllerBind(
                              setProfileBind(cancelAllControllerBind, controllerProfile, null),
                            )
                          }
                          title="Clear cancel-all controller bind"
                        >
                          ×
                        </button>
                      )}
                    </>
                  )}
                </div>
                {boardList.length > 1 && (
                  <button
                    type="button"
                    className={`btn-ghost text-xs ${reordering ? "text-accent" : ""}`}
                    onClick={() => setReordering((r) => !r)}
                    title="Drag cards to change their order"
                  >
                    <ListOrdered size={14} className="mr-1" />
                    {reordering ? "Done reordering" : "Reorder"}
                  </button>
                )}
              </div>
            </div>
            {/* Cancel-all controller bind editor (portals to body). */}
            {capturingCancelAllVr && (
              <VrBindPicker
                initial={getProfileBind(cancelAllControllerBind, controllerProfile)}
                vrConnected={vrConnected}
                profile={controllerProfile}
                onCancel={() => setCapturingCancelAllVr(false)}
                onConfirm={(serialized) => {
                  setCapturingCancelAllVr(false);
                  setCancelAllControllerBind(
                    setProfileBind(cancelAllControllerBind, controllerProfile, serialized),
                  );
                }}
              />
            )}
            {boardList.length > 0 && (
              <MasonryGrid className="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {boardList.map((e) =>
                  reordering ? (
                    <div
                      key={e.entry.id}
                      draggable
                      onDragStart={() => setDragId(e.entry.id)}
                      onDragOver={(ev) => ev.preventDefault()}
                      onDrop={() => onReorderDrop(e.entry.id)}
                      className={`relative cursor-grab active:cursor-grabbing rounded-2xl ring-2 transition ${
                        dragId === e.entry.id ? "ring-accent opacity-60" : "ring-white/10"
                      }`}
                    >
                      <div className="absolute right-2 top-2 z-10 text-muted/70">
                        <GripVertical size={16} />
                      </div>
                      {renderCard(e, "board")}
                    </div>
                  ) : (
                    renderCard(e, "board")
                  )
                )}
              </MasonryGrid>
            )}
          </>
        )}

        {/* --- Saved tab: the full library, tag-filterable --- */}
        {boardTab === "saved" && (
          <>
            {entries.length === 0 ? (
              <p className="text-muted">
                No sounds yet. {canUpload ? "Upload one above or browse" : "Browse"} the public list.
              </p>
            ) : (
              <>
                {savedTagPool.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mb-3">
                    <Tag size={13} className="text-muted shrink-0" />
                    {savedTagPool.map((t) => {
                      const on = savedTagFilter.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setSavedTagFilter((prev) =>
                              on ? prev.filter((x) => x !== t) : [...prev, t]
                            )
                          }
                          className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                            on ? "bg-accent/20 text-white" : "bg-white/10 text-muted hover:text-white"
                          }`}
                        >
                          {t}
                        </button>
                      );
                    })}
                    {savedTagFilter.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSavedTagFilter([])}
                        className="text-[11px] text-muted hover:text-white ml-1"
                      >
                        clear
                      </button>
                    )}
                  </div>
                )}
                {savedList.length === 0 ? (
                  <p className="text-muted text-sm">No saved clips match the selected tags.</p>
                ) : (
                  <MasonryGrid className="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                    {savedList.map((e) => renderCard(e, "saved"))}
                  </MasonryGrid>
                )}
              </>
            )}
          </>
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

// First-run / new-version setup guide. A dismissable modal walking through the
// six setup steps. Shown automatically on first visit (empty board) or after a
// minor/major version bump; re-openable via the header "Guide" button.
function OnboardingOverlay({ onClose }: { onClose: () => void }) {
  const steps: { icon: ReactNode; title: string; body: string; optional?: boolean }[] = [
    { icon: <Volume2 size={16} />, title: "Set your output device", body: "Open the Control Panel → Output & volume and pick where sounds play." },
    { icon: <Mic size={16} />, title: "Set up your virtual mic", body: "Optional. Turn on Virtual Mic mode to route the soundboard into a virtual cable so it comes through as your mic in games/calls.", optional: true },
    { icon: <Volume2 size={16} />, title: "Choose a monitoring device", body: "Optional. Pick a device to hear selected lines locally without echoing your own mic.", optional: true },
    { icon: <Upload size={16} />, title: "Add a soundbite", body: "Upload an mp3, import from YouTube, or Browse public clips and save one." },
    { icon: <LayoutGrid size={16} />, title: "Add it to your board", body: "Open the Saved tab and hit “Add to board” — only board clips play and take keybinds." },
    { icon: <Keyboard size={16} />, title: "Set keybinds", body: "Optional. Expand a board card (pencil) and capture a keybind so it fires hands-free.", optional: true },
  ];
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Setup guide"
      onClick={onClose}
    >
      <div
        className="card max-w-lg w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Welcome — let&apos;s get you set up</h2>
            <p className="text-sm text-muted mt-1">A quick tour of the soundboard. Optional steps are marked.</p>
          </div>
          <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close guide">
            <X size={16} />
          </button>
        </div>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] border border-white/10 text-accent">
                {s.icon}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="text-muted">{i + 1}.</span> {s.title}
                  {s.optional && <span className="chip">optional</span>}
                </div>
                <p className="text-xs text-muted mt-0.5">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-primary text-sm" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline public-clip browser shown under the "Browse public" tab — a compact
// mirror of the /public page so users can preview and save other people's clips
// (added as Saved references) without leaving the dashboard.
function BrowsePublicPanel({
  audio,
  savedSoundIds,
  onAdded,
}: {
  audio: ReturnType<typeof useAudioOutput>;
  savedSoundIds: Set<string>;
  onAdded: () => void;
}) {
  const toast = useToast();
  type PublicSound = {
    id: string;
    name: string;
    sizeBytes: number;
    ownerId: string;
    ownerName: string | null;
    mine: boolean;
    tags: string[];
  };
  const [sounds, setSounds] = useState<PublicSound[]>([]);
  const [q, setQ] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/public/sounds")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setSounds(j.sounds ?? []))
      .catch(() => toast.error("Couldn't load public clips."))
      .finally(() => setLoading(false));
  }, [toast]);

  // You can't add your own clips from here (you already own them).
  const others = useMemo(() => sounds.filter((s) => !s.mine), [sounds]);
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of others) for (const t of s.tags) set.add(t);
    return [...set].sort();
  }, [others]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return others.filter((s) => {
      if (needle && !s.name.toLowerCase().includes(needle) && !(s.ownerName ?? "").toLowerCase().includes(needle))
        return false;
      if (selectedTags.length && !selectedTags.some((t) => s.tags.includes(t))) return false;
      return true;
    });
  }, [others, q, selectedTags]);

  async function add(soundId: string) {
    setAdding(soundId);
    let res: Response;
    try {
      res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soundId }),
      });
    } catch {
      setAdding(null);
      toast.error("Network error — couldn't save that clip.");
      return;
    }
    setAdding(null);
    if (res.ok) {
      setAdded((s) => new Set(s).add(soundId));
      toast.success("Saved to your library.");
      onAdded();
    } else {
      await toast.fromResponse(res, "Couldn't save that clip");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <p className="text-sm text-muted">Preview and save clips others shared publicly.</p>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9 w-60"
            placeholder="Search name or uploader"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {availableTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <Tag size={13} className="text-muted shrink-0" />
          {availableTags.map((t) => {
            const on = selectedTags.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => setSelectedTags((sel) => (on ? sel.filter((x) => x !== t) : [...sel, t]))}
                className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                  on ? "bg-accent/20 text-white" : "bg-white/10 text-muted hover:text-white"
                }`}
              >
                {t}
              </button>
            );
          })}
          {selectedTags.length > 0 && (
            <button type="button" onClick={() => setSelectedTags([])} className="text-[11px] text-muted hover:text-white ml-1">
              clear
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-muted text-sm">Loading public clips…</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted text-sm">
          {others.length === 0 ? "No public clips from others yet." : "No matches."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[28rem] overflow-y-auto pr-1">
          {filtered.map((s) => {
            const isAdded = added.has(s.id) || savedSoundIds.has(s.id);
            return (
              <li key={s.id} className="card flex items-center gap-3">
                <button
                  className="btn-primary !rounded-xl !px-3 !py-2.5 shrink-0"
                  onClick={() => audio.play(s.id)}
                  title="Play"
                  aria-label={`Play ${s.name}`}
                >
                  <Play size={16} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-sm">{s.name}</div>
                  <div className="text-[11px] text-muted truncate mt-0.5">
                    {s.ownerName ?? "unknown"} · {formatBytes(s.sizeBytes)}
                  </div>
                  {s.tags.length > 0 && <TagChips tags={s.tags} className="mt-1.5" />}
                </div>
                <button
                  className={isAdded ? "btn-ghost text-xs !text-emerald-300 !border-emerald-400/30" : "btn-ghost text-xs"}
                  disabled={adding === s.id || isAdded}
                  onClick={() => add(s.id)}
                  title={isAdded ? "Already in your Saved library" : "Save to your library"}
                >
                  {isAdded ? <Check size={14} className="mr-1" /> : <Plus size={14} className="mr-1" />}
                  {isAdded ? "Saved" : "Save"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Paste a YouTube link → server fetches, trims, and transcodes it to an mp3 as
// a background job. We enqueue, then poll the job until it's done or errors.
function YouTubeImport({
  maxDurationSec,
  allTags,
  onImported,
}: {
  maxDurationSec: number;
  allTags: string[];
  onImported: () => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [makePublic, setMakePublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Post-import editor: the finished import is pulled back to the client to be
  // trimmed/leveled, then re-encoded and stored as a new clip. The original
  // auto-imported clip is deleted on confirm (or kept as-is on cancel).
  const [editBuf, setEditBuf] = useState<AudioBuffer | null>(null);
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const [oldSoundId, setOldSoundId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  // Cancel any in-flight poll loop if the component unmounts.
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  function resetEdit() {
    if (editUrl) URL.revokeObjectURL(editUrl);
    setEditUrl(null);
    setEditBuf(null);
    setOldSoundId(null);
    setUrl("");
    setName("");
    setTags([]);
    setMakePublic(false);
  }

  // Pull the freshly imported clip back to the client and open the editor.
  async function prepareEdit(soundId: string) {
    setPreparing(true);
    try {
      const [fileRes, listRes] = await Promise.all([
        fetch(`/api/sounds/${soundId}/file`),
        fetch(`/api/sounds`),
      ]);
      const ab = await fileRes.arrayBuffer();
      const buf = await decodeAudio(ab);
      const list = await listRes.json().catch(() => ({}));
      const meta = (list.sounds ?? []).find((s: { id: string; name: string }) => s.id === soundId);
      if (meta?.name && !name.trim()) setName(meta.name);
      setOldSoundId(soundId);
      setEditBuf(buf);
      setEditUrl(URL.createObjectURL(new Blob([ab], { type: "audio/mpeg" })));
    } catch {
      // The import already succeeded; if we can't pull it back, just show it.
      onImported();
    } finally {
      setPreparing(false);
      setBusy(false);
    }
  }

  // Encode the trimmed/leveled clip, store it as a new sound, and drop the
  // original un-edited import.
  async function finishEdit(blob: Blob) {
    setBusy(true);
    const base = (name.trim() || "youtube").replace(/[^\w.-]+/g, "_").slice(0, 80) || "youtube";
    const fd = new FormData();
    fd.append("file", new File([blob], `${base}.mp3`, { type: "audio/mpeg" }));
    fd.append("isPublic", String(makePublic));
    if (name.trim()) fd.append("name", name.trim());
    // Optional tags; the server applies `misc` when none are given.
    if (tags.length) fd.append("tags", JSON.stringify(tags));
    let res: Response;
    try {
      res = await fetch("/api/sounds", { method: "POST", body: fd });
    } catch {
      setBusy(false);
      toast.error("Network error saving the edited clip.");
      return;
    }
    if (!res.ok) {
      setBusy(false);
      await toast.fromResponse(res, "Couldn't save the edited clip");
      return;
    }
    if (oldSoundId) {
      await fetch(`/api/sounds/${oldSoundId}`, { method: "DELETE" }).catch(() => {});
    }
    setBusy(false);
    resetEdit();
    toast.success("Clip saved.");
    onImported();
  }

  // Keep the original auto-imported clip unedited.
  function keepOriginal() {
    resetEdit();
    onImported();
  }

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
        // Pull the result back for the trim/volume editor; if there's no
        // soundId for some reason, just refresh the board.
        if (j.soundId) void prepareEdit(j.soundId);
        else {
          setBusy(false);
          resetEdit();
          onImported();
        }
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

  if (editBuf && editUrl) {
    return (
      <div>
        <p className="text-sm text-muted mb-4">
          Imported! Trim it and set its default volume below, or keep the original as-is.
        </p>
        <div className="mb-4">
          <span className="block text-xs text-muted mb-1">
            Tags <span className="text-muted/60">(optional — defaults to “misc”)</span>
          </span>
          <TagEditor value={tags} suggestions={allTags} onChange={setTags} />
        </div>
        <ClipEditor
          buffer={editBuf}
          objectUrl={editUrl}
          busy={busy}
          confirmLabel={busy ? "Saving…" : "Save edited clip"}
          onConfirm={finishEdit}
          onCancel={keepOriginal}
        />
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-muted mb-4">
        Paste a YouTube link and we&apos;ll turn it into a clip on your board. Audio is trimmed to
        the first {formatDuration(maxDurationSec)}, then you can fine-tune it before it lands.
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
      {busy && !preparing && (
        <p className="text-muted text-sm mt-3">
          Fetching and converting — this can take up to a couple of minutes. You can keep using the
          board.
        </p>
      )}
      {preparing && <p className="text-muted text-sm mt-3">Loading the clip for editing…</p>}
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

// useLayoutEffect on the client, useEffect on the server (avoids the SSR warning).
const useIsoLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

// A masonry grid that PRESERVES row-major DOM order (so positions + drag-reorder
// keep working) while letting each card take its natural height. Uses the CSS-grid
// row-span trick: tiny auto-rows + a per-card `grid-row-end: span N` measured from
// the card's height, so expanding one card grows only that card (and whatever is
// below it in its column) — never the whole row. Re-measures on resize (ResizeObserver)
// and on add/remove (MutationObserver). SSR/first paint render a plain grid — which
// looks identical while every card is compact — to avoid a flash before measuring.
function MasonryGrid({ className = "", children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => setEnabled(true), []);

  useIsoLayoutEffect(() => {
    if (!enabled) return;
    const grid = ref.current;
    if (!grid) return;
    const ROW = 8; // px per auto-row
    const GAP = 12; // desired vertical gap (matches the gap-3 column gap)
    const items = () => Array.from(grid.children) as HTMLElement[];
    const relayout = () => {
      for (const item of items()) {
        const h = item.getBoundingClientRect().height;
        item.style.gridRowEnd = `span ${Math.max(1, Math.ceil((h + GAP) / ROW))}`;
      }
    };
    const ro = new ResizeObserver(relayout);
    const reobserve = () => {
      ro.disconnect();
      for (const item of items()) ro.observe(item);
      relayout();
    };
    reobserve();
    const mo = new MutationObserver(reobserve);
    mo.observe(grid, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [enabled]);

  return enabled ? (
    <div ref={ref} className={className} style={{ display: "grid", gridAutoRows: "8px", rowGap: 0, alignItems: "start" }}>
      {children}
    </div>
  ) : (
    <div ref={ref} className={`grid ${className} items-start`}>
      {children}
    </div>
  );
}

function SoundCard(props: {
  entry: Entry;
  isOwner: boolean;
  tags: string[];
  allTags: string[];
  onTagsChange: (tags: string[]) => void;
  capturing: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onCancel: () => void;
  onCaptureStart: () => void;
  onCaptureCancel: () => void;
  onCaptured: (combo: string) => void;
  onClearKey: () => void;
  hasDesktop: boolean;
  vrConnected: boolean;
  controllerCapturing: boolean;
  onControllerCaptureStart: () => void;
  onControllerCaptureCancel: () => void;
  onControllerCaptured: (token: string) => void;
  onClearController: () => void;
  onRemove: () => void;
  onDeleteSound: () => void;
  onTogglePublic: (next: boolean) => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  keybindsGloballyEnabled: boolean;
  keybindEnabled: boolean;
  onToggleKeybind: (on: boolean) => void;
  controllersGloballyEnabled: boolean;
  controllerEnabled: boolean;
  onToggleController: (on: boolean) => void;
  controllerProfile: VrProfile;
  // Compact-by-default card: collapsed shows play + name + read-only binds +
  // volume; the pencil expands it into the full CRUD editor below.
  expanded: boolean;
  onToggleExpand: () => void;
  // Which grid this card renders in — drives board-only vs saved-only chrome
  // (uploader line, always-on keybind sub-card, tag chips).
  view: "board" | "saved";
  // Saved vs Board: whether this entry is on the playable board, and the toggle.
  onBoard: boolean;
  onSetOnBoard: (on: boolean) => void;
}) {
  const { entry, capturing } = props;
  const { sound, ownerName } = entry;
  const hasKeybind = !!entry.entry.keybind;
  // Controller binds are per-profile: only the current profile's slot is shown
  // and edited here, so switching profiles "clears" the visible bind.
  const controllerBind = getProfileBind(entry.entry.controllerBind, props.controllerProfile);
  const hasController = !!controllerBind;
  const [editingTags, setEditingTags] = useState(false);

  // Capture a keyboard chord: hold the keys together, release to confirm.
  useEffect(() => {
    if (!capturing) return;
    const held = new Set<string>();
    let peakKeys: string[] = [];
    let peakMods: Mods = { ctrl: false, alt: false, shift: false, meta: false };
    let peakSize = 0;
    const sizeOf = (m: Mods, keys: number) =>
      keys + (m.ctrl ? 1 : 0) + (m.alt ? 1 : 0) + (m.shift ? 1 : 0) + (m.meta ? 1 : 0);
    function onKeyDown(ev: KeyboardEvent) {
      ev.preventDefault();
      if (ev.key === "Escape") {
        props.onCaptureCancel();
        return;
      }
      const token = keyTokenFromEvent(ev);
      if (!token || isModToken(token)) return; // modifiers tracked via flags
      if (!ev.repeat) held.add(token);
      const mods = modsFromEvent(ev);
      const s = sizeOf(mods, held.size);
      if (s > peakSize) {
        peakSize = s;
        peakKeys = [...held];
        peakMods = mods;
      }
    }
    function onKeyUp(ev: KeyboardEvent) {
      const token = keyTokenFromEvent(ev);
      if (token && !isModToken(token)) held.delete(token);
      if (held.size > 0 || peakKeys.length === 0) return; // wait for full release
      const combo = canonicalKeyCombo(peakMods, peakKeys);
      const single =
        peakKeys.length === 1 && !peakMods.ctrl && !peakMods.alt && !peakMods.shift && !peakMods.meta;
      const risk = single ? comboRisk(combo) : null;
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
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturing, props]);

  // Controller binds are composed in the VrBindPicker modal (rendered below when
  // props.controllerCapturing is set) — no live hold-and-release capture here.
  const { expanded } = props;

  return (
    <div className="card flex flex-col gap-2">
      <div className="flex">
        <button
          className={`btn-primary flex-1 text-left min-w-0 ${props.isPlaying ? "rounded-r-none" : ""}`}
          onClick={props.onPlay}
        >
          <Play size={16} className="mr-1 shrink-0" />
          <span className="truncate">
            {props.view === "saved" ? sound.name : entry.entry.label || sound.name}
          </span>
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
      {/* Board view: always-on keybind sub-card (keyboard | controller) so the
          mapping is visible without entering edit mode. */}
      {props.view === "board" && (
        <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-1.5">
          <span
            className={`inline-flex items-center justify-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] ${
              entry.entry.keybind && (!props.keybindEnabled || !props.keybindsGloballyEnabled)
                ? "line-through text-muted/60"
                : "text-muted"
            }`}
            title="Keyboard bind"
          >
            <Keyboard size={11} className="shrink-0" />
            <span className="truncate">{entry.entry.keybind || "—"}</span>
          </span>
          <span
            className={`inline-flex flex-wrap items-center justify-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] ${
              entry.entry.controllerBind && (!props.controllerEnabled || !props.controllersGloballyEnabled)
                ? "line-through text-muted/60 opacity-70"
                : "text-muted"
            }`}
            title="Controller bind"
          >
            <Gamepad2 size={11} className="shrink-0" />
            {controllerBind ? (
              <VrBindChips value={controllerBind} />
            ) : (
              <span>—</span>
            )}
          </span>
        </div>
      )}

      {/* Saved view (compact): tags + a combined uploader · visibility meta line.
          Keybinds are edit-only here — the capture controls live in the expanded
          editor below, mirroring the Board card design. */}
      {props.view === "saved" && (
        <>
          {!(expanded && props.isOwner) && props.tags.length > 0 && <TagChips tags={props.tags} />}
          <div className="flex items-center gap-1.5 text-[11px] text-muted/70 min-w-0">
            <span className="truncate">by {ownerName ?? "unknown"}</span>
            <span aria-hidden>·</span>
            {sound.isPublic ? (
              <span className="inline-flex items-center gap-1 shrink-0">
                <Globe size={11} /> Public
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 shrink-0">
                <Lock size={11} /> Private
              </span>
            )}
          </div>
        </>
      )}

      {/* Volume + the card's two compact actions (order: slider · edit · remove). */}
      <div className="flex items-center gap-2 mt-1">
        <div className="flex items-center gap-2 flex-1 min-w-0" title={`Volume ${Math.round(props.volume * 100)}%`}>
          <Volume2 size={14} className="text-muted shrink-0" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={props.volume}
            onChange={(e) => props.onVolumeChange(Number(e.target.value))}
            className="flex-1 min-w-0 accent-accent"
            aria-label="Volume"
          />
          <span className="shrink-0 text-xs text-muted w-8 text-right">{Math.round(props.volume * 100)}</span>
        </div>
        <button
          className="btn-ghost text-xs !px-2 shrink-0"
          onClick={props.onToggleExpand}
          title={expanded ? "Done editing" : "Edit"}
          aria-label={expanded ? "Collapse card" : "Edit card"}
        >
          {expanded ? "Done" : <Pencil size={14} />}
        </button>
        <button
          className={`btn-ghost text-xs !px-2 shrink-0 ${props.onBoard ? "" : "text-accent"}`}
          onClick={() => props.onSetOnBoard(!props.onBoard)}
          title={props.onBoard ? "Remove from board (keeps it in Saved)" : "Add to your board"}
          aria-label={props.onBoard ? "Remove from board" : "Add to board"}
        >
          {props.onBoard ? <X size={14} /> : <Plus size={14} />}
        </button>
      </div>

      {/* --- Full CRUD, revealed by the pencil --- */}
      {expanded && (
        <>
          <div className="text-xs text-muted truncate" title={sound.originalFilename}>
            {sound.originalFilename}
          </div>

          {props.isOwner ? (
            editingTags ? (
              <div className="flex flex-col gap-1">
                <TagEditor value={props.tags} suggestions={props.allTags} onChange={props.onTagsChange} />
                <button
                  type="button"
                  onClick={() => setEditingTags(false)}
                  className="btn-ghost text-[11px] self-end !py-0.5"
                >
                  Done
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditingTags(true)}
                className="flex items-center gap-1.5 text-left min-w-0"
                title="Edit tags"
              >
                <Tag size={12} className="text-muted shrink-0" />
                {props.tags.length ? (
                  <TagChips tags={props.tags} />
                ) : (
                  <span className="text-[11px] text-muted/60">Add tags</span>
                )}
              </button>
            )
          ) : (
            props.tags.length > 0 && <TagChips tags={props.tags} />
          )}

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
                    : "Click, then hold one or more keys together and release"
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
                {capturing ? "Hold keys…" : entry.entry.keybind || "Set keybind"}
              </span>
            </button>
            {hasKeybind && !capturing && (
              <button className="btn-ghost text-xs" onClick={props.onClearKey} title="Clear">×</button>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1">
            {hasController && (
              <Toggle
                size="sm"
                checked={props.controllerEnabled}
                disabled={!props.controllersGloballyEnabled}
                onChange={props.onToggleController}
                label={`Toggle controller bind for ${entry.entry.label || sound.name}`}
              />
            )}
            <button
              className="btn-ghost flex-1 text-xs min-w-0"
              disabled={!props.hasDesktop}
              onClick={props.onControllerCaptureStart}
              title={
                !props.hasDesktop
                  ? "Controller binds need the desktop app + SteamVR"
                  : hasController && !props.controllersGloballyEnabled
                  ? "Controller binds are globally off"
                  : hasController && !props.controllerEnabled
                  ? "This controller bind is off"
                  : !props.vrConnected
                  ? "SteamVR not detected — start SteamVR to use controller binds"
                  : "Choose Index inputs to bind"
              }
            >
              <Gamepad2 size={14} className="mr-1 shrink-0" />
              {controllerBind ? (
                <span
                  className={
                    !props.controllerEnabled || !props.controllersGloballyEnabled ? "line-through opacity-60" : ""
                  }
                >
                  <VrBindChips value={controllerBind} />
                </span>
              ) : (
                <span className="truncate">{props.hasDesktop ? "Set controller" : "Desktop app required"}</span>
              )}
            </button>
            {controllerBind && (
              <button className="btn-ghost text-xs" onClick={props.onClearController} title="Clear">×</button>
            )}
          </div>

          {props.controllerCapturing && (
            <VrBindPicker
              initial={controllerBind}
              vrConnected={props.vrConnected}
              profile={props.controllerProfile}
              onCancel={props.onControllerCaptureCancel}
              onConfirm={props.onControllerCaptured}
            />
          )}

          {props.isOwner ? (
            <div className="flex items-center justify-between mt-1">
              <button
                className="btn-ghost text-xs"
                onClick={() => props.onTogglePublic(!sound.isPublic)}
                title="Toggle public"
              >
                {sound.isPublic ? <Globe size={14} /> : <Lock size={14} />}
                <span className="ml-1">{sound.isPublic ? "Public" : "Private"}</span>
              </button>
              <button className="btn-danger text-xs" onClick={props.onDeleteSound} title="Delete the file (removes it from every board)">
                <Trash2 size={14} />
              </button>
            </div>
          ) : (
            // Added (referenced) clip — let the user drop the saved reference
            // entirely (distinct from just taking it off the board).
            <div className="flex items-center justify-end mt-1">
              <button className="btn-ghost text-xs" onClick={props.onRemove} title="Remove this saved clip from your library">
                <Trash2 size={14} className="mr-1" /> Remove from Saved
              </button>
            </div>
          )}
        </>
      )}

    </div>
  );
}

function ControlPanel({ audio }: { audio: ReturnType<typeof useAudioOutput> }) {
  // Collapsed by default — the slim status bar surfaces the live state so you
  // rarely need to open it. Tab is the section shown once expanded.
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"output" | "mic">("output");
  const labelsHidden = audio.devices.some((d) => !d.label);

  const outputLabel =
    audio.deviceId === "default"
      ? "System default"
      : audio.devices.find((d) => d.deviceId === audio.deviceId)?.label || "Output device";

  // The header meter reads the global output (cable in Virtual Mic mode, else
  // the normal-mode graph). Only animate when there's something to show.
  const showMeter = audio.supportsOutputMeter || audio.virtualMicMode;
  const meterActive = audio.virtualMicMode || audio.anyPlaying;

  return (
    <section className="card !p-0 overflow-hidden">
      {/* Slim status bar — click anywhere to expand. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 p-4 text-left transition-colors hover:bg-white/[0.02]"
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-accent">
          <Settings size={16} />
        </span>
        {/* Title shrinks (truncating) so the status cluster gets the horizontal
            room — the device chip + meter are the more useful at-a-glance info. */}
        <div className="min-w-0 shrink">
          <h2 className="section-title truncate">Control Panel</h2>
          <p className="section-sub hidden sm:block truncate">
            Output{audio.supportsSinkId ? ", volume & Virtual Mic" : " & volume"}
          </p>
        </div>

        {/* Live status cluster (output device · Virtual Mic state · output meter).
            flex-1 claims the leftover width so the chip + meter can stretch. */}
        <div className="ml-auto flex flex-1 items-center justify-end gap-2 min-w-0">
          <span className="chip hidden sm:inline-flex min-w-0 max-w-[14rem] md:max-w-[22rem]" title={outputLabel}>
            <Volume2 size={12} className="shrink-0" />
            <span className="truncate">{outputLabel}</span>
          </span>
          {audio.supportsSinkId && (
            <span
              className={`chip gap-1 shrink-0 ${
                audio.virtualMicMode ? "!border-accent/40 !bg-accent/15 !text-white" : ""
              }`}
            >
              <Mic size={12} className="shrink-0" />
              <span className="hidden md:inline">Virtual Mic</span>
              <span>{audio.virtualMicMode ? "On" : "Off"}</span>
            </span>
          )}
          {showMeter && (
            <LevelMeter
              getPeak={audio.getOutputPeak}
              active={meterActive}
              className="h-1.5 w-16 sm:w-28 md:w-36"
            />
          )}
          <ChevronDown
            size={16}
            className={`text-muted shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          />
        </div>
      </button>

      <Collapsible open={open}>
        <div className="px-4 pb-4">
          <div className="flex gap-2">
            <AddTabButton
              icon={<Volume2 size={18} />}
              label="Output & volume"
              active={tab === "output"}
              onClick={() => setTab("output")}
            />
            {audio.supportsSinkId && (
              <AddTabButton
                icon={<Mic size={18} />}
                label="Virtual Mic mode"
                active={tab === "mic"}
                onClick={() => setTab("mic")}
              />
            )}
          </div>

          <div className="mt-4 grid gap-3">
            {tab === "output" && (
              <>
                {/* Output device + Monitor device on one row; volume below. */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Volume2 size={14} className="text-accent shrink-0" />
                      <span className="text-sm font-medium">Output device</span>
                    </div>
                    {audio.supportsSinkId ? (
                      <>
                        <Select
                          className="w-full"
                          aria-label="Output device"
                          value={audio.deviceId}
                          onChange={(v) => audio.setDeviceId(v)}
                          options={[
                            { value: "default", label: "System default" },
                            ...audio.devices.map((d) => ({
                              value: d.deviceId,
                              label: d.label || `Output ${d.deviceId.slice(0, 6)}`,
                            })),
                          ]}
                        />
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
                    <p className="text-xs text-muted mt-2">
                      {audio.virtualMicMode
                        ? "In Virtual Mic mode this is the cable the soundboard + mics feed into — pick its recording side as your mic in-game."
                        : "Where the soundboard plays so you can hear it."}
                    </p>
                  </div>

                  {/* Monitor device — local listening for Virtual Mic mode. */}
                  {audio.supportsSinkId && (
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Headphones size={14} className="text-accent shrink-0" />
                        <span className="text-sm font-medium">Monitor device</span>
                      </div>
                      <Select
                        className="w-full"
                        aria-label="Monitor device"
                        value={audio.monitorDeviceId}
                        onChange={(v) => audio.setMonitorDeviceId(v)}
                        options={[
                          { value: "default", label: "System default" },
                          ...audio.devices.map((d) => ({
                            value: d.deviceId,
                            label: d.label || `Output ${d.deviceId.slice(0, 6)}`,
                          })),
                        ]}
                      />
                      <p className="text-xs text-muted mt-2">
                        Where you hear the Virtual Mic monitor locally. Set each source&apos;s monitor
                        toggle in the Virtual Mic tab.
                      </p>
                    </div>
                  )}
                </div>

                {/* Master volume — compact row. */}
                <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                  <div className="flex items-center gap-3">
                    <Volume2 size={14} className="text-accent shrink-0" />
                    <span className="text-sm font-medium shrink-0">Master volume</span>
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
                    <span className="text-xs text-muted w-8 text-right tabular-nums">
                      {Math.round(audio.masterVolume * 100)}
                    </span>
                  </div>
                </div>
              </>
            )}

            {tab === "mic" && audio.supportsSinkId && (
              <>
                {/* Enable + mic output volume — the primary controls for this tab. */}
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 min-w-0">
                      <Mic size={15} className="text-accent shrink-0" />
                      <div className="min-w-0">
                        <span className="text-sm font-medium block">Virtual Mic mode</span>
                        <span className="text-xs text-muted">Mix mics + soundboard into a cable as your in-game mic.</span>
                      </div>
                    </div>
                    <Toggle
                      checked={audio.virtualMicMode}
                      onChange={audio.setVirtualMicMode}
                      label="Toggle Virtual Mic mode"
                    />
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="text-sm shrink-0">Mic output volume</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={audio.micOutputVolume}
                      onChange={(e) => audio.setMicOutputVolume(Number(e.target.value))}
                      className="flex-1 accent-accent"
                      aria-label="Mic output volume"
                    />
                    <span className="text-xs text-muted w-8 text-right tabular-nums">
                      {Math.round(audio.micOutputVolume * 100)}
                    </span>
                  </div>
                  {/* Live mic output level lives with the volume it reflects. */}
                  {audio.virtualMicMode && (
                    <div className="mt-3">
                      <PeakMeter getPeak={audio.getCablePeak} active={audio.virtualMicMode} />
                    </div>
                  )}
                </div>
                <VirtualMicPanel audio={audio} />
              </>
            )}
          </div>
        </div>
      </Collapsible>
    </section>
  );
}

// Compact level meter: polls getPeak each frame with peak-hold decay and fills a
// pill green / amber (nearing the limiter) / red (clipping). Shared by the
// Control Panel header (global output) and each Virtual Mic input row. `active`
// gates the rAF loop so idle meters cost nothing.
function LevelMeter({
  getPeak,
  active,
  className = "",
}: {
  getPeak: () => number;
  active: boolean;
  className?: string;
}) {
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
      heldRef.current = Math.max(getPeak(), heldRef.current * 0.92); // peak-hold + decay
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
  const color = level >= 1.0 ? "bg-red-500" : level >= 0.89 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className={`shrink-0 overflow-hidden rounded-full bg-white/10 ${className}`}>
      <div className={`h-full ${color} transition-[width] duration-75`} style={{ width: `${pct}%` }} />
    </div>
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

  return (
    <div>
      <p className="text-xs text-muted">
        Mix your capture devices (mics, virtual cables, GoXLR buses) and the soundboard into a
        virtual audio cable, then pick that cable as your mic in-game. Each source has a cable send
        (what the game hears) and a monitor send (what you hear locally, on the monitor device set
        in the Output tab).
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

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-1">
              <Mic size={14} className="text-accent shrink-0" />
              <span className="text-sm font-medium">Sources → virtual mic</span>
            </div>
            <p className="text-xs text-muted mb-3">
              The soundboard plus every capture device Windows reports — mics, virtual cables
              (VB-Audio, VoiceMeeter) and GoXLR buses (e.g. Broadcast Stream Mix). Enable a source to
              feed it to the game and set its cable volume; flip Monitor to also hear it locally (at
              the same level). To route an app&apos;s audio in, send it to a cable / GoXLR bus in
              Windows and it&apos;ll appear here.
            </p>
            {/* Condensed grid — up to 3 sources per row. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
              {/* Soundboard line — always on, so no enable toggle. */}
              <SourceMixRow
                name="Soundboard"
                volume={audio.soundboardVolume}
                onVolume={(v) => audio.setSoundboardVolume(v)}
                monitorOn={(audio.monitorSends[audio.soundboardKey] ?? 0) > 0}
                onMonitor={(b) => audio.setMonitorSend(audio.soundboardKey, b ? 1 : 0)}
              />
              {audio.inputDevices.length === 0 ? (
                <p className="text-xs text-muted">No capture devices detected.</p>
              ) : (
                audio.inputDevices.map((d) => (
                  <SourceMixRow
                    key={d.deviceId}
                    name={d.label || `Capture ${d.deviceId.slice(0, 6)}`}
                    enabled={audio.inputs.find((i) => i.deviceId === d.deviceId)?.enabled ?? false}
                    onEnable={(b) => audio.setInputEnabled(d.deviceId, b)}
                    volume={audio.inputs.find((i) => i.deviceId === d.deviceId)?.volume ?? 1}
                    onVolume={(v) => audio.setInputVolume(d.deviceId, v)}
                    monitorOn={(audio.monitorSends[d.deviceId] ?? 0) > 0}
                    onMonitor={(b) => audio.setMonitorSend(d.deviceId, b ? 1 : 0)}
                    getPeak={audio.getInputPeak}
                    peakId={d.deviceId}
                    metersActive={on}
                  />
                ))
              )}
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

// One mix source (a capture device or the soundboard): an Enable switch (omitted
// for the always-on soundboard), a cable-volume slider (what the game hears), and
// a Monitor toggle (hear it locally at the same level — the monitor send taps the
// post-volume signal, so "on" == matches the cable). Volume + Monitor are
// disabled until the source is enabled. Shows its own level meter when active.
function SourceMixRow({
  name,
  enabled,
  onEnable,
  volume,
  onVolume,
  monitorOn,
  onMonitor,
  getPeak,
  peakId,
  metersActive,
}: {
  name: string;
  // Omit enabled/onEnable for an always-on source (the soundboard).
  enabled?: boolean;
  onEnable?: (on: boolean) => void;
  volume: number;
  onVolume: (v: number) => void;
  monitorOn: boolean;
  onMonitor: (on: boolean) => void;
  getPeak?: (id: string) => number;
  peakId?: string;
  metersActive?: boolean;
}) {
  const hasEnable = typeof enabled === "boolean";
  const active = hasEnable ? enabled! : true;
  // Stable per-row getter so the meter's rAF loop doesn't restart each render.
  const peakGetter = useCallback(
    () => (getPeak && peakId ? getPeak(peakId) : 0),
    [getPeak, peakId],
  );
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 transition-colors ${
        active ? "border-white/10 bg-white/[0.03]" : "border-white/5 bg-transparent"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {hasEnable && (
          <Toggle size="sm" checked={active} onChange={onEnable!} label={`Enable ${name}`} />
        )}
        <span className="text-sm truncate min-w-0" title={name}>{name}</span>
      </div>
      <div className="flex items-center gap-2">
        <Mic size={12} className="shrink-0 text-muted" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          disabled={!active}
          onChange={(e) => onVolume(Number(e.target.value))}
          className="flex-1 accent-accent disabled:opacity-40"
          aria-label={`Cable volume for ${name}`}
        />
        <span className="text-xs text-muted w-7 text-right tabular-nums">
          {Math.round(volume * 100)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1.5">
        <span className="flex items-center gap-1 text-xs text-muted">
          <Headphones size={12} className="shrink-0" /> Monitor
        </span>
        <Toggle
          size="sm"
          checked={monitorOn}
          onChange={onMonitor}
          disabled={!active}
          label={`Monitor ${name}`}
        />
      </div>
      {getPeak && peakId && active && (
        <LevelMeter getPeak={peakGetter} active={!!metersActive} className="h-1 w-full mt-2" />
      )}
    </div>
  );
}

// --- VR controller bind UI ---

// Render a stored bind as wrapping per-action pills, steps separated by "→".
// Handles sequences + down/up edges; long binds wrap instead of truncating.
function VrBindChips({ value }: { value: string }) {
  const bind = parseVrBind(value);
  if (!bind) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 min-w-0">
      {bind.steps.map((step, si) => (
        <span key={si} className="inline-flex flex-wrap items-center gap-1">
          {si > 0 && <span className="px-0.5 text-[10px] text-muted/60">→</span>}
          <span className="inline-flex flex-wrap items-center gap-0.5">
            {step.map((a, ai) => (
              <span
                key={ai}
                className="inline-flex items-center rounded bg-black/25 px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap"
              >
                {formatVrAction(a)}
              </span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

// A removable action chip inside the bind builder / a committed step.
function VrActionChip({ a, onRemove }: { a: VrAction; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/15 px-2 py-1 text-xs whitespace-nowrap">
      {formatVrAction(a)}
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted hover:text-white" aria-label="Remove action">
          <X size={12} />
        </button>
      )}
    </span>
  );
}

// One palette entry: a press (↓) / release (↑) pair for a single input. Each is
// drag-and-droppable into the builder's current-step zone, and click-to-add as a
// fallback. The edge arrow distinguishes down from up.
function VrPaletteRow({ input, onAdd }: { input: string; onAdd: (a: VrAction) => void }) {
  const p = parseToken(input);
  const dragHandlers = (edge: VrEdge) => ({
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ input, edge }));
      e.dataTransfer.effectAllowed = "copy";
    },
  });
  const btn =
    "rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs hover:bg-white/[0.09] active:scale-95 cursor-grab transition";
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1">
      <span className="truncate text-xs text-muted">{p?.key ?? input}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" className={btn} title="Press (down)" onClick={() => onAdd({ input, edge: "down" })} {...dragHandlers("down")}>
          ↓
        </button>
        <button type="button" className={btn} title="Release (up)" onClick={() => onAdd({ input, edge: "up" })} {...dragHandlers("up")}>
          ↑
        </button>
      </span>
    </div>
  );
}

// Controller-bind editor — a full-screen drag-flow builder. Palette of all 32
// actions (16 inputs × press/release) at the top; drag (or click) them into the
// builder's "current step" group. In Sequence mode "Add as next step" commits a
// group and starts the next, building an ordered combo; Simultaneous mode is a
// single group held together. A live test area shows progress as you physically
// perform the bind. Persists the serialized VrBind via onConfirm (see
// lib/vr-bind.ts).
function VrBindPicker({
  initial,
  vrConnected,
  profile = "index",
  onCancel,
  onConfirm,
}: {
  initial: string | null;
  vrConnected: boolean;
  profile?: VrProfile;
  onCancel: () => void;
  onConfirm: (serialized: string) => void;
}) {
  // Seed the builder from any existing bind: earlier steps become committed,
  // the last step stays editable as the "current" group.
  const seed = initial ? parseVrBind(initial) : null;
  const [mode, setMode] = useState<VrBindMode>(seed?.mode ?? "simul");
  const [steps, setSteps] = useState<VrStep[]>(seed ? seed.steps.slice(0, -1) : []);
  const [current, setCurrent] = useState<VrStep>(seed ? seed.steps[seed.steps.length - 1] : []);
  const [dragOver, setDragOver] = useState(false);

  const allSteps: VrStep[] = [...steps, ...(current.length ? [current] : [])];
  const totalActions = allSteps.reduce((n, s) => n + s.length, 0);
  const canSave = totalActions > 0;
  const bind: VrBind = { mode, steps: allSteps };
  const previewKey = canSave ? serializeVrBind(bind) : "";

  // --- builder ops ---
  const addToCurrent = (a: VrAction) =>
    setCurrent((prev) => {
      if (prev.some((x) => x.input === a.input && x.edge === a.edge)) return prev;
      if (prev.length >= MAX_ACTIONS_PER_STEP) return prev;
      return [...prev, a];
    });
  const removeCurrent = (i: number) => setCurrent((c) => c.filter((_, idx) => idx !== i));
  const removeFromStep = (si: number, ai: number) =>
    setSteps((s) => s.map((st, idx) => (idx === si ? st.filter((_, j) => j !== ai) : st)).filter((st) => st.length));
  const commitStep = () => {
    if (!current.length || steps.length >= MAX_STEPS - 1) return;
    setSteps((s) => [...s, current]);
    setCurrent([]);
  };
  const clearAll = () => {
    setSteps([]);
    setCurrent([]);
  };
  const switchMode = (next: VrBindMode) => {
    if (next === mode) return;
    if (next === "simul") {
      // Flatten every action into the single group (dedupe, cap respected).
      const merged: VrStep = [];
      for (const a of [...steps.flat(), ...current]) {
        if (merged.length >= MAX_ACTIONS_PER_STEP) break;
        if (!merged.some((x) => x.input === a.input && x.edge === a.edge)) merged.push(a);
      }
      setSteps([]);
      setCurrent(merged);
    }
    setMode(next);
  };

  // --- live test/preview ---
  const previewRef = useRef<VrBindPreview | null>(null);
  if (!previewRef.current) previewRef.current = new VrBindPreview(bind);
  const [progress, setProgress] = useState<VrPreviewProgress | null>(null);
  const [fired, setFired] = useState(false);
  const firedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const b = previewKey ? parseVrBind(previewKey) : null;
    previewRef.current!.setBind(b ?? { mode: "simul", steps: [] });
    setProgress(b ? previewRef.current!.snapshot() : null);
  }, [previewKey]);

  useEffect(() => {
    function onVrInput(ev: Event) {
      const d = (ev as CustomEvent<{ token: string; pressed: boolean }>).detail;
      if (!d?.token) return;
      const p = previewRef.current!.feed(d.token, d.pressed ? "down" : "up", performance.now());
      setProgress(p);
      if (p.justFired) {
        setFired(true);
        window.clearTimeout(firedTimer.current);
        firedTimer.current = window.setTimeout(() => {
          setFired(false);
          setProgress(previewRef.current!.snapshot());
        }, 900);
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onCancel();
    }
    window.addEventListener("soundboard:vrInput", onVrInput as EventListener);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("soundboard:vrInput", onVrInput as EventListener);
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(firedTimer.current);
    };
  }, [onCancel]);

  const onDropCurrent = (e: ReactDragEvent) => {
    e.preventDefault();
    setDragOver(false);
    try {
      const a = JSON.parse(e.dataTransfer.getData("text/plain")) as VrAction;
      if (a && typeof a.input === "string" && (a.edge === "down" || a.edge === "up")) addToCurrent(a);
    } catch {
      /* not one of our drags */
    }
  };

  // Render a committed (read-only-ish) step group with per-action removal.
  const StepGroup = ({ step, onRemoveAction }: { step: VrStep; onRemoveAction: (ai: number) => void }) => (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1.5">
      {step.map((a, ai) => (
        <VrActionChip key={ai} a={a} onRemove={() => onRemoveAction(ai)} />
      ))}
    </div>
  );

  // Portal to <body>: the card ancestor uses backdrop-filter (.glass), which
  // creates a containing block for position:fixed — without the portal the modal
  // is trapped inside the card grid instead of covering the viewport.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Controller bind editor"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-3xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header + mode toggle */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
              <Gamepad2 size={18} /> Controller bind
            </h2>
            <p className="text-xs text-muted mt-1">
              Drag actions into the bar below (or click them).{" "}
              {!vrConnected && "SteamVR isn’t detected — you can still build the bind now."}
            </p>
          </div>
          <button type="button" className="btn-ghost !px-2" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 mb-4 text-xs">
          {(["simul", "seq"] as VrBindMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`rounded-md px-3 py-1 transition ${
                mode === m ? "bg-accent/20 text-white" : "text-muted hover:text-white"
              }`}
            >
              {m === "simul" ? "Simultaneous" : "Sequence"}
            </button>
          ))}
          <span className="self-center px-2 text-[11px] text-muted/70">
            {mode === "simul" ? "hold together" : "in order, step by step"}
          </span>
        </div>

        {/* Palette */}
        <div className="grid grid-cols-2 gap-3">
          {vrInputsByHand(profile).map((group) => (
            <div key={group.hand} className="flex flex-col gap-1">
              <div className="px-0.5 text-[11px] font-medium text-muted">{group.label}</div>
              {group.inputs.map((input) => (
                <VrPaletteRow key={input} input={input} onAdd={addToCurrent} />
              ))}
            </div>
          ))}
        </div>

        {/* Builder bar */}
        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted/70">Bind</div>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-2">
            {steps.map((step, si) => (
              <div key={si} className="flex items-center gap-2">
                <StepGroup step={step} onRemoveAction={(ai) => removeFromStep(si, ai)} />
                <span className="text-muted/60">→</span>
              </div>
            ))}

            {/* Current-step drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDropCurrent}
              className={`flex min-h-[2.75rem] min-w-[10rem] flex-1 flex-wrap items-center gap-1 rounded-lg border-2 border-dashed p-1.5 transition ${
                dragOver ? "border-accent/70 bg-accent/10" : "border-white/15 bg-white/[0.02]"
              }`}
            >
              {current.length === 0 && (
                <span className="px-1 text-xs text-muted/60">
                  {steps.length ? "Drop the next step’s actions here" : "Drag or click actions to add them"}
                </span>
              )}
              {current.map((a, i) => (
                <VrActionChip key={i} a={a} onRemove={() => removeCurrent(i)} />
              ))}
            </div>

            {mode === "seq" && (
              <button
                type="button"
                className="btn-ghost text-xs whitespace-nowrap"
                onClick={commitStep}
                disabled={!current.length || steps.length >= MAX_STEPS - 1}
                title="Commit this group and start the next step"
              >
                <Plus size={14} className="mr-1" /> Add as next step
              </button>
            )}
          </div>
        </div>

        {/* Live test / preview */}
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted/70">Test it</span>
            {fired ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                <Check size={13} /> Matched!
              </span>
            ) : (
              <span className="text-[11px] text-muted/60">
                {vrConnected ? "perform the bind to verify" : "connect SteamVR to test"}
              </span>
            )}
          </div>
          {progress && canSave ? (
            <div className="flex flex-wrap items-center gap-2">
              {allSteps.map((step, si) => (
                <div key={si} className="flex items-center gap-2">
                  <div
                    className={`flex flex-wrap items-center gap-1 rounded-lg border p-1.5 transition ${
                      si === progress.stepIdx && !fired
                        ? "border-accent/70 bg-accent/10"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    {step.map((a, ai) => {
                      const ok = progress.satisfied[si]?.[ai];
                      return (
                        <span
                          key={ai}
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap transition ${
                            ok ? "bg-emerald-500/25 text-emerald-200" : "bg-black/25 text-muted"
                          }`}
                        >
                          {formatVrAction(a)}
                        </span>
                      );
                    })}
                  </div>
                  {si < allSteps.length - 1 && <span className="text-muted/60">→</span>}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted/60">Add at least one action to build a bind.</span>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between">
          <button type="button" className="btn-ghost text-xs" onClick={clearAll} disabled={!canSave}>
            Clear
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost text-sm" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={() => onConfirm(serializeVrBind(bind))}
              disabled={!canSave}
            >
              Save bind
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
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
