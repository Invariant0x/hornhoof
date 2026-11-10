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
6. Docker never runs on this machine; it runs Ivan's live company. On the test machine it is allowed only inside your own run: `remote.sh run --dind <label> '<command>'` gives a daemon in your container, and `npm run test:real` belongs there when a task's Done when names it. Do not run, build, pull, exec or inspect anything in Docker any other way.

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

- You read batch 8, slice keeper, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-8, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch8-keeper.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This batch

Batch 8 holds Plan 1b Tasks 8 and 9, Plan 2 Tasks 5, 6 and 7, and two bug fixes. It ends Plan 1b's code and Plan 2. Read in `/home/altera/hornhoof-network/hornhoof` on the branch `batch-8`, read only. The lead settled conflicts between these tasks and batch 6's fixes while assembling: `modules/link/client.ts` (`configFor`'s own-key check, now on `local`), `modules/link/link.ts` (`writeTunnelSettings(db, config, log?)`, `settingsWith`), and `modules/tls/store.ts` (`passes`, `readLinkMode`, `linkMode`). Read those on the branch and say if the join lost anything.

Writers' rulings and their open items are in the ledger, `network-build/progress.md`: the lines naming Plan 1b Task 8, Plan 1b Task 9, Plan 2 Task 5, Plan 2 Task 6, Plan 2 Task 7, and the carries beside them. Claims to check, not to trust.

Look hardest at, in this slice: frpc's child environment (Plan 2 Task 6's ruling gives it only PATH and the client's own env, since frpc fills `{{ .Envs.NAME }}` in its config and the config carries text the relay gave); `emit('listening')` in `LinkListener.listen` and the 408 it buys; who may set `x-forwarded-proto` and the visitor's address on each door, and whether a local caller can pass as the keeper; what `front` forwards while the keeper is down; a keeper crash and its frpc child; `apps/server/src/main.ts`, which has no test and has never run: read it and its `whenLead` hooks line by line against `AppMode` as batch 6 left it (a late `whenLead` no longer enters synchronously); `compose.yaml`'s ports, networks and environment against a fresh install with `HORNHOOF_PORT=` empty and against an old `.env`; `Dockerfile`'s `CMD`.

You are the batch's reader for interactions and do Plan 2's and Plan 1b's plan-end read: read only what passes between their batches, not each task again. The seams: the updater (2 T1), the installer (2 T8, T9) and `take_over` against the new compose services; `updates/routes.ts` and `app-mode` against the keeper's word; `tunnel.json`, which now only feeds the updater's backup and the installer; 1b's `LinkTls` and 2 T6's `servedCertificate`; `GET /api/link` and `POST /api/setup` between the server and 1b Task 9's screens. Real frpc passed only `frpc verify` here, a rehearsal against a real frps is Plan 2's later step: say if a test against the local relay in `hornhoof-edge` is cheap enough and would catch a named harm.

The certificate slice and the screens slice have their own readers and are already read. Their fix lists are `network-build/runs/batch8-cert-merged.md`, once written. Do not repeat them. Plan 2 Task 7's commits (`compose.yaml`) may get one more fix for a test, as its author check is still running.

# The tasks

## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 5

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


### Task 5: The keeper's mode and its doors to the app

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 2, 3 and 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper.test.ts test/config.test.ts` passes, and from
the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/updater-status.ts`, `apps/server/src/modules/keeper/keeper.ts`,
  `apps/server/src/keeper.ts`
- Modify: `apps/server/src/config.ts` (`machineId`; `TUNNEL_HOST`'s message becomes `TUNNEL_HOST must be the host name
  of the keeper container, like keeper.`)
- Test: `apps/server/test/keeper.test.ts` (new), `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: `passThrough`, `serve`, `socketAddress`, `firstForwarded`, `startingAnswer`, `Target` (Task 4);
  `writeKeeperState`, `Mode` (Task 3); `openDb`, `KEEPER_NAME` (Task 2).
- Produces:
  ```ts
  // modules/keeper/updater-status.ts
  export function updaterBusy(dir: string): boolean | null;
  //   true: status.json says state 'running' and step 'backup' | 'install' | 'health' | 'rollback'; false: any other
  //   state or step, or no file; null: a file it cannot read, or not JSON with a string state (not known now)
  // modules/keeper/keeper.ts
  export const KEEPER_PORTS = { peer: 7070, front: 7080, linkHttp: 7081 } as const;
  export type KeeperOptions = {
    config: Config;
    db: Db | null;              // Task 6 reads the link with it
    app: Target;                // { host: 'app', port: 8080 }
    frontHost: string | null;   // 'front'; null: no socket on the front port is front
    log: (line: string) => void;
    host?: string;              // where the front port listens, default '0.0.0.0'
    ports?: { front?: number; linkHttp?: number; linkTls?: number };  // 0 in tests
    everyMs?: number;           // 1000
  };
  export class Keeper {
    constructor(opts: KeeperOptions);
    start(): Promise<{ front: number; linkHttp: number; linkTls: number }>;  // the ports it got (linkTls 0 until Task 6)
    stop(): Promise<void>;
    mode(): Mode;               // 'maintenance' while updaterBusy(config.controlDir) is true, 'lead' when false,
                                //   what it was when null ('lead' at start)
  }
  // config.ts: machineId: string | null, from HORNHOOF_MACHINE_ID: 32 or 64 lowercase hex digits, unset or empty null,
  //   anything else throws 'HORNHOOF_MACHINE_ID must be the hex install.sh writes. Remove the line from .env, or run
  //   the install command again.'
  ```
- The keeper writes `keeper.json` at start, every `everyMs` and at once on a change of mode, with `link: null` until
  Task 6 fills it. It serves two doors with `serve(passThrough(...))` to `opts.app`:
  - the front port (7080 on `host`): `x-forwarded-for` is `firstForwarded(req)` when the socket's address is one of
    `lookup(frontHost, { all: true })` and that entry is not empty, else `socketAddress(req)`; no `x-forwarded-proto`.
  - the link's `http` door (7081 on `127.0.0.1` only): `x-forwarded-for` is `firstForwarded(req)` or else the socket's;
    `x-forwarded-proto: https`.
  - `unreachable`: in `maintenance`, 503 with `Retry-After: 10`, the JSON body `{"error":{"code":"unavailable",
    "message":"Hornhoof is installing an update and takes no changes until it ends.","reason":"maintenance"}}` under
    `/api/` and `/mcp`, else `text/plain` `Hornhoof is installing an update. Try again in a few minutes.` and
    `Hornhoof ставит обновление. Попробуйте через несколько минут.`; otherwise `startingAnswer`.
- `keeper.ts`, the entry point: `loadConfig(process.env)`; `openDb(url, KEEPER_NAME, { statementTimeoutMs: 2000 })`
  when `DATABASE_URL` is set, else `null`; `new Keeper({ config, db, app: { host: 'app', port: 8080 }, frontHost:
  'front', log: line => console.log(line) })`; `start()`; on SIGINT or SIGTERM `stop()`, then exit 0.

- [ ] **Step 1: Write failing tests** in `keeper.test.ts`, each keeper with ports 0, `host: '127.0.0.1'`, a temp
  `HORNHOOF_CONTROL_DIR` and a target that echoes the request's headers as JSON:
  - `updaterBusy` cases: `running` with each of the four steps is true; `running` with `pull`, and `done`, `failed`,
    `rolled_back` and a missing file are false; `{` and `[]` are null.
  - `writes its mode every second, maintenance while the updater installs`: `keeper.json` says `lead` with `at`
    within 2 s of now; `status.json` `running`/`install` gives `maintenance` within 2 s; `done` gives `lead` again.
  - `keeps maintenance through a status file it cannot read`: after `running`/`install` gave `maintenance`, `{`
    written over `status.json` leaves `maintenance` for 3 s; `failed` then gives `lead`.
  - `takes the visitor from front and from nobody else`: on the front port with `x-forwarded-for: 203.0.113.5`,
    `frontHost: 'localhost'` passes `203.0.113.5`; `frontHost: 'front.invalid'` passes `127.0.0.1`.
  - `marks the link's http traffic as https, and only that`: on the link door the target gets `x-forwarded-proto:
    https` and the first entry of the `x-forwarded-for` sent; on the front port a sent `x-forwarded-proto: https`
    does not arrive.
  - `answers maintenance while the app is down during an update, and starting otherwise`.
  - `takes link traffic through the keeper as over the link, and front's as local`: a `testApp({ TUNNEL_HOST:
    'localhost' })` listening on `127.0.0.1:0` as the target, a company set up through `inject`; through the link door
    `GET /api/health` is exactly `{ ok: true }` and a sign-in sets `__Host-hh_session`; through the front port health
    carries `version` and a sign-in sets `hh_session`.
  - `config.test.ts`: `HORNHOOF_MACHINE_ID` of 32 and of 64 hex is kept; `XYZ` throws the message above; unset is
    `null`; the `TUNNEL_HOST` message test (line 56) takes the new message.
  - `config.test.ts`, `loads the keeper's environment and nothing more`: `loadConfig` of exactly `{ DATABASE_URL:
    'postgres://hornhoof:hornhoof@db:5432/hornhoof', HORNHOOF_SECRET: <32 random bytes, base64>, ACME_DIRECTORY: '',
    HORNHOOF_MACHINE_ID: '', RELAY_URL: '' }`, the keys Task 7's compose gives the keeper, as compose hands empty
    values over, does not throw; its `controlDir` is `/control`, `machineId` null, `acmeDirectory` Let's Encrypt's
    and `relayUrl` `https://hornhoof.org`, as the app's are for the same values.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (no keeper).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the keeper: the app's mode, and the doors from front and the link to the app".


## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 6

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


### Task 6: The link moves into the keeper

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/client.test.ts test/tunnel.test.ts
test/link-listener.test.ts test/keeper-link.test.ts test/link-tls.test.ts test/link.test.ts test/auth.test.ts` passes,
and from the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/served.ts`
- Modify: `apps/server/src/modules/link/client.ts`, `apps/server/src/modules/link/tunnel.ts`,
  `apps/server/src/modules/link/link.ts`, `apps/server/src/modules/tls/listener.ts`,
  `apps/server/src/modules/tls/store.ts`, `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/auth/tunnel.ts`
  (no `linkVisitor`), `apps/server/src/main.ts`
- Delete: `apps/server/src/tunnel.ts`
- Test: `apps/server/test/client.test.ts`, `apps/server/test/tunnel.test.ts`, `apps/server/test/link-listener.test.ts`,
  `apps/server/test/keeper-link.test.ts` (new), `apps/server/test/auth.test.ts` (1b's cases on the listener's sockets
  go; Task 5 and this task's keeper tests cover that path)

**Interfaces:**
- Consumes: `Keeper`, `KEEPER_PORTS` (Task 5); `KEEPER_FILE`, `freshState` (Task 3); 1b's `LinkListener`,
  `linkVisitor`, `LINK_TLS_PORT`, `tlsOf`, `linkMode`, `certInfo`, `Served`, `LinkTls`.
- Produces:
  ```ts
  // modules/link/client.ts
  export type FrpcLocal = { http: { ip: string; port: number }; https: { ip: string; port: number } };
  export const linkClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-link`;
  export function configFor(settings: TunnelSettings, opts: { clientId: string; local: FrpcLocal }): string;
  export function clientFor(settings: TunnelSettings, opts: { clientId: string; local: FrpcLocal; dir?: string }): Client;
  // modules/link/tunnel.ts: TunnelKeeper's options lose `file` and gain
  //   read: () => Promise<TunnelSettings | null | undefined>   (undefined: not known now, the running client stays;
  //   null: no link, the client stops); a change is a change of JSON.stringify(settings)
  // modules/link/link.ts
  export async function tunnelSettings(db: Db, config: Config): Promise<TunnelSettings | null>;  // what writeTunnelSettings writes
  //   with its mode from readLinkMode, so a failed read of any table throws and never reads as a change
  // modules/tls/store.ts
  export async function readLinkMode(db: Db, config: Config): Promise<'http' | 'https'>;
  //   1b's rule, except that a failed database read throws; certificate data that does not pass still gives http.
  //   linkMode becomes readLinkMode(db, config).catch(() => 'http'), as 1b has it
  export async function servedCertificate(db: Db, config: Config): Promise<{ host: string; cert: { certPem: string; keyPem: string } | null } | null>;
  //   null without a link; cert: the link_tls row's certificate when its name is the link's, with its key decrypted
  // modules/tls/listener.ts: constructor(opts: { server: http.Server; log: FastifyBaseLogger | { warn(o: unknown, m?: string): void } })
  //   listen(port, host?) defaults host to 127.0.0.1, and every PROXY header is believed: only the keeper's frpc
  //   reaches that address
  // modules/keeper/served.ts
  export class KeeperServed implements Served {
    constructor(opts: { dir: string; timeoutMs?: number; everyMs?: number; now?: () => number });  // 20000, 500
    use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void>;
    //   resolves once a fresh keeper.json says link { host, fingerprint256 } with that host and
    //   cert ? certInfo(cert.certPem).fingerprint256 : null; throws 'The keeper does not serve this certificate yet.'
    //   after timeoutMs
  }
  // KeeperOptions gains clientFor?: (settings: TunnelSettings, clientId: string, local: FrpcLocal) => Client,
  //   and linkEveryMs?: number (3000), how often the link and its certificate are read
  ```
- `configFor`, `http` mode, exactly (with `https` mode's proxy block `type = "https"`, `localIP = "127.0.0.1"`,
  `localPort = <local.https.port>`, `transport.proxyProtocolVersion = "v2"` and no `requestHeaders` line):
  ```toml
  serverAddr = "<serverAddr>"
  serverPort = <serverPort>
  loginFailExit = false
  log.to = "console"
  log.level = "info"
  log.disablePrintColor = true
  clientID = "<clientId>"
  transport.protocol = "wss"
  transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
  transport.heartbeatInterval = -1
  transport.tcpMuxKeepaliveInterval = 10
  metadatas.name = "<name>"
  metadatas.key = "<key>"
  metadatas.client = "<clientId>"

  [[proxies]]
  name = "<name>"
  type = "http"
  subdomain = "<name>"
  localIP = "127.0.0.1"
  localPort = <local.http.port>
  ```
  `configFor` throws when `clientId` does not match `^[a-z0-9-]{1,63}-[0-9a-f]{8}-link$` or does not start with the
  link's name and a dash.
- The keeper, added to Task 5's: with `db` and `config.machineId`, a `TunnelKeeper` (`everyMs` `linkEveryMs`,
  `restartMs` 2000) whose `read` is `tunnelSettings(db, config)` with a throw read as `undefined`, and whose `clientFor`
  is `opts.clientFor` or `clientFor(settings, { clientId: linkClientId(settings.name, machineId), local })`, `local`
  being `127.0.0.1` with the link door's port and the TLS listener's. Without a machine id: no frpc, and once `The
  keeper carries no public link: HORNHOOF_MACHINE_ID is not set. Run the install command again.` A `LinkListener`
  handing its connections to a third `serve(passThrough(...))` server whose `x-forwarded-for` is
  `linkVisitor(req.socket)` or else the socket's, with `x-forwarded-proto: https`, listening on
  `127.0.0.1:<LINK_TLS_PORT>`. Every `linkEveryMs` `servedCertificate(db, config)`; a throw keeps what the listener has;
  a change of host or certificate is given to `use(host, cert)`, awaited, and only then `keeper.json`'s `link` becomes
  `{ host, fingerprint256 }` (null fingerprint for a stand-in, `{ host: null, fingerprint256: null }` without a link).
  `stop()` ends frpc and closes the listener.
- `main.ts` drops 1b's `LinkListener`. With `config.keeper`: `void ctx.tls.serveOn(new KeeperServed({ dir:
  config.controlDir })).catch(<one warning line>)`, and `ctx.mode.whenLead(() => ctx.tls.start(), () =>
  ctx.tls.stop())`; without a keeper nothing serves the link's TLS, so `LinkTls` is not started. The setup link is
  printed once, on the first way into `lead`. SIGINT and SIGTERM close the app and exit 0.
- `apps/server/src/tunnel.ts` goes; Task 7 removes its compose service.

- [ ] **Step 1: Write failing tests.**
  - `client.test.ts`: the exact `CONFIG` for `http` and for `https` mode as above, with `clientId
    'acme-ab12cd34-link'` and `local` `7081`/`8443`; `linkClientId('acme', 'ab12cd34' + '0'.repeat(24))` is
    `'acme-ab12cd34-link'`; a client id for another name throws; `clientFor` writes the file with mode 0600.
  - `tunnel.test.ts`: every case reads through `read` (the test sets what it answers); new: `keeps the client running
    while read answers undefined`, and `stops it when read answers null`.
  - `link-listener.test.ts`: the listener hands its connections to a plain `http.Server` that answers
    `linkVisitor(req.socket)`; a PROXY header from `127.0.0.1` with source `203.0.113.9` gives `203.0.113.9`;
    `listen(0)` listens on `127.0.0.1`. 1b's case that the header is believed only from the tunnel container goes.
  - `keeper-link.test.ts`, with `testApp`'s PGlite database, a link saved with `saveLink` and a fake frpc (an injected
    `clientFor` that writes `configFor(...)` to a file and starts a sleeping `node -e` child):
    - `runs frpc with the link's client id and the network transport, pointed at itself`: the config has `clientID =
      "acme-ab12cd34-link"`, `transport.heartbeatInterval = -1` and `localPort = <the link door's port>`.
    - `runs https when linkMode says so`: with `ACME_DIRECTORY` an https address in the keeper's config (with `off`,
      1b's `linkMode` always says `http`), a `link_tls` row in `https` with a `selfSigned` certificate for the host
      (as 1b's `linkMode` tests make one) gives the `https` block at the TLS listener's port.
    - `keeps frpc in https when only the certificate's read fails`: in `https` mode as above, a `db` that answers the
      `public_links` read and throws on the `link_tls` one makes `tunnelSettings` throw, and the keeper keeps the
      same child, the `https` block and the served certificate for 10 reads.
    - `keeps frpc and the certificate when the database does not answer`: with `linkEveryMs` 50, after the first read
      a `db` whose queries throw leaves the same child running and the same certificate served for 10 reads.
    - `uses the same client id after the keeper starts again`: a second keeper with the same machine id, started
      after the first stopped, writes the same `clientID`.
    - `stops frpc when the link goes`.
    - `serves the link's stored certificate and names it in keeper.json`: a TLS client with servername the host, sent
      a PROXY v2 header first, sees a peer certificate whose `fingerprint256` is the stored one's, and `keeper.json`
      says the same; a `link_tls` row for another name gives a stand-in and `fingerprint256: null`.
    - `passes link TLS traffic to the app with the visitor from the PROXY header`: the echoing target gets
      `x-forwarded-for: 203.0.113.9` and `x-forwarded-proto: https`.
    - `runs no link without a machine id`: no child, and the line above once.
    - `KeeperServed`: resolves once `keeper.json` names that host and fingerprint; throws after `timeoutMs` (100 in the
      test) otherwise; does not take a `keeper.json` whose `at` is 11 s old.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. 1b's `link-tls.test.ts` passes as it is, since it gives `LinkTls` a
  fake `Served`.
- [ ] **Step 4: Run Done when**, then the whole server suite once. Expected: PASS.
- [ ] **Step 5: Commit** "Carry the public link from the keeper, with the network's client id, and end its TLS there".


## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 7

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


### Task 7: Compose, the image and the database's settings

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 2, 4, 5 and 6 committed. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/compose.test.ts test/pins.test.ts` passes, and
`npm run build` from the worktree root leaves `apps/server/dist/front.js`, `keeper.js` and `migrate.js` and no
`tunnel.js` (after `rm -rf apps/server/dist` first).

**Files:**
- Modify: `compose.yaml`, `Dockerfile` (the frpc comment at line 40: the keeper runs frpc as its child)
- Test: `apps/server/test/compose.test.ts`, `apps/server/test/pins.test.ts` (its ordered `image:` list, lines 51-61)

**Interfaces:**
- Consumes: the three entry points (Tasks 2, 4, 5).
- `compose.yaml`, in this order: `front`, `keeper`, `migrate`, `app`, `db`, `node`, `updater`. The `tunnel` service
  goes. New and changed parts, each with a short comment in the file's own voice:
  ```yaml
  front:
    build: .
    image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}
    command: ["node", "apps/server/dist/front.js"]
    restart: unless-stopped
    ports:
      - "${HORNHOOF_PORT:-8080}:8080"
    depends_on:
      - keeper
    networks:
      - default
  keeper:
    build: .
    image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}
    command: ["node", "apps/server/dist/keeper.js"]
    restart: unless-stopped
    ports:
      - "${HORNHOOF_PEER_PORT:-8180}:7070"
    environment:
      DATABASE_URL: postgres://hornhoof:${POSTGRES_PASSWORD:-hornhoof}@db:5432/hornhoof
      HORNHOOF_SECRET: ${HORNHOOF_SECRET:?Set HORNHOOF_SECRET in .env}
      ACME_DIRECTORY: ${ACME_DIRECTORY:-}
      RELAY_URL: ${RELAY_URL:-}
      HORNHOOF_MACHINE_ID: ${HORNHOOF_MACHINE_ID:-}
    volumes:
      - control:/control
    depends_on:
      db:
        condition: service_healthy
    networks:
      - default
      - internal
  migrate:
    build: .
    image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}
    command: ["node", "apps/server/dist/migrate.js"]
    restart: "no"
    environment:
      DATABASE_URL: postgres://hornhoof:${POSTGRES_PASSWORD:-hornhoof}@db:5432/hornhoof
    depends_on:
      db:
        condition: service_healthy
    networks:
      - internal
  ```
  `app` loses `ports`; its environment gains `HORNHOOF_KEEPER: "on"` and `TUNNEL_HOST: keeper` (with the comment: the
  one container whose word on https and on the visitor's address the app believes); its `depends_on` is `db`
  (`service_healthy`), `migrate` (`service_completed_successfully`) and `keeper` (`service_started`). `db` gains
  `command: ["postgres", "-c", "wal_level=logical", "-c", "max_replication_slots=10", "-c", "max_wal_senders=10",
  "-c", "max_prepared_transactions=0"]`. `node` and `updater` stay as they are.

- [ ] **Step 1: Write failing tests** in `compose.test.ts` (the "tunnel service" describe goes):
  - `has no tunnel, and front alone publishes the web port`: no `tunnel` service; `front.ports` is
    `['${HORNHOOF_PORT:-8080}:8080']`; `app` has no `ports`; no other service names `HORNHOOF_PORT`.
  - `runs front, keeper and migrate from the app's own image`: each `image` equals `app.image`, and each `command` is
    `['node', 'apps/server/dist/<name>.js']`, whose `apps/server/src/<name>.ts` exists.
  - `gives the keeper the peer port, the database, the control folder and nothing of Docker`: its port, its
    `environment` keys exactly `DATABASE_URL`, `HORNHOOF_SECRET`, `ACME_DIRECTORY`, `RELAY_URL`,
    `HORNHOOF_MACHINE_ID`, `volumes` exactly `['control:/control']`, no `docker.sock` anywhere in it, networks
    `default` and `internal`.
  - `gives the keeper the app's value of every setting the link is read with`: the app's and the keeper's
    `environment` from the file, each `${NAME:-default}` and `${NAME:?...}` filled from one sample `.env` (a random
    `HORNHOOF_SECRET`, `NODE_KEY`, `POSTGRES_PASSWORD` `pw`, `ACME_DIRECTORY` `https://acme.hornhoof.test/directory`,
    `RELAY_URL` `https://relay.hornhoof.test`, `HORNHOOF_MACHINE_ID` 32 hex) and then from one with only the two
    required lines; for each, `loadConfig` of both answers the same `databaseUrl`, `secret`, `acmeDirectory` and
    `relayUrl`, and the keeper's `controlDir` is `/control`. These are the `Config` fields `tunnelSettings`,
    `readLinkMode` and `servedCertificate` read, with `relayUrl` in case the link's host is taken from it; when the
    agent finds them reading another one, it joins the list, the keeper gets the app's line for it, and the exact key
    list above grows by it.
  - `starts the app only after migrate ended well, and the app believes only the keeper`: `app.depends_on.migrate` is
    `{ condition: 'service_completed_successfully' }`; `migrate.restart` is `'no'` and its network `internal` only;
    `app.environment.TUNNEL_HOST` is `'keeper'` and `HORNHOOF_KEEPER` is `'on'`.
  - `starts the database with what logical copies need`: `db.command` as above.
  - `loads with a .env from before this build`: every `${...}` in the file has `:-` or is `HORNHOOF_SECRET` or
    `NODE_KEY` with `:?`.
  - `pins.test.ts`: the ordered `image:` list is four times the app's line (`front`, `keeper`, `migrate`, `app`),
    then postgres, the node's and the updater's; the comment on the tunnel's line goes; the frpc pin test stays.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL.
- [ ] **Step 3: Change** `compose.yaml` and the Dockerfile comment.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run front, keeper and migrate in place of the tunnel, and start the database for logical
  copies".


