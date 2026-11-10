# Build rulings (they override the plan)

1. One branch for everything. A plan's "Repo" line that names its own worktree or branch (relay-contract, backups, ...)
   means the Hornhoof clone `/home/altera/hornhoof-network/hornhoof` on its local branch `network`. "Starts from: main
   with plan N merged and shipped" and "Handed over" mean "plan N's tasks are complete on this branch". The relay repo
   is `/home/altera/hornhoof-network/hornhoof-edge`, local only: no remote, no push. Mac paths in a plan
   (`/Users/0x/Projects/...`) mean those two folders; `notes/specs/` means `/home/altera/hornhoof-network/specs/`,
   `notes/plans/` means `/home/altera/hornhoof-network/plans/`; `notes/ops/` is not on this machine.
2. Never deploy, ship or rehearse. Skip every step a plan marks as the team lead's or Ivan's: deploying the relay to the
   droplet, hornhoof.org, or any ssh; a rehearsal on a stand; `install.sh` against a real company; an Update; a
   `request.json` on a company; a merge into main; a push; anything on GitHub.
3. Code that a plan says depends on plan 1 being deployed is written and tested against the local relay the tests and
   the lab start. Never against the real one.
4. `~/.hornhoof-edge/` is not on this machine and is not created: no private-words file, no keys, no ssh config. Any
   plan step that writes or reads there is the lead's to rule on; report it, do not do it.
5. Migration numbers: the number is what `drizzle-kit generate` gives: the plan's number plus 11 (`0053_session_handover` to
   `0071_go_on_here`), and a plan's text and tests read so. Main's newest is `0052_dismissed_command_blocks`. One migration lane at a
   time, in the order 1b T1, 1b T3, 1b T7, 3 T2, 4 T1: a lane that was overtaken deletes its own migration, snapshot and journal
   entry and generates again after `lane.sh refresh`.
6. Docker is not used in this build. Do not run, build, pull, exec or inspect anything in Docker, on this machine it
   runs a live company. A plan's step or test that needs Docker is reported to the lead; write the test so that it is
   skipped when Docker is not there only if the plan's own command (`npm run test:real`) already keeps it apart, and go
   on with the rest.

# The machine's rules (from CLAUDE.md, they bind you)

- Files, code, commits, ledger lines, briefs: English. Comments are plain sentences that say why. Never use em dashes,
  in code, docs, commits or messages. In Russian UI strings write "е", never "ё".
- TDD for everything: the failing test first, watch it fail for the right reason, then the code, then watch it pass. A
  bug is fixed only after a test reproduces it.
- Uncle Bob's clean code: small functions, names that say what things are, no duplicated logic.
- Hornhoof's own rules: `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.
- You commit only on your own lane's task branch, through `network-build/lane.sh commit`; the lead lands batches. Never push. No new remote, no branch on GitHub.
  Never rewrite history. Never commit or create `notes/`, `.superpowers/`, `.claude/`, `node_modules/`, `archive/`,
  `companies/`, `deploy.env`, `.metrics/`.
- Never print a secret value: keys, tokens, passwords, generated visitor keys. A generated key lives only in its one
  response; tests compare it with booleans and fixed messages.
- Never put Ivan's email or any personal data into a request to an outside service. Never read or copy credentials: not
  `~/.claude` credentials, not `~/.gemini`, not `~/.ssh`, not any Docker volume.
- Nothing on the relay droplet: no ssh to it, no deploy. GitHub: reading is fine, public release downloads with their
  checksum checked are fine, nothing is sent to GitHub. Tests never reach hornhoof.org or a real company.
- This machine is a-host. It runs Ivan's company Hornhoof in Docker (containers named `hornhoof-*`) and belongs to his
  family. Never touch Docker that is not yours. No sudo. Work only inside `~/hornhoof-network`; other folders in the home
  belong to the machine's owner, do not read or change them. Temporary files go in
  `/home/altera/hornhoof-network/network-build/tmp` or the temporary folders tests make for themselves.
- Keep the load moderate, the company runs here: vitest with `--maxWorkers=2`, at most two heavy runs at once across the
  whole team. About 7 GB of memory is free. Every test or gate run goes through one of two wrappers, which also keep real
  Docker out of reach: `/home/altera/hornhoof-network/network-build/light.sh <command>` for a focused run of a few tests,
  and `/home/altera/hornhoof-network/network-build/heavy.sh <command>` for a full suite or coverage run (it waits for a
  free slot, so it may wait some minutes).
