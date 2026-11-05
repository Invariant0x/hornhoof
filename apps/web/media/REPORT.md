# README Media Render Report

## Command to Run

From the repository root:

```sh
sh apps/web/media/run.sh
```

Or via npm:

```sh
npm --prefix apps/web run media
```

To re-render a single scene:

```sh
sh apps/web/media/run.sh tree.spec.ts
```

All 11 scenes run inside `mcr.microsoft.com/playwright:v1.64.1-noble` against `vite --mode browser-test` at `1440x900` (`deviceScaleFactor: 2`, locale `en`, timezone `UTC`, `reducedMotion: 'no-preference'`, default light theme) with zero console errors or failed `/api/*` responses, and write animated GIF outputs only (no static PNGs) to `.github/assets/`.

## Rendered Assets

| File | Dimensions | Duration | Size |
| --- | --- | --- | --- |
| `.github/assets/map.gif` | `1200x750` | `9.00 s` | `5.69 MiB` (`5,964,450 B`) |
| `.github/assets/setup.gif` | `1200x750` | `7.50 s` | `4.49 MiB` (`4,705,782 B`) |
| `.github/assets/build.gif` | `1200x750` | `8.41 s` | `5.68 MiB` (`5,952,815 B`) |
| `.github/assets/development.gif` | `1200x750` | `8.50 s` | `4.69 MiB` (`4,913,074 B`) |
| `.github/assets/terminal.gif` | `1200x750` | `8.58 s` | `1.55 MiB` (`1,628,032 B`) |
| `.github/assets/tasks.gif` | `1200x750` | `7.66 s` | `4.83 MiB` (`5,064,077 B`) |
| `.github/assets/machines.gif` | `1200x750` | `8.66 s` | `5.06 MiB` (`5,301,535 B`) |
| `.github/assets/subscriptions.gif` | `1200x750` | `8.75 s` | `4.45 MiB` (`4,664,550 B`) |
| `.github/assets/home.gif` | `1200x750` | `9.75 s` | `5.28 MiB` (`5,534,871 B`) |
| `.github/assets/tree.gif` | `1200x750` | `7.08 s` | `5.17 MiB` (`5,425,363 B`) |
| `.github/assets/speed.gif` | `1200x750` | `9.08 s` | `4.12 MiB` (`4,322,584 B`) |

Static `.github/assets/machines.png` and `.github/assets/subscriptions.png` have been removed; `run.sh` deletes them if present and produces only `.gif` files under `6 MB` (`6,000,000 B`) via the `max_colors` step-down (`64`, `48`, `32`, `24`, `16`).

## Scene-by-Scene Breakdown

### 1. `map.gif` (`scenes/map.spec.ts`, `9.00 s`, `5.69 MiB`)
- **What it shows**: Moonfern's full company map (`96%` zoom) with the orchestrator hub (`24/32` working rising to `26/32` and `27/32` before returning to `24/32` for a clean loop), all five departments (`Operations`, `Development`, `Design`, `Marketing`, `Business development`) with live status cells, Maya Chen (CEO), Leo Park (Marketing and Design), Sam Rivera (Head of Engineering), cyan and amber pulses traveling along traces, and Turn 6 progress (`24 of 40` -> `25 of 40` -> `24 of 40`) under the hub.
- **Could not do / UI constraints**: Long department task titles and `"Business development"` truncate with an ellipsis inside fixed-width map cards, matching the live app's CSS.

### 2. `setup.gif` (`scenes/setup.spec.ts`, `7.50 s`, `4.49 MiB`)
- **What it shows**: The initial company setup flow (`/?code=mf9k2x7p`). Types `"Moonfern"`, confirms `moonfern.hornhoof.org is free.`, scrolls smoothly across the template cards with their mini org charts, selects `Startup` (`15 employees`), clicks `Next` to `"Create your account"` as CEO of Moonfern, and steps cleanly back to the opening state so first and last frames match pixel-for-pixel.
- **Could not do / UI constraints**: None.

### 3. `build.gif` (`scenes/build.spec.ts`, `8.41 s`, `5.68 MiB`)
- **What it shows**: Starts on the centered `Operations` map (`115%` zoom, `1/5 agents working`). Maya opens the orchestrator window, writes `"We are building Moonfern, a plant care app with photo ID and watering reminders."`, receives the four-department structure proposal (`Create departments (2)` initially), visibly ticks `Design` and `Business development` so all four are checked and the button reads `Create departments (4)`, clicks it, shows `.t-done` reading `Created: Development`, `Created: Design`, `Created: Marketing`, `Created: Business development`, closes the window to reveal all five departments wired around the `24/32` hub, and resets to the `115%` `Operations` map so the loop closes cleanly.
- **Could not do / UI constraints**: When the `applied` event arrives, `AgentWindow` replaces the interactive `StructureCard` immediately with `.t-done` (`Created: ...` lines).

