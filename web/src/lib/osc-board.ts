// VRChat avatar panel (1.5.2, experimental): the per-profile key layout + the
// desktop app's OSC bridge types. Client-safe (no server imports) so the editor,
// the dashboard bridge and the Zod schema in validation.ts all share it.
//
// Slots live in a fixed 3×5 space (slot = row * 5 + col, 0..14) whatever the grid
// size, so shrinking the grid only grays slots out and growing it brings them back
// with their settings. Keys on the avatar are numbered 1..N row-major from the
// top-left of the CURRENT grid (the OSC contract in AGENTS.md).

export type GridSize = "1x5" | "3x3" | "3x5";
export const GRID_SIZES: GridSize[] = ["1x5", "3x3", "3x5"];
export const SLOT_COLS = 5;
export const SLOT_COUNT = 15;
export const MAX_PAGES = 10;
export const MAX_POSITION = 120;

const DIMS: Record<GridSize, { rows: number; cols: number }> = {
  "1x5": { rows: 1, cols: 5 },
  "3x3": { rows: 3, cols: 3 },
  "3x5": { rows: 3, cols: 5 },
};

export const gridDims = (g: GridSize) => DIMS[g];
export const keysFor = (g: GridSize) => DIMS[g].rows * DIMS[g].cols;
export const slotOf = (row: number, col: number) => row * SLOT_COLS + col;

export function slotInGrid(g: GridSize, slot: number): boolean {
  const { rows, cols } = DIMS[g];
  return Math.floor(slot / SLOT_COLS) < rows && slot % SLOT_COLS < cols;
}

/** Avatar key n (1-based) → slot in the 3×5 space. */
export function keySlot(g: GridSize, n: number): number | null {
  const { cols } = DIMS[g];
  if (!Number.isInteger(n) || n < 1 || n > keysFor(g)) return null;
  const i = n - 1;
  return slotOf(Math.floor(i / cols), i % cols);
}

export function gridForKeys(n: number | null | undefined): GridSize | null {
  return n === 5 ? "1x5" : n === 9 ? "3x3" : n === 15 ? "3x5" : null;
}

export type OscKeyAction =
  | { type: "play"; soundId: string; soundName: string }
  | { type: "cancelAll" }
  | { type: "livepadCapture" }
  | { type: "livepadPlay"; mode: "position"; slot: number }
  | { type: "livepadPlay"; mode: "specific"; captureId: string; captureName: string }
  | { type: "profile"; mode: "cycle" }
  | { type: "profile"; mode: "specific"; profileId: string; profileName: string }
  | { type: "pageNext" }
  | { type: "pagePrev" };

export type OscActionType = OscKeyAction["type"];

export type OscPage = (OscKeyAction | null)[]; // always SLOT_COUNT long
export type OscLayout = { v: 1; grid: GridSize; pages: OscPage[] };

export const emptyPage = (): OscPage => Array.from({ length: SLOT_COUNT }, () => null);
export const defaultOscLayout = (): OscLayout => ({ v: 1, grid: "3x5", pages: [emptyPage()] });

/** Defensive read of the stored JSON; anything off falls back to the default. */
export function parseOscLayout(raw: string | null | undefined): OscLayout {
  if (!raw) return defaultOscLayout();
  try {
    const j = JSON.parse(raw) as Partial<OscLayout>;
    if (!j || j.v !== 1 || !GRID_SIZES.includes(j.grid as GridSize) || !Array.isArray(j.pages) || !j.pages.length) {
      return defaultOscLayout();
    }
    const pages = j.pages.slice(0, MAX_PAGES).map((p) => {
      const page = emptyPage();
      if (Array.isArray(p)) for (let i = 0; i < SLOT_COUNT; i++) page[i] = (p[i] as OscKeyAction | null) ?? null;
      return page;
    });
    return { v: 1, grid: j.grid as GridSize, pages };
  } catch {
    return defaultOscLayout();
  }
}

export const ACTION_LABELS: Record<OscActionType, string> = {
  play: "Play sound",
  cancelAll: "Cancel all",
  livepadCapture: "Livepad capture",
  livepadPlay: "Livepad play",
  profile: "Profile switch",
  pageNext: "Page +",
  pagePrev: "Page −",
};

/** A fresh action of a type, as placed from the palette (targets chosen afterwards). */
export function newAction(type: OscActionType): OscKeyAction {
  switch (type) {
    case "play":
      return { type, soundId: "", soundName: "" };
    case "livepadPlay":
      return { type, mode: "position", slot: 1 };
    case "profile":
      return { type, mode: "cycle" };
    default:
      return { type } as OscKeyAction;
  }
}

// --- Desktop bridge (electron/preload.js → window.soundboard.vrcOsc) ----------

export type VrcOscStatus = {
  running: boolean;
  vrchatFound: boolean;
  avatarKeys: 0 | 5 | 9 | 15 | null;
  manual: boolean;
  error?: string;
};

export type VrcOscConfig = { manual: boolean; inPort: number; outPort: number };

export type VrcOscBridgeApi = {
  attach: (onPress: (n: number) => void, onStatus?: (s: VrcOscStatus) => void, onAvatarChange?: () => void) => () => void;
  publishKeys: (keys: { n: number; active: boolean; playing: boolean }[]) => void;
  setPage: (i: number) => void;
  getStatus: () => Promise<VrcOscStatus>;
  getConfig: () => Promise<VrcOscConfig | null>;
  setConfig: (cfg: Partial<VrcOscConfig>) => Promise<{ ok: boolean; error?: string; config?: VrcOscConfig } | null>;
  onStatus: (fn: (s: VrcOscStatus) => void) => () => void;
};

export function getVrcOscBridge(): VrcOscBridgeApi | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { soundboard?: { vrcOsc?: VrcOscBridgeApi } };
  return w.soundboard?.vrcOsc ?? null;
}

// Device-local feature switch, default OFF: discovery listens for mDNS on every
// network interface, which makes Windows Firewall prompt, so only users who turn
// the panel on should see that. A window event keeps the editor and the dashboard
// bridge in sync within the page.
export const VRC_OSC_ENABLED_KEY = "soundboard:vrcOscEnabled";
export const VRC_OSC_ENABLED_EVENT = "soundboard:vrcOscEnabled-changed";

export function readVrcOscEnabled(): boolean {
  try {
    return localStorage.getItem(VRC_OSC_ENABLED_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeVrcOscEnabled(on: boolean) {
  try {
    localStorage.setItem(VRC_OSC_ENABLED_KEY, on ? "on" : "off");
  } catch {}
  window.dispatchEvent(new CustomEvent(VRC_OSC_ENABLED_EVENT, { detail: { on } }));
}
