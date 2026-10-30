# syntax=docker/dockerfile:1
# The node: runs the agent programs (Claude Code, Codex, Kimi Code) for one subscription, or for the company's API keys with --builtin.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/protocol packages/protocol
COPY apps/node apps/node
RUN npm run build -w @hornhoof/protocol && npm run build -w @hornhoof/node

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/*
# A browser for agents: Playwright with Chromium, outside /data and readable by every job user, so require('playwright') works anywhere.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@$PLAYWRIGHT_VERSION \
  && playwright install --with-deps --only-shell chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && npm cache clean --force && rm -rf /var/lib/apt/lists/* /tmp/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/node --workspace packages/protocol && npm cache clean --force
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/node/dist apps/node/dist
# git asks this for a repository's password; the node gives each turn its token in HH_GIT_PASSWORD.
COPY --chmod=755 apps/node/git-askpass /app/git-askpass
RUN mkdir -p /data && chown node:node /data
# Agent programs are installed into /data/tools at first use and keep their sign-in in /data/home.
# Set after npm ci, so nothing root writes during the build lands in /data.
ENV PATH=/data/tools/bin:$PATH HOME=/data/home
ARG HORNHOOF_VERSION=
ARG HORNHOOF_COMMIT=
ENV HORNHOOF_VERSION=$HORNHOOF_VERSION HORNHOOF_COMMIT=$HORNHOOF_COMMIT
# Personal nodes run as node. The built-in node overrides the user to root in compose.yaml, to run each company key as its own user.
USER node
VOLUME /data
ENTRYPOINT ["node", "/app/apps/node/dist/main.js"]
CMD ["run"]
