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

- You read batch 2, slice install, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-2, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch2-install.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Your slice: the install and update path, and you are named for the interactions between slices

An earlier reader's findings on 2 T1 are in `runs/p2t1-r1-claude.md`: six Minors, all four of the writer's rulings held. Do not repeat them; judge them against 2 T8. Seams: 2 T1's `--take-over` needs the control folder and `HORNHOOF_SERVER_DIR` from Task 8, and assumes the revision 1 installer blocks until compose kills its updater. This branch has no keeper, front or migrate in compose.yaml until 2 T7 lands: that is the plan's order, so read the code for what it will do then. The other slices are 2 T2 and 2 T10, and 1b T2: read their commits on the branch for anything that meets yours. Real Docker is out of reach for everything you run.

# The tasks

## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 1

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


### Task 1: The updater, revision 2

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/updater.test.ts` passes, and from the worktree root
`bash -n apps/updater/updater.sh apps/server/test/updater-rev1.sh` prints nothing.

**Files:**
- Create: `apps/server/test/updater-rev1.sh`, main's `apps/updater/updater.sh` (`git show main:apps/updater/updater.sh`)
  unchanged but for a second line, the comment `# The updater from before revision 2, kept so the tests run a move-in
  under it.`
- Modify: `apps/updater/updater.sh` (`note`, `recall`, `backup`, `install`, `healthy`, `interrupted`, the start, the
  header comment), `apps/server/test/updater-stubs/docker`
- Test: `apps/server/test/updater.test.ts`

**Interfaces:**
- Produces, in `updater.sh`:
  - `HORNHOOF_UPDATER_REV=2` goes to every installer it runs, beside the variables it passes today. The note gains
    `rev: "2"`; `recall` reads it, empty in a note an older updater wrote.
  - `backup()`: the app's container id (`compose ps -q app`), then `compose stop app`, then the dump as today. A failed
    dump starts that container again (`docker start <id>`, its failure ignored) before today's `Could not save the
    database, so nothing changed.`
  - `remove_unnamed <compose file>`, called by `install()` after `unpack` and before the installer: when the file names
    the service `updater`, every container of this compose project whose service the file does not name is removed
    with `docker rm -f <id>`, never one of service `updater`; when the file names no `updater`, nothing is removed (as
    `drop_orphans`). Services the file names: `docker compose --project-directory "$SERVER_DIR" -f <file> config
    --services`. Containers: `docker ps -a --filter "label=com.docker.compose.project=<project>" --format '{{.ID}}
    {{.Label "com.docker.compose.service"}}'`, the project being `.env`'s `COMPOSE_PROJECT_NAME`, else the updater's
    own `COMPOSE_PROJECT_NAME`, else `hornhoof`. A failed removal is one `say` line and the install goes on.
  - `install()` runs the installer in the background and waits for it. When it has not ended after
    `${HORNHOOF_INSTALL_WAIT:-900}` seconds: `compose stop migrate app` (ignored), the installer's process is killed,
    `say "The installer of <tag> did not end within <n> seconds, so it was stopped."`, and `install()` fails, so
    `install_new` goes back, and a hung install on the way back ends in today's `Could not go back` line. Then
    `drop_orphans` as today.
  - `health_url`: `HORNHOOF_HEALTH_URL` when set; else `http://front:8080/api/health` when `$SERVER_DIR/compose.yaml`
    (the file the build's installer just copied there) names the service `front`; else
    `http://app:8080/api/health`. `healthy` asks it on every try.
  - `interrupted()` at step `install` with a note whose `rev` is empty (an older updater ran this build's installer,
    which handed the update over, Task 8): `say "This build's updater goes on with the update."`; when `applied` still
    equals the note's `before` (nothing of the new build ran yet), `step backup "Saving the database again, now that
    the app is stopped."` and `backup`, whose failure goes to `go_back`, since this build's installer wrote `.env` and
    `compose.yaml` already; then `note`, `step install` and `install_new`. When `applied` differs, it goes on with the
    copy it has. Every other step, and a note with `rev` 2, as today.
  - `take_over()`, run as `updater.sh --take-over`, which the script checks first, before `interrupted` and the loops:
    the helper container this build's installer starts (Task 8). Unless `status.json` says `running` at step `install`
    and `recall` finds the note, it exits 0. Then `compose up -d --no-build --wait updater`, which replaces the older
    updater, and the installer waiting in it, with this build's. It exits 0 once `status.json`'s `log` has `This
    build's updater goes on with the update.`, within `${HORNHOOF_TAKE_OVER_WAIT:-60}` seconds. Otherwise (the compose
    command failed, or the line never came): `say "This build's updater did not start, so the build from before goes
    back."`, `write_status running rollback`, and `HORNHOOF_UPDATER_REF=<the note's back.updater> compose up -d
    --no-build updater`, so the older updater starts again, finds step `rollback` and goes back (`interrupted`,
    `go_back`). When that compose command fails too: `stop_with failed "No updater could start. Hornhoof still runs the
    build from before; run install.sh server in $SERVER_DIR." finished`.
  - The header comment says what revision 2 does, in the file's own voice.
- The stub's contract (`updater-stubs/docker`), for the tests:
  - `STUB_BUILD_SERVICES` words `<tag>=<svc>,<svc>,...` answer `config --services` for a compose file of that build
    (the unpacked one under `$WORK/<tag>/`, and the one in the server folder, which the fake installer copies from
    `HORNHOOF_COMPOSE_FILE` as the real one does); unpacking writes the tag into the file as a comment so the stub can
    tell; `STUB_SERVICES` stays the answer for any other file.
  - `STUB_PROJECT_CONTAINERS` words `<id>=<service>` answer `ps -a --filter`. `rm -f` is logged; `rm -f` of a
    container of service `front` also removes `$STUB_STATE/port-holder`.
  - The fake installer logs `HORNHOOF_UPDATER_REV=<value>`. For a build whose services name `front` it writes
    `$STUB_STATE/port-holder`, since `front` then holds the web port; for a build without `front` it fails with
    `Bind for 0.0.0.0:8080 failed: port is already allocated` while that file exists.
  - `STUB_HANDS_OVER` names builds whose installer, run without `HORNHOOF_UPDATER_REV`, copies its compose file into
    the server folder, logs `installer hands over`, and stops the updater running it (`kill -9 $PPID`), as compose
    replacing that updater does; with `STUB_HANDOVER=fail` it exits 1 with `Could not start the updater of this build,
    so nothing changed.` instead. `STUB_HANG` names builds whose installer sleeps 60 s, its output in the install log.
  - Each `pg_dump` writes `-- copy <n>`, `n` counting the dumps in `$STUB_STATE/copies`, and a restore keeps the copy
    it loaded in `$STUB_STATE/restored-copy`; `STUB_DUMP=fail` makes `pg_dump` fail. `start <id>` of a container other
    than the computer's is logged and does nothing else.
  - Each `compose up` naming `updater` logs `updater up HORNHOOF_UPDATER_REF=<value or empty>`; with
    `STUB_UPDATER_UP=fail` it fails unless `HORNHOOF_UPDATER_REF` is set in its environment.

- [ ] **Step 1: Write failing tests** in `updater.test.ts`. In these new tests `STUB_BUILD_SERVICES` has `0.4.1` name
  `db, app, front, keeper, migrate, node, updater` and `0.4.0` name `db, app, node, tunnel, updater`, unless a test
  says otherwise; the tests there today keep their stubs. `runRev1` runs `updater-rev1.sh --once` as `runOnce` runs the
  updater, on the same stand and stubs.
  - `tells each build's installer that this updater is revision 2`: the `installer server` line carries
    `HORNHOOF_UPDATER_REV=2`.
  - `stops the app before it saves the database, and starts it again when the copy fails`: `docker compose stop app`
    comes before `docker exec dbcid pg_dump`; with `STUB_DUMP=fail` the state is `failed` with `Could not save the
    database, so nothing changed.`, `docker start appcid` comes after the dump, and no installer ran.
  - `removes the containers of services the new build does not name, before its installer runs`: with
    `STUB_PROJECT_CONTAINERS='c-db=db c-app=app c-tunnel=tunnel c-up=updater'`, the log has `docker rm -f c-tunnel`
    before the new build's `installer server` line, and no `docker rm -f c-db`, `c-app` or `c-up`.
  - `goes back to a build from before front even though front held the web port`: the new build is broken
    (`STUB_BROKEN='0.4.1'`) and the project has `c-front=front c-keeper=keeper c-migrate=migrate` besides; after the
    failed health check the log has `docker rm -f c-front`, `c-keeper` and `c-migrate` before the old build's
    `installer server` line, that installer succeeds, and the state ends `rolled_back`.
  - `removes nothing when the build's compose file names no updater`: no `docker rm -f` line.
  - `checks health at front for a build that has it, and at the app for one that does not`: the curl lines name
    `http://front:8080/api/health` after installing a build with `front`, and `http://app:8080/api/health` after going
    back to one without it.
  - `stops an installer that does not end, and goes back`: `STUB_HANG='0.4.1'`, `HORNHOOF_INSTALL_WAIT: '2'`: the
    state ends `rolled_back`, its log has `The installer of 0.4.1 did not end within 2 seconds, so it was stopped.`,
    and `docker compose stop migrate app` comes before the old build's `installer server` line.
  - `moves in by handing over, and goes back to the old build when the new one fails`: `runRev1` with
    `STUB_HANDS_OVER='0.4.1'`, `STUB_BROKEN='0.4.1'`, `STUB_MIGRATIONS='0.4.0=20 0.4.1=21'` and the containers
    `c-db=db c-app=app c-tunnel=tunnel c-up=updater` stops at `running`/`install` after `installer hands over`. Then
    `runOnce(s, null, ...)`, as the new updater's container starts, with `c-front=front c-keeper=keeper
    c-migrate=migrate` added: the status log has `This build's updater goes on with the update.`; `docker compose stop
    app` comes before its `pg_dump` (copy 2); the 0.4.1 installer runs with `HORNHOOF_UPDATER_REV=2`; after the failed
    check at `http://front:8080/api/health`, `restored-copy` is 2, `docker rm -f c-front`, `c-keeper` and `c-migrate`
    come before the 0.4.0 `installer server` line, which succeeds; the state ends `rolled_back`, the last curl asks
    `http://app:8080/api/health` and gets commit `aaa`, and `.env` has `HORNHOOF_VERSION=0.4.0`.
  - `stays on the old build, working, when the new installer cannot start the hand-over helper`: `runRev1` with
    `STUB_HANDS_OVER='0.4.1'` and `STUB_HANDOVER=fail` ends `rolled_back` in that one run; its log has `Could not start
    the updater of this build, so nothing changed.`; there is no `docker rm -f` call and no call naming
    `hornhoof_restore`; the last curl gets commit `aaa`; `.env` has `HORNHOOF_VERSION=0.4.0`.
  - `brings the older updater back to go back when this build's updater does not start`: after `runRev1` stopped at
    `running`/`install` as above, `updater.sh --take-over` with `STUB_UPDATER_UP=fail` and `HORNHOOF_TAKE_OVER_WAIT:
    '1'` leaves `status.json` `running`/`rollback` with `This build's updater did not start, so the build from before
    goes back.`, and the calls have `updater up HORNHOOF_UPDATER_REF=<0.4.0's updater by digest>`; then `runRev1` ends
    `rolled_back` and the last curl gets commit `aaa`. With the line already in `status.json`, `--take-over` makes one
    `compose up -d --no-build --wait updater` call and changes `status.json` in nothing; with state `done` it makes no
    call.
  - The test at line 101 (`http://app:8080/api/health`) keeps passing, since `STUB_SERVICES` names no `front`, and
    the restore test's `at(r.calls, 'docker compose stop app')` now finds the stop before the copy, still before the
    swap.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/updater.test.ts`. Expected: FAIL (no
  revision, no stop before the copy, no removal, no time limit, no take-over, health always at the app).
- [ ] **Step 3: Implement** the interfaces above in `apps/updater/updater.sh`, the fixture, and the stub's contract.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Stop the app before the database copy, remove the services a build does not name, and take
  over an update an older updater began".


## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 8

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


### Task 8: The installer: start order, the machine id, handing over to the new updater

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 1 and 7 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts` passes; from the worktree
root, `bash -n scripts/install.sh` and `shellcheck scripts/install.sh` print nothing.

**Files:**
- Modify: `scripts/install.sh` (`start_server_services`, `server_mode`), `apps/server/test/install-stubs/docker`
- Test: `apps/server/test/install-script.test.ts`

**Interfaces:**
- Consumes: `updater.sh --take-over` (Task 1), the helper's job.
- `start_server_services`, every step through the compose command it is given, in this order:
  1. `stop app` (its output and status ignored).
  2. `up -d --no-build --remove-orphans --wait db`; on failure `fail "The database did not start. Run docker compose
     logs db in $SERVER_DIR to see why."`
  3. `up -d --no-build keeper front` (Task 9 wraps this one in its port retry).
  4. As today's four cases, without `db` and `tunnel`: from the updater with the node unchanged `up -d --no-build app`;
     from the updater otherwise `up -d --no-build app node`, then `sweep_nodes`; by hand with the node unchanged `up -d
     --no-build app updater`; by hand otherwise `up -d --no-build`. compose runs `migrate` first, since `app` waits for
     it. When the output says `migrate` did not complete, `fail "Hornhoof could not bring its database up to this
     build. Run docker compose logs migrate in $SERVER_DIR to see why."`; any other failure fails as today.
- `HORNHOOF_MACHINE_ID` is written into `.env`, with its other lines and before `compose.yaml`, only when `.env` has
  none: by hand `host_id`'s value, from the updater `od -An -N16 -tx1 /dev/urandom | tr -d ' \n'`.
- The handover: when `HORNHOOF_FROM_UPDATER` is set and `${HORNHOOF_UPDATER_REV:-1}` is below 2, right after
  `compose.yaml` is in the server folder and before anything else starts or is downloaded: `say "This build's updater
  takes over the update first."`, then `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v
  "$SERVER_DIR:$SERVER_DIR" -v "<project>_control:/control" -e "HORNHOOF_SERVER_DIR=$SERVER_DIR" "$UPDATER_REF"
  --take-over`, `<project>` being the `COMPOSE_PROJECT_NAME` just written to `.env` (compose names the control volume
  so); its failure is `fail "Could not start the updater of this build, so nothing changed."` Then `sleep
  "${HORNHOOF_HANDOVER_WAIT:-300}"`, then `fail "The updater of this build did not take over, so nothing changed. Run
  install.sh server in $SERVER_DIR."` The helper replaces the updater this runs under, and with it this script; the
  new updater goes on with the update. Until then nothing but `.env` and `compose.yaml` has changed, and the old
  installer writes both back on the way back.
- The stub's contract (`install-stubs/docker`): `STUB_MIGRATE=fail` makes a `compose ... up` that names `app`, or
  names no service, fail with `service "migrate" didn't complete successfully: exit 1`; `run -d` is logged as it is,
  and with `STUB_RUN=fail` it fails with `docker: Error response from daemon: failed to create task`.

- [ ] **Step 1: Write failing tests** in `install-script.test.ts`. Every test that runs with `HORNHOOF_FROM_UPDATER`
  gains `HORNHOOF_UPDATER_REV: '2'`, and the exact `up` strings at lines 431, 576, 660, 675, 763 and 784 become the
  new step 4 strings (`db app node tunnel` is now `app node`, `db app tunnel` is `app`, `db app tunnel updater` is
  `app updater`; the two `up -d --no-build` lines stay). New:
  - `starts the database, then the keeper and front, then the app, which migrates first`: in `calls`, `docker compose
    stop app` < `docker compose up -d --no-build --remove-orphans --wait db` < `docker compose up -d --no-build keeper
    front` < `docker compose up -d --no-build`.
  - `says where to look when the database cannot be brought up to this build`: `STUB_MIGRATE=fail` exits 1 with the
    message above.
  - `writes the machine id once: the host id by hand, a random one from the updater`: by hand `.env` gets
    `HORNHOOF_MACHINE_ID` equal to its `HORNHOOF_HOST_ID`; from the updater with no id, 32 hex digits; an existing
    `HORNHOOF_MACHINE_ID=` line stays as it was in both cases, and there is one such line.
  - `hands an update to this build's updater when an older updater runs it`: with `HORNHOOF_FROM_UPDATER: '1'`, no
    `HORNHOOF_UPDATER_REV`, `HORNHOOF_HANDOVER_WAIT: '1'` and a pinned `HORNHOOF_UPDATER_REF`: `.env` and
    `compose.yaml` are written; the calls have `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v
    <dir>:<dir> -v <project>_control:/control -e HORNHOOF_SERVER_DIR=<dir> <the updater ref> --take-over`, `<project>`
    read from the `.env` it wrote, and no `docker compose stop`, `up` or `pull`; it exits 1 with `The updater of this
    build did not take over, so nothing changed.`
  - `stops when the hand-over helper does not start`: the same with `STUB_RUN=fail` exits 1 at once with `Could not
    start the updater of this build, so nothing changed.`; `.env` and `compose.yaml` are written, `.env` has no
    `HORNHOOF_PEER_PORT`, and there is no `docker compose stop`, `up` or `pull` call.
  - `goes on without a handover under an updater of revision 2`: no `--take-over` call.
  - The test `updates without questions or downloads from the updater` keeps its `docker create` assertion for now;
    Task 9 narrows it.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the start order, the machine id and the handover in `scripts/install.sh`, and the stub's
  contract.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Start the database, keeper and front before the app, and let the new updater run the move".


## 2026-11-03-network-phase-1-plan-2-keeper-and-front, Task 9

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


### Task 9: The host-wide port registry

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts` passes; from the worktree
root, `bash -n scripts/install.sh` and `shellcheck scripts/install.sh` print nothing.

**Files:**
- Modify: `scripts/install.sh` (`free_port` goes into the new functions; `server_mode` writes no port and no
  `PUBLIC_URL` when it makes `.env`), `apps/server/test/install-stubs/docker`
- Test: `apps/server/test/install-script.test.ts`

**Interfaces:**
- New functions in `install.sh`, all through `"${DOCKER[@]}"`:
  - `take_port_lock`: `docker volume create hornhoof-ports`, then `docker create --name hornhoof-port-lock --label
    io.hornhoof.since=<date +%s> "$APP_REF" true`, whose output is the lock's id. When the name is taken: `docker
    inspect --format '{{.Id}} {{index .Config.Labels "io.hornhoof.since"}}' hornhoof-port-lock`; a lock whose `since`
    is more than 120 s ago is removed by the id read (`docker rm <id>`, so a lock another caller made meanwhile
    stays), and it tries again; otherwise it waits 1 s and tries again, until `${HORNHOOF_PORT_LOCK_WAIT:-180}`
    seconds have passed, then `fail "Another Hornhoof install on this computer is choosing its ports. Wait a minute,
    then run this command again."`
  - `drop_port_lock <id>`: `docker rm <id>`.
  - `read_registry`: `docker run --rm --user 0 -v hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat
    /ports/registry 2> /dev/null || true'`; `write_registry`, from its input: `docker run --rm -i --user 0 -v
    hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat > /ports/registry.new && mv /ports/registry.new
    /ports/registry'`.
  - `bound_ports`: the host ports every container publishes, running or stopped: `docker ps -aq`, then one `docker
    inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' <ids>`.
  - `reserve_ports [<port>]`: under the lock. Held: every port in the registry on another folder's line,
    `bound_ports`, the `HORNHOOF_PORT` and `HORNHOOF_PEER_PORT` of every readable `$BASE_DIR/.env` and
    `$BASE_DIR-*/.env` but this one, and, run by hand, a port that answers on localhost (`port_answers`).
    `server_mode` sets `ENV_BEFORE` when this folder's `.env` was there before this run. The web port is the first of:
    `.env`'s `HORNHOOF_PORT`; this folder's registry line's; 8080 with `ENV_BEFORE` (a company from before ports were
    kept runs on it); else the first free one from 8080 to 8179, which marks it new (`NEW_WEB`). The peer port: `.env`'s
    `HORNHOOF_PEER_PORT`; the registry line's; else the first free one from 8180 to 8279 (`NEW_PEER`). The marks stay
    for the whole run. Given `<port>` (the retry below), that port is held for the rest of the run, and the side it
    belongs to, new by then, goes straight to the free search; the other side keeps its port.
  - It writes this folder's registry line first, other lines kept, and only then the two ports into `.env`
    (`set_env`), with `PUBLIC_URL=http://localhost:<web port>` too when this run made `.env` and the web port is new. So
    a failed registry write fails before `.env` changes, and a failed `.env` write leaves a line that only holds the
    ports. Right before the registry write it reads the lock's id again (`docker inspect --format '{{.Id}}'
    hornhoof-port-lock`); when it is not this run's, another install took the lock over, and it fails with the lock
    message and writes nothing. No free port in a range fails with today's words (`No free port from <first> to
    <last> for Hornhoof. Stop what uses them, then run this command again.`). The lock goes in every case, a failure
    too.
- Order in `server_mode`: after the pull (or after `HORNHOOF_PULLED`) and before `start_server_services`; the address
  it prints and checks (`local_url`, `public`) is worked out after it.
- Step 3 of `start_server_services` (Task 8), `up -d --no-build keeper front`: when its output says `port is already
  allocated` or `address already in use` for a port marked new, `reserve_ports <that port>` takes the next one, and
  the step runs again, up to 5 times; then, or for a port not marked new, `fail "Port <port> is taken by a program
  outside Docker. Stop what uses it, then run this command again."`
