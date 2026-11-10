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

- You read batch 2, slice app, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-2, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch2-app.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# The tasks

## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 2

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


### Task 2: Migrations leave the app's start

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/db-pool.test.ts test/migrate.test.ts
test/cli.test.ts` passes, and from the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/migrate.ts`
- Modify: `apps/server/src/db/client.ts`, `apps/server/src/main.ts`, `apps/server/src/cli.ts`,
  `apps/server/package.json` (`dev`: `tsx src/migrate.ts && tsx watch src/main.ts`; `start`: `node dist/migrate.js &&
  node dist/main.js`)
- Test: `apps/server/test/db-pool.test.ts`, `apps/server/test/migrate.test.ts` (new)

**Interfaces:**
- Produces, in `db/client.ts` (`createDb` goes):
  ```ts
  export const APP_NAME = 'hornhoof-app';
  export const MIGRATE_NAME = 'hornhoof-migrate';
  export const KEEPER_NAME = 'hornhoof-keeper';
  export function openPool(url: string, onDropped: (err: Error) => void, name: string, opts?: { statementTimeoutMs?: number }): pg.Pool;
  //   pg.Pool with application_name = name, and statement_timeout only when given
  export function openDb(url: string, name: string, opts?: { statementTimeoutMs?: number }): Db;  // no migrations
  export async function migrateDb(url: string): Promise<number>;
  //   drizzle's migrate on a pool named MIGRATE_NAME with no timeouts; answers SELECT count(*) FROM
  //   drizzle.__drizzle_migrations afterwards, and ends its pool in every case
  ```
- Produces, in `migrate.ts`:
  ```ts
  export async function runMigrate(env: NodeJS.ProcessEnv, print: (line: string) => void): Promise<number>;
  //   no DATABASE_URL: prints 'DATABASE_URL is not set.' and gives 1; success: prints
  //   'The database is up to this build: <n> migrations.' and gives 0; a failure: prints
  //   'Could not bring the database up to this build: <loggable(err).message>' and gives 1
  ```
  run as an entry point the way `cli.ts` is (`realpathSync(process.argv[1])` against `import.meta.url`), exiting with
  its number.
- `main.ts` opens `openDb(url, APP_NAME)`; `cli.ts` opens `openDb(url, APP_NAME)`. Neither migrates any more.
  `openAgentSql` is unchanged.

- [ ] **Step 1: Write failing tests.**
  - `db-pool.test.ts`, `names each pool to Postgres`: `openPool(url, () => {}, 'hornhoof-keeper', {
    statementTimeoutMs: 2000 }).options` has `application_name: 'hornhoof-keeper'` and `statement_timeout: 2000`;
    `openPool(url, () => {}, 'hornhoof-app').options` has `application_name: 'hornhoof-app'` and no
    `statement_timeout`. The existing test changes only its call to the new signature.
  - `migrate.test.ts`: `says what is missing without a database address`: `runMigrate({}, print)` gives 1 and prints
    `DATABASE_URL is not set.`; `fails plainly when the database does not answer, and hides the password`:
    `runMigrate({ DATABASE_URL: 'postgres://hornhoof:s3cret@127.0.0.1:1/hornhoof' }, print)` gives 1, its one line
    starts with `Could not bring the database up to this build:` and does not contain `s3cret`.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (`runMigrate` and the new `openPool` do not exist).
- [ ] **Step 3: Implement** the interfaces above. A real run of the migrations is Task 7's compose and Task 11's
  rehearsal; plan 3 brings a real Postgres to the tests.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run migrations from their own entry point, not from the app's start".


## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 10

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


### Task 10: What people see and read

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Task 3 committed. **Done when:** from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Updates.test.tsx test/i18n.test.tsx` passes, and from
the worktree root `npx tsc -p apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/web/src/updates.ts` (`maintenance`), `apps/web/src/ui/UpdateProgress.tsx`,
  `apps/web/src/ui/UpdateBanner.tsx` and `apps/web/src/screens/Versions.tsx` (they pass `maintenance` beside `offline`),
  `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`, `guide/install.md` (line 43), `guide/public-link.md` (line 23), `SECURITY.md` (the line
  "The tunnel carries traffic only to the Hornhoof app...")
- Test: `apps/web/test/Updates.test.tsx`, `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: reasons `maintenance`, `read_only`, `starting` (Task 3; the keeper and `front` send the same, Tasks 4
  and 5).
- `Updates` gains `maintenance: boolean`: true while the latest poll failed with an `ApiFailure` whose `reason` is
  `maintenance`, false once a poll answers (and `offline` stays false meanwhile). `UpdateProgress` takes `maintenance?:
  boolean` and shows `t.updates.maintenance` in place of `restarting`.
- Texts:
  - `updates.maintenance`: EN `Maintenance: Hornhoof is installing the update and takes no changes until it ends.`;
    RU `Обслуживание: Hornhoof ставит обновление и не принимает изменений, пока оно не закончится.`
  - `errors.maintenance`: EN `Hornhoof is installing an update and takes no changes until it ends. Try again in a few
    minutes.`; RU `Hornhoof ставит обновление и не принимает изменений, пока оно не закончится. Попробуйте через
    несколько минут.`
  - `errors.read_only`: EN `Hornhoof only reads on this machine now, so nothing was changed.`; RU `Сейчас Hornhoof на
    этой машине только читает, поэтому ничего не изменилось.`
  - `errors.starting`: EN `Hornhoof is starting. Try again in a few seconds.`; RU `Hornhoof запускается. Попробуйте
    еще раз через несколько секунд.`
- Docs, each in the file's own voice:
  - `guide/install.md` line 43 becomes: "It takes the first free web port from 8080 and peer port from 8180, and keeps
    them in `.env` as `HORNHOOF_PORT` and `HORNHOOF_PEER_PORT`. A list in the Docker volume `hornhoof-ports` keeps
    every company's ports on this computer, so no two companies get the same one, even while one is stopped."
  - `guide/public-link.md` line 23: the tunnel container becomes the keeper: "The keeper, a small container next to
    the server, keeps the connection to it, so nothing has to be opened on your router. It carries nothing while the
    company has no link."
  - `SECURITY.md`: "The tunnel carries traffic only to the Hornhoof app, never to anything else on your network,
    whatever hornhoof.org asks for." becomes "The tunnel ends in the keeper, a container next to the app, which passes
    its traffic to the Hornhoof app only, never to anything else on your network, whatever hornhoof.org asks for."

- [ ] **Step 1: Write failing tests.** `Updates.test.tsx`: `shows maintenance while the server answers with it`: a
  running update whose next `/api/updates` answers 503 with reason `maintenance` shows the progress bar's
  `aria-valuetext` `Maintenance: Hornhoof is installing the update and takes no changes until it ends.`, and a later
  200 answer shows the step again; the typed `idle` fixture at line 199 gains `maintenance: false`. `i18n.test.tsx`:
  the three reasons show their texts in both languages.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL.
- [ ] **Step 3: Implement** the texts, `maintenance` and the docs.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say maintenance while an update keeps Hornhoof from taking changes".


