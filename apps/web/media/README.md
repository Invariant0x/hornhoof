# README Media Renderer

This folder renders the animated GIFs in `.github/assets/` using the real `@hornhoof/web` app running on Vite (`--mode browser-test`) in Chromium, with `/api/*`, `EventSource('/api/stream')`, and terminal WebSockets mocked inside the page.

It stays isolated from normal `vitest` and `playwright test` runs so unit and browser suites never pick these scenes up.

## Prerequisites

- Docker (`mcr.microsoft.com/playwright:v1.64.1-noble` is pulled automatically on the first run)
- `ffmpeg` and `ffprobe` on your host `PATH`

Linux `node_modules` are installed inside a dedicated Docker volume (`hornhoof-media-work`), so macOS binaries on the host are untouched and the repository is mounted read-only inside the container.

## Running

Render every scene and write the outputs to `.github/assets/`:

```sh
npm --prefix apps/web run media
```

Render a single scene while iterating on data or timing:

```sh
npm --prefix apps/web run media -- tree.spec.ts
```

Keep intermediate `.webm` videos and `.json` timing marks under `apps/web/media/results/` for inspection:

```sh
KEEP_MEDIA_RESULTS=1 npm --prefix apps/web run media
```

### On GitHub

`.github/workflows/media.yml` renders the scenes for a push to any `media-*` branch and keeps the new GIFs as the `media-gifs` artifact, and the videos, marks, failure shots and log as `media-results`. Where the repository variables `BUILD_RUNS_ON` and `BUILDKIT_ENDPOINT` name our own runner and its BuildKit, the scenes run in a build of `apps/web/media/Dockerfile` there, as that runner has no Docker daemon; otherwise a GitHub machine runs `run.sh` with Docker. Download the GIFs with `gh run download <run> -n media-gifs`, look at their frames, and commit the ones you want into `.github/assets/`.

`run.sh` also runs inside the Playwright image itself with `MEDIA_IN_CONTAINER=1`, and writes the GIFs to `MEDIA_ASSETS_DIR` when it is set.

### Marketing cuts

A scene named `marketing-*` is a cut for posts, 10 to 30 s, recorded at the size the network shows so nothing is scaled down afterwards. `scenes/marketing-map.spec.ts` records two: `marketing-map-linkedin` at 1080x1350 (4:5, the phone layout at 600x750 and scale 1.8) and `marketing-map-x` at 1920x1080 (16:9, 1280x720 at scale 1.5), with a pointer drawn by `moonfern/cursor.ts`. For each, `run.sh` writes a GIF at that size (up to 15 MB) and an H.264 MP4 (yuv420p, BT.709, CRF 16, `+faststart`) to `MEDIA_VIDEOS_DIR` (by default `results/marketing`, kept with `KEEP_MEDIA_RESULTS=1`), with `ffprobe.txt` and six frames of each MP4 in `frames/`. On GitHub they are the `media-videos` artifact. `MEDIA_STILLS=<dir>` makes the scene save screenshots at each step, to check a cut by eye where no ffmpeg is at hand. A failed scene no longer stops the others from being converted; the run still fails at the end.

Typecheck all media data files and scene specs against `apps/web/src/types.ts`:

```sh
npx tsc -p apps/web/media/tsconfig.json --noEmit
```

## Changing the Data

All fixtures are strongly typed against `apps/web/src/types.ts` and `@hornhoof/protocol`:

- `moonfern/people.ts`: Moonfern's three members (Maya Chen, Leo Park, Sam Rivera) and their department access.
- `moonfern/plans.ts`: The seven AI subscriptions, utilization windows, and reset timestamps (`subscriptions.gif`).
- `moonfern/machines.ts`: All ten machines, CPU/memory/disk load, active test-run parts, and connection history (`machines.gif`). A runtime check verifies that the pool totals equal 10 machines, 112 cores, and 296 GB of RAM.
- `moonfern/agents.ts`: Five departments, employees, models, and live "doing" lines (`map.gif`, `build.gif`, `development.gif`, `terminal.gif`, `machines.gif`, `subscriptions.gif`).
- `moonfern/tasks.ts`: Turn 6 ("Launch the iOS beta", 40 tasks, 24 done), later tasks and the camera flow's subtasks, the company goals with their smaller goals (`goals.gif`), the people who answer for each department, the pipeline "Beta build way" (`board.gif`), the three waiting requests (`tasks.gif`), and the history of #237 with thirty one-shot calls and a judge call (`calls.gif`).
- `moonfern/route.ts`: A task's route at a stage, for tasks on the map and in the tree.
- `moonfern/tracker-scene.ts`: Helpers of the tracker scenes: pick a view, scroll smoothly, and print the `/api` paths no mock answered.
- `moonfern/images.ts`: Three SVG onboarding card variants served from `/api/attachments/*` for the designer's choice card.
- `moonfern/tree.ts` and `moonfern/tree-clock.ts`: Sequence of `DepartmentTree` snapshots for Turn 6 (`tree.gif` and `speed.gif`), advancing the clock so idle and blocked developers move forward, tasks merge into `turn-6`, and multi-maker turn review verdicts appear.
- `moonfern/oak-lane.ts`: Complete dataset for the Oak Lane home company (`home.gif`).
- `moonfern/serve.ts` and `moonfern/stream.ts`: Page-level `/api/*` router, stateful mutations (approvals, builds, snapshots), `pushStream(page, msg)` for `EventSource('/api/stream')` pulses and live counts, and `triggerPoll(page)` for 5-second live polling updates on `Machines` and `Subscriptions`.

## Replacing `moonfern/terminal.rec`

`moonfern/terminal.rec` drives `AgentTerminal` over a mocked `/api/agents/<id>/terminal` WebSocket in `scenes/terminal.spec.ts`.

Format: one chunk per line:

```text
<ms since start> <base64-encoded UTF-8/ANSI bytes>
```

Lines starting with `#` or blank lines are ignored. Keep the total span around 6 to 7 seconds so the full session plays comfortably inside `terminal.gif` (6 to 12 s total).

To encode a line from Node:

```sh
node -e 'console.log(0, Buffer.from("moonfern$ npm test\r\n").toString("base64"))'
```

## Adjusting Scenes

Each file in `scenes/*.spec.ts` produces one animated GIF in `.github/assets/` (no static PNGs are emitted):

- Every scene calls `createSceneRecorder(page)` (`moonfern/record.ts`), calls `await recorder.markReady()` once the initial screen and fonts have settled (trimming initial page load frames), restores its opening state at the end so the loop closes cleanly, and finishes with `await recorder.finishGif('<name>')`.
- `run.sh` removes any stale `machines.png` or `subscriptions.png`, converts each video with `ffmpeg` from `mark.startSec` for `mark.durationSec` at 12 fps, width 1200 (`1200x750`), temporal denoise (`atadenoise`), `palettegen=stats_mode=diff` (stepping `max_colors` down from 64 through 48, 32, 24, 16 if needed), and `paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle` (`-loop 0`), and checks that every GIF is under 6 MB (`8..10 s` for `machines.gif` and `subscriptions.gif`, `6..12 s` for the other scenes).
- `skins.spec.ts` adds a skin from a file made from the Cyberpunk sample, the way the guide "Your own skin in a minute" says.
