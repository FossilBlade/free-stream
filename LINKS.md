# Links

Addresses for every part of FreeStream when it runs with `docker compose up -d` on the Mac.

- Use `http://mac.local:…` from a phone, the TV or another computer on the same Wi-Fi.
- Use `http://localhost:…` on the Mac itself.
- If `mac.local` doesn't open on a device, use the Mac's IP address instead (System Settings → Wi-Fi → Details).

## Services

| Component | From other devices | On the Mac | What it is |
|---|---|---|---|
| FreeStream | http://mac.local:8080 | http://localhost:8080 | The app: browse, play, download |
| Prowlarr | http://mac.local:9696 | http://localhost:9696 | Finds torrents; add and manage indexers here |
| FlareSolverr | (Mac only) | http://localhost:8191 | Gets Prowlarr past Cloudflare checks. Prowlarr uses it at `http://flaresolverr:8191` |
| Ollama | (Mac only) | http://localhost:11434 | Local AI for suggestions. Runs on the Mac, outside Docker |

Torrent traffic uses port 51413 (TCP and UDP). It has no web page.

## FreeStream pages

| Page | Link |
|---|---|
| Home | http://mac.local:8080/ |
| Shows | http://mac.local:8080/shows |
| Movies | http://mac.local:8080/movies |
| My List | http://mac.local:8080/my-list |
| Search | http://mac.local:8080/search |
| Downloads | http://mac.local:8080/downloads |
| Watching (followed shows) | http://mac.local:8080/watching |
| Who's watching | http://mac.local:8080/profiles |
| Manage profiles | http://mac.local:8080/profiles/manage |
| Settings | http://mac.local:8080/settings |
| A title | `http://mac.local:8080/title/tv/<tmdb id>` or `/title/movie/<tmdb id>` |

## Health checks

| Check | Link |
|---|---|
| FreeStream status | http://mac.local:8080/api/status |
| FlareSolverr ready | http://localhost:8191 (should say "FlareSolverr is ready!") |
| Ollama running | http://localhost:11434 (should say "Ollama is running") |

## Outside services

| Service | Link |
|---|---|
| Source code | https://github.com/FossilBlade/free-stream |
| TMDB API key (for the catalog) | https://www.themoviedb.org/settings/api |
