You are the writer for Task 7 of 2026-11-03-network-phase-1-plan-9-copies in Hornhoof's network build. Read everything below before you start.

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

# How you work (writer)

The top of your notes says how; a task's "Commit" step is your hand-in's commit. Change only the task's files. No `npm install`/`npm ci` unless the task names a dependency to add. Never run prettier or any formatter. Shell is bash on Debian Linux, x86_64, GNU tools. Python for the relay: standard library only, runnable on Python 3.12 (`/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12`; 3.14 at `/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`). There is no pytest. Stop and report when a fact the task rests on proves wrong in the code.

# How this build works now: conveyor v4, Ivan's word

Rules that bind you, not optional: `/home/altera/hornhoof-network/CLAUDE.md`, the build rulings below, and
`/home/altera/hornhoof-network/FROM-DAVID-conveyor-v4.md`, sections 2 to 4. You are a fresh writer for one task, in your own lane, your own clone of
the repository, on the branch `task-<lane>`. Other writers work beside you in theirs. Do not touch the real repositories or another lane.

**Skills.** Before you write a line, read and follow, and name in your hand-in: `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion`, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`. For Hornhoof also `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.

**The task's kind** is in your notes. Known behaviour, nearly every task, since plans give exact tests: test-first, as the plan says. A bug: a failing test that reproduces it, then the fix. An unknown way (a library or protocol not used here yet): one acceptance test from the plan first, then make it work, split into pure functions, cut what is extra, then direct fast tests on the pure functions. Old code with no tests: characterization tests first, then structural commits apart from behaviour commits.

**How to write tests.** Uncle Bob's way, without chasing coverage. Logic in a pure function, tested directly, with no database and no process. One or two integration tests per route or seam, for what only they can show, not one per branch. A test checks what a person of the code would see; if it would pass with the code wrong, throw it out. No test only to cover a line or raise a number. To get a function under CRAP 10, split it first. Tests are deterministic: nothing depends on the date, the time zone, the order of tests, randomness or ids; a flaky test is fixed at its cause, never retried. Old tests are not rewritten. Never a secret in a test's message: compare with booleans.

**While you work,** run a few tests at a time from your lane with `/home/altera/hornhoof-network/network-build/light.sh <command>`, with at most `--maxWorkers=2`. You do not run a repository's whole suite, and you do not run mutator.

**Hand-in, one command, once, on your final commit:**

1. Commit your work on your branch: write the message to a file (English, a subject as the plan's Commit step names it, then why; no trailers; no em dashes), then `/home/altera/hornhoof-network/network-build/lane.sh commit <lane> <file>`.
2. The author check, on that commit. Hornhoof: `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof && /home/altera/hornhoof-network/network-build/author-check.sh lanebase'`. Relay: `REMOTE_EDGE_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof-edge && /home/altera/hornhoof-network/network-build/author-check-relay.sh lanebase "<the unittest modules your change reaches>"'`. It may queue. Start it in the background and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <lane>-check` in the foreground, calling it again while it says WAITING. Never end your turn while it is pending.
3. Red: at most two tries to fix your own red, each commit followed by the check. Still red: stop and tell the lead.

**Reply to the lead:** the status (DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT), the commit, and the log path `network-build/runs/remote-<lane>-check-*.log`, in at most five lines. That log on that commit is the evidence, and nobody reruns it. There is no review agent per task; tasks land in batches, and the batch gets one review and one fix round. A deviation from the plan, and every place where the plan proved wrong, goes in your commit message's body and your reply, as a line `Ruling: <what> - why: <why> - cost if wrong: <cost>`. Never push. No subagents.


# Notes for this lane from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/ptables`, Hornhoof repo, branch `task-ptables`. Kind: known behaviour, test-first as each plan says. No database, no process, no clock: these are pure tables, and they are mutator targets at the end of phase 1, so the table of cases matters. Test each row and each boundary on both sides.
- This lane holds three small parts, three commits, one author check on the last. Each has its own brief with the plan's top: `network-build/briefs/ptables-9c3-brief.md`, `ptables-97-brief.md`, `ptables-9c9-brief.md`. Read all three first. "Starts from" lines are paper here: each part goes ahead of its plan because it needs nothing that has not been written.
  1. Plan 9c Task 3, whole: `apps/server/src/modules/keeper/switch-step.ts`, `apps/server/test/switch-step.test.ts`. Write the tables as they are; the rows of plans 10 and 11 come with those tasks.
  2. Plan 9 Task 7, only `apps/server/src/modules/keeper/sync-step.ts`, `apps/server/test/sync-step.test.ts`. `sync.ts`, `slots.ts`, the keeper and `lease-store.ts` stay for that task's own writer. `SyncRecord` has `state, copy, epoch, generation, at`. `hold`'s rows belong to 9c Task 9, not here.
  3. Plan 9c Task 9, only `apps/server/src/modules/keeper/update-steps.ts`, `apps/server/test/update-steps.test.ts`. `UpdaterStatus` is at `modules/updates/control.ts:6`, with no `promise` step today, so in the sample's type write `step: UpdaterStatus['step'] | 'promise'`; that task adds it to the union later and drops the local part. Do not change `control.ts`.
- `Term`, `LeaseKind`, `LeaseSync` are in `apps/server/src/db/net.ts`, below your `lanebase` (Plan 3 Tasks 1 and 2, not landed yet). Use type imports.
- Commit subjects name only the part you wrote when it is a part (2 and 3), since the plan's subject stays for that task's own writer. If a plan's text and the code disagree, stop and say which, with a Ruling line.
- `/* */` comments, as `apps/server` writes them (AGENTS.md: match the code around you).

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 9: Copies, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A computer of the CEO, or of someone who sees the whole company, that is fit to hold the company's data gets
a number in the server order and becomes a copy: it takes the company's secrets, starts its own database, and follows
the leader by Postgres logical replication over the peer link. Once it holds everything, the leader makes it the sync
copy, so a commit is confirmed only once the copy has it, and says so at hornhoof.org; a copy that falls silent is
dropped from sync within seconds and named again once it keeps pace. A copy whose replication breaks makes itself
again beside the old database, which the leader merges before it goes. A machine whose owner loses whole-company
scope stops holding data at once, uploads what it holds through a restricted endpoint when it is back, and then wipes
its database, its plaintext dumps and its secrets.

**Architecture:** One migration, `0055_copies`: the server order's columns and the copy's report columns on
`machines`, `net.pulse` (a row the leader writes each second, so every copy knows how far it reaches), and the merge
sources `machine:` and `upload:` with the machine they come from. On the leader's app, `modules/copies/` decides who
may hold data (`qualify.ts`), numbers the machines and gives the first three the data role (`order.ts`), takes the
data away when a scope is lost (`scope.ts`), hands a new copy the secrets (`routes.ts`) and shows each machine's
place and copy (`view.ts`); plan 8's merger reads a copy's old database over the peer link (`peerSource`) and an
uploaded one on the leader. The keeper gains a third kind, the follow
keeper (`modules/keeper/follow.ts`), for a data machine that does not lead: it is a worker's keeper with a database,
which makes and remakes the copy (`copy.ts`) and opens a local door to the leader's database (`net/db-door.ts`). The
leading keeper gains the sync controller (`sync.ts`, with its decisions in the pure `sync-step.ts`), the pulse, the
slots, and doors to the copies for merges. The updater gains four requests: become a data machine, load the schema
of a new copy, load an upload, and wipe. The web app shows each machine's number and its copy's state.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:net`, streams); Postgres 17.11 logical and synchronous
replication; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite; `pg`; `age-encryption` 0.3.1 (plan 7);
bash 3.2 and BusyBox for `updater.sh`; Docker Compose profiles; React for the web app; vitest; Docker for `npm run
test:real` (pairs of `linux/amd64` and `linux/arm64` Postgres, the second under QEMU on CI) and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.3 ("Who may hold data", losing whole-company scope, the
server order's columns and what the order decides), 3.4 ("One data machine", fence 1's sync flag, fence 3, fence 4,
"When the relay and the copy are both gone"), 3.7 (all but "Promotion" and "Rejoining"), section 2 ("Joining" and
the copy's lines on the Machines tab), section 4's rows "Copy laptop sleeps, copy disk full, or copy behind" and "The
server is 1, two laptops 2 and 3", section 5 steps 1 to 3 for a returning copy, section 10 ("Secrets", "A stolen
machine" for a data machine) and section 12's bullets on pairs, the lab's writer and checker, and the lost scope.
Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 9's entry. Plan 8, ruling 1 a), b) and d).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in the series' worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/network` on its branch `network`, after plan 8's last task is
committed there. No new worktree: nothing of the series ships until the series merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `people.scope_kind` (`company` or `listed`), `people.is_owner`, `people.status`; `person_access`;
  `machines` (`kind`, `hostname`, `person_id`, `revoked_at`, `created_at`); `PublicLinks` (`modules/link/link.ts`:
  `set`, `remove`); `Machines.tsx`; `apps/web/src/i18n/en.ts` and `ru.ts`.
- Plan 1: the relay client's `route`, `setSync`, `health`, `changeKey`, `visitorKey`; `Route`, `SyncRecord`,
  `SyncPost`, `SyncResult`; the fake relay `apps/server/test/fake-relay.ts` with the sync record.
- Plan 2: compose's `front`, `keeper`, `migrate`, `app`, `db`, `node`, `updater` and `db`'s settings (`wal_level =
  logical`, `max_replication_slots = 10`, `max_wal_senders = 10`); `app` waits for `migrate`
  (`service_completed_successfully`); `KEEPER_PORTS`, `Keeper`, `KeeperOptions`, `keeper.json` (`KEEPER_FILE`),
  `AppMode` (`off` until the first fresh word); `migrate.ts`; `passThrough`, `serve`, `Target`; `TunnelKeeper`;
  `updater.sh` (`handle_request`, `status.json`, `update`, `healthy`).
- Plan 3: `net`, `net_local` (`state`, `lease` with `sync` `copy`, `relay_off` or `alone`), `net.journal`,
  `net.fence_check()`, `net_fence`, `net.assert_lease`; `LeaseStore` (`take`, `renew`, `fence`, `endSessions`,
  `problems`, `prune`), `keeperSql`, `leaseValid`, `nextLeaseStep`, `LEASE_MS`; the keeper's `mode()`; `openPool`,
  `stripSettings`; `test/real/pg.ts` (`realDatabase`, `migrateDb`, `openDb`); `createTestSql`, `setLease`; the fence
  lint (`test/fence-lint.test.ts`).
- Plan 4: `applied`, `tool_calls`; `KEEPER_HOLD_MS`; `front` stamping tool calls.
- Plan 5: `issueCertificate`, `certFacts`, `MachineRole` (`data`, `worker`); `thisMachine`, `findThisMachine`,
  `revokedSerials`, `peerSecret`; `networkRoutes` (`POST /api/network/certificate`, `GET /api/network/peers`, `POST
  /api/network/report`); `askerOf`, `VIA`; the leader's own hidden `server:<machine id>` row; `PeerServer` (`hello`,
  `CONNECT app:8080`, `CONNECT db:5432` on a `peer` listener for a `data` certificate), `PeerDoor`, `APP_AUTHORITY`,
  `DB_AUTHORITY`; `peerClientFor`, `serviceName`, `PeerServices` (the `-data` and `-app` stcp services); the keeper's
  `Measures` (`fsync_p99_ms`, `disk_free`, `uptime_s`), `CertificateKeeper`, `machineKey`; `LeaseStore.othersHoldData()`
  and the check that no lease is taken or renewed with sync `alone` while another data machine is listed.
