# Server-side sequence export container (see ../../docs/architecture/server-side-export.md).
#
# Debian (glibc), NOT Alpine: @mediabunny/server -> node-av ships prebuilt
# native bindings (per-platform @seydx/node-av-* packages) and a postinstall
# that downloads an FFmpeg build, both of which target glibc. ca-certificates +
# curl/unzip are needed to install bun and for node-av's download.
#
# Package manager: bun. Runtime: Node (the repo convention — "Node is the
# runtime"), so we `bun run build` (tsc) and launch `node dist/server.js`.
FROM node:22-bookworm-slim

ENV BUN_INSTALL=/usr/local
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.12" \
  && bun --version

# Install deps first for layer caching. `trustedDependencies: [node-av]` lets
# bun run node-av's postinstall (downloads FFmpeg); the matching
# @seydx/node-av-<platform> prebuilt binary installs as an optional dep.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build the TypeScript, then drop devDependencies (tsc/@types) while keeping
# mediabunny + node-av (and its FFmpeg payload) intact.
COPY tsconfig.json ./
COPY src ./src
RUN bun run build && bun install --frozen-lockfile --production

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
