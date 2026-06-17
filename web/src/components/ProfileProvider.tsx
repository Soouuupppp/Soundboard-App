"use client";

// ProfileProvider (ver/1.4.1) — owns the user's profile list + the device-local
// ACTIVE profile id, and exposes the active profile's server-side config
// (voiceFx + per-clip soundFx) plus a debounced server-persist. It wraps
// AudioProvider in app/layout.tsx so the audio engine can back its
// soundFx/voiceFx accessors with the active profile's config instead of
// localStorage (the accessor SIGNATURES stay identical — only the backing store
// changed). The board layout itself is fetched per-profile by Dashboard via
// /api/board?profileId=<active>.
//
// What's per-profile (here): the board placements (Dashboard), the voice-changer
// mic chain + AI config, and applied per-clip sound effects. GLOBAL (not here):
// the Saved library + FX preset libraries. DEVICE-LOCAL: the active profile id,
// device selections, bus volumes, master toggles, binds — those stay in
// localStorage elsewhere. The AI BYO key is a secret and stays device-local too.

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
import type { ProfileBacking, VoiceFxMap, SoundFxMap } from "@/lib/audio-output";

export type ProfileMeta = {
  id: string;
  name: string;
  position: number;
  isDefault: boolean;
  // Serialized config blobs as stored server-side (parsed lazily for the active one).
  voiceFx: string | null;
  soundFx: string | null;
};

type ProfileCtx = {
  profiles: ProfileMeta[];
  activeProfileId: string | null;
  limit: number;
  loading: boolean;
  setActiveProfile: (id: string) => void;
  refreshProfiles: () => Promise<void>;
  // CRUD — return the raw Response so callers can route failures through useToast.
  createProfile: (name: string) => Promise<Response>;
  renameProfile: (id: string, name: string) => Promise<Response>;
  cloneProfile: (id: string) => Promise<Response>;
  deleteProfile: (id: string) => Promise<Response>;
  reorderProfile: (id: string, dir: -1 | 1) => Promise<void>;
  // The backing handed to useAudioOutput (active profile config + debounced persist).
  backing: ProfileBacking;
};

const ACTIVE_KEY = "soundboard:activeProfile";
const MIGRATED_KEY = "soundboard:profilesMigrated";
const VOICEFX_KEY = "soundboard:voicefx";
const SOUNDFX_KEY = "soundboard:soundfx";
const PERSIST_DEBOUNCE_MS = 250;

const Ctx = createContext<ProfileCtx | null>(null);