- Plan 5b: `WorkerKeeper`, `workerConfig`, `WorkerView` (`role`, `data`, `link`), `DataMachine`, `workerView`,
  `PEERS_FILE`; `PeerLink` (`use`, `leader`, `request`, `connectApp`, `state`), `DialTarget`; `visitConfigFor`,
  `visitClientFor`; `keeperAsker`, `KEEPER_MARK`; `lockLiveMachine`, `revokeMachineRows`, `dropPeerSecrets`,
  `visitorKeyOf`, `disconnectMachines`; `onlineShare`; `compose.worker.yaml` (`db`, `migrate`, `app`, `node` in the
  profile `data`); a worker's `.env` (`COMPOSE_FILE=compose.yaml:compose.worker.yaml`, `HORNHOOF_ROLE=worker`,
  `HORNHOOF_JOIN_SERVER`, `HORNHOOF_MACHINE_ID`); `updater.sh`'s worker mode; the lab (`npm run test:lab`,
  `test/lab/`).
- Plan 6: `machine_access`; the keeper's part that keeps a machine's computer access, run by `WorkerKeeper`.
- Plan 7: `machines.age_key`, `ageKey(dir)`, `BundleSecrets` (`HORNHOOF_SECRET`, `NODE_KEY`, `RELAY_URL`) and the
  rule `updater.sh` checks each with before it writes it into `.env`; `PeerLink.stream`; the leader's peer paths
  `/peer/backups/<id>`; `HolderKeeper`; `dump.json` and `dumps/`; `owned`; `cutover.sql`; `recovery_keys` and
  `linkPrint` (a changed link key retires the recovery key's match and raises the banner); `disablePerson`.
- Plan 8: `MergeSource`, `keptSource`, `sourceUrl`, `KEPT_NAME` (`modules/merge/source.ts`, the one file the fence
  lint lets open a client beside its three); `runMerge`, `MergeResult` (`apply.ts`); `complete` (`check.ts`); `A`,
  `B`, `S` and the cutoff (its rulings 4 and 5); `Merger` (`discover`, `tick`, `pending`), `KeptDatabases`
  (`merger.ts`, `kept.ts`, tested in `merge-kept.test.ts`); `net.merges` (`source` checked `^(kept|machine):.+$`,
  `fork`, `status` `pending`, `applied`, `merged`, `removing` or `done`), `net.restores`, `net.horizon`; the fork
  bundle through `dump.json` with a database's name; `rules.ts` and its never-compared columns; `LeaseStore.prune`
  with its conditions (ruling 14).
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and passwords made at run time.
- No new npm dependency. One new migration, `0055_copies`: `npx drizzle-kit generate --name copies` from
  `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1 appended after a `-->
  statement-breakpoint`; never an edit of an older one.
- A worker holds no company secret and no database (plan 5b). A data machine holds `HORNHOOF_SECRET`, `NODE_KEY`,
  `RELAY_URL`, its own `POSTGRES_PASSWORD`, both stcp secrets and the whole database (spec section 10). A secret never
  goes into a log line, an answer other than the one sealed to its machine, or a file outside `.env`, the keeper's
  volume, the replica's passfile in the `db` volume (ruling 7) and a control file of mode 0600 that is removed once
  read.
- A copy never writes the company's tables: its keeper takes no lease, runs no link frpc and never sets its app to
  `lead`; only its apply worker writes, as `session_replication_role = replica`.
- No database is thrown away before it is merged (spec 3.7): a copy's old database goes only after the leader's merge
  of it is `merged`, or `done` by ruling 15; an upload, and the machine's database it came from, only after the
  upload's merge is `merged` and its fork bundle recorded.
- Messages between keepers and apps change only by additions (spec section 9); a field a keeper of plan 8's build
  does not send keeps what it had.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  Everything here happens by itself: a machine becomes a copy, a copy is remade, a lost scope is wiped.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.
- Before a real or lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and
  `hornhoof-lab/*` images, never a volume.


# Quality rules (from the team lead, 2026-11-03)

These come after the plan's Global Constraints. Where they disagree, the plan's Global Constraints and the build rulings win: no prettier and no formatter (black, isort, ruff format are not run), the plan's file layout, the plan's names, the plan's test framework.
"Commit and Push" and "Push your branch" below do not apply to you: the build lead commits, nobody pushes. The gates crapper and dryer run on every task, on the changed code, through the commands in the task notes. Mutator runs once, at the end of phase 1, on the riskiest pure logic with its fast tests only, by the lead: writers do not run it (Ivan's word). No chasing of coverage: the rules below on crapper are met by splitting first.
For Hornhoof that means: vitest as the tests are written today, the code style of the file you change, no new dependency unless the task names it.

## Engineering rules (ub-mode), word for word

Every time you are asked to make a change follow:
* First Make it Work.
* Then Make it Right.
* Follow Practice

### First Make it Work

#### Laziness Protocol

* One decision lives in one place.
* Ship the smallest edit that solves the problem.

#### Foundational Thinking

* Get the data shape right before you write the logic.
* Do first whatever helps every later phase.
* If a concurrent writer would matter, do not share state.

#### TDD

* Write the failing test before you change the code.
* See it fail for the reason you expect.
* Make the smallest change that makes it pass.
* If an honest test is impractical, do not write a bad one.

#### Redesign From First Principles

* Do not bolt a new requirement onto the old design.
* Ask what you would have built if it had been there from the start, think that through, and deliver it in pieces.

#### Attack the Premise

* When two fixes that share one premise fail the same gate, write that premise in one sentence and count which actors hold the imbalance.
* Remove the assignment.
* Do not start another fix until you have done that.

#### Subtract Before You Add

* Take complexity out before you add anything.

#### Outcome-Oriented Execution

* Aim at the end state you can check.
* A break in the middle is allowed when you planned it and can undo it.

#### Build the Lever

* If the work is not obvious at a glance, build the tool that does it.
* Do one unit by hand, then make the tool match that unit.

#### Architecture

##### Model the Domain

* Put the domain in a structure that makes the illegal states impossible.
* Maintain a glossary of domain terms.
* If the code is already clear and local, leave it.

##### Boundary Discipline

* Check the data where it enters.
* Inside, trust it.
* Keep the business logic in a pure function.

##### Type System Discipline

* Make the illegal value impossible to write.
* Parse outside data once, where it comes in.
* Do not silence the compiler.

##### Make Operations Idempotent

* Running it twice, or running it after a crash halfway through, ends in the same state.

##### Separate Before Serializing Shared State

* If they do not need the same mutable thing, give each its own.
* If they do, allow one writer, and enforce that in the structure.

### Then Make it Right

#### Fix Root Causes

* Reproduce it.
* Fix the cause.
* A guard that only hides the crash is not a fix.

#### Sequence work into verifiable units

* Finish one small unit and check it.
* Then start the next.

#### Test Behavior, Not Implementation

* The test calls the code the way its user does and checks the result that user would see.
* If the test would still pass when every function returned nothing, throw it out.

#### Crapper

* Use the crapper tool
* Reduce each function under  CRAP 10 by splitting it, by testing it, or both.
* Consider whether case statements are worth reducing.

#### Dryer

* Use the dryer tool to eliminate duplication that rank 0.8 or above.

#### Mutator

* Use the mutator tool
* Cover the uncovered.
* Kill the survivors.
* Delete dead code.

#### Refactoring

* Pin what the code does.
* Change the structure.
* Prove the behavior did not change.

### Practice

#### Keep a Log

* Keep a log of every action you take and the reason you took it.
* Report that log upon completion.

#### Guard the Context Window

* Keep the main thread small.
* Send the bulk elsewhere, and keep the summary.

#### Worktree Cleanup

* Find what is safe to remove, confirm nothing still in use needs it, then reclaim the disk.
* Uncommitted work waits for a decision.

#### Commit and Push

* Commit often, in small ordered commits.
* Each commit says why, what changed, and how you proved it.
* Push to the main line at the end.

### In Hornhoof

* crapper, dryer and mutator are installed on your machine. Run them from the repository root on the files your branch changed, `git diff --name-only --diff-filter=d <main line>...HEAD`: `--changed` sees only uncommitted files. Their coverage comes from the project's own test tools; install what is missing in your home folder.
* Push your branch, not the main line: the main line takes it after the gates and the CEO's approval.

## ECC typescript rules

### coding-style.md
# TypeScript/JavaScript Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with TypeScript/JavaScript specific content.

## Types and Interfaces

Use types to make public APIs, shared models, and component props explicit, readable, and reusable.

### Public APIs

- Add parameter and return types to exported functions, shared utilities, and public class methods
- Let TypeScript infer obvious local variable types
- Extract repeated inline object shapes into named types or interfaces

```typescript
// WRONG: Exported function without explicit types
export function formatUser(user) {
  return `${user.firstName} ${user.lastName}`
}

// CORRECT: Explicit types on public APIs
interface User {
  firstName: string
  lastName: string
}

export function formatUser(user: User): string {
  return `${user.firstName} ${user.lastName}`
}
```

### Interfaces vs. Type Aliases

- Use `interface` for object shapes that may be extended or implemented
- Use `type` for unions, intersections, tuples, mapped types, and utility types
- Prefer string literal unions over `enum` unless an `enum` is required for interoperability

```typescript
interface User {
  id: string
  email: string
}

type UserRole = 'admin' | 'member'
type UserWithRole = User & {
  role: UserRole
}
```

### Avoid `any`

- Avoid `any` in application code
- Use `unknown` for external or untrusted input, then narrow it safely
- Use generics when a value's type depends on the caller

```typescript
// WRONG: any removes type safety
function getErrorMessage(error: any) {
  return error.message
}

// CORRECT: unknown forces safe narrowing
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}
```

### React Props

- Define component props with a named `interface` or `type`
- Type callback props explicitly
- Do not use `React.FC` unless there is a specific reason to do so

```typescript
interface User {
  id: string
  email: string
}

interface UserCardProps {
  user: User
  onSelect: (id: string) => void
}

function UserCard({ user, onSelect }: UserCardProps) {
  return <button onClick={() => onSelect(user.id)}>{user.email}</button>
}
```

### JavaScript Files

- In `.js` and `.jsx` files, use JSDoc when types improve clarity and a TypeScript migration is not practical
- Keep JSDoc aligned with runtime behavior

```javascript
/**
 * @param {{ firstName: string, lastName: string }} user
 * @returns {string}
 */
export function formatUser(user) {
  return `${user.firstName} ${user.lastName}`
}
```

## Immutability

Use spread operator for immutable updates:

```typescript
interface User {
  id: string
  name: string
}

// WRONG: Mutation
function updateUser(user: User, name: string): User {
  user.name = name // MUTATION!
  return user
}

// CORRECT: Immutability
function updateUser(user: Readonly<User>, name: string): User {
  return {
    ...user,
    name
  }
}
```

## Error Handling

Use async/await with try-catch and narrow unknown errors safely:

```typescript
interface User {
  id: string
  email: string
}

declare function riskyOperation(userId: string): Promise<User>

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}

