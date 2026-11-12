// Types + accessor for the desktop app's Stream Deck bridge (electron/preload.js →
// window.soundboard.streamDeck). Absent in the browser build.

export type StreamDeckAction = "play" | "cancelAll" | "aiPtt" | "aiReplay" | "livepad" | "profile";
export type StreamDeckError = "offline" | "not-found" | "unavailable";

export type StreamDeckPress = {
  id: number;
  action: StreamDeckAction;
  edge: "down" | "up";
  soundId?: string;
  profileId?: string;
};

export type StreamDeckState = {
  sounds: { soundId: string; name: string; onBoard: boolean }[];
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
  playing: string[];
  aiPtt: boolean;
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
