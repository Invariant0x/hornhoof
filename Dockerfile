# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
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

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/server --workspace packages/protocol && npm cache clean --force
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/drizzle apps/server/drizzle
COPY scripts/install.sh scripts/install.sh
# The updater takes the installer and the compose file of the build it moves to from this image.
COPY compose.yaml compose.yaml
COPY --from=build /app/apps/web/dist apps/web/dist
# The build this image is: CI passes the product version and the commit.
ARG HORNHOOF_VERSION=
ARG HORNHOOF_COMMIT=
ENV HORNHOOF_VERSION=$HORNHOOF_VERSION HORNHOOF_COMMIT=$HORNHOOF_COMMIT
# The folder the app shares with the updater; a new volume takes this owner.
RUN mkdir -p /control && chown node:node /control
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