const logger = {
  error: (message: string, error: unknown) => {
    // Replace with your production logger (for example, pino or winston).
  }
}

async function loadUser(userId: string): Promise<User> {
  try {
    const result = await riskyOperation(userId)
    return result
  } catch (error: unknown) {
    logger.error('Operation failed', error)
    throw new Error(getErrorMessage(error))
  }
}
```

## Input Validation

Use Zod for schema-based validation and infer types from the schema:

```typescript
import { z } from 'zod'

const userSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})

type UserInput = z.infer<typeof userSchema>

const validated: UserInput = userSchema.parse(input)
```

## Console.log

- No `console.log` statements in production code
- Use proper logging libraries instead
- See hooks for automatic detection

### patterns.md
# TypeScript/JavaScript Patterns

> This file extends [common/patterns.md](../common/patterns.md) with TypeScript/JavaScript specific content.

## API Response Format

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: {
    total: number
    page: number
    limit: number
  }
}
```

## Custom Hooks Pattern

```typescript
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}
```

## Repository Pattern

```typescript
interface Repository<T> {
  findAll(filters?: Filters): Promise<T[]>
  findById(id: string): Promise<T | null>
  create(data: CreateDto): Promise<T>
  update(id: string, data: UpdateDto): Promise<T>
  delete(id: string): Promise<void>
}
```

### security.md
# TypeScript/JavaScript Security

> This file extends [common/security.md](../common/security.md) with TypeScript/JavaScript specific content.

## Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const apiKey = process.env.API_KEY

