# FreeStream: web UI + API + torrent engine in one container.
FROM node:24-bookworm-slim

WORKDIR /app

# ffmpeg/ffprobe: measure a release's real runtime and grab frames for the AI source check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies first (cached unless a package.json / lockfile changes).
# Install scripts are skipped (the optional uTP/websocket add-ons aren't needed, and
# esbuild/rolldown ship prebuilt platform packages), except node-datachannel: WebTorrent
# loads it on startup, and its script downloads the prebuilt Linux binary.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm rebuild node-datachannel

COPY server server
COPY web web
RUN npm run build -w web

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    TORRENT_PORT=51413

EXPOSE 8080 51413/tcp 51413/udp
WORKDIR /app/server
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
