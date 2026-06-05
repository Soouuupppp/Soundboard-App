const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");

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
      resolve(val);
    };
    ipcMain.handle("soundboard:submitUrl", (_e, value) => done(value || null));
    ipcMain.handle("soundboard:cancelUrl", () => done(null));
    win.on("closed", () => done(null));
  });
}

// --- Main window + keybinds -------------------------------------------------

let mainWindow = null;
const registered = new Set();

function toElectronAccelerator(combo) {
  return combo
    .split("+")
    .map((p) => p.trim())
    .map((p) => {
      if (p === "Ctrl") return "CommandOrControl";
      if (p === "Meta") return "Super";
      if (p === "Space") return "Space";
      return p;
    })
    .join("+");
}

function registerCombos(combos) {
  for (const acc of [...registered]) {
    if (!combos.has(acc)) {
      try { globalShortcut.unregister(acc); } catch {}
      registered.delete(acc);
    }
  }
  for (const combo of combos) {
    const acc = toElectronAccelerator(combo);
    if (registered.has(acc)) continue;
    try {
      const ok = globalShortcut.register(acc, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("soundboard:globalKey", { combo });
        }
      });
      if (ok) registered.add(acc);
      else console.warn("[soundboard] failed to register", combo);
    } catch (e) {
      console.warn("[soundboard] register error", combo, e?.message);
    }
  }
}

function appIconPath() {
  const file = process.platform === "win32" ? "icon.ico" : "icon.png";
  return path.join(__dirname, "assets", file);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Soundboard",
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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
              if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(next);
            }
          },
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

  createWindow(url);

  ipcMain.handle("soundboard:registerKeybinds", (_evt, combos) => {
    if (!Array.isArray(combos)) return false;
    registerCombos(new Set(combos));
    return true;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveUrl());
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
