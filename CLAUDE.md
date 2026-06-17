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
(currently **1.4.1**).

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
- **Postgres** — official `postgres:16-alpine`. **Schema is applied via
  `web/src/db/bootstrap.sql`, NOT drizzle-kit migrations.** The web container's
  start command runs `tsx src/db/migrate.ts && node server.js`; `migrate.ts`
  executes `bootstrap.sql` on **every boot** — hand-maintained, idempotent DDL
  (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
  backfills) — then seeds the system roles. `bootstrap.sql` is the only DDL
  tracked in git; the `drizzle/` output folder is untracked and `pnpm db:generate`
  is **not** part of the deploy path. **When you change the schema, edit BOTH
  `src/db/schema.ts` (drizzle-orm uses it at runtime for queries) AND
  `bootstrap.sql`** (add to the `CREATE TABLE` block for fresh DBs + a matching
  `ADD COLUMN IF NOT EXISTS` backfill for existing ones — see the appSettings
  yt-override / motd columns as the pattern). Do not rely on drizzle migrations.
- **YouTube import** needs **`yt-dlp` + `ffmpeg`** on PATH; the web Dockerfile
  installs both. Runs in-process (`lib/yt-convert.ts`).
- **docker compose** — `web` + `db` services. The container listens on **5050**
  (compose maps `127.0.0.1:5050:5050`). Uploads bind-mounted to `./data_public`,
  postgres data to `./data_db`. Both gitignored.

## Commands (run from repo root)

```bash
pnpm dev            # next dev (web)
pnpm build          # next build (web)
pnpm db:generate    # drizzle-kit generate — NOT the deploy path (see Postgres note); schema lives in bootstrap.sql
pnpm db:migrate     # run src/db/migrate.ts (applies bootstrap.sql + seeds roles) — this is the real schema-apply step
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
The audio engine is **one unified, always-on graph** (rebuilt in 1.4.0 — the
old normal-mode `OutputGraph` + normal-vs-mixer branches are retired). It lives
in two lib files plus the header UI:
- `web/src/lib/audio-mixer.ts` — `MicMixer`, a single `AudioContext`. Buses:
  **`outputBus`** (global master gain, 0–2) → limiter → `ctx.destination`, routed
  via `ctx.setSinkId` to the **output device** (the virtual cable = the game's mic
  when Virtual Mic mode is on); **`monitorBus`** (global, 0–2) → a rebuildable
  monitor tail (`MediaStreamDestination → <audio>`, `setSinkId` to the **monitor
  device**); **`soundboardBus`** (0–2, `setSoundboardVolume`) fans to both output
  and monitor (through a **`soundboardMonitorGate`** that's 0 when monitor==output
  to kill same-device double-play); **`micBus`** (0–2, `setMicVolume`) → outputBus
  + a single **`monitorMicGate`** (`setMonitorMic` toggle) → monitorBus. The
  **mic input is opened only while Virtual Mic mode is on**. Each input runs
  `src → micGate (AI mute) → vol → [per-source FX chain] → micBus`; injected
  soundboard clips run `clip → [per-id FX chain] → soundboardBus`; **preview**
  clips (`injectPreview`) connect to **monitorBus only**, so they never leak into
  the cable. A pre-limiter analyser drives the output meter; each live input has a
  post-chain analyser (`getInputPeak`). The mixer keeps **multi-source** capability
  in code, but the UI exposes a single primary mic.
- `web/src/lib/audio-output.ts` — `useAudioOutput()` hook: device enumeration,
  persisted settings (localStorage `soundboard:output` for devices/volumes,
  `soundboard:soundfx` per-clip effects, `soundboard:voicefx` per-source voice
  changer), the always-on engine lifecycle, the 0–200% global/soundboard/mic
  volume hierarchy, the single **Input Device** accessor, and the AI push-to-talk
  orchestration (record → `convertVoice` → inject). Degrades to a plain `<audio>`
  sink (no FX/meter) only where `AudioContext.setSinkId` is absent. FX-param
  localStorage writes are debounced (~250ms) so slider drags stay smooth.
- `web/src/components/HeaderControls.tsx` — the UI moved into **three header
  popovers** (left of the user menu, shared `Popover` surface, one-open-at-a-time)
  plus the global output meter: **Settings** (`SettingsPanel` — output/monitor/
  **input** device, the three 0–200% volume sliders, Virtual Mic + monitor-mic
  toggles), **Voice changer** (`VoiceChangerPanel` — primary-mic DSP chain + AI),
  and **Sound Effects** (`SoundEffectsPickerModal` — per-clip FX by sound id). The
  old inline Control Panel card / `SourceMixRow` grid is gone. All dropdowns use
  the shared `Select`.

**Design constraint (important):** sources are **capture devices / cables
only** — no system loopback, no native code. Routing "any app's audio" into the
mic means sending that app to a virtual cable (VB-Audio, VoiceMeeter) or a GoXLR
bus in Windows, which then appears as a capture device here. Loopback and a
native WASAPI addon were both deliberately rejected (security + cost) — see the
`virtual-mic-capture` memory before reopening that decision.

### Voice changer (DSP + AI)
Added in 1.4.0, layered on top of the Virtual Mic graph. Two independent paths,
both **device-local** (no DB/schema change):
- **DSP effects (`lib/voice-fx.ts`)** — a **stackable chain** of native Web-Audio
  effects: `EffectKind` (robot/ring-mod, echo, reverb via a synthetic impulse,
  distortion, telephone band-pass, tremolo, low/high-pass, and a **bitcrusher**
  AudioWorklet served from `web/public/worklets/`) + `EffectConfig {id,kind,params}`
  and a `createEffect(ctx,cfg)` factory returning a `{input,output,update,dispose}`
  subgraph. Two scopes: **per-source** (the primary mic, `soundboard:voicefx`,
  inserted in that input's chain in `audio-mixer.ts`) and **per-clip** (by sound
  id, `soundboard:soundfx`, built fresh on every play — Board/keybind/VR + monitor
  previews). Chains rebuild make-before-break to avoid clicks.
- **AI voice (`lib/voice-ai.ts`, best-effort)** — push-to-talk preset voices via
  **`r3gm/rvc_zero`** (HF ZeroGPU Space, MIT), called **browser-direct** through
  `@gradio/client` (no server token, per-user `X-IP-Token` quota). Hybrid presets
  (pitch variants of the MIT `PhoenixStormJr/RVC-V2-default-voice`) + a custom RVC
  model/index URL field. **PTT** records from the mic → `convertVoice` → injects
  the converted clip into the mic's source path (through its DSP chain); while AI
  is on the **raw mic is muted from the cable** (`aiMuted`/`micGate`), so only
  converted bursts pass. An **AI replay** bind re-injects the last clip and a
  bundled chime plays on the monitor when a conversion lands. PTT + replay are
  bindable (keyboard `chord.ts` + VR `vr-bind.ts`, device-local) via the
  `AI_PTT_BIND` / `AI_REPLAY_BIND` sentinels. **Security:** mic audio leaving the
  machine is disclosed in-UI; the CSP `connect-src` is deliberately widened to the
  HF Spaces hosts in `middleware.ts`. Full survey + tradeoffs in
  `docs/voice-changer-research.md`.
- **Shared state lifted out of `Dashboard`** so binds/popovers work from any page:
  `components/VrProvider.tsx` owns `controllerProfile` / `vrConnected` / `hasDesktop`
  + the AI VR pickers; `components/VoiceChangerProvider.tsx` owns the AI-PTT/replay
  bind state + keyboard chord capture. FX presets are a shared device-local library
  (`lib/fx-presets.ts`, `soundboard:fxPresets`) reused by both the voice-changer
  and per-clip sound-effects editors.

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
(Virtual Mic + voice changer engine) · `voice-fx.ts` (native Web-Audio DSP effect
model + factory) · `voice-ai.ts` (browser-direct `@gradio/client` RVC voice
conversion) · `fx-presets.ts` (shared device-local FX preset library) ·
`audio-edit.ts` (decode/encode/segment for the clip editor) · `chord.ts` (keyboard
chord model) · `vr-bind.ts` (controller step/sequence model + matcher) ·
`validation.ts` (Zod schemas) · `utils.ts` (`formatBytes`, etc.).

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

**1.3.2 shipped** (persistent audio engine + local previews): the audio engine
hoisted into a global `components/AudioProvider.tsx` (mounted in `app/layout.tsx`)
so a **single** `MicMixer` survives route changes — collapsing the prior separate
Dashboard/Admin instances and fixing the virtual mic dying on the `/admin` route.
**Monitor-only local previews** (Saved-library, public-browser, and admin sound
previews now play on the monitor device via a `preview` flag, never into the
virtual-mic cable), a **monitor-latency watchdog** (`rebuildMonitorTail` swaps the
`monitorBus → MediaStreamDestination → <audio>` tail on AudioContext
suspend→resume + long idle so the bridge buffer can't accumulate seconds of lag),
a shared darker **`.popover`** surface for floating menus (avatar dropdown +
`Select`), a **"My uploads"** owner-only filter on the Saved tab, and **notice
banners** — an admin-set MOTD (new `appSettings` `motd*` columns, severity +
optional link, version+day dismissal, a `GET /api/motd` poll) plus a
non-dismissible web-only **desktop-app promo** (hidden inside the Electron
wrapper).

**1.3.3 shipped** (font + VR min-hold): the app-wide typeface switched to the
**Play** Google Font (self-hosted via `next/font/google`, `--font-play` in the
`globals.css`/Tailwind `sans` stack), and a per-action **minimum-hold gate** on VR
controller binds — a `down` action with a min-hold latches only if its button was
held continuously **≥ N seconds**, registering on release (early release = no
latch). Per-action presets (0.5 / 1 / 1.2 / 2 / 2.5s + custom) configured in
`VrBindPicker`, stored **device-local** (`soundboard:holdMs`, the serialized
`VrBind` is unchanged), with `STEP_TIMEOUT_MS` raised 1.5s → 3s so a long hold
completes inside one step's reset window. VR-only; keyboard binds untouched.

**1.4.0 shipped** (voice changer + audio-routing & layout refactor): a
per-source/per-clip **voice changer** on top of the Virtual Mic — a stackable
chain of native Web-Audio **DSP effects** (robot/ring-mod, echo, reverb,
distortion, telephone, tremolo, low/high-pass, and a bitcrusher worklet;
`lib/voice-fx.ts`), plus a best-effort **AI voice** path (push-to-talk preset
voices via `r3gm/rvc_zero`, called browser-direct through `@gradio/client` with an
explicit "audio leaves the machine" disclosure; `lib/voice-ai.ts`). The audio
engine was **re-architected into one unified always-on graph** (`audio-mixer.ts`:
`outputBus`/`monitorBus`/`soundboardBus`/`micBus`, a 0–200% global/soundboard/mic
volume hierarchy, a `soundboardMonitorGate` that kills same-device double-play, the
mic opened only with Virtual Mic mode) — the normal-mode `OutputGraph` and the
legacy `masterVolume` were retired. The inline Control Panel card was replaced by
three **header popovers** — **Settings · Voice changer · Sound Effects**
(`HeaderControls`, shared `Popover`) — with a single primary **Input Device**,
**per-clip sound effects** (by sound id, `soundboard:soundfx`) reachable from a
per-card button and a global picker modal, a shared **FX preset library**
(`soundboard:fxPresets`), an **AI replay** bind + "conversion ready" chime, and the
VR controller state + `VrBindPicker` **lifted out of `Dashboard` into shared
providers** (`VrProvider`, `VoiceChangerProvider`) so binds work from any page. All
device-local (no schema change); a CSP `connect-src` widening to the HF Spaces
hosts is the one security tradeoff, documented in `docs/voice-changer-research.md`.

**1.4.1 shipped** (voice-changer effects, sharable presets/voices, paid AI, and
profiles): the DSP palette grew with six more native effects (chorus, flanger,
phaser, vibrato, compressor, megaphone) plus a **noise gate** (envelope-follower
AudioWorklet with hysteresis) and a **pitch shifter** (self-authored granular
worklet; formant re-deferred) — all auto-surfaced through `EFFECT_DEFS`
(`lib/voice-fx.ts`). FX effect-chains and AI voice configs became **publishable
and browsable** via new server libraries (`sharedPreset` + `sharedVoice` tables,
`/api/presets` + `/api/voices` + admin moderation routes; `lib/shared-presets.ts`,
`lib/shared-voices.ts`, `FxPresetBar`/`VoicePresetBar` + browse modals), alongside
the device-local private libraries. **Paid AI voice** was wired through a
same-origin proxy (`/api/ai/sts` + `/api/ai/tts`, `lib/ai-providers.ts`) for
**ElevenLabs + Respeecher** — speech-to-speech conversion and in-browser
**STT→TTS "re-speak"** (`lib/voice-stt.ts`) — with the free `rvc_zero` PTT path
kept as the default; an **AI usage quota** (seconds/month, user override → role →
env, `lib/ai-quota.ts`, `user`/`role`/`appSettings` columns + `/api/ai/usage`)
mirrors the upload quota, plus a **BYO API key** path (device-local, never
persisted server-side, bypasses the quota). Respeecher continuous-live streaming
was researched and **re-deferred** (the standalone Next server has no WS upgrade
hook). **Profiles** landed as a server-side per-profile bundle — the **board
layout** (new `profile` + `profilePlacement` tables, the `boardEntry` placement
columns left orphaned as global Saved membership), the **mic voice-changer chain**,
and **per-clip sound effects** all sync across devices and the desktop app
(`ProfileProvider`, `/api/profiles` CRUD + clone, profile-scoped board/config; the
`audio.soundFx`/`voiceFx` accessors repointed to the active profile with the same
signatures). The header was restructured into a **three-zone navbar**
(`AppHeader`: logo · centered meter+Voice+Sound-Effects+AI popovers · Settings cog +
profile switcher + user menu with the quota bar beneath) with a **profile switcher**
(switch/rename/clone/delete/reorder, cap-aware via role default + per-user
override), the Sound-Effects editors moved to **anchored popovers**, and AI voice
split into its **own popover + a main-page section** when enabled. Schema changes
applied via `bootstrap.sql` (idempotent DDL) per the repo's mechanism — the first
batch to add DB tables to the otherwise device-local voice-changer feature.

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

### Tasks — 1.3.2 (persistent audio engine + local previews)

Version bumped to **1.3.2** across all three `package.json` + docs. Owner
decisions below are **locked**. Do task 1 first — task 2's admin-page case relies
on the shared engine task 1 introduces; task 3 is independent.

1. **Persist the audio engine across navigation** *(bug: virtual mic stops when
   not on the dashboard — admin-only in practice)*. **Root cause:** the audio
   engine (`useAudioOutput` + the `MicMixer`) is owned *inside* `<Dashboard>`,
   and `AdminPanel` separately calls `useAudioOutput()` for its own instance
   (`AdminPanel.tsx`). The unmount effect in `lib/audio-output.ts` calls
   `mixer.stop()`, so navigating from `/dashboard` to the separate `/admin` route
   unmounts Dashboard and **kills the virtual mic**. Only admins can reach
   `/admin`, so only they hit it.
   **Locked decision — hoist to a global provider:** move the engine into a React
   **context provider** mounted in `app/layout.tsx` (above the route segment) so a
   **single shared engine** survives all route changes. `Dashboard` and
   `AdminPanel` both *consume* the context instead of each instantiating the hook
   — this also collapses the two independent engine instances into one. Notes: the
   provider is a **client** component wrapping `layout.tsx`'s children (layout
   stays a server component); all `AudioContext`/`getUserMedia` creation stays
   client-only and lazy; teardown happens only on real app unmount (tab close),
   **not** on route change.
   **Progress: ✅ Done** *(new `components/AudioProvider.tsx` mounts a single
   `useAudioOutput()` in `app/layout.tsx`; `Dashboard`/`AdminPanel`/`PublicBrowse`
   consume it via `useAudio()` — collapses the prior independent instances into
   one engine that survives route changes.)*
2. **Local-only previews — don't route previews through the virtual-mic cable**
   *(feat)*. Today previews call the same cable-routed `audio.play()` as the Board
   (`PublicBrowse.tsx` public-clip preview, Saved-library card plays in
   `Dashboard.tsx`, and the admin sound preview at `AdminPanel.tsx` ~L1188), so in
   Virtual Mic mode they leak into the game mic.
   **Locked decisions:**
   - **What counts as a preview** (local-only): **public-browser previews**,
     **Saved-library (non-board) card previews**, and **admin-page sound
     previews**. **Board plays stay routed** through output/virtual mic — unchanged.
   - **Where a preview plays:** the **selected output device** (so you hear it
     where your other audio goes), but **never into the virtual-mic cable** — even
     when Virtual Mic mode is on.
   **Implementation:** add a preview play path in `lib/audio-output.ts` (e.g. a
   `preview` flag on `play()` or a separate `previewPlay`) that always takes the
   normal-mode `OutputGraph`/`<audio>` route to the selected output device and
   **bypasses `mixer.injectClip` (the cable)** regardless of `virtualMicMode`.
   Point the three preview call sites above at it; leave on-board playback on the
   existing cable-routed path. (Depends on task 1 for the admin-page case to be
   audible while Virtual Mic mode is on.)
   **Progress: ✅ Done** *(added a `preview` flag to `play()` in
   `lib/audio-output.ts`, wired into the Saved-tab card play (`playEntry(..., view
   === "saved")`), the inline `BrowsePublicPanel` preview, `PublicBrowse.tsx`, and
   the admin sound preview. Board plays / keybind / VR triggers stay routed.
   **Hotfix (owner override of the original "selected output device" decision):**
   previews now ALWAYS play on the **Monitor device** via a plain `<audio>` +
   `setSinkId(monitorDeviceId)` — never the cable, never the output device. In
   Virtual Mic mode the output device IS the cable, so routing previews there both
   leaked into the game mic and was inaudible; the monitor device is where you
   actually hear local audio.)*
3. **Monitor-latency watchdog — fix growing monitor delay over long sessions**
   *(bug)*. **Symptom:** after the app runs many hours (e.g. left open overnight,
   across a PC sleep/resume), the local **monitor** sound lags the trigger by
   2-3s, while the cable meter still fires instantly. **Confirmed by owner:**
   toggling Virtual Mic off/on (or reloading) clears it. **Root cause:** the cable
   path is a direct AudioContext output (`cableBus → limiter → ctx.destination`,
   and the meter taps `cableBus`), but the **monitor** path bridges through a
   `MediaStreamAudioDestinationNode → <audio>` element (`monitorDest`/`monitorEl`
   in `audio-mixer.ts`) so it can target a *different* device than the cable. That
   bridge has a jitter buffer that **accumulates latency** over long uptime on
   Chromium — so the meter (cable tap) stays real-time while the monitor element
   buffers behind. Not a logic bug; a platform behavior of the MediaStream→element
   bridge.
   **Fix direction:** add a watchdog in `MicMixer` that **rebuilds the monitor
   stream/element** when it goes stale instead of requiring a manual toggle —
   recreate `monitorDest` + `monitorEl` (re-applying `monitorBus` wiring + the
   monitor sink) on `AudioContext` resume after suspension and/or after a long
   idle gap, so the buffer resets to ~0 transparently. Keep the cable path
   untouched (it isn't affected). Verify the rebuild doesn't drop the monitor sink
   selection or click audibly.
   **Progress: ✅ Done** *(added a `rebuildMonitorTail()` to `MicMixer` that swaps
   just the `monitorBus → MediaStreamDestination → <audio>` tail — preserving the
   monitor sink + every source's monitor send — and a `startMonitorWatchdog()`
   that fires it on an explicit AudioContext suspend→resume (statechange listener)
   and on a long wall-clock gap (poll detecting sleep/throttle), debounced. Torn
   down in `stop()`. Cable path untouched.)*
4. **Darker floating-menu surface — header avatar dropdown looks washed-out**
   *(UI polish)*. The header avatar dropdown (Admin + Sign out) in
   `components/UserMenu.tsx` (the `glass rounded-lg` menu at ~L111) sits on the
   faint `.glass` surface (`globals.css`: a white `0.04 → 0.015` gradient over
   `backdrop-blur-xl`), so floating over page content near the top of the header
   it reads translucent/washed-out rather than a solid panel. **Fix:** give the
   floating menu a **darker, more opaque** surface (e.g. a near-solid dark panel
   bg behind the blur) so it reads as a distinct popover. **Note:** the shared
   `Select` menu (`components/Select.tsx` ~L146) uses the **same `.glass` class**,
   so prefer a shared darker **popover/menu** surface (a new util or a tweak that
   both consume) over a one-off override, to keep all floating menus consistent —
   confirm the change still looks right on the `Select` dropdowns too.
   **Progress: ✅ Done** *(added a shared `.popover` surface in `globals.css` — a
   near-solid dark panel `rgba(24,26,42,0.97)→rgba(13,15,26,0.97)` over the
   `#070811` base, keeping the blur + border — and swapped both the `UserMenu`
   avatar dropdown and the portalled `Select` menu from `.glass` to `.popover`.)*
