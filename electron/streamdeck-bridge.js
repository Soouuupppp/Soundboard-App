// Stream Deck bridge: a local named-pipe server our Stream Deck plugin connects to.
//
//   plugin ──(\\.\pipe\soundboard-streamdeck-<user hash>)──► this server ──IPC──► dashboard
//
// A named pipe (not a localhost port) so web pages can't reach it. libuv creates the
// pipe with default security and does NOT reject remote clients, so every connection
// must prove it can read the per-launch token from the discovery file in %APPDATA%
// (readable only by this Windows user). Never pass readableAll/writableAll to listen().
//
// Protocol: newline-delimited JSON, at most MAX_LINE bytes per line. The first line
// must be {"t":"hello","v":1,"token":"…"} within HELLO_TIMEOUT_MS, otherwise the
// connection is closed. After that the plugin sends presses and gets results back,
// and every authenticated client receives the latest state (pushed on change).

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PROTOCOL_VERSION = 1;
const MAX_LINE = 64 * 1024;
const MAX_CLIENTS = 4;
const HELLO_TIMEOUT_MS = 2000;
const STATE_DEBOUNCE_MS = 100;

// Caps on what the (semi-trusted, remote) page may publish through us.
const MAX_SOUNDS = 2000;
const MAX_PROFILES = 100;
const MAX_NAME = 120;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ACTIONS = new Set(["play", "cancelAll", "aiPtt", "aiReplay", "livepad", "profile"]);
const ERRORS = new Set(["offline", "not-found", "unavailable"]);

let server = null;
let discoveryPath = null;
let token = null; // Buffer
let tokenHash = null; // sha256(token), compared in constant time
let opts = null;
const clients = new Set();
let available = false;
let pageState = emptyPageState();
let stateTimer = null;

function emptyPageState() {
  return { sounds: [], profiles: [], activeProfileId: null, playing: [], aiPtt: false };
}