function parseMap<T>(raw: string | null | undefined): T {
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(true);
  // loadGen bumps on every SERVER (re)load — the audio hook re-seeds the mixer
  // only on a profile switch or a server reload, never on a local config edit.
  const [loadGen, setLoadGen] = useState(0);
  // Active profile's parsed config; recomputed only on switch / server reload.
  const [config, setConfig] = useState<{ voiceFx: VoiceFxMap; soundFx: SoundFxMap }>({
    voiceFx: {},
    soundFx: {},
  });

  // Live mirror of the profile list so persist() can update a profile's serialized
  // config without a setState (per-tick) — switching away and back stays correct.
  const profilesRef = useRef<ProfileMeta[]>(profiles);
  profilesRef.current = profiles;
  const activeRef = useRef<string | null>(activeProfileId);
  activeRef.current = activeProfileId;

  // Debounced server PATCH of a profile's config, merged per profile id.
  const patchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const patchPending = useRef<Map<string, { voiceFx?: string; soundFx?: string }>>(new Map());

  const flushPatch = useCallback((id: string) => {
    const t = patchTimers.current.get(id);
    if (t) { clearTimeout(t); patchTimers.current.delete(id); }
    const body = patchPending.current.get(id);
    if (!body) return;
    patchPending.current.delete(id);
    void fetch(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }, []);

  const flushAllPatches = useCallback(() => {
    for (const id of Array.from(patchPending.current.keys())) flushPatch(id);
  }, [flushPatch]);

  const schedulePatch = useCallback((id: string, fields: { voiceFx?: string; soundFx?: string }) => {
    const cur = patchPending.current.get(id) ?? {};
    patchPending.current.set(id, { ...cur, ...fields });
    const existing = patchTimers.current.get(id);
    if (existing) clearTimeout(existing);
    patchTimers.current.set(id, setTimeout(() => flushPatch(id), PERSIST_DEBOUNCE_MS));
  }, [flushPatch]);

  // Update the in-memory serialized config for a profile (so a switch reflects the
  // latest) and schedule the debounced server write.
  const persist = useCallback((profileId: string, fields: { voiceFx?: VoiceFxMap; soundFx?: SoundFxMap }) => {
    const serialized: { voiceFx?: string; soundFx?: string } = {};
    if (fields.voiceFx !== undefined) serialized.voiceFx = JSON.stringify(fields.voiceFx);
    if (fields.soundFx !== undefined) serialized.soundFx = JSON.stringify(fields.soundFx);
    const arr = profilesRef.current;
    const i = arr.findIndex((p) => p.id === profileId);
    if (i >= 0) {
      const updated = { ...arr[i], ...serialized };
      const next = arr.slice();
      next[i] = updated;
      profilesRef.current = next; // ref only — no setState (avoids per-tick re-render)
    }
    schedulePatch(profileId, serialized);
  }, [schedulePatch]);

  const persistVoiceFx = useCallback((v: VoiceFxMap) => {
    const id = activeRef.current;
    if (id) persist(id, { voiceFx: v });
  }, [persist]);
  const persistSoundFx = useCallback((v: SoundFxMap) => {
    const id = activeRef.current;
    if (id) persist(id, { soundFx: v });
  }, [persist]);

  const loadProfiles = useCallback(async () => {
    try {
      const r = await fetch("/api/profiles");
      if (!r.ok) { setLoading(false); return; }
      const data = await r.json();
      const list: ProfileMeta[] = data.profiles ?? [];
      setProfiles(list);
      profilesRef.current = list;
      if (typeof data.limit === "number") setLimit(data.limit);
      // Resolve the active profile: persisted device-local id if still present,
      // else the default (or first). Persist the resolved id back.
      let active: string | null = null;
      try { active = localStorage.getItem(ACTIVE_KEY); } catch {}
      if (!active || !list.some((p) => p.id === active)) {
        active = (list.find((p) => p.isDefault) ?? list[0])?.id ?? null;
        if (active) { try { localStorage.setItem(ACTIVE_KEY, active); } catch {} }
      }
      setActiveProfileId(active);
      activeRef.current = active;
      // One-time migration: push any device-local soundfx/voicefx into the Default
      // profile (only if it has no server config yet), then stop reading them.
      try {
        if (!localStorage.getItem(MIGRATED_KEY)) {
          const def = list.find((p) => p.isDefault) ?? list[0];
          if (def && !def.voiceFx && !def.soundFx) {
            const localVoice = localStorage.getItem(VOICEFX_KEY);
            const localSound = localStorage.getItem(SOUNDFX_KEY);
            const body: { voiceFx?: string; soundFx?: string } = {};
            if (localVoice && localVoice !== "{}") body.voiceFx = localVoice;
            if (localSound && localSound !== "{}") body.soundFx = localSound;
            if (Object.keys(body).length) {
              await fetch(`/api/profiles/${def.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }).catch(() => {});
              // Reflect locally so the first seed uses the migrated config.
              const i = profilesRef.current.findIndex((p) => p.id === def.id);
              if (i >= 0) {
                const next = profilesRef.current.slice();
                next[i] = { ...next[i], ...body };
                profilesRef.current = next;
                setProfiles(next);
              }
            }
          }
          localStorage.setItem(MIGRATED_KEY, "1");
        }
      } catch {}
      setLoadGen((g) => g + 1);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  // Recompute the active profile's parsed config on switch / server reload only.
  useEffect(() => {
    const p = profilesRef.current.find((x) => x.id === activeProfileId);
    setConfig({
      voiceFx: parseMap<VoiceFxMap>(p?.voiceFx),
      soundFx: parseMap<SoundFxMap>(p?.soundFx),
    });
  }, [activeProfileId, loadGen]);

  // Flush pending config writes on unload so an interrupted drag isn't lost.
  useEffect(() => {
    const onUnload = () => flushAllPatches();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      flushAllPatches();
    };
  }, [flushAllPatches]);

  const setActiveProfile = useCallback((id: string) => {
    flushAllPatches(); // commit the outgoing profile's pending edits first
    setActiveProfileId(id);
    activeRef.current = id;
    try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
    // Desktop app re-registers the active profile's board hotkeys (Dashboard
    // refetches the board + re-pushes combos on activeProfileId change).
    window.dispatchEvent(new CustomEvent("soundboard:activeProfile-changed", { detail: { id } }));
  }, [flushAllPatches]);

  const createProfile = useCallback(async (name: string) => {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) await loadProfiles();
    return res;
  }, [loadProfiles]);

  const renameProfile = useCallback(async (id: string, name: string) => {
    const res = await fetch(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) await loadProfiles();
    return res;
  }, [loadProfiles]);

  const cloneProfile = useCallback(async (id: string) => {
    const res = await fetch(`/api/profiles/${id}/clone`, { method: "POST" });
    if (res.ok) await loadProfiles();
    return res;
  }, [loadProfiles]);

  const deleteProfile = useCallback(async (id: string) => {
    const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
    if (res.ok) {
      // If the active profile was deleted, switch to another before refetching.
      if (activeRef.current === id) {
        const fallback = profilesRef.current.find((p) => p.id !== id);
        if (fallback) setActiveProfile(fallback.id);
      }
      await loadProfiles();
    }
    return res;
  }, [loadProfiles, setActiveProfile]);

  // Swap a profile's position with its neighbour in the given direction.
  const reorderProfile = useCallback(async (id: string, dir: -1 | 1) => {
    const ordered = profilesRef.current.slice().sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex((p) => p.id === id);
    const j = idx + dir;
    if (idx === -1 || j < 0 || j >= ordered.length) return;
    const a = ordered[idx];
    const b = ordered[j];
    // Swap positions, persist both, then refetch.
    await Promise.all([
      fetch(`/api/profiles/${a.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position: b.position }),
      }).catch(() => null),
      fetch(`/api/profiles/${b.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position: a.position }),
      }).catch(() => null),
    ]);
    await loadProfiles();
  }, [loadProfiles]);

  const backing: ProfileBacking = useMemo(
    () => ({ activeProfileId, loadGen, config, persistVoiceFx, persistSoundFx }),
    [activeProfileId, loadGen, config, persistVoiceFx, persistSoundFx],
  );

  const value: ProfileCtx = {
    profiles,
    activeProfileId,
    limit,
    loading,
    setActiveProfile,
    refreshProfiles: loadProfiles,
    createProfile,
    renameProfile,
    cloneProfile,
    deleteProfile,
    reorderProfile,
    backing,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProfiles(): ProfileCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProfiles must be used within a ProfileProvider");
  return ctx;
}
