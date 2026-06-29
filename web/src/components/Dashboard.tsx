"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type DragEvent as ReactDragEvent } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Play, Trash2, Upload, Keyboard, Globe, Lock, Volume2, Settings, X, Square, Mic, ChevronDown, Youtube, Gamepad2, Tag, Pencil, Plus, GripVertical, ListOrdered, LayoutGrid, Bookmark, Search, Check, Sliders, ArrowUp, ArrowDown } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { type AudioOutput, type AiConfig } from "@/lib/audio-output";
import {
  EFFECT_DEFS,
  makeEffect,
  effectLabel,
  type EffectConfig,
  type EffectKind,
} from "@/lib/voice-fx";
import {
  AI_PRESETS,
  AI_CUSTOM_ID,
  AI_MODEL_CREDIT,
  AI_PRIVACY_NOTICE,
  type AiVoice,
} from "@/lib/voice-ai";
import { useAudio } from "@/components/AudioProvider";
import { useProfiles } from "@/components/ProfileProvider";
import { useVoiceChanger } from "@/components/VoiceChangerProvider";
import { useVr } from "@/components/VrProvider";
import { VrBindPicker } from "@/components/VrBindPicker";
import { VrBindChips } from "@/components/VrBindChips";
import { SoundEffectsPanel } from "@/components/SoundEffectsModal";
import { AiMainSection } from "@/components/AiVoicePanel";
import { Popover } from "@/components/Popover";
import { analytics } from "@/lib/analytics";
import { TagChips, TagEditor } from "@/components/Tags";
import { ClipEditor } from "@/components/ClipEditor";
import { useToast } from "@/components/Toast";
import { Select, type SelectOption } from "@/components/Select";
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
  parseVrBind,
  getProfileBind,
  setProfileBind,
  applyHolds,
  VR_PROFILES,
  type VrEdge,
  type VrProfile,
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

// Sentinel entryId for the AI voice-changer push-to-talk hotkey, routed like
// cancel-all through the keyboard + VR matchers but driving startPtt/stopPtt.
const AI_PTT_BIND = "__aiPtt__";