if (!apiKey) {
  throw new Error('API_KEY not configured')
}
```

## Agent Support

- Use **security-reviewer** skill for comprehensive security audits

### testing.md
# TypeScript/JavaScript Testing

> This file extends [common/testing.md](../common/testing.md) with TypeScript/JavaScript specific content.

## E2E Testing

Use **Playwright** as the E2E testing framework for critical user flows.

## Agent Support

- **e2e-runner** - Playwright E2E testing specialist

## Rulings made while planning

1. **Plan 9 is three plans; this is the first.** (The team lead approved the split on 2026-11-03: 9 Copies, 9b The
   server order, 9c The planned switch and updates across machines, all on the `network` branch.) The overview's plan 9
   holds copies, the server order and the planned switch with updates across machines. This plan, 9, makes copies and
   keeps them in sync. Plan 9b brings the score and its measurements, the daily ranking, pins, "Does not take the
   server" and its refusals, `server_why` for numbers from 2, the copy handed over when the ranking changes, and section
   2's whole Priority row and sortable column. Plan 9c brings "Move the server here" (3.4 "Planned switch") with 3.7's
   promotion and sequences, section 9's updates across machines (the promise, the slot wait before the dump, sync off
   for migrations, rollback with slots, copies remaking after migrations), the built-in node's identity per machine
   (plan 4's ruling 9, which a copy's own node needs; until then a copy runs no built-in node), and the relay's traffic
   counter with its runbook line. Plan 10 keeps proofs (a) and (b), the heartbeats and the takeover. Until 9c, an update
   of the leader that changes the schema makes each copy make itself again (ruling 14: it sees the leader's count of
   migrations differ from its own), and a copy whose subscription stopped first is dropped from sync within seconds
   (ruling 9).
2. **What this plan does of the server order.** It adds the three columns of spec 3.3 and numbers the machines by the
   spec's ties alone, since the score is 9b's: 1 is the leader; then the machines that hold a copy, then the rest that
   qualify (ruling 3), each group by the CEO's machines, then whole-company people's, then the older `created_at`.
   Numbers 2 and 3 get the data role; from 4 on a machine works. A machine holding a copy keeps its place ahead of those
   without one, so no ranking here ever takes a copy away: a copy goes only with its scope (ruling 10), its row
   (Disconnect) or plan 9b's handover. A data row whose person no longer passes the scope check of ruling 3 (a restore
   of an older bundle can bring one back, ruling 21) is not ranked: the ranking takes its data away as ruling 10 does.
   `server_why` holds a key the card turns into words: `server` on 1 ("The company server runs here."), `next` from 4
   ("Gets a copy if one of the first three leaves."), null on 2 and 3 until 9b. `server_pin` is added and stays null.
   The ranking runs at the app's first lead, every minute while it leads, and at once after a scope change of a person
   or a Disconnect; it writes only rows whose values change, in one transaction.
3. **Who may hold data** (spec 3.3), checked in this order, the first failure being the machine's reason: a live row of
   `kind` `computer` (else "it is a phone"); with a core, `network_id` set, or the leader's own `server:` row (else
   "Hornhoof runs here without Docker"); its person active and the CEO (`is_owner`) or `scope_kind` `company` (else the
   scope line); a public link of the company (else ruling 18's line); a report within the last 2 minutes with `memory`,
   `disk_free` and `fsync_p99_ms` (else "measuring"); `memory` at least 3.5 GiB; `disk_free` at least 3 times the
   leader's database (`pg_database_size`, read by the ranking) plus 10 GiB; `fsync_p99_ms` under 50. The spec says
   Docker "gets 4 GB of memory or more": a Linux VM given 4 GB reports a little less as its total, so 3.5 GiB is the
   line (deviation in form). The keeper reports `memory` as `os.totalmem()` and `cores` as `os.availableParallelism()`,
   both inside its container, which on a Mac is Docker's VM. A machine that holds a copy and later fails a measure keeps
   it until 9b hands it over; one that fails the scope check loses it at once (ruling 10).
4. **A copy is a data machine that follows.** It has the role `data`, a `data` certificate, the secrets of
   `BundleSecrets`, its own `POSTGRES_PASSWORD`, and runs `db` and `app` from the profile `data`. `compose.worker.yaml`
   moves `node` to a profile of its own, `builtin`, which no `.env` of this plan names (ruling 1). Its keeper is the
   follow keeper: the worker's keeper of plan 5b (certificate by the peer link and by signed renewal, the view, the
   front door to the leader's app, the reports, computer access, the holder) with a database, a peer server, the peer
   frpc of its own `-data` and `-app` services, and the copy maker. It never takes a lease, never runs the link frpc,
   and writes `keeper.json` with the mode `off` while its database is being made or swapped and `read` otherwise; with
   no leader reachable for 60 s its front door passes to its own app, which reads (spec 3.9). Which keeper runs is
   chosen at its start: `HORNHOOF_ROLE=worker`, the worker's; else, while the control folder holds `replica.json` or
   its database has an enabled subscription, the follow keeper; else the leading keeper as before. The keeper's
   environment carries `HORNHOOF_ROLE` (plan 5b), so the `up` that makes a worker a data machine, or a data machine a
   worker again, starts it anew as the other kind. `migrate` does nothing and exits 0 while `replica.json` is there
   ("This machine keeps a copy; its schema comes from the company server."), so the `app`'s wait for it never
   migrates a copy; the updater updates such a machine as a worker (no backup, no migrations, its turn waited for)
   until 9c brings a copy's own order. The app's grants for its agent roles are per database and not copied, so with
   a keeper the app runs them on each change of its mode from `off`, not at its start.
5. **Becoming a copy.** The ranking sets the role `data` on the row. The worker's keeper sees it in its view, asks for a
   new certificate (plan 5's route issues the row's role), and with it `POST /api/network/secrets`, which answers the
   three secrets sealed with age to the row's `age_key`, only to a live row of the role `data` whose certificate it is
   and whose person passes ruling 3's scope check; plan 5's certificate route likewise issues a `data` certificate only
   to such a row, and a `worker` one otherwise. Only a worker's keeper does this, and never while `role.json` or
   `replica.json` is there. The keeper opens them, writes `replica.json` and then `role.json` (`{ id, secrets }`, 0600)
   into the control folder, and the updater's `become_data` writes `.env`: the three secrets (checked as plan 7 checks
   them), `POSTGRES_PASSWORD` (24 random alphanumerics when the line is missing or empty), `HORNHOOF_ROLE=data` and
   `COMPOSE_PROFILES=data`; removes `role.json`; and runs `up -d --no-build` of every service but itself with
   `HORNHOOF_ROLE=data` in compose's own environment (the updater's environment holds the role it was started with,
   which would else win over `.env`), then replaces itself from the image it runs. A failed check or a failed `up` puts
   the `.env` of before back, removes `role.json` and `replica.json`, stops `db`, `migrate` and `app`, starts `front`
   and `keeper` again as a worker's, and writes `role.failed` with one line ("The company's settings cannot be written
   here, so this machine stays a worker."), which the card shows as the copy's state; the keeper tries again an hour
   later. `.env.before-data`, kept until the end, lets an updater that restarted in the middle finish or undo it.
6. **The data link.** A data machine reaches another's `db` through `CONNECT db:5432` on the peer link, directly or
   through that machine's `-data` stcp service, whose secret only data machines get (spec 3.2); `visitConfigFor` takes
   `-data` targets with that secret for a data machine, whose peer link then dials through them. Postgres never sees
   the peer link itself: the keeper opens a door, a TCP listener on its container, whose every connection becomes one
   `CONNECT db` stream. The follow keeper's door, `KEEPER_PORTS.db` (7432), leads to the leader's `db`, and the copy's
   `db` connects to `keeper:7432` for the schema and the subscription. The leading keeper opens a door to a copy's
   `db` while its app asks for one, on a port of its choice named in `keeper.json` (`doors`). A door takes connections
   only from the addresses `db` and `app` resolve to, looked up each minute. The copy and a merge connect as
   `hornhoof_replica` (`LOGIN REPLICATION BYPASSRLS`, `USAGE` and `SELECT` on `public`, `net`, `net_local` and
   `drizzle` and on their tables now and later, nothing else), whose password is `replicaPassword(secret)`, base64url
   of HMAC-SHA256 keyed by the company secret's bytes (as `loadConfig` decodes them) over `hornhoof-replica`, so every
   data machine knows it and none stores it. `BYPASSRLS`, since the tables plan 5 hides keep row level security with
   no policy, and a copy would else get them empty. The password is set as a SCRAM-SHA-256 verifier the keeper
   computes, on a connection closed right after, so no statement, log line or `pg_stat_activity` row holds it; the
   subscription reads it from a passfile in the `db` volume (ruling 7). The role is cluster-wide but its grants are
   per database, so each keeper checks, each minute, that the role exists and has `USAGE` on each of the four schemas
   its database has (`has_schema_privilege`), and grants in full when not; the follow keeper also right after a
   schema load and after a swap. Every table of `public` and `net` has a primary key, or the publication would refuse
   the leader's updates of it; Task 4's test holds that. (Deviation in form: the spec names no role for this.)
7. **A new copy** (spec 3.7). The copy maker asks its updater with `schema.json` (`{ attempt, database, port, password
   }`, 0600). The updater runs, in `db`, `pg_dump --schema-only --no-owner --no-publications --no-subscriptions
   --no-privileges` of the leader through `keeper:7432` and `pg_dump --data-only --table=drizzle.__drizzle_migrations`,
   both into one file, then loads it into the database named with `psql -1 -v ON_ERROR_STOP=1`, which must hold no
   table in `public` first; writes the replica's passfile `<PGDATA>/replica.pgpass` (0600, the `postgres` user's); and
   writes `schema/<attempt>.done` or `.failed`. Then the maker grants the replica role in that database (ruling 6),
   sets `wal_receiver_status_interval = 1s` (by `ALTER SYSTEM` and a reload) and makes the subscription `copy_<the
   first 16 hex of its network id>_<attempt number>`, to the publication `hornhoof`, with `copy_data = true`,
   `synchronous_commit = 'local'`, `binary = false`, `streaming = off` and `disable_on_error = true`, connecting to
   `host=keeper port=7432 dbname=hornhoof user=hornhoof_replica passfile=<that file>`; its name is its slot's and its
   application name. A failed attempt is given up whole before the next, 10 minutes later with the next number, so a
   slot name is never used twice: its subscription disabled, detached (`slot_name = NONE`) and dropped, then its
   database dropped when it holds no `net_local.state` row (ruling 12). The leader drops the detached slots (ruling
   13). The leading keeper keeps the publication `FOR TABLES IN SCHEMA public, net` (made once, when missing). The copy
   is finished when every row of `pg_subscription_rel` is `r`; its progress until then is its database's size over the
   leader's, at most 99. It keeps the count of migrations its schema came with; each view carries the leader's
   (ruling 14).
8. **The pulse.** While another data machine is listed, the leading keeper writes `net.pulse` (`at`
   `clock_timestamp()`) every second with `synchronous_commit = local`, so published WAL flows even when the company
   is idle, every copy confirms its position each second, and each copy knows in the leader's clock how far it
   reaches: its report's `copyAt` is its `net.pulse.at`. `net.pulse` has the fence trigger as every `net` table; the
   keeper's session passes it as before.
9. **Synchronous replication and the sync record** (spec 3.4 fence 3, 3.7). The leading keeper's sync controller
   samples every 250 ms and decides with the pure `nextSyncStep` (Task 7 has its table):
   - With no other data machine listed: sync `alone`. When one is listed, it first posts "sync off" (epoch one above
     the record's, at its own route's generation) and goes on with `relay_off` once the relay stored it.
   - A copy keeps pace while its slot's `confirmed_flush_lsn` is at or past the leader's WAL position of 1 s before.
     The lowest-numbered copy that finished and has kept pace for 30 s is named: `synchronous_standby_names = 'FIRST 1
     ("<its name>")'` by `ALTER SYSTEM` and a reload. A reload does not say when commits start to wait: backends
     decide by a flag the checkpointer sets once it has read the new setting. So the setting counts only after a
     barrier: its walsender shows `sync_state` `sync`, then a `CHECKPOINT` ends, which the checkpointer runs only after
     the reload it was signalled before. Then the WAL position W is read, and once the slot confirmed W, "sync on"
     naming the copy's network id, at its own route's generation.
   - A named copy is silent when no new `reply_time` came from its walsender for 2 s, timed by the leader's own
     monotonic clock from when it last saw the value change (the value is the copy's clock, which may be off by
     seconds), or when its walsender is gone; or when for 5 s every sample saw a commit waiting on it (`wait_event`
     `SyncRep`) for over 1 s while the copy's `CONNECT db` streams carried under 1 MB in those 5 s. The spec's "commits
     under 1 MB" is read by what the keeper can see: a big file moving to the copy is bytes on its streams, so it does
     not count; a big transfer slower than 1 MB in 5 s does count as silent, and other traffic on the streams can keep
     a slow copy named (deviation in form, both accepted). Then "sync off", and once the relay stored it,
     `synchronous_standby_names` cleared.
   - A lower-numbered finished copy that kept pace for 30 s, or a named copy that is no longer a copy, is replaced
     through "sync off" in the same way, then named.
   - After its route's generation changes (the link frpc registered again), it posts its state again at the new
     generation; until the relay stored it, `relay_off` does not count.
   - The lease's sync flag is `copy` while `synchronous_standby_names` is set (no commit returns until the copy it
     names has it, once the barrier passed; before it the relay still holds "off"), `relay_off` while it is not and the
     relay holds "off" at the current generation, `alone` with no other data machine, and null otherwise; `mode()`
     says `lead` only with a flag. A keeper that starts reads the record and the setting it finds, runs the barrier
     again, and clears the setting only after "off" is stored.
