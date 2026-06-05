# Soundboard — Electron wrapper

Wraps the running web app in a desktop window and registers the user's
configured keybinds as OS-level global shortcuts. Press a key from anywhere
and the corresponding sound plays in the wrapped app.

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

- `Soundboard-0.1.0-x64.exe` — NSIS installer (Start Menu + desktop shortcuts).
- `Soundboard-0.1.0-x64-portable.exe` — single-file executable, no install.

Send one of these to your friends. They open it, log in with Discord, done.
Power users can still change the URL later via **File → Change server URL…**
if you ever move the server.

If you skip setting `SOUNDBOARD_URL`, the build still works but the app will
prompt the user for a URL on first launch.

### Other platforms

```bash
pnpm --filter electron dist            # current OS
pnpm --filter electron exec electron-builder --mac    # .dmg (must be run on macOS, requires signing for distribution)
pnpm --filter electron exec electron-builder --linux  # .AppImage
```

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
  registers each one with `globalShortcut`.
- When a global shortcut fires, the main process sends an IPC message; the
  preload re-emits it as a `soundboard:globalKey` `CustomEvent` on `window`
  and the dashboard listener triggers playback.

## Notes / caveats

- Combos already taken by the OS (e.g. `Ctrl+Alt+Del`) silently fail to
  register. Check the dev console (View → Toggle Developer Tools).
- Audio plays through the Electron renderer, so the app must be running
  (windowed or minimized — focus is not required).
- For friends to use your binary, your server must be reachable from their
  network (deploy somewhere, or set up a tunnel). Discord OAuth needs the
  matching redirect URI configured on your Discord application.
