// Types + accessor for the desktop app's Stream Deck bridge (electron/preload.js →
// window.soundboard.streamDeck). Absent in the browser build.

// Keep in sync with electron/streamdeck-bridge.js (ACTIONS) and streamdeck/src/bridge.ts.
export type StreamDeckAction =
  | "play"
  | "cancelAll"
  | "aiPtt"
  | "aiReplay"
  | "livepad"
  | "profile"
  | "profileCycle"
  | "livepadPlayLatest"
  | "livepadPlay"
  | "aiToggle";
export type StreamDeckError = "offline" | "not-found" | "unavailable";

export type StreamDeckPress = {
  id: number;
  action: StreamDeckAction;
  edge: "down" | "up";
  soundId?: string;
  profileId?: string;
  // livepadPlay carries exactly one: a 1-based position (1 = newest) or a capture id.
  slot?: number;
  captureId?: string;
};

export type StreamDeckState = {
  sounds: { soundId: string; name: string; onBoard: boolean }[];
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  playing: string[];
  aiPtt: boolean;
  // AI voice is enabled for the selected mic.
  aiEnabled: boolean;
  // Livepad temp captures, newest first, and the ones playing right now.
  captures: { id: string; name: string; durationSec: number }[];
  playingCaptures: string[];
};

export type StreamDeckBridgeApi = {
  attach: (onPress: (press: StreamDeckPress) => void) => () => void;
  publishState: (state: StreamDeckState) => void;
  result: (id: number, ok: boolean, error?: StreamDeckError) => void;
  getStatus: () => Promise<{ connected: boolean }>;
  onStatus: (fn: (status: { connected: boolean }) => void) => () => void;
};

export function getStreamDeckBridge(): StreamDeckBridgeApi | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { soundboard?: { streamDeck?: StreamDeckBridgeApi } };
  return w.soundboard?.streamDeck ?? null;
}
