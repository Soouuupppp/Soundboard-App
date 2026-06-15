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
(currently **1.4.0**).

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
