# Soundboard — Electron wrapper

Wraps the running web app in a desktop window and registers the user's
configured keybinds as OS-level global shortcuts. Press a key from anywhere
and the corresponding sound plays in the wrapped app.

**Author:** Soouuupppp · [soouuupppp.com](https://soouuupppp.com) · [soouuuppppgames@gmail.com](mailto:soouuuppppgames@gmail.com) · [github.com/Soouuupppp](https://github.com/Soouuupppp)

## Run from source

```bash
pnpm --filter electron install
pnpm --filter electron start
```

On first launch you'll be prompted for the server URL (e.g.
`http://localhost:5050` for local dev, or `https://your-host` for prod). The
URL is saved in `userData/settings.json` so it's only asked once. Change it
later via **File → Change server URL…**.

You can also force a URL via env var (skips the prompt):

```bash
SOUNDBOARD_URL=http://localhost:5050 pnpm --filter electron start
```

## Build a Windows .exe to share

Set your public server URL first so it's baked into the binary — your friends
won't be prompted for anything.

PowerShell:
```powershell
$env:SOUNDBOARD_URL = "https://soundboard.example.com"
pnpm --filter electron install
pnpm --filter electron dist:win
```

bash / zsh:
```bash
SOUNDBOARD_URL=https://soundboard.example.com pnpm --filter electron install
SOUNDBOARD_URL=https://soundboard.example.com pnpm --filter electron dist:win
```

Outputs to `electron/dist/`:

- `Soundboard-1.1.0-x64.exe` — NSIS installer (Start Menu + desktop shortcuts).
- `Soundboard-1.1.0-x64-portable.exe` — single-file executable, no install.

Send one of these to your friends. They open it, log in with Discord, done.
Power users can still change the URL later via **File → Change server URL…**
if you ever move the server.

If you skip setting `SOUNDBOARD_URL`, the build still works but the app will
prompt the user for a URL on first launch.

> **Windows only.** The mac/Linux build targets were removed — the desktop
> wrapper ships for Windows. The website itself (including Virtual Mic mode)
> still runs in any modern browser on any OS.

## Releasing a new version (auto-update)

Installed Windows clients check for updates ~4 seconds after launch and on
demand via **File → Check for updates…**. They poll the latest GitHub Release
for a `latest.yml` manifest written by `electron-builder`.

To ship a new version:

1. Bump `"version"` in `electron/package.json` (semver).
2. Commit and push to `master`. The `Electron Release` workflow:
   - builds the Windows NSIS installer and portable .exe,
   - publishes them along with `latest.yml` to a draft GitHub release tagged
     `electron-v<version>`,
   - then flips the draft to a published "latest" release.
3. Within a few seconds of their next launch, installed clients see the new
   version, download it in the background, and get a "Restart now / Later"
   prompt when it's ready. Choosing "Later" installs on next quit.

Notes:

- **Portable .exe users don't auto-update.** electron-updater can't write over
  a single-file portable executable, so the check no-ops on those builds. They
  need to re-download from the releases page.
- **Linux/macOS builds are not published by CI** in the current setup. Build
  locally with `pnpm dist` if you need them — only Windows gets auto-updates.
- The workflow skips if a published release with the matching tag already
  exists, so re-pushing the same version is safe.
- Set `SOUNDBOARD_URL` as a repo **variable** (Settings → Variables → Actions)
  to bake your server URL into CI builds. Without it the packaged app prompts
  on first launch.

### Code signing (optional)

The Windows build is **unsigned** by default — Windows SmartScreen will show
"Windows protected your PC" on first launch; the user clicks "More info → Run
anyway". For a signed build, set `CSC_LINK` and `CSC_KEY_PASSWORD` env vars
pointing at a `.pfx` certificate before running `dist:win`. See
electron-builder's [code signing docs](https://www.electron.build/code-signing).

## How it works

- `main.js` opens a `BrowserWindow` pointed at the configured URL.
- `preload.js` exposes `window.soundboard.registerKeybinds(combos)`.
- The dashboard calls that with the list of configured combos. The main process
  validates each combo and registers it with `hotkeys.js`, which is backed by
  `uiohook-napi` — a low-level keyboard listener that **observes** key events
  rather than capturing them. The key still fires in whatever app currently
  has focus.
- When a watched combo matches, the main process sends an IPC message; the
  preload re-emits it as a `soundboard:globalKey` `CustomEvent` on `window`
  and the dashboard listener triggers playback.

## Notes / caveats

- Because hotkeys are passthrough, dangerous combos (e.g. just `A`) will
  trigger playback every time you type that key. The web UI shows a warning
  when you assign one.
- Audio plays through the Electron renderer, so the app must be running
  (windowed or minimized — focus is not required).
- For friends to use your binary, your server must be reachable from their
  network (deploy somewhere, or set up a tunnel). Discord OAuth needs the
  matching redirect URI configured on your Discord application.
