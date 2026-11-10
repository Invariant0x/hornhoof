You are the writer for Task 9 of 2026-11-03-network-phase-1-plan-9c-planned-switch in Hornhoof's network build. Read everything below before you start.

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

# Network Phase 1, Plan 9c: The Planned Switch and Updates Across Machines, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CEO presses "Move the server here" on a numbered machine's card. Hornhoof gives that machine a copy if it
has none, names it the sync copy, and once it keeps pace hands the server over in about 10 s: the leader stops writes,
waits until the copy holds every change, and lets go of the link; the copy takes the link at hornhoof.org, promotes
itself and leads as number 1, and the old leader follows it as a copy, as do the other copies. One Update moves every
machine: copies promise not to take over, the database is saved only once they hold every change, sync is off while
migrations run, a rollback drops the slots first, copies remake themselves after migrations, and then each copy installs
in its turn. Every data machine runs its own built-in node, so API-key turns survive a switch. The relay counts its
outbound traffic per month.

**Architecture:** One migration, `0057_switch`: `net.move` (the CEO's request and its state), `net.handovers` (the new
leader's record of each planned switch, spec 3.7's "record for the old leader"), `net_local.state` gains the handover it
ended with, and `jobs`, `agents` and `test_parts` gain the machine of their built-in node. The switch's decisions are
pure (`modules/keeper/switch-step.ts`); the leading keeper hands over (`handing.ts`), the follow keeper takes over and
promotes (`taking.ts`, `promote.ts`), over new peer paths `/peer/switch/*`, each side keeping its phase in a file of its
keeper folder so a restart goes on where it was; a keeper changes kind by exiting, and compose starts it again as the
other. On the app, `modules/copies/move.ts` takes the CEO's request, gives the target its copy, and the sync controller
names it. The updater chooses its path (lead, copy, worker) by what the machine is now and its installer by how the
machine was installed; the leading keeper gets the copies' promises, waits for their slots before the dump, turns sync
off for migrations and drops the slots before a restore (`update-steps.ts`); the follow keeper keeps its promise
(`updating.ts`). The hub knows each machine's built-in node. The relay's addendum A2 counts the droplet's outbound
bytes.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:https`, `fetch`); Postgres 17.11 logical and synchronous
replication; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite; bash 3.2 and BusyBox for `updater.sh`; Docker
Compose; React for the web app; vitest; Docker for `npm run test:real` and `npm run test:lab`; Python 3 for the relay's
addendum.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.4 "Planned switch" (steps 1 to 8, the copy made first and
named sync for the switch) and fences 1 to 4 as they hold during it; 3.7 "Promotion", "Sequences" and the publication
made before any slot; 3.9 "Built-in node"; 3.10 (the standby reads the link's name and key from its copy); section 2's
"Move the server here" with its inline confirm and the line "Mac takes the server once its copy is up to date (40%)";
section 4's rows "The CEO presses 'Move the server here'" and "Update fails, or the leader dies mid-update"; section 9
"Updates across machines" and "The maintenance state" (steps 1 to 11, "A machine that was offline"); section 12's
bullets for the planned switch, rollback with slots, sequences, the maintenance state surviving a rollback and a
built-in node's turn surviving a planned switch. Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 9's
entry (its relay part: decision 5, the traffic counter and the runbook line). Plan 9's ruling 1, which split plan 9 into
9, 9b and 9c; plan 4's ruling 9; plan 5's ruling 13. The approved mockup
https://claude.ai/artifact/Twnj15fdFN4Z1gT4Z2AgxT (`moveHere`, `moveAsk`, `moveYes`, `cancel`, and `prioBody`'s `move`).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see them
fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only the
task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a test of
an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**Two repositories.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in the series' worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/network` on its branch `network`, after plan 9b's last task is
committed there; no new worktree, since nothing of the series ships until the series merges into main, once, at its end.
Task 12 alone works in the relay repository, `/home/altera/hornhoof-network/hornhoof-edge`, on its `main`, as plan 1's addendum A1
does.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `NodeHub`, `NodeIdentity`, `BUILTIN`, `identityOf`, `sameNode` (`modules/nodes/hub.ts`); `jobsOf` and
  `failOpenJobs` (`modules/nodes/messages.ts`); the 26 uses of `BUILTIN` in `conversation/queue.ts`, `jobs/routes.ts`,
  `nodes/hub.ts`, `nodes/routes.ts`, `nodes/socket.ts`, `subscriptions/routes.ts`, `subscriptions/views.ts`,
  `testruns/pool.ts` and `testruns/runs.ts`; `jobs`, `agents` and `test_parts` (`builtin`) in `schema.ts`; `updater.sh`
  (`update`, `backup`, `applied`, `restore`, `go_back`, `install_new`, `unpack`, `write_status`, `handle_request`,
  `interrupted`).
- Plan 1: the relay client's `route`, `setSync`; `Route`, `SyncRecord`, `SyncPost`; `FakeRelay`
  (`apps/server/test/fake-relay.ts`) with `register`; the relay repo's `relay.py`, `hornhoof-relay`, `setup-relay.sh`,
  `hornhoof-relay.service`, `relay/test/`, and its README's headings.
- Plan 2: `Keeper`, `KeeperOptions`, `KEEPER_PORTS`, `keeper.json` (`readKeeperState`, `writeKeeperState`,
  `KeeperState`), `AppMode`; `front`'s hold (plan 4's ruling 12: `HOLD_MS`); maintenance read from `status.json`
  (`updaterBusy`) and `UpdaterStatus` (`modules/updates/control.ts`); `migrate.ts`; compose's `restart: unless-stopped`
  on `keeper`; updater revision 2 (the app stopped right before the dump).