5. **"My uploads only" toggle on the Saved tab** *(feat)*. In the **Saved**
   section (`Dashboard.tsx`, the tag-filter chip row at ~L1109), add a toggle
   **before the tag chips** (in front of the `Tag` icon) that filters the list to
   **only the user's own uploaded sounds** — i.e. clips where
   `e.sound.ownerId === user.id` (the existing `isOwner` check at ~L720),
   excluding saved *references* to other people's public clips. Combine it with
   the existing tag filter (**AND**) in the `savedList` memo (~L668) — currently
   `savedList` only narrows by `savedTagFilter`; add a `savedMineOnly` predicate
   alongside it. State mirrors the tag filter's behavior (ephemeral
   `useState`; persisting device-local is optional). Match the chip-row styling so
   the toggle reads as part of that filter bar.
   **Progress: ✅ Done** *(added ephemeral `savedMineOnly` state + a "My uploads"
   pill at the front of the Saved filter bar (before the `Tag` icon); `savedList`
   now ANDs `e.sound.ownerId === user.id` with the tag filter.)*
6. **Notice banners — admin MOTD + web-only "get the desktop app" promo**
   *(feat, two-sided)*. A stack of banners rendered **below the nav** (between
   `<SiteHeader>` and `<main>` in `app/layout.tsx`), gated on a logged-in session.
   **Locked decisions:** both notices show to **signed-in users only** (logged-out
   landing stays clean); the promo is a **persistent banner** (not a hover
   tooltip).

   **6a. Admin-set MOTD banner** *(dismissible, re-shows on change or next day)*.
   - **Storage:** extend the `appSettings` singleton (`db/schema.ts`,
     `lib/app-settings.ts`) with `motdEnabled` (bool), `motdMessage` (text),
     `motdLinkLabel` (text, nullable), `motdLinkUrl` (text, nullable),
     `motdSeverity` (`'info' | 'warning' | 'success'`, default `info`), and
     `motdUpdatedAt` (timestamp, **bumped only when MOTD fields change** — it's the
     dismissal version token; don't reuse the row-wide `updatedAt`). Generate a
     migration (`pnpm db:generate`).
   - **Admin UI:** a **new section in `AdminPanel`** (mirror the YouTube-settings
     section pattern, ~`AdminPanel.tsx` L162) — enable toggle, message textarea,
     optional link (label + URL), severity picker (use the shared `Select`). Saves
     via `/api/admin/settings`; add Zod validation in `lib/validation.ts` (bound
     message length, require https URL when a link is set).
   - **Banner:** a client `<MotdBanner>` fed the server-read MOTD; colors by
     severity; renders the message + optional link; a **dismiss** (X) button.
   - **Dismiss semantics (locked):** persist device-local
     (`soundboard:motdDismissed = { version, date }`). Re-show when the content
     **changed** (`version !== motdUpdatedAt`) **or** it's a **new local calendar
     day** (`date !== today`). Hidden entirely when `motdEnabled` is false or the
     message is empty.

   **6b. Web-only desktop-app promo** *(non-dismissible)*. A persistent banner
   shown **only in the web build** — i.e. when `window.soundboard` is absent (the
   Electron detection used at `Dashboard.tsx` ~L456; check client-side after mount
   so SSR doesn't flash it). Text promoting the Windows app + a link to
   **`https://github.com/Soouuupppp/Soundboard-App/releases/latest`** (opens in a
   new tab). **No dismiss** — we want users on the app. Never renders inside the
   Electron wrapper.
   **Progress: ✅ Done** *(6a: added `motdEnabled/Message/LinkLabel/LinkUrl/
   Severity/UpdatedAt` to the `appSettings` schema; `updateAppSettings` bumps
   `motdUpdatedAt` only when a MOTD field changes; `PatchAppSettingsBody` validates
   the new fields (https-only link, 500-char message); a new "Notice banner" admin
   tab with `MotdSettings` (toggle + textarea + link + severity `Select`). 6b:
   `NoticeBanners.tsx` holds `MotdBanner` (severity colors, version+day dismissal
   via `soundboard:motdDismissed`) and a non-dismissible `DesktopPromoBanner`
   (shown only when `window.soundboard` is absent). Layout reads settings
   server-side for signed-in users and renders the stack between header and main.
   Schema applied via `bootstrap.sql` — the project's actual mechanism (idempotent
   DDL run by `migrate.ts` at container start), NOT drizzle-kit migrations: added
   the MOTD columns to the `appSettings` CREATE block + `ADD COLUMN IF NOT EXISTS`
   backfills, mirroring `schema.ts`. **Hotfix:** the banner now updates without a
   refresh — `MotdBanner` polls a new signed-in `GET /api/motd` every 60s (seeded
   from the SSR value); a version change re-shows a dismissed banner. No WS/SSE
   infra added. **Dismiss scope (owner revision):** the dismissal record lives in
   **`sessionStorage`** (not localStorage), so a dismissed banner re-shows on a
   content change (version) **or** a new local day (date) **or** an app restart /
   new session — fixing "enabled but didn't show after restart.")*
7. **Expanded sound-card layout cleanup** *(UI)*. The expanded/edit card layout is
   awkward (see owner screenshot). Rework the **shared `SoundCard` editing block**
   (`Dashboard.tsx` ~L1824–2092) — it backs **both** the Board and Saved expanded
   cards, so changes apply to **both views** (locked). Locked changes:
   - **Volume slider its own row (expanded):** in the **expanded** state the
     volume slider gets a full-width row of its own. In the **collapsed** state,
     keep the Edit (pencil) + remove-from-board buttons **right-aligned on the
     slider row** as today (only the expanded state relocates buttons).
   - **Relocate Done + remove-from-board (expanded):** move the **Done** (collapse)
     and **remove-from-board** buttons off the slider row to a **new bottom row
     beneath the `[Public | Delete]` row** (~L2065). Apply the relocation in each
     context where those controls exist (owner vs non-owner "Remove from Saved").
   - **Merge bind editing into the top binds (locked layout):** the top keybind
     sub-card (currently the 2-col `keyboard | controller` grid at ~L1849, Board
     view only) becomes a **vertical stack** (one bind per line). In **edit mode**
     each line shows: enable **toggle** (left) + the bind value (**tap the row to
     re-capture** — keyboard inline hold-capture, controller opens `VrBindPicker`)
     + a **small × remove**; an unbound slot shows "Set keybind"/"Set controller".
     **Remove the separate wide capture rows** (~L1974–2053). Collapsed = the same
     stack but read-only (no toggle/×). Since the **Saved** expanded card has no
     top sub-card today, render this same stacked bind block there in edit mode.
     Preserve the `!hasDesktop` disabled state on the controller affordance.
   - **Clip name wraps:** the original filename (~L1939, currently `truncate`)
     wraps to additional rows instead of truncating (`break-words`, drop
     `truncate`).
   - **Bigger tags everywhere (locked):** bump `TagChips` (`components/Tags.tsx`)
     from `text-[10px]` to ~`text-xs` (12px) with a bit more padding — applies
     globally wherever tags render (editor, saved cards, public browser, admin).
   **Progress: ✅ Done** *(extracted a `bindStack(editMode)` helper in `SoundCard`
   — one bind per line (keyboard, controller), edit mode = toggle + tap-to-capture
   value + × clear, read-only = struck-through value; collapsed Board shows the
   read-only stack, expanded (both views) shows the editable stack, replacing the
   old 2-col grid + wide capture rows. Volume slider gets its own full-width row
   when expanded (pencil/board buttons only render collapsed); Done +
   add/remove-from-board relocated to a new bottom row beneath `[Public|Delete]` /
   `[Remove from Saved]`. Filename wraps (`break-words`). `TagChips` bumped to
   `text-xs` + `px-2.5 py-1`.)*

### Tasks — 1.3.3 (Font change & input delay for keybinds/controller binds)

Version bumped to **1.3.3** across all three `package.json` + docs. Owner
decisions below are **locked**.

1. **App-wide font → "Play" (Google Font)** — switch the global typeface across
   the whole app to the **Play** Google Font. **Locked:** load via
   `next/font/google` (self-hosted, weights **400 + 700** — Play has no other
   weights, so existing `font-medium`/`font-semibold` utilities synthesize/round)
   in `app/layout.tsx` with a `--font-play` CSS variable; prepend it to the
   `globals.css` `font-family` stack **and** set `tailwind.config.ts`
   `fontFamily.sans` so every surface (dashboard, admin, public browser, header,
   banners) picks it up. No per-component font overrides exist to clean up.
   **Progress: ✅ Done** *(loaded `Play` via `next/font/google` in `app/layout.tsx`
   — subsets `latin`, weights 400+700, `variable: "--font-play"`, `display: swap`;
   applied the variable class on `<html>`. Prepended `var(--font-play)` to the
   `globals.css` `html, body` font stack and added `theme.extend.fontFamily.sans`
   (Play → existing fallbacks) in `tailwind.config.ts` so every Tailwind surface
   inherits it. No per-component overrides needed.)*

2. **Minimum-hold gate on VR bind actions** *(reframed from "input delay")*.
   **Locked owner decisions:**
   - **Not an output delay — a minimum press/hold duration on a button.** A
     `down` action with a min-hold of **N seconds** latches only if its button was
     held continuously **≥ N**, and it registers **on release** (the up edge):
     release before N → no latch (re-press to retry). The bind fires when its
     final step completes — i.e. on the qualifying release of the last action.
   - **Per action** granularity — **any button** in a sequence can carry its own
     min-hold (not just the final press), configured per action in `VrBindPicker`.
     Presets **0.5 / 1 / 1.2 / 2 / 2.5** + "Other" → custom seconds input.
   - **VR controller binds ONLY. Keyboard binds are out of scope** this version.
   - **Device-local storage** (localStorage, e.g. `soundboard:holdMs` →
     `{ [entryId]: number[][] }` ms per step→action, plus a cancel-all key) — the
     on-disk serialized `VrBind` is **unchanged**; hold durations ride alongside
     binds into the matcher at runtime.
   - **Raise `STEP_TIMEOUT_MS` 1.5s → 3s** globally so a 2/2.5s hold completes
     within one step's reset window (the button's down edge counts as progress, so
     the hold has up to the timeout to qualify). Custom input capped below 3s.
   - **Matcher change** (`lib/vr-bind.ts`): track per-input press time
     (`heldSince`). A min-hold `down` action satisfies like the existing
     event-based `up`-latch — but on the button's **up** edge, gated by
     `(releaseTime - heldSince[input]) >= holdMs` (early release = no latch).
     `setBinds` entries carry optional per-action hold durations; mirror in
     `VrBindPreview` so the editor test area reflects the gate. Cancel-all bind
     gets the same treatment. Min-hold is offered only on **down**-edge actions.
   **Progress: ✅ Done** *(`lib/vr-bind.ts`: `VrAction` gained an optional runtime
   `holdMs` (not serialized — serialize/parse ignore it); `STEP_TIMEOUT_MS` 1.5s→3s;
   `MAX_HOLD_MS=2900` + `HOLD_PRESETS_SEC=[0.5,1,1.2,2,2.5]`. New `bindHolds`/
   `applyHolds` helpers extract/attach a `number[][]` matrix. The matcher now treats
   a min-hold down as an event action (`isEventAction`): its down edge counts as
   progress, and it latches on the **up** edge only if `now - heldSince[input] >=
   holdMs` (early release = no latch). Added a `heldSince` map to `VrMatcher` +
   `VrBindPreview` (set on every down, never deleted; cleared on `reset()`); preview
   `snapshot` reads green only on a qualifying release so it reflects the gate.
   `Dashboard.tsx`: device-local `soundboard:holdMs` (`{[entryId]:number[][]}`) +
   `soundboard:cancelAllHoldMs` state, loaded/persisted alongside the bind keys;
   `applyHolds` attaches them onto each parsed bind in the `setBinds` memo (entries +
   cancel-all). `VrBindPicker` carries `holdMs` on builder actions, gained an
   `initialHolds` prop + a "Minimum hold (optional)" section listing each down-edge
   action with a `HoldControl` (shared `Select` presets + "Other…" custom seconds,
   capped at 2.9s); `onConfirm` now returns `(serialized, holds)` and the preview
   re-attaches holds via a `holdsKey`. Clearing a controller bind clears its holds.
   Keyboard binds untouched. **Caveat (follow-up):** the locked `{[entryId]:
   number[][]}` shape is per-entry but binds are per-profile — switching Index↔Quest
   reuses one matrix, so out-of-structure entries degrade to no-hold and saving the
   other profile overwrites it. Honored the locked shape; flag for the owner if
   per-profile hold storage is wanted.)*

### Tasks — 1.4.0 (Voice Changer)

Version bumped to **1.4.0** across all three `package.json` + docs. Owner
decisions below are **locked**. This version adds a **customizable voice changer
on top of the Virtual Mic** — a real-time DSP effects path that ships now, plus a
researched-and-wired AI voice option. It is a **research-heavy** version: the
research (open-source first, security-first, free-only) feeds the integration, so
do task 1 before locking the implementation details of tasks 2–4.

**Cross-cutting locked decisions (apply to every task):**
- **Open-source first, security first, free-only.** Prefer open-source solutions.
  External APIs are **in scope only if free**, but mic audio leaving the machine
  is a security tradeoff to be called out explicitly — weigh it against in-browser
  (WASM/ONNX/WebGPU) options that keep audio local. Honor the existing
  capture-devices/cables-only, no-native-code, browser-based constraint (see the
  `virtual-mic-capture` memory) — the voice changer is a **Web Audio** feature so
  it works identically in the web build and the Electron wrapper.
