// Bridge to the native vr-bridge.exe (Valve Index controller listener).
//
// Mirrors hotkeys.js: an external input source that emits "tokens" into the
// same playback pipeline. vr-bridge.exe is a background OpenVR app that prints
// line-delimited JSON on stdout; we parse it and surface button-down edges via
// onMatch and SteamVR connection state via onStatus.
//
// Public API:
//   start({ exePath, actionsPath, dataDir, onInput, onStatus })
//     onInput({ token, pressed })  pressed=true on press, false on release
//   stop()
//
// Lifecycle: the sidecar self-reconnects to SteamVR; we restart the *process*
// (with backoff) only if it crashes. A missing exe (native not built / not
// packaged) disables the feature quietly, the way a missing uiohook does.

const { spawn } = require("child_process");
const fs = require("fs");

let child = null;
let stopped = false;
let backoff = 500; // ms, doubles up to a cap on repeated crashes
const BACKOFF_MAX = 10000;

function start({ exePath, actionsPath, dataDir, onInput, onStatus }) {
  stopped = false;

  if (!exePath || !fs.existsSync(exePath)) {
    console.warn(
      "[vr-controllers] vr-bridge.exe not found — VR controller input disabled.\n" +
        `         Looked for: ${exePath}\n` +
        "         Build it: pnpm --filter electron build:native"
    );
    return false;
  }

  const spawnOnce = () => {
    if (stopped) return;
    child = spawn(exePath, ["--actions", actionsPath, "--data", dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        backoff = 500; // the process is talking → it's healthy
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if ((msg.t === "down" || msg.t === "up") && typeof msg.token === "string") {
          try {
            onInput && onInput({ token: msg.token, pressed: msg.t === "down" });
          } catch (e) {
            console.warn("[vr-controllers] onInput threw:", e && e.message);
          }
        } else if (msg.t === "status") {
          try {
            onStatus && onStatus({ steamvr: !!msg.steamvr });
          } catch (e) {
            console.warn("[vr-controllers] onStatus threw:", e && e.message);
          }
        }
      }
    });

    child.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) console.warn("[vr-bridge]", s);
    });

    child.on("error", (e) => {
      console.warn("[vr-controllers] spawn error:", e && e.message);
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      console.warn(
        `[vr-controllers] bridge exited (code=${code}, signal=${signal}); ` +
          `restarting in ${backoff}ms`
      );
      const delay = backoff;
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
      setTimeout(spawnOnce, delay);
    });
  };

  spawnOnce();
  return true;
}

function stop() {
  stopped = true;
  if (child) {
    try {
      child.kill();
    } catch {}
    child = null;
  }
}

module.exports = { start, stop };