- Plan 3: `net_local.state`, `net_local.lease`, `net_local.maintenance`; `LeaseStore` (`take`, `renew`, `fence`,
  `endSessions`); `nextLeaseStep`; `keeperSql`; `Keeper.term()`; the keeper's answer to `GET /api/network/lease?nonce=`
  on its link doors (plan 3's Task 5); ruling 8 (a new term at every keeper start).
- Plan 4: `builtinKey(nodeKey, machineId)`, `run --builtin` with `HORNHOOF_MACHINE_ID`, `socket.ts`'s `identify` of a
  `builtin.<m>.<hex>` bearer; the node through `front`; `failOpenJobs(..., 'machine_restarted', running)` at hello.
- Plan 5: `findThisMachine`, the leader's hidden `server:<machine id>` row (its ruling 6); `PeerServer` and its peer
  paths, `peerClientFor`; `CertificateKeeper`; `TunnelKeeper` and `linkClientId(name, machineId)`; `LinkListener`.
- Plan 5b: `WorkerKeeper`, `workerConfig`, `WorkerConfig`, `WorkerView`, `DataMachine`, `WorkerLink`, `workerView`,
  `PEERS_FILE`; `PeerLink` (`leader()`, `request`, `stream`, `connectDb`, `Hello`); `builtinMachine`, `shownMachine`;
  `disconnectMachines`, `disablePerson`'s disconnect; the worker's updates (`leaderBuild`, `goodGrant`, `tryGrant`,
  `followOf`, `holdsMachine`, `go.json`, `follow.json`); `install.sh server` and `worker`; the lab (`Lab`, `LabMachine`,
  `steps.ts`).
- Plan 7: the CEO's check on the people's routes (`not_owner_session`); `errorText`.
- Plan 8: `BOOKKEEPING` and the merge's rules (`modules/merge/rules.ts`).
- Plan 9: `machines.role`, `copy_state`, `copy_progress`, `copy_name`, `server_order`, `server_pin`, `server_why`,
  `upload_state`; `qualify.ts`; `order.ts` (`COPIES`, `Ranking`, `rankOf`, `candidates`, `rank`); `scope.ts`
  (`cutReplication`, `leaveData`); `FollowKeeper`, `followConfig`, `FollowConfig`, `keeperRole`, `REPLICA_FILE`
  (`replica.json`); `CopyMaker`, `CopyReport`, `CopyOrder`, `COPY_STATE`, `SCHEMA_FILE`, `copyName`; `DbDoor`,
  `replicaPassword`, `PUBLICATION`; `SyncController`, `nextSyncStep`, `SyncSample`, `SyncMemory`, `CopySample`,
  `lsnAtLeast`, `sweepSlots`; `net.pulse`; the remake by the leader's count of migrations (its ruling 14), its swap and
  `copy-state.json`'s phases; the guard of its ruling 12 (`stopped`, error `led`); the merge of a copy that never wrote
  by one id-set read (its ruling 15); `become_data`, `schema_request`, the upload and the wipe in `updater.sh`;
  `compose.worker.yaml` with `node` in the profile `builtin`; `GET /api/machines`' `data` and `copies`; the lab's
  `copies.test.ts`, `writer.ts` (`startWriter`, `checkRows`) and `relay()`.
- Plan 9b: `rankOf`, `planRoles` and the handover of a copy (`modules/copies/order.ts`); `net.ranking`; `setPriority`
  and `PUT /api/machines/:id/priority`; `CopyOrder.lastAttempt`; `DataView` (`number`, `why`, `pin`, `unfit`, `copy`,
  `leftAt`) and `priority` in `GET /api/machines`; the card's Priority part and `machines.priority` in both language
  files; `CopySample.number` `Infinity` for a data row with no number.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`. The relay repo's commits are `commit -s` with the same name and email, as plan
  1's.
- Nothing private in either repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and passwords made at run time. The runbook line goes into the team lead's private
  `~/.hornhoof-edge/droplet/README.txt`, never into a repo.
- No new npm dependency, and no new Python package in the relay. One new migration, `0057_switch`: `npx drizzle-kit
  generate --name switch` from `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1
  appended after a `--> statement-breakpoint`; never an edit of an older one. Its number follows plan 9b's `0056`; the
  series' migrations are numbered again at the merge into main.
- One leader at a time (spec 3.4): the old leader writes nothing after it fenced, and the new one writes nothing, its
  app included, before its promotion ended; after the old leader sent "go", it leads again only on the new one's word.
  Hornhoof moves the server only on the CEO's request (spec 3.3); nothing here starts a switch by itself.
- No confirmed write is lost (spec 3.4, section 9): the new leader promotes only once its slot confirmed the old
  leader's last position W, a copy joins the new leader with `copy_data = false` only when it confirmed W, and the
  update's dump is taken only after every promised copy confirmed W, else the update ends with nothing changed. No
  database is thrown away before it is merged (spec 3.7, plan 9's Global Constraints).
- Messages between keepers and apps change only by additions (spec section 9): a keeper of plan 9b's build that does not
  know a peer path answers 404, which reads as "not ready", and a status or view without the new fields keeps what it
  had.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  The CEO only presses "Move the server here" or Update; everything else happens by itself.
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

1. **What this plan takes.** Plan 9's ruling 1 gave it "Move the server here" (3.4 "Planned switch") with 3.7's
   promotion and sequences, section 9's updates across machines (the promise, the slot wait before the dump, sync off
   for migrations, rollback with slots, copies remaking after migrations, a copy's own update order), the built-in
   node's identity per machine (plan 4's ruling 9, which plan 5's ruling 13 moved to plan 9), and the relay's traffic
   counter with its runbook line. Plan 9b left it the promotion making the new leader 1, which 9b's ranking does at the
   new leader's first lead. Left to plan 10 (ruling 12): the heartbeats, B's promise outside a switch, the takeover, the
   switch banners of section 2 and the old leader's note on its card.
2. **The CEO's request** (section 2, spec 3.4). `net.move` holds one request at a time: its id (new for each request,
   and the id of the switch it leads to), its target machine, who asked and when, its state (`preparing`, `switching`,
   `failed`), a failure's reason, and the machine that led when it was asked. `POST /api/machines/:id/move`, the CEO
   only (plan 7's check), on a machine with a number from 2: it stores the request (a new one replaces a `preparing` or
   `failed` one) and runs the ranking, which gives the target the role `data` at once if it has not got it, past
   `COPIES` too (spec: "A first makes its copy if it has none (number 4 or later)"), and retires it by no rule while the
   request stands. The sync controller names the target as soon as its copy finished and kept pace for 30 s, through
   "sync off" if another copy is named, and no lower number replaces it meanwhile (spec: "names it sync (3.7), for the
   switch even over a lower number"). The leading keeper starts the switch once the target is named, "on" for it is
   stored, and it keeps pace (ruling 3). Refused: the leader's own row (409 `already_leader`), a machine with no number
   (409 `no_number`), while the updater runs (409 `updating`), while a switch runs (409 `switching`); outside lead 503
   as every writing route. Two additions, for the team lead to rule on: `DELETE /api/machines/:id/move` cancels a
   request that is `preparing` or `failed` (the card's Cancel beside the waiting line), and a request still `preparing`
   after 24 hours fails with `expired`, so a copy that never finishes does not hold a move forever. The target's card
   says, in its Priority part: "<host> takes the server once its copy is up to date (<p>%)" while its copy is being
   made, the same without the share once it finished, "Moving the server to <host>." while switching, and "The server
   stayed on <leader>: <reason>" for 24 hours after a failure, to everyone who sees that part; the buttons only to the
   CEO.
3. **The switch, step by step** (spec 3.4 steps 1 to 8). A is the leading keeper, B the target's follow keeper. Each
   keeps its phase in its keeper folder, A in `handing.json` (`offered`, `stopped`, `go`, `followed`) and B in
   `taking.json` (`offered`, `go`, `promoted`, `aborted`), written before the act it stands for, so a keeper that starts
   again goes on from it, and doing again on start whatever act of its phase may not have finished (a fence, a stop, a
   disable). A talks to B over its peer client, B answers on its peer server: `POST /peer/switch/offer`, `POST
   /peer/switch/go`, `POST /peer/switch/abort`, `GET /peer/switch/state`. The offer is taken only from the machine B's
   link names as leader; B keeps that machine in `taking.json`, and `go`, `abort` and `state` are taken only from it,
   since A's hello says `lead: false` once it fenced. Each switch has an id, the request's (`net.move.request`), which
   every message and both files carry; a message of another id is refused, one of the same id again changes nothing. The
   deadline is the offer's time plus 60 s (spec step 8).
   - Step 1: A offers once the target is ready (ruling 2). It first claims the request it sampled (`preparing` to
     `switching` by its id, under the lock the routes take), then writes `offered`, then sends the offer; a request
     replaced or cancelled meanwhile is not claimed. B accepts when its copy is `ready` and its subscription enabled,
     and writes `offered`.
   - Step 2: A writes `stopped`, closes its front door (so every `front` holds, plan 4's ruling 12), says `lead: false`
     in its hello, fences (`LeaseStore.fence()`: an expired lease, the app's and agent roles' sessions ended), takes no
     lease while `handing.json` is there, and only then records `fenced`; a keeper that starts in `stopped` without
     `fenced` closes and fences again before anything else.
   - Step 3: A reads W after the fence and waits until B's slot confirmed W, then up to 10 s more for the other copies
     whose copy is `ready` and that have a walsender; those that reached W are `copies`. A copy still making its first
     copy is never among them. A writes `go`, then sends `go` with W and `copies`, again each second while B answers
     `offered`. B answers 200 only before its deadline and with its subscription enabled and its apply worker running,
     and writes `go`. B's slot on A at W is the barrier: a subscriber reports a position as flushed only once every
     transaction before it is applied and flushed, and with `streaming = off` it applies in order (PostgreSQL 17's
     `worker.c`, `send_feedback` and `get_flush_position`); B's own origin progress is no barrier, since it stays at the
     last published commit while W runs on over WAL nobody publishes.
   - Step 4: A stops its link frpc and keeps it stopped while `handing.json` is there.
   - Step 5: B disables its subscription, then becomes a leading keeper that takes no lease yet (ruling 4): its link
     frpc registers the name, and once the relay's `route` names B's client, B checks its nonce: `GET
     <base>/api/network/lease?nonce=<22 random base64url>` answers B's machine id and that nonce; `<base>` is the link's
     `https://<host>`, or `HORNHOOF_LINK_PROBE`, which only tests set.
   - Step 6: B promotes (ruling 5) if the deadline has not passed. Its term written, there is no abort.
   - Step 7: A sees `leading` in B's `state` and follows (ruling 6).
   - Aborts. Before it sent `go`, A alone decides: B does nothing without `go`, and its `offered` ends at the deadline.
     A sends `abort` (its answer is not needed), removes `handing.json`, opens its front door, starts its link frpc, and
     leads again under a new term (plan 3's ruling 8: one above its own, (T + 1, A), as the spec's re-entry says); once
     it leads it marks the request `failed` (`no_answer`, `not_ready`, `behind`). After `go`, only B's word counts: B
     aborts when its name or nonce fails or the deadline passes before its term (link frpc stopped, subscription enabled
     again, `aborted` with the reason and `follow: (T + 1, A)`, kept 10 minutes); A, asking `state` each second,
     re-enters on `aborted` as above. B's word may also be `none`: no `taking.json` of that switch and no handover of it
     recorded, so B never took `go` for it and never can (its `go` needs `offered` of that switch, and the follow keeper
     ends an `offered` at B's deadline), and A re-enters (`no_answer`); an `offered` answer is not that word, since a
     late `go` may still reach B before B's own clock passes the deadline. B answers `leading` only once the handover is
     recorded with every slot (promotion step 6), from `net.handovers` once its `taking.json` is gone, so an A that
     comes back late still learns that B leads; with its term written and no handover yet it answers `go`, which A
     cannot abort on. A that hears nothing keeps asking (deviation, ruling 12: the spec gives that case to the takeover
     rule, which is plan 10's).
4. **A keeper changes kind by exiting** (deviation in form; the spec does not say how). `keeperRole` reads the keeper
   folder as well: `taking.json` in phase `go` or `promoted` makes a leading keeper that is taking over; `handing.json`
   a leading keeper that is handing over; then plan 9's `replica.json` or an enabled subscription a follow keeper; else
   a leading keeper. A keeper whose kind must change writes its files, closes its listeners and exits 0, and compose's
   `restart: unless-stopped` starts it again within seconds as the other kind. Every `front` holds meanwhile, as it
   holds for any keeper restart.
5. **Promotion** (spec 3.7, steps 5 and 6), by B, each step checked first so a restart goes on:
   1. The term: `net_local.state` of (one above the highest of A's term, every `net.journal.term_number` and its own
      state's, B), unsplit, with B's cluster. A row of B's already above A's term is this attempt's own (B writes
      nothing between `go` and here), so a restart keeps it.
   2. The subscription detached (`slot_name = NONE`) and dropped.
   3. Every sequence owned by a column of a table in `public` set to that column's maximum plus 1000, unless it already
      stands higher.
   4. The publication `hornhoof` made when missing, before any slot (spec 3.7).
   5. A slot for A and for each of `copies`, named `copyName(<its network id>, <the attempt of its row's copy_name, 0
      without one> + 1)`, so no old subscription of that machine can attach to it.
   6. One commit: `net.handovers` gets the record of the old leader under the switch's id (its row, its term, W, B's
      row, the time and the slots' names), and `net.move` is deleted.
   7. `replica.json` and `copy-state.json` removed; `promoted` written.
   8. The lease taken as at every keeper start, which makes the term (M + 2, B), M the highest number step 1 saw, (T +
      2, B) when that is A's (deviation in form: the spec says (T + 1, B); terms only need to grow). The front door
      opens; the sync controller starts as any leading keeper's: "sync off" at B's new generation, then the first copy
      in the order once it kept pace (deviation in form: the spec sets sync at promotion; A subscribes only after it, so
      a set sync would make the first commits wait and take the "sync off" path anyway). The app leads once the flag
      allows, and 9b's ranking makes B 1 and ranks A. B answers `state` `leading`, with its term and the slots' names,
      from step 6's commit on, and removes `taking.json` once its app leads. From promotion until A joins, seconds as a
      rule, B commits with no copy confirming, exactly as under today's "sync off" (spec 3.4): B dying in that window is
      plan 10's takeover, with the same exposure as any "sync off", not a gap in this switch.
6. **The old leader and the other copies follow B** (spec step 7). On `leading`, A writes `followed`, then: its
   `net_local.state` records the handover (`handed_to`, `handed_lsn` W, `handed_at`); every replication slot of its own
   is dropped, walsenders ended first; its keeper folder gets `peers.json`, a view built from its own database (the data
   machines, the authority, the revoked serials and the link, its secrets opened with `HORNHOOF_SECRET`, `dataSecret`
   included), and `copy-state.json` in a new phase `join` with B's slot name for it; then plan 9's `replica.json` in the
   control folder, and A exits and starts as a follow keeper. `followConfig` takes the server's address from the view's
   link when `.env` has no `HORNHOOF_JOIN_SERVER` (a server's never has). The copy maker's `join` makes the subscription
   to that slot with `create_slot = false` and `copy_data = false`, every table ready at once. A database whose state
   records a handover is no `led` database for plan 9's ruling 12 and counts as never written for its ruling 15:
   everything it wrote reached B before W. Every other copy learns its slot from B's view (`CopyOrder.join`), and its
   maker drops its old subscription and joins the same way; a copy that did not reach W gets no slot and remakes (plan
   9's ruling 14). A view from a new leader counts toward no remake rule until that leader's views named no `join` for
   the copy twice in a row, so a copy that reached W is never made again.
7. **Any data machine may lead.** A machine installed by `install.sh server` may follow, and a machine that joined may
   lead, so:
   - The updater's path follows what the machine is now: `lead` with no `replica.json` and `HORNHOOF_ROLE` not `worker`;
     `copy` with `replica.json`; `worker` with `HORNHOOF_ROLE=worker`. Its installer follows how it was installed:
     `install.sh worker` with `compose.yaml` and `compose.worker.yaml` when `.env` names `COMPOSE_FILE`, else
     `install.sh server` with `compose.yaml`. The `copy` path is plan 9's (a worker's: no backup, no migrations, the
     turn waited for) with the machine's own installer and files; the `lead` path checks health at `front` as a
     server's, whatever the installer. `install.sh worker` on a data machine (`COMPOSE_PROFILES` naming `data`) starts
     every service of the profiles but the updater, `db`, `migrate`, `app` and the built-in node included, not `keeper`
     and `front` alone as plan 5b's does for a worker; on a copy `migrate` does nothing (plan 9), on a joined leader it
     migrates.
   - The wipe of an install with no `COMPOSE_FILE` also writes `COMPOSE_FILE=compose.yaml:compose.worker.yaml` (that
     file taken from the image as plan 5b's `compose_from_image` does) and `HORNHOOF_JOIN_SERVER` from `wipe.json`'s new
     `server`, the link's address, so it works on as a worker.
   - Plan 5's `thisMachine` revokes the other live `server:` rows only when it inserts its own (a database brought to a
     new server); a leader that found its row, as B finds its joined computer's, revokes none, so A's certificate stays
     good after the switch.
   - A `server:` row is hidden only while it is the leader's own (`findThisMachine`); another one is listed as a machine
     with its hostname from its reports (plan 5b), number, copy and Priority part, and the `/api/machines/:id` routes
     take it. Its Disconnect answers 409 `server_install`: the machine where the company was installed is not a joined
     computer (plan 5's ruling 6).
   - Where a machine leaves, the leader is refused: Disconnect of the leading row and disabling its person answer 409
     `leader` "<host> runs the company server. Move the server to another machine first."; plan 9's `leader_scope` and
     9b's `leader_pin` stand.
8. **Each data machine's built-in node is its own** (spec 3.9 "Built-in node"; plan 4's ruling 9). The hub's identity
   becomes `{ kind: 'builtin', machine }`, the network id in the node's key (plan 4's `builtin.<m>.<hex>`); the bare
   `NODE_KEY` is the leader's own. Jobs, agents and test parts record the machine of the built-in node they went to
   (`builtin_machine`), and a built-in node touches only its own. An API-key agent stays on its machine's built-in node
   while it is ready, else goes to the leader's, else to any ready one, lowest number first, as a move (a fresh
   session). Each ready built-in node is a place for test parts. Copies run theirs (`COMPOSE_PROFILES=data, builtin`),
   and plan 5b's grant waits for their jobs too, while a granted machine's built-in node takes no new work. A built-in
   node's message source stays `node:builtin:<stream>:<n>` (plan 4's ruling 4; each node's stream id is its own), so a
   message sent before an Update and again after it is still applied once. On a planned switch A's built-in node
   reconnects through A's `front` to B and keeps its jobs (section 12).
9. **An update across machines, on the leader** (section 9 steps 2 to 9). The updater and the leading keeper meet
   through the control folder:
   - The updater learns before it asks anything whether the new build has migrations (its `_journal.json` entries above
     the database's `applied`) and writes it into `status.json`. A new step, `promise`, waits up to 30 s for the
     keeper's `promised.json`; refused or silent, the update ends "<why>, so nothing changed." The keeper sends each
     copy that is online and up to date (`sync` or `pace` in its sync controller) "updating until <now + 15 min>" (`POST
     /peer/updating`), sends it again every 5 minutes while the update runs, and answers ok only when every one answered
     (section 9: "without every acknowledgement the leader cancels the update"). No copy: ok at once. A keeper that
     starts again with the promise sent and no answer sends it again.
   - In maintenance (plan 3's lease, plan 2's step `backup`), the keeper writes `net_local.maintenance`, reads W and
     waits up to 60 s until each promised copy's slot confirmed it; with migrations it then has those copies disable
     their subscriptions (each answering once it did) and holds sync off, and waits until "off" is stored at the current
     generation and no copy is named; then `settled.json`, which says whether all of that happened. The updater's
     `backup` waits up to 120 s for it, before it stops the app for the dump; a `settled.json` that says no, or none,
     ends the update "The copies did not confirm the last changes, so nothing changed." and the maintenance state with
     it. Sync off comes before the dump here, not after it as the spec's step 6 says (deviation in form: nothing writes
     in maintenance, so the order changes nothing). The hold is kept in the keeper's file and set again when a keeper
     starts, before its sync controller's first step.
   - An updater that stops in `backup` goes on from `backup`, not from the start, so the maintenance state, which plan 2
     reads from the step, never lapses once W was read; it stops only in `promise` or `pull`, before W, to start over.
   - Before a restore in `go_back`, `status.json` says `restore`, and the keeper has the copies disable their
     subscriptions and drops every slot, walsenders ended first (today's `DROP DATABASE ... WITH (FORCE)` fails on an
     active slot), then `slots-dropped.json`; the updater waits up to 60 s for it, then ends the walsenders and drops
     the slots itself too, and restores only once the database has no slot left.
   - At the end the keeper deletes `net_local.maintenance`, tells the copies "update ended" and lifts the hold; the
     controller names a copy once one keeps pace (after migrations or a restore, once a copy remade itself). The end
     comes when plan 2 ends the maintenance state: on success, on a finished rollback, and on a failure (plan 2's
     ruling, approved there), once the keeper leads again.
   - The first update that meets copies is run by this plan's updater and keeper. No company runs a build of plan 9 or
     9b: the series reaches main and Ivan's companies once, at its end, from main's build, which has no copies, and an
     updater of before this plan, finding no promise step, updates as plan 2's (the keeper's rows for a status with no
     memory do nothing). An update from a build of plan 9 or 9b with copies is not supported.
   - An update is refused while a move is `preparing` or `switching` (409 `moving`), as a move is while the updater
     runs.
   - Deviation in form, step 1: machines download the new build once the leader runs it (plan 5b), not while it
     installs, so a failed update leaves nobody waiting on a build that went back; nothing stops either way. Updates are
     proven by unit tests, the updater's stub tests and the real pairs, a rollback with an active copy among them
     (section 12 asks rollback with slots of the pairs and the maintenance state of the updater's tests); the lab has no
     registry to update from.
10. **The copies during an update, and a copy's own order** (section 9 steps 2, 6, 10 and 11). The follow keeper takes
    `POST /peer/updating` from the leader: `{ version, until, migrations }` is written to `promise.json` in the control
    folder, with the leader that sent it, and to its own `net_local.maintenance` before it answers, so a restart keeps
    it; `stop`, `ended` and the renewals are then taken from that leader, whose hello says `lead: false` in maintenance.
    While a promise holds, its `keeper.json` says `maintenance`, its front door never passes to its own app, and its
    maker does nothing that a remake, a schema load, a swap or a new subscription would do, nor gives an attempt up: it
    keeps what it saw (the leader's count of migrations, a missing slot) and acts on it once the promise is gone,
    against the leader's view of then. `{ stop: true }` disables the subscription, and a keeper that starts or ticks
    with a stopped promise disables it again if it is enabled; `{ ended: true }`, or the promise's time passing, removes
    it, and the subscription is enabled again unless the leader's count of migrations changed or its slot is gone (plan
    9's remake). A copy installs the leader's build on the `copy` path (ruling 7) in its turn, one grant at a time with
    the workers (plan 5b), which waits for its built-in node's jobs too. Its own app may read a database of the other
    schema for the minutes between its install and its remake; that app answers only with no leader for 60 s (plan 9's
    ruling 4).
11. **The relay counts its traffic** (overview, decision 5). Addendum A2 to plan 1, in the relay repo: each minute
    `relay.py` adds what the interface of the default route sent since its last read to the UTC month's total in its
    SQLite; a reboot, another interface or a counter that went down counts from zero. Past 300 GB in a month it logs one
    line a day. `hornhoof-relay traffic` prints the last 12 months. The README's "What it stores" says so. The runbook
    line goes into the team lead's private `~/.hornhoof-edge/droplet/README.txt`. Deployed with the series' other relay
    work at its end, before the rehearsal, as A1.
12. **What plan 10 takes from here** (its entry in the overview gains it, approved with this plan): a planned switch
    whose peer link breaks after "go" leaves A fenced until B answers, and the takeover rule settles it (spec step 8);
    the leader dying mid-update while copies hold the promise (section 4's row); the banners "Moving the company to Mac"
    and the old leader's note. Until then the page holds for the switch's seconds and the badge moves.

## Review Focus

1. Two leaders writing at once: A writes after its fence, or leads again after it sent `go` without B's word; B writes
   anything, its app included, before its slots exist, or takes a lease before `promoted`. Tests in Task 3 (every row of
   `nextHandStep` and `nextTakeStep`), Task 6 (`takes no lease before it promoted`) and Task 7 (`never leads again after
   go without B's word`).
2. A confirmed write lost or doubled across the switch: B promoting before it applied W, a copy joining B with
   `copy_data = false` that never reached W, an old subscription attaching to B's slot, a sequence handing out a number
   already used. Tests in Task 4 (the real pairs: `promotes a copy and the old leader joins it`, `reaches W when only a
   checkpoint follows`) and Task 7 (`gives no slot to a copy that missed W`).
3. A keeper that stops in the middle of a switch, on either side: each phase of `handing.json` and `taking.json` found
   at start leads on, never to two leaders and never to none for good while both machines run. Tests in Task 6 and Task
   7 (`goes on after a restart in each phase`) and Task 11 (the lab restarts B's keeper during a switch).
4. An update with migrations that hangs on the sync copy, a dump taken before the copies confirmed W, or a restore that
   meets an active slot. Tests in Task 9 (every row of `nextUpdateStep`, the updater's order of steps with its stubs),
   Task 4 (`refuses to drop a database with an active slot, and drops it once the slots went`) and Task 9's real
   `update-rollback.test.ts` (a rollback with a copy subscribed and a migration applied).
5. A built-in node's job taken, failed or cancelled by another machine's built-in node, or an API-key turn ended by a
   planned switch. Tests in Task 2 (`keeps each built-in node's jobs apart`, `keeps a turn across a planned switch`) and
   Task 11 (m1's built-in node online on m2 under its own machine after the move).

---


# The task

### Task 9: An update on the leader: the promise, the copies at W, sync off and the slots

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/update-steps.test.ts test/lead-update.test.ts
test/sync-step.test.ts test/updater.test.ts` passes, then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2
nice -n 10 npx vitest run test/UpdateProgress.test.tsx test/i18n.test.tsx` passes; the `tsc` commands print nothing;
`bash -n` and `shellcheck` on `apps/updater/updater.sh` print nothing; from the worktree root `npm run test:real` passes
with Docker running, after the disk check.

**Files:**
- Create: `apps/server/src/modules/keeper/update-steps.ts`, `apps/server/src/modules/keeper/lead-update.ts`,
  `apps/server/test/real/update-rollback.test.ts`
- Modify: `apps/server/src/modules/updates/control.ts` (`UpdaterStatus`, the three files),
  `apps/server/src/modules/keeper/keeper.ts` (a leading keeper runs `LeadUpdate`),
  `apps/server/src/modules/keeper/sync.ts` and `sync-step.ts` (`hold`), `apps/updater/updater.sh`,
  `apps/server/test/updater-stubs/docker` (the build's journal), `apps/web/src/types.ts` (`UpdateStep`),
  `apps/web/src/ui/UpdateProgress.tsx`, `apps/web/src/i18n/en.ts`, `ru.ts`
- Test: `apps/server/test/update-steps.test.ts` (new), `apps/server/test/lead-update.test.ts` (new),
  `apps/server/test/sync-step.test.ts`, `apps/server/test/updater.test.ts`, `apps/web/test/UpdateProgress.test.tsx` (new
  when there is none), `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: plan 2's `status.json` and `UpdaterStatus`, its maintenance from the step; plan 3's lease kind
  `maintenance`, `net_local.maintenance`; plan 9's `SyncController.copies()`, `nextSyncStep`, `SyncSample`; Task 4's
  `dropSlots`; plan 5's peer client.
- Produces:
  ```ts
  // modules/updates/control.ts
  //   UpdaterStatus.step gains 'promise'; UpdaterStatus gains migrations?: number | null (the new build's
  //   migrations the database has not applied; null when unknown) and restore?: boolean (go_back restores)
  export const PROMISED_FILE = 'promised.json';
  export const SETTLED_FILE = 'settled.json';
  export const DROPPED_FILE = 'slots-dropped.json';
  //   control folder, each { id: string; ok: boolean; why?: string }, the keeper's, whole and then moved
  // modules/keeper/update-steps.ts
  export const PROMISE_MS = 900_000;        // "updating until <now + 15 min>"
  export const PROMISE_AGAIN_MS = 300_000;
  export const ANSWER_MS = 10_000;          // one copy's answer to /peer/updating
  export const W_WAIT_MS = 60_000;
  export type UpdateMemory = { id: string; version: string; migrations: number | null; promised: string[];
    promisedAt: number; answered: boolean; w: string | null; wAt: number | null; stopped: boolean;
    stopAcks: string[]; settled: boolean; dropped: boolean };
  export type UpdateSample = { now: number;
    status: { id: string; version: string; state: UpdaterStatus['state']; step: UpdaterStatus['step'];
      migrations: number | null; restore: boolean } | null;
    memory: UpdateMemory | null; online: string[]; answers: Record<string, 'ok' | 'refused' | 'silent'> | null;
    inFlight: boolean; maintenance: boolean; leads: boolean; atW: string[]; held: boolean };
  //   online: copies the sync controller has in sync or pace; answers: to the last promise, once every one came or
  //   ANSWER_MS passed, kept in memory only; inFlight: a request to the copies is out; maintenance: the lease's kind is
  //   maintenance (plan 3), the sessions ended; atW: promised copies whose slot's confirmed_flush_lsn is at or past
  //   memory.w; held: SyncController.held(); stopAcks: promised copies that answered 200 to { stop: true }
  export type UpdateAction =
    | { do: 'none' } | { do: 'promise'; to: string[] } | { do: 'answer'; ok: boolean; why: string | null }
    | { do: 'promise_again' } | { do: 'begin' } | { do: 'stop_copies' } | { do: 'settle'; ok: boolean }
    | { do: 'drop_slots' } | { do: 'end' };
  export function nextUpdateStep(s: UpdateSample): UpdateAction;
  // modules/keeper/lead-update.ts
  export const LEAD_UPDATE = 'lead-update.json';   // keeper folder: UpdateMemory, 0600, written before each act
  export class LeadUpdate {
    constructor(opts: { dir: string; controlDir: string; sql: Sql;
      sync: { copies(): { name: string; networkId: string; state: 'sync' | 'pace' | 'behind' | 'silent' }[];
        hold(on: boolean): void };
      peer: (networkId: string) => { request(method: string, path: string, body?: unknown, timeoutMs?: number):
        Promise<{ status: number; body: unknown } | null> };
      hostname: (networkId: string) => Promise<string>; leads: () => boolean; maintenance: () => boolean;
      now?: () => number; log: (line: string) => void; everyMs?: number });
    start(): Promise<void>;
    stop(): Promise<void>;
    busy(): boolean;   // status.json running, or a memory kept: Task 7's Hander reads it as updating()
  }
  // SyncSample gains hold: boolean; SyncController gains hold(on: boolean): void and held(): boolean, true once the
  //   hold is on, off is stored at the route's current generation and synchronous_standby_names names nobody
  ```
- `nextUpdateStep`, the first row that matches:

  | When | Action |
  |---|---|
  | status not `running` or null, memory set, `leads` | end |
  | status not `running` or null | none |
  | memory null or of another id, step `promise` | promise to `online` |
  | memory null or of another id | none (an update an updater of before this plan began) |
  | step `promise`, `answered` | none |
  | step `promise`, answers null, `inFlight` | none |
  | step `promise`, answers null | promise to `promised` (a keeper that started again with no answer) |
  | step `promise`, every one of `promised` `ok` | answer ok |
  | step `promise` | answer no, with the first copy's why |
  | `promised` not empty, `now` at or past `promisedAt + PROMISE_AGAIN_MS` | promise_again |
  | step `backup`, `maintenance`, `w` null | begin |
  | `w` set, not `settled`, every one of `promised` in `atW`, `migrations` not 0, not `stopped` | stop_copies |
  | `w` set, not `settled`, every one of `promised` in `atW`, `migrations` 0 | settle ok |
  | `w` set, not `settled`, `stopped`, every one of `promised` in `atW` and in `stopAcks`, `held` | settle ok |
  | `w` set, not `settled`, `now` at or past `wAt + W_WAIT_MS` | settle no |
  | `w` set, not `settled`, `stopped`, not every one of `promised` in `stopAcks`, not `inFlight` | stop_copies |
  | `restore`, not `dropped` | drop_slots |
  | otherwise | none |

  A `migrations` of null counts as not 0. The why of a copy that was `silent` is "<host> did not answer", of one that
  `refused` "<host> did not promise to wait".
- `LeadUpdate` acts, writing `lead-update.json` before each act. On `start`, before the keeper starts its sync
  controller, a memory with `stopped` or `dropped` true calls `sync.hold(true)`, so a restart never names a copy in the
  middle of an update:
  - `promise`: memory `{ id, version, migrations, promised: to, promisedAt: now }`; `POST /peer/updating` `{ version,
    until: now + PROMISE_MS, migrations }` to each, `ANSWER_MS` each, all at once; 200 `{ ok: true }` is `ok`, another
    answer `refused`, none `silent`. With no copy, answers `{}`, so ok at once.
  - `answer`: `PROMISED_FILE` `{ id, ok, why }`; `answered` true.
  - `promise_again`: the same request to `promised`, `promisedAt` now, and `net_local.maintenance.until` moved to `now +
    PROMISE_MS` when it is there; a copy that does not answer is logged, nothing more.
  - `begin`: `net_local.maintenance` (version, since now, until now + `PROMISE_MS`), then `pg_current_wal_lsn()` into
    `w`, `wAt` now.
  - `stop_copies`: `stopped` true written; `sync.hold(true)`; `POST /peer/updating` `{ stop: true }` to each of
    `promised` not yet in `stopAcks`, each 200 added to `stopAcks`.
  - `settle`: `SETTLED_FILE` `{ id, ok, why }`, why "The copies did not confirm the last changes" when no; `settled`
    true.
  - `drop_slots`: `{ stop: true }` to `promised`; `sync.hold(true)`; `dropSlots`; `DROPPED_FILE` `{ id, ok: true }`;
    `dropped` true.
  - `end`: `DELETE FROM net_local.maintenance`; `{ ended: true }` to `promised`, one try each; `sync.hold(false)`; the
    three files of that id and `lead-update.json` removed. `leads` is plan 3's normal lease with the app in `lead`, so
    copies hear "update ended" only after it (spec step 8).
- `nextSyncStep` with `hold`, four rows after `posting` and before every other: `hold`, `setting` set, off stored:
  `clear`, flag `relay_off`; `hold`, `setting` set: post off, flag `copy`; `hold`, off not stored: post off, flag null;
  `hold`: none, flag `relay_off`. With `hold` false the table is as it was, so the controller names a copy once one
  keeps pace (spec step 10).
- `updater.sh`, on the `lead` path only (Task 10 names the paths; until then, a machine with no `replica.json` and not
  `HORNHOOF_ROLE=worker`):
  - `unpack` also takes `/app/apps/server/drizzle/meta/_journal.json` as `journal.json`; a missing one is no failure.
  - `update`, after the downloads: `BEFORE=$(applied)` (moved up from `backup`); `MIGRATIONS` the journal's `.entries
    | length` minus `BEFORE` when both are numbers and that is 0 or more, else empty; `write_status` writes
    `migrations` (null when empty) and `restore` (true once `RESTORE=1`), from then on in every status.
  - `promise_copies`, then: `step promise "Asking the copies to wait for the update."`; once a second, up to
    `PROMISE_WAIT` seconds, `promised.json` with this `id`: `ok` true goes on; false `stop_with failed "<why>, so
    nothing changed."`; none `stop_with failed "The keeper did not answer, so nothing changed."`.
  - `step backup`, then `settle_wait`: up to `SETTLE_WAIT` seconds for `settled.json` with this `id`; `ok` true goes on
    to plan 2's stop of the app and the dump; else `stop_with failed "The copies did not confirm the last changes, so
    nothing changed."`.
  - `go_back`, when it restores: `RESTORE=1`, `write_status running rollback`, up to `DROP_WAIT` seconds for
    `slots-dropped.json` with this `id`; then `drop_slots` of its own, whether the file came or not: in `db`, as the
    owner, `pg_terminate_backend` of every slot's `active_pid` and `pg_drop_replication_slot` of every slot, again each
    2 s for up to `DROP_WAIT` seconds until `pg_replication_slots` has no row; then `keep_link` and `restore` as today.
    A slot still there at the end: no restore, `stop_with failed "Could not drop the copies' slots, so the database was
    not put back. Run install.sh server in $SERVER_DIR, and see docker compose logs keeper."`, the maintenance state
    staying until then.
  - `interrupted`: `promise` and `pull` start over (W not read yet); `backup` goes on from `backup`: `BEFORE` read again
    (no migration ran yet), `MIGRATIONS` from the status, `step backup`, `settle_wait` (the keeper's `settled.json` of
    this id stands, since the step, and so the maintenance state, never left `backup`), then the dump.
  - `PROMISE_WAIT` 30, `SETTLE_WAIT` 120, `DROP_WAIT` 60, each from `HORNHOOF_PROMISE_WAIT`, `HORNHOOF_SETTLE_WAIT`,
    `HORNHOOF_DROP_WAIT` when set, as `HEALTH_WAIT`.
- The docker stub: `cp` of `_journal.json` writes `{ "entries": [...] }` with as many entries as `STUB_MIGRATIONS` gives
  that build; a query of `pg_replication_slots` answers the lines of `$STUB_STATE/slots` (none when missing), and a
  `pg_drop_replication_slot` empties it unless `STUB_SLOTS_STAY` is set; `STUB_STOP_IN=backup` stops the updater at its
  first `pg_dump`, once, as `pull` does.
- Web: `UpdateStep` gains `promise`; `STEPS` is `['pull', 'promise', 'backup', 'install', 'health']`;
  `updates.steps.promise`: "asking the copies to wait" / «прошу копии подождать».

- [ ] **Step 1: Write failing tests.**
  - `update-steps.test.ts`: one test per row, named by it (for example `updates: settle no when a copy has not confirmed
    W within a minute`), each with a sample where every earlier row fails; and `answers ok at once with no copy`: step
    `promise`, `online` `[]`, after `promise`: answers `{}` gives answer ok.
  - `lead-update.test.ts`, on `createTestSql` with a temporary control and keeper folder and fake peers:
    - `promises and answers`: two copies in `pace`: each gets `{ version, until, migrations }` with `until` 15 minutes
      ahead; both 200: `promised.json` `{ id, ok: true }`; one silent: `ok` false with why "<its host> did not answer".
    - `waits for the copies at W, then stops them for migrations`: status `backup` with `migrations` 2, the lease in
      maintenance: one `net_local.maintenance` row; `w` read; the fake slots below W: no `settled.json`; at W: `{ stop:
      true }` to each, `hold(true)`; with one copy not answering the stop, or `held()` false (the relay silent): no
      `settled.json`, the stop sent again, and after 60 s `settled.json` `ok` false; with both answering and `held()`
      true: `settled.json` ok. With `migrations` 0: no `stop`, no hold.
    - `refuses the dump when a copy stays behind`: a slot below W for 61 s of fake time: `settled.json` `ok` false.
    - `drops the slots before a restore`: status `rollback` with `restore` true: `{ stop: true }` to each, the slots
      gone, then `slots-dropped.json`.
    - `ends only once it leads`: status `rolled_back`, `leads` false: the row stays; `leads` true: the row gone, `{
      ended: true }` to each, `hold(false)`, the files gone.
    - `promises again while the update runs`: 5 minutes of fake time in step `install`: a second promise and `until`
      moved.
    - `goes on after a restart`: a new `LeadUpdate` over the kept `lead-update.json` at step `backup` with `w` set:
      reads no new W and settles once the slots reach it; over one at step `promise` with `promised` set and no answer:
      sends the promise again; over one with `stopped` true: `hold(true)` before its first sample.
  - `sync-step.test.ts`: one test per `hold` row; `holds sync off`: with off stored, no setting and a copy keeping pace,
    `hold` gives none; `hold` false: `set` as before.
  - `updater.test.ts` (its stubs; the keeper's files written by the test):
    - `asks the copies before it saves the database`: with `promised.json` ok and `settled.json` ok: the status shows
      step `promise` before `backup`, `migrations` 2 for a build of 22 entries over 20 applied, and the dump comes after
      `settled.json` appeared.
    - `ends when a copy does not promise`: `promised.json` `{ ok: false, why: 'Mac did not answer' }`: `failed` with
      "Mac did not answer, so nothing changed.", no dump, no install.
    - `ends when no keeper answers`: no `promised.json` within `HORNHOOF_PROMISE_WAIT=1`: `failed` with "The keeper did
      not answer, so nothing changed.".
    - `ends when the copies do not confirm`: `settled.json` `ok` false: `failed` with "The copies did not confirm the
      last changes, so nothing changed.", no dump.
    - `waits for the slots before it restores`: a build that fails its health check after a migration: status `restore`
      true, then, after `slots-dropped.json`, the stub's slot query, then the restore; with none within
      `HORNHOOF_DROP_WAIT=1`, the updater's own terminate and drop, then the restore once the stub lists no slot; with
      the stub listing a slot throughout: no restore and `failed` with "Could not drop the copies' slots, so the
      database was not put back.".
    - `starts over when stopped while asking`: `STUB_STOP_IN` during step `promise`: the next start runs the update from
      the beginning. `goes on from the dump when stopped there`: stopped in `backup` after `settled.json`: the next
      start writes no `pull` or `promise` status, takes the dump and installs.
  - `test/real/update-rollback.test.ts`, on a pair as Task 4's, the copy subscribed and active, the leader's sync naming
    it: `LeadUpdate` through `begin`, `stop_copies` and `settle` with the fake relay; the dump taken as the updater
    takes it (`pg_dump` in the leader's container); a migration that adds a column applied on the leader; then status
    `rollback` with `restore`: `drop_slots`; the updater's restore commands run as `updater.sh` runs them
    (`hornhoof_restore` loaded from the dump, `DROP DATABASE hornhoof WITH (FORCE)`, the rename): they succeed; the
    restored database has the `net_local.maintenance` row the dump held, and not the new column; then `end`: the row is
    gone and the copy, its subscription enabled again, finds its slot missing, which is plan 9's remake.
  - `UpdateProgress.test.tsx`: `counts the promise as a step`: step `promise` is "2 of 5" with "asking the copies to
    wait", in Russian «прошу копии подождать».
- [ ] **Step 2: Run** the files of Done when. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Update with copies: their promise, the dump once they hold every change, sync off for
  migrations, slots dropped before a restore".