- Skills, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`; read and follow them:
  `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion` before you claim
  anything is done.
- An irreversible, destructive or security-sensitive step, or a side effect outside this folder: do not do it, report it.


# You are the reviewer (read-only)

Another agent wrote the task below. You review it; you do not fix it. Two reviewers work at once, independently.

- Do NOT edit, create, move or delete any file in either repository. Do not commit, stage, push, run prettier or any
  formatter. Temporary files only under `/home/altera/hornhoof-network/network-build/tmp/<your own new folder>`.
- Read the change (the review package named below), compare it line by line with the brief: the plan's top part, its
  Review Focus, its Global Constraints, the build rulings and the build lead's rulings, and the task's Files, Interfaces
  and Steps. Spec: `/home/altera/hornhoof-network/specs/2026-11-02-single-network-design.md`. Ledger of earlier rulings,
  all of which stand: `/home/altera/hornhoof-network/network-build/progress.md`.
- Use `git diff`, `git show --format=%s`, or the package; do not print full `git log` output, it carries an author's
  email address, and nothing of the kind goes in your report.
- Tests (Ivan's word): do not ask for a test only to cover a line, pin a condition or raise a number. Report a missing or weak test as Important only when a named harm to a person could reach production unseen, and say which. Do not ask for old tests to be rewritten. A test that passes with the code wrong, on what the task promises, is still a finding.
- Judge every finding by what a person using Hornhoof would get. Critical: a person loses data or access, a company is
  exposed or cut off, or the task's promise is false. Important: a real gap against the brief, or a test that would
  pass with the code wrong. Minor: anything else.
- Look hardest at: behavior that differs from the Interfaces; tests that would pass even if the code were wrong (weak
  asserts, sleeps instead of waits, skipped checks); any secret value that could reach a log, a test message or a
  report; anything private or any em dash in a tracked file; fail-open reads; processes or ports left behind; Python
  syntax newer than 3.12 in relay files; facts in docs that are not true at this commit.
- Check the build's rules as findings too: was each new test seen failing first, is any changed function over CRAP 10, any
  duplicate pair at 0.8; small functions, names that say what things are, comments that say why. Mutator is not part of a task's or a plan's review; it runs once, at the end of phase 1.
- Reproduce before you claim: for a Critical or Important say how you checked it (the command or the reasoning from
  named lines). Run a focused test only when it settles a doubt; the lead already ran the full suite and gives you its
  result. At most `nice -n 10`, one run at a time. You do not dispatch subagents.
- Report, as your final message, a list of findings, each: severity, `file:line`, what is wrong, what a person would
  get, what would make it right. Say so if you find nothing at a severity. Keep it short and concrete. Never print a
  key or token value.

# This review: conveyor v4, one review per batch

- You read batch 6, slice mode, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-6, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch6-mode.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This slice

Plan 2 Task 3: the app runs in the mode the keeper gives it. One reader. Plan 2 Task 5, the keeper that writes this state, is being written on top of it and is not in this package.

Read for: what a request can still change in each mode; what happens on a stale, missing or unreadable state file; what runs and stops as the mode changes, in `app.ts` and the timers; whether a mode change can leave a socket or a timer behind.

# The tasks

## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 3

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges `192.0.2.0/24`
  and `203.0.113.0/24`, hosts under `hornhoof.test`, and keys made at run time.
- No new dependency. The pass-through is `node:http` and `node:net`.
- No migration in this plan. The keeper reads only tables and columns that exist before and after it, so a keeper of
  this build runs on the database of the build before while `migrate` has not run yet.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from the worktree root:
  `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`. Types and shell, always from the worktree root:
  `npx tsc -p apps/server/tsconfig.json --noEmit` and, for web tasks, `npx tsc -p apps/web/tsconfig.json --noEmit`,
  both printing nothing; `bash -n scripts/install.sh apps/updater/updater.sh` and `shellcheck scripts/install.sh` (CI
  runs it, `.github/workflows/images.yml:38`). Never run prettier.
- Every variable the new `compose.yaml` reads has a default, or is one every `.env` has today (`HORNHOOF_SECRET`,
  `NODE_KEY`): the updater that runs the move-in loads the new compose file with the old `.env` before the new
  installer runs (`apps/updater/updater.sh:269-282`, `pull_images`).
- The built-in node runs agents and shares the default network with `front`, the keeper, the app and the updater.
  Nothing it can send makes the app or the keeper believe a forwarded header, change a mode, or reach the link key or a
  certificate key. The control folder, which carries `keeper.json`, is mounted by the app, the keeper and the updater
  only; the node mounts nothing of it.
- A private key (the link key, a certificate's key) never goes into a log line, `keeper.json` or an answer. The
  keeper writes frpc's config with mode 0600 in its own container.
- Fail toward a working company: what the keeper cannot read now (the database, the status file) keeps what it runs;
  the app keeps its mode while the keeper's word is stale.
- localhost, the link and the built-in node keep working as before: the same web port, now on `front`; the node still
  at `http://app:8080` (plan 4 moves it).


