# syntax=docker/dockerfile:1
# Every step that runs Node runs on the builder's own platform: what it makes is plain JavaScript, and Node under the
# emulation that builds the other platform crashes. The image itself only copies. Base images are pinned by digest, so a
# build starts from the images it was tested with; the tag says which release that is.
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @hornhoof/protocol && npm run build -w @hornhoof/server -w @hornhoof/web

# The server's production modules: they install on the builder's platform, with prebuilt binaries picked for the target CPU.
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS deps
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
RUN cpu="$(case "${TARGETARCH:-}" in amd64) echo x64 ;; '') node -p process.arch ;; *) echo "$TARGETARCH" ;; esac)" \
  && npm ci --omit=dev --cpu="$cpu" --workspace apps/server --workspace packages/protocol && npm cache clean --force && mkdir /control

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app /app
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/drizzle apps/server/drizzle
COPY scripts/install.sh scripts/install.sh
COPY templates templates
# The updater takes the installer and the compose file of the build it moves to from this image.
COPY compose.yaml compose.yaml
COPY --from=build /app/apps/web/dist apps/web/dist
# The tunnel container runs this image too, and frpc carries the company's public link from hornhoof.org to the app.
# It is the client the relay is built for, taken from its own image.
COPY --from=fatedier/frpc:v0.71.1@sha256:7a0a18bc9c83dc106a7e5213a890f521affdf90d595829c56b0ed8481377d50e /usr/bin/frpc /usr/local/bin/frpc
# The build this image is: CI passes the product version and the commit, and the node build the server's nodes should
# be, which the node image of this commit carries too.
ARG HORNHOOF_VERSION=
ARG HORNHOOF_COMMIT=
ARG HORNHOOF_NODE_BUILD=
ENV HORNHOOF_VERSION=$HORNHOOF_VERSION HORNHOOF_COMMIT=$HORNHOOF_COMMIT HORNHOOF_NODE_BUILD=$HORNHOOF_NODE_BUILD
# The folder the app shares with the updater; a new volume takes this owner.
COPY --from=deps --chown=node:node /control /control
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
