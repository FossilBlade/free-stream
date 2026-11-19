# FreeStream

A self-hosted, Netflix-style streaming app for your home network. It plays movies and shows straight from torrents while they download, so there's nothing to wait for and no media library to manage. It runs on one computer (built and tested on an Apple Silicon Mac), and everyone in the house watches from a browser on the same Wi-Fi or from a small LG webOS TV app.

Written in TypeScript: React + Vite on the front end, Express + WebTorrent on the server.

> **Legal note:** FreeStream is a player and organiser. It doesn't host, index or ship any content, and it only uses the indexers you add yourself. Only stream content you have the right to watch. You are responsible for following the law where you live.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start (Docker)](#quick-start-docker)
- [Setup without Docker](#setup-without-docker)
- [Watching on an LG TV](#watching-on-an-lg-tv)
- [Configuration](#configuration)
- [Security and privacy](#security-and-privacy)
- [If something won't play](#if-something-wont-play)
- [Development](#development)

## Features

### Browse and watch
- **Catalog from TMDB:** trending, popular, new releases, genres, seasons and episodes, cast, trailers and age ratings.
- **Netflix-style interface** with its own teal-and-amber theme, built for the TV remote: arrow keys, OK and Back everywhere, LG Magic Remote pointer support, and media keys in the player. It runs on old TV browsers (LG webOS 5, Chromium 68). On phones the main sections move to a bottom tab bar.
- **Streams while downloading** (WebTorrent). Seeking jumps ahead in the download. In season packs, each episode picks its own file.
- **Continue Watching, My List, resume position**, auto "next episode", and subtitles bundled with the torrent.
- **Downloads page:** download for offline viewing, **Keep** a download so it's never cleaned up, save the file to the device you're on, or delete it. Downloads are linked to their titles, so a title page shows "On this computer" instead of offering to download it again.
- **Download-only by default:** FreeStream doesn't upload to other peers unless you turn sharing on in Settings.

### Search
- Search by title, actor or director. Exact titles and the profile's languages rank first, and adding a year narrows the results ("Drishyam 2015").
- **Filters** by type, language, genre, decade and sort order, with or without typed text. The Movies and Shows pages have language tabs.
- Recent searches are kept per profile.

### Sources
- **Prowlarr or Jackett** supply the torrent results. Each indexer is searched separately with a timeout, so one slow site can't hold up the rest.
- **Strict title matching:** the release name must start with the title, and any of the film's release years is accepted (festival premiere or wide release).
- **Best pick:** one recommended source goes to the top, with the reason ("Checked: full movie · 1080p, matches your screen · Plays on this device · 240 seeders"). Sources are ranked for the device you're using:
  - no 4K for a 1080p screen (auto-detected, or set per device under Settings → This screen);
  - Dolby audio ranked down where it can't play (Chrome on a computer);
  - files unusually **small** (likely poor quality or fake) or **very large** (slow to stream) for their resolution and runtime are flagged.
- **Preview** any source before committing. It plays a few spots of the actual file, shows its real resolution and runtime, and runs a source check. Previews are discarded when closed.
- **Magnet link:** paste your own.

### Source checks (optional AI)
1. **File list:** flags program files, archives, or a video that's only a small part of the download.
2. **Runtime probe** with ffmpeg: compares the real runtime with TMDB's, the strongest "is it the whole film?" signal. Also reads resolution and audio languages.
3. **AI judgement**, optionally with video frames. It runs locally with [Ollama](https://ollama.com) by default (`gemma4:e2b`), so nothing leaves your network. Remote options: Google Gemini (free tier), Anthropic Claude, OpenAI, xAI Grok, OpenRouter, or any OpenAI-compatible server. An unsure AI never overrides the measurements.

### Release status and "Watching"
- **Coming soon / In theaters / Available**, from TMDB's release dates. Proper releases usually appear after the *digital* release, so titles still in theaters show only **theater copies** (camera recordings or screeners) in their own section, if you want one anyway.
- **Notify me** on upcoming titles. When you play a theater copy, a **better version** watch starts automatically. FreeStream checks in the background, verifies what it finds, and can download it for you.

### Family profiles
- **"Who's watching?"**: each person has their own My List, Continue Watching, history, languages and suggestions. Downloads, sources and Settings are shared.
- **Parent PIN** protects Settings and profile changes.
- **Kids' profiles** have an age limit (up to 7, 12 or 16) and a simpler app. Kids see only titles within their limit and get a single **Play** button: FreeStream picks a checked source itself (never a theater copy). There are no source lists, downloads or settings.

> **Note on the kids' filter:** content filtering is based on **metadata, not on the content itself**. FreeStream uses the age ratings and certificates listed on TMDB: the strictest rating among India, the US, the UK, New Zealand, Australia, Canada and Ireland. Titles with no rating are hidden. Nothing reviews the actual video, so a wrong or missing rating on TMDB leads to a wrong result, and torrents can be mislabelled. Treat it as a helpful filter, not a guarantee, and supervise younger children.

### Suggestions
- **Every night at 3am** (local time), each profile gets these rows on Home:
  - "Top picks for {name}"
  - "Because you watched …"
  - 2–3 themed rows
  - "Coming soon for you"

  Title pages also get **More like this**.
- **How they're chosen:** suggestions come from what the profile finished, is watching and has in My List.
  - Recent viewing counts more, and films stopped early count against their genres.
  - **Candidates are real TMDB titles:** recommendations for liked titles, more from favourite actors and directors, top-rated titles in favourite genres and languages, and new releases.
- **AI (optional)** picks the best of the top 40, writes a one-line reason ("Suggested for you: …") and names the themed rows.
  - It can only answer with numbers from the candidate list, so it can't invent titles.
  - A reason that mentions a title the viewer never watched is replaced with a plain one.
  - Without AI, scoring alone is used.
- **Not interested** on a suggested title keeps it out of future suggestions.

## Requirements

- **One computer that stays on while you watch.** It was built on macOS (Apple Silicon); it should also run on Linux through Docker.
- **Node.js 22+**, or Docker Desktop.
- **A free TMDB API key:** [themoviedb.org](https://www.themoviedb.org/settings/api) → Settings → API. Either the "API Key" or the "API Read Access Token" works.
- **Prowlarr or Jackett**, with the indexers you choose to add. The Docker setup includes Prowlarr.
- **Optional:** ffmpeg (for the runtime probe; included in the Docker image) and Ollama (for local AI checks and suggestions).

## Quick start (Docker)

With Docker Desktop running:

```sh
cp .env.example .env     # optional: set TZ and API keys here, or later in Settings
npm run docker:up        # = docker compose up -d --build
```

This starts FreeStream and Prowlarr. Both restart automatically whenever Docker starts.

1. **Prowlarr:** open http://localhost:9696, add indexers, and copy the API key (Settings → General).
2. **FreeStream:** open `http://<this computer's IP>:8080`; on a Mac, `ipconfig getifaddr en0` prints the IP. In **Settings**, add the TMDB key and the Prowlarr API key, set the Prowlarr URL to **`http://prowlarr:9696`** (the container name, not localhost), and press **Test connection**.
3. **Optional AI:** install Ollama on the host, run `ollama pull gemma4:e2b`, and keep `ollama serve` running. The container reaches it at `host.docker.internal:11434`.

Also good to know:
- **State** lives in `./data` (Prowlarr's config in `./data/prowlarr`). Downloads go to `~/Movies/FreeStream`.
- **Cloudflare-protected indexers:** run `docker compose --profile flaresolverr up -d`, then in Prowlarr go to Settings → Indexers and add a FlareSolverr proxy at `http://flaresolverr:8191`.
- **Logs:** `npm run docker:logs`. **Stop:** `npm run docker:down`.
- **Sleep:** Docker doesn't keep the Mac awake. Prevent sleep in System Settings, or run `caffeinate -s` while watching.

## Setup without Docker

```sh
npm install
cp .env.example .env   # optional: everything can also be set on the Settings page
npm start              # builds the web app, starts the server, keeps the Mac awake
```

Install Prowlarr or Jackett yourself and use `http://localhost:9696` (Prowlarr) or `http://localhost:9117` (Jackett) as the indexer URL. If macOS asks whether `node` may accept incoming connections, click **Allow**, or other devices can't reach it.

## Watching on an LG TV

**Quickest:** open the TV's web browser and go to `http://<computer IP>:8080`.

**As an app on the TV's home screen** (needs Developer Mode once):

1. **Developer Mode:**
   - Create a free account at [webostv.developer.lge.com](https://webostv.developer.lge.com).
   - On the TV, install **Developer Mode** from the LG Content Store and sign in.
   - Turn **Dev Mode Status** on (the TV restarts), then turn **Key Server** on.
2. Register the TV, using the IP shown in the Developer Mode app:
   ```sh
   npx -p @webos-tools/cli ares-setup-device -a tv -i "host=<TV-IP>" -i "port=9922" -i "username=prisoner"
   npx -p @webos-tools/cli ares-novacom --device tv --getkey   # enter the passphrase shown on the TV
   ```
3. Build and install:
   ```sh
   npm run webos:package                 # uses this Mac's Wi-Fi IP and the PORT from .env
   # or: ./webos/package.sh http://<ip>:8080
   npm run webos:install
   ```

The TV app is a small launcher: it checks that the server is reachable, then opens the web app full screen. App updates therefore don't need a reinstall, only a new IP does, so reserve the computer's IP in your router. Developer Mode expires after about 50 hours unless you press **Extend** in the Developer Mode app.

| Where | Remote keys |
| --- | --- |
| Everywhere | Arrows move, **OK** selects, **Back** goes back |
| Player | ◀ ▶ seek 10 s · **OK** play/pause · ▼ shows buttons (subtitles, next episode) · ⏩ ⏪ seek 30 s · ⏹ exit |
| Source list | ▶ moves to **Preview** |

## Configuration

Everything can be set on the **Settings** page; values saved there take precedence over `.env`. See [`.env.example`](.env.example) for all variables.

| Variable | What it does |
| --- | --- |
| `PORT` | Port the app listens on (default `8080`). |
| `TMDB_API_KEY` | TMDB v3 API key or v4 read token. |
| `INDEXER_TYPE`, `INDEXER_URL`, `INDEXER_API_KEY` | Prowlarr or Jackett connection. |
| `DOWNLOAD_DIR`, `CACHE_LIMIT_GB` | Where downloads go, and how much space they may use before the oldest are cleared (kept downloads are never cleared). |
| `DATA_DIR` | Where settings, profiles and history are stored (default `./data`). |
| `TZ` | Time zone for the nightly suggestions, e.g. `Europe/London`. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Local AI (defaults `http://localhost:11434`, `gemma4:e2b`). |
| `AI_MODE`, `AI_REMOTE_PROVIDER`, `AI_REMOTE_API_KEY`, `AI_REMOTE_MODEL` | AI checks: `off`, `local`, `remote` or `local+remote`, and the remote provider. |

## Security and privacy

- **For your home network only.** There are no user accounts, and the API has no login. Don't expose port 8080 to the internet or forward it on your router. For access away from home, use a VPN to your home network (for example Tailscale or WireGuard).
- **The parent PIN keeps kids out of Settings. It isn't strong security.** It's hashed and salted, and repeated wrong guesses lock it for a while. But anyone who can reach the server can still read `data/db.json` on the computer.
- **Secrets stay local.** API keys entered in Settings are stored in plain text in `data/db.json` on the computer running FreeStream. `.env`, `data/` and the generated TV config are excluded by `.gitignore`, so never commit them. Use `.env.example` as the template.
- **What leaves your network:** catalog lookups to TMDB, searches to your indexers, torrent traffic, and, only if you choose a remote AI provider, source-check and suggestion prompts sent to that provider. With local AI (the default), the AI steps stay on your computer.
- **Torrenting exposes your IP address** to other peers. Upload is off by default (download-only), but peers still see your IP. Consider a VPN if that matters where you live.

## If something won't play

Streaming sends the raw file to the browser; nothing is converted. The badges on each source predict this:

- **Plays well:** H.264 video with AAC audio plays almost everywhere. With AC3 audio it plays on TVs and in Safari.
- **Likely plays:** HEVC/x265 or HDR is fine on LG TVs and Safari, and usually in Chrome on a Mac.
- **May not play:** DTS/TrueHD audio, AV1 and Remux files often fail or play without sound. Dolby (AC3/E-AC3) audio doesn't play in Chrome or Firefox on a computer.

Use **Preview** to check before watching. In the player, **Choose another source** forgets the bad one and reopens the list.

## Development

```sh
npm run dev        # API on :8080 + Vite dev server on :5173 (reachable from other devices too)
npm run typecheck
```

| Folder | Contents |
| --- | --- |
| `server/` | Express + WebTorrent, TypeScript run with `tsx`. State lives in `data/db.json`. Main modules: `tmdb.ts` (catalog), `indexers.ts` and `pick.ts` (source search and ranking), `torrents.ts` (streaming and downloads), `verify.ts` and `llm.ts` (source checks), `watcher.ts` (background Watching), `suggest.ts` (suggestions), `profiles.ts` (profiles, PIN, age limits). |
| `server/scripts/` | `ai-bench.ts` benchmarks local models on labelled source checks; `suggest-try.ts` prints a profile's suggestions; `suggest-grounding.ts` tests the check on AI-written reasons. |
| `web/` | React + Vite. Built for Chromium 68 (`@vitejs/plugin-legacy`), so the CSS avoids flex `gap`, `inset`, `aspect-ratio` and `clamp()`. Spatial navigation for TV remotes uses `@noriginmedia/norigin-spatial-navigation`. |
| `webos/` | The LG TV launcher app and its packaging scripts. |