10. **Losing whole-company scope** (spec 3.3). First, before anything new is written, each live machine of the person
    with the role `data` is cut from the leader's WAL: its walsender ended and its slot dropped (tried for up to 5 s,
    since its subscription may reconnect in between; else 503 "Try again in a minute."), so no row written after this,
    a new key above all, can reach it; a named sync copy makes the commits below wait until the controller has posted
    "off" and cleared it (ruling 9). Then, in the transaction of `PATCH /api/people/:id` that turns the person's
    `scope_kind` from `company` to `listed`, for each of those machines: `server_order` null, the role `worker`,
    `data_left_at` now, `upload_state` `waiting`, its certificates revoked, and `dropPeerSecrets`; after it commits,
    the link key changed (ruling 20), which retires the recovery key's match and raises plan 7's banner (the spec's
    renewed recovery pair), the visitor key renewed (`visitorKeyOf` with `force`), and the ranking run. The person's
    own leading machine is refused first: 409 `leader_scope` "<machine> runs the company server. Move the server to
    another machine first." until 9c brings the move. The ranking does the same for a data row whose person fails the
    scope check for any other reason (ruling 2). A disabled person's machines are disconnected as today (plan 5b), and
    a Disconnect of a data machine now cuts it the same way first, sets its `data_left_at`, and changes the link key
    (spec section 10), so it leaves holding nothing that opens the company's link. The card of a machine that left
    says "Stopped holding the company's data on <date>. If it may be in other hands, change the company secret and the
    API keys." (spec: "The card then offers a new company secret and API keys as the CEO's choice"; a line, as plan
    5b's Disconnect card).
