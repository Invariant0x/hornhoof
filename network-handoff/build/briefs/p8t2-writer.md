You are the writer for Task 2 of 2026-11-03-network-phase-1-plan-8-merge in Hornhoof's network build. Read everything below before you start.

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

# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p8t2`, Hornhoof repo, branch `task-p8t2`. Kind: known behaviour, test-first as the plan says.
- The plan's "Starts from" line is paper here: this task goes ahead of its plan, because the pure part needs nothing that has not landed. Your lane stands on batch 6. You write `apps/server/src/modules/merge/rules.ts`, `facts.ts`, `words.ts` and `apps/server/test/merge-rules.test.ts`.
- All 31 tables of today's `public` have a rule. Eleven rules name tables no migration has made yet. In the test keep this set, and let the rule's checks skip those names: `LATER = applied, authority, certificates, computer_runs, machine_access, machine_online, machine_tickets, peer_secrets, person_keys, recovery_keys, tool_calls`. A later task shrinks the set as those tables land; a word in the test says so.
- `task_events.uuid` comes with Plan 3 Task 2 (being written beside you, not in your base). If a rule of yours reads that column, say so in your hand-in; the test must not depend on it yet.
- `openTestDb` is private at `apps/server/test/helpers.ts:37`, and a change to `helpers.ts` makes the batch run the whole server package. Do not touch it: build `Query` from `createTestDb()`'s `$client`, as `apps/server/test/db.test.ts:116` reads it, and leave the export to 8 T3. Say which half of a test you hold for 8 T3 if one must wait.
- Do not touch `schema.ts`. The planner checked by script that `CLOSING`, `SOFT_REFS` and the `number` and `task` columns hold for today's tables; your test is the proof, not its word.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 8: Merge, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a database of the company comes back after it went its own way, the leading machine brings into its own
database what that database did and the leader lacks: a change the journal proves is applied, a row the leader lacks
is added, and any other difference becomes a conflict with both values, which the orchestrator settles, or the CEO
when it is about people, access, plans or machines. In this plan the database a restore set aside merges at once, is
saved as an encrypted bundle for 30 days and then removed; the journal's way, which plans 9 and 10 need for copies and
split machines, is built whole and tested on forks of one database.

**Architecture:** One migration, `0054_merges` (custom): `net.merges`, `net.merge_rows`, `net.merge_conflicts`,
`net.merge_consumed`, `net.restores` and `net.horizon`, each with plan 3's fence, and `fork` among the reasons of
`net.backups`. A gate for the app's writes (`db/gate.ts`) lets a merge run while the app's own writes wait outside
their transactions. The folder
`modules/merge/` holds the rule of each table (`rules.ts`), what the catalog says of each table (`facts.ts`), the plain
words (`words.ts`), the source (`source.ts`, the one file more that the fence lint lets open a client), the reading of
both sides (`read.ts`), the planner (`plan.ts`), the applier (`apply.ts`), the completion check (`check.ts`), the kept
databases (`kept.ts`), the loop that runs merges while the app leads (`merger.ts`), the merge task (`task.ts`), the
picks (`picks.ts`), the orchestrator's tools (`tools.ts`) and the CEO's routes (`routes.ts`). The data keeper asks for
fork bundles through plan 7's dump path, the updater dumps a kept database, and the keeper's prune leaves the journal
alone while a merge waits. The web app gets the restore dialog's choice, the kept databases' states in Settings and
the CEO's merge card.

**Tech Stack:** TypeScript on Node 22; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite (`dumpDataDir` and
`loadDataDir` make a fork in tests); `pg` for the source's client; bash 3.2 and BusyBox for `updater.sh`; React for
the web app; vitest with PGlite; Docker for `npm run test:real` and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` section 5 (the cut-off return: "Safe merge", steps 1 to 8,
"After a restore", "Known limits"), 3.7 ("Sequences", "The journal", "Foreign keys", "No database is thrown away"),
3.8 ("Making": fork dumps are bundles; "Restoring": "A restore starts a new history ... to roll back on purpose, the
CEO removes those databases on the warning screen"), 3.9 ("Where a change came from"; "Jobs" for what this plan
leaves to plan 10) and section 12's merge bullets. Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan
8's entry.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in the series' worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/network` on its branch `network`, after plan 7's last task is
committed there. No new worktree: nothing of the series ships until the series merges into main, once, at its end.

**Handed over** (done on the `network` branch before this plan starts; none of it is shipped):
- Today's code: `db/schema.ts` (the tables, their keys and checks; agents' `kind` `orchestrator`, `head` or `worker`;
  the partial unique indexes `agents_one_head`, `agents_one_orchestrator` and `turns_one_open`; `notebook_notes`'
  `ON DELETE CASCADE` and `test_runs`' `ON DELETE SET NULL` on `department_id`); `db/agent-sql.ts` (`HIDDEN`);
  `db/agent-sql.ts`' `SECRET` (the columns that hold a password, a token or a key); `db/client.ts` (drizzle's
  `migrate`);
  `config.databaseUrl`; `modules/tasks/engine.ts` (`createTask`, `updateTask`, `TaskChange`, `Actor`, `NewTask`,
  `Wake`, `inRepository`); `modules/tasks/wake.ts` (`wakeAll`); `modules/tasks/tree.ts` (a task's branch is
  `task-<number>` when `inRepository`, a turn's `turn-<number>`); `modules/tasks/decisions.ts` (`DecisionSubject`,
  `decisionOwner`, `Decisions`, `visibleDecisions`); `modules/tasks/routes.ts` (`GET /api/requests`, which answers the
  decisions); `modules/tools/mcp.ts` (`toolsFor`: what is registered after its early return for every other kind of
  agent is the orchestrator's alone); `ctx.bus`; in `apps/web` `screens/Tasks.tsx` (the decisions, `ComputerCard`
  among them), `api.ts`, `types.ts`, `i18n/en.ts` and `ru.ts`.