### 4. `development.gif` (`scenes/development.spec.ts`, `8.50 s`, `4.69 MiB`)
- **What it shows**: Development's pipeline schema zoomed to `74%` so employee chip text, model names, tool badges, and task titles are legible at `1200px` GIF width. Across four live snapshots, agents change state (`working`, `handed on`, `needs a decision`, `queued`, `free`), `Dana`'s head line updates at each stage, task `#221 Plant identification camera flow` advances from `Developer` (`Iris`) -> `Code reviewer` (`Vera`, `gate 1`) -> `Security engineer` (`Petra`, `gate 2`) -> `Test engineer` (`Gideon`, `last gate`) with pulses, and the camera pans smoothly across the pipeline and back to Snapshot 0 for a clean loop.
- **Could not do / UI constraints**: At `74%` zoom, `Performance` (`Caleb`) and `Test engineer` (`Gideon`) do not fit inside the same static frame together, so the scene pans once smoothly right (`420px`) to show `Code reviewer`, `Security engineer`, and `Test engineer` in full, then pans smoothly back left (`420px`). After live `org` stream events fire, the bottom status bar shows the most recent agent event rather than the initial gate legend.

### 5. `terminal.gif` (`scenes/terminal.spec.ts`, `8.58 s`, `1.55 MiB`)
- **What it shows**: Developer `Iris`'s live `xterm.js` terminal replaying `moonfern/terminal.rec` over a mocked WebSocket (`/api/agents/dev-1/terminal`), showing a colored shell prompt, `claude --print`, `Read`, `Edit` diff lines, `Vitest` output (`14 tests`), and `git status -sb`. `Card: Iris` stands open on the left during the stream, `Task` (`#221`) opens beside it near the end, and `Task` closes while `xterm` resets to the initial shell prompt so first and last frames match pixel-for-pixel.
- **Could not do / UI constraints**: `moonfern/terminal.rec` is a scripted recording ready to be swapped for a captured live session. When two `400px` side panels (`Card` and `Task`) open together at `1440px` viewport width, `.side-panels` overlaps the left `224px` of `.xterm` and shows `"Back to terminal"` as designed in `theme.css`.

### 6. `tasks.gif` (`scenes/tasks.spec.ts`, `7.66 s`, `4.83 MiB`)
- **What it shows**: The `Tasks` screen starting at the top with three waiting items: designer `Nadia`'s visual choice with three plant-card SVG options (`Botanical field card`, `Moisture & light dial`, `Compact shelf list`), `Dana`'s commit approval (`8f4c2d1...`), and `Priya`'s CSV cultivar question. Smoothly scrolls down, clicks `Approve` on `Dana`'s commit (`Tasks` badge drops `3 -> 2`, Turn 6 advances `24 -> 25 of 40 tasks done`), glides down to Turn 6 (`Launch the iOS beta`) and its task rows, then restores all three requests and smoothly scrolls back to `scrollTop = 0` so first and last frames match pixel-for-pixel.
- **Could not do / UI constraints**: None.

### 7. `machines.gif` (`scenes/machines.spec.ts`, `8.66 s`, `5.06 MiB`)
- **What it shows**: Starts at the very top of `Machines` (`scrollTop = 0`) so the heading and pool summary strip (`10 of 10` online, `112` processor cores, `146.4 of 296 GB` free memory, `55%` busy now) are completely visible above all ten live machine rows. Across live polling ticks, CPU load bars, free memory figures, and `"N working"` counts shift slightly; clicks the `"Claude"` provider chip (`6` machines) and clears it; opens `studio-server` (`Company server here`) to show `Running now` (`Liam`, `Marcus`, `Paula`, and `Tests of task 221, part 1 of 3`) and `Plans on this machine` (`GLM` and `Codex plus`), scrolling smoothly in two stages across the card before closing it and returning smoothly to `scrollTop = 0` matching the opening frame.
- **Could not do / UI constraints**: `studio-server`'s inline detail row (`<tr className="det">`, including `Resources`, `Running now`, `Plans on this machine`, `Agent programs`, and `Connection to the server`) is roughly `980px` tall, exceeding the `848px` `.body` scroll viewport height at `1440x900`. Instead of cutting off either end, the scene holds on the upper half (`Running now` and `Plans on this machine`) and then glides smoothly down to show the lower half (`Agent programs` and `Connection to the server`) before closing.

