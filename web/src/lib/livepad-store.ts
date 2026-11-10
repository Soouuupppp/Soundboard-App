// Livepad temp files (1.5.0), kept in the Origin Private File System so finished
// captures live on disk rather than in RAM.
//
//   livepad/<sessionId>/manifest.json
//   livepad/<sessionId>/<captureId>-<n>.wav
//
// The session id lives in sessionStorage, so a reload finds its folder again. A Web
// Lock held for the page's lifetime marks a folder as live: when a page goes away
// for any reason (reload, tab close, crash) the browser frees its lock, so the
// startup sweep can safely delete every folder whose lock is free.

export const LIVEPAD_DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
export const LIVEPAD_MAX_MAX_BYTES = 5 * 1024 * 1024 * 1024;
// Fits the largest single result (240s of 48 kHz mono), so a capture can't evict itself.
export const LIVEPAD_MIN_MAX_BYTES = 50 * 1024 * 1024;

export function clampMaxBytes(v: number): number {
  if (!Number.isFinite(v)) return LIVEPAD_DEFAULT_MAX_BYTES;
  return Math.max(LIVEPAD_MIN_MAX_BYTES, Math.min(LIVEPAD_MAX_MAX_BYTES, Math.round(v)));
}

export type LivepadCapture = {
  id: string;
  createdAt: number;
  durationSec: number;
  sampleRate: number;
  fileName: string;
  sizeBytes: number;
  name: string;
  volume: number;
  edited: boolean;
  savedSoundId: string | null;
};

type Manifest = { userId: string; captures: LivepadCapture[] };

type CaptureMeta = Omit<LivepadCapture, "fileName" | "sizeBytes">;
export type CapturePatch = Partial<Pick<LivepadCapture, "name" | "volume" | "edited" | "savedSoundId">>;

const ROOT_DIR = "livepad";
const MANIFEST_FILE = "manifest.json";
const SESSION_KEY = "soundboard:livepadSession";
// A reloading page's lock can outlive it by a moment; only a tab that still holds
// the lock after these retries is really another live tab.
const LOCK_RETRIES = 4;
const LOCK_RETRY_MS = 75;
const VOLUME_PERSIST_DEBOUNCE_MS = 250;

const lockName = (sessionId: string) => `soundboard:livepad:${sessionId}`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function livepadStoreSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof navigator.locks?.request === "function"
  );
}

export function isQuotaError(e: unknown): boolean {
  return (e as DOMException | undefined)?.name === "QuotaExceededError";
}

// Resolves to a release function, or null if someone else holds the lock.
function takeLock(name: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

async function claimSession(): Promise<{ sessionId: string; release: () => void }> {
  const existing = sessionStorage.getItem(SESSION_KEY);
  if (existing) {
    for (let i = 0; i < LOCK_RETRIES; i++) {
      const release = await takeLock(lockName(existing));
      if (release) return { sessionId: existing, release };
      await delay(LOCK_RETRY_MS);
    }
    // Still held: this tab was duplicated and copied a live tab's sessionStorage.
  }
  const sessionId = crypto.randomUUID();
  const release = await takeLock(lockName(sessionId));
  if (!release) throw new Error("Couldn't lock the Livepad session.");
  sessionStorage.setItem(SESSION_KEY, sessionId);
  return { sessionId, release };
}

async function sweepAbandoned(root: FileSystemDirectoryHandle, keep: string) {
  const names: string[] = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "directory" && name !== keep) names.push(name);
  }
  for (const name of names) {
    try {
      const release = await takeLock(lockName(name));
      if (!release) continue; // another tab's live session
      try {
        await root.removeEntry(name, { recursive: true });
      } finally {
        release();
      }
    } catch {
      /* retried on the next launch */
    }
  }
}

async function clearDirectory(dir: FileSystemDirectoryHandle) {
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  await Promise.all(names.map((n) => dir.removeEntry(n, { recursive: true }).catch(() => {})));
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}

async function loadManifest(dir: FileSystemDirectoryHandle, userId: string): Promise<LivepadCapture[]> {
  let manifest: Manifest | null = null;
  try {
    const handle = await dir.getFileHandle(MANIFEST_FILE);
    manifest = JSON.parse(await (await handle.getFile()).text()) as Manifest;
  } catch {
    return []; // first run of this session, or an unreadable manifest
  }
  // One browser profile can hold several accounts' sessions over time; never show
  // one account's audio to another.
  if (manifest.userId !== userId || !Array.isArray(manifest.captures)) {
    await clearDirectory(dir);
    return [];
  }
  return manifest.captures;
}

// Which captures to remove to get under the limit: oldest already-saved ones first
// (they exist in the library), then oldest unsaved. `protectedId` is never picked.
export function pickEvictions(
  captures: LivepadCapture[],
  maxBytes: number,
  protectedId: string | null,
): string[] {
  let total = captures.reduce((sum, c) => sum + c.sizeBytes, 0);
  if (total <= maxBytes) return [];
  const byAge = captures.filter((c) => c.id !== protectedId).sort((a, b) => a.createdAt - b.createdAt);
  const order = [...byAge.filter((c) => c.savedSoundId), ...byAge.filter((c) => !c.savedSoundId)];
  const out: string[] = [];
  for (const c of order) {
    if (total <= maxBytes) break;
    out.push(c.id);
    total -= c.sizeBytes;
  }
  return out;
}