11. **The upload and the wipe** (plan 8's 1b, spec 3.3). A machine whose row says `upload_state` `waiting` learns it
    from its view, or by its signed renewal once its `data` certificate is refused. Its follow keeper sets its mode
    `off`, disables its subscriptions at once, and asks its updater for an upload (`upload.json`): each table of
    `public`, `net` and `net_local` as CSV with a header (`COPY ... TO STDOUT (FORMAT csv, HEADER true)`), one file a
    table, in one gzip tar. The keeper puts it through `PeerLink.stream('PUT', '/peer/upload/<id>')` with its worker
    certificate. That path is the restricted keeper endpoint: the leading keeper's peer server takes it only from a
    machine its app names in `uploads` (rows `waiting`), one at a time, at most 3 times the leader's database plus 1
    GiB, into `/control/uploads/` (0600), and writes `load.json` for its updater. The updater never runs SQL that came
    from the machine: it unpacks at most 4 times the leader's database plus 1 GiB, takes only files named
    `<schema>.<table>.csv` for tables the leader has, makes `hornhoof_uploading_<first 16 hex of the network
    id>_<stamp>` with the leader's own schema, loads each file by `\copy` with the header's columns checked against that
    table, as data alone, under `session_replication_role = replica`, in one transaction, then renames the database
    `hornhoof_upload_...`; a failure drops it, and the machine, still `waiting`, uploads again 10 minutes later. The
    merger takes such a database as a source `upload:<name>`, with a fork bundle as plan 8 makes one for a kept
    database. The row goes `received` once the database exists and `kept` once that merge is `merged` (plan 8's
    completion check, spec 3.7) and its fork bundle is in `net.backups`; then the machine's view says `wipe` and its
    keeper writes `wipe.json`. The updater's wipe keeps `wipe.json` until every step is done, so a step that fails is
    tried again a minute later, also after a restart: it refuses a database with a `net_local.state` row (ruling 12),
    stops `db`, `migrate` and `app`, removes the database volume, `dumps/`, `restore/`, `schema/`, `uploads/`, the
    updater's own dumps, `replica.json` and the copy's files, and only then empties `HORNHOOF_SECRET`, `NODE_KEY`,
    `RELAY_URL` and `POSTGRES_PASSWORD`, removes `COMPOSE_PROFILES`, writes `HORNHOOF_ROLE=worker`, runs `up -d
    --no-build --remove-orphans` with that role in compose's environment, and writes `wiped.json` last; its role check
    then replaces the updater itself (ruling 5). The worker keeper's next report says `wiped`, and the row's
    `upload_state` becomes null; a worker's keeper, which holds no database, answers an upload request with `wiped` at
    once. It never receives anything new: it was cut from the WAL first (ruling 10), its certificate is a worker's, and
    its subscriptions were disabled. A `hornhoof_next` being made goes with the volume: it was read from the leader
    after the old one stopped, and never wrote. (Deviation in form: the spec says "uploading its database's unmerged
    rows"; it uploads every row and the merge finds what is unmerged, so the machine needs to know nothing of the
    leader's journal.)
12. **A returning copy, section 5 steps 1 and 2** (plan 8's 1d). Step 1 holds by construction: a follow keeper is
    fenced (no lease), its app reads, and it runs no link frpc. Step 2's bundle is needed only by a machine that wrote,
    which in this plan none does, since no copy ever leads before plan 9c. So the guard alone is here: a database
    whose `net_local.state` has a row (it once held a term) is never dropped by this plan's remake, swap or wipe; the
    card says "Copy: stopped" and the database stays until plan 10, which brings the old leader's return and its
    bundle, signed by a data machine that is not the leader, and says what becomes of such a copy (its entry in the
    overview). (Deviation, approved by the team lead on 2026-11-03.)
13. **Slots and WAL.** The leading keeper sets `max_slot_wal_keep_size` to the smaller of 20 GB and a quarter of its
    volume's free disk, in whole MB, by `ALTER SYSTEM` and a reload, at its first lead and every hour. Every minute it
    drops each slot `copy_<16 hex>_<n>` that no live row of the role `data` has those 16 hex for, or whose `n` is below
    the attempt in that row's reported `copy_name`, ending its walsender first; a slot of a later attempt than the
    report waits for the next report. A table sync slot (`pg_%_sync_%`) that has been inactive for 10 minutes in a row
    is dropped too: the attempt that made it was given up, or its copy sleeps and will make itself again. Other names
    are left alone. A slot whose `wal_status` is `lost` is reported to its copy, which makes itself again (ruling 14).
14. **Remaking into a side database** (spec 3.7). A copy makes itself again when the leader lists its slot `lost`, or no
    longer lists a slot it listed before, two views in a row, or when its subscription stopped on an error (`subenabled`
    false) and an `ENABLE` did not hold for 10 minutes, or when the leader's count of migrations is not the one its
    schema came with. It disables the old subscription and detaches it from its slot (`slot_name = NONE`), so the leader
    drops that slot (ruling 13), and makes a new copy into `hornhoof_next`, with the next attempt number, as ruling 7,
    while the old `hornhoof` goes on being read. Once that copy finished, it reports `old: { attempt }`; the leader's
    merger makes a merge `machine:<machine id>:<attempt>` and reads the copy's `hornhoof` through a door (ruling 6) as a
    `MergeSource` (`peerSource`); when that merge is `merged` (or `done`, ruling 15) the copy's view says so, and the
    copy swaps: `off`, the new subscription disabled, `hornhoof` renamed `hornhoof_old_<stamp>` and `hornhoof_next`
    renamed `hornhoof`, the new subscription enabled, the old one dropped, the old database dropped, the replica role's
    grants made on the new one, `read`. Each step is written to `<keeper dir>/copy-state.json` first, and a keeper that
    starts finishes a swap it finds half done. The leader drops the old slot by ruling 13.
15. **A copy's old database costs one id-set read** (spec 3.7: "A copy that never wrote still runs the compare; usually
    it finds nothing, at the cost of one id-set read"). For a `machine:` or `upload:` source whose `net_local.state` has
    no row (it never wrote) and that lacks no restore the leader has, the merge is `merged` once every journal id of the
    source at or after the leader's own horizon is on the leader or consumed, the source has no open conflict, and no
    `net.backups` row of it is missing on the leader. Every row of a copy that never wrote came from the leader with its
    journal row in the same transaction, so what it holds that the leader lacks is what the leader deleted since; ids
    older than the leader's horizon are the leader's own pruned history. This check reads only `net.journal`'s ids,
    `net.merge_consumed`, `net.backups`, `net.merge_conflicts`, `net.restores`, `net_local.state` and the leader's
    `net.merges` and `net.horizon`, by column, so it runs before plan 8's check that both sides have the same shape, and
    a copy of an older schema merges. Any other source goes plan 8's whole way. (Deviation, approved by the team lead on
    2026-11-03: plan 8 reads every row of a source, which for a copy across homes would cross hornhoof.org once more.) A
    restore is the one way the leader loses rows it did not delete itself, so a source that lacks a restore the leader
    has is compared row by row, as section 12 says, with one exception: when the CEO left out that restore's kept
    database (its merge has a `fork`, was never `merged`, and is `removing` or `done`), a copy that never wrote holds
    nothing that database did not hold, and its merge is `done` with the line "Left out with the database from before
    the restore of <time>.", so the CEO's choice is not undone by a copy. A kept database left out because it held no
    company (a total loss) does not count: the copy then compares, and brings back what only it held.
16. **The copy's lines** (section 2 and section 4's rows). A copy's state on its card, from the leader's view of its
    slot and its last report: "being made, <p>%", "being made again, <p>%", "up to date" (named sync, or keeping pace),
    "catching up" (connected, under a minute behind, not yet keeping pace), "<n> min behind" (connected, over a minute
    behind), "asleep since <time>" (no walsender, or no report for 2 minutes; the time is its `copyAt`), "stopped: disk
    full" (its report says so: its subscription stopped with under 1 GiB free), "stopped: the company's settings cannot
    be written here" (ruling 5), "stopped". The tab says "<leader> leads. <copy> keeps a copy and takes over if <leader>
    stops." (two copies: "<a> and <b> keep copies; <sync or a> takes over if <leader> stops."), and, while no copy is
    named sync or keeping pace and one has existed, "Only <leader> holds changes since <time>", the newest `copyAt` of
    the copies. The tab says "takes over" as the spec does: plan 10 makes it so, and nothing of the series ships before
    it.
17. **The lease renews as on one machine until plan 10** (deviation, approved by the team lead on 2026-11-03). Proofs
    (a) and (b) come with plan 10's takeover, and before it no copy takes over, so a lease renewed without proof cannot
    meet another leader. One rule of the spec is kept now: while a commit has waited on a silent copy for 10 s and the
    relay has not stored "off", the keeper stops renewing, so the lease ends, fence 4 ends the waiting sessions and
    their callers get an error (spec 3.4: "the leader fences after L and its commits wait"). It renews again once the
    relay stored "off" or the copy answers, and not before: ending the waiting sessions does not count, or each new
    lease would wait out the same 10 s again. Going on under a split term after 2 minutes (3.6) is plan 10's. Plan 3's
    ruling 6 is here too: at lease end with another data machine listed, the keeper stops its link frpc; it starts it
    again 30 s later while it does not lead, so it can hold its route and get "off" stored, which it needs to lead again
    (no copy takes the name over before plan 10, which sets that wait).
18. **Copies need the company's link** (deviation, approved by the team lead on 2026-11-03). The sync record lives at
    the link's name. The spec gives a company without a public link a hidden name; that, and a takeover by it, are plan
    10's. Here a company with no link gives no machine a copy, every qualifying machine's reason being "the company has
    no link at hornhoof.org; turn it on in Settings", and `PublicLinks.remove` is refused while another data machine is
    listed (409 `link_needed` "Machines keep copies of the company through its link, so it stays."). A rename keeps
    working: the controller follows the link's name and posts its state there. The overview's plan 10 entry gives a
    company with no link its hidden name and lifts `link_needed`; no company ships without copies for want of a link.
19. **What the other plans left here.** Plan 5's ruling 7 (a copy's app door passing to the leader): a copy's app door
    reaches its own app, and nothing needs more, since workers pick the leader by `hello` (deviation in form). Plan
    6's ruling 11 (a data machine that does not lead keeps its own computer access): the follow keeper runs plan 6's
    part as a worker's keeper does. Plan 7's ruling 1: the bundles' recipients follow the role `data` already, so
    copies get them; "Debian leads; restore there" needs nothing, since a copy's front door passes to the leader;
    `cutover.sql` drops the slots of the database it closes, after it ends its sessions, so a restore leaves no slot
    behind and every copy remakes (ruling 14), its old database covered by ruling 15. Plan 8's ruling 14: with other
    data machines the prune deletes only rows older than 7 days and older than the oldest `copyAt` among finished
    copies whose slot is not lost; a copy whose slot is lost never wrote and makes itself again, so it holds nothing a
    merge must prove and does not hold the horizon back (deviation in form from 3.7's "every data machine
    confirmed"). The relay's traffic counter and "Mac cannot reach Debian; copy stopped." (which
    needs the heartbeats) are 9c's and plan 10's.
20. **The link key changes by a key Hornhoof chooses** (deviation, approved by the team lead on 2026-11-03; plan 1 has
    an addendum for it). Plan 1's R6.1 makes the relay pick the new key and refuse the old one at once, so an answer
    lost on the way would leave the company with no key that works. This plan is the first to change the key by itself,
    so R6.1 takes an optional body `{ key }` (43 base64url characters) and sets that key. `PublicLinks.changeKey` first
    saves the new key, sealed as the key is, in `public_links.next_key_enc`; then asks the relay; on a 200 it makes it
    the key and clears `next_key_enc`; on any other end, the next try reads `route` with the next key first (it worked:
    adopt it) and then with the key (it did not: ask again). While `next_key_enc` is set, each ranking tries again. The
    relay's side is plan 1's addendum, Task A1, in the relay's repository: R6.1 still authenticated by the current key,
    the new key checked as 43 base64url characters (else 400 `invalid`), and a key equal to the current one refused (400
    `same_key`). The team lead runs it and deploys the relay with the rest of the series' relay work at the end, before
    the rehearsal. This plan's lab runs on the fake relay, so here only the fake relay, which answers as the addendum
    does, and plan 1's client `changeKey(name, key, next?)` change.
21. **A restore keeps who holds the company's data, and its link** (plan 7's ruling 14 carried further; approved by the
    team lead on 2026-11-03). A restore of an older bundle would bring back a machine's data role and the link key and
    stcp secrets of before, which a machine that left may know or which the relay no longer takes. So `carry.sql` also
    takes each machine's `role`, `data_left_at` and `upload_state`, the `public_links` row whole (its key and
    `next_key_enc` sealed as stored), and the `peer_secrets` rows, and `applyCarry` sets them on the restored database
    before the keeper or a machine reads it. The ranking's scope check (ruling 2) holds even without the carry, as after
    a total loss.

