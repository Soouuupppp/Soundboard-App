const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const hotkeys = require("./hotkeys");
const vrControllers = require("./vr-controllers");
const { autoUpdater } = require("electron-updater");

// --- Settings persistence ---------------------------------------------------
// Stored in userData (per-OS app data dir) so each friend keeps their own URL.

const SETTINGS_PATH = () => path.join(app.getPath("userData"), "settings.json");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH(), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH()), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(s, null, 2));
  } catch (e) {
    console.warn("[soundboard] failed to write settings:", e?.message);
  }
}

// Resolution order:
//   1. user's saved override (set via "Change server URL…")
//   2. SOUNDBOARD_URL env (dev override)
//   3. baked-in URL from build (electron/baked.json)
//   4. null → prompt the user on first launch
function readBakedUrl() {
  try {
    const p = path.join(__dirname, "baked.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j.url || null;
  } catch {
    return null;
  }
}
function resolveUrl() {
  const s = readSettings();
  if (s.url) return s.url;
  if (process.env.SOUNDBOARD_URL) return process.env.SOUNDBOARD_URL;
  return readBakedUrl();
}

// Validate that a server URL is well-formed and uses http(s). Returns a
// canonical Origin string ("https://example.com") or null.
function originOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function promptForUrl(current) {
  const win = new BrowserWindow({
    width: 520,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Soundboard — Server URL",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "prompt-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const safeCurrent = String(current || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Soundboard</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e8ee;margin:0;padding:20px;}
  h1{font-size:15px;margin:0 0 8px 0;font-weight:600;}
  p{font-size:12px;color:#9aa3b2;margin:0 0 12px 0;}
  input{width:100%;padding:8px;border-radius:6px;border:1px solid #1f2532;background:#141821;color:#fff;font-size:13px;outline:none;}
  input:focus{border-color:#5865F2;}
  .row{display:flex;gap:8px;margin-top:14px;justify-content:flex-end;}
  button{padding:8px 14px;border-radius:6px;border:0;color:#fff;font-size:13px;cursor:pointer;}
  button.primary{background:#5865F2;}
  button.secondary{background:#1f2532;}
</style></head><body>
<h1>Enter Soundboard server URL</h1>
<p>Example: <code>https://soundboard.example.com</code></p>
<input id="u" value="${safeCurrent}" placeholder="https://..." autofocus />
<div class="row">
  <button class="secondary" id="cancel">Cancel</button>
  <button class="primary" id="ok">Connect</button>
</div>
<script>
  document.getElementById('ok').addEventListener('click', () => {
    const v = document.getElementById('u').value.trim();
    window.promptApi.submit(v);
  });
  document.getElementById('cancel').addEventListener('click', () => window.promptApi.cancel());
  document.getElementById('u').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('ok').click();
    if (e.key === 'Escape') window.promptApi.cancel();
  });
</script>
</body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler("soundboard:submitUrl");
      ipcMain.removeHandler("soundboard:cancelUrl");
      if (!win.isDestroyed()) win.close();
      // Reject anything that isn't an http(s) URL.
      if (val && !originOf(val)) {
        console.warn("[soundboard] rejecting non-http(s) URL from prompt");
        resolve(null);
        return;
      }
      resolve(val);
    };
    ipcMain.handle("soundboard:submitUrl", (_e, value) => done(value || null));
    ipcMain.handle("soundboard:cancelUrl", () => done(null));
    win.on("closed", () => done(null));
  });
}

// --- Auto-update ------------------------------------------------------------
// Windows-only, GitHub-hosted, unsigned. Linux/macOS builds, dev runs, and the
// portable .exe (no install location to update) all skip silently.

function updaterSupported() {
  if (!app.isPackaged) return false;
  if (process.platform !== "win32") return false;
  // electron-builder sets this for the portable target at runtime.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return false;
  return true;
}

let updateCheckInFlight = null;

function wireUpdaterLogs() {
  autoUpdater.logger = {
    info: (...a) => console.log("[updater]", ...a),
    warn: (...a) => console.warn("[updater]", ...a),
    error: (...a) => console.error("[updater]", ...a),
    debug: (...a) => console.log("[updater:debug]", ...a),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
}

// Background check on startup — silent unless an update is found.
function checkForUpdatesInBackground() {
  if (!updaterSupported()) return;
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn("[updater] background check failed:", err?.message || err);
  });
}

// Menu-driven check — surfaces a dialog with the outcome.
async function checkForUpdatesInteractive() {
  if (!updaterSupported()) {
    dialog.showMessageBox({
      type: "info",
      message: "Auto-update is not available for this build.",
      detail:
        process.platform !== "win32"
          ? "Auto-update is currently Windows-only."
          : process.env.PORTABLE_EXECUTABLE_FILE
          ? "The portable build can't self-update. Download a new version from the releases page."
          : "Auto-update only runs in packaged builds.",
    });
    return;
  }
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info || info.version === app.getVersion()) {
        await dialog.showMessageBox({
          type: "info",
          message: "You're up to date.",
          detail: `Current version: ${app.getVersion()}`,
        });
      }
      // If a newer version exists, electron-updater handles downloading and the
      // update-downloaded event below prompts the user to restart.
    } catch (err) {
      await dialog.showMessageBox({
        type: "error",
        message: "Couldn't check for updates.",
        detail: String(err?.message || err),
      });
    } finally {
      updateCheckInFlight = null;
    }
  })();
  return updateCheckInFlight;
}

