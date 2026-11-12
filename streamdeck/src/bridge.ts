// Client side of the Soundboard desktop app's Stream Deck bridge
// (electron/streamdeck-bridge.js). Reads the discovery file on every connect attempt,
// connects to the named pipe, proves itself with the token, then keeps the latest
// state and sends presses. Reconnects with backoff (1 s → 10 s) while the app is closed.

import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export type BridgeAction = "play" | "cancelAll" | "aiPtt" | "aiReplay" | "livepad" | "profile";
export type BridgeError = "offline" | "not-found" | "unavailable";
export type PressResult = { ok: boolean; error?: BridgeError };

export type BridgeSound = { soundId: string; name: string; onBoard: boolean };
export type BridgeProfile = { id: string; name: string };

export type BridgeState = {
  /** Authenticated to the app and received its state. */
  connected: boolean;
  /** The dashboard is open (presses can do something). */
  available: boolean;
  sounds: BridgeSound[];
  profiles: BridgeProfile[];
  activeProfileId: string | null;
  playing: Set<string>;
  aiPtt: boolean;
};

const PROTOCOL_VERSION = 1;
const PRESS_TIMEOUT_MS = 2000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;
// The app caps state at 2000 sounds; this is just a ceiling against a runaway peer.
const MAX_INCOMING_LINE = 4 * 1024 * 1024;
// Only ever connect to our own local pipe: a tampered discovery file must not be able
// to point us (and the token) at a UNC path on another machine.
const PIPE_PREFIX = "\\\\.\\pipe\\soundboard-streamdeck-";

function discoveryPath(): string | null {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, "Soundboard", "streamdeck-bridge.json") : null;
}

const offlineState = (): BridgeState => ({
  connected: false,
  available: false,
  sounds: [],
  profiles: [],
  activeProfileId: null,
  playing: new Set(),
  aiPtt: false,
});

class Bridge {
  state: BridgeState = offlineState();
  private socket: net.Socket | null = null;
  private backoff = MIN_BACKOFF_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: PressResult) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(s: BridgeState) => void>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  /** Subscribe to state changes; returns an unsubscribe. */
  onChange(fn: (s: BridgeState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  press(action: BridgeAction, edge: "down" | "up", extra: { soundId?: string; profileId?: string } = {}): Promise<PressResult> {
    const socket = this.socket;
    if (!socket || !this.state.connected) return Promise.resolve({ ok: false, error: "offline" });
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "offline" });
      }, PRESS_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      socket.write(JSON.stringify({ t: "press", id, action, edge, ...extra }) + "\n");
    });
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    const file = discoveryPath();
    let info: { v?: unknown; pipe?: unknown; token?: unknown } | null = null;
    try {
      if (file) info = JSON.parse(await readFile(file, "utf8"));
    } catch {
      info = null;
    }
    if (
      !info ||
      info.v !== PROTOCOL_VERSION ||
      typeof info.pipe !== "string" ||
      !info.pipe.startsWith(PIPE_PREFIX) ||
      /[\\/]/.test(info.pipe.slice(PIPE_PREFIX.length)) ||
      typeof info.token !== "string"
    ) {
      this.scheduleRetry();
      return;
    }

    const token = info.token;
    const socket = net.connect(info.pipe);
    this.socket = socket;
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, token }) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) this.onMessage(line);
      }
      if (buf.length > MAX_INCOMING_LINE) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: "offline" });
        this.pending.delete(id);
      }
      const wasConnected = this.state.connected;
      this.state = offlineState();
      if (wasConnected) this.emit();
      this.scheduleRetry();
    });
  }

  private onMessage(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.t === "state") {
      this.backoff = MIN_BACKOFF_MS;
      this.state = parseState(m);
      this.emit();
    } else if (m.t === "result" && typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      const error = m.error === "not-found" || m.error === "unavailable" || m.error === "offline" ? m.error : undefined;
      p.resolve({ ok: m.ok === true, error: m.ok === true ? undefined : (error ?? "unavailable") });
    }
  }
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

// The app already sanitizes, but this side treats the pipe as untrusted input too.
function parseState(m: Record<string, unknown>): BridgeState {
  const s = offlineState();
  s.connected = true;
  s.available = m.available === true;
  if (Array.isArray(m.sounds)) {
    for (const x of m.sounds.slice(0, 2000)) {
      const soundId = str(x?.soundId, 64);
      if (soundId) s.sounds.push({ soundId, name: str(x.name, 120), onBoard: x.onBoard === true });
    }
  }
  if (Array.isArray(m.profiles)) {
    for (const x of m.profiles.slice(0, 100)) {
      const id = str(x?.id, 64);
      if (id) s.profiles.push({ id, name: str(x.name, 120) });
    }
  }
  s.activeProfileId = str(m.activeProfileId, 64) || null;
  if (Array.isArray(m.playing)) for (const id of m.playing.slice(0, 2000)) if (typeof id === "string") s.playing.add(id);
  s.aiPtt = m.aiPtt === true;
  return s;
}

export const bridge = new Bridge();
