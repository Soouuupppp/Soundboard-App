# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A Discord-authenticated soundboard. Users log in with Discord, upload mp3s (or
import from YouTube), tag and organize them in a **Saved** library, promote a
curated subset onto a playable **Board**, assign keyboard **and VR controller**
binds (Valve Index or Meta Quest/Touch), and optionally share clips publicly for others to browse and
add to their own library. A **Virtual Mic mode** mixes mics + the soundboard
into a virtual audio cable so the sounds come through as your mic in
games/calls. An **Electron wrapper** registers the board's keybinds as OS-level
global hotkeys (and listens to VR controllers via a native OpenVR sidecar) so
they fire even when the app isn't focused.

Public instance: https://soundboard.soouuupppp.com

## Monorepo layout

pnpm workspace (`pnpm-workspace.yaml`), package manager pinned to `pnpm@9.12.3`.

- **`web/`** — `soundboard-web`, the Next.js 15 app (App Router, TypeScript).
  Everything user-facing lives here.
- **`electron/`** — `soundboard-electron`, the desktop wrapper. Loads a remote
  server URL in a `BrowserWindow` and adds global hotkeys + VR controller input.
  **Windows-only.**
  - **`electron/native/vr-bridge/`** — a small **C++/OpenVR** background app
    (`vr-bridge.exe`) that reads Valve Index / Meta Quest (Touch) controllers and
    prints button edges as JSON. Built with CMake; staged into
    `electron/resources/vr` for packaging.
- Root `package.json` is just convenience scripts that delegate into the
  workspaces.

Versions across all three `package.json` files are kept in lockstep
(currently **1.3.1**).

## Stack

