# syntax=docker/dockerfile:1
# Renders the README's animated pictures where a BuildKit is at hand but no Docker daemon, as on the repository's own
# runner. The scenes run in the Playwright image run.sh uses, and the last stage holds only what came out: the new GIFs
# in gifs/, the marketing cuts as GIF and MP4 in videos/, the videos, marks and failure shots in results/, the log, and
# the exit status of run.sh. A failed scene fails no build, so its shot can be looked at.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS render
RUN apt-get update -q && apt-get install -y -q --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . .
RUN npm ci --no-audit --no-fund
ARG SCENES=""
RUN mkdir -p /out/gifs /out/videos \
  && (MEDIA_IN_CONTAINER=1 MEDIA_ASSETS_DIR=/out/gifs MEDIA_VIDEOS_DIR=/out/videos KEEP_MEDIA_RESULTS=1 sh apps/web/media/run.sh $SCENES > /out/render.log 2>&1; echo $? > /out/status) \
  && cp -R apps/web/media/results /out/results 2>/dev/null || true

FROM scratch
COPY --from=render /out/ /
