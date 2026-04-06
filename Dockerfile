# ─────────────────────────────────────────────────────────────
#  OTUSDT Auto-Lock Bot
#  Minimal Alpine-based Node.js 20 container.
#  Secrets are mounted at /secrets/ as a volume.
# ─────────────────────────────────────────────────────────────

FROM node:20-alpine

# Create a non-root user for the bot to run as.
# UID 1001 avoids collision with node image's existing 'node' user.
RUN addgroup -g 1001 bot && adduser -u 1001 -G bot -s /bin/sh -D bot

WORKDIR /app

# Install production dependencies only. Copy manifests first for
# better layer caching.
COPY --chown=bot:bot package.json ./
COPY --chown=bot:bot package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY --chown=bot:bot index.js ./
COPY --chown=bot:bot config.js ./
COPY --chown=bot:bot src/ ./src/
COPY --chown=bot:bot scripts/ ./scripts/

# Create the data directory for persistent state (lastProcessedBlock)
# and make sure the bot user owns it.
RUN mkdir -p /app/data && chown -R bot:bot /app/data

# Secrets directory is mounted as a volume at runtime.
# We do not copy anything into it; it exists only as a mount point.
RUN mkdir -p /secrets && chown bot:bot /secrets

USER bot

# No health check needed; Coolify supervises the process lifecycle.
# If the bot crashes, Coolify restarts it and catch-up handles missed events.

CMD ["node", "index.js"]
