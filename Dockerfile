# room-server. The backend has no build step: @kan/protocol and @kan/nodes
# export raw src/index.ts, and the server runs under tsx.
FROM node:24-slim

WORKDIR /app

# Dependency layer, invalidated only by a package.json or the lockfile.
# The sibling manifests have to be present even though -w skips installing
# their deps: npm resolves the workspace graph before applying the filter.
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/room-server/package.json apps/room-server/
COPY apps/agent-runner/package.json apps/agent-runner/
COPY packages/protocol/package.json packages/protocol/
COPY packages/nodes/package.json packages/nodes/

# Scoping to the one workspace drops tldraw, Vite and the Tauri CLI: 136M
# instead of 394M. NODE_ENV=production must stay below this line: set it here
# and npm omits devDependencies, which is where tsx lives.
#
# npm 11.19 in this image blocks install scripts, so esbuild's postinstall is
# skipped and warns loudly. That is survivable: the platform binary arrives via
# @esbuild/* optionalDependencies and install.js is only a fallback. Verified by
# running the image, not by reading the warning.
RUN npm ci -w @kan/room-server --include-workspace-root

COPY packages/protocol/src packages/protocol/src
COPY packages/nodes/src packages/nodes/src
COPY apps/room-server/src apps/room-server/src

ENV NODE_ENV=production \
    KAN_DATA_DIR=/data \
    PORT=8787

# The volume is created from this directory, so it inherits the ownership.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
CMD ["npx", "tsx", "apps/room-server/src/main.ts"]