- Plan 3: `net` and `net_local`; `net_local.state` (`cluster` is the system identifier); `net.journal` (`id`, `xact`,
  `at`, `tbl`, `op`, `key`, `cols`, `old`), written per table by `net."journal_<table>"()`; `net.fence_check()`,
  `net_fence` and `problems()` (`net.<table> has no fence trigger`); `net.defer_foreign_keys()` (every foreign key of
  `public` is `DEFERRABLE INITIALLY IMMEDIATE`); `stripSettings(url)` and `openPool` (the app's pool runs with
  `transaction_timeout=5s` and, under a keeper, `hornhoof.fenced=on`); `LeaseStore.prune(batch?)`, the keeper's prune
  timer and `test/real/lease-store.test.ts` (`prunes as the keeper after the lease ended`); the fence lint
  (`test/fence-lint.test.ts`); `createTestSql`, `setLease`; `npm run test:real` with `realDatabase()` on Postgres
  17.11. `openTestDb` in `test/helpers.ts` is not exported on the branch: Task 2 exports it.
- Plan 4: `applied (source, at, base)` and `tool_calls (id, job_id, answer, at)`; `nodeSource`, `webSource`,
  `toolSource`, `withSource`, `recordSources` (`db/sources.ts`: the one wrapper around the app's `db.transaction` and
  its write statements; a transaction in an open source inserts its step into `applied`); the
  tool wrapper that runs a tool call in `withSource(toolSource(<invocation>))`; `task_events.uuid`; the prune of
  `applied` and `tool_calls` beside the journal.
- Plans 5 and 5b: the columns the keeper's report writes on `machines` (`web_port`, `peer_port`, `commit`, `uptime_s`,
  `fsync_p99_ms`, `disk_free`, `report_at`, `addresses`, `path`, `direct_fails`, `renew_at`, `update_commit`,
  `update_state`, `owner_pin`) and those the follow of an update writes (`go_commit`, `go_at`, `failed_commit`,
  `failed_at`); the tables `authority`, `certificates`, `peer_secrets`, `machine_tickets`, `machine_online`,
  `person_keys`.
- Plan 6: `machine_access` (only a machine's owner opens it) and `computer_runs` (`waiting`, `sent`, `done`, `lost`).
- Plan 1b: `sign_in_attempts`, `link_tls`.
- Plan 7: `net.backups` and the check on its `reason`; the bundle's manifest `reason`; `machines.held_backups`;
  `recovery_keys`; `modules/backups/` (`bundle.ts`, `records.ts`, `holders.ts` with `pickHolders` and
  `refreshHolders`, `restore.ts`: `Restores`, `start`, `afterSwap`, `applyCarry`, `readRestoreStatus`; `types.ts`:
  `RestoreStatus` with `kept`, `MakerView`; `routes.ts`: `GET /api/backups` with the newest 10 bundles and `kept`,
  `POST /api/backups/:id/restore`, `GET /api/network/backups`, `POST /api/network/backups`, the report's
  `heldBackups`, at most 16); `restore.json` (`attempt`, `id`, `dumpedAt`, `carry`);
  `UpdaterControl.claim` and `POST /api/updates`; the keeper's `BackupKeeper` (`dump.json`, the latest 2 it keeps, one
  dump per 10 minutes); the updater's `dump_request`, `owned` and `applied`; the database `hornhoof_before_<stamp>` a
  restore keeps with its connections off; `apps/web/src/screens/Backups.tsx` (the restore dialog, `kept`) and
  `apps/web/test/api-mock.ts`; the lab's `steps.ts` and `backups.test.ts`; `guide/backups.md`.
- Where the branch's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and data made at run time.
- No new npm dependency. One new migration, `0054_merges`, by `npx drizzle-kit generate --custom --name merges` from
  `apps/server`; never an edit of an older one.
- The safe merge (spec section 5): the merge never deletes a row or overwrites a value on the leader unless the journal
  proves that the source changed it after the two parted, from the value the leader still holds, and the leader did not;
  a row's absence proves nothing, and a kept database never proves anything (rulings 3 and 5). It never writes the
  source: the source is read in one read-only transaction. Every difference it cannot prove stays as the leader has it
  and is listed with both values.
- A conflict's values are kept in `net.merge_conflicts` only. A secret column's value (ruling 9) never reaches the
  orchestrator, a screen, a log line or a task's text; no log line holds a row's values.
- Ivan's rules: only a machine's owner opens computer access to it, so no pick opens it (ruling 9); no step of this
  plan asks Ivan to type a command. Everything Ivan does here is a click: the restore's choice, a pick, "Leave it out".
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.


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

1. **One plan; what it leaves.** The reading, the planner, the applier, the records, the task and the picks only work
   whole, and each task below ends in something a reviewer can reject alone, so the plan is not split. Before plan 9
   no machine but the server holds data, so the only database that ever comes back in this plan is the one a restore
   set aside on the leader itself. (Deviations to rule on.) a) The spec's step 3 reads X "over the peer link"; this
   plan reads a database of the leader's own Postgres through one interface, `MergeSource`, and plan 9, which makes
   copies and the data link between machines, adds the source read over it. b) The overview's plan 9 entry cites
   "plan 8's restricted upload" (spec 3.3, a machine that lost whole-company scope uploads its unmerged rows): it is
   the peer reading of a) with a contract of its own, who may upload what and when the machine may wipe after, so it
   moves to plan 9, which defines both. c) Spec 3.9's jobs while a merge is pending (an unknown job keeps running, its
   events and results parked, X's tool tokens accepted) are plan 10's by the overview; section 5's "open ones stay
   open while their node lists them" and "parked results apply" need exactly those, so they go there too. Here
   nothing the source left open runs again (ruling 7). d) Steps 1 and 2 as a returning machine's own keeper and
   updater take them (fenced, `read`, its link stopped, its own bundle) and section 12's bullets about copies and
   returning machines are plans 9's and 10's; nothing runs on a kept database, and its bundle is ruling 15.