## Review Focus

1. A commit confirmed that the copy named at hornhoof.org lacks: sync cleared before the relay stored "off", "sync on"
   posted before the copy confirmed past W or before the setting held, a flag of `copy` or `relay_off` kept while
   neither holds, or a restart that clears the setting first. Tests in Task 7 (every row of `nextSyncStep`'s table,
   `never clears before off is stored`, `waits for the setting to hold`, `runs the barrier before W`) and Task 8
   (`confirms only what the copy holds`, `waits for the checkpointer before W`).
2. The company stuck: commits waiting for good on a sleeping copy, a lease that lapses while a copy is first made, a
   copy that cannot be made keeping the leader from writing, a keeper whose lease ended that can never get "off"
   stored, a copy judged silent by its clock. The silent copy is dropped within about 3 s; with the relay gone too the
   keeper fences within 20 s. Tests in Task 7 (`drops a silent copy`, `stops renewing when sync cannot be cleared`,
   `stays stopped until the copy answers`, `starts its link again to get off stored`, `times a reply by its own
   clock`) and Task 8 (`goes on alone when the copy stops`, `makes the first copy while the leader writes`).
3. Data where it must not be: a copy on a machine whose owner does not see the whole company, also after a restore; a
   worker or a machine that left holding a secret or rows; an upload left on either side or run as SQL on the
   leader. Tests in Task 2 (`gives data only to whole-company people's fit computers`), Task 3 (`takes the data away
   at once`), Task 9 (`keeps who holds the data and the link`) and Task 10 (`wipes the database, the dumps and the
   secrets`, `keeps no part`, `refuses what is not a table's data`).
4. A database thrown away before it is merged: a remade copy's old database dropped before its merge, a wiped
   machine's before its upload is merged and its fork bundle recorded, a database that once held a term dropped at
   all, a wipe that stops halfway and is forgotten. Tests in Task 9 (`swaps only after the merge`, `keeps a database
   that led`, `compares across a restore`) and Task 10 (`wipes only after the upload is kept`, `never wipes a database
   that led`, `goes on with a wipe that failed`).
5. A copy that drifts without anyone seeing it: rows that do not fit, a slot lost to `max_slot_wal_keep_size`, a
   restore on the leader, a migration on the leader, a copy behind shown as up to date. The copy remakes itself and
   its card says so. Tests in Task 8 (`loses a slot to the WAL limit`), Task 9 (`remakes after its slot is lost`,
   `remakes after a migration`), Task 11 (`catching_up` in `copies-view.test.ts`) and Task 12's restore step.

---


# The task

