# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A Discord-authenticated soundboard. Users log in with Discord, upload mp3s (or
import from YouTube), tag and organize them in a **Saved** library, promote a
curated subset onto a playable **Board**, assign keyboard **and Valve Index VR
controller** binds, and optionally share clips publicly for others to browse and
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
    (`vr-bridge.exe`) that reads Valve Index controllers and prints button edges
    as JSON. Built with CMake; staged into `electron/resources/vr` for packaging.
- Root `package.json` is just convenience scripts that delegate into the
  workspaces.

Versions across all three `package.json` files are kept in lockstep
(currently **1.3.0**).

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
- `lib/chord.ts` is the shared chord model for **both** keyboard and controller
  binds: a bind is a *set* of inputs held together, serialized "+"-joined and
  canonically ordered. Two never-mixed namespaces: keyboard
  (`"Ctrl+Shift+F5"`) and controller (`"VR:LeftHand:A+VR:RightHand:Trigger"`).
  Matching fires on the input that *completes* a bound set; **largest wins**
  (`pickLargest`), so a chord suppresses its sub-binds.
- Keybinds only apply to **on-board** entries, gated by a master keybinds toggle
  + per-entry enable. A **cancel-all** action is a first-class bindable button on
  the Board tab; it routes through the same matching via the `CANCEL_ALL_BIND`
  sentinel and persists device-locally (localStorage `soundboard:cancelAllKeybind`).
- **Duplicate-playback guard:** in the Electron app a focused keypress hits both
  the in-app `keydown` listener and the OS global hook. `playEntry`
  (`Dashboard.tsx`) coalesces with a ~60ms per-entry window so each trigger plays
  once.

### VR controller binds (Valve Index)
The full path, web ⇄ Electron ⇄ native:
- **Native** `electron/native/vr-bridge/src/main.cpp` — a background OpenVR app
  (`VRApplication_Background`, no rendering, doesn't steal focus). It reads the
  Index via the SteamVR Input action system and prints line-delimited JSON on
  stdout: `{"t":"status","steamvr":bool}`, `{"t":"down|up","token":"VR:…"}`.
  Action manifests live in `native/vr-bridge/manifests/`
  (`soundboard_actions.json`, `bindings_knuckles.json`); a generated
  `.vrmanifest` (names the app "Soundboard") is written into the Electron
  userData dir at runtime.
- **The 16 inputs** come from `makeDigital()` + `makeAnalog()` — per hand: `A`,
  `B`, `Trigger`, `TriggerPull` (analog pull, hysteresis-thresholded, distinct
  from the `Trigger` click), `Grip`, `ThumbstickClick`, `ATouch`,
  `TrackpadTouch`. **Touch + analog-pull are first-class bindable** (locked owner
  decision) — never filter them out.
- **Electron** `vr-controllers.js` spawns the sidecar (path from `vrPaths()` in
  `main.js`: `resources/vr` when packaged, the CMake `build/Release` in dev),
  self-restarts it on crash with backoff, and forwards edges via IPC. `main.js`
  → `webContents.send("soundboard:vrInput"/"soundboard:vrStatus")` → `preload.js`
  re-emits them as window `CustomEvent`s. A missing exe disables the feature
  quietly.
- **Bind model + engine** live in `web/src/lib/vr-bind.ts`. A bind is an
  **ordered list of steps**; each step is a **set of simultaneous actions**; an
  **action** = one input + one **edge** (`down`/`up`), so all 16 inputs expose 32
  actions. Two modes: **simul** (one step — hold a group together / fire on a
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
  **full-screen drag-flow builder**: a palette of all 32 actions (grouped by
  hand, each input with ↓/↑) is dragged or clicked into a **current-step** group;
  "Add as next step" commits a step in seq mode; a live **test area**
  (`VrBindPreview`) shows progress as you physically perform the bind. Persisted
  as a serialized `VrBind` JSON string in `controllerBind` (`serializeVrBind`).
- **Storage + compat:** new binds are JSON (leading `{`); **legacy `+`-joined
  chord strings auto-convert** on read (`parseVrBind`) to a single simultaneous
  step of `down` actions, so old binds keep working. `lib/validation.ts` bounds
  the raw length and delegates the grammar/caps to `isValidVrBindString`. Stored
  binds render as wrapping per-action pills with `→` step separators
  (`VrBindChips`).

### Virtual Mic mode
The audio engine lives in three files:
- `web/src/lib/audio-mixer.ts` — `MicMixer`, a single `AudioContext` that sums
  **sources** (capture devices + injected soundboard clips) into a **cableBus**
  → `ctx.destination` routed via `setSinkId` to the chosen output device (the
  virtual cable = the game's mic). A parallel **monitorBus** with per-source
  monitor-send gains lets you hear chosen lines locally without echoing your own
  mic into the monitor. A pre-limiter **cableAnalyser** drives the cable meter;
  each live input also has its **own post-volume analyser** (`getInputPeak`) for
  per-source meters.
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
  reveals the Output & Virtual Mic pill tabs (Sources / Monitor sections).

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

### User-facing notifications
- `components/Toast.tsx` — `ToastProvider` + `useToast` (mounted in the root
  layout), with a `fromResponse` helper (reads a failed Response's `{error}`,
  friendly 429 message) and a `useMutate` hook for fire-and-forget mutations.
  Client fetch/mutation paths route 4xx/5xx/network/429 failures through it
  instead of failing silently. Passive background loads (nav storage meter, tag
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

The **1.3.0 UX overhaul** is feature-complete: the Saved/Board split, mandatory
tags + `misc` default, inline public browser, wavesurfer multi-segment clip
editor, cancel-all-as-a-bind, admin pill redesign with per-role overrides + tag
editing, new-user onboarding overlay, nonce-based CSP, and the toast notification
system all shipped.

The **controller binds were then re-architected** beyond the original picker:
binds are now **step/sequence macros with down/up edges** (`lib/vr-bind.ts`),
edited in a **full-screen drag-flow builder with a live test area**
(`VrBindPicker`). See the "VR controller binds" concept above.

A **pre-release security audit** (1.3.0) hardened four things, all now locked:
the upload `Content-Length` guard, system-role rename protection, idempotent
public-clip adds, and dropping `ownerId` from `/api/public/sounds` (see the
relevant concept sections + Security notes above).

**Caveats for the next agent:**
- The nonce-based CSP (`middleware.ts`) keeps `script-src 'self'` rather than
  `'strict-dynamic'` as a more forgiving fallback. The CSP + nonce only behave in
  a real build (a mismatch blocks all scripts), so it **can't be exercised on the
  host with `next dev`** — if hydration ever breaks in prod, suspect the nonce
  plumbing here first.
- **VR bind matching is unverified against real hardware** in this environment
  (built + typechecked only). The `VrMatcher` engine is pure and unit-testable;
  the temporal-prefix caveat (above) is a known, accepted limitation.
- No per-role **sound-count** quota exists (quotas are file size + total
  storage only). Don't add one without an explicit owner decision.

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