2. **A source is one database read in one snapshot.** `MergeSource` runs queries in one `REPEATABLE READ READ ONLY`
   transaction on its own connection, which `default_transaction_read_only` also opens read-only; its first query
   takes the snapshot before it answers. The merge reads the source only through it and never writes it. A kept
   database is read with the app's own credentials: the address is `stripSettings(config.databaseUrl)` with its path
   set to the database's name (in `pg` a database named in the address wins over a `database` option, so the name is
   never passed beside it), and the first query checks that `current_database()` is that name. `source.ts` is the
   one file the fence lint lets open a client beside its three. The two sides must have the same shape: in `public`
   the same tables with the same columns and types, else the merge waits with "The two databases are of different
   versions." The number of migrations is not compared: `0054` adds nothing to `public`, so a database plan 7 kept (at
   `0053`) merges, and a `net` table a source lacks (`net.merges`, `net.merge_rows`, `net.merge_conflicts`,
   `net.merge_consumed`, `net.restores`, `net.horizon`) reads as empty. The source's `companies` row must be the
   leader's, else "This database is of another company."
3. **Which way.** The merge compares row by row (spec "After a restore": only additions; every other difference a
   conflict, the leader's value kept) when the source is a kept database, when the leader has a restore (`net.restores`,
   ruling 13) the source lacks, or when the two journals share no id above the cutoff (step 3: "they prove nothing").
   Otherwise it goes by the journal. A kept database always compares, so a merge never undoes a restore's changes on
   its own: what the restore removed comes back as an addition, and what it put back as a difference.
4. **Where the two parted.** The cutoff is the later of the two sides' horizons (`net.horizon`, ruling 14), less one
   day, or none when neither side pruned. A side's ids are its journal rows at or after the cutoff. `A`, the source's
   changes, are its ids the leader lacks and no merge consumed (`net.merge_consumed`); `B`, the leader's, are its ids
   the source lacks; `shared` counts the ids both hold. The day of margin only widens what is read and proves nothing
   by itself: a journal row's `at` is when its row changed, not when its transaction committed, and a prune deletes
   in batches. What a row of `A` proves is ruling 5's base check.
5. **What the journal proves.** First the source's transactions whose source the leader lists go: every row of `A`
   whose `xact` also inserted an `applied` row the leader's `applied` lists, or a `tool_calls` row the leader's
   lists, is consumed as `skipped` (spec step 4). Those rows, and every row of `A` older than the leader's own horizon
   (the leader may have pruned what it did then), are `S`: read, compared, never taken. The rest of `A` proves. Per
   table and key, with the key's rows of `A` and `S` in order (`at`, then `id`; plan 3 writes one key's rows in the
   order their transactions took the row), X the source's row now and Y the leader's, and the columns of ruling 6 left
   out everywhere:
   - A column's base is its value on the source before `A` first changed it: the `old` of the first row of `A` that
     names it. A key whose first row of `A` is an insert has no base.
   - X and Y both have the row: a column is taken from X only when a row of `A` changed it, no row of `S` names it,
     `B` neither changed it nor inserted or deleted the key, and Y's value is its base. A key `A` inserted that Y holds
     (only a natural key can) is compared whole: equal, or a conflict `differs`. Any other column that a row of `A` or
     `S` names and whose values differ is in conflict; one row may take some columns and list others. A column no row
     of `A` or `S` names is the leader's.
   - X has the row and Y none: added when `A` inserted the key and `B` did not delete it; else a conflict
     `changed_removed`.
   - X has no row: Y's row is deleted only when the key's last row in `A` and `S` is a delete of `A`, `A` did not
     insert the key, `B` did not touch it, and Y's row equals the base row (that delete's `old`, with each column an
     earlier row of `A` changed at its base); the applier then looks for the leader's rows that point at it (ruling
     8). A key `A` inserted and deleted again is nothing. Otherwise nothing is deleted, and when a row of `A` named a
     column of the key and Y has the row, it is a conflict `removed_changed` whose `there` is the key's last `old` in
     the source's journal (the row as it was before it went; a `bytea` value only as its hash).
   - A key only `B` touched, or only `S`, is the leader's: the leader has its own result of that input.
   So a row's absence never deletes, a value a skipped transaction wrote is never taken, and an update that changed
   nothing (`cols` empty) does nothing.