- The stub's contract (`install-stubs/docker`): `STUB_PORTS_DIR` holds `registry` for `run` with `-v
  hornhoof-ports:/ports` (read for `cat /ports/registry`, written from stdin for `cat > /ports/registry.new`), so
  several installs share it; `create --name hornhoof-port-lock` fails with `Conflict. The container name is already in
  use` while `$STUB_PORTS_DIR/lock` exists, else makes that file and prints `lock-<n>`; `rm <id>` of the lock removes
  the file; `STUB_LOCK_SINCE` is the lock's `since` for `inspect`; `ps -aq` prints `STUB_BOUND_IDS` and the
  `PortBindings` `inspect` prints `STUB_BOUND_PORTS`; `STUB_BIND_FAIL` words are ports whose first `up` that binds
  them fails with `Bind for 0.0.0.0:<port> failed: port is already allocated`; `STUB_REGISTRY=fail` makes the
  registry write fail; with `STUB_LOCK_TAKEN=1`, `inspect --format '{{.Id}}' hornhoof-port-lock` answers
  `lock-other`.

- [ ] **Step 1: Write failing tests** in `install-script.test.ts`:
  - `keeps a host-wide list of ports, so four companies on one computer never share one`: `server`, then `--name b`,
    `--name c`, `--name d` with one `HOME` and one `STUB_PORTS_DIR`: web ports 8080 to 8083, peer ports 8180 to 8183,
    and four registry lines naming their folders.
  - `leaves the ports of a stopped and pruned company to it`: a registry line `<home>/hornhoof-old 8080 8180` with no
    folder and no container: a new install gets 8081 and 8181.
  - `skips ports any container publishes, running or stopped`: `STUB_BOUND_PORTS='8080 8180'` gives 8081 and 8181.
  - `gives an existing company a peer port and keeps its web port`: a `.env` with `HORNHOOF_PORT=8085` keeps it, gets
    `HORNHOOF_PEER_PORT=8180`, and the registry line `<dir> 8085 8180`; a `.env` with no `HORNHOOF_PORT`, whose
    company runs on 8080 with `STUB_BOUND_PORTS='8080'`, keeps 8080.
  - `chooses a new company's ports by the free search though its .env is there by then`: a fresh install with
    `STUB_BOUND_PORTS='8080'` gets `HORNHOOF_PORT=8081` and `PUBLIC_URL=http://localhost:8081`; its next run, with
    `STUB_BOUND_PORTS='8080 8081'` (its own `front` binds 8081 now), keeps 8081.
  - `takes the lock and gives it back`: `docker create --name hornhoof-port-lock` comes before the registry write and
    `docker rm lock-1` after it; with `STUB_REGISTRY=fail` the install fails, `.env` has no `HORNHOOF_PEER_PORT`, and
    the `docker rm` still comes.
  - `writes nothing when another install took its lock over`: `STUB_LOCK_TAKEN=1` exits 1 with the lock message, no
    registry write, `.env` without `HORNHOOF_PEER_PORT`, and no `docker rm lock-other`.
  - `takes over a lock older than two minutes by its id, and waits for a younger one`: `STUB_LOCK_SINCE` 200 s ago
    gives `docker rm <that id>` and the install goes on; 30 s ago with `HORNHOOF_PORT_LOCK_WAIT: '2'` exits 1 with the
    lock message.
  - `moves a new port that something outside Docker holds, and its address with it`: `STUB_BIND_FAIL='8180'` ends
    with `HORNHOOF_PEER_PORT=8181` in `.env` and the registry, and two `up -d --no-build keeper front` calls;
    `STUB_BIND_FAIL='8080'` on a fresh install ends with `HORNHOOF_PORT=8081`, `PUBLIC_URL=http://localhost:8081` and
    8081 on the registry line; six ports failing in a row exit 1 with the port message; a `.env` from before with
    `HORNHOOF_PORT=8085` and `STUB_BIND_FAIL='8085'` exits 1 with `Port 8085 is taken by a program outside Docker.`
    and keeps 8085.
  - Existing tests: `installs a named server in its own folder, compose project and free port`, `keeps the folder and
    port of a named server on the next run` and `leaves the port of another Hornhoof on this computer to it` pass
    unchanged; `updates without questions or downloads from the updater` narrows its `docker create` assertion (line
    657) to calls without `hornhoof-port-lock`, and `leaves the built-in node and this server's plan nodes running
    when the node image did not change` its `docker rm` check (line 765) to `docker rm -f hornhoof-`.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above in `scripts/install.sh`, and the stub's contract.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep every company's web and peer ports in one list on the computer".