- **web/** — Next.js 15 (App Router), Tailwind (glassy dark UI), Auth.js v5 /
  `next-auth` beta (Discord provider), Drizzle ORM, Postgres, Zod for
  validation. Client-side audio editing uses **`wavesurfer.js` v7 + Regions**
  (waveform multi-segment cut editor) and **`@breezystack/lamejs`** (pure-JS mp3
  re-encoder). The **CSP lives in `middleware.ts`** (per-request nonce), not
  `next.config.ts`.
- **electron/** — Electron 33, `uiohook-napi` (low-level keyboard hook),
  `electron-updater` (GitHub-release auto-update), `electron-builder`. The
  **vr-bridge** sidecar is C++ linking the bundled **OpenVR** SDK.
- **Postgres** — official `postgres:16-alpine`.
- **YouTube import** needs **`yt-dlp` + `ffmpeg`** on PATH; the web Dockerfile
  installs both. Runs in-process (`lib/yt-convert.ts`).
- **docker compose** — `web` + `db` services. The container listens on **5050**
  (compose maps `127.0.0.1:5050:5050`). Uploads bind-mounted to `./data_public`,
  postgres data to `./data_db`. Both gitignored.

## Commands (run from repo root)

```bash
pnpm dev            # next dev (web)
pnpm build          # next build (web)
pnpm db:generate    # drizzle-kit generate (migrations)
pnpm db:migrate     # apply migrations (tsx src/db/migrate.ts)
pnpm electron       # run the desktop wrapper from source
pnpm up / pnpm down # docker compose up --build / down
```

- Web-only extras: `pnpm --filter web <script>` — `lint`, `start`, `db:push`.
- Electron scripts: `pnpm --filter electron <script>` — `start`, `bake`,
  **`build:native`** (CMake-build the vr-bridge → `resources/vr`; Windows + VS
  2022 C++ workload + CMake required), `dist`, `dist:win`, `dist:portable`,
  `release:win`. See `electron/README.md`.

## Key concepts

### Auth, roles, quotas
- Auth.js with the Discord provider; the Drizzle adapter owns the core
  `user`/`account`/`session`/`verificationToken` tables (`web/src/db/schema.ts`).
- Discord user ID is mirrored onto `user.discordId` for fast lookups.
- Two seeded **system roles**: `user` (default) and `admin` (`isSystem`,
  protected from deletion *and rename* — admin detection keys on the literal
  name `"admin"` and seeding on `"user"`, so the role PATCH refuses name edits on
  system roles). Custom roles are creatable in `/admin`.
- **Quotas** (max file size + max total storage) resolve **user override → role
  default → env `DEFAULT_MAX_FILE_SIZE`/`DEFAULT_MAX_TOTAL_STORAGE`**
  (`lib/quota.ts`). Sizes are stored as bytes; the admin UI accepts human strings
  like `5 MB`. There is **no per-role "sound count" quota** in the schema — don't
  invent one.
- **Upload permission** resolves **user `canUploadOverride` → role `canUpload`**.
  Users who can't upload can still browse + save public clips.
- Put a Discord ID in `DISCORD_ADMIN_IDS` to auto-promote on first login.

### Sounds, the Saved library, and the Board
- A `sound` is owned by one user and stored on disk at
  `data_public/<discordId>/<uuid>.mp3` (path mirrored in `sound.storagePath`;
  `lib/storage.ts` owns path safety, `lib/sounds.ts` owns create/delete).
- A `boardEntry` is a **reference** to a sound, with optional override
  `label`/`keybind`/`controllerBind`/`position`. Adding someone's public clip
  creates a reference — the file is **not copied** and doesn't count against the
  adder's quota. If the owner deletes it, references show as unavailable. Adding
  the same public clip twice is **idempotent** (`POST /api/board` returns the
  existing entry) — a Saved library is a set, not a multiset.
- **Saved vs Board split** (`boardEntry.onBoard`): every entry is in the user's
  **Saved** library; only `onBoard=true` entries appear on the playable **Board**
  and get positions/keybinds/VR binds. New entries default to saved-only; the
  user explicitly promotes them. (`bootstrap.sql` backfilled pre-existing entries
  to `true`.) The dashboard exposes Saved/Board pill tabs; Board has a drag
  Reorder mode; Saved has tag-filter chips.
- `/api/sounds/[id]/file` streams the mp3 with an access check (owner always;
  anyone logged-in if the sound is public).
- **Cards are compact by default** (play/cancel + name + read-only bind chips +
  volume); a pencil expands them into full CRUD, add/remove-from-board, and the
  keybind/VR-bind capture controls.

### Tags
- Tags are **global + normalized** (`tag` table, unique lowercased names) joined
  to sounds via `soundTag`. One label is one shared tag across every clip, so
  renaming/deleting a tag in `/admin` affects all clips at once. `lib/tags.ts`
  owns normalization; **cap is `MAX_TAGS_PER_SOUND = 3`**.
- **Invariant: every sound has ≥1 tag.** The shared creation tail
  (`persistSound`) defaults to a seeded **`misc`** tag when none survive
  normalization, so all upload/import paths satisfy it. `bootstrap.sql` seeds
  `misc` and backfilled it onto previously-untagged sounds.

### YouTube import
- `appSettings` (single `singleton` row, admin-editable) holds the master
  `ytEnabled` toggle + limits (`ytMaxDurationSec`, `ytMaxFileSize`,
  `ytConcurrency`, `ytAllowedHosts`). `role` rows carry per-role `yt*Override`
  columns (null → fall back to the global value); the master toggle still gates
  everything.
- A `conversionJob` row tracks one request (pending → running → done/error). The
  client enqueues then polls `/api/sounds/youtube/[jobId]`. `lib/yt-convert.ts`
  is the in-process worker: a `yt-dlp` (bestaudio → mp3, duration/size capped) +
  `ffmpeg` pipeline, bounded by `ytConcurrency`. Configurable via env
  `YTDLP_PATH`, `YTDLP_COOKIES`, `YTDLP_PROXY`, `YTDLP_EXTRACTOR_ARGS`. Stale
  running/pending rows are failed on restart.

### Clip editor (pre-upload)
- `components/ClipEditor.tsx` (+ `lib/audio-edit.ts`) is the shared pre-upload
  editor for both file uploads and YouTube re-encodes. Built on **wavesurfer.js
  v7 + Regions** as a **delete model**: drag selects a span, Del/Backspace
  removes it (shown as red overlays), Space plays; the export is the **kept
  complement, concatenated**. Re-encodes client-side via lamejs
  (`encodeMp3Segments` + `mergeRanges`/`keepSegments`), volume baked in. The
  original file is never stored.

### Keybinds & chords
- `lib/chord.ts` is the **keyboard** chord model: a bind is a *set* of keys held
  together, serialized "+"-joined and canonically ordered (`"Ctrl+Shift+F5"`).
  Matching fires on the key that *completes* a bound set; **largest wins**
  (`pickLargest`), so a chord suppresses its sub-binds. (Controller binds use the
  separate step/sequence model in `lib/vr-bind.ts`, below — the `parseVrChord`/
  `canonicalVrChord` helpers in `chord.ts` are legacy and unused.)
- Keybinds only apply to **on-board** entries, gated by a master keybinds toggle
  + per-entry enable. A **cancel-all** action is a first-class bindable button on
  the Board tab; it routes through the same matching via the `CANCEL_ALL_BIND`
  sentinel and persists device-locally (localStorage `soundboard:cancelAllKeybind`).
- **Duplicate-playback guard:** in the Electron app a focused keypress hits both
  the in-app `keydown` listener and the OS global hook. `playEntry`
  (`Dashboard.tsx`) coalesces with a ~60ms per-entry window so each trigger plays
  once.

### VR controller binds (Valve Index & Meta Quest/Touch)
The full path, web ⇄ Electron ⇄ native:
- **Native** `electron/native/vr-bridge/src/main.cpp` — a background OpenVR app
  (`VRApplication_Background`, no rendering, doesn't steal focus). It reads the
  controller via the SteamVR Input action system and prints line-delimited JSON on
  stdout: `{"t":"status","steamvr":bool}`, `{"t":"down|up","token":"VR:…"}` (Index)
  or `"VRQ:…"` (Quest). Action manifests live in `native/vr-bridge/manifests/`
  (`soundboard_actions.json` + the per-controller bindings `bindings_knuckles.json`
  for Index and `bindings_touch.json` for Touch, both listed in
  `default_bindings`); a generated `.vrmanifest` (names the app "Soundboard") is
  written into the Electron userData dir at runtime.
- **Inputs** come from `makeDigital()` + `makeAnalog()`, which register **both**
  controllers' action tables. Index (per hand): `A`, `B`, `Trigger`, `TriggerPull`
  (analog pull, hysteresis-thresholded, distinct from the `Trigger` click), `Grip`,
  `ThumbstickClick`, `ATouch`, `TrackpadTouch` → `VR:Hand:Key`. Quest/Touch is
  asymmetric (left `X`/`Y` + `Menu`, right `A`/`B`; plus `Trigger`, `TriggerTouch`,
  `Grip`, `ThumbstickClick`, `ThumbstickTouch`, face-button touch, `ThumbrestTouch`)
  → `VRQ:Hand:Key`. **Touch + analog-pull are first-class bindable** (locked owner
  decision) — never filter them out. Only the action set the connected controller's
  binding maps actually fires, so an Index emits `VR:*` and a Touch emits `VRQ:*`.
- **Electron** `vr-controllers.js` spawns the sidecar (path from `vrPaths()` in
  `main.js`: `resources/vr` when packaged, the CMake `build/Release` in dev),
  self-restarts it on crash with backoff, and forwards edges via IPC. `main.js`
  → `webContents.send("soundboard:vrInput"/"soundboard:vrStatus")` → `preload.js`
  re-emits them as window `CustomEvent`s. A missing exe disables the feature
  quietly.
- **Bind model + engine** live in `web/src/lib/vr-bind.ts`. A bind is an
  **ordered list of steps**; each step is a **set of simultaneous actions**; an
  **action** = one input + one **edge** (`down`/`up`), so each input exposes two
  actions (↓/↑). Two modes: **simul** (one step — hold a group together / fire on a
  release) and **seq** (multi-step combo). Matching: a `down` action is
  state-based (satisfied while held), an `up` action is event-based (its release
  fires during the active step); the bind fires when the **last step completes**.
  Steps must advance within `STEP_TIMEOUT_MS` (1.5s) or the bind resets; inputs
  not in the pending step are ignored (don't reset). Among binds completing on
  the **same edge**, **most-specific (most total actions) wins** (`bindWeight`).
  *Caveat:* a short bind that is the temporal prefix of a longer one fires first
  on its own completing edge — "most-specific" only arbitrates same-edge
  completions, not across time.
- **Web** `Dashboard.tsx` drives one stateful `VrMatcher` (in a ref): it
  reconciles the on-board binds (`setBinds`) and `feed`s each controller edge
  (`down`/`up` from the bridge's `pressed` flag), playing the returned hit.
  `vrConnected` / `hasDesktop` gate the UI; the matcher is `reset()` while the
  editor is open so editor presses don't leak into playback. **Enable toggles
  mirror keybinds** (device-local localStorage): a **master switch**
  (`soundboard:controllersEnabled`, shown in the Board header beside the SteamVR
  chip when `hasDesktop`) and a **per-clip switch** (`soundboard:controllerEnabled`,
  missing = on). A bind fires only when both are on; disabled binds are dropped
  from `setBinds`.
- **Composing a bind:** the controller-bind button opens **`VrBindPicker`**, a
  **full-screen drag-flow builder**: a palette of the active profile's actions
  (`vrInputsByHand(profile)`, grouped by hand, each input with ↓/↑) is dragged or
  clicked into a **current-step** group;
  "Add as next step" commits a step in seq mode; a live **test area**
  (`VrBindPreview`) shows progress as you physically perform the bind. Persisted
  as a serialized `VrBind` JSON string in `controllerBind` (`serializeVrBind`).
- **Storage + compat:** a single bind serializes to JSON (leading `{`); **legacy
  `+`-joined chord strings auto-convert** on read (`parseVrBind`) to a single
  simultaneous step of `down` actions, so old binds keep working. `lib/validation.ts`
  bounds the raw length and delegates the grammar/caps to
  `isValidControllerBindString` (accepts a single bind or the profile map below).
  Stored binds render as wrapping per-action pills with `→` step separators
  (`VrBindChips`); labels come from the token alone (`formatVrAction`), so a stored
  Quest bind shows Quest labels regardless of the device's current profile.
- **Controller profiles (Index vs Quest/Touch):** a device-local dropdown
  (`soundboard:controllerProfile`) in the controller-toggle card picks the
  hardware. The two profiles expose **different physical inputs** and live in
  **separate token namespaces** — Index uses `VR:Hand:Key` (unchanged, the
  original 8/hand), Quest uses `VRQ:Hand:Key` (asymmetric: left X/Y + Menu, right
  A/B; plus face/trigger/thumbstick touches + thumbrest, no trackpad/analog-pull).
  Because the namespaces are disjoint, **a bind built on one controller never
  fires on the other** (owner decision). `lib/vr-bind.ts` owns the per-profile key
  lists (`vrInputsByHand(profile)`), labels (`parseToken`/`formatVrAction`, token
  encodes profile so no profile arg needed), and the union `VALID_INPUTS`. The
  native bridge registers **both** action sets and emits whichever the active
  controller's binding maps (`bindings_knuckles.json` → `VR:*`,
  `bindings_touch.json` → `VRQ:*`); the manifest/`main.cpp` action table must stay
  in sync with the web key lists.
- **Per-profile bind storage:** each `boardEntry.controllerBind` (and the
  device-local cancel-all bind) holds a **profile map**
  `{"index":"<serialized>","quest":"<serialized>"}` — switching profile shows /
  edits / activates only that profile's slot, so the other is preserved and the
  visible bind "clears" on switch. `lib/vr-bind.ts` owns the map helpers
  (`parseProfileBinds`/`getProfileBind`/`setProfileBind`); a bare serialized bind
  (pre-profiles) reads as the Index slot. `isValidControllerBindString` validates
  either form (the validation cap is 4096 to fit two binds).
- **Cancel-all** has its own device-local controller bind
  (`soundboard:cancelAllControllerBind`) alongside its keybind, routed through
  `VrMatcher` via the `CANCEL_ALL_BIND` sentinel.

### Virtual Mic mode
The audio engine lives in three files:
- `web/src/lib/audio-mixer.ts` — `MicMixer`, a single `AudioContext` that sums
  **sources** (capture devices + injected soundboard clips) into a **cableBus**
  → limiter → `ctx.destination`, routed via `setSinkId` to the chosen output
  device (the virtual cable = the game's mic). `cableBus.gain` is the master
  **"mic output volume"** (pre-limiter, `setMicOutputVolume`); each input has its
  own cable-send gain (its volume) and the soundboard line has `setSoundboardVolume`.
  A parallel **monitorBus** with per-source **monitor-send** gains (`setMonitorSend`,
  tapping the post-volume signal so "on" matches the cable level) lets you hear
  chosen lines locally without echoing your own mic. A pre-limiter **cableAnalyser**
  drives the cable meter; each live input also has its **own post-volume analyser**
  (`getInputPeak`) for per-source meters.
- `web/src/lib/audio-output.ts` — `useAudioOutput()` hook: device enumeration,
  persisted settings (localStorage `soundboard:output`), normal-vs-mixer
  playback, and mixer lifecycle. **Normal-mode metering:** when
  `AudioContext.setSinkId` is available (`supportsContextSink`), normal playback
  routes through a small **`OutputGraph`** (`<audio>`→`MediaElementSource`→master
  →analyser→`ctx.destination`) so output can be metered even outside Virtual Mic
  mode — and device routing for normal playback then uses **`ctx.setSinkId`**
  (not `<audio>.setSinkId`, which `createMediaElementSource` disables). Without
  context-sink support it falls back to direct `<audio>.setSinkId` and a flat
  meter. `getOutputPeak()` returns the cable peak in Virtual Mic mode, else the
  `OutputGraph` peak.
- `web/src/components/Dashboard.tsx` — the UI. The **Control Panel** is a
  collapsed-by-default card whose slim status bar surfaces the output device,
  Virtual Mic on/off, and a live global output meter (`LevelMeter`); expanding it
  reveals two pill tabs. **Output & volume:** Output device + Monitor device on
  one row, a compact Master-volume row below. **Virtual Mic mode:** a card with
  the enable toggle + the **mic-output-volume** slider + its level meter, then the
  sources as a 3-up responsive grid of `SourceMixRow`s — each an **Enable toggle +
  cable-volume slider + Monitor toggle** (the always-on Soundboard line omits the
  enable). Native `<select>`s are gone; all dropdowns use the shared `Select`.

**Design constraint (important):** sources are **capture devices / cables
only** — no system loopback, no native code. Routing "any app's audio" into the
mic means sending that app to a virtual cable (VB-Audio, VoiceMeeter) or a GoXLR
bus in Windows, which then appears as a capture device here. Loopback and a
native WASAPI addon were both deliberately rejected (security + cost) — see the
`virtual-mic-capture` memory before reopening that decision.

### Electron desktop wrapper
- `main.js` opens a `BrowserWindow` at the configured server URL (baked at build
  time via `baked.json`, env `SOUNDBOARD_URL`, or prompted on first launch and
  saved to `userData/settings.json`; change later via File → Change server URL…).
- `preload.js` exposes `window.soundboard.registerKeybinds(combos)`; the
  dashboard calls it with the board's combos. `hotkeys.js` (backed by
  `uiohook-napi`) **observes** key events without capturing them, so the key
  still reaches whatever app has focus. A match → IPC → `soundboard:globalKey`
  CustomEvent → dashboard triggers playback. VR input flows the same way via
  `vr-controllers.js` (see above).
- Permissions are locked down in `main.js`: only `media` (mic for the mixer) and
  `speaker-selection` (`setSinkId`) are granted; webviews are refused. OAuth
  hosts (`discord.com`, `discordapp.com`) may navigate in-app so the session
  cookie lands on the right origin.
- Auto-update: installed clients poll the latest GitHub Release for a
  `latest.yml`. Portable .exe builds don't auto-update. See `electron/README.md`.

### Layout & navigation
- The dashboard is the **single page** — public browsing is embedded via
  `PublicBrowse` (no standalone `/public` route). `app/layout.tsx` renders a
  **minimal header**: `components/SiteHeader.tsx` (a client wrapper that hides on
  scroll-down / reappears on scroll-up) holding the logo, and `components/UserMenu.tsx`
  (the upload-quota meter + an avatar dropdown with Admin + Sign out). The sign-in/
  sign-out **server actions** are defined in the layout and passed into `UserMenu`
  as props.
- `components/Select.tsx` is the shared dark dropdown primitive (portal-based, so
  its menu escapes `overflow` clipping) — used everywhere instead of native
  `<select>`.

### User-facing notifications
- `components/Toast.tsx` — `ToastProvider` + `useToast` (mounted in the root
  layout), with a `fromResponse` helper (reads a failed Response's `{error}`,
  friendly 429 message) and a `useMutate` hook for fire-and-forget mutations.
  Client fetch/mutation paths route 4xx/5xx/network/429 failures through it
  instead of failing silently. Passive background loads (header quota meter, tag
  autocomplete prefetch) deliberately stay silent.

### `lib/` map
`auth.ts` / `auth-handlers.ts` (Auth.js config + route handlers) · `quota.ts`
(limit resolution + usage) · `storage.ts` (upload paths, path-traversal safety) ·
`sounds.ts` (sound create/delete + `persistSound` tail) · `tags.ts`
(normalize/setSoundTags, 3-tag cap) · `app-settings.ts` (singleton settings +
per-role YT resolution) · `rate-limit.ts` (in-memory token bucket; single
process) · `yt-convert.ts` (YouTube worker) · `audio-mixer.ts` / `audio-output.ts`
(Virtual Mic) · `audio-edit.ts` (decode/encode/segment for the clip editor) ·
`chord.ts` (keyboard chord model) · `vr-bind.ts` (controller step/sequence model
+ matcher) · `validation.ts` (Zod schemas) · `utils.ts` (`formatBytes`, etc.).

## Security notes
- **CSP + nonce live in `web/src/middleware.ts`** (not `next.config.ts`). The
  middleware generates a per-request nonce, sets it on the request's
  `content-security-policy` header (so Next stamps its framework scripts) and on
  the response, and drops `'unsafe-inline'` from `script-src` (now
  `script-src 'self' 'nonce-…'`). The matcher covers all non-static routes; the
  static security headers stay in `next.config.ts`.
- The same middleware does **CSRF defense** for state-changing `/api/*` requests
  (Origin/Referer must match host) — covers the multipart upload route, which
  CORS preflights don't protect. Auth.js routes and Server Actions are exempt
  (they have their own guards).
- `microphone` and `speaker-selection` are scoped to `self` for the in-app
  mixer; everything else is locked down.
- The Electron app loads a **remote** URL, so the renderer is treated as
  semi-trusted — hence the strict permission handlers and the loopback rejection
  above.
- The multipart upload route (`/api/sounds`) requires a **positive
  `Content-Length`** (else `411`) so the per-user size cap is enforced *before*
  `req.formData()` buffers the body — a header-less / chunked request must not be
  allowed to fall through (note `Number("") === 0`, which is finite). Route
  handlers don't inherit `serverActions.bodySizeLimit`, so this guard is the only
  pre-buffer ceiling.
- API responses don't leak internal user UUIDs: `/api/public/sounds` resolves
  `mine` server-side and omits `ownerId` from the payload.

## Project status

**1.3.0 shipped** (feature-complete): the Saved/Board split, mandatory tags +
`misc` default, inline public browser, wavesurfer multi-segment clip editor,
cancel-all-as-a-bind, admin pill redesign with per-role overrides + tag editing,
new-user onboarding overlay, nonce-based CSP, toast notifications, and the
re-architected **step/sequence controller binds** with the full-screen drag-flow
builder (`lib/vr-bind.ts`, `VrBindPicker`). A pre-release security audit hardened
the upload `Content-Length` guard, system-role rename protection, idempotent
public-clip adds, and `ownerId` removal from `/api/public/sounds`.

**1.3.1 shipped** (UX compaction + Quest support): the shared dark `Select`
dropdown (replaces all native `<select>`), the compacted Control Panel (output +
monitor on one row, compact master volume, a 3-up source grid with Enable +
cable-volume + Monitor-toggle rows, a master "mic output volume" gain), full
**Meta Quest/Touch controller support** (accurate per-controller input map in a
separate `VRQ:` token namespace + native `bindings_touch.json`), **per-profile
controller binds** (each entry/cancel-all stores `{index,quest}`; switching
profile swaps which is shown/active), a controller bind for **cancel-all**, and a
**minimal hide-on-scroll header** with an avatar dropdown (the standalone
`/public` page was removed — the dashboard is the single page).

### Tasks — 1.3.1 (UX compaction + Quest support — ✅ shipped)

Version bumped to **1.3.1** across all three `package.json` + docs. Owner
decisions below are **locked**. Ordered for the build cycle: the shared dropdown
primitive first (it unblocks the control panel + Quest profile), then the control
panel, then the controller work (which touches `VrBindPicker` once), then the
header/routing change last so it doesn't churn the panels mid-flight.

1. **Custom dark dropdown component** — replace all **5 native `<select>`** (2 in
   `Dashboard.tsx`, 3 in `AdminPanel.tsx`) with a reusable styled dropdown that
   matches the glassy dark UI (fixes the white/gray native popup). No more native
   `<option>` rendering anywhere. *(Shared primitive — tasks 2 & 4 consume it.)*
   **Progress: ✅ Done**
2. **Control Panel vertical compaction** —
   - *Output & volume tab:* output device + monitor device on one row, a compact
     master-volume row below (the monitor-device dropdown moved up from the
     Virtual Mic panel).
   - *Virtual Mic tab:* a card with Toggle + **Mic output volume** (a master gain
     on `cableBus` in `audio-mixer.ts`, pre-limiter) + the cable level meter.
     Below it the sources as a 3-up grid: each row = **Enable toggle + cable-volume
     slider + Monitor toggle** (Monitor "on" matches the cable level via the
     post-volume `monitorSend`). The Soundboard line is always-on (no enable). The
     old Monitor checkbox card is gone.
   **Progress: ✅ Done** *(monitor is a toggle, not a slider, and enable is its own
   switch — refined in post-review hotfix.)*
3. **Control Panel header** — give more horizontal space to the output-device
   chip + level meter in the slim status bar. *(Same component as task 2 — land
   in one pass.)*
   **Progress: ✅ Done**
4. **Index ↔ Quest controller profile** — a dropdown in the controller-toggle
   card (next to the keybinds/controller switches) to pick the controller type,
   **device-local in localStorage**. Full support: native `vr-bridge` ships a
   Quest/Touch SteamVR binding file (`default_bindings` entry so SteamVR
   auto-maps), and the web bind picker shows the profile's input palette.
   **Progress: ✅ Done** *(superseded by the hotfix below — Quest now has its own
   accurate input map + `VRQ:` token namespace, not just relabels.)*
5. **Controller cancel-all bind** — give cancel-all a controller bind alongside
   its keyboard one. Reuse the now-profile-aware `VrBindPicker` (step/seq, down/up
   edges); store **device-local in localStorage** (mirrors
   `soundboard:cancelAllKeybind`); route through `VrMatcher` via the
   `CANCEL_ALL_BIND` sentinel.
   **Progress: ✅ Done**
6. **Minimal hide-on-scroll header** — collapse the nav to a small header: logo +
   "Soundboard", the upload-quota meter, and a **user-icon dropdown** (Admin +
   Sign out). Header hides on scroll-down, reappears on scroll-up. The dashboard
   is the single page — **remove the standalone `app/public/page.tsx`** (public
   browsing is already embedded via `PublicBrowse`); drop the `My board`/`Public`
   nav links.
   **Progress: ✅ Done**

When you start a fresh batch of work, add a checklist here (task + a **Progress**
field: `Not started` → `In progress` → `✅ Done`) and keep design decisions
locked with the owner recorded inline.

## Conventions
- Match the existing concise, comment-the-why style. The audio files in
  particular carry ASCII signal-flow diagrams in their header comments — keep
  them accurate if you change routing.
- **Do not run linting** (`pnpm lint` / eslint) — don't run it to verify changes.
  `tsc --noEmit` is fine for typechecking.
- License is UNLICENSED / all rights reserved.
- Background context lives in the auto-memory (`virtual-mic-capture`,
  `ver-1-3-0-scope`); consult it before reopening settled decisions.
