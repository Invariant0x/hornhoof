#!/bin/sh
set -eu

MEDIA_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$MEDIA_DIR/../../.." && pwd)"
RESULTS_DIR="$MEDIA_DIR/results"
# MEDIA_ASSETS_DIR sends the pictures elsewhere, as the render in apps/web/media/Dockerfile does.
ASSETS_DIR="${MEDIA_ASSETS_DIR:-$REPO_ROOT/.github/assets}"
DOCKER_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"
DOCKER_VOLUME="hornhoof-media-work"

# MEDIA_IN_CONTAINER=1: this already is the Playwright image with the repository installed, as in
# apps/web/media/Dockerfile, so the scenes run here and no Docker is needed.
IN_CONTAINER="${MEDIA_IN_CONTAINER:-0}"

if [ "$IN_CONTAINER" != "1" ] && ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required to run media scenes ($DOCKER_IMAGE)" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg is required to convert scene videos into GIFs" >&2
  exit 1
fi

rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR" "$ASSETS_DIR"

# A scene that fails leaves the others to be converted; the run still fails at the end.
render_status=0
if [ "$IN_CONTAINER" = "1" ]; then
  echo "==> Rendering scenes in this container..."
  (
    cd "$REPO_ROOT"
    npm run build -w @hornhoof/protocol
    npx --prefix apps/web playwright test -c apps/web/media/playwright.media.config.ts "$@"
  ) || render_status=$?
else
echo "==> Rendering scenes in Docker ($DOCKER_IMAGE)..."
docker run --rm --ipc=host \
  -v "$REPO_ROOT:/src:ro" \
  -v "$RESULTS_DIR:/results" \
  -v "$DOCKER_VOLUME:/work" \
  "$DOCKER_IMAGE" \
  bash -lc '
    set -euo pipefail
    mkdir -p /work
    rm -rf \
      /work/apps/web/src \
      /work/apps/web/media \
      /work/apps/web/e2e \
      /work/packages/protocol/src \
      /work/templates
    tar -C /src \
      --exclude="./.git" \
      --exclude="node_modules" \
      --exclude="./apps/web/media/results" \
      --exclude="./.github/assets" \
      -cf - . | tar -C /work -xf -

    cd /work
    LOCK_HASH="$(sha256sum package-lock.json | awk "{print \$1}")"
    SAVED_HASH=""
    if [ -f node_modules/.lock-sha256 ]; then
      SAVED_HASH="$(cat node_modules/.lock-sha256)"
    fi
    if [ "$LOCK_HASH" != "$SAVED_HASH" ]; then
      echo "==> Installing Linux dependencies on volume..."
      npm ci
      printf "%s" "$LOCK_HASH" > node_modules/.lock-sha256
    fi

    npm run build -w @hornhoof/protocol
    status=0
    npx --prefix apps/web playwright test -c apps/web/media/playwright.media.config.ts "$@" || status=$?

    # A failed scene still leaves its video, marks and failure shots to look at.
    cp -R /work/apps/web/media/results/. /results/
    exit "$status"
  ' -- "$@" || render_status=$?
fi

echo "==> Converting videos to GIFs in .github/assets/..."

rm -f "$ASSETS_DIR/machines.png" "$ASSETS_DIR/subscriptions.png"

MAX_GIF_BYTES=6000000
check_status=0

for mark in "$RESULTS_DIR"/marks/*.json; do
  [ -e "$mark" ] || continue
  name="$(basename "$mark" .json)"
  webm="$RESULTS_DIR/videos/$name.webm"
  out_gif="$ASSETS_DIR/$name.gif"

  if [ ! -f "$webm" ]; then
    echo "error: missing video $webm for scene $name" >&2
    exit 1
  fi

  webm_dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$webm")"
  trim_args="$(node -e '
    const fs = require("node:fs");
    const mark = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const webmDur = Number(process.argv[2]);
    const start = Math.max(0, mark.startSec);
    const maxAvail = Number.isFinite(webmDur) && webmDur > start ? webmDur - start : mark.durationSec;
    const wantDur = Math.max(1, Math.min(mark.durationSec, maxAvail));
    process.stdout.write(`${start.toFixed(3)} ${wantDur.toFixed(3)}`);
  ' "$mark" "$webm_dur")"

  start_sec="${trim_args% *}"
  dur_sec="${trim_args#* }"

  for max_colors in 64 48 32 24 16; do
    ffmpeg -hide_banner -loglevel error -y \
      -i "$webm" -ss "$start_sec" -t "$dur_sec" \
      -vf "fps=12,scale=1200:-1:flags=lanczos,atadenoise=0a=0.04:0b=0.08:1a=0.04:1b=0.08:2a=0.04:2b=0.08,split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=$max_colors[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
      -loop 0 "$out_gif"
    gif_bytes="$(wc -c < "$out_gif" | tr -d ' ')"
    if [ "$gif_bytes" -lt "$MAX_GIF_BYTES" ]; then
      break
    fi
  done

  gif_dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out_gif")"
  gif_mb="$(node -e 'process.stdout.write((Number(process.argv[1]) / (1024 * 1024)).toFixed(2))' "$gif_bytes")"

  printf "  %-20s %6ss  %6s MiB (%s bytes)\n" "$name.gif" "$gif_dur" "$gif_mb" "$gif_bytes"

  node -e '
    const [name, durStr, bytesStr, maxBytesStr] = process.argv.slice(1);
    const dur = Number(durStr);
    const bytes = Number(bytesStr);
    const maxBytes = Number(maxBytesStr);
    const minDur = name === "machines" || name === "subscriptions" ? 8 : 6;
    const maxDur = name === "machines" || name === "subscriptions" ? 10 : 12;
    if (!(dur >= minDur && dur <= maxDur)) {
      console.error(`error: ${name}.gif duration ${dur}s is outside ${minDur}..${maxDur}s`);
      process.exit(1);
    }
    if (bytes >= maxBytes) {
      console.error(`error: ${name}.gif size ${bytes} bytes exceeds 6 MB limit`);
      process.exit(1);
    }
  ' "$name" "$gif_dur" "$gif_bytes" "$MAX_GIF_BYTES" || check_status=1
done

if [ "${KEEP_MEDIA_RESULTS:-0}" != "1" ]; then
  rm -rf "$RESULTS_DIR"
fi

if [ "$render_status" -ne 0 ] || [ "$check_status" -ne 0 ]; then
  echo "error: a scene failed to render or its GIF is outside its limits" >&2
  exit 1
fi

echo "==> Done. GIF assets written to .github/assets/"