autoUpdater.on("update-downloaded", async (info) => {
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Soundboard ${info.version} is ready to install.`,
    detail: "Restart to apply the update.",
  });
  if (response === 0) autoUpdater.quitAndInstall();
});

// --- Main window + keybinds -------------------------------------------------

let mainWindow = null;
let currentOrigin = null; // canonical origin of the loaded server URL

function appIconPath() {
  const file = process.platform === "win32" ? "icon.ico" : "icon.png";
  return path.join(__dirname, "assets", file);
}

// Resolve the native VR bridge exe + its action manifest. Packaged builds ship
// them under resources/vr (electron-builder extraResources); dev runs use the
// CMake build output. The generated .vrmanifest is written into userData, which
// is writable even when the install dir under Program Files is not.
function vrPaths() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "vr")
    : path.join(__dirname, "native", "vr-bridge", "build", "Release");
  return {
    exePath: path.join(base, "vr-bridge.exe"),
    actionsPath: path.join(base, "soundboard_actions.json"),
    dataDir: app.getPath("userData"),
  };
}

// Hosts allowed to navigate inside the window even when they aren't the
// soundboard origin — needed so OAuth (Discord) completes in-app and the
// session cookie lands on the right origin.
const OAUTH_HOSTS = new Set(["discord.com", "discordapp.com"]);

function isAllowedNav(url) {
  const o = originOf(url);
  if (!o) return false;
  if (o === currentOrigin) return true;
  try {
    return OAUTH_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Lock down a freshly-created BrowserWindow's navigation surface:
//   - same-origin nav and OAuth provider nav stay in the window
//   - any other nav is opened in the user's external browser
//   - window.open / target=_blank for non-OAuth hosts goes external
//   - block any attempt to grant elevated webPreferences via new windows
function lockdownWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNav(url)) return { action: "allow" };
    const o = originOf(url);
    if (o) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNav(url)) return;
    event.preventDefault();
    const o = originOf(url);
    if (o) shell.openExternal(url).catch(() => {});
  });

  // Defense-in-depth: refuse to attach to webviews and refuse permission
  // requests (notifications, geolocation, etc.) from the remote site — with one
  // exception: microphone capture ("media") is allowed for our own trusted
  // origin so the in-app mic mixer (Virtual Mic mode) can read input devices.
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  // Permissions the in-app mic mixer needs: "media" (getUserMedia microphone)
  // and "speaker-selection" (setSinkId / AudioContext.setSinkId output routing).
  const TRUSTED_PERMS = new Set(["media", "speaker-selection"]);

  // Both handlers receive a URL that may include a path (e.g. ".../dashboard"),
  // so compare on the parsed *origin*, not via strict string equality.
  const isTrustedUrl = (url) => {
    const o = originOf(url);
    return o !== null && o === currentOrigin;
  };

  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb, details) => {
    const allowed = TRUSTED_PERMS.has(perm) && isTrustedUrl(details && details.requestingUrl);
    console.log(
      "[soundboard] permission REQUEST:",
      perm,
      "from",
      details && details.requestingUrl,
      "->",
      allowed ? "ALLOW" : "DENY",
    );
    return cb(allowed);
  });
  // permissions.query() / synchronous checks go through here.
  win.webContents.session.setPermissionCheckHandler((_wc, perm, requestingOrigin) => {
    const allowed = TRUSTED_PERMS.has(perm) && isTrustedUrl(requestingOrigin);
    console.log(
      "[soundboard] permission CHECK:",
      perm,
      "from",
      requestingOrigin,
      "->",
      allowed ? "ALLOW" : "DENY",
    );
    return allowed;
  });
}

function createWindow(url) {
  currentOrigin = originOf(url);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Soundboard",
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockdownWindow(mainWindow);
  mainWindow.loadURL(url);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Change server URL…",
          click: async () => {
            const current = resolveUrl() || "";
            const next = await promptForUrl(current);
            if (next) {
              writeSettings({ ...readSettings(), url: next });
              currentOrigin = originOf(next);
              if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(next);
            }
          },
        },
        {
          label: "Check for updates…",
          click: () => { checkForUpdatesInteractive(); },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  wireUpdaterLogs();
  buildMenu();

  let url = resolveUrl();
  if (!url) {
    url = await promptForUrl("");
    if (!url) {
      app.quit();
      return;
    }
    writeSettings({ url });
  }

  // Reject non-http(s) URLs from settings/baked/env too.
  if (!originOf(url)) {
    console.error("[soundboard] refusing to load non-http(s) URL:", url);
    app.quit();
    return;
  }

  createWindow(url);

  // Defer a few seconds so the window is up before any update toast appears.
  setTimeout(checkForUpdatesInBackground, 4000);

  // Start the passthrough keyboard hook. Each match is forwarded to the
  // renderer the same way the old globalShortcut path did.
  hotkeys.start({
    onMatch: (combo) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("soundboard:globalKey", { combo });
      }
    },
  });

  // Start the native VR controller bridge (Valve Index, via SteamVR). It runs
  // as a separate process; button presses are forwarded on their own channel
  // so they stay independent of the keyboard path.
  const vp = vrPaths();
  vrControllers.start({
    exePath: vp.exePath,
    actionsPath: vp.actionsPath,
    dataDir: vp.dataDir,
    onInput: ({ token, pressed }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("soundboard:vrInput", { token, pressed });
      }
    },
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("soundboard:vrStatus", status);
      }
    },
  });

  ipcMain.handle("soundboard:registerKeybinds", (_evt, combos) => {
    if (!Array.isArray(combos)) return { ok: false, error: "not an array" };
    // Cap how many combos a remote page can ever register at once.
    if (combos.length > 200) return { ok: false, error: "too many combos" };
    // Validate each one server-side so the renderer can't slip through junk.
    const accepted = [];
    const rejected = [];
    for (const c of combos) {
      const v = hotkeys.validateCombo(c);
      if (v.ok) accepted.push(c);
      else rejected.push({ combo: c, reason: v.reason });
    }
    hotkeys.setCombos(accepted);
    return { ok: true, accepted: accepted.length, rejected };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveUrl());
  });
});

app.on("will-quit", () => {
  hotkeys.stop();
  vrControllers.stop();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Disallow any non-existing webContents from creating new windows or
// navigating elsewhere — belt-and-braces in case a future code path opens a
// BrowserWindow without going through createWindow().
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNav(url)) return { action: "allow" };
    const o = originOf(url);
    if (o) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
});
