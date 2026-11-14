// VRChat avatar panel over OSC (1.5.2, experimental).
//
//   avatar contact ──VRChat──OSC/UDP──► 127.0.0.1:<our port> ──► this module ──► main ──IPC──► dashboard
//   dashboard ──IPC──► main ──► this module ──OSC/UDP──► 127.0.0.1:<VRChat's port> ──► avatar params
//
// Discovery is OSCQuery: we serve a tiny HTTP tree (must contain /avatar, or VRChat
// sends us nothing) and advertise it plus our UDP port over mDNS. We also browse
// mDNS for VRChat's own OSCQuery service to learn its receive port and read the worn
// avatar's parameter list (which Soundboard/v1/Key/<n> exist = the panel's grid size).
// Manual mode skips all of that and uses fixed ports (users who launch with --osc).
//
// Every socket here binds to 127.0.0.1. mDNS itself is multicast on the LAN (that's
// how VRChat finds us), but the records we answer with point at 127.0.0.1, and we
// only trust discovery answers that come from this machine.
//
// We only ever SEND names under SEND_PREFIX (hard-coded check), so a semi-trusted
// page can't drive other avatar parameters.

const dgram = require("dgram");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

const PARAM_ROOT = "/avatar/parameters/";
const SEND_PREFIX = "Soundboard/v1/";
const KEY_RE = /^\/avatar\/parameters\/Soundboard\/v1\/Key\/(\d+)$/;
const MAX_KEYS = 15;
const VALID_GRIDS = new Set([5, 9, 15]);
const REQUERY_MS = 30_000;
const BROWSE_MS = 10_000;
const HTTP_TIMEOUT_MS = 2000;
const HTTP_MAX_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_DEPTH = 4;

const OSCJSON_SVC = "_oscjson._tcp.local";
const OSC_SVC = "_osc._udp.local";

// ---------------------------------------------------------------------------
// OSC 1.0 codec (only what VRChat uses: T, F, i, f, s). Decoding never throws;
// anything malformed or with an unknown type tag is dropped.

const pad4 = (n) => (n + 3) & ~3;

function readString(buf, off) {
  const end = buf.indexOf(0, off);
  if (end < 0) return null;
  const next = pad4(end + 1);
  if (next > buf.length) return null;
  return { value: buf.toString("utf8", off, end), next };
}

function decodeMessage(buf, out) {
  const addr = readString(buf, 0);
  if (!addr || !addr.value.startsWith("/")) return;
  const tags = readString(buf, addr.next);
  if (!tags || !tags.value.startsWith(",")) return;
  let off = tags.next;
  const args = [];
  for (const t of tags.value.slice(1)) {
    if (t === "T") args.push(true);
    else if (t === "F") args.push(false);
    else if (t === "i" || t === "f") {
      if (off + 4 > buf.length) return;
      args.push(t === "i" ? buf.readInt32BE(off) : buf.readFloatBE(off));
      off += 4;
    } else if (t === "s") {
      const s = readString(buf, off);
      if (!s) return;
      args.push(s.value);
      off = s.next;
    } else return; // unsupported type: drop the whole message
  }
  out.push({ address: addr.value, args });
}

function decodePacket(buf, out = [], depth = 0) {
  if (buf.length < 4 || depth > MAX_BUNDLE_DEPTH) return out;
  if (buf.length >= 16 && buf.toString("ascii", 0, 8) === "#bundle\0") {
    let off = 16; // tag + 8-byte timetag (ignored: we act on arrival)
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size <= 0 || size % 4 !== 0 || off + size > buf.length) break;
      decodePacket(buf.subarray(off, off + size), out, depth + 1);
      off += size;
    }
    return out;
  }
  decodeMessage(buf, out);
  return out;
}

function encString(s) {
  const b = Buffer.from(s, "utf8");
  const out = Buffer.alloc(pad4(b.length + 1));
  b.copy(out);
  return out;
}

function encodeMessage(address, value) {
  if (typeof value === "boolean") return Buffer.concat([encString(address), encString(value ? ",T" : ",F")]);
  const n = Buffer.alloc(4);
  n.writeInt32BE(value | 0);
  return Buffer.concat([encString(address), encString(",i"), n]);
}

// ---------------------------------------------------------------------------
// State

let opts = null; // { onPress(n), onStatus(status), config: {manual,inPort,outPort} }
let running = false;
let udp = null;
let udpPort = 0;
let httpServer = null;
let httpPort = 0;
let mdns = null;
let instance = "";
let vrcHttpPort = 0; // VRChat's OSCQuery HTTP port (discovery mode)
let vrcOscPort = 0; // where we send
let avatarKeys = null; // 0 | 5 | 9 | 15 | null (unknown)
let vrchatFound = false;
let lastError = null;
let timers = [];
let queryFailures = 0;
let gen = 0; // bumps on stop/restart so stale async work is ignored