// Sentinel entryId for the AI replay hotkey — re-injects the last converted clip
// (audio.replayLastConversion), routed through the same matchers (one-shot).
const AI_REPLAY_BIND = "__aiReplay__";

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
  // Active profile (ver/1.4.1): board placements are per-profile, so every board
  // GET/PATCH carries the active profile id. A ref lets the plain mutation helpers
  // read the current id without being rebound on each switch.
  const { activeProfileId } = useProfiles();
  const activeProfileIdRef = useRef<string | null>(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
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
  // Controller profile + SteamVR/desktop presence now live in the shared
  // VrProvider (so the header Voice-changer popover can drive them too).
  const { controllerProfile, setControllerProfile, vrConnected, hasDesktop } = useVr();

  // --- Board section: Saved (full library) vs Board (the playable subset) ---
  const [boardTab, setBoardTab] = useState<"board" | "saved">("board");
  const [reordering, setReordering] = useState(false);
  const [savedTagFilter, setSavedTagFilter] = useState<string[]>([]);
  // Saved tab: limit to the user's own uploads (exclude saved references to
  // other people's public clips). Ephemeral, like the tag filter.
  const [savedMineOnly, setSavedMineOnly] = useState(false);
  // Saved tab: free-text search over clip name / author. Ephemeral, like the filters.
  const [savedSearch, setSavedSearch] = useState("");
  // Which card is expanded into full CRUD (only one at a time keeps it tidy).
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  // Just-uploaded sounds get a highlight + "New" badge on the Saved tab so they're
  // easy to find. Ephemeral (session-only); cleared on hover or when added to a board.
  const [newSavedIds, setNewSavedIds] = useState<Set<string>>(new Set());
  const markNewSaved = useCallback((soundId: string) => {
    setNewSavedIds((prev) => new Set(prev).add(soundId));
  }, []);
  const clearNewSaved = useCallback((soundId: string) => {
    setNewSavedIds((prev) => {
      if (!prev.has(soundId)) return prev;
      const next = new Set(prev);
      next.delete(soundId);
      return next;
    });
  }, []);
  // Drag-reorder state (Board tab only): the entry id being dragged.
  const [dragId, setDragId] = useState<string | null>(null);

  // Cancel-all keybind — a board-level action bound like a clip, but device-local
  // (no boardEntry to hang it on), so it lives in localStorage. `null` = unbound.
  const [cancelAllKeybind, setCancelAllKeybindState] = useState<string | null>(null);
  const [capturingCancelAll, setCapturingCancelAll] = useState(false);
  // Cancel-all's controller bind — same device-local pattern (serialized VrBind).
  const [cancelAllControllerBind, setCancelAllControllerBindState] = useState<string | null>(null);
  // Per-action VR min-hold durations (ms), device-local. Indexed [step][action]
  // against the active profile's bind; the serialized VrBind itself is unchanged.
  // Entries: { [entryId]: number[][] }; cancel-all has its own matrix.
  const [holdMsByEntry, setHoldMsByEntryState] = useState<Record<string, number[][]>>({});
  const [cancelAllHoldMs, setCancelAllHoldMsState] = useState<number[][] | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem("soundboard:cancelAllKeybind");
      if (v) setCancelAllKeybindState(v);
      const c = localStorage.getItem("soundboard:cancelAllControllerBind");
      if (c) setCancelAllControllerBindState(c);
      const h = localStorage.getItem("soundboard:holdMs");
      if (h) {
        const o = JSON.parse(h);
        if (o && typeof o === "object") setHoldMsByEntryState(o as Record<string, number[][]>);
      }
      const ch = localStorage.getItem("soundboard:cancelAllHoldMs");
      if (ch) {
        const o = JSON.parse(ch);
        if (Array.isArray(o)) setCancelAllHoldMsState(o as number[][]);
      }
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
  // A `holds` matrix with no positive entry is dropped (stored as no-hold).
  const hasAnyHold = (holds: number[][]) => holds.some((s) => s.some((ms) => ms > 0));
  const setEntryHoldMs = useCallback((entryId: string, holds: number[][] | null) => {
    setHoldMsByEntryState((prev) => {
      const next = { ...prev };
      if (holds && hasAnyHold(holds)) next[entryId] = holds;
      else delete next[entryId];
      try {
        if (Object.keys(next).length) localStorage.setItem("soundboard:holdMs", JSON.stringify(next));
        else localStorage.removeItem("soundboard:holdMs");
      } catch {}
      return next;
    });
  }, []);
  const setCancelAllHoldMs = useCallback((holds: number[][] | null) => {
    const keep = holds && hasAnyHold(holds) ? holds : null;
    setCancelAllHoldMsState(keep);
    try {
      if (keep) localStorage.setItem("soundboard:cancelAllHoldMs", JSON.stringify(keep));
      else localStorage.removeItem("soundboard:cancelAllHoldMs");
    } catch {}
  }, []);

  // AI push-to-talk bind state is shared via VoiceChangerProvider so the header
  // Voice-changer popover and this matcher read/write the same device-local binds
  // (keyboard combo + per-profile serialized controller bind). The keyboard
  // chord-capture and the VR bind pickers (PTT + replay) render from the
  // provider/VrProvider; this component only reads the binds + capture flags to
  // gate + drive its playback matcher.
  const {
    aiPttKeybind,
    setAiPttKeybind,
    aiPttControllerBind,
    capturingAiPtt,
    setCapturingAiPtt,
    capturingAiPttVr,
    aiReplayKeybind,
    aiReplayControllerBind,
    capturingAiReplay,
    capturingAiReplayVr,
  } = useVoiceChanger();

  // All tag names in the system — feeds the per-card tag autocomplete.
  const [allTags, setAllTags] = useState<string[]>([]);
  const refreshTags = useCallback(async () => {
    const j = await fetch("/api/tags").then((r) => r.json()).catch(() => ({}));
    setAllTags(j.tags ?? []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const pid = activeProfileIdRef.current;
      const res = await fetch(`/api/board${pid ? `?profileId=${encodeURIComponent(pid)}` : ""}`);
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
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    refreshTags();
  }, [refresh, refreshTags]);

  // Re-fetch the board when the active profile changes — placements are
  // per-profile, so a switch swaps the whole board layout / binds.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId]);

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
  const audio = useAudio();
  const { play: audioPlay, updateEntryVolume, cancelAll, startPtt, stopPtt, replayLastConversion } = audio;
  // Capture devices with AI enabled — the PTT hotkey records from all of them.
  const aiPttDevices = useMemo(
    () =>
      Object.entries(audio.voiceFx)
        .filter(([k, fx]) => k !== audio.soundboardKey && fx.ai?.enabled)
        .map(([k]) => k),
    [audio.voiceFx, audio.soundboardKey],
  );
  const aiPttDevicesRef = useRef<string[]>(aiPttDevices);
  aiPttDevicesRef.current = aiPttDevices;
  const startAiPtt = useCallback(() => {
    for (const d of aiPttDevicesRef.current) startPtt(d);
  }, [startPtt]);
  const stopAiPtt = useCallback(() => {
    for (const d of aiPttDevicesRef.current) stopPtt(d);
  }, [stopPtt]);
  // Tracks an in-flight PTT hold so the right release edge stops it.
  const aiPttKeyRef = useRef<string | null>(null);
  const vrPttActiveRef = useRef(false);
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
  // `preview` (Saved-tab card plays) forces the local-only route so it never
  // leaks into the virtual-mic cable; Board plays / binds leave it false.
  const playEntry = useCallback((entryId: string, soundId: string, preview = false) => {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const last = lastPlayRef.current.get(entryId) ?? 0;
    if (now - last < 60) return;
    lastPlayRef.current.set(entryId, now);
    audioPlay(soundId, volumes[entryId] ?? 1, entryId, preview);
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
  // controllerProfile + its persistence/setter live in VrProvider (useVr above).
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
    } catch {}
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
    // AI push-to-talk hotkey, also routed via a sentinel (hold semantics handled
    // in the key listeners). Gated by the master keybinds switch like the rest.
    if (aiPttKeybind) {
      const { mods, keys } = parseKeyCombo(aiPttKeybind);
      if (keys.length > 0) {
        binds.push({
          raw: canonicalKeyCombo(mods, keys),
          mods,
          tokens: new Set(keys),
          entryId: AI_PTT_BIND,
          soundId: "",
        });
      }
    }
    // AI replay hotkey — one-shot, routed via its own sentinel.
    if (aiReplayKeybind) {
      const { mods, keys } = parseKeyCombo(aiReplayKeybind);
      if (keys.length > 0) {
        binds.push({
          raw: canonicalKeyCombo(mods, keys),
          mods,
          tokens: new Set(keys),
          entryId: AI_REPLAY_BIND,
          soundId: "",
        });
      }
    }
    return binds;
  }, [entries, keybindsEnabled, keybindEnabled, cancelAllKeybind, aiPttKeybind, aiReplayKeybind]);

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
      if (capturingFor || capturingCancelAll || capturingAiPtt || capturingAiReplay) return; // capture handles its own keys
      const mods = modsFromEvent(ev);
      const candidates = keyBinds.filter((b) => sameMods(b.mods, mods));
      const best = pickLargest(heldKeysRef.current, token, candidates);
      if (best) {
        ev.preventDefault();
        if (best.entryId === CANCEL_ALL_BIND) cancelAll();
        else if (best.entryId === AI_PTT_BIND) {
          // Hold: start on the completing key, stop when that key releases.
          if (aiPttKeyRef.current === null) { aiPttKeyRef.current = token; startAiPtt(); }
        } else if (best.entryId === AI_REPLAY_BIND) replayLastConversion();
        else playEntry(best.entryId, best.soundId);
      }
    }
    function onKeyUp(ev: KeyboardEvent) {
      const token = keyTokenFromEvent(ev);
      if (token && !isModToken(token)) heldKeysRef.current.delete(token);
      // Release the PTT hold when its completing key lifts.
      if (token && aiPttKeyRef.current === token) { aiPttKeyRef.current = null; stopAiPtt(); }
    }
    function clearHeld() {
      heldKeysRef.current.clear();
      // A blur mid-hold would otherwise strand the PTT capture open.
      if (aiPttKeyRef.current !== null) { aiPttKeyRef.current = null; stopAiPtt(); }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearHeld);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearHeld);
    };
  }, [keyBinds, capturingFor, capturingCancelAll, capturingAiPtt, capturingAiReplay, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion]);

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

  // (The AI push-to-talk keyboard chord-capture moved to VoiceChangerProvider so
  // the header popover's "Set keybind" works regardless of which page is mounted.)

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
        // PTT: start recording on the down edge; the up edge below stops it (true
        // hold even while unfocused). startPtt is idempotent so a repeat is safe.
        else if (hit.entryId === AI_PTT_BIND) startAiPtt();
        else if (hit.entryId === AI_REPLAY_BIND) replayLastConversion();
        else playEntry(hit.entryId, hit.soundId);
      }
    }
    // Release edge forwarded by the Electron hook (ver/1.4.2) — ends a held PTT.
    function onGlobalUp(ev: Event) {
      const detail = (ev as CustomEvent<{ combo: string }>).detail;
      if (!detail?.combo) return;
      const { mods, keys } = parseKeyCombo(detail.combo);
      const hit = keybindByCombo.get(canonicalKeyCombo(mods, keys));
      if (hit?.entryId === AI_PTT_BIND) stopAiPtt();
    }
    window.addEventListener("soundboard:globalKey", onGlobal as EventListener);
    window.addEventListener("soundboard:globalKeyUp", onGlobalUp as EventListener);
    return () => {
      window.removeEventListener("soundboard:globalKey", onGlobal as EventListener);
      window.removeEventListener("soundboard:globalKeyUp", onGlobalUp as EventListener);
    };
  }, [keybindByCombo, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion]);

  // Tell the Electron host (if any) which keybinds to register globally.
  useEffect(() => {
    const api = (window as unknown as { soundboard?: { registerKeybinds?: (combos: string[]) => void } }).soundboard;
    if (api?.registerKeybinds) {
      api.registerKeybinds([...keybindByCombo.keys()]);
    }
  }, [keybindByCombo]);

  // --- Controller (Valve Index) binds: chords, independent of keybinds ---
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
          // Attach device-local per-action min-holds onto the parsed bind.
          return bind ? [{ id: e.entry.id, bind: applyHolds(bind, holdMsByEntry[e.entry.id]) }] : [];
        });
    // Cancel-all is a board-level bind routed through the same matcher via the
    // sentinel id (gated only by the master controller switch, like its keybind).
    if (controllersEnabled) {
      const cab = parseVrBind(getProfileBind(cancelAllControllerBind, controllerProfile));
      if (cab) binds.push({ id: CANCEL_ALL_BIND, bind: applyHolds(cab, cancelAllHoldMs) });
      // AI push-to-talk controller bind (hold semantics handled in onVrInput).
      const ptt = parseVrBind(getProfileBind(aiPttControllerBind, controllerProfile));
      if (ptt) binds.push({ id: AI_PTT_BIND, bind: ptt });
      // AI replay controller bind (one-shot).
      const rep = parseVrBind(getProfileBind(aiReplayControllerBind, controllerProfile));
      if (rep) binds.push({ id: AI_REPLAY_BIND, bind: rep });
    }
    vrMatcherRef.current!.setBinds(binds);
  }, [entries, controllersEnabled, controllerEnabled, cancelAllControllerBind, aiPttControllerBind, aiReplayControllerBind, controllerProfile, holdMsByEntry, cancelAllHoldMs]);

  // Feed press/release edges to the matcher; play the most-specific bind that
  // completes. Skipped while the bind editor is open (and the matcher is reset
  // on open/close) so editor presses don't leak into playback.
  useEffect(() => {
    function onVrInput(ev: Event) {
      const detail = (ev as CustomEvent<{ token: string; pressed: boolean }>).detail;
      if (!detail?.token || capturingVrFor || capturingCancelAllVr || capturingAiPttVr || capturingAiReplayVr) return;
      const edge: VrEdge = detail.pressed ? "down" : "up";
      const hitId = vrMatcherRef.current!.feed(detail.token, edge, performance.now());
      if (hitId === CANCEL_ALL_BIND) cancelAll();
      else if (hitId === AI_PTT_BIND) { vrPttActiveRef.current = true; startAiPtt(); }
      else if (hitId === AI_REPLAY_BIND) replayLastConversion();
      else if (hitId) {
        const soundId = vrSoundByEntry.get(hitId);
        if (soundId) playEntry(hitId, soundId);
      }
      // PTT hold release: once active, the first button release (that didn't just
      // complete the PTT bind itself) ends the capture.
      if (edge === "up" && vrPttActiveRef.current && hitId !== AI_PTT_BIND) {
        vrPttActiveRef.current = false;
        stopAiPtt();
      }
    }
    window.addEventListener("soundboard:vrInput", onVrInput as EventListener);
    return () => window.removeEventListener("soundboard:vrInput", onVrInput as EventListener);
  }, [capturingVrFor, capturingCancelAllVr, capturingAiPttVr, capturingAiReplayVr, vrSoundByEntry, playEntry, cancelAll, startAiPtt, stopAiPtt, replayLastConversion]);

  useEffect(() => {
    vrMatcherRef.current!.reset();
  }, [capturingVrFor, capturingCancelAllVr, capturingAiPttVr, capturingAiReplayVr]);

  // (SteamVR status + hasDesktop now come from VrProvider via useVr.)

  // --- Upload ---
  const fileRef = useRef<HTMLInputElement>(null);
  const [makePublic, setMakePublic] = useState(false);
  const [clipName, setClipName] = useState("");
  const [uploadTags, setUploadTags] = useState<string[]>([]);
  // Set when the user tries to submit with a required field empty — reveals the
  // validation highlight (we don't flag empty fields eagerly).
  const [uploadTriedSubmit, setUploadTriedSubmit] = useState(false);
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
    setUploadTriedSubmit(false);
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
    // Capture the new sound id so the Saved tab can highlight it.
    const j = await res.json().catch(() => ({}));
    if (j?.sound?.id) {
      markNewSaved(j.sound.id);
      setBoardTab("saved");
    }
    analytics.uploadSound();
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

  // Board PATCHes target a per-profile placement, so they carry the active profile
  // id (the server upserts the placement for that profile + the entry's sound).
  const boardPatch = (body: Record<string, unknown>): RequestInit =>
    jsonPatch({ ...body, profileId: activeProfileIdRef.current ?? undefined });

  async function setKeybind(entryId: string, combo: string | null) {
    if (await mutate(`/api/board/${entryId}`, boardPatch({ keybind: combo }), "Couldn't update keybind")) refresh();
  }

  async function setControllerBind(entryId: string, token: string | null) {
    if (await mutate(`/api/board/${entryId}`, boardPatch({ controllerBind: token }), "Couldn't update controller bind")) refresh();
  }

  async function removeEntry(entryId: string) {
    if (await mutate(`/api/board/${entryId}`, { method: "DELETE" }, "Couldn't remove that entry")) {
      const sid = entries.find((e) => e.entry.id === entryId)?.sound.id;
      if (sid) analytics.removeFromSaved(sid);
      refresh();
    }
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
    if (await mutate(`/api/board/${entryId}`, boardPatch({ onBoard: on }), failMsg)) {
      const sid = entries.find((e) => e.entry.id === entryId)?.sound.id;
      if (sid) (on ? analytics.boardAdd : analytics.boardRemove)(sid);
      refresh();
    }
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
  // Saved list: optional name/author search + "my uploads only" + tag filter, ANDed.
  const savedList = useMemo(() => {
    const needle = savedSearch.trim().toLowerCase();
    return entries.filter((e) => {
      if (savedMineOnly && e.sound.ownerId !== user.id) return false;
      if (savedTagFilter.length > 0 && !e.tags.some((t) => savedTagFilter.includes(t))) return false;
      if (
        needle &&
        !e.sound.name.toLowerCase().includes(needle) &&
        !(e.ownerName ?? "").toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [entries, savedTagFilter, savedMineOnly, savedSearch, user.id]);
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
    const pid = activeProfileIdRef.current ?? undefined;
    const results = await Promise.all(
      ordered.map((e, i) =>
        fetch(`/api/board/${e.entry.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: i, profileId: pid }),
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
      onPlay={() => playEntry(e.entry.id, e.sound.id, view === "saved")}
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
      onControllerCaptured={(token, holds) => {
        setCapturingVrFor(null);
        // Merge into this profile's slot, preserving the other profile's bind.
        setControllerBind(e.entry.id, setProfileBind(e.entry.controllerBind, controllerProfile, token));
        setEntryHoldMs(e.entry.id, holds);
      }}
      onClearController={() => {
        setControllerBind(e.entry.id, setProfileBind(e.entry.controllerBind, controllerProfile, null));
        setEntryHoldMs(e.entry.id, null);
      }}
      controllerHolds={holdMsByEntry[e.entry.id] ?? null}
      onRemove={() => removeEntry(e.entry.id)}
      onDeleteSound={() => deleteSound(e.sound.id)}
      onTogglePublic={(next) => togglePublic(e.sound.id, next)}
      expanded={expandedCard === e.entry.id}
      onToggleExpand={() => setExpandedCard((id) => (id === e.entry.id ? null : e.entry.id))}
      onBoard={e.entry.onBoard}
      onSetOnBoard={(on) => {
        if (on) clearNewSaved(e.sound.id);
        setOnBoard(e.entry.id, on);
      }}
      isNew={view === "saved" && newSavedIds.has(e.sound.id)}
      onSeen={() => clearNewSaved(e.sound.id)}
    />
  );

  return (
    <div className="space-y-8">
      {/* The audio Control Panel moved into the header (Settings · Voice changer ·
          Sound Effects popovers in HeaderControls). The AI push-to-talk + AI-replay
          controller bind editors now render from VrProvider so they open from the
          header popover on any page. */}

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
                <div className="grid gap-4 sm:grid-cols-2 items-stretch">
                  <label className="flex flex-col">
                    <span className="block text-xs text-muted mb-1">Audio file</span>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/mpeg,.mp3"
                      onChange={(e) => onPickFile(e.target.files?.[0])}
                      className="input w-full flex-1 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white file:text-xs"
                    />
                  </label>
                  <label className="flex flex-col">
                    <span className="block text-xs text-muted mb-1">Clip name</span>
                    <input
                      className="input w-full flex-1"
                      value={clipName}
                      onChange={(e) => setClipName(e.target.value)}
                      placeholder={fileName ? fileName.replace(/\.mp3$/i, "") : "My epic clip"}
                      maxLength={200}
                    />
                  </label>
                  {/* Private toggle (≈1/4) + tags (≈2/4) on one row, with spacing
                      between (the empty middle column). Stacks on mobile. */}
                  <div className="sm:col-span-2 flex flex-col gap-3 sm:grid sm:grid-cols-4 sm:gap-4 sm:items-start">
                    <label className="flex items-center gap-3 text-sm select-none">
                      <Toggle checked={makePublic} onChange={setMakePublic} label="Share this clip publicly" />
                      <span className="flex items-center gap-1.5">
                        {makePublic ? <Globe size={14} /> : <Lock size={14} />}
                        {makePublic ? "Public" : "Private"}
                      </span>
                    </label>
                    <div className="sm:col-span-2 sm:col-start-3">
                    <span className="block text-xs text-muted mb-1">
                      Tags <span className="text-muted/60">(at least one required)</span>
                    </span>
                    <TagEditor
                      value={uploadTags}
                      suggestions={allTags}
                      onChange={setUploadTags}
                      invalid={uploadTriedSubmit && uploadTags.length === 0}
                    />
                    {uploadTriedSubmit && uploadTags.length === 0 && (
                      <p className="text-[11px] text-amber-300/80 mt-1">Add at least one tag before uploading.</p>
                    )}
                    </div>
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
                      confirmDisabled={uploadTags.length === 0}
                      onConfirmBlocked={() => setUploadTriedSubmit(true)}
                      onConfirm={uploadBlob}
                      onCancel={resetUpload}
                    />
                  </div>
                )}
                {err && <p className="text-red-300 text-sm mt-3">{err}</p>}
              </>
            )}
            {addTab === "youtube" && yt.enabled && canUpload && (
              <YouTubeImport
                maxDurationSec={yt.maxDurationSec}
                allTags={allTags}
                onImported={(newSoundId) => {
                  if (newSoundId) {
                    markNewSaved(newSoundId);
                    setBoardTab("saved");
                  }
                  refresh();
                }}
              />
            )}
            {addTab === "browse" && (
              <BrowsePublicPanel
                audio={audio}
                savedSoundIds={savedSoundIds}
                onAdded={(soundId) => {
                  if (soundId) {
                    markNewSaved(soundId);
                    setBoardTab("saved");
                  }
                  refresh();
                  refreshTags();
                }}
              />
            )}
          </div>
        </Collapsible>
      </section>

      {/* Main-page AI controls — only while AI is enabled for the primary mic
          (configuration stays in the AI header popover). */}
      <AiMainSection audio={audio} />

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
                          onClick={() => {
                            setCancelAllControllerBind(
                              setProfileBind(cancelAllControllerBind, controllerProfile, null),
                            );
                            setCancelAllHoldMs(null);
                          }}
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
                initialHolds={cancelAllHoldMs}
                vrConnected={vrConnected}
                profile={controllerProfile}
                onCancel={() => setCapturingCancelAllVr(false)}
                onConfirm={(serialized, holds) => {
                  setCapturingCancelAllVr(false);
                  setCancelAllControllerBind(
                    setProfileBind(cancelAllControllerBind, controllerProfile, serialized),
                  );
                  setCancelAllHoldMs(holds);
                }}
              />
            )}
            {boardList.length > 0 && (
              <MasonryGrid className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
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
                <div className="flex flex-wrap items-center gap-1.5 mb-3">
                  {/* Name/author search — same behavior as the public browser. */}
                  <div className="relative mr-1">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                    <input
                      className="input !py-1 text-xs pl-8 w-52"
                      placeholder="Search name or author"
                      value={savedSearch}
                      onChange={(e) => setSavedSearch(e.target.value)}
                      aria-label="Search saved clips"
                    />
                  </div>
                  {/* My-uploads-only filter, in front of the tag chips. */}
                  <button
                    type="button"
                    aria-pressed={savedMineOnly}
                    onClick={() => setSavedMineOnly((v) => !v)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] transition mr-1 ${
                      savedMineOnly ? "bg-accent/20 text-white" : "bg-white/10 text-muted hover:text-white"
                    }`}
                  >
                    My uploads
                  </button>
                  {savedTagPool.length > 0 && (
                    <Tag size={13} className="text-muted shrink-0" />
                  )}
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
                {savedList.length === 0 ? (
                  <p className="text-muted text-sm">
                    {savedSearch.trim() || savedMineOnly
                      ? "No saved clips match the current filters."
                      : "No saved clips match the selected tags."}
                  </p>
                ) : (
                  <MasonryGrid className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
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

// Inline public-clip browser shown under the "Browse public" tab — a compact
// mirror of the /public page so users can preview and save other people's clips
// (added as Saved references) without leaving the dashboard.
function BrowsePublicPanel({
  audio,
  savedSoundIds,
  onAdded,
}: {
  audio: AudioOutput;
  savedSoundIds: Set<string>;
  onAdded: (soundId?: string) => void;
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
      analytics.savePublicSound(soundId);
      toast.success("Saved to your library.");
      onAdded(soundId);
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
        <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[28rem] overflow-y-auto overflow-x-hidden pr-1">
          {filtered.map((s) => {
            const isAdded = added.has(s.id) || savedSoundIds.has(s.id);
            return (
              <li key={s.id} className="card flex items-center gap-3">
                <button
                  className="btn-primary !rounded-xl !px-3 !py-2.5 shrink-0"
                  onClick={() => audio.play(s.id, 1, undefined, true)}
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
  onImported: (newSoundId?: string) => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // Reveal required-field validation only after a blocked submit attempt.
  const [triedSubmit, setTriedSubmit] = useState(false);
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
  // The active conversion job while it's still downloading/converting (cleared
  // once the editor opens — by then yt-dlp is done and a normal clip exists).
  const jobIdRef = useRef<string | null>(null);

  // Tell the server to stop yt-dlp + delete the job's temp files (and any sound
  // that already landed). Best-effort + keepalive so it survives an unmount.
  const cancelActiveJob = useCallback(() => {
    const id = jobIdRef.current;
    jobIdRef.current = null;
    if (id) fetch(`/api/sounds/youtube/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }, []);

  useEffect(() => () => {
    cancelled.current = true; // stop the poll loop
    cancelActiveJob(); // kill an in-flight conversion (no-op past the editor)
  }, [cancelActiveJob]);

  function resetEdit() {
    if (editUrl) URL.revokeObjectURL(editUrl);
    setEditUrl(null);
    setEditBuf(null);
    setOldSoundId(null);
    setUrl("");
    setName("");
    setTags([]);
    setTriedSubmit(false);
    setMakePublic(false);
  }

  // Explicit Cancel during conversion: stop polling, cancel the job server-side
  // (kills yt-dlp + cleans its files), and reset the form.
  function cancelImport() {
    cancelled.current = true;
    cancelActiveJob();
    resetEdit();
    setBusy(false);
    setPreparing(false);
    setErr(null);
  }

  // Pull the freshly imported clip back to the client and open the editor.
  async function prepareEdit(soundId: string) {
    // Conversion's done (yt-dlp finished, the clip exists) — past the cancellable
    // window; from here the user keeps or replaces it via the editor.
    jobIdRef.current = null;
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
    const j = await res.json().catch(() => ({}));
    if (oldSoundId) {
      await fetch(`/api/sounds/${oldSoundId}`, { method: "DELETE" }).catch(() => {});
    }
    setBusy(false);
    resetEdit();
    analytics.importYoutube();
    toast.success("Clip saved.");
    onImported(j?.sound?.id);
  }

  // Cancel at the editor stage: discard the auto-imported clip entirely (delete
  // its file + row) rather than keeping it. resetEdit first for instant feedback.
  async function discardImport() {
    const id = oldSoundId;
    resetEdit();
    if (id) await fetch(`/api/sounds/${id}`, { method: "DELETE" }).catch(() => {});
    onImported(); // refresh the library (the clip is gone)
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
    cancelled.current = false; // a prior cancel may have set this
    setBusy(true);
    const res = await fetch("/api/sounds/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.trim(),
        isPublic: makePublic,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(tags.length ? { tags } : {}),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Couldn't start the conversion");
      setBusy(false);
      return;
    }
    const { jobId } = await res.json();
    jobIdRef.current = jobId; // mark the conversion cancellable
    poll(jobId);
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
        <div className="sm:col-span-2">
          <span className="block text-xs text-muted mb-1">
            Tags <span className="text-muted/60">(at least one required)</span>
          </span>
          <TagEditor value={tags} suggestions={allTags} onChange={setTags} invalid={triedSubmit && tags.length === 0} />
          {triedSubmit && tags.length === 0 && (
            <p className="text-[11px] text-amber-300/80 mt-1">Add at least one tag before importing.</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 sm:col-span-2">
          <label className="flex items-center gap-3 text-sm select-none">
            <Toggle checked={makePublic} onChange={setMakePublic} label="Share this clip publicly" />
            <span className="flex items-center gap-1.5">
              {makePublic ? <Globe size={14} /> : <Lock size={14} />}
              {makePublic ? "Public — others can find and add it" : "Private — only you can use it"}
            </span>
          </label>
          {/* Wrapper catches the click while the button is disabled (pointer-events
              :none) so we can reveal the missing tag. */}
          <span onClick={() => { if (!busy && tags.length === 0) setTriedSubmit(true); }}>
            <button className="btn-primary" disabled={busy || tags.length === 0}>
              <Youtube size={16} className="mr-1" /> {busy ? "Converting…" : "Import"}
            </button>
          </span>
        </div>
      </form>
      {busy && !preparing && (
        <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-muted text-sm">
            Fetching and converting — this can take up to a couple of minutes. You can keep using the
            board.
          </p>
          <button type="button" className="btn-ghost text-sm shrink-0" onClick={cancelImport}>
            <X size={15} className="mr-1" /> Cancel
          </button>
        </div>
      )}
      {preparing && <p className="text-muted text-sm mt-3">Loading the clip for editing…</p>}
      {err && <p className="text-red-300 text-sm mt-3">{err}</p>}
      {/* Once converted, the trim/volume editor appears below the inputs (same as
          the file-upload flow). Tags live in the form above; finishEdit reads them. */}
      {editBuf && editUrl && (
        <div className="mt-4">
          <p className="text-sm text-muted mb-3">
            Imported! Trim it and set its default volume below, then save it — or cancel to discard it.
          </p>
          <ClipEditor
            buffer={editBuf}
            objectUrl={editUrl}
            busy={busy}
            confirmLabel={busy ? "Saving…" : "Save edited clip"}
            confirmDisabled={tags.length === 0}
            onConfirmBlocked={() => setTriedSubmit(true)}
            onConfirm={finishEdit}
            onCancel={discardImport}
          />
        </div>
      )}
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
  onControllerCaptured: (token: string, holds: number[][]) => void;
  onClearController: () => void;
  // Device-local per-action min-holds for the active profile's bind (or null).
  controllerHolds: number[][] | null;
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
  // Just-uploaded highlight (Saved tab). `onSeen` clears it (hover/add-to-board).
  isNew?: boolean;
  onSeen?: () => void;
}) {
  const { entry, capturing } = props;
  const { sound, ownerName } = entry;
  const audio = useAudio();
  // Controller binds are per-profile: only the current profile's slot is shown
  // and edited here, so switching profiles "clears" the visible bind.
  const controllerBind = getProfileBind(entry.entry.controllerBind, props.controllerProfile);
  const hasController = !!controllerBind;
  const [editingTags, setEditingTags] = useState(false);
  // Per-clip Sound Effects popover, anchored to this card's Sliders button.
  const [fxOpen, setFxOpen] = useState(false);

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

  const keyDisabled = !!entry.entry.keybind && (!props.keybindEnabled || !props.keybindsGloballyEnabled);
  const controllerDisabled = !!controllerBind && (!props.controllerEnabled || !props.controllersGloballyEnabled);

  // Stacked bind block — one bind per line (keyboard, then controller). In edit
  // mode each line is [enable toggle] [bind value — tap to (re)capture] [× clear];
  // read-only mode (collapsed Board card) shows just the value, struck through
  // when disabled. Backs both the Board and Saved expanded cards.
  const bindStack = (editMode: boolean) => (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-1.5">
      {/* Keyboard line */}
      <div className="flex items-center gap-1.5 min-w-0">
        {editMode && entry.entry.keybind && !capturing && (
          <Toggle
            size="sm"
            checked={props.keybindEnabled}
            disabled={!props.keybindsGloballyEnabled}
            onChange={props.onToggleKeybind}
            label={`Toggle keybind for ${entry.entry.label || sound.name}`}
          />
        )}
        {editMode ? (
          <button
            className="btn-ghost flex-1 text-xs min-w-0 !justify-start"
            onClick={capturing ? props.onCaptureCancel : props.onCaptureStart}
            title={
              entry.entry.keybind && !props.keybindsGloballyEnabled
                ? "Keybinds are globally off"
                : entry.entry.keybind && !props.keybindEnabled
                  ? "This keybind is off"
                  : "Click, then hold one or more keys together and release"
            }
          >
            <Keyboard size={14} className="mr-1 shrink-0" />
            <span className={`truncate ${keyDisabled ? "line-through text-muted" : ""}`}>
              {capturing ? "Hold keys…" : entry.entry.keybind || "Set keybind"}
            </span>
          </button>
        ) : (
          <span
            className={`inline-flex flex-1 items-center gap-1 min-w-0 rounded-md bg-white/5 px-2 py-1 text-xs ${
              keyDisabled ? "line-through text-muted/60" : "text-muted"
            }`}
            title="Keyboard bind"
          >
            <Keyboard size={11} className="shrink-0" />
            <span className="truncate">{entry.entry.keybind || "—"}</span>
          </span>
        )}
        {editMode && entry.entry.keybind && !capturing && (
          <button className="btn-ghost text-xs !px-1.5 shrink-0" onClick={props.onClearKey} title="Clear">×</button>
        )}
      </div>

      {/* Controller line */}
      <div className="flex items-center gap-1.5 min-w-0">
        {editMode && hasController && (
          <Toggle
            size="sm"
            checked={props.controllerEnabled}
            disabled={!props.controllersGloballyEnabled}
            onChange={props.onToggleController}
            label={`Toggle controller bind for ${entry.entry.label || sound.name}`}
          />
        )}
        {editMode ? (
          <button
            className="btn-ghost flex-1 text-xs min-w-0 !justify-start"
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
                      : "Choose inputs to bind"
            }
          >
            <Gamepad2 size={14} className="mr-1 shrink-0" />
            {controllerBind ? (
              <span className={controllerDisabled ? "line-through opacity-60" : ""}>
                <VrBindChips value={controllerBind} />
              </span>
            ) : (
              <span className="truncate">{props.hasDesktop ? "Set controller" : "Desktop app required"}</span>
            )}
          </button>
        ) : (
          <span
            className={`inline-flex flex-1 flex-wrap items-center gap-1 min-w-0 rounded-md bg-white/5 px-2 py-1 text-xs ${
              controllerDisabled ? "line-through text-muted/60 opacity-70" : "text-muted"
            }`}
            title="Controller bind"
          >
            <Gamepad2 size={11} className="shrink-0" />
            {controllerBind ? <VrBindChips value={controllerBind} /> : <span>—</span>}
          </span>
        )}
        {editMode && hasController && (
          <button className="btn-ghost text-xs !px-1.5 shrink-0" onClick={props.onClearController} title="Clear">×</button>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`card flex flex-col gap-2 relative ${
        props.isNew ? "ring-2 ring-lime-400/70 shadow-[0_0_0_3px_rgba(163,230,53,0.12)]" : ""
      }`}
      onMouseEnter={props.isNew ? props.onSeen : undefined}
    >
      {props.isNew && (
        <span className="absolute -top-2 -right-2 z-10 rounded-full bg-lime-400 px-2 py-0.5 text-[10px] font-semibold text-black shadow">
          New
        </span>
      )}
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
      {/* Board view (collapsed): read-only stacked binds so the mapping is visible
          without entering edit mode. In edit mode the editable stack renders in the
          expanded block below instead. */}
      {props.view === "board" && !expanded && bindStack(false)}

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

      {/* Volume row. Collapsed: slider + edit (pencil) + add/remove-from-board,
          right-aligned. Expanded: the slider gets its own full-width row — the
          Done + remove-from-board buttons relocate to the bottom row below. */}
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
          {/* Number only while editing; collapsed cards give the space to the
              bar (the wrapper title still shows the % on hover). */}
          {expanded && (
            <span className="shrink-0 text-xs text-muted w-8 text-right">{Math.round(props.volume * 100)}</span>
          )}
        </div>
        {!expanded && (
          <>
            <Popover
              open={fxOpen}
              onClose={() => setFxOpen(false)}
              align="right"
              portal
              panelClassName="w-[30rem] max-w-[calc(100vw-1.5rem)] max-h-[70vh] overflow-y-auto p-3"
              trigger={
                <button
                  className={`btn-ghost text-xs !px-2 shrink-0 ${fxOpen ? "text-accent" : ""}`}
                  onClick={() => setFxOpen((o) => !o)}
                  title="Sound effects"
                  aria-label="Sound effects"
                  aria-haspopup="dialog"
                  aria-expanded={fxOpen}
                >
                  <Sliders size={14} />
                </button>
              }
            >
              <SoundEffectsPanel
                audio={audio}
                soundId={sound.id}
                name={entry.entry.label || sound.originalFilename}
                onClose={() => setFxOpen(false)}
              />
            </Popover>
            <button
              className="btn-ghost text-xs !px-2 shrink-0"
              onClick={props.onToggleExpand}
              title="Edit"
              aria-label="Edit card"
            >
              <Pencil size={14} />
            </button>
            <button
              className={`btn-ghost text-xs !px-2 shrink-0 ${props.onBoard ? "" : "text-accent"}`}
              onClick={() => props.onSetOnBoard(!props.onBoard)}
              title={props.onBoard ? "Remove from board (keeps it in Saved)" : "Add to your board"}
              aria-label={props.onBoard ? "Remove from board" : "Add to board"}
            >
              {props.onBoard ? <X size={14} /> : <Plus size={14} />}
            </button>
          </>
        )}
      </div>

      {/* --- Full CRUD, revealed by the pencil --- */}
      {expanded && (
        <>
          <div className="text-xs text-muted break-words" title={sound.originalFilename}>
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

          {/* Editable stacked binds (keyboard + controller) — replaces the old
              wide capture rows; shown in both Board and Saved expanded cards. */}
          {bindStack(true)}

          {props.controllerCapturing && (
            <VrBindPicker
              initial={controllerBind}
              initialHolds={props.controllerHolds}
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

          {/* Bottom row: Done (collapse, ✓) + add/remove-from-board (icon-only) —
              relocated here off the slider row in the expanded state. */}
          <div className="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-white/5">
            <button
              className="btn-ghost text-xs !px-2"
              onClick={props.onToggleExpand}
              title="Done editing"
              aria-label="Collapse card"
            >
              <Check size={14} />
            </button>
            <button
              className={`btn-ghost text-xs !px-2 ${props.onBoard ? "" : "text-accent"}`}
              onClick={() => props.onSetOnBoard(!props.onBoard)}
              title={props.onBoard ? "Remove from board (keeps it in Saved)" : "Add to your board"}
              aria-label={props.onBoard ? "Remove from board" : "Add to board"}
            >
              {props.onBoard ? <X size={14} /> : <Plus size={14} />}
            </button>
          </div>
        </>
      )}

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
