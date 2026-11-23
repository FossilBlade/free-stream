# FreeStream

A self-hosted, Netflix-style streaming app for your home network. It plays movies and shows straight from torrents while they download, so there's nothing to wait for and no media library to manage. It runs on one computer (built and tested on an Apple Silicon Mac), and everyone in the house watches from a browser on the same Wi-Fi or from a small LG webOS TV app.

Written in TypeScript: React + Vite on the front end, Express + WebTorrent on the server.

> **Legal note:** FreeStream is a player and organiser. It doesn't host, index or ship any content, and it only uses the indexers you add yourself. Only stream content you have the right to watch. You are responsible for following the law where you live.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start (Docker)](#quick-start-docker)
- [Setup without Docker](#setup-without-docker)
- [Cloudflare-protected indexers](#cloudflare-protected-indexers)
- [Watching on an LG TV](#watching-on-an-lg-tv)
- [Configuration](#configuration)
- [Health check](#health-check)
- [Security and privacy](#security-and-privacy)
- [If something won't play](#if-something-wont-play)
- [Development](#development)

## Features

### Browse and watch
- **Catalog from TMDB:** trending, popular, new releases, genres, seasons and episodes, cast, trailers and age ratings.
- **Netflix-style interface** with its own teal-and-amber theme, built for the TV remote: arrow keys, OK and Back everywhere, LG Magic Remote pointer support, and media keys in the player. It runs on old TV browsers (LG webOS 5, Chromium 68). On phones the main sections move to a bottom tab bar.
- **Streams while downloading** (WebTorrent). Seeking jumps ahead in the download. In season packs, each episode picks its own file.
- **Live conversion with ffmpeg** when a device can't play a file directly, most often Dolby or DTS audio in Chrome (see [If something won't play](#if-something-wont-play)).
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

This starts FreeStream, Prowlarr and FlareSolverr (for [Cloudflare-protected indexers](#cloudflare-protected-indexers)). All three restart automatically whenever Docker starts.

1. **Prowlarr:** open http://localhost:9696, add indexers (see [Starting indexers](#starting-indexers)), and copy the API key (Settings → General).
2. **FreeStream:** open `http://<this computer's IP>:8080`; on a Mac, `ipconfig getifaddr en0` prints the IP. In **Settings**, add the TMDB key and the Prowlarr API key, set the Prowlarr URL to **`http://prowlarr:9696`** (the container name, not localhost), and press **Test connection**.
3. **Optional AI:** install Ollama on the host, run `ollama pull gemma4:e2b`, and keep `ollama serve` running. The container reaches it at `host.docker.internal:11434`.

### Starting indexers

These public indexers need no account and work well together. In Prowlarr, go to **Indexers → Add Indexer**, search for each name, and save it with the default settings:

| Indexer | Good for |
| --- | --- |
| **YTS** | Movies: small, good-quality H.264 encodes that play almost everywhere. |
| **The Pirate Bay** | Movies and shows; the widest selection, including Indian releases. |
| **LimeTorrents** | Movies and shows; a useful second source for shows. |

Skip **Internet Archive**. It mostly times out, and its results are rarely full films. (FreeStream gives each indexer 25 seconds and carries on without slow ones, but that makes every search take the full 25 seconds.) Indexers behind Cloudflare, such as 1337x, need one extra setting: see [Cloudflare-protected indexers](#cloudflare-protected-indexers).

Also good to know:
- **State** lives in `./data` (Prowlarr's config in `./data/prowlarr`). Downloads go to `~/Movies/FreeStream`.
- **Logs:** `npm run docker:logs`. **Stop:** `npm run docker:down`.
- **Sleep:** Docker doesn't keep the Mac awake. Prevent sleep in System Settings, or run `caffeinate -s` while watching.

## Setup without Docker

```sh
npm install
cp .env.example .env   # optional: everything can also be set on the Settings page
npm start              # builds the web app, starts the server, keeps the Mac awake
```

Install Prowlarr or Jackett yourself, add the [starting indexers](#starting-indexers), and use `http://localhost:9696` (Prowlarr) or `http://localhost:9117` (Jackett) as the indexer URL. If macOS asks whether `node` may accept incoming connections, click **Allow**, or other devices can't reach it.

## Cloudflare-protected indexers

Some indexers (1337x, for example) sit behind Cloudflare's "checking your browser" page, so Prowlarr's searches come back blocked. [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) fixes that: it opens the page in a headless Chrome, waits out the check, and hands the cookies back. Prowlarr reuses those cookies, so the slow browser step only happens now and then.

### 1. Run FlareSolverr

**With Docker (the Quick start):** it's already running as the `flaresolverr` container. Prowlarr reaches it at `http://flaresolverr:8191`. Its port is open to this computer only, not the rest of the network.

**Without Docker:** pick one, then check it answers at http://localhost:8191 ("FlareSolverr is ready!").

- **Just this one container** (if you have Docker but run FreeStream with `npm start`):
  ```sh
  docker compose up -d flaresolverr
  # or, outside this repo:
  docker run -d --name flaresolverr --restart unless-stopped -p 127.0.0.1:8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
  ```
- **Windows or Linux (x64):** download the build for your system from [FlareSolverr's releases](https://github.com/FlareSolverr/FlareSolverr/releases), unpack it, and run `flaresolverr`. It includes its own Chrome.
- **macOS, or anywhere from source:** install Google Chrome and Python 3, then:
  ```sh
  git clone https://github.com/FlareSolverr/FlareSolverr.git && cd FlareSolverr
  python3 -m venv .venv && . .venv/bin/activate
  pip install -r requirements.txt
  python src/flaresolverr.py
  ```
  Keep it running while you use FreeStream; FlareSolverr's README lists the Python versions it supports.

### 2. Point Prowlarr (or Jackett) at it

**Prowlarr:**
1. **Settings → Indexers → Indexer Proxies → +** and choose **FlareSolverr**.
2. **Tags:** `flaresolverr`. **Host:** `http://flaresolverr:8191` with Docker, or `http://localhost:8191` without. Leave the timeout at 60 seconds.
3. Press **Test**, then **Save**.
4. Open each Cloudflare-protected indexer (**Indexers** → the indexer → edit), add the tag `flaresolverr`, and save. Prowlarr marks these as blocked by Cloudflare when you test them, and under **System → Status**.

Only indexers with the tag go through FlareSolverr; the rest connect directly as before.

**Jackett:** on the dashboard, set **FlareSolverr API URL** to `http://localhost:8191` and press **Apply server settings**. Jackett uses it for any indexer that hits a Cloudflare check.

### Good to know

- The first search on a protected indexer takes 5–20 seconds longer while the check is passed.
- It gets past Cloudflare's automatic check, not sites that ask you to solve a CAPTCHA.
- FlareSolverr can break for a while when Cloudflare changes its checks. [Byparr](https://github.com/ThePhaseless/Byparr) is a drop-in replacement: same port, same Prowlarr setting. In `docker-compose.yml`, swap the image for `ghcr.io/thephaseless/byparr:latest`.
- Headless Chrome uses roughly 200–500 MB of memory while it works.

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

## Health check

Settings opens with a **Health check** that tests every part of the setup and says what to fix:
- App data folder
- TMDB key
- Prowlarr or Jackett, plus indexers that keep failing or that Prowlarr has paused
- ffmpeg
- Ollama and the AI model, or a remote AI key
- Disk space and the cache limit
- Time zone
- Parent PIN (when there are kids' profiles)
- Suggestions

It runs every 6 hours in the background. If something fails, a red dot appears on the Settings icon for adults.

From a terminal:

```sh
npm run doctor                        # when running with npm start
docker exec freestream npm run doctor # with Docker
```

Each line prints `OK`, `WARN` or `FAIL`, with a fix under each problem. The command exits with code 1 if anything fails. It only reads; it never changes settings. Remote AI providers are only checked for a key, so it never costs anything.

## Security and privacy

- **For your home network only.** There are no user accounts, and the API has no login. Don't expose port 8080 to the internet or forward it on your router. For access away from home, use a VPN to your home network (for example Tailscale or WireGuard).
- **The parent PIN keeps kids out of Settings. It isn't strong security.** It's hashed and salted, and repeated wrong guesses lock it for a while. But anyone who can reach the server can still read `data/db.json` on the computer.
- **Secrets stay local.** API keys entered in Settings are stored in plain text in `data/db.json` on the computer running FreeStream. `.env`, `data/` and the generated TV config are excluded by `.gitignore`, so never commit them. Use `.env.example` as the template.
- **What leaves your network:** catalog lookups to TMDB, searches to your indexers, torrent traffic, and, only if you choose a remote AI provider, source-check and suggestion prompts sent to that provider. With local AI (the default), the AI steps stay on your computer.
- **Torrenting exposes your IP address** to other peers. Upload is off by default (download-only), but peers still see your IP. Consider a VPN if that matters where you live.

## If something won't play

FreeStream sends the raw file when the device can play it. When it can't, it converts the file live with ffmpeg (included in the Docker image; install it yourself with `npm start`):

- **Before playing**, the player reads the file's real codecs and compares them with what this device can decode.
- **Audio it can't play** (Dolby AC3/E-AC3 in Chrome or Firefox on a computer or phone, DTS or TrueHD anywhere) is converted to AAC, and the video is passed through untouched. This is cheap and starts in a second or two. The player shows "Converting … audio for this device".
- **Video it can't decode** (for example HEVC or AV1 without a decoder, or XviD) is re-encoded to H.264. This uses a lot of the server's CPU, and on a Mac Docker can't use hardware encoding, so prefer a source marked "Plays well" when there is one.
- **Seeking** in a converted stream restarts the conversion at the new position. Subtitles shift to match.
- **If playback fails anyway**, the player retries with conversion before showing an error.

On the source list, the badges predict this:
- **Audio converted here:** fine; the audio is converted while you watch.
- **May not play here:** AV1, XviD or Remux files, or anything that needs conversion when ffmpeg isn't installed.

Use **Preview** to check a source before watching. In the player, **Choose another source** forgets the bad one and reopens the list.

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