### 8. `subscriptions.gif` (`scenes/subscriptions.spec.ts`, `8.75 s`, `4.45 MiB`)
- **What it shows**: Starts at the top of `Subscriptions` (`scrollTop = 0`) showing all seven plans (`Antigravity ultra`, `Claude max [Orchestrator]`, `Claude pro`, `Codex pro`, `Codex plus`, `GLM`, `Kimi`). Across live polling ticks, the `5 hours` and `7 days` utilization bars and `"N working"` counts shift slightly; clicks the `"Sam Rivera"` owner chip (`Codex plus` and `GLM`) and clears it; opens Maya Chen's `Claude max` (`Orchestrator`) plan and smoothly scrolls so the entire card (`Limits`, `Agents on it` across `Operations`, `Development`, and `Business development`, and `Machines of this plan`) stands inside the frame without cutoff, then closes it and glides back to `scrollTop = 0` matching the opening frame.
- **Could not do / UI constraints**: None.

### 9. `home.gif` (`scenes/home.spec.ts`, `9.75 s`, `5.28 MiB`)
- **What it shows**: Oak Lane home (`Nina Park` CEO and `Tom Park`, `110%` zoom, `7/10 agents working`, 3 departments: `Operations`, `Home devices`, `Household`). Starts on the home map with pulses, flies into `Home devices` (`Felix` head, `Mina` on Network and Wi-Fi, `Gus` on Smart devices, `Cleo` on Device cleanup), opens `Tasks` showing both confirmation requests (`Router firmware 7.2 is ready: update tonight?` and `3 unknown browser extensions on Mia's laptop: remove?`), clicks `"Yes, update tonight at 23:30"`, and returns to the `110%` Oak Lane map matching the opening frame.
- **Could not do / UI constraints**: Household yes/no prompts use `kind: 'choice'` rather than `kind: 'approval'` because `approval` cards hardcode `"asks you to approve a commit"` in `en.ts`.

### 10. `tree.gif` (`scenes/tree.spec.ts`, `7.08 s`, `5.17 MiB`)
- **What it shows**: Development's work tree (`TreeView`) zoomed at `83%` so the tree fills roughly `90%` of the canvas width and agent names, `#task` numbers, state colors, and wait badges (`|| waits for Dana since 14:12`, `? asking`, `waits for #221`) are clearly readable. Replays 4 snapshots (`14:20` -> `14:24` -> `14:28` -> `14:32`): idle developer `Tessa` picks up `#235` and turns active, `Liam` merges `#226` into `turn-6`, `Iris` merges `#221` into `turn-6` unblocking `Owen` on `#227`, pans down to show multi-maker turn review `#242` (`Vera`, `Marcus`, `Hana`, `Kiran`) recording clean verdicts, pans back up to open `Iris`'s window and `Card: Iris`, and closes the window back to Snapshot 0 (`14:20`) for a clean loop.
- **Could not do / UI constraints**: At `83%` zoom (chosen for readable labels across the canvas width), all 16 vertical lanes do not fit in a single static viewport height, so the scene shows `main`, `turn-6`, `Dana`, `Victor`, and the active developers at top, pans smoothly down `260px` for the four reviewers' verdicts, and pans smoothly back up `260px`. Clicking an agent row opens `AgentWindow` + `Card: Iris` rather than the small inline `.tv-card` (which only opens for `main`, `turn`, `merge`, and `review` items).

### 11. `speed.gif` (`scenes/speed.spec.ts`, `9.08 s`, `4.12 MiB`)
- **What it shows**: Development's `Speed` drawer (`SpeedPanel`) beside the `56%` schema. Starts on the `Speed` tab showing Turn 6 totals (`11 h 16 min` working, `42 min` waiting, `12 min` idle) and per-agent timeline strips advancing across snapshots, switches to the `Idle` tab showing `Priya`'s active wait (`since 14:04, still going`, ticking `24 min` -> `28 min`) above ended waits (`Owen`, `Tessa`, `Jules`), and returns to the `Speed` tab at Snapshot 0 (`11 h 16 min`) so the loop closes cleanly.
- **Could not do / UI constraints**: With 14 tracked agents in Development, the `Speed` tab displays the turn summary and the top four agent rows (`Dana`, `Victor`, `Iris`, `Tessa`) without scrolling, while the `Idle` tab highlights `Priya`, `Owen`, `Tessa`, and `Jules`.