const keyDown = new Map(); // n -> bool, for rising-edge detection
const desired = new Map(); // param name -> bool|int (what the page wants on the avatar)
const sent = new Map(); // param name -> last value sent
let flushQueued = false;
let lastStatusJson = "";

function status() {
  return {
    running,
    vrchatFound,
    avatarKeys,
    manual: !!opts?.config?.manual,
    ...(lastError ? { error: lastError } : {}),
  };
}

function emitStatus() {
  const s = status();
  const j = JSON.stringify(s);
  if (j === lastStatusJson) return;
  lastStatusJson = j;
  opts?.onStatus?.(s);
}

// ---------------------------------------------------------------------------
// Sending (changes only; full resend on avatar change / (re)connect)

function sendRaw(name, value) {
  if (!udp || !vrcOscPort) return;
  if (typeof name !== "string" || !name.startsWith(SEND_PREFIX) || name.includes("..")) return;
  const msg = encodeMessage(PARAM_ROOT + name, value);
  udp.send(msg, vrcOscPort, "127.0.0.1", () => {});
}

function flush() {
  flushQueued = false;
  if (!running || !vrcOscPort) return;
  for (const [name, v] of desired) {
    if (sent.get(name) === v) continue;
    sent.set(name, v);
    sendRaw(name, v);
  }
}

function queueFlush() {
  if (flushQueued) return;
  flushQueued = true;
  setImmediate(flush);
}

function resendAll() {
  sent.clear();
  queueFlush();
}

function sendBool(name, v) {
  if (!name.startsWith(SEND_PREFIX)) return;
  desired.set(name, !!v);
  queueFlush();
}

function sendInt(name, v) {
  if (!name.startsWith(SEND_PREFIX)) return;
  desired.set(name, Math.trunc(Number(v)) || 0);
  queueFlush();
}

/** keys: [{n, active, playing}] (already validated by main). */
function setKeys(keys) {
  for (const k of keys) {
    sendBool(`${SEND_PREFIX}Active/${k.n}`, k.active);
    sendBool(`${SEND_PREFIX}Playing/${k.n}`, k.playing);
  }
}

function setPage(i) {
  sendInt(`${SEND_PREFIX}Page`, i);
}

// ---------------------------------------------------------------------------
// Receiving

function onAvatarChange() {
  keyDown.clear();
  resendAll();
  opts?.onAvatarChange?.();
  if (!opts?.config?.manual) queryAvatar();
}