6. **Columns that are never compared.** `updated_at` (on `tasks`, `notebook_notes`, `improvements`) and `tasks.version`;
   `nodes.last_seen_at`, `nodes.status` and `nodes.version`; `subscriptions.status`, `limits` and `models`;
   `machines.server_order` and `server_why` when plan 9 has added them; and the machine columns plans 5, 5b and 7 have
   the keeper's report and an update's follow write (Handed over, and `held_backups`). A row the merge adds brings the
   source's values; a row it changes keeps the leader's, but for `updated_at`, which takes the later of the two, and
   `tasks.version`, which takes the larger plus 1. (Additions to rule on: the spec lists `nodes.last_seen_at`,
   `nodes.status`, `subscriptions.status`, `limits`, `models`, `server_order`, `server_why`, `updated_at` and
   `tasks.version`; `nodes.version` and the machines' report columns are reports as those are, written every minute
   on both sides, and would make every machine a conflict.) An end both sides recorded is one end: two non-null values
   of `revoked_at`, `removed_at`, `closed_at`, `used_at` or `retired_at` count as equal and the leader's time stays, so
   a certificate revoked on both sides, or the restore's carry, lists nothing. Values are compared by their type: a
   timestamp as an instant to the microsecond, a `bytea` by its SHA-256 (the journal keeps only `sha256:<hex>`),
   anything else as JSON with an object's keys sorted.
