# syntax=docker/dockerfile:1
# The node: runs the agent programs (Claude Code, Codex, Kimi Code) for one subscription, or for the company's API keys with --builtin.
# Every step that runs Node runs on the builder's own platform: what it makes is plain JavaScript or a download for the
# target, and Node under the emulation that builds the other platform crashes. The image itself only copies and runs apt.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
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

# The node's production modules: no native code among them.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/node --workspace packages/protocol && npm cache clean --force

# A browser for agents: Playwright with Chromium's headless shell for the target, and the Debian packages it needs.
# Playwright picks the download by the machine it runs on; the override names the target instead.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS browser
ARG TARGETARCH
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@$PLAYWRIGHT_VERSION && npm cache clean --force
COPY apps/node/browser-packages.cjs /opt/browser-packages.cjs
RUN target="debian12-$(case "$TARGETARCH" in amd64) echo x64 ;; *) echo "$TARGETARCH" ;; esac)" \
  && PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$target" playwright install --only-shell chromium \
  && node /opt/browser-packages.cjs /usr/local/lib/node_modules/playwright/node_modules/playwright-core/lib/coreBundle.js "$target" > /opt/browser-packages \
  && chmod -R a+rX /opt/ms-playwright

FROM node:22-bookworm-slim
COPY --from=browser /opt/browser-packages /opt/browser-packages
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep tmux $(cat /opt/browser-packages) \
  && rm -rf /var/lib/apt/lists/*
# Outside /data and readable by every job user, so require('playwright') works anywhere.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright NODE_PATH=/usr/local/lib/node_modules
COPY --from=browser /opt/ms-playwright /opt/ms-playwright
COPY --from=browser /usr/local/lib/node_modules/playwright /usr/local/lib/node_modules/playwright
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app /app
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/node/dist apps/node/dist
# git asks this for a repository's password; the node gives each turn its token in HH_GIT_PASSWORD.
COPY --chmod=755 apps/node/git-askpass /app/git-askpass
# Agents send screenshots for people with hh-attach; the node gives each turn its address and token.
COPY --chmod=755 apps/node/hh-attach.cjs /usr/local/bin/hh-attach
# Agents run in tmux sessions; their hooks and status line tell the node how a turn goes through hh-hook.
COPY --chmod=755 apps/node/hh-hook.cjs /usr/local/bin/hh-hook
RUN mkdir -p /data && chown node:node /data
# Agent programs are installed into /data/tools at first use and keep their sign-in in /data/home.
# Set last, so nothing the build writes lands in /data.
ENV PATH=/data/tools/bin:$PATH HOME=/data/home
ARG HORNHOOF_VERSION=
ARG HORNHOOF_COMMIT=
ENV HORNHOOF_VERSION=$HORNHOOF_VERSION HORNHOOF_COMMIT=$HORNHOOF_COMMIT
# Personal nodes run as node. The built-in node overrides the user to root in compose.yaml, to run each company key as its own user.
USER node
VOLUME /data
ENTRYPOINT ["node", "/app/apps/node/dist/main.js"]
CMD ["run"]