- **Per-source opt-in (locked).** The voice changer is applied **per source** in
  the mixer (the live mic, each capture device/cable, and the soundboard line each
  independently opt in), consistent with the existing `SourceMixRow` model in
  `audio-mixer.ts`. DSP effects are available to any source; the AI path is
  expected to make sense primarily on the **live mic** (the user's own voice) —
  research confirms feasibility/latency before committing AI to arbitrary sources.
- **Latency (locked):** **DSP effects must be real-time** (live on the mic during
  calls/games, low latency). **AI conversion may be higher-latency / push-to-talk
  style** — it does not have to keep up live.

**Owner decisions locked in planning (2026-06-15 `/plan-release`):**
- **AI privacy:** **free external API is OK with explicit in-UI disclosure** that
  mic audio leaves the machine. **Locked provider: `r3gm/rvc_zero`** (HF ZeroGPU
  Space, MIT source). **Routing — browser-direct (reverses the earlier proxy
  plan):** because rvc_zero runs on **ZeroGPU**, a server proxy with our token
  would force all users to share one tiny GPU quota; calling the Space
  **directly from the browser** (via `@gradio/client`) makes each user spend their
  own per-IP `X-IP-Token` quota and we hold **no HF token**. This requires a
  **deliberate CSP `connect-src` widening** to `https://*.hf.space
  https://huggingface.co` in `middleware.ts` (see Task 3). *Documented scale path:*
  self-host the MIT Gradio app on our own GPU later (then a same-origin proxy
  returns and audio stays on our infra).
- **AI ship bar:** **DSP (task 2) is the committed deliverable; AI (task 3) is
  best-effort.** If no acceptable free endpoint is wired in time, ship the AI UI
  affordance disabled / "coming soon" rather than forcing a janky integration.
- **AI voice type:** **preset voices ship; voice cloning deferred** (revised
  2026-06-15). rvc_zero needs a pre-trained model per voice. **Preset policy =
  hybrid (locked):** ship a tiny set of **confirmed-safe** bundled presets +
  a **custom RVC model URL** field. Most public RVC models are scraped
  celebrity/character voices → **legal/impersonation risk to bundle**, so the only
  bundled model is **`PhoenixStormJr/RVC-V2-default-voice`** (generic original,
  **MIT, attribution required**), exposed as **pitch variants** (Neutral / Deeper
  pitch −7 / Higher pitch +7) via RVC's pitch param. Anything else is the user's
  own custom URL (they own the rights). Zero-shot **cloning** (OpenVoice V2) is a
  **future version**, not 1.4.0. Concrete URLs + spec in
  `docs/voice-changer-research.md` §4b.
- **AI sources:** **capture devices only** (the mixer has no distinct "live mic"
  abstraction). DSP effects are available to **every** source (soundboard + each
  capture device); the **AI section is shown on each capture-device row and hidden
  on the always-on soundboard line** — the user enables it on whichever device is
  their mic. (locked 2026-06-15)
- **PTT trigger + raw-mic interaction (locked 2026-06-15):**
  - **Push-to-talk is both an on-screen hold button AND a bindable hotkey**
    (keyboard via `chord.ts` + VR via `vr-bind.ts`), routed like cancel-all through
    a **sentinel** (e.g. `AI_PTT_BIND`) with **device-local** localStorage binds
    (mirrors `soundboard:cancelAllKeybind` / `soundboard:cancelAllControllerBind`).
    Hold to record → release converts → converted clip is injected.
  - **AI replaces the raw mic:** while AI is enabled on a capture device, that
    device's **raw signal is removed from the cable** (and monitor) — only the
    converted PTT clips reach the cable (through that source's DSP chain). So you
    sound converted with no doubling; continuous live voice is not available while
    AI is on (PTT bursts only). The mixer needs a per-source "raw-muted while AI
    on" state that still lets injected converted clips flow through the chain.
- **DSP mode:** **stackable chain** — a source can enable **multiple effects at
  once, ordered in series** (not a single-effect Select). Each effect is a
  self-contained subgraph (one input node, one output node) so chain wiring is
  uniform; reorder/add/remove supported.
- **DSP + AI coexist:** a source may run **both** — AI-converted audio is fed
  **through that source's DSP chain** before the cable (best-effort, given AI is
  push-to-talk).
- **Persistence:** **device-local localStorage** (new key, e.g.
  `soundboard:voicefx` → `{ [sourceKey]: { effects: EffectConfig[]; ai?: {…} } }`,
  `sourceKey` = capture `deviceId` / `SOUNDBOARD_KEY` / a live-mic key) — mirrors
  the existing `soundboard:output` audio-settings pattern. **No DB/schema change.**
- **UI:** a **third Control Panel pill tab "Voice changer"** alongside *Output &
  volume* / *Virtual Mic mode* (gated on `supportsSinkId`), listing sources with a
  per-source effect-chain builder; the AI section appears only on the live-mic row.

**Research-derived technical locks (2026-06-15 — full writeup is task 1's
`docs/voice-changer-research.md` deliverable):**
- **DSP effect palette (Web Audio, MIT-friendly where possible):**
  - *Robot / ring-mod* — `OscillatorNode → GainNode.gain` (multiply). Pure native.
  - *Echo* — `DelayNode` + feedback `GainNode` + wet/dry. Pure native.
  - *Reverb* — `ConvolverNode` with a **synthetically generated impulse response**
    (no IR files required; an optional small IR pack can broaden it later). Native.
  - *Bonus native effects to broaden the palette* — distortion/overdrive
    (`WaveShaperNode`), telephone/band-pass (`BiquadFilterNode`), tremolo (LFO →
    gain), low/high-pass, and a bitcrusher (`AudioWorklet`).
  - *Pitch shift + formant shift* — **DEFERRED (owner decision 2026-06-15): not
    shipped this version, and no external DSP library is added.** The DSP path is
    native Web Audio only. (For the record, if revisited: SoundTouchJS —
    `@soundtouchjs/audio-worklet` + `@soundtouchjs/formant-correction-worklet`,
    **MPL-2.0**, safe as a dependency — is the recommended pick; see
    `docs/voice-changer-research.md` §3b.)
- **AI path (best-effort):** **`r3gm/rvc_zero`** (HF ZeroGPU Space, MIT source),
  called **browser-direct via `@gradio/client`** (client-side dep) for **preset
  voices** only — a curated list of public RVC model `{ modelUrl, indexUrl, pitch }`
  entries. Per-user ZeroGPU quota via `X-IP-Token`; **no HF token, no proxy
  route.** **Push-to-talk** (record a chunk → `client.predict` → receive converted
  audio → inject into the live-mic cable path, optionally through that source's DSP
  chain). Audio is uploaded to Hugging Face → **explicit security disclosure** in
  the UI. **Cloning (OpenVoice V2), in-browser ONNX/WebGPU local conversion, and
  self-hosting the MIT Gradio app** are all documented future options, **not
  shipped this version**.

1. **Research: open-source voice-changer + effect/voice options** *(research
   deliverable)*. Survey and evaluate, with security + free + open-source as the
   ranking axes:
   - **Open-source sound/effect libraries** to broaden the DSP palette beyond the
     starter set (so we can offer a bunch of different options) — Web Audio /
     WASM DSP, impulse-response packs, vocoder/effect toolkits.
   - **AI voice-conversion / custom-voice-generator** options: **in-browser
     (WASM/ONNX/WebGPU, e.g. RVC/so-vits-style — audio stays local)** vs **free
     external API (audio leaves the machine)**. The research **decides the
     direction**, the **custom-voice type** (preset voices vs voice cloning vs
     both), and the specific model/library — weighing security, latency, cost
     (must be free), and licensing.
   - **Output (locked):** write the full evaluation to a **new `docs/` markdown**
     file (e.g. `docs/voice-changer-research.md`) — options, tradeoffs,
     security analysis, and the recommended pick. Distill the resulting **locked
     decisions back into this CLAUDE.md task section** so tasks 2–4 build against
     them.
   *Plan:* the locked picks are already distilled above; task 1's remaining work
   is to **write `docs/voice-changer-research.md`** — the full option survey, the
   tradeoff/security analysis (esp. audio-leaves-machine for the AI path), the
   licensing notes (SoundTouchJS LGPL-2.1 vs Tone.js MIT), and the recommended
   picks. Do this first so 2–4 reference it.
   **Progress: ✅ Done** *(wrote `docs/voice-changer-research.md` — the full
   survey, graph-insertion point, DSP palette (native nodes + SoundTouchJS), AI
   direction (free HF Gradio Spaces via a same-origin proxy, push-to-talk,
   disclosed), security + persistence + UI analysis, and the recommended picks.
   **Correction folded back in:** SoundTouchJS is **MPL-2.0** (`@soundtouchjs/
   audio-worklet` + `@soundtouchjs/formant-correction-worklet`), not LGPL — safe
   as a proprietary dependency, so the licensing concern is moot; the actual GPL
   option (Rubberband) is the one rejected. Named concrete free AI Spaces:
   `r3gm/rvc_zero` / `JackismyShephard/ultimate-rvc` (presets), `myshell-ai/
   OpenVoiceV2` (cloning). In-browser ONNX/WebGPU local conversion deferred.)*

2. **Real-time DSP voice changer (ships this version)** *(feat)*. Integrate a
   **real-time DSP effects** path into the Virtual Mic chain (`lib/audio-mixer.ts`
   `MicMixer`). **Locked effect set (revised 2026-06-15):** **robot / ring-mod,
   echo / reverb** plus the native extras the research surfaced (distortion/
   overdrive, telephone/band-pass, tremolo, low/high-pass, bitcrusher) — **all
   native Web Audio, no external DSP library.** **Pitch shift + formant shift are
   DEFERRED** (owner decision; were in the original starter set) — do not add
   SoundTouchJS/Tone.js this version. Effects are **per-source opt-in** (see
   cross-cutting) and **real-time**. Keep the ASCII signal-flow header diagrams in
   `audio-mixer.ts` accurate as routing changes.
   *Plan (locked):* new **`web/src/lib/voice-fx.ts`** owns the effect model — an
   `EffectKind` union + `EffectConfig` (kind + params), a `createEffect(ctx, cfg)`
   factory returning `{ input, output, update(params), dispose() }` subgraphs, and
   the native palette above (no external DSP lib). The only worklet is our own
   **bitcrusher** processor, served from **`web/public/worklets/`** and registered
   via `ctx.audioWorklet.addModule` (lazy, once). In **`audio-mixer.ts`**, insert a
   per-source **effect-chain node**
   between each source's `out` and the cable/monitor split: today
   `connectSource(out, key)` wires `out → cableBus` and `out → monitorSend →
   monitorBus`; change it to `out → [chain] → (cableBus, monitorSend)` and move the
   per-input meter analyser **post-chain** so the row meter reflects the processed
   signal. Add `setSourceEffects(key, EffectConfig[])` that (re)builds that source's
   chain in series and reconciles params without dropping the source. The soundboard
   line gets the same treatment via `soundboardBus`. Update the ASCII header diagram
   to show the chain insert. **Risk:** rebuilding a chain mid-stream can click —
   build the new chain, splice it in, then retire the old (mirror the
   `rebuildMonitorTail` make-before-break pattern). All effects are native nodes
   (plus our bitcrusher worklet), so chain latency stays low.
   **Progress: ✅ Done** *(new `web/src/lib/voice-fx.ts` owns the effect model — an
   `EffectKind` union (robot/echo/reverb/distortion/telephone/tremolo/lowpass/
   highpass/bitcrusher), `EffectConfig {id,kind,params}`, `EFFECT_DEFS` param
   metadata driving UI sliders + `defaultParams`/`makeEffect`/`effectLabel`
   helpers, and a `createEffect(ctx,cfg)` factory returning `{input,output,
   update(params),dispose()}` subgraphs — all native Web Audio (robot=ring-mod
   osc→gain.gain, echo=DelayNode+feedback+wet/dry, reverb=ConvolverNode w/ a
   synthetic exp-decay IR rendered into a buffer, distortion=WaveShaperNode tanh
   curve, telephone=bandpass biquad, tremolo=sub-audio LFO→gain, low/highpass
   biquads). The only worklet is our own `public/worklets/bitcrusher-processor.js`
   (bit-depth + sample-rate reduction), registered lazily once per ctx via
   `ensureBitcrusherModule`. In `audio-mixer.ts`: a per-source `SourceChain
   {out,tail,effects}` map + persisted `sourceEffects` config map; `connectSource`
   now builds `out → [fx…] → tail` and fans the **tail** out to cable + monitorSend
   + (for inputs) the **post-chain** meter analyser; `buildChain`/`rebuildChain`
   (make-before-break, mirrors `rebuildMonitorTail`)/`disposeChain` + a public
   `setSourceEffects(key, EffectConfig[])` that preloads the bitcrusher worklet
   when needed. Soundboard line routed through its own chain via `connectSource`.
   `stop()` + input removal dispose chains. ASCII header diagram updated to show
   the chain insert. No pitch/formant, no external DSP lib. tsc clean.)*

3. **AI voice option (research-driven)** *(feat)*. Wire up at least one **AI voice
   changer / custom-voice generator** per the task-1 recommendation. Direction
   (in-browser vs free external API), custom-voice type (preset/clone/both), and
   model are **decided by the research** under the free + security constraints.
   AI conversion **may be higher-latency / push-to-talk** (not required to run
   live). Surface the security posture of the chosen path to the user (especially
   if any audio leaves the machine).
   *Plan (locked, best-effort):* **live mic only**, **push-to-talk**, **preset
   voices only** (cloning deferred). Provider **`r3gm/rvc_zero`**, called
   **browser-direct** — **no proxy route, no server token.** Add **`@gradio/client`**
   to `web/package.json`; a new **`web/src/lib/voice-ai.ts`** wraps
   `Client.connect("r3gm/rvc_zero")` + `client.predict(api_name, [audio, modelUrl,
   indexUrl, pitch, …])` and exposes the **hybrid preset list** — three pitch
   variants of the one confirmed-safe MIT model (`PhoenixStormJr/RVC-V2-default-
   voice`: Neutral/Deeper/Higher, all sharing `default.pth` + the `…_default_v2
   .index` resolve URLs) **plus a "Custom…" entry** taking a user-entered
   `{ modelUrl, indexUrl, pitch }`. **Credit PhoenixStormJr (MIT) in the UI** and
   show a "use only voices you're entitled to" reminder by the custom field. **CSP change required** in `web/src/middleware.ts`:
   add `https://*.hf.space https://huggingface.co` to **`connect-src`** (everything
   else stays; the converted audio returns as a `blob:` already allowed in
   `media-src`). Client orchestration in `audio-output.ts` (capture N seconds from
   the live-mic stream → `predict` → inject the converted clip into the live-mic
   source path, **routed through that source's DSP chain** so the two coexist).
   **The UI must show an explicit "audio is sent to Hugging Face (rvc_zero)" notice**
   whenever AI is enabled. ZeroGPU Spaces queue/sleep/rate-limit, so handle
   errors/unavailability gracefully and, if the Space proves undependable, render
   the AI controls disabled/"coming soon" — DSP still ships. The deferred paths
   (OpenVoice cloning, in-browser WebGPU, self-hosting) are recorded in
   `docs/voice-changer-research.md`.
   *PTT + raw-mic (locked):* the AI section appears on **each capture-device row**
   (not the soundboard). Push-to-talk is **a hold button + a bindable
   keyboard/VR hotkey** — add an `AI_PTT_BIND` sentinel routed through the existing
   keyboard (`chord.ts`) and VR (`vr-bind.ts`) matchers in `Dashboard.tsx`, with
   **device-local** binds like cancel-all (`soundboard:aiPttKeybind` /
   `soundboard:aiPttControllerBind`). Hold → record from that device's mic stream
   → release → `predict` → inject the converted clip into the source's path
   (through its DSP chain). **While AI is enabled on a capture device the mixer
   mutes that device's raw cable+monitor send** (only converted clips pass);
   `audio-mixer.ts` needs a per-source `aiMuted` flag that zeroes the raw send but
   keeps the inject/chain path live. Cap the PTT record length (e.g. ≤15s).
   **Progress: ✅ Done (backend/plumbing; UI controls land in task 4)** *(new
   `web/src/lib/voice-ai.ts` — browser-direct `@gradio/client` wrapper for
   `r3gm/rvc_zero`: lazy cached `Client.connect`, `convertVoice(blob, {modelUrl,
   indexUrl,pitch})` → predict `/run` → fetch the output blob, the hybrid
   `AI_PRESETS` (Neutral/Deeper −7/Higher +7 of `PhoenixStormJr/RVC-V2-default-
   voice`) + `AI_CUSTOM_ID`, `resolveVoice`, `checkAiAvailable`, and the
   `AI_MODEL_CREDIT`/`AI_PRIVACY_NOTICE` strings. The `@gradio/client` import is
   `@ts-ignore`d + dynamic so tsc passes before `pnpm install`; dep added to
   `web/package.json`. `middleware.ts` CSP `connect-src` widened to
   `https://*.hf.space wss://*.hf.space https://huggingface.co` (commented as the
   deliberate audio-leaves-machine tradeoff). `audio-mixer.ts`: per-input `micGate`
   (`src → micGate → gain`) + `aiMuted` map + `setSourceAiMuted` (zeroes the raw
   mic only), `getSourceStream`, and `injectClipToSource(deviceId, …)` that injects
   a converted clip at the source's chain head so it flows through that source's DSP
   chain (falls back to the soundboard line if the device is closed).
   `audio-output.ts`: `soundboard:voicefx` device-local state (`{[key]:{effects,
   ai?}}`) + `setSourceEffects`/`setSourceAi` accessors (seeded into the mixer on
   start before `syncInputs`), and PTT orchestration — `startPtt`/`stopPtt` record
   the device's mic (the mixer's shared stream when active, else a fresh capture)
   via `MediaRecorder`, capped at `MAX_PTT_MS=15s`, then `convertAndInject` →
   `convertVoice` → `injectClipToSource`, with `pttRecording`/`aiBusy`/`aiError`
   exposed. `Dashboard.tsx`: `AI_PTT_BIND` sentinel + device-local
   `soundboard:aiPttKeybind`/`aiPttControllerBind` state/setters, routed through the
   keyboard matcher (start on the completing key, stop on its release / blur) and
   the VR matcher (start on completion, stop on the next release edge); the Electron
   global-hook path starts PTT (down-only → relies on the 15s cap). tsc clean.
   NOTE: the bind-capture UI + the on-screen hold button + the voicefx panel are
   task 4 — the setters/accessors are in place for it.)*

4. **Voice-changer UI** *(feat)*. Expose the voice changer in the **Control
   Panel** (`Dashboard.tsx`) consistent with the existing Virtual Mic UI — a
   **per-source** way to enable + pick/configure the active effect or AI voice,
   matching the dark glassy UI and the shared `Select` / `SourceMixRow` patterns.
   Exact layout follows once tasks 1–3 settle the option set.
   *Plan (locked):* add a **third pill tab "Voice changer"** in the Control Panel
   (`Dashboard.tsx`, beside *Output & volume* / *Virtual Mic mode*, gated on
   `audio.supportsSinkId`). A new `VoiceChangerPanel` lists each source (soundboard
   + capture devices, same source set as `VirtualMicPanel`) as a card with a
   **per-source effect-chain editor**: an ordered list of active effects (each with
   a remove × + param sliders), an "Add effect" picker (shared `Select` of the
   palette), and reorder controls. **Each capture-device** card (not the
   soundboard) additionally shows the **AI voice section**: an enable toggle, a
   preset-voice `Select` incl. a "Custom…" option that reveals model/index URL +
   pitch inputs, a **push-to-talk hold button** plus **bind-capture controls** for
   the keyboard + VR PTT hotkey (reuse the `SoundCard` bind-capture / `VrBindPicker`
   affordances), the **security disclosure** notice + a "use only voices you're
   entitled to" reminder, and a **PhoenixStormJr / MIT attribution** line.
   Reference-sample cloning is deferred. State is read/written
   through new `audio-output.ts` accessors backed by `soundboard:voicefx`
   localStorage; effect param changes call `mixer.setSourceEffects` live. Reuse
   `Toggle`, `Select`, `SourceMixRow` styling; no native `<select>`.
   **Progress: ✅ Done** *(added a third Control Panel pill tab "Voice changer"
   (gated on `audio.supportsSinkId`) in `Dashboard.tsx`. New `VoiceChangerPanel`
   lists the Soundboard line + every capture device as a `VoiceSourceCard`. Each
   card has an `EffectChainEditor`: an ordered list of the source's effects (each a
   sub-card with `effectLabel` header, up/down reorder, × remove, and a slider per
   `EFFECT_DEFS` param — sliders call `audio.updateSourceEffectParams` live, no
   chain rebuild; add/remove/reorder call `audio.setSourceEffects`) plus an "Add
   effect…" shared `Select` (placeholder, value="" so it re-adds). Capture-device
   cards also render an `AiSection`: an enable `Toggle` (mutes the raw mic via
   `setSourceAi`), the `AI_PRIVACY_NOTICE` (amber, `ShieldAlert`) + a raw-mic-muted
   note, a preset `Select` (`AI_PRESETS` + "Custom…"), custom model/index URL +
   pitch inputs with a "use only voices you're entitled to" reminder, a
   hold-to-talk button (`onPointerDown/Up/Leave` → `audio.startPtt`/`stopPtt`,
   shows Recording/Converting state), the global PTT hotkey capture controls
   (keyboard via `vc.setCapturingAiPtt` + VR via `vc.setCapturingAiPttVr`/
   `VrBindChips`, mirroring cancel-all), and the `AI_MODEL_CREDIT` attribution. PTT
   bind state + capture toggles are threaded from Dashboard via a `vc`
   (`VoiceChangerControls`) prop; the AI-PTT `VrBindPicker` renders in Dashboard
   scope. State flows through the task-3 `soundboard:voicefx` accessors. No native
   `<select>`. tsc clean.)*

### Tasks — 1.4.0 (Sound-routing & layout refactor — appended)

A second 1.4.0 batch (same version — **appended**, not a new version bump) that
**re-architects the audio routing and the control-panel UI**. Owner decisions
below are **locked** (settled in planning 2026-06-15). Build the engine first
(everything else routes through it), then the header chrome, then the three
popovers, then presets/binds/cleanup.

**Target signal flow (locked):**

```
        ┌─ Soundboard clip(s) ─► [per-id FX chain] ─► soundboardBus(SB vol) ─┐
        │                                                                     ├─► outputBus(global) ─► limiter ─► ctx.destination ─►(setSinkId) OUTPUT device
 (VM ON)│  mic ─► [mic FX chain] ─► micGate(AI mute) ─► micBus(mic vol) ──────┤
        │  AI converted clip ─► [mic FX chain] ───────────────────────────────┘
        │
 soundboardBus ─────────────────────────────────────────────────────────────► monitorBus(global) ─► monitor tail ─►(setSinkId) MONITOR device
 micBus ─► monitorMicGate(monitor-mic toggle) ───────────────────────────────►
```

Preview clips connect to **monitorBus only** (never outputBus), so they never
leak into the cable when Virtual Mic mode is on.

**Cross-cutting locked decisions:**
- **Engine always runs** — retire the separate normal-mode `OutputGraph`; one
  unified audio graph is active in all modes so Soundboard per-clip effects are
  heard on normal output **and** the cable. Output routing always via
  `ctx.setSinkId`; degrade to direct `<audio>` (no FX/meter) where
  `AudioContext.setSinkId` is absent. **The mic input is opened only when Virtual
  Mic mode is on** (no surprise mic capture otherwise; mic permission is requested
  only then).
