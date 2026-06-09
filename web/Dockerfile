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
# ffmpeg is required for audio extraction/trimming; both are in Alpine community.
RUN apk add --no-cache yt-dlp ffmpeg
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Standalone server bundle
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

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
