# --- deps ---
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --prod=false

# --- builder ---
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable
# yt-dlp + ffmpeg power the YouTube→soundbite import (web/src/lib/yt-convert.ts).
# yt-dlp comes from upstream, not apk: Alpine's package lags and YouTube's
# frequent extractor/bot-check changes break old versions (cookies stop being
# enough). It's a Python zipapp, so python3 is the only runtime dep. ffmpeg does
# the audio extraction/trimming. Rebuild to pull a newer yt-dlp.
RUN apk add --no-cache ffmpeg python3 \
 && wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Standalone server bundle
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# public/ holds the web manifest + favicons; Next's standalone output does NOT
# bundle public/, so copy it explicitly or those assets 404 at runtime.
COPY --from=builder /app/public ./public

# Source needed for the migration runner at startup
COPY --from=builder /app/src/db ./src/db
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Ensure uploads dir exists at runtime (mount point)
RUN mkdir -p /data_public && chown -R node:node /data_public
USER node

ENV HOSTNAME=0.0.0.0
# PORT is provided by docker-compose (or defaults to 3000 if running the image directly).
ENV PORT=3000

CMD ["sh", "-c", "node node_modules/tsx/dist/cli.mjs src/db/migrate.ts && node server.js"]