export class LivepadStore {
  // Serializes file + manifest writes so two operations can't interleave.
  private queue: Promise<unknown> = Promise.resolve();
  private writeCounter = 0;
  private volumePersistTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly dir: FileSystemDirectoryHandle,
    private readonly sessionId: string,
    private readonly userId: string,
    private readonly releaseLock: () => void,
    private captures: LivepadCapture[],
  ) {}

  static async open(userId: string): Promise<LivepadStore> {
    const opfs = await navigator.storage.getDirectory();
    const root = await opfs.getDirectoryHandle(ROOT_DIR, { create: true });
    const { sessionId, release } = await claimSession();
    try {
      const dir = await root.getDirectoryHandle(sessionId, { create: true });
      const captures = await loadManifest(dir, userId);
      void sweepAbandoned(root, sessionId).catch(() => {});
      return new LivepadStore(root, dir, sessionId, userId, release, captures);
    } catch (e) {
      release();
      throw e;
    }
  }

  // Newest first, the order the grid shows.
  list(): LivepadCapture[] {
    return [...this.captures].sort((a, b) => b.createdAt - a.createdAt);
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => {});
    return run;
  }

  private persist(captures: LivepadCapture[]) {
    const manifest: Manifest = { userId: this.userId, captures };
    return writeFile(this.dir, MANIFEST_FILE, JSON.stringify(manifest));
  }

  // A fresh name per write: a File snapshot or object URL of the previous version
  // must stay readable until its owner has moved on.
  private nextFileName(id: string) {
    return `${id}-${++this.writeCounter}-${Date.now()}.wav`;
  }

  private async writeAudio(id: string, audio: Blob): Promise<string> {
    const fileName = this.nextFileName(id);
    try {
      await writeFile(this.dir, fileName, audio);
    } catch (e) {
      await this.dir.removeEntry(fileName).catch(() => {});
      throw e;
    }
    return fileName;
  }

  add(audio: Blob, meta: CaptureMeta): Promise<LivepadCapture> {
    return this.enqueue(async () => {
      const fileName = await this.writeAudio(meta.id, audio);
      const capture: LivepadCapture = { ...meta, fileName, sizeBytes: audio.size };
      this.captures = [...this.captures, capture];
      try {
        await this.persist(this.captures);
      } catch (e) {
        this.captures = this.captures.filter((c) => c.id !== meta.id);
        await this.dir.removeEntry(fileName).catch(() => {});
        throw e;
      }
      return capture;
    });
  }

  replaceAudio(
    id: string,
    audio: Blob,
    fields: Pick<LivepadCapture, "durationSec" | "sampleRate"> & CapturePatch,
  ): Promise<LivepadCapture> {
    return this.enqueue(async () => {
      const old = this.captures.find((c) => c.id === id);
      if (!old) throw new Error("That capture no longer exists.");
      const fileName = await this.writeAudio(id, audio);
      const updated: LivepadCapture = { ...old, ...fields, fileName, sizeBytes: audio.size };
      this.captures = this.captures.map((c) => (c.id === id ? updated : c));
      try {
        await this.persist(this.captures);
      } catch (e) {
        this.captures = this.captures.map((c) =>
          c.id === id ? { ...c, ...old, volume: c.volume, name: c.name } : c,
        );
        await this.dir.removeEntry(fileName).catch(() => {});
        throw e;
      }
      await this.dir.removeEntry(old.fileName).catch(() => {});
      return updated;
    });
  }

  update(id: string, patch: CapturePatch): Promise<void> {
    return this.enqueue(async () => {
      if (!this.captures.some((c) => c.id === id)) return;
      this.captures = this.captures.map((c) => (c.id === id ? { ...c, ...patch } : c));
      await this.persist(this.captures);
    });
  }

  // Slider drags: visible now, written once the drag settles. Mutators change
  // this.captures before persisting it, not after, so a volume set while a manifest
  // write is in flight can't be lost to a stale copy.
  setVolume(id: string, volume: number) {
    this.captures = this.captures.map((c) => (c.id === id ? { ...c, volume } : c));
    if (this.volumePersistTimer !== null) clearTimeout(this.volumePersistTimer);
    this.volumePersistTimer = setTimeout(() => {
      this.volumePersistTimer = null;
      void this.enqueue(() => this.persist(this.captures)).catch(() => {});
    }, VOLUME_PERSIST_DEBOUNCE_MS);
  }

  remove(ids: string[]): Promise<void> {
    return this.enqueue(async () => {
      const drop = new Set(ids);
      const gone = this.captures.filter((c) => drop.has(c.id));
      if (gone.length === 0) return;
      this.captures = this.captures.filter((c) => !drop.has(c.id));
      try {
        await this.persist(this.captures);
      } finally {
        await Promise.all(gone.map((c) => this.dir.removeEntry(c.fileName).catch(() => {})));
      }
    });
  }

  async getFile(capture: LivepadCapture): Promise<File> {
    const handle = await this.dir.getFileHandle(capture.fileName);
    return handle.getFile();
  }

  // Delete this session's folder and give up the lock (app close, sign-out).
  destroy(): Promise<void> {
    if (this.volumePersistTimer !== null) clearTimeout(this.volumePersistTimer);
    return this.enqueue(async () => {
      this.captures = [];
      try {
        await this.root.removeEntry(this.sessionId, { recursive: true });
      } catch {
        /* the next launch's sweep gets it */
      }
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        /* ignore */
      }
      this.releaseLock();
    });
  }
}
