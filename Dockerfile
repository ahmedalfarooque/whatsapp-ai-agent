# syntax=docker/dockerfile:1
FROM node:20-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native addon (node-gyp) at install time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build \
  && npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root runtime user.
RUN groupadd --system app && useradd --system --gid app --home-dir /app app

# node_modules already contains the compiled better-sqlite3 addon built
# against this same base image, and has been pruned to production deps only.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY knowledge ./knowledge
COPY dashboard ./dashboard

RUN mkdir -p /app/data /app/secrets && chown -R app:app /app

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# CMD as an array (exec form) so Node receives SIGTERM/SIGINT directly for
# graceful shutdown, instead of a shell swallowing the signal.
CMD ["node", "dist/index.js"]
