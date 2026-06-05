# Soundboard

Discord-authenticated soundboard dashboard. Users upload mp3s, organize them on a board, assign keybinds, and share publicly. Comes with an Electron wrapper that registers OS-level global shortcuts so keybinds work when the browser isn't focused.

## Stack

- **web/** — Next.js 15 (App Router, TS), Tailwind + shadcn-style UI, Auth.js (Discord), Drizzle ORM, Postgres
- **electron/** — Electron wrapper around the web app, `globalShortcut` → IPC → renderer event
- **Postgres** — official `postgres:16-alpine` image
- **docker compose** — `web` and `db` services, each their own image. Bind-mount volumes: `./data_public` (uploads) and `./data_db` (postgres). Both gitignored.

## Quick start

```bash
cp .env.example .env       # fill in DISCORD_CLIENT_ID/SECRET, AUTH_SECRET, DISCORD_ADMIN_IDS
docker compose up --build
# http://localhost:3000
```

### Discord OAuth

1. https://discord.com/developers/applications → New Application → OAuth2.
2. Add redirect: `http://localhost:3000/api/auth/callback/discord`.
3. Copy Client ID/Secret into `.env`.
4. Put your Discord user ID in `DISCORD_ADMIN_IDS` to be auto-promoted to admin on first login.

### Local dev (no Docker, app only)

```bash
pnpm install
# start postgres however you like, set DATABASE_URL
pnpm db:migrate
pnpm dev
```

### Electron desktop wrapper

```bash
pnpm --filter electron install
pnpm electron        # opens the local web app with OS-level global shortcuts
```

The Electron app reads keybinds from the logged-in user's board (via an exposed API) and registers them as global shortcuts. Pressing the key triggers playback even when Electron isn't focused.

## Roles & quotas

- Two seeded roles: `user` (default), `admin`. Custom roles are creatable in `/admin`.
- Each role has `defaultMaxFileSize` and `defaultMaxTotalStorage` (bytes).
- Each user can have individual overrides (`maxFileSizeOverride`, `maxTotalStorageOverride`) editable from `/admin`.
- Quota resolution: user override → role default → env `DEFAULT_*`.

## Storage layout

```
data_public/
  <user-discord-id>/
    <sound-uuid>.mp3
data_db/
  ... postgres files ...
```

Public sounds added to another user's board are stored as **references** in `board_entries`, not copied — they don't count against the adder's quota. If the owner deletes the file, references show as unavailable.