function pipeName() {
  // Per Windows user, so two users on one PC each get their own pipe.
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USERNAME || "";
  }
  const h = crypto.createHash("sha256").update(user.toLowerCase()).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\soundboard-streamdeck-${h}`;
}

const cleanId = (v) => (typeof v === "string" && ID_RE.test(v) ? v : null);

function cleanName(v) {
  if (typeof v !== "string") return "";
  // Drop control characters; the plugin escapes again before drawing.
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NAME);
}

// Re-validate everything the page sends; anything malformed is dropped, not trusted.
function sanitizeState(raw) {
  const s = emptyPageState();
  if (!raw || typeof raw !== "object") return s;
  if (Array.isArray(raw.sounds)) {
    const seen = new Set();
    for (const x of raw.sounds) {
      if (s.sounds.length >= MAX_SOUNDS) break;
      const soundId = cleanId(x && x.soundId);
      if (!soundId || seen.has(soundId)) continue;
      seen.add(soundId);
      s.sounds.push({ soundId, name: cleanName(x.name) || "Untitled", onBoard: !!x.onBoard });
    }
  }
  if (Array.isArray(raw.profiles)) {
    for (const x of raw.profiles) {
      if (s.profiles.length >= MAX_PROFILES) break;
      const id = cleanId(x && x.id);
      if (id) s.profiles.push({ id, name: cleanName(x.name) || "Profile" });
    }
  }
  s.activeProfileId = cleanId(raw.activeProfileId);
  if (Array.isArray(raw.playing)) {
    s.playing = raw.playing.slice(0, MAX_SOUNDS).map(cleanId).filter(Boolean);
  }
  s.aiPtt = raw.aiPtt === true;
  return s;
}

function stateMessage() {
  return { t: "state", available, ...(available ? pageState : emptyPageState()) };
}

function send(client, msg) {
  if (client.socket.destroyed) return;
  try {
    client.socket.write(JSON.stringify(msg) + "\n");
  } catch {
    client.socket.destroy();
  }
}

function broadcastStateSoon() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const msg = stateMessage();
    for (const c of clients) if (c.authed) send(c, msg);
  }, STATE_DEBOUNCE_MS);
}

function authedCount() {
  let n = 0;
  for (const c of clients) if (c.authed) n++;
  return n;
}

function tokenMatches(candidate) {
  if (typeof candidate !== "string" || candidate.length > 256) return false;
  const h = crypto.createHash("sha256").update(candidate, "utf8").digest();
  return crypto.timingSafeEqual(h, tokenHash);
}

function cleanPress(m) {
  if (!Number.isSafeInteger(m.id) || m.id < 0) return null;
  if (!ACTIONS.has(m.action)) return null;
  const edge = m.edge === "up" ? "up" : "down";
  const press = { action: m.action, edge };
  if (m.action === "play") {
    press.soundId = cleanId(m.soundId);
    if (!press.soundId) return null;
  }
  if (m.action === "profile") {
    press.profileId = cleanId(m.profileId);
    if (!press.profileId) return null;
  }
  return press;
}

async function handlePress(client, m) {
  const press = cleanPress(m);
  if (!press) {
    if (Number.isSafeInteger(m.id)) send(client, { t: "result", id: m.id, ok: false, error: "not-found" });
    return;
  }
  // Remember an open push-to-talk hold so a dropped connection can end it.
  if (press.action === "aiPtt") client.pttHeld = press.edge === "down";
  let res;
  try {
    res = await opts.onPress(press);
  } catch {
    res = { ok: false, error: "unavailable" };
  }
  const ok = !!(res && res.ok);
  const out = { t: "result", id: m.id, ok };
  if (!ok) out.error = ERRORS.has(res && res.error) ? res.error : "unavailable";
  send(client, out);
}

function onLine(client, line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    client.socket.destroy();
    return;
  }
  if (!m || typeof m !== "object") {
    client.socket.destroy();
    return;
  }
  if (!client.authed) {
    if (m.t !== "hello" || m.v !== PROTOCOL_VERSION || !tokenMatches(m.token)) {
      client.socket.destroy();
      return;
    }
    client.authed = true;
    clearTimeout(client.helloTimer);
    send(client, stateMessage());
    opts.onClientsChanged?.(authedCount());
    return;
  }
  if (m.t === "press") handlePress(client, m);
}

function onConnection(socket) {
  if (clients.size >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }
  const client = { socket, authed: false, pttHeld: false, buf: "" };
  clients.add(client);
  client.helloTimer = setTimeout(() => {
    if (!client.authed) socket.destroy();
  }, HELLO_TIMEOUT_MS);

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    client.buf += chunk;
    let idx;
    while ((idx = client.buf.indexOf("\n")) !== -1) {
      const line = client.buf.slice(0, idx);
      client.buf = client.buf.slice(idx + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE) {
        socket.destroy();
        return;
      }
      if (line.trim()) onLine(client, line);
      if (socket.destroyed) return;
    }
    if (Buffer.byteLength(client.buf, "utf8") > MAX_LINE) socket.destroy();
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(client.helloTimer);
    const wasAuthed = client.authed;
    clients.delete(client);
    if (client.pttHeld) {
      client.pttHeld = false;
      Promise.resolve(opts.onPress({ action: "aiPtt", edge: "up" })).catch(() => {});
    }
    if (wasAuthed) opts.onClientsChanged?.(authedCount());
  });
}

function writeDiscovery(pipe) {
  try {
    fs.mkdirSync(path.dirname(discoveryPath), { recursive: true });
    fs.writeFileSync(
      discoveryPath,
      JSON.stringify({ v: PROTOCOL_VERSION, pipe, token: token.toString("hex") }),
    );
    return true;
  } catch (e) {
    console.warn("[streamdeck] failed to write discovery file:", e?.message);
    return false;
  }
}

/**
 * Start the bridge.
 *   appDataDir        app.getPath("appData"); the file goes in a fixed "Soundboard" folder
 *                     so dev and packaged builds agree on where the plugin looks.
 *   onPress(press)    → Promise<{ok, error?}>
 *   onClientsChanged(authedCount)
 */
function start(options) {
  if (server || process.platform !== "win32") return;
  opts = options;
  discoveryPath = path.join(options.appDataDir, "Soundboard", "streamdeck-bridge.json");
  token = crypto.randomBytes(32);
  tokenHash = crypto.createHash("sha256").update(token.toString("hex"), "utf8").digest();
  const pipe = pipeName();

  server = net.createServer(onConnection);
  server.on("error", (e) => {
    // EADDRINUSE: another Soundboard instance already owns the pipe (and the file).
    console.warn("[streamdeck] bridge unavailable:", e?.code || e?.message);
    server = null;
  });
  server.listen(pipe, () => {
    if (!writeDiscovery(pipe)) stop();
  });
}

function stop() {
  clearTimeout(stateTimer);
  stateTimer = null;
  for (const c of clients) c.socket.destroy();
  clients.clear();
  if (server) {
    try {
      server.close();
    } catch {}
    server = null;
  }
  // Only remove the file if it is still ours (a second instance may have replaced it).
  if (discoveryPath && token) {
    try {
      const j = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
      if (j.token === token.toString("hex")) fs.unlinkSync(discoveryPath);
    } catch {}
  }
  token = null;
  tokenHash = null;
}

function setAvailable(next) {
  next = !!next;
  if (available === next) return;
  available = next;
  if (!available) pageState = emptyPageState();
  broadcastStateSoon();
}

function setState(raw) {
  if (!available) return;
  pageState = sanitizeState(raw);
  broadcastStateSoon();
}

module.exports = { start, stop, setAvailable, setState, authedCount };
