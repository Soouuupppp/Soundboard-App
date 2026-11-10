// Bridge to the native audio-capture.exe (Livepad per-app and playback-device capture).
//
// Runs the helper only while something needs it. Unlike vr-bridge's line JSON, its
// stdout is framed binary because it carries PCM:
//   1 byte type (1 = JSON event, 2 = PCM), 3 reserved, u32 LE length, payload.
//
// Public API:
//   start({ exePath, excludeExe, onEvent, onPcm })   true if the helper can run
//   capture(key) / capture(null)                     start or stop recording a source
//   stop()
//
// A missing exe (native not built or not packaged) disables the feature quietly.

const { spawn } = require("child_process");
const fs = require("fs");

const TYPE_JSON = 1;
const TYPE_PCM = 2;
const HEADER = 8;
const MAX_FRAME = 1024 * 1024; // the helper's real frames are a few KB
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 10000;

let child = null;
let config = null;
let wanted = false;
let captureKey = null;
let backoff = BACKOFF_MIN;
let restartTimer = null;
let warnedMissing = false;

function write(line) {
  try {
    if (child) child.stdin.write(line + "\n");
  } catch (e) {
    console.warn("[audio-capture] write failed:", e && e.message);
  }
}

function spawnOnce() {
  restartTimer = null;
  if (!wanted || child) return;
  const proc = spawn(config.exePath, ["--exclude-exe", config.excludeExe], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  child = proc;
  proc.stdin.on("error", () => {}); // a dying helper closes the pipe mid-write

  let pending = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= HEADER) {
      const length = pending.readUInt32LE(4);
      if (length > MAX_FRAME) {
        console.warn("[audio-capture] bad frame, restarting helper");
        proc.kill();
        return;
      }
      if (pending.length < HEADER + length) break;
      const type = pending[0];
      const payload = pending.subarray(HEADER, HEADER + length);
      pending = pending.subarray(HEADER + length);
      if (type === TYPE_PCM) {
        try {
          config.onPcm(payload);
        } catch (e) {
          console.warn("[audio-capture] onPcm threw:", e && e.message);
        }
      } else if (type === TYPE_JSON) {
        let msg;
        try {
          msg = JSON.parse(payload.toString("utf8"));
        } catch {
          continue;
        }
        if (msg.t === "hello") {
          backoff = BACKOFF_MIN;
          if (captureKey) write(`start ${captureKey}`); // resume after a helper crash
        }
        try {
          config.onEvent(msg);
        } catch (e) {
          console.warn("[audio-capture] onEvent threw:", e && e.message);
        }
      }
    }
  });

  proc.on("error", (e) => console.warn("[audio-capture] spawn error:", e && e.message));
  proc.on("exit", (code, signal) => {
    if (child === proc) child = null;
    if (!wanted) return;
    console.warn(`[audio-capture] helper exited (code=${code}, signal=${signal}); restarting in ${backoff}ms`);
    try {
      config.onEvent({ t: "exit" });
    } catch {}
    restartTimer = setTimeout(spawnOnce, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });
}

function start(cfg) {
  if (!cfg.exePath || !fs.existsSync(cfg.exePath)) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[audio-capture] audio-capture.exe not found — native Livepad sources disabled.\n" +
          `         Looked for: ${cfg.exePath}\n` +
          "         Build it: pnpm --filter electron build:native"
      );
    }
    return false;
  }
  config = cfg;
  wanted = true;
  if (!child && !restartTimer) spawnOnce();
  return true;
}

function capture(key) {
  captureKey = key;
  write(key ? `start ${key}` : "stop");
}

function stop() {
  wanted = false;
  captureKey = null;
  backoff = BACKOFF_MIN;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (child) {
    try {
      child.kill();
    } catch {}
    child = null;
  }
}

module.exports = { start, capture, stop };
