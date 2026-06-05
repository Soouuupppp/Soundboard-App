# Soundboard

> 🎉 **Public & free instance available at [soundboard.soouuuppp.com](https://soundboard.soouuuppp.com)** — log in with Discord and start building your board, no setup required.

Discord-authenticated soundboard dashboard. Upload mp3s, organize them on a board, assign keybinds, and share publicly. Ships with an Electron wrapper that registers OS-level global shortcuts so keybinds work even when the browser isn't focused.

**Author:** Soouuupppp · [soouuupppp.com](https://soouuupppp.com) · [soouuuppppgames@gmail.com](mailto:soouuuppppgames@gmail.com) · [github.com/Soouuupppp](https://github.com/Soouuupppp)

## Stack

- **web/** — Next.js 15 (App Router, TS), Tailwind glassy dark UI, Auth.js (Discord), Drizzle ORM, Postgres
- **electron/** — Electron wrapper around the web app; passthrough low-level keyboard hook (`uiohook-napi`) → IPC → renderer event (keys still reach whatever app currently has focus)
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
- Each role has `defaultMaxFileSize` and `defaultMaxTotalStorage` (bytes — the admin UI accepts human sizes like `5 MB`, `1.5 GB`).
- Each user can have individual overrides (`maxFileSizeOverride`, `maxTotalStorageOverride`) editable from `/admin`.
- Quota resolution: user override → role default → env `DEFAULT_*`.

## Public sounds

- Sounds flipped to **Public** appear in `/public` for every other user to browse, play, and add to their own board.
- Authors are filtered out of their own public listing — you can't re-add a clip you already own. Your uploads are auto-placed on your board.

## Storage layout

```
data_public/
  <user-discord-id>/
    <sound-uuid>.mp3
data_db/
  ... postgres files ...
```

Public sounds added to another user's board are stored as **references** in `board_entries`, not copied — they don't count against the adder's quota. If the owner deletes the file, references show as unavailable.

## License

Unlicensed / all rights reserved. Contact the author for usage permissions.