7. **The rule of each table** (`rules.ts`; a table `public` holds that the list does not name stops the merge with
   "No merge rule for public.<table>.", and a test keeps the list whole):
   - Never merged (`skip`): `node_codes`, `machine_tickets`, `pending_wakes`, `sign_in_attempts` and `link_tls` (spec
     step 5: join codes and waiting wakes go; tickets are join codes too; a sign-in count and the link's certificate
     belong to the machine that leads). `sessions` stay (spec) by the journal, but are never added after a restore,
     whose carry ended every session on purpose (plan 7, ruling 14).
   - Added and never compared (`add`): `applied`, `tool_calls`, `machine_online`. A source's `applied` row the leader
     lacks is added, so a node that sends that message again finds it done.
   - Logs (`log`), matched by a column and added with a new sequence value (spec 3.7), never compared and never
     deleted: `agent_events` by `id` with a new `seq`, `task_events` by `uuid` with a new `id`, `agent_changes` by
     `id`. By the journal a `task_events` key (its `id`, a number of each side) is read as its row's `uuid` on the
     source first, and the leader's row is found by that uuid. `attachments` stay `rows` (deviation to rule on): main
     sets an attachment's `request_id` when a picture is attached to a request and deletes old files by its retention,
     changes the journal proves; after a restore `compare` only adds them, as it would a log's.
   - `map_returns.source_key` (`task:<id>` or `message:<seq>`, numbers of each side) is read on both sides as the
     uuid of that event before it is compared, and written as the leader's number of the event with that uuid, in an
     added row, a change and a pick; with no such event on the leader the unit is `refused` ("Its task_events row is
     not here."). The logs go before `map_returns` (the rule's `after`).
   - Numbers (`tasks`, `turns`, `test_runs` per company, `notebook_notes` per company and department): a row added
     whose number another row of its scope holds takes the next free one, the scope's highest plus 1; the source's
     number is kept for the task's text ("was #57").
   - One open turn: a turn added `open` while the leader has another open turn is added `closed`, `closed_at` now, and
     the source's tasks of that turn that are not done or cancelled are added in the leader's open turn.
   - One head and one orchestrator: an agent added as `head` of a department that has a live head, or as
     `orchestrator` while one is live, is added as `worker`.
   - Nothing runs again: a row of `jobs`, `computer_runs`, `test_runs` or `test_parts` that the merge or a pick writes
     in an open state is written closed: a job `queued` or `running` as `failed`, `finished_at` now, with the error
     "Ran on <label> while it was cut off." (by the journal) or "Ran before the restore; how it ended was not kept."
     (after a restore); a computer run `waiting` or `sent` as `lost`, `done_at` now; a test run `running` as
     `stopped`, `finished_at` now; a test part `queued` or `running` as `stopped`, `finished_at` now, with the job's
     error. Main's scheduler hands out queued test parts by themselves, so a failed job alone would not stop them. A
     row the leader holds open stays as it is (plan 10).
   - Computer access is never opened by a merge: `machine_access`' `until`, `opened_by`, `opened_at` and `grant` are
     never taken from the source; a row the merge adds has them null, and a difference in them is a conflict only
     `here` settles (ruling 11). So a machine added after the restored bundle comes back with its access closed.
   - One unique match: a `person_access` row whose insert fails on `person_access_place` is that place's row on the
     leader when every other column but `id` and `created_at` is equal (plan 7's carry writes these rows with new
     ids); it is recorded as `matched`, and no row points at a `person_access` row. Any other error of class 23 is
     `refused`, naming the constraint. No other unique key matches rows: a key's predicate and its nulls
     (`agents_one_head`, `jobs.tool_token_hash`) would make a match by its columns wrong.
   - Soft references (`SOFT_REFS`), ids in a column no foreign key checks: `tasks.gates` and `tasks.panel` (agents),
     `tasks.after` (tasks), `subscriptions.target_id` (a department or a team, by `target_kind`). They are checked as
     foreign keys are (ruling 8). The ids and names in `turns.messages`, `task_events.data` and `agent_events.data`
     are history, shown as written, and not checked.
   - `net.backups` rows the leader lacks are added by id, in both ways: a restore of an older bundle then lists, and
     can check, the bundles made after it. (Addition to rule on.)
   - A conflict an earlier merge left open in the source (its `net.merge_conflicts`) is carried: it becomes a conflict
     of this merge with its kind, its operation and its `there`, `here` the leader's row now, and `carried` the id it
     had first, unless the leader holds a conflict of that first id already. It may hold the only copy of a value the
     company wrote.
   - Topics, which say whose a conflict is: `people` (`people`, `invites`, `sessions`, `person_keys`,
     `sign_in_attempts`), `access` (`person_access`, `machine_access`, `recovery_keys`, `certificates`, `authority`,
     `peer_secrets`, `public_links`, `link_tls`), `plans` (`subscriptions`, `nodes`, `plan_credentials`), `machines`
     (`machines`, `machine_online`, `computer_runs`, `node_codes`, `machine_tickets`), and `work`, the orchestrator's,
     for every other table. Every table in `HIDDEN` has a topic of the CEO's or is `skip` or `add`.
8. **One transaction, while the app's writes wait outside theirs.** The merge runs inside the write gate
   (`db/gate.ts`): every write of the app's process enters the gate before its `BEGIN` and leaves after its end (a
   `db.transaction` that is not read-only and a write statement outside one, both in plan 4's `recordSources`
   wrapper, and an agent's SQL in `write` mode). The merge closes the gate to new writers, waits up to 30 s for those
   inside to leave, and then holds it alone. So a write that comes during a merge waits before its transaction opens,
   plan 3's 5 s `transaction_timeout` never ends it, and no lock of the app's is held when the merge locks, so no
   lock order can cross. (Addition to rule on: the spec says only that the app's writes wait.) Then `REPEATABLE READ`;
   `SET LOCAL lock_timeout = '10s'`, `statement_timeout = 0` and `transaction_timeout = 0`; `LOCK TABLE` every table of
   `public` the merge may write `IN EXCLUSIVE MODE` (reads go on), for any session outside the gate, before the first
   read takes the snapshot; then `SET CONSTRAINTS ALL DEFERRED`. Each row the merge writes is a unit, tables parents
   first (by their foreign keys and the rules' `after`, a cycle in name order), each under a savepoint (a batch of
   units may share one, and goes one by one when it fails). An error of class 23 (a unique key, a check, a null) takes
   the unit back to its savepoint and makes it `refused`, naming the constraint; any other error (a lock not taken in
   10 s, a fault) ends the whole transaction and changes nothing, and the merge is tried again later. Then the
   reference pass: every unit whose row points, by a foreign key or a soft reference, at a row that is not there is
   made `refused` ("Its <table> row is not here."), and the merge goes back to a savepoint taken before its first
   unit and writes again every unit not refused, until a pass refuses none. Nothing is ever undone by a delete or a
   value put back, so no `ON DELETE CASCADE` or `SET NULL` acts on a unit's account and no unique key another unit took
   is met by an old value; a unit that fails only in a replay is refused as in the first pass. That is the spec's row
   group: a row whose parent failed fails with it, and the merge never aborts. (Deviation in form: the group is found
   after the fact by the references and replayed, not built before, which also covers the cycle of `turns` and
   `tasks`.) A unit that deletes first looks for the leader's rows that point at the row, by a foreign key or a soft
   reference: then `still_used`, so no delete of the merge cascades. Rows the merge writes wake nobody (spec step 5):
   it writes rows only, and the screens are told once to read again.
9. **The records, and when the source may go.** The same transaction writes `net.merge_conflicts` (both values, the
   operation `there` would run, the source's latest `at`, the task the row belongs to); every id of `A` and `S` into
   `net.merge_consumed` as `applied`, `skipped`, `conflict` or `equal` (spec step 6); `net.merge_rows` for what a key
   alone does not show: a row of `S` the leader lacks (`skipped`), a matched row (`matched`, with the leader's key),
   and a row written with other values than the source's (`rewritten`, with those columns and the source's values: a
   number, a closed turn, a worker, a closed job, run or part, closed access); and on `net.merges` the counts, the
   tasks it touched, the code (ruling 10), the cutoff, its own `xact` and the status `applied`. A merge `applied`
   never runs again: after a stop it goes on with its check, so nothing it did is read as a new difference. The check
   reads the source again, in a new snapshot:
   - by the journal, every id of the source at or after the cutoff is on the leader or consumed;
   - every row of a table that is not `skip` (nor `sessions` after a restore) is on the leader by its key (a log's by
     its match), and, but in a `log` or `add` table, equal to it as ruling 6 compares (`source_key` in uuid form),
     leaving out the columns `net.merge_rows` names `rewritten` for it; or its key is named by a conflict of any merge,
     or by `net.merge_rows` as `skipped`, or as `matched` with the leader's key there; or the leader's journal names its
     key since the two parted (by the journal at or after the cutoff, after a restore once the merge was applied) in a
     transaction no merge made (`net.merges.xact`), which is the company's own later change or deletion;
   - every `net.backups` row and every open conflict of the source is on the leader.
   Only then is the merge `merged`, and only a merged or left-out source may be dropped. A row of the source that is
   neither there nor listed keeps the check failing and the database kept, the safe way. A secret column is one that
   `SECRET` of `db/agent-sql.ts` names for its table (`machines.machine_key` and `nodes.account` among them), or whose
   name ends in `_hash` or `_enc`, or is `sealed`, `wrapped`, `salt`, `iv` or `grant`: its values are kept for a pick
   but shown as "(hidden)", also where a row's name would show its key (`sessions.token_hash`). A conflict on
   `machine_access` can only be settled by keeping the leader's row: computer access is opened by the machine's owner,
   on its card (plan 6).
10. **The merge task.** A merge with a conflict of the orchestrator's, a renumbered row or a task with code becomes one
    task of the orchestrator's (spec step 7), made by `createTask` as the orchestrator with himself as assignee:
    "Bring back what <label> did while apart (<from> to <to> UTC)" by the journal, "Bring back what <label> held
    (<from> to <to> UTC)" after a restore. What it needs is on `net.merges`, written in the merge's transaction, since
    the source may be gone when the task is made: `tasks`, the tasks of every row the merge added, changed or listed,
    and `code`, for each of them that `inRepository`: its number on the source, its branch by that number, and the
    machines the source's jobs on it ran on with their last time (spec step 8). Its body says what came back, counts,
    the renumbering ("Task #63 here was #57 on <label>"), the code, the orchestrator's conflicts grouped by task and
    then by table with both values in plain words (at most 100, then "and <n> more; merge_conflicts lists them"), and
    of the CEO's only how many: no value, name or table of a conflict of the CEO's or of a table in `HIDDEN` reaches
    the orchestrator. Then what to do: settle them with `merge_conflicts` and `merge_pick`, tell the holders of tasks
    that changed, and report to the CEO what was kept and what he decided. A second source merged while that task is
    open joins it (spec: "More than two sides merge one at a time into the same merge task"): its title names every
    source and its body is written again by `updateTask` as the orchestrator, who is woken on it (`wakeAll`,
    `assigned`). With no live orchestrator that can take it, the task is tried again each minute; the drop and the
    CEO's conflicts do not wait for it.
    Renumbered tasks and turns keep no branch column: their code stays on the branch of the source's number, which
    the task names, and the orchestrator moves it. (Deviation to rule on: a branch column on tasks and turns would let
    a renumbered task keep its branch; it is left out, since branches today follow numbers everywhere.)
11. **Picks.** `merge_pick` settles conflicts of the orchestrator's topic: one, a list, or every open one of a merge,
    a table or a time range (spec: "in bulk by table, side or time range"), at most 500 a call. `here` keeps the
    leader's row as it is; `there` runs the conflict's operation with the source's values (an update writes its
    columns, an insert adds the row with ruling 7's rules, a delete removes the leader's row when nothing points at
    it); `value` writes the given columns of one `differs` conflict. Each conflict settles in its own transaction,
    journaled and fenced as any change of the app, in the tool's source, but for a group: `there` on a `refused`
    conflict settles with it, in one transaction, every open `refused` conflict of the same merge its row points at or
    that points at its row (by foreign keys and soft references, both ways, on and on), since a turn and its task can
    only come back together; the group settles or fails whole, and is the CEO's when one of it is. One that fails
    stays open with its reason. The answer names the tasks whose rows changed, whose holders he tells. The CEO picks
    the same way on his screen, any conflict, and is the only one for `people`, `access`, `plans` and `machines` (spec
    step 7), each a decision of his (`DecisionSubject` `merge`).
12. **Kept databases.** At its first lead after a start the app makes a `net.merges` row (`kept:<name>`) for each
    database named `hornhoof_before_<stamp>` that has none: `pending`, or `removing` when the CEO chose so (below) or
    when it holds no company. Its label is "the database from before the restore of <time>", or "the database kept as
    <name>" for one plan 7 kept before this release, which has no mark. The app turns its connections on (`ALTER
    DATABASE ... ALLOW_CONNECTIONS true`) to read it. A `fork` id is set when it holds the company, and the data
    keeper makes that fork bundle (ruling 15). The merger runs one merge at a time, every minute while the app leads,
    waiting twice as long after each failure, up to an hour: a `pending` merge is applied and then checked, an
    `applied` one only checked; a merge `merged` or `removing` whose fork bundle is in `net.backups` (or that needs
    none) has its database dropped and is `done`. The restore dialog has "Bring back what came after <time>", on by
    default; turned off, the database is left out: its bundle is made and it is dropped without a merge (spec 3.8:
    "the CEO removes those databases on the warning screen"). The choice is written to `/control/restore-choice.json`
    before the order goes, since the app's memory does not outlive the swap, and removed only after the `net.merges`
    row that holds it has committed; a file of another attempt stays for the next restore to write over. Settings
    shows each kept database's state, and "Leave it out" while its merge is `pending` or `applied`. An Update is
    refused while a merge is `pending` or `applied`, since migrations could part the two shapes (ruling 2): "A database
    from before a restore is still being brought back. Wait for it, or leave it out in Settings." (Addition to rule
    on.) The fork bundle is asked for at once and the merge does not wait for it, since the database stays until both
    are done.
13. **A restore leaves a mark.** `afterSwap` writes `net.restores` (the attempt, the bundle, its `dumpedAt` and the
    kept database's name) once per attempt, also after a restore from a recovery file, which has no carry. The order
    does not outlive the swap and the restored database rarely holds its own bundle's record (the record is written
    after the dump), so the updater writes `dumpedAt` from `restore.json` into `restore-status.json` beside `kept`. A
    status written before this release has no `dumpedAt` and leaves no mark. Plan 9's sources read the mark (ruling 3).
14. **The prune knows the merges** (plan 3's ruling 19). `LeaseStore.prune` deletes journal rows older than 7 days only
    while the lease's sync is `alone`, the lease has not lapsed (`until` ahead of now) and no merge is `pending` or
    `applied`; each prune that deletes a row writes `net.horizon.below` (7 days ago) in the same transaction and
    deletes `net.merge_consumed` rows older than it. Plan 3's real test that prunes as the keeper after the lease ended
    changes with it. Plan 9, with copies, adds "every data machine confirmed".
15. **Fork bundles.** A fork bundle is a bundle as plan 7 makes them, with the reason `fork`: the keeper writes
    `dump.json` with the kept database's name, the updater turns its connections on and dumps it, and the keeper
    seals, signs and records it, sending the record again until `net.backups` has it. It is kept 30 days from
    `madeAt` outside the usual rotation (spec step 2), on the data machine and on its holders: its holders are picked
    as for any bundle, and it stays named for them beside the newest 2 until its 30 days end. It is listed in "Restore
    from a backup" beyond the newest 10 as "Set aside before a merge", reported held beyond the newest 16 (at most 32
    in all), and restores as any other.
16. **Times in a task's text are UTC.** A task's title and body are stored text that every reader sees alike, so they
    say "14:02 to 15:30 UTC", with the day when the two are not on one day.

## Review Focus

1. A confirmed write lost silently: a row or column of the source that is neither on the leader nor listed after a
   merge, by either way, also after a unit failed, a transaction was skipped, a parent was refused or the app stopped
   between the merge and its check. Tests in Task 4 (every case of `journalOutcome`, `lists a change whose base the
   leader no longer holds`) and Task 5 (`finishes the completion check`, `refuses a row whose parent is gone, and what
   hangs on it`, `never deletes through a skipped transaction`, `carries a conflict left open`).
2. A restore undone behind the CEO's back: a kept database's deletions or older values written over the restored
   ones. Tests in Task 5 (`never reads a stale absence as a deletion or a stale value as a change`) and Task 10 (`an
   older bundle restored, then the database from before`).
3. The company working while a merge runs: a task moved, an invite accepted, a page saved meanwhile. The writes wait
   before their transactions, under 30 s on a big company, and land after; none ends at 5 s, and the merge does not
   list them. Tests in Task 3 (`gates the app's writes`), Task 5 (`holds the app's writes while it runs`) and Task 10
   (`writes wait for the merge`, `holds the app's writes briefly on a big company`).
4. Something of the source running or opening again: a job, a test part, a command, or computer access on a machine
   added after the bundle. Tests in Task 5 (`stops what the source left running`, `brings back a new machine with its
   access closed`) and Task 8 (`never opens computer access`).
5. A conflict in the wrong hands: the orchestrator seeing a secret, a CEO's conflict or a hidden table in a list or in
   his task's text, settling a CEO's conflict, or a secret shown in a row's name. Tests in Task 2 (`hides secrets`),
   Task 8 (`keeps the CEO's conflicts and secrets from the orchestrator`, `tells the orchestrator only how many are
   the CEO's`) and Task 9 (`lets only the CEO pick his conflicts`).
6. A kept database dropped too soon, not at all, or the wrong one: before its bundle is recorded, before the check
   passed, the live database read in its place, or a name that is not a kept database's. Tests in Task 6 (`drops only
   what is merged and saved`, `goes on with the check after a stop`) and Task 10 (`reads the kept database, not the
   live one`, `drops only a kept database`).

---


# The task

### Task 2: The rule of each table, the catalog and the words

**Repo:** the `network` worktree, branch `network`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/merge-rules.test.ts` passes, then the whole server
suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/merge/rules.ts`, `apps/server/src/modules/merge/facts.ts`,
  `apps/server/src/modules/merge/words.ts`
- Modify: `apps/server/test/helpers.ts` (`openTestDb` exported, as it is)
- Test: `apps/server/test/merge-rules.test.ts` (new)

**Interfaces:**
- Consumes: `HIDDEN`, `SECRET` (`db/agent-sql.ts`).
- Produces:
  ```ts
  // modules/merge/rules.ts
  export type Topic = 'people' | 'access' | 'plans' | 'machines' | 'work';
  export const CEO_TOPICS: readonly Topic[];                 // people, access, plans, machines
  export type TableRule = {
    kind: 'rows' | 'add' | 'log' | 'skip';                   // ruling 7
    topic: Topic;
    match?: string;                                          // log: the column rows are matched by
    sequence?: string;                                       // log: the column that takes nextval on an added row
    number?: readonly string[];                              // the scope columns of a per-scope `number`
    task?: string;                                           // the column naming the task a row belongs to
    after?: readonly string[];                               // tables planned before it besides its parents
    afterRestore?: 'skip';                                   // sessions
    hereOnly?: readonly string[];                            // columns never taken from the source (ruling 7)
  };
  export const TABLE_RULES: Readonly<Record<string, TableRule>>;
  export const BOOKKEEPING: Readonly<Record<string, readonly string[]>>;   // ruling 6, per table
  export const ENDS: readonly string[];                      // revoked_at, removed_at, closed_at, used_at, retired_at
  export type Closing = { column: string; open: readonly string[]; to: string; at: string; error?: string };
  export const CLOSING: Readonly<Record<string, Closing>>;   // ruling 7's "Nothing runs again"
  export type SoftRef = { table: string; column: string; parent: string; list: boolean;
    when?: { column: string; value: string } };
  export const SOFT_REFS: readonly SoftRef[];
  export function ruleOf(table: string): TableRule;          // throws Error(`No merge rule for public.${table}.`)
  export function isSecret(table: string, column: string): boolean;   // ruling 9
  export function ceosConflict(table: string): boolean;      // CEO_TOPICS has its topic
  // modules/merge/facts.ts
  export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  export type ForeignKey = { name: string; table: string; columns: string[]; parent: string; parentColumns: string[] };
  export type TableFacts = { name: string; columns: { name: string; type: string }[]; key: string[];
    fks: ForeignKey[]; referencedBy: ForeignKey[] };
  export type Facts = { tables: Map<string, TableFacts>; order: string[] };
  export function factsOf(q: Query): Promise<Facts>;
  //   from pg_catalog for the tables of public (relkind r): columns with format_type, the primary key, foreign keys
  //   both ways; order lists the tables parents first and each after the tables its rule's `after` names, a cycle in
  //   name order
  export function sameShape(a: Facts, b: Facts): string | null;   // null, or 'The two databases are of different versions.'
  //   the tables of public, their columns and types; nothing else
  // modules/merge/words.ts
  export function nameOf(table: string, row: Record<string, unknown> | null, key: Record<string, unknown>): string;
  export function valueWords(table: string, column: string, value: unknown): string;
  export function timeWords(at: Date, now?: Date): string;          // '3 Nov 14:02 UTC', the year when not now's
  export function rangeWords(from: Date, to: Date, now?: Date): string;
  //   '14:02 to 15:30 UTC' within one UTC day, else '3 Nov 14:02 to 4 Nov 09:10 UTC'
  ```
- `TABLE_RULES`, exactly (every other field absent):
  ```text
  skip  node_codes (machines), machine_tickets (machines), pending_wakes (work), sign_in_attempts (people),
        link_tls (access)
  add   applied (work), tool_calls (work), machine_online (machines)
  log   agent_events (work; match id, sequence seq), task_events (work; match uuid, sequence id, task task_id),
        agent_changes (work; match id)
  rows  people (people); sessions (people, afterRestore skip); invites (people); person_keys (people)
        person_access (access); machine_access (access, hereOnly until, opened_by, opened_at, grant);
        recovery_keys (access); certificates (access); authority (access); peer_secrets (access);
        public_links (access)
        subscriptions (plans); nodes (plans); plan_credentials (plans)
        machines (machines); computer_runs (machines)
        companies, departments, teams, agents, proposals, improvements, test_parts (work);
        tasks (work; number company_id; task id); turns (work; number company_id; task task_id);
        test_runs (work; number company_id; task task_id); notebook_notes (work; number company_id, department_id);
        jobs, requests, attachments (work; task task_id);
        map_returns (work; task source_task_id; after task_events, agent_events)
  ```
- `BOOKKEEPING`: `tasks` `updated_at`, `version`; `notebook_notes` and `improvements` `updated_at`; `nodes`
  `last_seen_at`, `status`, `version`; `subscriptions` `status`, `limits`, `models`; `machines` `server_order`,
  `server_why`, `web_port`, `peer_port`, `commit`, `uptime_s`, `fsync_p99_ms`, `disk_free`, `report_at`, `addresses`,
  `path`, `direct_fails`, `renew_at`, `update_commit`, `update_state`, `go_commit`, `go_at`, `failed_commit`,
  `failed_at`, `owner_pin`, `held_backups`. A name a table does not have is ignored.
- `CLOSING`, exactly: `jobs` `status` `queued`, `running` to `failed`, at `finished_at`, error `error`;
  `computer_runs` `state` `waiting`, `sent` to `lost`, at `done_at`; `test_runs` `status` `running` to `stopped`, at
  `finished_at`; `test_parts` `status` `queued`, `running` to `stopped`, at `finished_at`, error `error`.
- `SOFT_REFS`, exactly: `tasks.gates` and `tasks.panel` to `agents`, `tasks.after` to `tasks`, each a list;
  `subscriptions.target_id` to `departments` when `target_kind` is `department`, and to `teams` when it is `team`.
- `isSecret(table, column)`: `SECRET[table]` holds it, or the name ends in `_hash` or `_enc`, or is `sealed`,
  `wrapped`, `salt`, `iv` or `grant`.
- `nameOf`: `tasks` `task #<number> "<title>"`; `turns` `turn <number> "<title>"`; `people` `<name> (<email>)`;
  `agents`, `departments`, `teams` `<name>`; `machines` `<hostname>` or `a machine`; `subscriptions` `<label>`; `jobs`
  `job <the id's first 8 characters>`; every other table `<table> <the key's values joined by ", ">`, a secret
  column's value as `(hidden)`. With no row, from the key. `valueWords`: `(hidden)` when `isSecret`; `nothing` for
  null; text in double quotes, cut at 200 characters with `...`; anything else its JSON, cut the same way.

- [ ] **Step 1: Write failing tests** in `merge-rules.test.ts`:
  - `has a rule for every table`: on `openTestDb()`, every table of `public` has `ruleOf`; `TABLE_RULES` names no table
    `public` lacks; `ruleOf('nope')` throws `No merge rule for public.nope.`; every table and column `CLOSING`,
    `SOFT_REFS` and `hereOnly` name is in `factsOf`.
  - `gives every hidden table to the CEO or keeps it out`: each name in `HIDDEN` has a topic in `CEO_TOPICS` or the
    kind `skip` or `add`.
  - `reads the catalog`: `factsOf` on the test database gives `tasks` the key `['id']`, a foreign key to `turns` and
    one from `turns`; `map_returns` a key of three columns; in `order`, `departments` before `teams`, `teams` before
    `agents`, and `task_events` and `agent_events` before `map_returns`. `sameShape` of the facts with themselves is
    null; with a column dropped from a copy of the facts, or its type changed, it is the sentence.
  - `hides secrets`: `isSecret` is true for `people.password_hash`, `jobs.tool_token_hash`, `subscriptions.secret_enc`,
    `nodes.key_hash`, `nodes.account`, `machines.machine_key`, `departments.repo_token_enc`, `sessions.token_hash`,
    `person_keys.wrapped`, `person_keys.salt`, `machine_access.grant`, and false for `tasks.title`, `people.email`,
    `nodes.status`; `valueWords('machines', 'machine_key', 'x')` is `(hidden)`; `nameOf('sessions', null, {
    token_hash: 'abc' })` holds no `abc`.
  - `says rows and times in plain words`: `nameOf('tasks', { number: 57, title: 'Fix login' }, ...)` is `task #57 "Fix
    login"`; a 300-character title is cut at 200 with `...`; `rangeWords` of 14:02 and 15:30 on one UTC day is `14:02
    to 15:30 UTC`, across midnight `3 Nov 23:50 to 4 Nov 00:10 UTC`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the three files and the export.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Give every table its merge rule, and read what the catalog says of each".

