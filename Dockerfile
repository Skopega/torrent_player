# syntax=docker/dockerfile:1

# ============================================================================
# Stage 1: build (TypeScript server + Vite web)
# ============================================================================
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Root manifest + lockfile, workspace manifests, and patch-package patches first
# so dependency install is cached separately from source changes.
COPY package.json package-lock.json ./
COPY patches ./patches
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

# postinstall (patch-package) applies patches/bittorrent-tracker+11.2.3.patch
RUN npm ci --no-audit --no-fund

# Full source, then build server (tsc) and web (vite).
COPY server ./server
COPY web ./web

RUN npm run build

# Keep only production dependencies in the final image.
RUN npm prune --omit=dev

# ============================================================================
# Stage 2: runtime
# ============================================================================
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Europe/Moscow

# Enable Debian "non-free" (needed for the Intel iHD VAAPI driver -> QSV).
RUN sed -i 's/Components: main/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      xvfb \
      tini \
      procps \
      intel-media-va-driver-non-free \
      libva2 \
      libva-drm2 \
      libva-x11-2 \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome (pre-downloaded .deb). Provides the real Chrome for Cloudflare bypass.
# Installed with full recommended deps so all Chrome runtime libraries are present.
COPY docker/bin/chrome/google-chrome-stable_current_amd64.deb /tmp/google-chrome.deb
RUN apt-get update \
 && apt-get install -y /tmp/google-chrome.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/google-chrome.deb

# Pre-downloaded ffmpeg/ffprobe (BtbN static build with QSV) and xray-core (vless).
COPY docker/bin/ffmpeg/ffmpeg /opt/ffmpeg/ffmpeg
COPY docker/bin/ffmpeg/ffprobe /opt/ffmpeg/ffprobe
COPY docker/bin/xray/xray /opt/xray/xray
RUN chmod +x /opt/ffmpeg/ffmpeg /opt/ffmpeg/ffprobe /opt/xray/xray

# Application: pruned node_modules + built server + built web frontend.
# server/package.json carries "type": "module" — required for Node to run the ESM dist.
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# Supervisor (watchdog) script.
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

# Explicit paths (xrayBinPath() is DATA_DIR-relative and would break with TP_DATA_DIR=/data).
ENV TP_DATA_DIR=/data \
    TP_WEB_DIST=/app/web/dist \
    FFMPEG_PATH=/opt/ffmpeg/ffmpeg \
    FFPROBE_PATH=/opt/ffmpeg/ffprobe \
    XRAY_BIN=/opt/xray/xray \
    RUTRACKER_HEADED=1

RUN mkdir -p /data

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