function onMessage(m) {
  if (m.address === "/avatar/change") {
    if (!vrchatFound && opts?.config?.manual) {
      vrchatFound = true;
      emitStatus();
    }
    onAvatarChange();
    return;
  }
  const k = KEY_RE.exec(m.address);
  if (!k) return;
  const n = Number(k[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_KEYS) return;
  const v = m.args[0];
  const on = v === true || (typeof v === "number" && v > 0.5);
  if (opts?.config?.manual && !vrchatFound) {
    vrchatFound = true;
    emitStatus();
  }
  const was = keyDown.get(n) === true;
  keyDown.set(n, on);
  if (on && !was) opts?.onPress?.(n);
}

// ---------------------------------------------------------------------------
// OSCQuery HTTP server (ours) and client (VRChat's)

function hostInfo() {
  return {
    NAME: "Soundboard",
    OSC_IP: "127.0.0.1",
    OSC_PORT: udpPort,
    OSC_TRANSPORT: "UDP",
    EXTENSIONS: { ACCESS: true, VALUE: true, DESCRIPTION: true },
  };
}

const TREE = {
  DESCRIPTION: "Soundboard",
  FULL_PATH: "/",
  ACCESS: 0,
  CONTENTS: {
    avatar: {
      FULL_PATH: "/avatar",
      ACCESS: 0,
      CONTENTS: {
        change: { FULL_PATH: "/avatar/change", ACCESS: 2, TYPE: "s" },
        parameters: { FULL_PATH: "/avatar/parameters", ACCESS: 0, CONTENTS: {} },
      },
    },
  },
};

function findNode(p) {
  if (p === "/" || p === "") return TREE;
  let node = TREE;
  for (const part of p.split("/").filter(Boolean)) {
    node = node.CONTENTS && Object.prototype.hasOwnProperty.call(node.CONTENTS, part) ? node.CONTENTS[part] : null;
    if (!node) return null;
  }
  return node;
}

function onHttp(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  let url;
  try {
    url = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    res.writeHead(400).end();
    return;
  }
  const body = url.searchParams.has("HOST_INFO") ? hostInfo() : findNode(url.pathname);
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function getJson(port, pathAndQuery) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathAndQuery, timeout: HTTP_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let size = 0;
      const chunks = [];
      res.on("data", (c) => {
        size += c.length;
        if (size > HTTP_MAX_BYTES) req.destroy();
        else chunks.push(c);
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// Walk the parameter tree (nested CONTENTS) for Soundboard/v1/Key/<n> nodes.
function countKeys(node, depth = 0, found = new Set()) {
  if (!node || typeof node !== "object" || depth > 12) return found;
  const m = typeof node.FULL_PATH === "string" ? KEY_RE.exec(node.FULL_PATH) : null;
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= MAX_KEYS) found.add(n);
  }
  if (node.CONTENTS && typeof node.CONTENTS === "object") {
    for (const child of Object.values(node.CONTENTS)) countKeys(child, depth + 1, found);
  }
  return found;
}

function gridFromKeys(found) {
  if (found.size === 0) return 0;
  const n = found.size;
  // Only the three shipped sizes count; anything else is not a Soundboard panel we know.
  return VALID_GRIDS.has(n) && Math.max(...found) === n ? n : 0;
}

async function queryAvatar() {
  const g = gen;
  if (!vrcHttpPort) return;
  const tree = await getJson(vrcHttpPort, "/avatar/parameters");
  if (g !== gen) return;
  if (!tree) {
    queryFailures++;
    if (queryFailures >= 2) lostVrchat();
    return;
  }
  queryFailures = 0;
  avatarKeys = gridFromKeys(countKeys(tree));
  emitStatus();
}

async function connectVrchat(httpPortFound) {
  const g = gen;
  const info = await getJson(httpPortFound, "/?HOST_INFO");
  if (g !== gen) return;
  const port = info && Number(info.OSC_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const changed = port !== vrcOscPort || httpPortFound !== vrcHttpPort;
  vrcHttpPort = httpPortFound;
  vrcOscPort = port;
  queryFailures = 0;
  vrchatFound = true;
  lastError = null;
  if (changed) {
    keyDown.clear();
    resendAll();
  }
  emitStatus();
  await queryAvatar();
}

function lostVrchat() {
  vrcHttpPort = 0;
  vrcOscPort = 0;
  vrchatFound = false;
  avatarKeys = null;
  queryFailures = 0;
  keyDown.clear();
  sent.clear();
  emitStatus();
  browse();
}

// ---------------------------------------------------------------------------
// mDNS: advertise ours, browse for VRChat's

function localAddresses() {
  const set = new Set(["127.0.0.1", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) set.add(a.address.replace(/%.*$/, ""));
  }
  return set;
}

function fromThisMachine(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "").replace(/%.*$/, "");
  return a.startsWith("127.") || a.startsWith("169.254.") || a.toLowerCase().startsWith("fe80:") || localAddresses().has(a);
}

function ourRecords(ttl) {
  const host = `${instance}.local`;
  const oj = `${instance}.${OSCJSON_SVC}`;
  const oo = `${instance}.${OSC_SVC}`;
  return [
    { name: OSCJSON_SVC, type: "PTR", ttl, data: oj },
    { name: oj, type: "SRV", ttl, data: { port: httpPort, target: host, priority: 0, weight: 0 } },
    { name: oj, type: "TXT", ttl, data: ["txtvers=1"] },
    { name: OSC_SVC, type: "PTR", ttl, data: oo },
    { name: oo, type: "SRV", ttl, data: { port: udpPort, target: host, priority: 0, weight: 0 } },
    { name: oo, type: "TXT", ttl, data: ["txtvers=1"] },
    { name: host, type: "A", ttl, data: "127.0.0.1" },
  ];
}

// PTRs as answers, SRV/TXT/A as additionals: VRChat's OSCQuery library reads the
// SRV and A records from the ADDITIONAL section and ignores a reply without them.
function ourResponse(ttl) {
  const all = ourRecords(ttl);
  return { answers: all.filter((r) => r.type === "PTR"), additionals: all.filter((r) => r.type !== "PTR") };
}

function announce(ttl = 120) {
  if (!mdns) return;
  try {
    mdns.respond(ourResponse(ttl));
  } catch {}
}

function onMdnsQuery(query) {
  const names = new Set(ourRecords(120).map((r) => r.name.toLowerCase()));
  const asked = (query.questions || []).some((q) => names.has(String(q.name).toLowerCase()));
  if (asked) announce();
}

function onMdnsResponse(res, rinfo) {
  if (!fromThisMachine(rinfo && rinfo.address)) return;
  const records = [...(res.answers || []), ...(res.additionals || [])];
  const vrcNames = new Set();
  for (const r of records) {
    if (r.type === "PTR" && String(r.name).toLowerCase() === OSCJSON_SVC && typeof r.data === "string" && r.data.startsWith("VRChat-Client-")) {
      vrcNames.add(r.data.toLowerCase());
    }
  }
  for (const r of records) {
    if (r.type !== "SRV" || !String(r.name).startsWith("VRChat-Client-")) continue;
    if (!String(r.name).toLowerCase().endsWith(OSCJSON_SVC)) continue;
    vrcNames.delete(String(r.name).toLowerCase());
    const port = r.data && Number(r.data.port);
    // VRChat on Windows only answers same-machine queries, so always talk to loopback.
    if (Number.isInteger(port) && port > 0 && port <= 65535 && (port !== vrcHttpPort || !vrchatFound)) {
      connectVrchat(port);
    }
  }
  // Got a PTR without its SRV: ask for it.
  for (const name of vrcNames) {
    try {
      mdns.query({ questions: [{ name, type: "SRV" }] });
    } catch {}
  }
}

function browse() {
  if (!mdns) return;
  try {
    mdns.query({ questions: [{ name: OSCJSON_SVC, type: "PTR" }] });
  } catch {}
}

function startMdns() {
  let factory;
  try {
    factory = require("multicast-dns");
  } catch {
    lastError = "mdns-missing";
    return false;
  }
  try {
    mdns = factory();
  } catch {
    lastError = "mdns-failed";
    return false;
  }
  mdns.on("query", onMdnsQuery);
  mdns.on("response", onMdnsResponse);
  mdns.on("error", () => {});
  mdns.on("warning", () => {});
  announce();
  browse();
  return true;
}

function stopMdns() {
  if (!mdns) return;
  const m = mdns;
  mdns = null;
  try {
    // Goodbye records (TTL 0) withdraw the advert, then close.
    m.respond(ourResponse(0), () => {
      try {
        m.destroy();
      } catch {}
    });
  } catch {
    try {
      m.destroy();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

function listenUdp(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.once("error", (e) => {
      try {
        s.close();
      } catch {}
      resolve({ error: e && e.code === "EADDRINUSE" ? "port-in-use" : "udp-failed" });
    });
    s.bind(port, "127.0.0.1", () => {
      s.removeAllListeners("error");
      s.on("error", () => {});
      resolve({ socket: s });
    });
  });
}

function listenHttp() {
  return new Promise((resolve) => {
    const s = http.createServer(onHttp);
    s.once("error", () => resolve(null));
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

/**
 * Start (or restart with new config).
 *   onPress(n)         rising edge on Soundboard/v1/Key/<n>
 *   onStatus(status)   {running, vrchatFound, avatarKeys, manual, error?}
 *   onAvatarChange()   VRChat reported /avatar/change
 *   config             {manual, inPort, outPort}
 */
async function start(options) {
  stop();
  const g = ++gen;
  opts = options;
  const cfg = options.config || {};
  lastError = null;
  instance = `Soundboard-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

  const u = await listenUdp(cfg.manual ? cfg.inPort : 0);
  if (g !== gen) {
    u.socket?.close();
    return;
  }
  if (!u.socket) {
    lastError = u.error;
    emitStatus();
    return;
  }
  udp = u.socket;
  udpPort = udp.address().port;
  udp.on("message", (buf) => {
    for (const m of decodePacket(buf)) onMessage(m);
  });
  running = true;

  if (cfg.manual) {
    vrcOscPort = cfg.outPort;
    resendAll();
    emitStatus();
    return;
  }

  const hs = await listenHttp();
  if (g !== gen) {
    hs?.close();
    return;
  }
  if (!hs) {
    lastError = "http-failed";
    emitStatus();
    return;
  }
  httpServer = hs;
  httpPort = hs.address().port;
  startMdns();
  emitStatus();

  timers.push(
    setInterval(() => {
      if (vrchatFound) queryAvatar();
    }, REQUERY_MS),
    setInterval(() => {
      if (!vrchatFound) browse();
      announce();
    }, BROWSE_MS),
  );
}

function stop() {
  gen++;
  for (const t of timers) clearInterval(t);
  timers = [];
  stopMdns();
  if (httpServer) {
    try {
      httpServer.close();
    } catch {}
    httpServer = null;
  }
  if (udp) {
    try {
      udp.close();
    } catch {}
    udp = null;
  }
  const wasRunning = running;
  running = false;
  udpPort = httpPort = vrcHttpPort = vrcOscPort = 0;
  vrchatFound = false;
  avatarKeys = null;
  queryFailures = 0;
  keyDown.clear();
  // `desired` is kept on purpose: a restart (port change) resends the last key states.
  sent.clear();
  if (wasRunning) emitStatus();
}

module.exports = { start, stop, status, setKeys, setPage, sendBool, sendInt, SEND_PREFIX };
