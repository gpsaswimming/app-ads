# app-ads-api — the Fastify Ads API (DESIGN.md §7).
# Secret-free, environment-agnostic image: every value is injected at runtime via
# ads-api.env. Runs as a non-root user with a container healthcheck on /health.

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install production deps first for better layer caching. sharp ships prebuilt
# linux-musl binaries, so no native toolchain is needed on alpine.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# node:alpine ships an unprivileged `node` user (uid 1000). Drop root.
USER node

EXPOSE 8080

# Busybox wget is present on alpine; fail the check on a non-2xx /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/health || exit 1

CMD ["node", "src/server.js"]