### Task 7: The sync controller

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sync-step.test.ts test/sync.test.ts
test/keeper.test.ts test/lease-store.test.ts test/slots.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/sync-step.ts`, `apps/server/src/modules/keeper/sync.ts`,
  `apps/server/src/modules/keeper/slots.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts` (the controller, the pulse, the slots, the flag, the link frpc at
  lease end, `keeper.json` `copies`), `apps/server/src/modules/keeper/lease-store.ts` (`take`, `renew`, `prune`),
  `apps/server/test/fake-lease.ts` (`take` and `renew` record their `sync`)
- Test: `apps/server/test/sync-step.test.ts` (new), `apps/server/test/sync.test.ts` (new),
  `apps/server/test/slots.test.ts` (new), `apps/server/test/keeper.test.ts`, `apps/server/test/lease-store.test.ts`

**Interfaces:**
- Consumes: the relay client's `route` and `setSync`, `Route`, `SyncRecord`, `SyncPost` (plan 1); `LeaseStore`,
  `LeaseSync`, `keeperSql`, `nextLeaseStep`, `fakeLease` (plan 3); `othersHoldData` (plan 5); `PeerServer.dbBytes` (Task
  4); `copyName` (Task 6).
- Produces:
  ```ts
  // modules/keeper/sync-step.ts
  export const SAMPLE_EVERY_MS = 250;
  export const SILENT_REPLY_MS = 2_000;
  export const SLOW_WAIT_MS = 1_000;
  export const SLOW_FOR_MS = 5_000;
  export const SLOW_BYTES = 1_048_576;
  export const PACE_MS = 1_000;
  export const PACE_FOR_MS = 30_000;
  export const STOP_RENEW_MS = 10_000;
  export type Flag = LeaseSync | null;
  export type CopySample = { machine: string; networkId: string; number: number; name: string; finished: boolean;
    keptPaceMs: number; replyAgeMs: number | null; confirmed: string | null; syncState: string | null };
  //   confirmed: the slot's LSN; replyAgeMs: the leader's monotonic ms since it saw reply_time change, null with no
  //   walsender; syncState: pg_stat_replication.sync_state
  export type SyncSample = { now: number; others: CopySample[]; listed: number; setting: string | null;
    route: { client: string; generation: number } | null; record: SyncRecord | null; oldestWaitMs: number | null;
    slowForMs: number; namedBytes5s: number };
  //   listed: the other live data rows, finished or not; others: those of them with a copy name; setting: the name
  //   in synchronous_standby_names, or null; record: the relay's record as last read or stored
  export type SyncMemory = { w: string | null; posting: boolean; flag: Flag; checkpointed: boolean; blocked: boolean };
  export function lsnAtLeast(a: string, b: string): boolean;   // 'X/Y' positions compared as 64-bit numbers
  export type SyncAction =
    | { do: 'none' } | { do: 'post'; state: 'off' } | { do: 'post'; state: 'on'; copy: string }
    | { do: 'set'; name: string } | { do: 'clear' } | { do: 'checkpoint' } | { do: 'read_w' };
  export function nextSyncStep(s: SyncSample, m: SyncMemory): { action: SyncAction; flag: Flag; memory: SyncMemory;
    renew: boolean };
  // modules/keeper/sync.ts
  export class SyncController {
    constructor(opts: { sql: Sql; relay: { route(name: string, key: string): Promise<Route>; setSync(name: string,
      key: string, post: SyncPost): Promise<SyncResult> };
      link: () => { name: string; key: string; client: string } | null;
      dbBytes: (machine: string) => number; log: (line: string) => void; now?: () => number; everyMs?: number });
    start(): Promise<void>;     // reads the record and the setting it finds; never clears before off is stored
    stop(): Promise<void>;
    flag(): Flag;
    renew(): boolean;           // !memory.blocked
    copies(): { name: string; state: 'sync' | 'pace' | 'behind' | 'silent' }[];   // for keeper.json
  }
  // modules/keeper/slots.ts
  export const SLOTS_EVERY_MS = 60_000;
  export const KEEP_SIZE_EVERY_MS = 3_600_000;
  export function keepSize(diskFree: number): number;   // MB: min(20480, floor(diskFree / 4 / 2 ** 20))
  export function sweepSlots(sql: Sql, log: (line: string) => void, inactiveSince: Map<string, number>, now: number):
    Promise<string[]>;
  //   the names dropped; inactiveSince: when each table sync slot was first seen inactive, kept by the caller
  // lease-store.ts: take(kind: LeaseKind, until: Date, sync: LeaseSync): Promise<Term>; renew(term: Term, kind:
  //   LeaseKind, until: Date, endSessions: boolean, sync: LeaseSync): Promise<boolean>, which sets the lease's sync in
  //   its one UPDATE; prune gains the bound copiesAt: Date | null (below)
  ```
- `nextSyncStep`, the first row that matches; `setting` names a copy C when it equals C's `name`; "off stored" means
  `record.state` `off` with `record.generation` the route's `generation`; "on C stored" likewise with `copy` C's
  network id; C is listed when it is in `others`:

  | When | Action | Flag |
  |---|---|---|
  | `posting` | none | `memory.flag` |
  | `listed` 0, `setting` set, off stored | `clear` | `relay_off` |
  | `listed` 0, `setting` set | post off | `copy` |
  | `listed` 0, record `on` | post off | `alone` |
  | `listed` 0 | none | `alone` |
  | `setting` set and names no listed copy, off stored | `clear` | `relay_off` |
  | `setting` set and names no listed copy | post off | `copy` |
  | `setting` C, C silent, off stored | `clear` | `relay_off` |
  | `setting` C, C silent | post off | `copy` |
  | `setting` C, a lower-numbered finished copy kept pace `PACE_FOR_MS`, off stored | `clear` | `relay_off` |
  | `setting` C, a lower-numbered finished copy kept pace `PACE_FOR_MS` | post off | `copy` |
  | `setting` C, `w` null, C's `syncState` not `sync` | none | `copy` |
  | `setting` C, `w` null, not `checkpointed` | `checkpoint` | `copy` |
  | `setting` C, `w` null | `read_w` | `copy` |
  | `setting` C, `lsnAtLeast(C's confirmed, w)`, on C not stored | post on C | `copy` |
  | `setting` C | none | `copy` |
  | off stored, a finished copy kept pace `PACE_FOR_MS` | `set` the lowest-numbered such | `relay_off` |
  | off stored | none | `relay_off` |
  | otherwise | post off | null |

  C is silent when `replyAgeMs` is null or over `SILENT_REPLY_MS`, or when `slowForMs` is at least `SLOW_FOR_MS` and
  `namedBytes5s` under `SLOW_BYTES`. `set` and `clear` reset `w` to null and `checkpointed` to false; the controller
  sets `checkpointed` once its `CHECKPOINT` ended and `w` once read; a post's answer sets `posting` false. The flag
  of the row is kept in `memory.flag`. `blocked` turns true when `oldestWaitMs` is at least `STOP_RENEW_MS`, the
  setting is set, the copy it names is silent or not listed, and off is not stored; it turns false only once off is
  stored or the copy the setting names is listed and not silent, so sessions ended at lease end do not lift it.
  `renew` is `!blocked`; a commit waiting on a copy that keeps receiving (a big transaction) never stops the lease.
- `SyncController`, every `everyMs` (`SAMPLE_EVERY_MS`), on the keeper's `keeperSql` session:
  - The sample: other live data rows from `machines`; for each, its slot by `copyName` in `pg_replication_slots`
    (`confirmed_flush_lsn`) and its walsender in `pg_stat_replication` by `application_name` (`reply_time`,
    `sync_state`, `pid`); `replyAgeMs` by `performance.now()` since the sample that first saw this `reply_time`, a
    walsender seen first or with a new `pid` starting its clock then (`reply_time` is the copy's clock, never
    compared with the leader's);
    `keptPaceMs` since when `confirmed` has been at or past the `pg_current_wal_lsn()` sampled `PACE_MS` before;
    `finished` from the row's `copy_state` `ready`; `setting` from `SHOW synchronous_standby_names`; the oldest
    `pg_stat_activity` row with `wait_event` `SyncRep`; `slowForMs` since when every sample saw it over
    `SLOW_WAIT_MS`; `namedBytes5s` from `dbBytes` of the named copy; `route` as the keeper last read it, null unless
    it is `held` by the keeper's own link client.
  - `post`: `route` read again, then `setSync(name, key, { client, generation, state, copy, epoch: record.epoch + 1 })`
    with the keeper's own client and the generation just read;
    `stored: true` updates the record; anything else is one log line and the next sample decides again.
  - `set`: `ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 ("<name>")'` and `pg_reload_conf()`; `clear`:
    `ALTER SYSTEM RESET synchronous_standby_names` and `pg_reload_conf()`; each on a session with `synchronous_commit
    = local`. `checkpoint`: `CHECKPOINT` on such a session, which the checkpointer runs only after the reload it was
    signalled before (ruling 9). `read_w`: `pg_current_wal_lsn()`.
  - It samples from the keeper's first lead on, leading or not, so a keeper whose lease ended can get off stored.
  - The flag is what the keeper gives `LeaseStore.take` and `renew` as their `sync`, in place of plan 3's `alone`;
    with no flag it neither takes nor renews, and while `renew()` is false it does not renew, so the lease ends as
    plan 3's does; `mode()` says `lead` only with a flag. Plan 5's guard stays: while `othersHoldData()` last answered
    true, `alone` counts as no flag.
- The pulse: while `listed` is above 0 and the keeper leads, `INSERT INTO net.pulse (at) VALUES (clock_timestamp()) ON
  CONFLICT (id) DO UPDATE SET at = excluded.at` each second on a session with `synchronous_commit = local`.
- Slots: `ALTER SYSTEM SET max_slot_wal_keep_size = '<keepSize>MB'` and a reload at the first lead and every
  `KEEP_SIZE_EVERY_MS`, with the volume's free disk from `Measures`. `sweepSlots` each `SLOTS_EVERY_MS`: each slot
  `copy_<16 hex>_<n>` is dropped when no live data row's network id starts with those 16 characters, or when that
  row's `copy_name` has a higher `n`; a table sync slot (`pg_%_sync_%`) once it was inactive at every sweep for 10
  minutes; each one's walsender ended first by `pg_terminate_backend`; other names left alone.
- At lease end, with `listed` above 0, the keeper stops its link frpc (plan 3's ruling 6) and starts it again 30 s
  later while it does not lead, so its route is held and off can be stored.
- `keeper.json` gains `copies` from `copies()`.
- `LeaseStore.prune`, with other data machines listed: only rows older than 7 days and older than `copiesAt`, the
  oldest `copy_at` among rows with `copy_state` `ready` whose slot is not `lost`; with none, nothing older than 7 days
  is kept from going as plan 8 says.

- [ ] **Step 1: Write failing tests.**
  - `sync-step.test.ts`: one test per row of the table, named by its When, each asserting the action, the flag and
    `renew`; and:
    - `never clears before off is stored`: over every sample built from `setting` set and the record `on` at either
      generation, no action is `clear`.
    - `posts on only past W`: `setting` C, `w` 0/3000000, C's `confirmed` 0/2FFFFFF: no post; 0/3000000: post on.
    - `posts again at a new generation`: on C stored at generation 4, the route at 5: post on C, flag `copy`.
    - `takes no flag without the relay`: listed 1, no setting, record off at an older generation: post off, flag null.
    - `stays alone when the last copy goes`: listed 0, record `on` naming a machine that left: post off, flag `alone`.
    - `drops a silent copy`: `replyAgeMs` 2001: post off; null: post off; `slowForMs` 5000 with 900000 bytes: post
      off; with 2000000 bytes: none.
    - `stops renewing when sync cannot be cleared`: C silent, `oldestWaitMs` 10000, off not stored: `renew` false; at
      9999: true; off stored: true.
    - `stays stopped until the copy answers`: after `renew` turned false, `oldestWaitMs` null (the sessions ended)
      with C still silent: false; C not silent: true; from false again, off stored: true.
    - `waits for the setting to hold`: `setting` C, `w` null, C's `syncState` `potential`: none; `sync`: `checkpoint`;
      `checkpointed`: `read_w`; after a `set` or a `clear`, `w` is null and `checkpointed` false.
    - `never clears an empty setting`: `listed` 1, `others` empty, no setting, off stored: none, flag `relay_off`; not
      stored: post off, flag null.
  - `sync.test.ts`, on `createTestSql` with fakes for the catalogs and the fake relay:
    - `names the copy, then says so at the relay`: a finished copy kept pace for 30 s: the setting names it, then once
      its slot confirmed W the fake relay's record is `on` with its network id at epoch one above.
    - `never clears before off is stored`: with the fake relay failing `setSync`, a silent copy keeps the setting;
      once it stores, the setting is reset.
    - `starts from what it finds`: started with the setting naming C and the record `on` C: no clear, no post until
      C confirms W, then none; `CHECKPOINT` ran before W was read.
    - `runs the barrier before W`: after the `set`, the statements are the setting, `pg_reload_conf()`, a
      `pg_stat_replication` read showing `sync`, `CHECKPOINT`, then `pg_current_wal_lsn()`, in this order.
    - `times a reply by its own clock`: a walsender whose `reply_time` is 5 s behind the leader's clock, and another
      5 s ahead, each changing each second: neither silent; one whose `reply_time` stays the same for 2.1 s: silent;
      a new `pid` starts its clock again.
  - `slots.test.ts`: `keepSize` of 40 GiB free is 10240, of 200 GiB 20480; `sweepSlots` drops `copy_<a>_1` when A's
    `copy_name` is `copy_<a>_2`, keeps `copy_<a>_3`, drops `copy_<z>_1` of no machine; keeps `pg_16384_sync_1_7`
    while it is active and while it has been inactive for 9 minutes, drops it at 10; keeps a slot of another name.
  - `keeper.test.ts`: `beats the pulse while copies exist`: with a data row listed, `net.pulse.at` advances each second;
    with none, it is not written; `stops its link at lease end with copies`: the link frpc child stops when the lease
    ends and another data row is listed, and not when none is; `starts its link again to get off stored`: 30 s after
    that lease end the link frpc child runs again while the keeper does not lead, and with the fake relay storing off
    the keeper takes a lease with sync `relay_off`; `leads alone only when alone`: with `othersHoldData` true and the
    flag `alone`, `fakeLease` gets no `take`.
  - `lease-store.test.ts`, `prunes only what every copy holds`: rows 8 days old with a copy's `copy_at` 9 days ago
    stay; with `copy_at` now they go; a copy whose slot is `lost` does not hold them back.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the three files and the keeper's changes.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Confirm commits only once the sync copy holds them, and drop a silent copy from sync only
  after the relay knows".

