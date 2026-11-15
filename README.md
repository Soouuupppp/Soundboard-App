<p align="center">
  <img src="web/src/app/logo.png" alt="Soundboard logo" width="96" height="96">
</p>

<h1 align="center">Soundboard</h1>

<p align="center">
  A soundboard that lives in your browser and plays into your games and calls.<br>
  Upload clips, put your favourites on a board, bind them to keys, a VR controller or a Stream Deck,<br>
  and send them through a virtual mic so everyone hears them.
</p>

<p align="center">
  <a href="https://soundboard.soouuupppp.com"><strong>Open the public instance →</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Soouuupppp/Soundboard-App/releases/latest">Desktop app (Windows)</a>
  &nbsp;·&nbsp;
  <a href="docs/soundboard-guide.html">Interactive guide</a>
</p>

---

## Try it now

The public instance at **[soundboard.soouuupppp.com](https://soundboard.soouuupppp.com)** is free. Sign in with
Discord and you're in, with nothing to install. What you can do there depends on your role: by default you can
browse and save public clips, and an admin can allow you to upload your own.

Want the global hotkeys, VR controllers or Stream Deck? Install the
[Windows desktop app](https://github.com/Soouuupppp/Soundboard-App/releases/latest) and point it at the same site.
Want your own server? See [Self-hosting](#self-hosting).

## Features

| Feature | What it does | Browser | Windows desktop app |
| --- | --- | :---: | :---: |
| **Saved library** | Every clip you upload or save from the public list, with 1–3 tags, search and a tag filter | ✅ | ✅ |
| **Board** | The clips you actually play: buttons, drag-to-reorder, per-clip volume, Cancel all | ✅ | ✅ |
| **Upload + clip editor** | Upload an mp3, cut out parts on a waveform, re-encoded in the browser before upload | ✅ | ✅ |
| **YouTube import** | Paste a link and the server converts it, then the same editor opens. Each instance's admin decides who can use it | ✅ | ✅ |
| **Public sharing** | Make a clip public; others save it as a reference (no copy, no storage used) | ✅ | ✅ |
| **Keyboard binds** | A key or a chord like `Ctrl+Shift+F5` per Board clip | While the page is focused | Anywhere, even in a game |
| **VR controller binds** | Valve Index or Meta Quest/Touch buttons, including sequences and hold times | — | ✅ (SteamVR) |
| **Virtual Mic** | Mixes your mic and the board into a virtual audio cable your game uses as its mic | ✅ (Chromium) | ✅ |
| **Voice changer** | A chain of real-time mic effects (robot, echo, reverb, pitch shift, noise gate and more) | ✅ (Chromium) | ✅ |
| **Clip effects** | Effects for one clip, applied every time it plays | ✅ (Chromium) | ✅ |
| **AI voice** | Optional push-to-talk voice conversion through third-party providers, played into your mic | ✅ (Chromium) | ✅ |
| **Livepad** | Keep a rolling buffer of a source and snapshot the last 1–120 seconds into a card | Recording devices (Chromium) | + single apps and playback devices |
| **Profiles** | Switch whole setups (board, binds, effects, AI voice); Saved is shared by all | ✅ | ✅ |
| **Stream Deck** | Our plugin: play, Cancel all, AI push-to-talk, Livepad, switch profile | — | ✅ |
| **VRChat avatar panel** | *Experimental.* A Stream-Deck-like panel on your avatar that triggers the app over OSC (PC only) | — | ✅ |

"Chromium" means a browser that can send audio to a chosen output device (Chrome, Edge and other Chromium
browsers). Elsewhere the board still plays on your default output, without Virtual Mic or effects.

## How you use it

```text
 Upload / YouTube / Browse public
               │
               ▼
        ┌─────────────┐   Add to board    ┌─────────────┐   button, key, controller,
        │    Saved    │ ────────────────► │    Board    │ ─────────────────────────► plays
        │  (library)  │ ◄──────────────── │(per profile)│   Stream Deck, avatar panel
        └─────────────┘ Remove from board └─────────────┘
```

1. **Add sounds.** Upload an mp3, import from YouTube, or save someone's public clip. A tag is required. New clips
   always land in **Saved**, never straight on a Board.
2. **Build your Board.** Add the clips you want to play to the Board of the active profile. Removing a clip from
   the Board keeps it in Saved.
3. **Bind and play.** Click to play, or give a Board clip a keyboard bind and a controller bind. **Cancel all**
   stops everything and can be bound too.
4. **Route it.** Turn on Virtual Mic in Settings to play into a game or call (see [Audio routing](#audio-routing)).
5. **Switch profiles** for different games or streams. Each profile keeps its own Board, binds and effects.

New here? Open the [interactive guide](#interactive-guide) for a hands-on tour.

## How it fits together

The website does all the work: it stores clips, runs the board and mixes the audio in your browser. The
desktop app loads the same website and adds local inputs. Those inputs only *trigger* the page; they never play
audio themselves.

```mermaid
flowchart LR
  subgraph Server["Server (Docker)"]
    Web["Next.js web app"]
    DB[("Postgres")]
    Files[("Uploaded mp3s")]
    Web --- DB
    Web --- Files
  end

  subgraph PC["Your Windows PC"]
    UI["Soundboard page<br/>(browser or desktop app)<br/>plays and mixes audio"]
    Desktop["Desktop app<br/>(Electron)"]
    Keys["Global hotkeys"]
    VR["VR controllers<br/>(SteamVR)"]
    Deck["Stream Deck plugin"]
    OSC["VRChat avatar panel"]
    Cap["App / playback capture"]
    Cable["Virtual audio cable"]
    Game["Game or call"]
  end

  UI <-->|"HTTPS: clips, settings"| Web
  Desktop -->|"loads"| UI
  Keys -->|"trigger"| Desktop
  VR -->|"trigger"| Desktop
  Deck -->|"trigger"| Desktop
  OSC -->|"trigger"| Desktop
  Cap -->|"Livepad audio"| Desktop
  Desktop -->|"trigger / audio"| UI
  UI ==>|"board + mic audio"| Cable
  Cable ==>|"used as the mic"| Game
```

| Bridge (desktop app only) | How it talks to the app | What it does |
| --- | --- | --- |
| **Global hotkeys** | Keyboard hook that watches keys without blocking them | Board keybinds fire while another app has focus |
| **VR controllers** | Small OpenVR helper reading SteamVR input | Matches controller binds (Index and Quest/Touch) |
| **Stream Deck** | Our plugin over a local named pipe with a per-launch token | Play, Cancel all, AI push-to-talk/toggle, Livepad, switch profile |
| **Livepad capture** | Native WASAPI helper, one approval per source | Records a single app or playback device for Livepad |
| **VRChat avatar panel** | OSC/OSCQuery on the local machine | Keys on your avatar run actions you lay out per profile |

## Audio routing

Virtual Mic needs a **virtual audio cable** installed in Windows, for example VB-Audio Virtual Cable or
VoiceMeeter. A cable has two ends:

1. In Soundboard **Settings**, set **Output** to the cable's playback end (often called *CABLE Input*) and turn on
   **Virtual Mic mode**. Your mic and the board are mixed into it.
2. In your game or call, pick the cable's recording end (often *CABLE Output*) as the microphone.
3. Set **Monitor** to your headphones to hear the board yourself. Previews from Saved and the public list only
   ever play on the Monitor, never into the cable.

Virtual Mic only takes audio from recording devices and cables. To put another app's sound in your mic, route
that app to a cable in Windows first. Livepad is separate: the desktop app can record a single app or playback
device for Livepad only.

The optional AI voice sends your recorded speech to third-party providers (listed in the Terms of Service shown
on first login and in [`AGENTS.md`](AGENTS.md#third-party-ai-voice-providers)).

## Interactive guide

[`docs/soundboard-guide.html`](docs/soundboard-guide.html) is a clickable copy of the dashboard running on
example data, with the same look as the app. Press the **?** next to the logo for guides and tips: pick a guide
(Board & Saved, Add a sound, Keybinds & controllers, Play into a game, Livepad, Profiles) and it highlights each
control in turn, moving on by itself as soon as you do the step. It's where the guide is designed and tuned
before it goes into the app.

GitHub shows `.html` files as source, so **download the file and open it in your browser**. It's a single file;
the only thing it loads is the app's font from Google Fonts (without internet it uses your system font).
Everything in it is simulated: it plays no audio, uses no microphone, uploads nothing, and resets when you
reload. It isn't part of the live app.

To change it, edit the guide text and example data at the top of its script. After changing markup classes or
icons, run `node docs/build-guide.mjs` (needs `pnpm install`) to rebuild its CSS from the app's Tailwind setup.

## Self-hosting

You need **Docker** with Compose, **Node.js** and **pnpm 9.12.3** (only for the helper scripts), and a Discord
application for login.

1. **Create the Discord application.** In the
   [Discord developer portal](https://discord.com/developers/applications), create an application, open
   **OAuth2**, and add the redirect `http://localhost:5050/api/auth/callback/discord` (use your public URL
   instead when you deploy, see below). Copy the client ID and secret.

2. **Create `.env`** from the example and fill it in:

   ```bash
   cp .env.example .env
   ```

   | Variable | Set it to |
   | --- | --- |
   | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database credentials of your choice |
   | `DATABASE_URL` | `postgres://<user>:<password>@db:5432/<db>`, matching the values above (`db` is the Compose service) |
   | `AUTH_SECRET` | A long random string, e.g. `openssl rand -base64 32` |
   | `AUTH_URL`, `NEXTAUTH_URL` | The URL people open: `http://localhost:5050` locally |
   | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From step 1 |
   | `DISCORD_ADMIN_IDS` | Your Discord user ID, so you become admin on first login |
   | `UPLOADS_DIR` | Leave as `/data_public` (the path inside the container) |

   Everything else in `.env.example` is optional and commented there: default quotas, Google Analytics,
   paid AI voice keys, and YouTube cookies or a proxy for servers YouTube blocks.

3. **Start it.**

   ```bash
   pnpm up
   ```

   `pnpm up` runs `scripts/docker-rebuild.mjs`, which builds the web image, keeps the previous build as
   `soundboard-web:prev` for rollback, and runs the stack in the foreground (Ctrl+C stops and cleans up).
   `pnpm dev` does the same but detached; `pnpm down` stops it. Plain `docker compose up --build` works too.

4. **Open** [http://localhost:5050](http://localhost:5050) and sign in with Discord.

The database schema is applied automatically every time the web container starts, and the default roles are
created then: **user** (browse and save public clips, no uploads), **whitelisted** (can upload) and **admin**.
Manage roles, quotas, tags, YouTube import and AI voice in `/admin`.

**Data** lives on the host: uploads in `./data_public/<discord-id>/<uuid>.mp3` and the database in `./data_db`
(both gitignored). Set `DATA_PUBLIC_DIR` and `DATA_DB_DIR` to keep them somewhere else.

**Putting it online.** Compose only listens on `127.0.0.1:5050`, so put an HTTPS reverse proxy (Caddy, nginx,
Cloudflare Tunnel…) in front of it. Then set `AUTH_URL` and `NEXTAUTH_URL` to your `https://` address, add
`https://<your-domain>/api/auth/callback/discord` as the Discord redirect, and set `NEXT_PUBLIC_SITE_URL` before
building (it's baked in at build time). The microphone and audio-device features only work over HTTPS or on
`localhost`.

## Local development

### Run the web app with hot reload

Next.js dev runs on the host on port **3000**, against a database you start yourself. Compose can provide one:
it publishes Postgres on `127.0.0.1:5432`.

```bash
pnpm install
docker compose up -d db
```

The web app doesn't read the root `.env`, and the migration script doesn't load any env file, so give both the
variables directly. Use `localhost` (not `db`) in `DATABASE_URL`, and add
`http://localhost:3000/api/auth/callback/discord` as a Discord redirect.

```bash
export DATABASE_URL=postgres://soundboard:changeme@localhost:5432/soundboard
export AUTH_SECRET=dev-secret-change-me
export AUTH_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000
export DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... DISCORD_ADMIN_IDS=...
export UPLOADS_DIR="$PWD/data_public"

pnpm db:migrate   # apply the schema and seed the roles
pnpm dev:web      # http://localhost:3000
```

In PowerShell, set each one as `$env:DATABASE_URL = "postgres://..."` instead (and
`$env:UPLOADS_DIR = "$PWD\data_public"`). You can also put them in `web/.env.local`, which Next.js reads, but
`pnpm db:migrate` still needs `DATABASE_URL` in the shell.

YouTube import runs on the host in this mode, so it needs `yt-dlp` and `ffmpeg` on your `PATH` (the Docker
image already includes them).

### Test without Discord

For local testing you can turn login off. Every request then runs as one seeded **System** user with the admin
role, and every page shows a red "Auth is OFF" banner.

```bash
AUTH_DISABLED=true docker compose up --build -d
```

> [!WARNING]
> With `AUTH_DISABLED=true`, **anyone who can reach the server is an admin.** Use it only on your own machine,
> never on a server other people can reach.

### Run the desktop app from source

The desktop app is Windows only. Point it at your local server; a source run with `SOUNDBOARD_URL` set uses its
own settings folder, so it doesn't touch an installed copy.

```powershell
$env:SOUNDBOARD_URL = "http://localhost:5050"; pnpm electron
```

```bash
SOUNDBOARD_URL=http://localhost:5050 pnpm electron
```

Building the native helpers, the installer and the Stream Deck plugin is covered in
[`electron/README.md`](electron/README.md). You don't need any of that to use the website.

## Repository map

| Path | What's there |
| --- | --- |
| [`web/`](web) | The Next.js app: pages, API routes, the audio engine, database schema (`src/db/bootstrap.sql`) |
| [`electron/`](electron) | Windows desktop app plus native helpers for VR controllers and Livepad capture — [README](electron/README.md) |
| [`streamdeck/`](streamdeck) | Our Stream Deck plugin |
| [`avatar-panel/`](avatar-panel) | Unity package for the experimental VRChat avatar panel — [README](avatar-panel/README.md) |
| [`docs/`](docs) | The [interactive guide](docs/soundboard-guide.html) and the [voice changer research](docs/voice-changer-research.md) |
| [`scripts/`](scripts) | Docker rebuild and rollback helpers |
| [`AGENTS.md`](AGENTS.md) | Detailed architecture notes, decisions and release history |

## License

Unlicensed, all rights reserved. Contact the author for permission to use it.

**Author:** Soouuupppp · [soouuupppp.com](https://soouuupppp.com) · [soouuuppppgames@gmail.com](mailto:soouuuppppgames@gmail.com) · [github.com/Soouuupppp](https://github.com/Soouuupppp)
