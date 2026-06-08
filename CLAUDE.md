# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A Discord-authenticated soundboard. Users log in with Discord, upload mp3s,
arrange them on a personal board, assign keybinds, and optionally share clips
publicly for others to browse and add to their own board. A **Virtual Mic
mode** lets you mix mics + the soundboard into a virtual audio cable so the
sounds come through as your mic in games/calls. An **Electron wrapper**
registers the board's keybinds as OS-level global hotkeys so they fire even
when the app isn't focused.

Public instance: https://soundboard.soouuupppp.com

## Monorepo layout

pnpm workspace (`pnpm-workspace.yaml`), package manager pinned to `pnpm@9.12.3`.

- **`web/`** — `soundboard-web`, the Next.js 15 app (App Router, TypeScript).
  Everything user-facing lives here.
- **`electron/`** — `soundboard-electron`, the desktop wrapper. Loads a remote
  server URL in a `BrowserWindow` and adds global hotkeys. **Windows-only.**
- Root `package.json` is just convenience scripts that delegate into the
  workspaces.

Versions across all three `package.json` files are kept in lockstep
(currently **1.1.0**).

## Stack

- **web/** — Next.js 15, Tailwind (glassy dark UI), Auth.js v5 / `next-auth`
  beta (Discord provider), Drizzle ORM, Postgres, Zod for validation.
- **electron/** — Electron 33, `uiohook-napi` (low-level keyboard hook),
  `electron-updater` (GitHub-release auto-update), `electron-builder`.
- **Postgres** — official `postgres:16-alpine`.
- **docker compose** — `web` + `db` services. Uploads bind-mounted to
  `./data_public`, postgres data to `./data_db`. Both gitignored.

## Commands (run from repo root)

```bash
pnpm dev            # next dev (web)
pnpm build          # next build (web)
pnpm db:generate    # drizzle-kit generate (migrations)
pnpm db:migrate     # apply migrations (tsx src/db/migrate.ts)
pnpm electron       # run the desktop wrapper from source
pnpm up / pnpm down # docker compose up --build / down
```

Web-only extras (run with `pnpm --filter web <script>`): `lint`, `db:push`.
Electron build scripts (`pnpm --filter electron <script>`): `bake`, `dist`,
`dist:win`, `dist:portable`, `release:win` — see `electron/README.md`.

## Key concepts

### Auth, roles, quotas
- Auth.js with the Discord provider; the Drizzle adapter owns the core
  `user`/`account`/`session`/`verificationToken` tables (`web/src/db/schema.ts`).
- Discord user ID is mirrored onto `user.discordId` for fast lookups.
- Two seeded **system roles**: `user` (default) and `admin` (protected from
  deletion via `isSystem`). Custom roles are creatable in `/admin`.
- Quotas resolve **user override → role default → env `DEFAULT_*`**. Sizes are
  stored as bytes; the admin UI accepts human strings like `5 MB`.
- Put a Discord ID in `DISCORD_ADMIN_IDS` to auto-promote on first login.

### Sounds, boards, public sharing
- A `sound` is owned by one user and stored on disk at
  `data_public/<discordId>/<uuid>.mp3` (path mirrored in `sound.storagePath`).
- A `boardEntry` is a **reference** to a sound on a user's board, with an
  optional override `label`/`keybind`/`position`. Adding someone's public clip
  creates a reference — the file is **not copied** and doesn't count against
  the adder's quota. If the owner deletes it, references show as unavailable.
- `/api/sounds/[id]/file` streams the mp3 with an access check (owner always;
  anyone logged-in if the sound is public).

### Virtual Mic mode (the 1.1 feature)
The audio engine lives in three files:
- `web/src/lib/audio-mixer.ts` — `MicMixer`, a single `AudioContext` that sums
  **sources** (capture devices + injected soundboard clips) into a **cableBus**
  → `ctx.destination` routed via `setSinkId` to the chosen output device (the
  virtual cable = the game's mic). A parallel **monitorBus** with per-source
  monitor-send gains lets you hear chosen lines locally without echoing your
  own mic into the monitor.
- `web/src/lib/audio-output.ts` — `useAudioOutput()` hook: device enumeration,
  persisted settings (localStorage `soundboard:output`), normal-vs-mixer
  playback, and mixer lifecycle.
- `web/src/components/Dashboard.tsx` — the UI (Sources / Monitor sections).

**Design constraint (important):** sources are **capture devices / cables
only** — no system loopback, no native code. Routing "any app's audio" into
the mic means sending that app to a virtual cable (VB-Audio, VoiceMeeter) or a
GoXLR bus in Windows, which then appears as a capture device here. Loopback and
a native WASAPI addon were both deliberately rejected (security + cost) — see
the `virtual-mic-capture` memory before reopening that decision.

### Electron global hotkeys
- `main.js` opens a `BrowserWindow` at the configured server URL (baked at
  build time, env `SOUNDBOARD_URL`, or prompted on first launch and saved to
  `userData/settings.json`).
- `preload.js` exposes `window.soundboard.registerKeybinds(combos)`; the
  dashboard calls it with the board's combos. `hotkeys.js` (backed by
  `uiohook-napi`) **observes** key events without capturing them, so the key
  still reaches whatever app has focus. A match → IPC → `soundboard:globalKey`
  CustomEvent → dashboard triggers playback.
- Permissions are locked down in `main.js`: only `media` (mic for the mixer)
  and `speaker-selection` (`setSinkId`) are granted; webviews are refused.

## Security notes
- CSP and security headers are defined in `web/next.config.ts`. `microphone`
  and `speaker-selection` are scoped to `self` for the in-app mixer; everything
  else is locked down.
- The Electron app loads a **remote** URL, so the renderer is treated as
  semi-trusted — hence the strict permission handlers and the loopback
  rejection above.

## Conventions
- Match the existing concise, comment-the-why style. The audio files in
  particular carry ASCII signal-flow diagrams in their header comments — keep
  them accurate if you change routing.
- **Do not run linting** (`pnpm lint` / eslint) — don't run it to verify changes.
- License is UNLICENSED / all rights reserved.