- **Single Input Device** (primary mic) in the UI. The mixer keeps its
  multi-source capability **in code** (don't rip it out), but the UI exposes only
  the one primary mic; extra capture sources aren't user-addable this batch.
- **Volume hierarchy, all 0–200% (default 100%):** *Global output* = master gain
  on the combined sum feeding both output + monitor; *Soundboard output* + *Mic
  output* = the two sub-bus levels under it. (Today's `clamp01` on these three
  becomes a 0–2 clamp; per-clip / per-input volumes stay 0–1.) The cable limiter
  still protects the virtual mic; >100% can distort normal output/monitor — note
  it in the UI.
- **Monitor:** soundboard is always monitored locally; the mic is added to the
  monitor only when the **monitor-mic** toggle is on (single `monitorMicGate`
  replaces the per-source monitor-send UI; keep the underlying send map for
  future multi-source).
- **Inline Control Panel card is removed.** Three header buttons left of the user
  dropdown — **Settings · Voice changer · Sound Effects** — each open a popover
  panel (shared `.popover` surface, outside-click/Esc close, one-open-at-a-time).
  The global output level meter moves into the header.
- **Persistence stays device-local localStorage**; no DB/schema change. New keys:
  per-id soundboard FX (`soundboard:soundfx`), shared preset library
  (`soundboard:fxPresets`), AI replay bind keys. Migrate old `monitorSends` /
  per-source inputs / 0–1 volume blobs.

1. **Engine refactor — unified always-on graph** *(refactor, do first)*. In
   `lib/audio-mixer.ts` + `lib/audio-output.ts`: make the engine start on
   mount/first gesture regardless of `virtualMicMode` and **retire `OutputGraph`**
   + the dual normal-vs-mixer branches in `play()`. Restructure buses to the
   diagram above: `outputBus(global)` → limiter → destination; `monitorBus(global)`
   → monitor tail; `soundboardBus` fans to both; `micBus` fans to outputBus +
   (`monitorMicGate`)→monitorBus. Open/close the **mic input with the VM toggle**.
   Add the `global` master gain (0–2) and widen soundboard/mic volume clamps to
   0–2. Keep the ASCII header diagrams accurate.
   **Progress: ✅ Done** *(`audio-mixer.ts`: rebuilt `MicMixer` into a unified
   always-on engine — buses are now `outputBus(global 0..2)` → limiter → destination,
   `monitorBus(global 0..2)` → rebuildable monitor tail, `soundboardBus(SB 0..2)`
   fanning to both, and `micBus(mic 0..2)` → outputBus + `monitorMicGate` (single
   monitor-mic toggle) → monitorBus. Added `setGlobalVolume`/`setMicVolume`/
   `setMonitorMic` (`clamp02`), renamed `setCableDevice`→`setOutputDevice` /
   `getCablePeak`→`getOutputPeak` (alias kept), a shared `injectInto` helper backing
   `injectClip` (→ soundboardBus), `injectClipToSource` (→ input chain head), and a
   new `injectPreview` (→ monitorBus ONLY). Mic FX chains stay per-input (soundboard
   chain dropped — moves per-clip in task 2); per-source monitor sends kept as a
   vestigial map for a future multi-source UI. Updated the ASCII header diagram.
   `audio-output.ts`: deleted `OutputGraph` + the dual normal/mixer branches; the
   engine now starts once on mount when `AudioContext.setSinkId` exists and keeps
   running (mic opened/closed only with the Virtual Mic toggle via `syncInputs([])`),
   `play()` injects through the engine (preview → monitorBus, board → soundboardBus)
   and degrades to a plain `<audio>` sink only without context-sink support. Added
   `globalVolume`/`setGlobalVolume` + `monitorMic`/`setMonitorMic` state, persistence,
   and live-apply effects; legacy `monitorSends`/`monitored` migrate to the
   monitor-mic toggle; bus setters widened to `clamp2` (0..2). Old hook fields kept
   for back-compat so the still-present inline panel compiles (task 3 removes it).
   tsc clean.* **Follow-up to flag:** soundboardBus is always monitored per the
   locked diagram, so in normal mode if the monitor device == output device you'll
   hear board plays twice — task 4's monitor dropdown should offer an "Off/None"
   option, or the owner may want the monitor tail gated when no distinct monitor
   device is chosen.)
2. **Per-clip soundboard effects (by sound id)** *(feat)*. Soundboard DSP becomes
   **per-clip only** — remove the soundboard-line chain from the voice changer.
   New device-local map `soundboard:soundfx` → `{ [soundId]: EffectConfig[] }`;
   `injectClip` builds a per-id chain (clip → chain → soundboardBus), disposed on
   end/stop, reading the config on **every** play (Board, keybind, VR, and local
   previews — preview clips connect to monitorBus only). Preload the bitcrusher
   worklet if any per-id chain needs it.
   **Progress: ✅ Done** *(`audio-mixer.ts`: `injectClip`/`injectPreview` gained an
   optional `effects?: EffectConfig[]`; the shared `injectInto` now builds a fresh
   per-clip chain `gain → fx₀ → … → dest` and disposes the effects on end/stop
   alongside the source. Added `preloadEffects(configs)` (loads the bitcrusher
   worklet when a chain needs it so the first play builds real nodes, keeping
   `play()` synchronous). `audio-output.ts`: new device-local `soundboard:soundfx`
   map (`SoundFxMap = Record<soundId, EffectConfig[]>`) with read/write helpers,
   `soundFx` state + `soundFxRef`, loaded on mount; `play()` reads
   `soundFxRef.current[soundId]` and passes it to both `injectClip` and
   `injectPreview`, so the chain applies on EVERY trigger (board/keybind/VR) and on
   previews (monitor-only). New `setSoundEffects(soundId, effects)` accessor
   (persists, drops empty chains, preloads worklet) exposed for the task-7 editor;
   engine start preloads worklets for all stored chains. The soundboard line is no
   longer seeded as a voice-changer source (DSP is per-clip now; task 1 already
   removed its engine chain). tsc clean.)*
3. **Header chrome + shared `Popover`** *(feat)*. Add a shared anchored `Popover`
   component (generalize the `UserMenu` dropdown pattern: `.popover` surface,
   outside-click/Esc, one-open-at-a-time). Add **Settings · Voice changer · Sound
   Effects** buttons left of `UserMenu` in `app/layout.tsx`, each opening its
   popover; move the global **output level meter** into the header. These consume
   `useAudio()` (client components in the header). **Remove the inline Control
   Panel card** + tab scaffolding (`ControlPanel`, `VirtualMicPanel`,
   `SourceMixRow`, tab buttons) from `Dashboard.tsx`.
   **Progress: ✅ Done** *(new shared `components/Popover.tsx` — an anchored
   `.popover` panel with outside-click/Esc close, open-state controlled by the
   parent so a group enforces one-open-at-a-time. Extracted the meter cluster
   (`meterColor`/`useMeterBar`/`LevelMeter`/`PeakMeter`) out of Dashboard into
   `components/LevelMeter.tsx` so the header + future popovers reuse it. New
   `components/HeaderControls.tsx` (client, consumes `useAudio()`): the global
   output `LevelMeter` + three popover buttons — Settings · Voice changer · Sound
   Effects (the latter two gated on `supportsSinkId`) — one-open-at-a-time. Bodies
   are short placeholders that tasks 4/5/7 fill. `app/layout.tsx`: built the shell
   (header + banners + main) once and, for signed-in users, wrapped the WHOLE shell
   (header included) in `AudioProvider` so the header controls can drive the single
   engine; added `<HeaderControls/>` left of `UserMenu`. `Dashboard.tsx`: removed
   the `<ControlPanel>` render (kept the AI-PTT VR picker) and deleted the
   `ControlPanel`, `VirtualMicPanel`, `SourceMixRow` functions + the moved meter
   cluster (~23k chars). tsc clean.* **Follow-up for tasks 5/7:** the Voice-changer
   popover (task 5) needs the AI-PTT bind state/capture + matcher wiring that still
   live in `Dashboard.tsx`, and the Sound Effects header modal (task 7) needs the
   board/saved sound list — both must be lifted to a shared location (global audio
   layer or a new context) since the header now renders outside Dashboard. The
   `VoiceChangerPanel`/`EffectChainEditor`/`AiSection`/`VoiceChangerControls`
   definitions were left in Dashboard (currently unused, tsc-clean) for task 5 to
   move/reduce.)*
4. **Settings popover** *(feat)*. Live-updating (no save button): Output Device,
   Monitor Device, **Input Device (primary mic — new)**, Global output (0–200%),
   Soundboard output (0–200%), Mic output (0–200%), Virtual Mic toggle, Monitor-mic
   toggle. Re-point the three volume sliders at the new global/soundboard/mic gains;
   the Input Device dropdown drives the single primary-mic source.
   **Progress: ✅ Done** *(added a single-primary-mic accessor to `audio-output.ts`:
   `inputDeviceId` (derived = first enabled input) + `setInputDeviceId(id)` which
   collapses `inputs` to one `{deviceId,enabled:true,volume:1}` entry (multi-source
   plumbing stays in the mixer); persisted. New `components/SettingsPanel.tsx` (live,
   no save button): Output/Monitor/Input device `Select`s, the three 0–200% volume
   sliders re-pointed at `globalVolume`/`soundboardVolume`/`micOutputVolume` (with a
   >100%-may-distort note), Virtual Mic + Monitor-mic `Toggle`s, a "show device
   names" mic-permission button when labels are hidden, secure-context/mixer-error
   notices, and a live `PeakMeter`; degrades to master-volume-only when
   `!supportsSinkId`. Extracted a shared `components/Toggle.tsx` for the popovers
   (Dashboard keeps its private copy). Wired `SettingsPanel` into `HeaderControls`
   (replacing the Settings placeholder; panel scrolls at `max-h-[80vh]`). tsc clean.)*
5. **Voice changer popover (primary mic only)** *(feat)*. Reduce
   `VoiceChangerPanel` to one source (the selected mic): an enable toggle → the
   `EffectChainEditor` (add effect / stacked compact cards / reorder) + preset
   save/apply; plus the `AiSection` (preset or custom RVC URL, the HF privacy
   disclosure, PhoenixStormJr/MIT attribution). No per-source list.
   **Progress: ✅ Done** *(new `components/VoiceChangerProvider.tsx` — a context that
   lifts the AI-PTT bind state out of Dashboard (device-local keyboard combo +
   per-profile controller bind + the two capture flags) AND owns the keyboard
   chord-capture effect, so the popover's "Set keybind" works on any page; mounted
   in `app/layout.tsx` inside `AudioProvider` for signed-in users. Extracted
   `components/VrBindChips.tsx` (shared). New `components/VoiceChangerPanel.tsx` —
   PRIMARY-MIC-ONLY popover body keyed by `audio.inputDeviceId`: an `EffectChainEditor`
   (Select-add from `EFFECT_DEFS` / stacked cards with reorder, ×, live param
   sliders) + the `AiSection` (enable=`setSourceAi` mutes raw mic, preset/Custom…
   model+index+pitch, `AI_PRIVACY_NOTICE` + raw-mic-muted note, hold-to-talk via
   `startPtt`/`stopPtt`, keyboard + VR PTT bind capture via the provider,
   `AI_MODEL_CREDIT`); shows a "pick an Input device in Settings" hint when no mic
   is selected. Wired into `HeaderControls` (replacing the placeholder). Dashboard:
   replaced its local AI-PTT state with `useVoiceChanger()`, removed the moved
   keyboard-capture effect, deleted the old `VoiceChangerPanel`/`VoiceSourceCard`/
   `EffectChainEditor`/`AiSection`/`VoiceChangerControls` + local `VrBindChips`
   (~16k chars); the matcher + the VR bind PICKER still render in Dashboard, now
   reading the shared state. tsc clean.* **Follow-ups:** (a) the VR PTT bind PICKER
   only opens while the Dashboard page is mounted (it owns `controllerProfile` +
   SteamVR status) — opening the voice popover on /admin shows the button but the
   editor won't appear there; the keyboard PTT capture works everywhere. (b) The
   popover reads `controllerProfile` from localStorage once per open, so a profile
   switch made elsewhere mid-open isn't reflected until reopened. (c) preset
   save/apply is deferred to task 8.)*
6. **AI Replay bind + "ready" chime** *(feat)*. Alongside the existing
   `AI_PTT_BIND` (record), add an `AI_REPLAY_BIND` sentinel (keyboard via
   `chord.ts` + VR via `vr-bind.ts`, **device-local** like cancel-all) that
   re-injects the **last converted clip** (store its URL). Add a bundled
   **"conversion ready" chime** in `web/public/` played on the monitor device when
   a conversion completes.
   **Progress: ✅ Done** *(`VoiceChangerProvider` gained the AI-replay bind state —
   `aiReplayKeybind`/`aiReplayControllerBind` (device-local
   `soundboard:aiReplayKeybind`/`soundboard:aiReplayControllerBind`) + capture flags;
   refactored the PTT + replay binds onto shared `useLocalBind`/`useChordCapture`
   helpers. `audio-output.ts`: a `lastConvRef` keeps the last converted clip's
   object URL alive (no revoke-on-end; the previous one is revoked when a new
   conversion replaces it, and the survivor on unmount) + a `replayLastConversion()`
   accessor that re-injects it via `injectClipToSource`. `convertAndInject` now
   plays a bundled chime on the MONITOR device after a successful conversion.
   Generated `web/public/conversion-ready.wav` (a short, quiet two-note 16-bit PCM
   ding via a node WAV writer). `Dashboard.tsx`: new `AI_REPLAY_BIND` sentinel wired
   through all three matchers (in-app keyboard, Electron global-hook, VR) →
   `replayLastConversion`, with a second `VrBindPicker` render for the replay
   controller bind; consumes the replay state from `useVoiceChanger()`.
   `VoiceChangerPanel` AiSection gained a "Replay last" button + keyboard/VR replay
   bind capture mirroring PTT. tsc clean.)*
7. **Sound Effects modal (per-clip, by id)** *(feat)*. Two entry points (locked):
   a **per-card button** on each `SoundCard` that opens the modal scoped to that
   clip's id, **and** a **global header modal** with a clip picker/list (board +
   saved sounds) → `EffectChainEditor` for the chosen id + preset apply/save.
   Backed by the `soundboard:soundfx` map from task 2.
   **Progress: ✅ Done** *(new `components/SoundEffectsModal.tsx`: a shared
   `SoundFxEditor` (ordered effect cards with reorder/×/param sliders + an "Add
   effect…" `Select` of `EFFECT_DEFS`) that drives ALL edits through
   `audio.setSoundEffects(soundId, …)` — per-clip chains aren't a live mixer source,
   so each edit just persists and the next play rebuilds it. A `ModalShell`
   (createPortal full-screen overlay, Esc/click-outside close) + a shared
   `FxEditorHeader` with a "Preview" button (`audio.play(soundId,1,undefined,true)`
   → monitor-only). Two exports: `SoundEffectsModal` (per-card, fixed id) and
   `SoundEffectsPickerModal` (global header: fetches `GET /api/board`, dedupes by
   sound id, searchable list showing a Board chip + per-clip fx-count, → editor with
   a back button). Wired: a per-card `Sliders` button on each `SoundCard`
   (`onOpenFx` → Dashboard `fxModalSound` state → `SoundEffectsModal`), and the
   header "Sound Effects" button now opens `SoundEffectsPickerModal` (a modal, not a
   popover — removed the placeholder + the `fx` popover slot). tsc clean. Preset
   save/apply slot deferred to task 8.)*
8. **Shared preset library** *(feat)*. One device-local list
   `soundboard:fxPresets` → `{ id, name, effects: EffectConfig[] }[]`, with
   "save current chain as preset" + "apply preset" affordances **reused** by both
   the Voice changer and Sound Effects editors (a preset saved in either appears in
   both).
   **Progress: ✅ Done** *(new `lib/fx-presets.ts` — one device-local list
   `soundboard:fxPresets` (`FxPreset{id,name,effects}`) with `readPresets`/`addPreset`/
   `deletePreset`/`renamePreset`, a `cloneEffects` that deep-copies a chain with
   FRESH ids (via `makeEffect`) so applying never collides with a live chain's ids,
   and a `useFxPresets()` hook that refreshes on a `soundboard:fxPresets-changed`
   CustomEvent (dispatched on every write) + the cross-tab `storage` event. New
   shared `components/FxPresetBar.tsx` — an "Presets…" `Select` + Apply/Delete on the
   chosen preset + an inline "Save as preset…" name input snapshotting the current
   chain. Wired into BOTH editors: the voice-changer `EffectChainEditor`
   (apply → `audio.setSourceEffects(sourceKey, …)`) and the per-clip `SoundFxEditor`
   (apply → `commit`/`audio.setSoundEffects(soundId, …)`); a preset saved in either
   appears in both. Device-local; no DB. tsc clean.)*
9. **Migration + typecheck** *(chore)*. Migrate persisted state (old
   `monitorSends` / per-source `inputs` / 0–1 volume blobs) to the new shape; keep
   audio-file ASCII diagrams accurate. `tsc --noEmit` clean (no lint per repo
   convention).
   **Progress: ✅ Done** *(added the legacy MULTI-source `inputs` → single-primary-mic
   migration in the `audio-output.ts` mount load: if >1 input was enabled, collapse to
   the first enabled `{deviceId,enabled:true,volume:1}` and persist the collapsed
   shape (the mixer keeps multi-source in code; only the UI is single-mic). Confirmed
   the legacy `monitorSends`/`monitored` → `monitorMic` migration (task 1) and that the
   three bus volumes (global default 1, soundboard, mic) + legacy per-clip `masterVolume`
   all load sanely (old 0–1 blobs are valid 0–2 values). Corrected the `audio-mixer.ts`
   header ASCII diagram to the real node order (`mic → micGate → (input vol) → [mic FX
   chain] → micBus`). Final `tsc --noEmit` clean.)*

### Tasks — 1.4.0 (Post-review follow-ups — appended)

Follow-ups from the post-batch review (owner decisions **locked** 2026-06-16).
Same version (1.4.0) — appended. Build order: the audio-routing fix (1) first,
then the cleanups (3/4/5), then the larger VR-lift refactor (2) last.

1. **Monitor double-play fix + always-audible previews** *(bug)*. In normal mode
   `soundboardBus` fans to both `outputBus` and `monitorBus`, so when the monitor
   device equals the output device (the common `default`/`default` case) every
   board play is heard twice. **Locked decision:** keep "soundboard is always
   monitored locally" for the cross-device case, but insert a
   **`soundboardMonitorGate`** gain between `soundboardBus` and `monitorBus` and set
   it to **0 when `monitorDeviceId === outputDeviceId`, else 1** (recompute in
   `start()` + `setOutputDevice` + `setMonitorDevice`). This kills the same-device
   double-play while preserving "monitor the soundboard on a *different* device."
   **Previews stay on the monitorBus path** (separate from the soundboard send, so
   the gate doesn't silence them), and the **monitor device keeps defaulting to
   `"default"`** (system default) so a preview is always audible somewhere. Do NOT
   gate the whole monitor tail (that would silence previews when monitor==output).
   The mic's `monitorMicGate` stays user-controlled as-is. Update the
   `audio-mixer.ts` ASCII diagram for the new gate.
   **Progress: ✅ Done** *(added a `soundboardMonitorGate` GainNode between
   `soundboardBus` and `monitorBus` in `audio-mixer.ts` — `soundboardBus.connect(
   soundboardMonitorGate).connect(monitorBus)` instead of a direct send. A
   `soundboardMonitorGateValue()` helper returns 0 when `monitorDeviceId ===
   outputDeviceId` (kills the same-device double-play) else 1 (still monitor the
   board on a distinct device); `recomputeSoundboardMonitorGate()` re-applies it,
   called from `start()` (seeded), `setOutputDevice`, and `setMonitorDevice`.
   Previews (`injectPreview`) connect to `monitorBus` directly — after the gate —
   so they stay audible even when monitor == output; the monitor device still
   defaults to `"default"`. The whole monitor tail and the mic's `monitorMicGate`
   are untouched. Disposed/nulled in `stop()`; ASCII diagram updated. tsc clean.)*

2. **Lift VR controller state + `VrBindPicker` out of Dashboard** *(refactor —
   future-proofing for more pages)*. Today `controllerProfile` (device-local),
   `vrConnected` (SteamVR status), `hasDesktop` (Electron presence), and the
   full-screen `VrBindPicker` editor (+ its helpers `VrActionChip`/`VrPaletteRow`/
   `HoldControl`/`VrBindPreview` usage) all live **inside `Dashboard.tsx`**, so the
   header Voice-changer popover's "Set controller" button only works while the
   dashboard page is mounted (it shows the button on `/admin` etc. but the editor
   never renders). **Owner intent:** more pages are coming, so do this now.
   **Scope of work (locked plan):**
   - Extract `components/VrBindPicker.tsx` — move `VrBindPicker` + `VrActionChip` +
     `VrPaletteRow` + `HoldControl` out of Dashboard (they only depend on
     `lib/vr-bind.ts` + lucide + react). Update Dashboard's per-entry / cancel-all /
     AI-PTT / AI-replay picker renders to import it.
   - Create a shared **`components/VrProvider.tsx`** (or fold into
     `VoiceChangerProvider`) owning `controllerProfile` (+ its `soundboard:
     controllerProfile` persistence + setter), `vrConnected` (subscribe to the
     `soundboard:vrStatus` window event), and `hasDesktop` (window.soundboard
     check). Mount it in `app/layout.tsx` for signed-in users.
   - Render the AI-PTT + AI-replay `VrBindPicker`s **from the provider** (driven by
     the existing `capturingAiPttVr`/`capturingAiReplayVr` context flags) so they
     open from any page, not just the dashboard.
   - Repoint every Dashboard consumer (the VR matcher, the profile dropdown, each
     `SoundCard`'s controller bind, cancel-all) to read `controllerProfile`/
     `vrConnected`/`hasDesktop` from the provider instead of local state. The
     per-entry SoundCard VR picker can stay rendered in Dashboard (it's only used
     there), but it now reads the shared profile.
   - **Size:** medium-large — touches `Dashboard.tsx` broadly; do it as its own
     pass. (Once done, the task-5 "VR picker only on dashboard" follow-up + the
     `controllerProfile`-read-once popover caveat both resolve, since the popover
     reads live context.)
   **Progress: ✅ Done** *(extracted `components/VrBindPicker.tsx` — moved
   `VrBindPicker` + `VrActionChip` + `VrPaletteRow` + `HoldControl` out of Dashboard
   (they depend only on `lib/vr-bind.ts` + Select + lucide + react); `VrBindPicker`
   is now `export`ed and imported by Dashboard for the per-entry + cancel-all
   pickers. New `components/VrProvider.tsx` owns `controllerProfile` (+ its
   `soundboard:controllerProfile` persistence/setter — now the single writer),
   `vrConnected` (subscribes to `soundboard:vrStatus`), and `hasDesktop`
   (`window.soundboard`), exposed via `useVr()`; it ALSO renders the AI-PTT +
   AI-replay `VrBindPicker`s (driven by the `VoiceChangerProvider` capture flags)
   so "Set controller" opens from the header popover on any page. Mounted in
   `app/layout.tsx` inside `VoiceChangerProvider` for signed-in users. Dashboard now
   reads `controllerProfile`/`setControllerProfile`/`vrConnected`/`hasDesktop` from
   `useVr()` (removed the local state + the vrStatus/hasDesktop effects + the
   profile load/persist), dropped the in-Dashboard AI-PTT/replay picker renders and
   the 4 orphaned AI VR setters from its `useVoiceChanger()` destructure, and pruned
   the now-unused `vr-bind` imports. The per-entry SoundCard + cancel-all pickers
   stay rendered in Dashboard but read the shared profile via props/useVr. Block
   excised with a marker-based slice to preserve CRLF. tsc clean.)*

3. **Remove the orphaned `masterVolume`** *(cleanup)*. The legacy per-clip
   `masterVolume` (0–1, `soundboard:output.masterVolume`) is still multiplied into
   every play (`masterRef` in `play()`/`updateEntryVolume` + the live-update effect)
   but no surviving UI sets it (its slider died with the inline panel in task 3;
   `SettingsPanel` drives the new global/soundboard/mic bus gains instead). **Locked
   decision: delete it end-to-end** — the `masterVolume` state, `masterRef`, the
   `clamp(perEntryVolume * masterRef.current)` multiply (just use `perEntryVolume`),
   the masterVolume live-update effect, `setMasterVolume`, the `Stored.masterVolume`
   field/load, and the `masterVolume`/`setMasterVolume` entries on the `AudioOutput`
   type + return. Per-clip/per-entry volume (0–1) stays; the three bus gains are the
   master controls now. Leave the persisted key harmlessly orphaned (no migration
   needed). tsc must stay clean (check no other consumer reads `audio.masterVolume`).
   **Progress: ✅ Done** *(deleted `masterVolume` end-to-end in `audio-output.ts`:
   the `Stored.masterVolume` field + its load, the `masterVolume` state +
   `setMasterVolumeState`, `masterRef`, the master live-update `useEffect`,
   `setMasterVolume`, and the `masterVolume`/`setMasterVolume` entries on the
   `AudioOutput` type + returned object. The two play-path multiplies became plain
   `clamp(perEntryVolume)`. Confirmed (grep) no other file read `audio.masterVolume`.
   Per-entry volume (0–1) + the three bus gains are untouched; the persisted
   `soundboard:output.masterVolume` key is left harmlessly orphaned. tsc clean.)*

4. **Dead-code cleanup** *(chore)*. Remove the now-unused lucide imports in
   `Dashboard.tsx` (`Wand2`, `Sparkles`, `ShieldAlert`, `Headphones` — they moved to
   the extracted components) and prune the vestigial monitor-send API that no UI
   consumes anymore: `monitorSends`/`setMonitorSend`/`setMonitorSends` on the hook +
   the `monitorLevels`/`setMonitorSend`/`setMonitorSends` methods on `MicMixer`
   (keep the legacy-read migration in the mount load that derives `monitorMic` from
   an old `monitorSends`/`monitored` blob — that's still needed). If removing the
   hook fields, confirm nothing references them. tsc clean.
   **Progress: ✅ Done** *(removed the unused `Headphones`/`Wand2`/`Sparkles`/
   `ShieldAlert` lucide imports from `Dashboard.tsx`. Pruned the vestigial
   monitor-send API: dropped `MicMixer.monitorLevels` + `setMonitorSend`/
   `setMonitorSends`, and the hook's `monitorSends` state + `setMonitorSend`
   callback + the `monitorSends`/`setMonitorSend` `AudioOutput` type/return entries.
   KEPT the legacy-read migration that derives `monitorMic` from an old
   `monitorSends`/`monitored` blob (the `Stored.monitored`/`Stored.monitorSends`
   fields stay for it). Confirmed no component referenced the removed fields. tsc
   clean.)*

5. **Debounce FX param localStorage writes** *(perf)*. `setSoundEffects` /
   `updateSourceEffectParams` (and `setSourceEffects`) re-serialize the whole
   `soundFx`/`voiceFx` map to `localStorage` on **every slider tick** during a param
   drag. **Locked decision:** keep the React state + live mixer update synchronous
   (so the audio + UI stay responsive), but **debounce only the `localStorage`
   persist** (~250ms trailing) — e.g. a small `debouncedWrite(key, value)` helper, or
   flush the latest map on a timer. Make sure a final flush lands (trailing edge +
   flush on unmount/`beforeunload`) so nothing is lost. Applies to the per-clip
   `soundfx` and per-source `voicefx` writes; the structural changes (add/remove/
   reorder) can stay immediate.
   **Progress: ✅ Done** *(added a module-level debounced-persist layer in
   `audio-output.ts`: `fxPending`/`fxTimers` maps keyed by localStorage key, with
   `writeFxDebounced(key,value)` (250ms trailing, `FX_PERSIST_DEBOUNCE_MS`),
   `writeFxNow(key,value)` (immediate — cancels any pending write for the key so a
   stale value can't clobber a structural change), `flushFxWrite`, and
   `flushAllFxWrites`. `writeVoiceFx` is now immediate (`writeFxNow`) for structural
   voicefx changes (`setSourceEffects`/`setSourceAi`); a new `writeVoiceFxDebounced`
   backs the per-tick `updateSourceEffectParams`. `writeSoundFx` (the per-clip
   editor's only persist path) is debounced since each param tick re-saves the whole
   chain and there's no live mixer node. React state + the live mixer update stay
   synchronous (audio/UI responsive); only the localStorage write is coalesced. A
   `useEffect` flushes on unmount + `beforeunload` so an interrupted drag isn't lost.
   tsc clean.)*

**Explicitly NOT a task** (owner call): the `controllerProfile`-read-once-per-open
in `VoiceChangerPanel` — the profile can't be toggled while the popover is open, so
the staleness can't occur in practice. (Also auto-resolves if task 2 lands.)

### Tasks — 1.4.1 (Voice changer effects improvements)

Version bumped to **1.4.1** across all three `package.json` + docs. Owner
decisions below are **locked** (settled in planning 2026-06-16). Build order: do
the research (task 1) first since it feeds the new DSP effects, then the sharable
preset work (tasks 2–4). Tasks 2–4 are independent of task 1.

**Cross-cutting locked decisions:**
- **Real-time is the priority for the AI path** (revised in planning — broadened
  from the initial "on-device only" framing). The research evaluates **both**
  in-browser/on-device options (native Web Audio, WASM, ONNX, WebGPU — audio stays
  local) **and external providers**, ranked by whether they can do **low-latency
  live conversion**. **Paid external providers are in scope** if they're realtime
  and good (research must surface rough pricing alongside free options); **free
  options preferred** where quality is comparable. Any path where audio **leaves
  the machine** (esp. continuous realtime streaming, a bigger exposure than
  1.4.0's PTT bursts) requires an **explicit in-UI privacy disclosure** (mirror
  the 1.4.0 `AI_PRIVACY_NOTICE` pattern) + the deliberate CSP `connect-src`
  widening in `middleware.ts`. Still honor the capture-devices/cables-only,
  no-native-code, browser-based constraint (`virtual-mic-capture` memory) — the
  AI runs in the browser (in-process WASM/WebGPU or a network call), not native.
- **Realtime AI is RESEARCH + DOCUMENT ONLY this version (locked, narrowed in
  planning 2026-06-16).** 1.4.1 **does not wire a realtime AI path** — paid
  realtime needs a server proxy holding our key (we'd pay per use for every user)
  and in-browser realtime RVC is still immature, so the realtime integration is
  deferred. Task 1 fully researches realtime (in-browser + free/paid external) and
  records the recommended pick + cost/privacy analysis in
  `docs/voice-changer-research.md`, but **the only AI that ships unchanged is the
  existing 1.4.0 push-to-talk `r3gm/rvc_zero` path.** The committed code
  deliverable for 1.4.1 is the **new DSP effects** (task 1). No CSP/proxy/billing
  work this version.
- **Sharable presets are DSP effect chains only** — the existing `soundboard:
  fxPresets` shape (`{ id, name, effects: EffectConfig[] }`, `lib/fx-presets.ts`).
  **AI voice configs (RVC model/index URL + pitch) are NOT shared** (the custom-URL
  impersonation/legal concern flagged in 1.4.0 stands). The device-local
  `soundboard:fxPresets` library **stays** for private/unsaved presets; the new
  server library is additive (publish to it / add from it).
- **This batch DOES add a DB table** — a deliberate departure from the
  voice-changer feature's device-local stance, since sharing requires a server.
  Per the repo's mechanism, schema changes go in **BOTH `web/src/db/schema.ts` AND
  `web/src/db/bootstrap.sql`** (CREATE TABLE block + idempotent `ADD COLUMN IF NOT
  EXISTS` backfills), run by `migrate.ts` at container start — **NOT** drizzle-kit
  migrations. See the `db-schema-via-bootstrap-sql` memory.

1. **Research: more voice-changer effects + a realtime AI path** *(research
   deliverable; new DSP ships)*. Survey along two axes — broaden the DSP palette,
   and find a **realtime AI** voice path (in-browser or external; see cross-cutting
   for the cost/privacy locks). Open-source preferred; for AI, **realtime quality
   ranks above free/local** (paid + audio-off-machine acceptable with disclosure):
   - **More DSP effects** to broaden the native palette beyond the 1.4.0 set
     (robot/echo/reverb/distortion/telephone/tremolo/low-high-pass/bitcrusher) —
     additional native Web Audio nodes, WASM DSP, vocoder/effect toolkits,
     impulse-response packs for the reverb.
   - **Real-time AI voice changer (research/document only — NOT implemented this
     version, locked).** Survey + recommend, ranked by low-latency live
     conversion: (a) **in-browser/on-device** models (WASM/ONNX/WebGPU, e.g.
     RVC/so-vits-style or lighter realtime models) where audio stays local, and
     (b) **external realtime providers** (free or paid — surface rough pricing,
     latency, streaming protocol, and the audio-leaves-machine exposure). Compare
     against the 1.4.0 HF-hosted `rvc_zero` PTT path (which ships unchanged). The
     output is the recommendation + analysis in the docs file; **no realtime code
     lands in 1.4.1.**
   - **Output (locked):** extend **`docs/voice-changer-research.md`** with a new
     section for the new-DSP survey + the realtime-AI survey (options, tradeoffs,
     security/privacy esp. for any audio-off-machine path, pricing, licensing,
     recommended picks + a "future version" implementation sketch). Distill the
     DSP picks back into this task section so the implementation builds against
     them; the realtime-AI picks stay as the documented future direction.
   **Locked ship bar:** the **new feasible DSP effects are the ONLY committed code
   deliverable** of task 1 — implement them in `lib/voice-fx.ts` (native Web Audio,
   plus a worklet only if needed, mirroring the bitcrusher) and wire them into the
   existing per-source / per-clip chain editors so they appear automatically via
   `EFFECT_DEFS` (add `EffectKind` members + `EFFECT_DEFS` entries + `createEffect`
   cases; the UI, presets, and persistence pick them up with no further wiring).
   The **realtime AI path ships no code this version** (research/document only,
   above); the existing 1.4.0 PTT AI is untouched.
   **Progress: ✅ Done** *(added six native Web Audio effects to `lib/voice-fx.ts`
   — `chorus`/`flanger`/`phaser`/`vibrato` (LFO-modulated `DelayNode`/all-pass
   biquads, same osc→param pattern as tremolo/robot), `compressor`
   (`DynamicsCompressorNode`), and `megaphone` (band-pass → tanh `WaveShaper`).
   Each got an `EffectKind` member + `EFFECT_DEFS` entry (params drive the sliders/
   defaults) + a `createEffect` case with live `update()`/`dispose()`; the chain
   editors, presets, and persistence pick them up with no further wiring. No
   worklet, no external DSP lib; pitch/formant still deferred. Extended
   `docs/voice-changer-research.md` §8 — the new-DSP table, the
   considered-but-skipped effects (noise gate needs an envelope/worklet; stereo
   widener is moot on a mono mic chain), and a realtime-AI survey (in-browser
   ONNX/WebGPU = research-grade/not-ready; external realtime = paid + server-key
   + continuous off-machine stream) recommending self-hosted RVC/w-okada behind a
   WS proxy as the future pick — RESEARCH ONLY, no realtime code lands. tsc
   clean.)*

2. **Server-side sharable preset library — schema + API** *(feat)*. A shareable
   server library of FX effect-chain presets (DSP chains only — see cross-cutting).
   - **Schema (locked):** new table **`sharedPreset`** in `schema.ts` — `id` uuid
     PK, `ownerId` text → `user.id` (`onDelete: cascade`), `name` text, `effects`
     text (serialized `EffectConfig[]` JSON), `isOfficial` boolean default false
     (admin/featured flag), `createdAt` timestamp. Mirror into `bootstrap.sql`
     (CREATE TABLE IF NOT EXISTS block; no backfill needed — it's a brand-new
     table). Don't add a column the UI won't use (no `updatedAt`/`description`).
   - **API (locked):** `GET /api/presets` (list — official first, then newest;
     joins `user` for `ownerName`/`ownerImage`, **omits `ownerId`**, returns a
     `mine` flag like `/api/public/sounds`); `POST /api/presets` (auth'd publish —
     validate name + `effects` against the new Zod schema, see below;
     rate-limited like `board-mut`); `DELETE /api/presets/[id]` (owner always;
     admin any). A new **`PostSharedPresetBody`** Zod schema in `lib/validation.ts`
     validates `name` (`printable`, ≤80) + an `effects` array (≤12 items) of
     `{ kind ∈ EffectKind, params: Record<string, finite number> }` — bound it so
     the DB can't be stuffed; the client re-clones with fresh ids anyway.
   - **Admin route (locked):** `PATCH /api/admin/presets/[id]` (admin-only) to
     toggle `isOfficial` (promote/demote) — mirrors `/api/admin/sounds/[id]`. Admin
     DELETE goes through the same `DELETE /api/presets/[id]` (admin-any branch).
   - **Publishing semantics (locked):** a user-published preset is **public
     immediately** (no approval queue) and appears in the browse library; admins
     can **delete any** and **toggle `isOfficial`**. There is **no edit** — to
     change a published preset, delete + republish. Per-user publish cap (e.g. 50)
     enforced in `POST`.
   **Progress: ✅ Done** *(new `sharedPreset` table in `schema.ts` (id/ownerId→user
   cascade/name/effects JSON/isOfficial/createdAt) + matching `CREATE TABLE IF NOT
   EXISTS` + owner index in `bootstrap.sql` (new table, no backfill).
   `PostSharedPresetBody` in `lib/validation.ts` — name (≤80, printable, min 1) +
   `effects` array (1–12) of `{kind ∈ EFFECT_KINDS, params: record<string, finite
   number>}` (EFFECT_KINDS mirrors the voice-fx `EffectKind` union with a sync
   note, so the server module stays free of the "use client" audio lib). Routes:
   `GET /api/presets` (official-first then newest; joins user for ownerName/Image,
   OMITS ownerId, returns `mine`; parses effects defensively), `POST /api/presets`
   (auth'd; rate-limited `preset-mut`; per-user cap 50 → 409; `isOfficial` honored
   only for admins so an admin can author-as-official in one call), `DELETE
   /api/presets/[id]` (owner-or-admin), `PATCH /api/admin/presets/[id]` (admin-only
   isOfficial toggle). CSRF/Origin is covered by the global middleware. No edit
   endpoint. tsc clean.)*

3. **Sharable presets — user UI** *(feat)*. **Locked: a "Browse shared" button in
   `FxPresetBar`** (`components/FxPresetBar.tsx`, reused by both the voice-changer
   `EffectChainEditor` and the per-clip Sound-Effects editor) that opens a **modal
   browser** (mirror `SoundEffectsPickerModal`'s `ModalShell` + searchable list in
   `components/SoundEffectsModal.tsx`). The modal lists shared presets — **official
   ones first with a featured badge**, then user presets with **owner display
   name** — searchable, each with **Apply**. `FxPresetBar` also gets a **"Publish
   to shared…"** action (name the current chain → `POST /api/presets`), shown
   alongside the existing local "Save as preset…".
   - **Apply behavior (locked):** applying a shared preset **clones it (fresh ids
     via `cloneEffects`) into the working chain** AND offers a **"save to my
     presets"** affordance so a local copy lands in `soundboard:fxPresets` (via
     `addPreset`) and shows in the local dropdown next time.
   - The device-local `soundboard:fxPresets` flow stays intact alongside the
     server library (private/unsaved presets). Match the dark glassy UI / shared
     `Select`; route failures through `useToast`/`fromResponse`. New `lib/`
     helper (e.g. `lib/shared-presets.ts`) wraps the fetch/publish/delete calls.
   **Progress: ✅ Done** *(new `lib/shared-presets.ts` — `SharedPreset` type +
   `fetchSharedPresets`/`publishSharedPreset` (strips effect ids; admin-only
   `isOfficial`)/`deleteSharedPreset`/`setSharedPresetOfficial` (returns raw
   Response for `toast.fromResponse`). New `components/SharedPresetsModal.tsx` — a
   portal modal (Esc/click-outside) listing the library (official-first w/ a Star
   "Official" badge, user presets show effect count + "by <ownerName>"), searchable
   by name/author, each row: **Apply** (clones into the working chain via
   `cloneEffects` → `onApply`, closes), **+ Save** (`addPreset` → local
   `soundboard:fxPresets`), and **Delete** on your own. `FxPresetBar` gained
   **Publish to shared…** (reuses the inline name input via a `mode` flag → `POST
   /api/presets`) and **Browse shared** (opens the modal); the local
   "Save as preset…" + dropdown flow is unchanged. Both effect editors
   (voice-changer + per-clip) get it for free since they share `FxPresetBar`.
   Failures via `useToast`/`fromResponse`. tsc clean.)*

4. **Admin section for shared presets** *(feat)*. A **new pill-tab in
   `AdminPanel`** ("Presets", mirroring the `roles|users|youtube|notices|tags|
   content` tab pattern + the `refresh()`/`onChange` data flow). **Locked: admins
   can BOTH author and moderate** —
   - **Author from scratch:** reuse the exported **`EffectChainEditor`**
     (`components/VoiceChangerPanel.tsx`) to build a chain in the admin tab, name
     it, and publish it as **official** (`POST /api/presets` then
     `PATCH …/isOfficial=true`, or a publish-as-official path).
   - **Moderate:** list **all** shared presets (official + user, with owner display
     name), **toggle official** (promote/demote via `PATCH /api/admin/presets/
     [id]`), and **delete any** (`DELETE /api/presets/[id]`).
   - Validation reuses task 2's `PostSharedPresetBody`.
   **Progress: ✅ Done** *(new `"presets"` pill-tab in `AdminPanel` (Sliders icon),
   added to the tab union + the `refresh()` Promise.all (loads the shared library
   via `fetchSharedPresets`, which already returns official+user with owner names,
   no UUID — admins moderate the same list users see). New `PresetsAdmin` section:
   **author** = a controlled `EffectChainBuilder` + name field → "Publish official"
   (`publishSharedPreset(name, draft, {isOfficial:true})`, honored server-side for
   admins); **moderate** = list all presets (official badge + owner) with
   "Make official"/"Unofficial" (`setSharedPresetOfficial` → `PATCH
   /api/admin/presets/[id]`) and Delete (`deleteSharedPreset` → admin-any branch).
   **Design note:** rather than convert the live `EffectChainEditor`
   (`VoiceChangerPanel`) — which relies on the no-rebuild `updateSourceEffectParams`
   live path that matters for live mic audio — I added a sibling controlled
   `components/EffectChainBuilder.tsx` (plain `EffectConfig[]` + `onChange`) for
   offline authoring. Same UI; safer than regressing the live param path. tsc
   clean.)*

### Tasks — 1.4.1 (Noise gate + pitch/formant shift — appended)

Two DSP effects that §8 of `docs/voice-changer-research.md` had **deferred** but
the owner has now greenlit (decided 2026-06-16 after a follow-up research pass).
Same version (1.4.1) — appended. Both are new `EffectKind` members in
`lib/voice-fx.ts`, so the existing chain editors, presets, persistence, and the
server-side shared-preset library pick them up automatically via `EFFECT_DEFS` —
**no UI/editor wiring beyond the lib + worklet files.** Build the noise gate first
(self-contained, mirrors the bitcrusher); then pitch/formant (a new dependency +
two vendored worklets, larger).

**Cross-cutting (both tasks):**
- Worklets are served **same-origin from `web/public/worklets/`** and registered
  lazily via `ctx.audioWorklet.addModule(url)` — our CSP is `script-src 'self'`, so
  same-origin worklet modules need **no CSP change** (an npm `blob:`/CDN import
  would; don't go that route). Mirror the existing `ensureBitcrusherModule`
  lazy-once-per-context registration + `chainNeedsBitcrusher`/`preloadEffects`
  preload pattern (generalize it — see task 6's note — rather than copy-paste a
  third time).
- Adding an effect = an `EffectKind` member + an `EFFECT_DEFS` entry (drives the
  sliders + defaults) + a `createEffect` case returning `{input,output,update,
  dispose}`. Keep the `voice-fx.ts` header ASCII/notes accurate.
- The validation allow-list **`EFFECT_KINDS`** in `lib/validation.ts` (used by
  `PostSharedPresetBody`) **must gain the new kinds** or shared presets containing
  them will fail server-side validation. (Update both the `voice-fx.ts` union and
  the `validation.ts` mirror — there's a "keep in sync" note there.)

5. **Noise gate effect** *(feat — ship)*. A new `"noisegate"` effect: a custom
   single-node **AudioWorklet** (author `web/public/worklets/noisegate-processor.js`,
   modeled on `bitcrusher-processor.js`). DSP: a **peak/envelope follower** with
   attack/release smoothing computes the signal level per render quantum; gate
   opens when level ≥ open threshold and closes when it falls below a **close
   threshold a few dB lower** (**hysteresis**, to stop chatter), with a **hold**
   time before closing and a **range** (how far down the closed gate attenuates,
   not necessarily −∞). **Locked params (`EFFECT_DEFS`):** `threshold` (dB,
   −80..0, default ≈ −45), `attack` (s, small), `hold` (s), `release` (s),
   `range` (dB of attenuation when closed, default ≈ −60). Smooth the gain ramp
   (don't hard-switch) to avoid clicks. Register lazily like the bitcrusher;
   `createEffect`'s `"noisegate"` case builds the `AudioWorkletNode` optimistically
   with the same passthrough-gain fallback if construction throws.
   **Progress: ✅ Done** *(new `web/public/worklets/noisegate-processor.js` — a
   peak/envelope follower (instant attack, ~1ms smoothed decay) drives a hysteresis
   gate: opens at `threshold`, closes only below `threshold−3dB`, with a `hold` time
   before closing and a ramped gain (attack/release one-pole) toward open (1) or the
   closed `range` floor (dB) so it doesn't click; detection from ch0, the per-sample
   gain applied to all channels. Added `EffectKind` `"noisegate"` + `EFFECT_DEFS`
   entry (threshold −80..0/−45, attack/hold/release, range −100..0/−60) + a
   `createEffect` `"noisegate"` case (optimistic `AudioWorkletNode` → passthrough-gain
   fallback). Generalised the bitcrusher's lazy register-once preload into a
   `WORKLET_MODULES` registry + `chainNeedsWorklet`/`ensureWorkletModules` (per-ctx,
   per-url dedupe), and repointed the three `audio-mixer.ts` call sites
   (`buildSourceChain`/`setSourceEffects`/`preloadEffects`) off the bitcrusher-specific
   helpers — so the gate (and the pitch effect below) register the same way. Added
   `"noisegate"` to the `validation.ts` `EFFECT_KINDS` allow-list so shared presets
   accept it. tsc clean.)*

6. **Pitch + formant shift effect** *(feat — ship; new dependency)*. A new
   `"pitch"` effect backed by **SoundTouchJS** — `@soundtouchjs/audio-worklet`
   (pitch/rate, **MPL-2.0** — file-level copyleft, safe in this proprietary +
   Electron app) plus `@soundtouchjs/formant-correction-worklet` for **formant
   preservation/shift**. **Locked params:** `pitch` (semitones, e.g. −12..+12,
   default 0) and `formant` (semitones or a ratio, default 0 = preserve). Owner
   accepted the **inherent buffering latency** (~tens of ms) on the live mic path
   (it's a per-source opt-in effect). Integration notes:
   - **Add the deps** to `web/package.json` (they install at the same time as the
     existing `@gradio/client`). **Vendor each package's worklet processor JS into
     `web/public/worklets/`** (e.g. a small build/copy step or a committed copy) so
     it loads same-origin under our CSP — an npm/CDN `addModule` would violate
     `script-src 'self'`. Note the vendoring mechanism in the file header.
   - SoundTouchJS's documented path is **buffer playback**, not a live mic stream —
     the **integration risk is the live `MediaStreamSource` → worklet** path.
     Validate it processes a continuous live stream cleanly (no buffer-underrun
     artifacts) before considering it done; if the live path proves unworkable,
     fall back to a **DIY granular pitch worklet (pitch-only, no formant)** and
     flag formant as re-deferred rather than shipping something broken.
   - `createEffect`'s `"pitch"` case wires the SoundTouch worklet node(s) in series
     (pitch → formant-correction), exposing `pitch`/`formant` via its AudioParams
     in `update()`; `dispose()` tears them down.
   - **Generalize the worklet preload** (`voice-fx.ts`): the bitcrusher's
     `ensureBitcrusherModule`/`chainNeedsBitcrusher`/`preloadEffects` is now one of
     three worklet-backed effects — refactor to a small registry (kind → module
     URL(s)) + a generic `ensureWorkletModules(ctx, effects)` so the noise gate and
     pitch effect register the same way, and update the `audio-mixer.ts` /
     `audio-output.ts` preload call sites (currently `chainNeedsBitcrusher`-gated)
     to the generic check. Keep the optimistic-build + passthrough-fallback
     behavior for every worklet effect.
   - Update `docs/voice-changer-research.md` §3b / §8 to record that pitch+formant
     (SoundTouchJS) and the noise gate are now **shipped** (move them out of the
     "deferred / considered but not shipped" lists).
   **Progress: ✅ Done — PITCH shipped; FORMANT re-deferred (⚠️ flag to owner).**
   *(Spike outcome: SoundTouchJS couldn't be adopted in-environment — its
   pitch/formant worklets live inside the npm packages and can't be vendored into
   `web/public/worklets/` without installing+building them, and its documented path
   is buffer playback, not a live `MediaStreamSource` (the flagged integration risk),
   so it's unverifiable under the no-install/no-run constraint. Per the LOCKED
   fallback I shipped a self-authored **pitch-only** worklet
   `web/public/worklets/pitch-processor.js` — a classic dual-tap delay-line granular
   shifter (circular buffer, two read taps a half-window apart scrolling at
   `1−2^(st/12)`, constant-power sin-window crossfade, linear interpolation; mono →
   copied to extra channels) — and **RE-DEFERRED formant** (no `@soundtouchjs/*`
   dependency added). Added `EffectKind` `"pitch"` + `EFFECT_DEFS` (single `pitch`
   param, −12..+12 st) + a `createEffect` `"pitch"` case (optimistic worklet →
   passthrough fallback) + `"pitch"` in the `validation.ts` allow-list. The worklet
   preload was generalised in task 5 (`WORKLET_MODULES` registry +
   `ensureWorkletModules`), so the pitch worklet registers/preloads with no extra
   wiring. Docs: §8a-bis records the gate + pitch as shipped + the formant re-defer +
   the SoundTouchJS upgrade path; §3b/§8a updated (removed from the deferred lists).
   tsc clean. **Owner decision needed** to get formant: install SoundTouchJS, vendor
   its worklet JS into `web/public/worklets/`, and extend the `pitch` case — steps
   recorded in the worklet header + §8a-bis.)*

### Tasks — 1.4.1 (Paid AI voice — STS + STT→TTS re-speak — appended)

> **This SUPERSEDES the earlier 1.4.1 "realtime/paid AI = research-only,
> deferred" lock** (§8b of `docs/voice-changer-research.md` + the 1.4.0-batch
> cross-cutting note). Owner reversed it (decided 2026-06-16 after the paid-provider
> research pass): we now actually wire **paid AI providers**. Two distinct features
> sharing one provider / proxy / quota stack:
> **(A) STS** — speech→speech voice *conversion* (preserves your delivery), and
> **(B) STT→TTS "re-speak"** — in-browser speech-to-text → paid AI text-to-speech
> (clean synthetic voice, your delivery is discarded). The free 1.4.0
> **rvc_zero** browser-direct PTT path **stays** as the default engine.

**Cross-cutting locked decisions (2026-06-16):**
- **Providers:** **ElevenLabs + Respeecher** for both features; **rvc_zero kept**
  as the free, no-key default engine.
- **Keys / billing — hybrid (locked):** an **app-owned key** (env
  `ELEVENLABS_API_KEY` / `RESPEECHER_API_KEY`) gated by a **per-user free quota**,
  PLUS **BYO key** (the user pastes their own; device-local) to bypass the quota.
  **All paid calls route through a same-origin Next.js proxy** that holds the app
  key OR forwards a BYO key supplied in a request header — **the BYO key is never
  persisted server-side**. Because the browser only ever talks to our own origin,
  **NO CSP `connect-src` change is needed** for the paid providers (rvc_zero stays
  browser-direct on the already-allowed HF hosts; Web Speech API is a native
  browser API). BYO-key usage is **not metered**.
- **Quota — mirror uploads/YT (locked):** unit = **seconds of AI audio**,
  **unified** across providers (one pool), **monthly reset**. Resolution =
  **user override → role default → env `DEFAULT_AI_QUOTA_SECONDS`** (the
  `lib/quota.ts` pattern). Per-user usage is **displayed in /admin on each user**
  (used / cap), with a role default + per-user override — exactly like the file
  quota. STS/live meter **input** (audio) seconds; TTS meters **output** seconds.
- **Admin (locked):** a master **`aiEnabled`** toggle + the **live session cap**
  (default ~60s) + the per-role AI quota live in **/admin appSettings**, mirroring
  the YouTube-settings section. App keys via **env** (standard for secrets), not the
  DB.
- **STS interaction (locked):** **PTT for ElevenLabs** (its Voice Changer is
  file-input, ≤300s, result streamed back) + **continuous-live for Respeecher**
  (true full-duplex realtime <200ms). Live is **allowed on the app quota** but with
  a **hard auto-stop session cap** (admin-configurable) and meters elapsed seconds
  against the quota.
- **STT→TTS (locked):** in-browser **Web Speech API** (`SpeechRecognition`) for the
  STT half; **interim transcript shown** as feedback, **auto-speak on release** (no
  edit-confirm). The TTS half is the chosen paid provider's voice.
  ⚠️ **Risk: Web Speech API likely does NOT work in the Electron wrapper** (the
  Chromium build ships no Google speech key) — validate early; if broken, gate the
  re-speak feature to the **web build** (and surface why) or add a fallback. The
  free rvc_zero STS path is unaffected and still works in Electron.
- **Voices (locked):** **curated safe presets per provider + a custom voice-ID
  field** (mirrors the rvc_zero hybrid). Bundle only safe default provider voices;
  the custom field carries the existing "use only voices you're entitled to"
  reminder.
- **Disclosure (locked):** paid providers AND the Web Speech API all send audio /
  text off the machine → extend the `AI_PRIVACY_NOTICE` pattern; the Respeecher
  **live** stream gets a **prominent, always-on** disclosure (continuous off-machine
  stream, a bigger exposure than PTT bursts).
- **Persistence:** extend the device-local `soundboard:voicefx` `ai` shape
  (engine/provider, mode = sts|respeak, voiceId | custom voice-id, optional byoKey).
  Selecting the existing free rvc_zero engine keeps its current behavior unchanged.
- **Schema** changes go in **BOTH `web/src/db/schema.ts` AND
  `web/src/db/bootstrap.sql`** (idempotent DDL run by `migrate.ts` at container
  start) — NOT drizzle-kit migrations. See the `db-schema-via-bootstrap-sql` memory.

Build order: quota+admin plumbing (1) → paid proxy PTT/file (2) → Respeecher live
(3) → STT→TTS (4) → UI (5) → persistence/validation/docs/tsc (6).

1. **AI quota + admin plumbing** *(do first — both features depend on it)*.
   - **Schema (both `schema.ts` + `bootstrap.sql`):** add a **role** AI quota
     default + use-permission (e.g. `aiQuotaSecondsMonthly` int nullable,
     `canUseAi` bool) mirroring the role's upload columns; matching **user**
     overrides (`aiQuotaSecondsOverride`, `canUseAiOverride`); and **per-user usage
     tracking** — simplest is two columns on `user` (`aiSecondsUsed` int +
     `aiUsagePeriod` text `YYYY-MM`, rolled over when the month changes); a small
     `aiUsage` ledger table is the more auditable alternative (pick one, note it).
     Add `appSettings` columns: `aiEnabled` (bool) + `aiLiveSessionCapSec` (int,
     default 60). Add `ADD COLUMN IF NOT EXISTS` backfills.
   - **`lib/ai-quota.ts`:** resolution (user override → role → env
     `DEFAULT_AI_QUOTA_SECONDS`), a `getAiUsage(userId)` (with monthly rollover),
     and a `consumeAiSeconds(userId, n)` / `checkAiQuota` used by the proxy routes;
     gate on the master `aiEnabled` + `canUseAi`. BYO-key requests skip consume.
   - **Admin:** an "AI" settings block in `AdminPanel` (master toggle + live cap +
     per-role AI quota/permission, reuse the YT-section + role-override patterns) and
     a **per-user used/cap display + override** in the users tab (mirror the upload
     quota UI). Zod validation in `lib/validation.ts` for the new settings.
   - **`GET /api/ai/usage`** (or fold into the session/me payload) → current user's
     `{ used, cap, enabled }` for the UI meter.
   **Progress: ✅ Done** *(Schema — chose the **two-columns-on-`user`** option (not a
   ledger table): `user.aiSecondsUsed` (int, default 0) + `user.aiUsagePeriod` (text
   `YYYY-MM`, UTC), plus per-user overrides `aiQuotaSecondsOverride` + `canUseAiOverride`;
   role `aiQuotaSecondsMonthly` (int null) + `canUseAi` (bool, default TRUE); appSettings
   `aiEnabled` (bool, default FALSE) + `aiLiveSessionCapSec` (int, default 60). Mirrored
   in both `schema.ts` and `bootstrap.sql` (CREATE blocks + `ADD COLUMN IF NOT EXISTS`
   backfills). New `lib/ai-quota.ts` — `DEFAULT_AI_QUOTA_SECONDS` (env, default 300),
   `currentAiPeriod()` (UTC YYYY-MM), `getAiQuotaSeconds`/`canUserUseAi` (user override →
   role → env/allowed), `getAiUsage` (used/cap/enabled/canUse; stale period reads 0),
   `consumeAiSeconds` (atomic conditional UPDATE that resets the counter on a month
   rollover), and `checkAiQuota({byo})` (gates aiEnabled → permission → remaining; BYO
   skips the quota, returns `{ok,status,error}` mapping straight to a response). New
   `GET /api/ai/usage` returns the current user's meter. Validation: `aiQuotaSeconds`
   (0–10M) added to `PatchRoleBody` (`aiQuotaSecondsMonthly`+`canUseAi`), `PatchUserBody`
   (`aiQuotaSecondsOverride`+`canUseAiOverride`), `PatchAppSettingsBody`
   (`aiEnabled`+`aiLiveSessionCapSec` 5–600). Admin: roles GET (`select *`) + roles PATCH
   (`set(parsed.data)`) pass the new fields through automatically; users GET now returns
   role defaults, overrides, resolved `aiCap` + current-period `aiUsed`, and
   `defaultAiQuotaSeconds`; users PATCH whitelist extended. AdminPanel: a new **"AI voice"**
   pill tab with `AiSettings` (master Toggle + live-cap input + a per-role quota/access
   table reusing `Toggle`/`NullableNumber`), and two new Users-table columns — **AI access**
   (`AiAccessOverride`, three-state like `UploadOverride`) + **AI quota** (used/cap +
   `NullableNumber` override). tsc clean. App provider keys stay in env only.)*

2. **Paid provider proxy — STS (file/PTT) + TTS** *(feat)*.
   - **`lib/ai-providers.ts`** (server): ElevenLabs + Respeecher clients —
     **STS** (ElevenLabs Voice Changer file endpoint; Respeecher S2S file) and
     **TTS** (both providers' text→speech). Provider + voiceId params; accept an app
     key (env) or a BYO key (from the request, never stored).
   - **`POST /api/ai/sts`** (audio blob + provider + voiceId) and **`POST
     /api/ai/tts`** (text + provider + voiceId): auth'd, gate on `aiEnabled` +
     `canUseAi`, **meter usage** against the quota (skip for BYO), `board-mut`-style
     rate-limit, return the converted audio. CSRF/Origin covered by the global
     middleware. **No CSP change** (same-origin proxy).
   - **Client (`audio-output.ts` / `voice-ai.ts`):** when the selected engine is a
     paid provider, the PTT path posts the recorded clip to `/api/ai/sts` (STS mode)
     and injects the result via `injectClipToSource` (through the source's DSP chain),
     exactly like the rvc_zero flow. TTS is used by feature B (task 4).
   **Progress: ✅ Done** *(new `lib/ai-providers.ts` (server-only) — `providerSts`/
   `providerTts` for ElevenLabs (Voice Changer `/speech-to-speech/{voice}` multipart +
   `/text-to-speech/{voice}` JSON, `xi-api-key`) and Respeecher (env-configured
   `RESPEECHER_STS_URL`/`RESPEECHER_TTS_URL` since its REST surface is account-specific;
   503 with a clear message when unset), `appKeyFor(provider)` reading
   `ELEVENLABS_API_KEY`/`RESPEECHER_API_KEY`, and a `ProviderError` carrying an HTTP
   status. Routes `POST /api/ai/sts` (multipart audio+provider+voiceId+seconds hint, 30MB
   Content-Length pre-guard) and `POST /api/ai/tts` (JSON `PostAiTtsBody`): both auth'd,
   `ai-mut` rate-limited, gated + metered via `checkAiQuota`/`consumeAiSeconds` (STS meters
   the clamped input-seconds hint, TTS meters estimated output seconds ≈ text/14; BOTH
   skip metering when a BYO key is present). The BYO key arrives in the `x-ai-key` header,
   is used then discarded — never stored/logged. CSRF/Origin covered by the global
   middleware; NO CSP change (same-origin proxy). Validation: `aiProvider`/`aiVoiceId` +
   `PostAiTtsBody`. New CLIENT helper `lib/voice-ai-paid.ts` — device-local BYO-key store
   (`soundboard:aiKeys`, sent as `x-ai-key`), curated ElevenLabs preset voices + custom
   sentinel (Respeecher = custom-only, account voice ids), per-provider privacy notices
   (+ a prominent live notice), and `convertStsViaProxy`/`ttsViaProxy`. `audio-output.ts`:
   `AiConfig` extended (`engine`/`mode`/`customVoiceId`/`live`; undefined engine = rvc_zero
   for back-compat), `convertAndInject` now branches rvc_zero vs paid STS (resolving the
   convert fn before flipping `aiBusy`), and PTT tracks `startedAt` so the metered input
   seconds reflect the real recording length. tsc clean. Live/respeak paths are tasks 3/4;
   the UI (engine picker/BYO field/usage meter) is task 5.)*

3. **Respeecher continuous-live (WebSocket streaming)** *(feat — biggest/riskiest)*.
   - **Server WS proxy** to Respeecher's realtime S2S. ⚠️ **Infra risk:** the web
     app runs Next standalone (`node server.js`) — route handlers don't do
     WebSockets, so this needs a **custom server / upgrade handler** (or a separate
     ws endpoint). Scope/spike this first; if a same-origin WS proxy proves
     impractical, fall back to Respeecher **in PTT/file mode** and re-defer
     continuous-live (flag to owner). The browser↔proxy WS is same-origin so
     `connect-src 'self'` covers it.
   - **Session cap:** auto-stop the stream after `aiLiveSessionCapSec`; **meter
     elapsed seconds** against the quota (skip for BYO); refuse to start if quota
     exhausted.
   - **Client:** open the WS, `mic MediaStreamTrack → chunked PCM frames → proxy →
     converted frames → MediaStreamAudioSourceNode injected at the mic source's
     chain head` (so DSP still applies), with the raw mic muted via the existing
     `aiMuted` gate. A **start/stop** control (optionally a bind), and the
     **always-on** live disclosure.
   **Progress: ✅ Done — FALLBACK (continuous-live RE-DEFERRED, per the locked
   spike-then-fall-back decision; ⚠️ FLAG TO OWNER).** *(Spike outcome: the web app
   ships `next.config.ts` `output: "standalone"` and the Docker `CMD` is `node
   server.js` — the Next-generated standalone server, which exposes no `upgrade`
   hook, and App-Router route handlers cannot accept a WebSocket upgrade. A
   same-origin WS proxy would require replacing/wrapping the standalone server with
   a custom Node server AND changing the Dockerfile start command — a deploy-
   architecture change that can't be validated under the no-build/no-run constraint
   — and Respeecher's realtime S2S WebSocket framing/auth isn't publicly specified
   to implement faithfully. Per the LOCKED fallback, continuous-live is re-deferred
   and **Respeecher ships in PTT/file STS mode** (already wired in task 2:
   `providerSts` + the `engine:"respeecher"` branch in `convertAndInject`). The
   `AiConfig.live` flag exists but is inert — task 5's Respeecher "PTT vs Live"
   control renders Live as disabled/"coming soon". No WS code, no custom server, no
   Dockerfile change shipped. **Owner decision needed** to revisit: adopting a
   custom server (drop `output: standalone` or wrap it) + obtaining Respeecher's
   realtime WS spec would unblock a future implementation; documented in task 6's
   docs update.)*

4. **In-browser STT + STT→TTS "re-speak"** *(feat — feature B)*.
   - **`lib/voice-stt.ts`:** a thin wrapper over `SpeechRecognition`
     (`webkitSpeechRecognition`) exposing start/stop + interim/final transcript
     events. Feature-detect; degrade gracefully where unsupported (notably the
     Electron wrapper — see the cross-cutting risk).
   - **Flow:** the PTT trigger (reuse `AI_PTT_BIND` / hold button) starts
     recognition; the **interim transcript is shown live**; on release the **final
     text auto-converts** via `POST /api/ai/tts` (chosen provider + voice) and the
     result is injected into the mic source path (through its DSP chain), raw mic
     muted. Meters output seconds (skip for BYO).
   - **Disclosure** that recognition audio goes to the browser's STT (Google for
     Chrome) and the text goes to the TTS provider.
   **Progress: ✅ Done** *(new `lib/voice-stt.ts` — a thin wrapper over
   `SpeechRecognition`/`webkitSpeechRecognition`: `sttSupported()` (feature-detect;
   ⚠️ Electron's Chromium ships no Google speech key so it returns false there →
   the UI gates re-speak to the web build), `startStt({onInterim,onFinal,onError})`
   → `SttHandle.stop()` (continuous + interimResults; accumulates final text,
   delivers it on the recognizer's `onend`), and the `STT_PRIVACY` disclosure
   string. Wired into `audio-output.ts`: `startPtt`/`stopPtt` now BRANCH on the
   active source's `ai.mode` — for a paid engine with `mode:"respeak"` they drive
   speech recognition instead of `MediaRecorder` (a new `sttRef` map), pushing the
   interim transcript to a new `aiTranscript` hook field for the live display; on
   release (or the MAX_PTT_MS cap, or `onend`) the final text auto-synthesizes via
   `ttsAndInject` → `ttsViaProxy` (`POST /api/ai/tts`) and injects the result into
   the source's chain through its DSP chain, raw mic still muted by the existing
   `aiMuted` gate; output seconds are metered server-side (task 2, skipped for BYO).
   Recognition is torn down on unmount alongside PTT recorders. So every existing
   PTT trigger (hold button / keyboard / VR) does STS or re-speak depending on mode
   with no extra wiring. tsc clean. The engine/mode pickers + the transcript/privacy
   UI are task 5.)*

5. **Voice-changer UI — engine/provider picker, voices, BYO key, usage meter**
   *(feat)*. Extend the `AiSection` (in `VoiceChangerPanel`):
   - An **engine picker** (shared `Select`): **rvc_zero (Free)** | **ElevenLabs** |
     **Respeecher**. For paid engines, a **mode** picker where applicable —
     **STS** vs **Re-speak (STT→TTS)** — and for Respeecher STS a **PTT vs Live**
     toggle.
   - **Voice picker:** curated provider presets + a **custom voice-ID** field (with
     the entitlement reminder).
   - **BYO key** field (device-local; masked input) with a note that it bypasses the
     free quota; when empty, the app quota is used.
   - The **usage meter** (used / cap from `/api/ai/usage`), the per-engine
     **privacy disclosures**, and provider **attribution** where required. Keep
     rvc_zero's current controls intact when it's selected. Re-use `Toggle` /
     `Select` / the existing PTT + VR bind-capture affordances; no native `<select>`.
   **Progress: ✅ Done** *(extended `AiSection` in `VoiceChangerPanel.tsx`: an
   **engine** `Select` (RVC⚡ZERO Free | ElevenLabs | Respeecher) whose change resets
   the voice (disjoint id namespaces) + mode; for paid engines a **mode** `Select`
   (Voice conversion STS | Re-speak STT→TTS) — re-speak shows a "needs Chrome, not
   the desktop app" note when `sttSupported()` is false — and for Respeecher a
   "Continuous live — coming soon" line (per the task-3 fallback; live is inert).
   **Voice picker** branches: rvc_zero keeps its presets + custom model/index/pitch
   form unchanged; paid shows `PAID_VOICES` presets (ElevenLabs library voices;
   Respeecher = custom-only) + a **custom provider voice-ID** field, both with the
   entitlement reminder. A **BYO key** field (paid only, `type=password`,
   device-local via `readAiKeys`/`writeAiKeys` keyed by provider) with a
   "bypasses the free quota, stored only on this device" note. A live **usage meter**
   (`AiUsageMeter` → `GET /api/ai/usage`, re-fetched on each conversion's aiBusy
   falling edge; hidden when a BYO key is set). Per-engine **privacy disclosures**
   (`AI_PRIVACY_NOTICE` for rvc_zero, `PAID_PRIVACY[provider]` for paid, plus
   `STT_PRIVACY` for re-speak and the `RESPEECHER_LIVE_PRIVACY` note) and
   **attribution** (`AI_MODEL_CREDIT` vs "Powered by <Provider>"). The hold-to-talk
   button + PTT/replay keyboard+VR bind capture are unchanged; in re-speak the button
   relabels and shows the live `audio.aiTranscript`. All via shared `Select`/`Toggle`;
   no native `<select>`. tsc clean.)*

6. **Persistence + validation + docs + typecheck** *(chore)*.
   - **AI config persistence is per-profile server-side** (the Profiles batch moves
     the voice-changer config off device-local `soundboard:voicefx`): the `ai` shape
     (engine, mode, voiceId|custom) rides in the active profile's voice-changer
     config, read/written through the existing `audio.setSourceAi` / voice-changer
     accessors (which the Profiles batch repoints to the server). **The BYO key
     stays device-local** (`soundboard:aiKeys`, per-user, NOT per-profile, NOT
     synced — it's a secret). Old device-local rvc_zero `ai` blobs migrate into the
     Default profile via the profiles migration (read as `engine: "rvc_zero"`).
     Debounce/secure the BYO-key write. **Order:** land the Profiles batch before
     this so the persistence target exists.
   - Zod schemas for `/api/ai/*` request bodies in `lib/validation.ts`.
   - Update `docs/voice-changer-research.md` §8b: record that paid STS
     (ElevenLabs/Respeecher) + STT→TTS re-speak are now **implemented** (with the
     proxy + app-quota/BYO + live-streaming architecture and the provider ranking
     table), superseding the "deferred" verdict.
   - `tsc --noEmit` clean (no lint per repo convention).
   **Progress: ✅ Done** *(Persistence: the paid-AI config (`engine`/`mode`/
   `voiceId`/`customVoiceId`/`live`) was added to `AiConfig`, which lives in the
   `voiceFx` map → already persisted **per-profile server-side** by the Profiles
   batch's `setSourceAi`/voiceFx accessors (no new persistence code needed). Old
   device-local rvc_zero `ai` blobs have no `engine` field → read as `rvc_zero`
   (back-compat default) and migrate into the Default profile via the existing
   `ProfileProvider` one-time migration. The **BYO key stays device-local**
   (`soundboard:aiKeys`) and its write is now **debounced (300ms) with an
   unmount-flush** in `AiSection`. Validation: `aiProvider`/`aiVoiceId`/
   `PostAiTtsBody` (added in task 2; STS validated field-wise in its route) cover the
   `/api/ai/*` bodies. Docs: added `docs/voice-changer-research.md` **§8d** recording
   paid STS (ElevenLabs/Respeecher) + STT→TTS re-speak as IMPLEMENTED — the
   same-origin proxy + app-quota/BYO architecture, the Respeecher continuous-live
   re-defer (standalone-server limitation) and how to revisit it — superseding the
   §8b/§8c "deferred" verdict. Final `tsc --noEmit` clean.)*

### Tasks — 1.4.1 (Profiles + header layout + Sound Effects popover — appended)

Three UI/architecture changes (owner decisions **locked** 2026-06-16). Same
version (1.4.1) — appended. The **Profiles** task is large and **server-side**, a
deliberate departure from the device-local audio-settings stance — the owner chose
full cross-device sync for profiles.

**Cross-cutting locked decisions:**
- **What a Profile bundles (per-profile):** the **Board layout** (placements,
  positions, keybinds, VR binds, labels, on-board state), the **voice-changer mic
  chain + AI config**, and **applied per-clip sound effects** (by sound id). These
  all become **server-side per profile** and **sync across devices + the desktop
  app**.
- **What stays GLOBAL (shared by all profiles):** the **Saved library** (the set of
  sounds the user has saved — owned + public-clip references) and the **FX preset
  library** (`soundboard:fxPresets` + the server `sharedPreset` library). The Saved
  tab + all preset options are always fully available regardless of active profile.
- **What stays DEVICE-LOCAL / global-per-user (NOT per-profile):** output/monitor/
  **input** device selection, the three bus volumes, Virtual-Mic + monitor-mic
  toggles, the master keybinds/controllers enable toggles, cancel-all binds,
  per-action hold-ms, controller profile, and the **AI BYO key** (a secret). Only
  the three bundles above are per-profile.
- **Active profile is DEVICE-LOCAL** (`soundboard:activeProfile` = profileId; new
  device → Default). The desktop app registers the active profile's board hotkeys,
  so a switch re-registers them. Switching is **instant** (everything auto-persists
  server-side; no save button).
- **Profile cap = role default + per-user override** (mirror the upload/AI quota
  pattern): role `profileLimit` + user `profileLimitOverride` + env
  `DEFAULT_PROFILE_LIMIT`, surfaced/overridable in /admin.
- **Default profile:** renamable; **deletable only when >1 profile exists**;
  deleting the active one switches to another; delete shows a confirm dialog.
- **Keep the `audio` accessor API stable.** The Profiles task swaps the *backing
  store* of `audio.soundFx`/`setSoundEffects` and `audio.voiceFx`/`setSourceEffects`/
  `setSourceAi` from device-local localStorage to **server-side, scoped to the
  active profile** — so the Sound-Effects popover and the (paid-AI) Voice-changer UI
  consume the same accessors **unchanged**. This is what keeps the sprint smooth.
- **Supersedes** the paid-AI batch's device-local `soundboard:voicefx` assumption
  (its task 6 now points here). Schema changes go in **BOTH `schema.ts` AND
  `bootstrap.sql`** (idempotent DDL via `migrate.ts`) — see the
  `db-schema-via-bootstrap-sql` memory.

**Recommended 1.4.1 sprint order (all appended batches — locked 2026-06-16):**
1. **Sound-Effects popover** (this batch, task 1 — independent UI, quick).
2. **Profiles backend** (this batch, task 2 — foundational; repoints the audio
   accessors to server-side per-profile; migration).
3. **Navbar + profile switcher** (this batch, task 3).
4. **Paid-AI batch** — quota+admin, proxy STS/TTS, Respeecher live, and STT→TTS are
   **profile-independent** (can start in parallel with 1–3); its **voice-changer UI
   + persistence build on Profiles**, so land those after step 2.
5. **Noise gate + pitch/formant** (the independent voice-fx batch) — **LAST**, by
   owner decision: it carries the only external dependency (SoundTouchJS) + the
   live-stream integration risk, so it's quarantined to the end where it can't churn
   `audio-output.ts`/`audio-mixer.ts` mid-profiles-refactor. New effects appear
   automatically via `EFFECT_DEFS`, so every earlier FX/preset/UI surface gains them
   with **zero rework**. *(The noise gate alone is dependency-free and may be
   cherry-picked first as a warm-up; pitch/formant stays last.)*

1. **Sound Effects → popover (header + per-card)** *(feat — independent, do first)*.
   - **Header button:** convert `SoundEffectsPickerModal`
     (`components/SoundEffectsModal.tsx`) from the full-screen `ModalShell` to an
     **anchored `Popover`** (`components/Popover.tsx`) opening below the header
     button — behaving exactly like Settings / Voice changer, **one-open-at-a-time**
     with them (fold into `HeaderControls`' single `panel` state instead of the
     separate `fxOpen` flag). It may be **a bit wider** than the other two popovers.
     The pick-a-clip → `SoundFxEditor` flow stays inside the popover.
   - **Per-card button:** convert the per-card `SoundEffectsModal` (opened from each
     `SoundCard`'s Sliders button) to an **anchored `Popover`** next to that button
     too (no more centered modal). Reuse `SoundFxEditor` unchanged.
   - `ModalShell` can be retired once both move (confirm nothing else uses it).
   - **Planning notes (locked 2026-06-16):** the header popover folds into
     `HeaderControls`' `Panel` union (add `"fx"`, drop the separate `fxOpen` flag)
     so it's one-open-at-a-time with Settings/Voice; give it a wider
     `panelClassName` (≈`w-[26rem]`) + `max-h-[80vh] overflow-y-auto` for the
     picker→editor flow. The per-card `Sliders` button wraps its `SoundEffectsModal`
     render in `<Popover align="right">` anchored to the button (the `Popover`
     panel already escapes `overflow` via portalled `Select`; cap height + scroll
     for small cards). The pick-list and `SoundFxEditor` stay as-is.
   **Progress: ✅ Done** *(`SoundEffectsModal.tsx`: retired `ModalShell` +
   `createPortal`; the two modal exports became popover BODIES — `SoundEffectsPanel`
   (per-card, fixed soundId) and `SoundEffectsPickerPanel` (header picker→editor
   flow), each a plain fragment that renders inside an anchored `Popover` (which
   supplies the `.popover` surface + outside-click/Esc close). `HeaderControls.tsx`:
   folded Sound Effects into the single `panel` state — added `"fx"` to the `Panel`
   union, dropped the separate `fxOpen` flag, and render `SoundEffectsPickerPanel`
   in a `Popover` (`align="left"`, wider `w-[26rem]` + `max-h-[80vh] overflow-y-auto
   p-3`), one-open-at-a-time with Settings/Voice. `Dashboard.tsx`: removed the
   Dashboard-level `fxModalSound` state + top-level modal render + the `onOpenFx`
   prop; `SoundCard` now owns local `fxOpen` state, calls `useAudio()`, and wraps its
   Sliders button in `<Popover align="right">` (`w-[22rem]` + `max-h-[70vh]` scroll)
   rendering `SoundEffectsPanel` scoped to the card's sound id. tsc clean.)*

2. **Profiles — server-side per-profile board + voice changer + applied FX**
   *(feat — large; foundational)*.
   - **Schema (`schema.ts` + `bootstrap.sql`):** a **`profile`** table (`id` uuid
     PK, `userId` text → user cascade, `name`, `position` int, `isDefault` bool,
     `createdAt`) carrying the per-profile **voice-changer config** + **applied FX**
     as JSON columns (`voiceFx` json, `soundFx` json `{[soundId]:EffectConfig[]}`).
     The **Board placement becomes per-profile** while the **Saved library stays
     global** — split the current `boardEntry` (which conflates library membership
     with board placement): keep `boardEntry` as the **global saved-library** row
     (userId, soundId), and add a **`profilePlacement`** table (`profileId` →
     profile cascade, `soundId`, `onBoard`, `position`, `label`, `keybind`,
     `controllerBind`, `createdAt`) for the per-profile board state. Add role
     `profileLimit` + user `profileLimitOverride` columns (mirror the quota
     columns). `ADD COLUMN IF NOT EXISTS` backfills; new tables are plain
     `CREATE TABLE IF NOT EXISTS`. *(Confirm the exact split during impl — this is
     the biggest refactor; the library-global / placement-per-profile boundary is
     the locked requirement.)*
   - **Migration (bootstrap + one-time client):** seed a **"Default"** profile per
     existing user; move each existing `boardEntry`'s on-board state
     (onBoard/position/keybind/controllerBind/label) into a Default
     `profilePlacement`; the library rows stay global. Client one-time: push any
     existing device-local `soundboard:soundfx` / `soundboard:voicefx` into the
     Default profile server-side, then stop reading them locally.
   - **API:** profile CRUD — `GET /api/profiles` (list, ordered), `POST`
     (create empty, cap-enforced via the role/override limit → 409 at cap), `PATCH
     /api/profiles/[id]` (rename / reorder), `DELETE /api/profiles/[id]` (refuse
     when only 1; if active, caller switches), and a **clone** path (`POST
     /api/profiles/[id]/clone` → deep-copies that profile's placements + voiceFx +
     soundFx, name `"<name> clone"`, cap-enforced). The board + voiceFx + soundFx
     read/write endpoints take/scope to a `profileId`. Rate-limit like `board-mut`;
     CSRF via the global middleware.
   - **Repoint the engine accessors:** in `audio-output.ts`, back
     `soundFx`/`setSoundEffects` and the voice-changer `voiceFx`/`setSourceEffects`/
     `setSourceAi` with the **active profile's server config** instead of
     localStorage — **keep the accessor signatures identical** so the FX/voice UIs
     don't change. Keep the debounced-write pattern (now a debounced server PATCH).
     BYO key + device selections + master toggles stay device-local.
   - **Active profile** = device-local (`soundboard:activeProfile`); switching
     refetches the board placements + voice/FX config and re-registers Electron
     hotkeys. The Dashboard board reads the active profile's placements.
   - **Planning decisions (locked 2026-06-16):**
     - **Cap default = `DEFAULT_PROFILE_LIMIT` = 5** (user `profileLimitOverride`
       → role `profileLimit` → env, mirroring `lib/quota.ts`). New `lib/profiles.ts`
       owns the resolution (`getProfileLimit(userId)`) + the count check; `POST`
       /clone return **409** at the cap. Surface used/cap + a per-user override in
       /admin's user row (mirror the upload-quota UI) and a role default field.
     - **boardEntry split = leave the placement columns ORPHANED** (locked). Add
       `profilePlacement` and stop reading/writing `boardEntry.{label,keybind,
       controllerBind,position,onBoard}`; do **NOT** `DROP` them (additive
       idempotent bootstrap convention — like the orphaned `masterVolume` key).
       `boardEntry(userId, soundId)` is now purely global Saved membership.
     - **`profilePlacement` shape:** `id` uuid PK, `profileId` uuid → profile
       cascade, `soundId` uuid → sound cascade, `onBoard` bool default true,
       `position` int default 0, `label`/`keybind`/`controllerBind` text,
       `createdAt`. **Unique `(profileId, soundId)`.** A row exists only for sounds
       touched per-profile (promoted to board / bound / reordered); **absence =
       saved-only in that profile** (onBoard false, no binds). The Saved tab still
       lists every `boardEntry` (global) regardless of active profile.
     - **API surface (keep Dashboard's `Entry` shape stable):** `GET
       /api/board?profileId=X` returns one row per global `boardEntry`, with
       `entry.id` = **boardEntry.id** (stable Saved id) and `onBoard`/`position`/
       `label`/`keybind`/`controllerBind` **merged from profile X's placement**
       (defaults when no placement row). `PATCH /api/board/[id]` (`[id]` =
       boardEntry.id) carries `profileId` in the body and **upserts** the placement
       for `(profileId, soundId)`. `DELETE /api/board/[id]` removes the global Saved
       row and **app-level-deletes that sound's placements across all the user's
       profiles** (placement FKs soundId, not boardEntry.id). Reorder commits
       per-placement positions for the active profile. Validate `profileId` belongs
       to the caller on every write.
     - **Profile config columns** store JSON text: `voiceFx` = the serialized
       `VoiceFxMap` (`audio-output.ts`, primary-mic source `{effects, ai}`),
       `soundFx` = `{[soundId]:EffectConfig[]}`. Read on profile load/switch into
       the existing `audio.voiceFx`/`audio.soundFx` state; writes go through the
       **same accessors** (debounced **server PATCH** to `/api/profiles/[id]`,
       replacing the localStorage write — keep the 250ms debounce + flush-on-unmount
       pattern). A `ProfileProvider` (or fold into `VrProvider`/`VoiceChangerProvider`)
       owns the profile list + active id and feeds the active id into the audio hook;
       the **BYO AI key stays device-local** (`soundboard:aiKeys`).
     - **Profiles are RE-ORDERABLE (locked):** the switcher (task 3) gets reorder
       controls; `PATCH /api/profiles/[id]` accepts a `position` (or a small reorder
       endpoint). `position` set on create (append to end).
     - **Migration:** bootstrap seeds a `Default` profile per user with no profile
       (`isDefault=true`, position 0) and copies each **on-board** `boardEntry`
       (onBoard/position/label/keybind/controllerBind) into a Default
       `profilePlacement` (idempotent: skip when a placement already exists). The
       one-time **client** push of device-local `soundboard:soundfx`/`voicefx` into
       the Default profile runs once (guard with a `soundboard:profilesMigrated`
       flag), then those local keys are ignored.
   **Progress: ✅ Done** *(Schema: new `profile` (id/userId→user cascade/name/
   position/isDefault/voiceFx text/soundFx text/createdAt) + `profilePlacement`
   (id/profileId→profile cascade/soundId→sound cascade/onBoard/position/label/
   keybind/controllerBind, UNIQUE (profileId,soundId)) tables, plus role
   `profileLimit` + user `profileLimitOverride` columns — mirrored in
   `bootstrap.sql` (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS) with an
   idempotent migration that seeds a `Default` profile per user and copies each
   on-board `boardEntry` into a Default placement. The `boardEntry` placement
   columns are left ORPHANED (boardEntry = global Saved membership now). New
   `lib/profiles.ts` owns `DEFAULT_PROFILE_LIMIT=5` + `getProfileLimit` (user→role→
   env) + `ensureDefaultProfile`/`resolveProfile`/`getOwnedProfile`/`getProfileCount`.
   API: `GET/POST /api/profiles` (list+create, 409 at cap), `PATCH/DELETE
   /api/profiles/[id]` (rename/reorder/persist voiceFx|soundFx; delete refuses the
   last one), `POST /api/profiles/[id]/clone` (deep-copies placements+config, 409 at
   cap), all rate-limited `board-mut` + ownership-validated. Board API reworked:
   `GET /api/board?profileId=X` returns one row per global boardEntry merged with
   that profile's placement (entry.id = boardEntry.id; defaults when no placement),
   `PATCH /api/board/[id]` carries `profileId` and UPSERTS the placement for
   (profile,sound), `DELETE` removes the global row + app-side deletes that sound's
   placements across all the caller's profiles. Validation: `PostProfileBody`/
   `PatchProfileBody`, `profileId` on `PatchBoardEntryBody`, `profileLimit`/
   `profileLimitOverride` on the role/user PATCH bodies. Client: new
   `components/ProfileProvider.tsx` (wraps AudioProvider in layout) owns the profile
   list + device-local active id (`soundboard:activeProfile`), exposes CRUD +
   reorder + a `backing` (active profile's parsed config + debounced server PATCH,
   250ms + flush-on-unload) and runs the one-time client migration of device-local
   `soundfx`/`voicefx` into the Default profile (`soundboard:profilesMigrated`
   guard). `useAudioOutput(backing?)` repointed: identical `soundFx`/`voiceFx`/
   `setSoundEffects`/`setSourceEffects`/`setSourceAi` signatures now persist via the
   backing (server) when present, else localStorage; a seed effect re-applies the
   active profile's chains to the mixer only on switch / server reload (loadGen) so
   per-edit persists don't rebuild chains. Dashboard threads `activeProfileId` into
   the board GET + all board PATCHes (`boardPatch` helper) + commitOrder, and
   refetches on profile switch. Admin: roles table gains a Profiles cap column
   (`ProfileLimitInput`), users table gains a used/cap display + per-user override;
   `/api/admin/users` GET returns the resolved cap + profile count. The switcher UI
   itself is Task 3. tsc clean.)*

3. **Navbar layout refactor + profile switcher dropdown** *(feat)*.
   - **Layout (`app/layout.tsx` header + `HeaderControls` + `UserMenu`):**
     restructure into **three zones** — **left:** logo icon + "Soundboard";
     **center:** the global output **meter → Voice changer → Sound effects** buttons
     (the meter moves into the center group); **right (horizontal cluster):**
     **Settings cog → user dropdown → profile dropdown** side by side, with the
     **upload-storage quota** as a thin bar **spanning beneath** them. The Settings
     cog **moves out** of the center group to the right cluster; the quota meter
     moves out of `UserMenu` (avatar dropdown stays) into the navbar bar. The navbar
     may be **taller** to fit the quota bar. Use a 3-column grid so the center group
     is truly centered.
   - **Profile switcher dropdown** (the new right-cluster control between the user
     dropdown and the quota): the button shows the **current profile name**; the
     menu lists the other profiles (click to **switch**), each row with a **clone**
     button (clones **that row's** profile → `"<name> clone"`) and a **delete**
     button (confirm dialog; disabled/ hidden when only 1 profile). **Inline-rename**
     the profile name (pencil / edit affordance). An **"other" input** at the bottom
     creates a **new empty profile** by the typed name. **Cap-aware** (disable
     create + show the limit when at the role/override cap). Uses the task-2
     profiles API; route failures through `useToast`. Reuse the `.popover` surface /
     `Select` styling.
   - **Reorder (locked 2026-06-16 — owner chose YES):** the switcher rows get
     **move up/down** controls (small ▲/▼ buttons, simplest; drag optional) that
     PATCH the affected profiles' `position` via the task-2 API and re-sort the
     list. Order = `position` (set on create = append). The active-profile + clone/
     delete/rename behaviour is unchanged by reorder.
   - **Planning notes (locked 2026-06-16):** the active profile id + profile list
     come from the task-2 `ProfileProvider` (client), so the switcher is a client
     component in the header reading shared context (not the server layout). On a
     narrow viewport, follow the existing `hidden sm:` pattern — the center group +
     quota bar may collapse/hide on small screens; the switcher stays. The header
     becomes a **3-column grid** (`grid-cols-[auto_1fr_auto]`) so the center group
     is truly centered independent of the side clusters' widths.
   **Progress: ✅ Done** *(new `components/AppHeader.tsx` — a client `grid-cols-[auto_1fr_auto]`
   navbar for signed-in users: LEFT = logo + "Soundboard"; CENTER (`hidden sm:flex`,
   truly centered) = output meter → Voice changer → Sound Effects; RIGHT cluster =
   Settings cog → user dropdown → profile dropdown in a row with the upload-storage
   **quota bar spanning beneath** them. `HeaderControls` was split into two CONTROLLED
   pieces — `CenterControls` (meter + Voice/FX popovers) and `SettingsControl` (the
   cog, moved to the right cluster) — sharing one `panel` state owned by `AppHeader`
   so the three popovers stay one-open-at-a-time across the split. The storage meter
   was lifted out of `UserMenu` into a new `components/QuotaBar.tsx` (same
   `/api/sounds` fetch + `soundboard:storage-changed` refetch, rendered as a thin bar);
   `UserMenu` is now just the avatar dropdown. New `components/ProfileSwitcher.tsx`
   (right cluster, between user menu + quota): a `.popover` dropdown showing the active
   profile name; rows list every profile (ordered by `position`), click a non-active
   row to `setActiveProfile`, with per-row inline rename (pencil → input), clone, delete
   (`confirm()`, hidden when only 1 profile), and ▲/▼ reorder (→ `reorderProfile`); a
   trailing "new profile name…" input creates one (disabled + "Profile limit reached"
   at the cap) with a "N / limit" line. All mutations go through `ProfileProvider`'s
   helpers; failures route through `useToast`/`fromResponse`. `app/layout.tsx` renders
   `<AppHeader>` for signed-in users (logged-out keeps the simple logo + Discord login
   header). tsc clean.)*

### Tasks — 1.4.1 (UI adjustments — appended)

Six UI/feature adjustments (recovered from the "Adjustments checklist" session;
the routine that was meant to build them never committed/landed). Owner decisions
**locked** 2026-06-17. Same version (1.4.1) — appended.

1. **Header order: Settings cog + profile button left of the name + quota bar**
   *(UI)*. In `components/AppHeader.tsx` the right cluster is currently `Settings →
   UserMenu(name) → ProfileSwitcher`. Reorder so both the Settings cog and the
   profile switcher sit **left of** the user name: `Settings → ProfileSwitcher →
   UserMenu(name)`. Quota bar still spans beneath.
   **Progress: ✅ Done** *(reordered the `AppHeader` right cluster to `Settings →
   ProfileSwitcher → UserMenu`; updated the header comment.)*

2. **AI Voice as its own header button/popover (split from Voice changer)**
   *(feat)*. Today the AI section is nested inside the Voice-changer popover
   (`VoiceChangerPanel` → `AiSection`). Give AI its **own header button** (4th
   popover, `Panel` += `"ai"`, one-open-at-a-time) with its **own enable toggle**;
   the Voice-changer popover keeps only the DSP effect chain. Move `AiSection` into
   a shared `components/AiVoicePanel.tsx` so it's reusable (popover + main page).
   **Progress: ✅ Done** *(new `components/AiVoicePanel.tsx` holds the moved
   `AiSection` + `AiUsageMeter` + an `AiVoicePanel({audio})` popover wrapper (with
   the no-mic input-picker fallback) + `AiMainSection`. `HeaderControls` gained a 4th
   popover button (Sparkles icon, `Panel` += `"ai"`, one-open-at-a-time). The AI
   enable Toggle stays in the section. `VoiceChangerPanel` slimmed to the DSP effect
   chain only — removed `AiSection`/`AiUsageMeter` + the now-unused imports.)*

3. **Main-page AI section when AI is enabled** *(feat)*. When AI voice is enabled
   for the active mic (`audio.voiceFx[audio.inputDeviceId]?.ai?.enabled`), render a
   main-page section in `Dashboard.tsx` **between the upload card and the board
   section** showing the interactive AI buttons (hold-to-talk + replay + live
   transcript/status). Reuse from `AiVoicePanel`. Hidden when AI is off.
   **Progress: ✅ Done** *(`AiMainSection({audio})` (exported from `AiVoicePanel`)
   renders a `card` with hold-to-talk + replay buttons + busy/error/transcript
   status; returns null unless `audio.voiceFx[inputDeviceId]?.ai?.enabled`. Mounted
   in `Dashboard` between the upload card and the board section.)*

4. **API key field moves into the Settings popover** *(UI)*. Move the BYO provider
   API-key inputs out of `AiSection` and into `SettingsPanel` (a new "AI provider
   keys" block — ElevenLabs + Respeecher password inputs, device-local
   `soundboard:aiKeys` via `readAiKeys`/`writeAiKeys`, debounced write). AI section
   keeps a short pointer to Settings.
   **Progress: ✅ Done** *(new `AiKeysSection` in `SettingsPanel` — ElevenLabs +
   Respeecher password inputs backed by `readAiKeys`/`writeAiKeys` (300ms debounced
   write + unmount flush). The BYO-key block was removed from `AiSection`, which now
   shows a "paste your key in Settings to bypass the quota" pointer.)*

5. **Savable + sharable AI voice configs — full public server library** *(feat —
   overturns the prior "AI configs NOT shared" lock; owner chose the full library
   2026-06-17)*. Mirror the shared-effect-preset stack for AI voice configs (custom
   voice id / model+index url + engine):
   - **Schema** (`schema.ts` + `bootstrap.sql`): new `sharedVoice` table (id,
     ownerId→user cascade, name, engine text, config text JSON, isOfficial,
     createdAt) — brand-new table, no backfill.
   - **Validation:** `PostSharedVoiceBody` (name ≤80, engine enum, bounded config:
     voiceId/customVoiceId strings, optional rvc custom {modelUrl,indexUrl,pitch}).
   - **API:** `GET/POST /api/voices`, `DELETE /api/voices/[id]`, `PATCH
     /api/admin/voices/[id]` (official toggle) — clones of the `/api/presets` set
     (per-user cap, official honored for admins, rate-limited, owner-or-admin
     delete).
   - **Client:** `lib/voice-presets.ts` (device-local `soundboard:voicePresets`
     save/apply + `useVoicePresets`, mirrors `fx-presets.ts`) + `lib/shared-voices.ts`
     (fetch/publish/delete/setOfficial). A `components/VoicePresetBar.tsx` (mirror
     `FxPresetBar`) + `components/SharedVoicesModal.tsx` (mirror
     `SharedPresetsModal`), wired into the AI section. Keep the "use only voices you
     have the rights to" reminder.
   - **Admin:** a "Shared voices" moderation list in the existing Admin **Presets**
     tab (toggle official + delete any).
   **Progress: ✅ Done** *(new `sharedVoice` table (id/ownerId→user cascade/name/
   engine/config JSON/isOfficial/createdAt) in `schema.ts` + `bootstrap.sql` (CREATE
   IF NOT EXISTS + owner index, new table no backfill). `PostSharedVoiceBody` in
   `validation.ts` (name ≤80, engine enum, bounded config — voiceId/customVoiceId
   strings + optional https rvc {modelUrl,indexUrl,pitch}). Routes `GET/POST
   /api/voices`, `DELETE /api/voices/[id]`, `PATCH /api/admin/voices/[id]` — clones
   of the `/api/presets` set (per-user cap 50, `isOfficial` honored for admins,
   `voice-mut` rate-limit, owner-or-admin delete; GET omits ownerId, returns `mine`).
   Client: `lib/voice-presets.ts` (device-local `soundboard:voicePresets` +
   `useVoicePresets`, mirrors `fx-presets`) + `lib/shared-voices.ts`. New
   `components/VoicePresetBar.tsx` (Save/Publish/Browse, mirror `FxPresetBar`) +
   `components/SharedVoicesModal.tsx` (mirror `SharedPresetsModal`), wired into
   `AiSection` after the voice picker with the entitlement reminder. Admin: a "Shared
   voices" moderation list (toggle official + delete) added to the Presets tab.)*

6. **Sound Effects popover bigger / params wrap** *(UI)*. The Sound-Effects
   popovers are cramped (fixed `w-[26rem]` header / `w-[22rem]` per-card, single
   column params). Widen them and let the effect param rows **wrap to two columns**
   on the wider width so they don't overflow a tiny column.
   **Progress: ✅ Done** *(widened the header Sound-Effects popover `w-[26rem]`→
   `w-[34rem]` and the per-card popover `w-[22rem]`→`w-[30rem]`; the `SoundFxEditor`
   param rows now wrap to two columns (`sm:grid-cols-2`, label `w-20`→`w-16`).)*

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
