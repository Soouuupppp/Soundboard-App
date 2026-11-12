# Soundboard — Electron wrapper

Wraps the running web app in a desktop window and registers the user's
configured keybinds as OS-level global shortcuts. Press a key from anywhere
and the corresponding sound plays in the wrapped app. It also reads **Valve
Index VR controllers** through a bundled native OpenVR sidecar, so controller
binds fire the same way — even when the app isn't focused.

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

## VR controller bridge (native)

Valve Index support is provided by `native/vr-bridge` — a small C++/OpenVR
background app (`vr-bridge.exe`) that reads the controllers via the SteamVR
Input system and prints button edges as JSON on stdout. The `dist*` scripts
build it automatically (via `build:native`), but you can build it on its own:

```bash
pnpm --filter electron build:native   # CMake → resources/vr/vr-bridge.exe
```

Requires Windows with the **Visual Studio 2022 C++ workload** and **CMake**. In
dev runs the app looks for the CMake `build/Release` output; packaged builds
ship the exe under `resources/vr`. A missing exe just disables VR input quietly
(keybinds still work).

## Livepad capture helper (native)

Livepad records individual apps and playback devices through
`native/audio-capture`, a small C++/WASAPI helper (`audio-capture.exe`). `build:native`
builds it alongside the VR bridge and stages it into `resources/audio-capture`. It only
runs while Livepad needs it. A missing exe just hides those sources (recording devices
still work).

The first time a source is turned on, a native dialog asks for approval. Approvals are
stored per server + source in the app's userData folder and can be cleared with
**File → Forget Livepad capture approvals…**.

Once a source is approved, the configured server's page can start it again without another
prompt, so only approve sources on a server you trust. Approving an app also records any child
processes it starts, even ones with a different name. App names shown in the picker and dialog
come from each program's own version information.

## Stream Deck plugin

`../streamdeck` is our own Elgato Stream Deck plugin (Windows only, keypad buttons only).
It talks to this app over a local named pipe, so it only works with the desktop app,
not the browser version. Buttons: **Play sound**, **Cancel all**, **AI push-to-talk**
(hold), **AI replay**, **Livepad capture** and **Switch profile**. They work while the
dashboard is open; otherwise the key shows Stream Deck's alert.

Install it with **File → Install Stream Deck plugin…** (opens the bundled
`.streamDeckPlugin`, which the Stream Deck app installs), or download
`com.soouuupppp.soundboard.streamDeckPlugin` from the GitHub release. Then drag the
actions from the **Soundboard** category onto keys; Play sound and Switch profile list
your sounds and profiles live while the app's dashboard is open. **Settings → Stream
Deck** in the app shows whether the plugin is connected.

`pnpm build:streamdeck` builds and packs the plugin into `resources/streamdeck`
(also run by `dist`/`dist:win`/`dist:portable`/`release:win`). In dev, the File menu
item opens that file. The pipe and its discovery file
(`%APPDATA%\Soundboard\streamdeck-bridge.json`, a per-launch token readable only by
your Windows user) are created at app start and the file is deleted on quit.

**No-plugin fallback:** Stream Deck's built-in **Hotkey** action can press a key the
app already listens for. Bind a sound to an unused key such as **F13–F24** in the app,
then set a Hotkey button to send that key. This is tap-only (no hold-to-talk), the
button can't show the sound name, and it doesn't fire while you're holding a modifier
key, because keybinds need an exact modifier match.

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

- `Soundboard-Setup-1.5.1-x64.exe` — NSIS installer (Start Menu + desktop shortcuts).
- `Soundboard-1.5.1-x64-portable.exe` — single-file executable, no install.

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
  and the dashboard listener triggers playback. The hook also emits the matching
  **key-up** edge (`soundboard:globalKeyUp`) so a held combo works as true
  push-to-talk for the AI voice changer even when the app is unfocused.
- VR input flows the same way: `vr-controllers.js` spawns the native
  `vr-bridge.exe`, forwards each button edge over IPC → `soundboard:vrInput` /
  `soundboard:vrStatus` `CustomEvent`s, and the dashboard's matcher fires the
  bound clip.
- Stream Deck: `streamdeck-bridge.js` serves a named pipe for the plugin. After a
  token handshake, presses go to the dashboard through `window.soundboard.streamDeck`
  (only from the configured server's main frame), and the dashboard publishes its
  sound and profile lists back, which main re-validates before passing them on.

## Notes / caveats

- Because hotkeys are passthrough, dangerous combos (e.g. just `A`) will
  trigger playback every time you type that key. The web UI shows a warning
  when you assign one.
- Audio plays through the Electron renderer, so the app must be running
  (windowed or minimized — focus is not required).
- For friends to use your binary, your server must be reachable from their
  network (deploy somewhere, or set up a tunnel). Discord OAuth needs the
  matching redirect URI configured on your Discord application.