### Task 3: The app's modes

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/app-mode.test.ts test/version.test.ts
test/health.test.ts test/config.test.ts test/socket.test.ts` passes, and from the worktree root `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/state.ts`, `apps/server/src/modules/keeper/app-mode.ts`
- Modify: `apps/server/src/config.ts` (`keeper`), `apps/server/src/errors.ts` (three reasons), `apps/server/src/app.ts`
  (`ctx.mode`, the gate, `/api/health`, lead work), `apps/server/src/modules/agents/timers.ts` (`startTimers`)
- Test: `apps/server/test/app-mode.test.ts` (new), `apps/server/test/version.test.ts` (its health equality, line 15,
  gains `mode: 'lead'`), `apps/server/test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // modules/keeper/state.ts
  export const KEEPER_FILE = 'keeper.json';
  export type Mode = 'lead' | 'read' | 'maintenance' | 'off';
  export type KeeperState = { mode: Mode; at: string; link: { host: string | null; fingerprint256: string | null } | null };
  export function readKeeperState(dir: string): KeeperState | null;   // null when missing or not this shape (zod)
  export function writeKeeperState(dir: string, state: KeeperState): void;  // written whole, then renamed; mode 0644
  export function freshState(dir: string, now: number, staleMs?: number): KeeperState | null;  // null unless at is within staleMs (10000)
  // modules/keeper/app-mode.ts
  export class AppMode {
    constructor(opts: { dir: string; fromKeeper: boolean; everyMs?: number; staleMs?: number; now?: () => number; log: (line: string) => void });
    current(): Mode;
    start(): void;          // without a keeper: lead at once; with one: check() now and every everyMs (1000)
    stop(): Promise<void>;  // stops reading, and runs the leave hooks when in lead
    check(): Promise<void>; // reads keeper.json once; a fresh word sets the mode; awaits the hooks of a change
    whenLead(enter: () => unknown, leave: () => unknown): void;  // enter on every change into lead, leave on every change out
  }
  export function modeGate(mode: AppMode): (req: FastifyRequest) => Promise<void>;
  export function whileLeading<A extends unknown[]>(mode: AppMode, work: (...args: A) => Promise<void>): (...args: A) => Promise<void>;
  //   runs work only while mode.current() is 'lead', checked when the call runs; else resolves and does nothing
  // config.ts: keeper: boolean, from HORNHOOF_KEEPER: 'on' gives true, unset or empty false, anything else throws
  //   'HORNHOOF_KEEPER must be on, or not set.'
  // errors.ts: ErrorReason gains 'maintenance' | 'read_only' | 'starting'
  // app.ts: Ctx gains mode: AppMode
  ```
- `AppMode`: before its first fresh word the mode is `off`; a stale, missing or unreadable `keeper.json` changes
  nothing. Hooks run in the order they were registered; a hook registered while in `lead` is entered at once; a
  throwing hook is one log line and stops neither the others nor the change. Each change logs `Hornhoof now runs in
  <mode> mode.`
- `modeGate`, an `onRequest` hook added right before `fromOwnPages` (after the socket plugin, so a refused socket is
  closed by it). `lead`: nothing. `read` and `maintenance`: `GET`, `HEAD` and `OPTIONS` pass unless the request carries
  `Upgrade: websocket`; anything else throws `new ApiError(503, 'unavailable', <message>, <reason>)`, reason
  `read_only` or `maintenance`. `off`: only `GET /api/health` passes; the rest throws with reason `starting`. Messages:
  `read_only` 'Hornhoof only reads on this machine now, so nothing was changed.'; `maintenance` 'Hornhoof is installing
  an update and takes no changes until it ends.'; `starting` 'Hornhoof is starting.'
- `GET /api/health`: in `off` the status is 503 and `ok` is false; elsewhere 200 and `ok: true`. Over the link the body
  stays `{ ok }` (1b); elsewhere it is `{ ok, version, commit, mode }`.
- In `app.ts`: `ctx.mode = new AppMode({ dir: config.controlDir, fromKeeper: config.keeper, log })`, started in
  `onReady` and stopped in `onClose`, in place of today's three hooks at lines 98-100. Lead work goes through
  `whenLead`: `ctx.updates.start()`/`stop()`, `ctx.links.sync()` on the way in, and `startTimers`, whose
  `wakeLeftBehind` and `dropOldFiles` run on the way in and whose minute timer runs only while leading; its leave
  hook clears the timer and waits for a minute round that runs. Leaving `lead` closes every open WebSocket:
  `app.websocketServer.clients`, each with `close(1012, 'Hornhoof takes no changes now.')`. `NodeHub`'s `onMessage` and
  `onClose` are `whileLeading(ctx.mode, ...)` of today's handlers, so a message still queued when the app leaves `lead`
  writes nothing. 1b's `handOverSession` hook does nothing unless `ctx.mode.current()` is `lead`. Without a keeper
  every test sees what it saw before: lead from `onReady`.

- [ ] **Step 1: Write failing tests** in `app-mode.test.ts`:
  - `leads at once without a keeper`.
  - `is off until the keeper writes, then takes its mode`: no file, `check()` leaves `off`; a state `lead` with `at`
    now, `check()` gives `lead`; one `maintenance`, `maintenance`.
  - `keeps its mode when the keeper's word is stale or unreadable`: in `lead`, a state `maintenance` with `at` 11 s ago
    and then a file `{"mode":"nope"}` each leave `lead`.
  - `runs lead work on the way in and out`: enters and leaves counted over `lead`, `maintenance`, `lead`, `stop()`
    (2 and 2); a hook registered while leading is entered at once; a throwing enter hook still lets the next run; a
    leave hook that resolves after 200 ms is awaited by the `check()` that leaves.
  - `does lead work only while leading`: a `whileLeading` wrapper calls its work in `lead`, and in `maintenance` and
    `off` resolves without calling it; a call made in `lead` that runs after the change to `maintenance` (queued behind
    a slower one, as `NodeHub` queues messages) does not call it.
  - With `testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir })`, `dir` a fresh temp folder:
    - `answers only health while off`: from `127.0.0.1`, `GET /api/health` is 503 with `{ ok: false, version, commit,
      mode: 'off' }`; `GET /api/me` is 503 with reason `starting`.
    - `serves reads and refuses changes in maintenance`: written `lead` before `testApp`, `setUpCompany`, then
      `maintenance` written and `until` health says `maintenance`; `GET /api/me` with the session is 200; `POST
      /mcp` and a sign-in (`POST /api/auth/login`) are 503 with reason `maintenance`; an `inject` with `upgrade:
      websocket` headers on `/api/nodes/socket` is 503.
    - `answers read_only in read`: the same with `read` and reason `read_only`.
    - `hands over no session outside lead`: in `maintenance`, a `GET /api/me` over the link (`viaLink()` with only an
      `hh_session` cookie, of a session row set to `before_host_cookie` true) sets no `__Host-hh_session`, and the
      row's `expires_at` and the count of session rows stay as they were.
    - `closes open sockets when it leaves lead`: a built-in node connected as `socket.test.ts` does (`listen`,
      `connectNode`) is closed with code 1012 within 2 s of `maintenance` being written, and a new connection is
      refused while it holds.
  - `config.test.ts`: `HORNHOOF_KEEPER` `on` gives `keeper: true`; unset `false`; `yes` throws the message above.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (no `AppMode`, no gate, no `mode` in health).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when**, then the whole server suite once (`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run`
  from `apps/server`), since lead work moved. Expected: PASS.
- [ ] **Step 5: Commit** "Run the app in the mode the keeper gives it: lead, read, maintenance or off".


