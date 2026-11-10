You are the writer for Task 2 of 2026-11-03-network-phase-1-plan-3-fences-and-journal in Hornhoof's network build. Read everything below before you start.

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

- Your lane: `/home/altera/hornhoof-network/wt/p3t2`, Hornhoof repo, branch `task-p3t2`. Kind: known behaviour, test-first as the plan says. Security class: fences, roles and rights.
- Your lane stands on batch 6 (2 T3, 1b T7 with migration `0055_link_tls`, the sql-check part of 3 T3) and on 3 T1 (`test/real/pg.ts`: `realServer`, `realDatabase`, `poolOf`). Those are below your `lanebase` (tag), not yours. Batch 6 is under review; a fix may reach your base, and the lead carries it.
- You are next in the migration chain. Migration numbers are what `drizzle-kit generate` gives (build ruling 5): the plan's number plus 11, so yours follow `0055_link_tls`. A plan's text and tests read so.
- `apps/server/src/db/agent-sql.ts` changed in 1b T7: `role` takes the rights as a function and `readVisible` holds the repeated GRANT line; `link_tls` is hidden from agents. Follow the code. `apps/server/test/migration-history.test.ts` pins the migration count in two places: update both.
- `checkAgentSql` and `REFUSED_FUNCTIONS` are in `apps/server/src/db/sql-check.ts`; do not make a second list.
- Docker only on the test machine, inside your own run. `test:real` needs a daemon: `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/p3t2 /home/altera/hornhoof-network/network-build/remote.sh run --dind p3t2-real 'cd /home/altera/hornhoof-network/hornhoof && npm run test:real'`, waiting in the foreground with `remote-wait.sh`; inside the container your lane sits at the path `hornhoof`. Name that log in your hand-in beside the author check. Never run Docker on this machine.
- Tests that race use real transactions held open with their own clients and wait on the lock, never on time.
- A migration makes a batch's check the whole suite; that is the batch's, not yours.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 3: Fences and the Journal on One Machine, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every change to the company's data writes a journal row, and Postgres commits it only while the keeper holds a
lease (fence 1). The keeper renews that lease each second on its own connection, ends it and the app's and agents'
sessions when a tick comes late or the lease lapses (fence 4), and leads only while every table carries its trigger and
the agents' rights are as they must be. Transactions of the app and the orchestrator's role end when they run 5 s before
their commit (fence 2). The orchestrator's SQL is parsed with Postgres's own parser and may no longer commit, set,
cancel or reach the fence, and any warning at commit reaches its caller as "not confirmed". The keeper answers
`/api/network/lease` on the link. Real Postgres 17.11 runs the tests that PGlite cannot.

**Architecture:** Two migrations: `0045` (drizzle-kit, from `schema.ts`) adds `public.applied`, `public.tool_calls`
and `task_events.uuid`; `0046` (custom SQL) adds the schemas `net` and `net_local`, the lease, state and maintenance
tables, `net.journal` with its deferred fence trigger, and the functions `net.assert_lease`, `net.attach_journal`,
`net.detach_journal` and `net.defer_foreign_keys`. `migrateDb` takes the journal off before the migrations and puts
it back after, with every foreign key deferrable. The app's pool and the agents' pools watch notices at commit
(`db/confirm.ts`); the database tool checks each text with `libpg-query` (`db/sql-check.ts`) and the agent role runs
fixed statements before its `COMMIT`. In the keeper, a pure function of two clocks (`modules/keeper/lease.ts`) picks
each second's step, and a lease store (`modules/keeper/lease-store.ts`) carries it out on one dedicated connection.

**Tech Stack:** TypeScript on Node 22; drizzle on node-postgres (pg 8.23) and drizzle-kit 0.31; PL/pgSQL on
Postgres 17.11; `libpg-query` 17.7.3 (libpg_query 17 in WASM); vitest with PGlite 0.5.13 (Postgres 18.6 in WASM);
Docker for `npm run test:real`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.4 (fences 1, 2 and 4, "The orchestrator's SQL", the
keeper's own writes, the late tick, "One data machine"), 3.7 ("Sequences", "The journal", schemas, "Foreign keys"),
3.9 (`applied` and `tool_calls`, schema only), 3.10 (the keeper answers `/api/network/lease`), section 9 ("The
maintenance state", as a lease kind) and section 12 (the parts of "Real Postgres 17.11 pairs" and "Orchestrator SQL"
that one machine has). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 3's entry. Plan 2
`notes/plans/2026-11-03-network-phase-1-plan-2-keeper-and-front.md` (see "Handed over by plan 2").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in a new worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/fences-and-journal` on a new branch `fences-and-journal` from
main (`git worktree add`, then `npm ci` there once), after plan 2 is merged into main and shipped.

**Handed over by plan 2** (merged and shipped before this plan starts):
- `db/client.ts`: `APP_NAME = 'hornhoof-app'`, `MIGRATE_NAME = 'hornhoof-migrate'`, `KEEPER_NAME = 'hornhoof-keeper'`;
  `openPool(url, onDropped, name, opts?: { statementTimeoutMs?: number })`, `openDb(url, name, opts?)`,
  `migrateDb(url): Promise<number>` (drizzle's migrator on a pool named `MIGRATE_NAME`, no timeouts, answers the count
  of `drizzle.__drizzle_migrations`); `main.ts` and `cli.ts` open `openDb(url, APP_NAME)`; `migrate.ts` runs
  `migrateDb` as its own entry point and in its own `migrate` container, before `app` starts.
- `modules/keeper/state.ts`: `Mode`, `KeeperState`, `KEEPER_FILE`, `readKeeperState`, `writeKeeperState`,
  `freshState`. `modules/keeper/app-mode.ts`: `AppMode` (`current`, `start`, `stop`, `check`, `whenLead`, options
  `staleMs` 10000 and `now`), `modeGate` with the `read_only` message `Hornhoof only reads on this machine now, so
  nothing was changed.`, `whileLeading`. `errors.ts`: reasons `maintenance`, `read_only`, `starting`.
- `modules/keeper/keeper.ts`: `Keeper` with `KeeperOptions` (`config`, `db`, `app`, `frontHost`, `log`, `host`,
  `ports`, `everyMs`, `clientFor`, `linkEveryMs`), `mode()`, `KEEPER_PORTS`; the front door on 7080, the link's `http`
  door on `127.0.0.1:7081` and the link's TLS server behind `LinkListener` on `127.0.0.1:8443`, each a
  `serve(passThrough(...))`; `keeper.json` written every `everyMs` and at once on a change. `updater-status.ts`:
  `updaterBusy(dir): boolean | null`. `keeper.ts` (the entry point) opens `openDb(url, KEEPER_NAME, {
  statementTimeoutMs: 2000 })`. `config.keeper` (`HORNHOOF_KEEPER=on`), `config.machineId` (`HORNHOOF_MACHINE_ID`).
- compose: `db` runs `postgres -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10 -c
  max_prepared_transactions=0`; the installer starts `front` and `keeper` before `migrate`, and `app` after it. The
  updater (revision 2) stops `app` before its copy and restores the copy with `DROP DATABASE ... WITH (FORCE)` when a
  failed build changed the migrations.
- Plan 1b: the migrations `0042_session_handover`, `0043_sign_in_attempts` and `0044_link_tls`, the last before this
  plan's, with `HIDDEN` gaining `sign_in_attempts` and `link_tls`; `npm run test:real` (`apps/server/test/real/run.sh`,
  `vitest.real.config.ts` with `include: ['test/real/**/*.test.ts']` and `fileParallelism: false`, CI job `test-real`).
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and passwords made at run time.
- One new dependency, in `apps/server` only: `libpg-query` at exactly `17.7.3` (`npm install libpg-query@17.7.3
  --save-exact -w apps/server`), which brings `@pgsql/types`. Nothing else.
- Two new migrations, never an edit of an older one: `0045_sources` by `npx drizzle-kit generate --name sources` and
  `0046_net` by `npx drizzle-kit generate --custom --name net`, both from `apps/server`. In `0046_net.sql` each
  statement is its own chunk, the chunks separated by `--> statement-breakpoint` as in the generated files.
- Fail closed, toward a company that only reads: a fence function that cannot decide refuses; the keeper leads only
  with a lease it renewed and no fence problem; a write that fails at a fence reaches people as `read_only` or
  `not_confirmed` (503), never as "Something went wrong."
- The fence is the app's own for superusers (ruling 1): the app's pools say `hornhoof.fenced = on` when it runs with a
  keeper, the agent roles are fenced whatever they say, and nothing else in `apps/server/src` opens a pool or client.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  the same with its test file; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; the real tests from the worktree root: `npm run test:real`, which needs Docker. Types, always
  from the worktree root: `npx tsc -p apps/server/tsconfig.json --noEmit` and, for the task that touches the web app,
  `npx tsc -p apps/web/tsconfig.json --noEmit`, both printing nothing. Never run prettier.


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

1. **The fence binds the app, the agents and nothing an older build runs.** `net.assert_lease` lets a session pass
   unchecked when its login role is a superuser and it does not say `hornhoof.fenced = on`; every other session gets
   the full check. The app opens its pools with that setting when it runs with a keeper, so all its writes are fenced;
   the agent roles are no superusers, so they are fenced whatever they set. A superuser could always drop a trigger,
   so the fence never held against one; what it guards is the app's own code, which the lint and the pool options pin.
   This keeps going back possible: a build from before this plan (plan 2's or today's) runs no lease, and under the
   spec's letter every commit it makes would fail, also when Ivan goes back by `install.sh`. With this rule it writes
   as before; only its orchestrator's `database` tool cannot change rows until the company updates again. It also
   lets `migrate`, the updater's restore and an owner's `psql` through, which replaces the spec's
   `hornhoof-migrate` exception (section 9). An app without a keeper (`npm run dev`) is not fenced and writes no
   lease. Every PGlite test database sets `hornhoof.fenced = on` when it opens and holds an endless lease, so the
   whole suite runs fenced.
2. **`migrateDb` takes the journal off before the migrations and puts it back after.** Each table's journal function
   names its columns, so a migration that drops a column and then writes that table would fail inside drizzle's one
   transaction, which nothing can join. So `migrateDb` runs `net.detach_journal()` (when it exists), the migrations,
   then `net.attach_journal()` and `net.defer_foreign_keys()`, also after a failed run. Spec 3.7 has the keeper attach
   the trigger after each migration; here `migrate` does, the keeper only checks, and a `migrate` killed in between
   leaves the company in `read` until the next `migrate` run. Foreign keys are made deferrable after every run, not
   once, so a later migration's new key is too.
3. **`libpg-query` instead of `pgsql-parser`.** pgsql-parser wraps libpg-query 17 and adds a deparser this check does
   not need. The parser is Postgres 17's, as the database is.
4. **More refused than the spec lists.** The parser takes only `SELECT` (without `INTO`), `INSERT`, `UPDATE` and
   `DELETE`, each with or without `WITH`; `MERGE` goes too. It refuses calls to `pg_cancel_backend`,
   `pg_terminate_backend`, `pg_reload_conf`, every `set_config` (not only on the spec's settings), `lo_*`, `loread`,
   `lowrite`, `query_to_xml`, `query_to_xmlschema`, `query_to_xml_and_xmlschema`, `ts_stat` and `ts_rewrite` (these run
   query text the parser never sees), and anything in `net` or `net_local`, also when a name is spelled as a field
   (`(pg_backend_pid()).pg_cancel_backend`, which Postgres resolves as a call). PUBLIC loses EXECUTE on the same
   functions of `pg_catalog`, so the rights stay the first guard. The check runs for the read role's texts too.
5. **"Not confirmed" is any notice during a commit.** Every connection that commits writes sets
   `client_min_messages = warning` (the app's pool by its options, the agent role right before its `COMMIT`), so the
   only notices that arrive are warnings, whatever language the server speaks. A notice during `COMMIT` or `END`, or
   during a statement that runs outside a transaction (other than `BEGIN`, `START`, `ROLLBACK` and `ABORT`), makes the
   call fail with `NotConfirmed`. A terminated session or an ended transaction (`57P01`, `25P04`, a lost connection,
   and the error drizzle's `ROLLBACK` on such a connection puts in its place) is not confirmed either. Both answer 503
   with reason `not_confirmed`. Every client the app, the agents and the keeper connect keeps an `error` listener for
   its whole life, since pg-pool takes its own off a client it lends out, and a session ended between two queries of a
   transaction would otherwise end the process.
6. **frpc stays up at lease end while the machine is alone.** Fence 4 stops the link's frpc so that another machine can
   take the name; with no other data machine, nobody can, and a stopped frpc may wait about 40 s for its route (plan
   2). Plan 5, which brings a second data machine, stops it.
7. **"alone" is the only sync flag this plan writes.** No table lists data machines yet; plan 5 adds them and must make
   the keeper stop writing "alone" once a second one is listed.
8. **A new term at every keeper start and after every fence.** A keeper that starts cannot know whether the lease it
   finds lapsed, so it ends it and the sessions, then takes the highest term number it sees plus one with its own
   machine id. After a late tick or a lapse it fences at once and takes the new term at the next tick, since the
   machine is alone. A late renewal never brings a lapsed lease back: the renewal updates only a lease that has not
   ended, in the database's own clock.
9. **A stale keeper word puts a leading app in `read`.** Plan 2 left this to plan 3: with no fresh word for 10 s, the
   lease is gone too, so the app shows `read` instead of failing writes. Other modes keep what they are.
10. **Left to their plans:** `net.merges` (plan 8), `net.backups` (plan 7), writing `net_local.maintenance` (plan 9,
    with copies to promise to; here it is schema only, and maintenance stays plan 2's, read from `status.json`, now
    written as the lease's kind), pruning the journal beyond ruling 19 (plan 8), the `invocation` argument of
    `net.assert_lease`, which this plan passes as `NULL` and plan 4 records, and every column `tool_calls` and `applied`
    need beyond their keys.
11. **One Postgres 17.11 container for the real tests**, the image compose runs, with compose's `db` settings. Pairs
    and `linux/arm64` come with plan 9, which makes copies (the overview's plan 9 entry has them; its rule line says
    "pairs from plan 3").
12. **Safer `search_path` than the spec writes.** The `SECURITY DEFINER` functions use `SET search_path = pg_catalog,
    net_local, pg_temp` and name every table with its schema, since a path without `pg_temp` searches temporary
    tables first.
13. **The journal row.** `xact` is the md5 of the cluster's system identifier and the transaction's id, as a uuid: one
    per transaction, unique across machines and restores (a transaction id never repeats in a cluster), and nothing a
    session sets can change it, which a setting such as `net.xact` could. An insert lists every column and no old
    values; an update lists the columns whose value changed and their old values, and an update that changes nothing
    still writes a row with no columns (plan 4's retries commit such a touch); a delete lists every column and the whole
    old row. A `bytea` value is kept as `sha256:<hex>`.
14. **The keeper checks the fences every 3 s,** with the link. On a fresh install the app applies the PUBLIC revokes
    at its start, so the keeper leads within 3 s of that.
15. **The lint forbids more than the spec lists:** `TRUNCATE`, `DISABLE TRIGGER` and `PREPARE TRANSACTION` too, since
    none writes a journal row or each escapes a fence, and a pool or client opened outside the three files that own
    them.
16. **The orchestrator's calls may take 5 s now,** not 15: `transaction_timeout = 5s` replaces the write role's
    `statement_timeout`. The read role keeps its 15 s.
17. **`transaction_timeout` stops at the commit.** Postgres 17 turns it off right before the commit record and the wait
    for a copy (`CommitTransaction`, `xact.c`), so nothing in this plan bounds a commit that waits on a copy while the
    keeper renews: the keeper's fence ends it when the lease ends, and from plan 9 the leader turning a silent copy's
    sync off does (spec 3.7). On one machine no commit waits. The real tests make a commit wait with
    `synchronous_standby_names` naming a copy that does not exist.
18. **The connection settings cannot be dropped by the address.** pg lets a connection string's `options` and
    `application_name` replace the ones given beside it, so the pools and the keeper's client take both out of the
    address first and set their own.
19. **The keeper prunes the journal while the machine is alone** (the team lead's ruling). Until plan 8 nothing else
    removes journal rows, every change writes one (`agent_events` alone takes thousands of inserts an hour on Ivan's
    company), and his Mac's disk has filled up before. While the lease's sync is `alone`, the keeper deletes
    `net.journal` rows older than 7 days, at most 10,000 per round, once a minute, and not during maintenance. Its
    session passes the fence trigger as a superuser that is not fenced (ruling 1). It rides ruling 7's condition: plan
    5 must stop it once a second data machine is listed (the statement itself deletes nothing when sync is not
    `alone`), and plan 8 replaces it with pruning that knows the merges. `0046_net` adds an index on `net.journal
    (at)` so that a round reads only what it deletes.
20. **No transaction of the app waits on anything but its own queries** (the team lead's ruling). The heaviest reads
    on Ivan's company (`/api/org`, the full task list, turns, the department tree, the improvements) answer in 0.6 to
    1.3 s end to end, about 0.5 s of it the relay's round trip, so the database's part is far below 5 s; the risk is a
    transaction that waits on a node message, git, fetch, the file system, a timer or ACME. Task 3 lists every
    `db.transaction(` whose callback awaits such a thing before its code, and each one moves out of the transaction,
    gets a test that keeps it under 1 s, or goes to the team lead. A transaction of the app that the limit ends logs
    one line naming the route and how long it ran, and one that ran over 2 s logs a warning of the same shape, so a
    read that grows with the company's history shows before the limit ends it; Task 6 checks that the first hour
    after Ivan's Update has neither.

## Review Focus

1. A Mac that sleeps, or a Docker VM whose clock lags or jumps: on waking the keeper fences, the app reads for about a
   second and leads under a new term, and nothing commits under the old lease after the fence, also when a renewal
   sent before the sleep arrives late. Tests in Task 4 (the table of `nextLeaseStep`, `fences a late tick and takes a
   new term at the next`, `a renewal that arrives after the fence changes nothing`) and Task 4's real tests.
2. An update between two builds of this shape, done or rolled back with the copy restored, a migration that drops a
   column and writes that table, and going back to plan 2's build and forward again: the maintenance lease refuses the
   app's commits while `migrate` runs, the journal is back afterwards, the company leads again when the updater
   records the end, and plan 2's build writes. Tests in Task 2 (`takes the journal off for the migrations and puts it
   back`, also after a failed one, `lets a superuser session that does not say it is fenced pass`) and Task 4
   (`writes a maintenance lease while the updater installs`), and Task 6's rehearsal.
3. Every write the app makes, under the fence: the whole PGlite suite runs fenced; a 50 MB file commits within the 5 s
   limit and its journal row holds a hash; a refused or unconfirmed commit answers `read_only` or `not_confirmed`.
   Tests in Tasks 2 and 3.
4. The keeper or its database gone while the app leads: commits answer `read_only`, the app reads after 10 s, and it
   leads again once the keeper is back, under a new term, with the sessions of the old one ended. Tests in Task 3
   (`answers read_only to a write when the lease has ended`), Task 4 (`goes to read when no fresh word came for 10 s`,
   `ends the app's and the agents' sessions, and no other`) and Task 6's rehearsal (the keeper paused).
5. Orchestrator SQL that tries to get past a fence: `COMMIT`, `SET`, `SET CONSTRAINTS ALL IMMEDIATE`, `DO`, `CALL`,
   `PREPARE TRANSACTION`, `set_config`, `lo_from_bytea`, `query_to_xml`, `ts_rewrite`, a function spelled as a field,
   each also after a first statement; a cancel
   of its own role's waiting commit; a text that sleeps past the lease. Each is refused, or its commit is refused or
   reported as not confirmed. Tests in Task 3.

---


# The task

### Task 2: The journal and fence 1

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/journal.test.ts test/migrations.test.ts
test/orchestrator-control.test.ts` passes, then the whole server suite (`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest
run`); from the worktree root `npm run test:real` passes and `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/src/db/net.ts`, `apps/server/drizzle/0045_sources.sql`, `apps/server/drizzle/0046_net.sql`
  (with their `meta/` snapshots and journal entries, as drizzle-kit writes them)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts` (`migrateDb`),
  `apps/server/src/db/agent-sql.ts` (`HIDDEN`), `apps/server/src/modules/tools/database.ts` (`CLOSED`, the
  descriptions' list of closed tables), `apps/server/test/global-setup.ts`, `apps/server/test/helpers.ts`
- Test: `apps/server/test/journal.test.ts` (new), `apps/server/test/migrations.test.ts`,
  `apps/server/test/orchestrator-control.test.ts` (the `CLOSED` text), `apps/server/test/real/journal.test.ts` (new)

**Interfaces:**
- Produces, in `schema.ts`:
  ```ts
  export const applied = pgTable('applied', { source: text('source').primaryKey(), at: timestamp('at', { withTimezone: true }).notNull().defaultNow() });
  export const toolCalls = pgTable('tool_calls', { id: uuid('id').primaryKey(), jobId: uuid('job_id').notNull().references(() => jobs.id), answer: jsonb('answer'), at: timestamp('at', { withTimezone: true }).notNull().defaultNow() });
  // taskEvents gains: uuid: uuid('uuid').notNull().defaultRandom().unique()
  // tasks gains, beside its other indexes: index('tasks_turn_id').on(t.turnId), index('tasks_product_id').on(t.productId)
  ```
  The two indexes are the team lead's: turns read tasks by `turn_id`, and removing a department changes tasks by
  `product_id`, and neither had one; they come here so that no other migration lands between plan 1b's and this plan's.
  `0045_sources` is what drizzle-kit generates for these; its `ADD COLUMN ... DEFAULT gen_random_uuid() NOT NULL` gives
  every older row its own uuid.
- Produces, in `0046_net.sql` (all objects owned by the role that migrates):
  - Schemas `net` and `net_local`.
  - `net_local.state (id boolean PRIMARY KEY DEFAULT true CHECK (id), term_number bigint NOT NULL, term_machine text
    NOT NULL, term_split boolean NOT NULL DEFAULT false, machine text NOT NULL, cluster text NOT NULL)`, `cluster`
    being `pg_control_system()`'s `system_identifier` as text.
  - `net_local.lease (id boolean PRIMARY KEY DEFAULT true CHECK (id), term_number bigint NOT NULL, term_machine text
    NOT NULL, term_split boolean NOT NULL DEFAULT false, kind text NOT NULL CHECK (kind IN ('normal', 'split',
    'maintenance')), until timestamptz NOT NULL, sync text CHECK (sync IN ('copy', 'relay_off', 'alone')))`.
  - `net_local.maintenance (id boolean PRIMARY KEY DEFAULT true CHECK (id), version text NOT NULL, since timestamptz
    NOT NULL, until timestamptz NOT NULL)`, written by nobody yet.
  - `net.journal (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), xact uuid NOT NULL, term_number bigint, term_machine
    text, term_split boolean, machine text, at timestamptz NOT NULL DEFAULT clock_timestamp(), tbl text NOT NULL, op
    text NOT NULL CHECK (op IN ('insert', 'update', 'delete')), key jsonb NOT NULL, cols text[] NOT NULL, old jsonb)`,
    and `CREATE INDEX journal_at ON net.journal (at)` (ruling 19).
  - `net.assert_lease(margin interval, invocation uuid) RETURNS void`, `SECURITY DEFINER`, `SET search_path =
    pg_catalog, net_local, pg_temp`. It returns at once when `session_user` is a superuser and
    `current_setting('hornhoof.fenced', true)` is not `'on'` (ruling 1). Otherwise it raises `SQLSTATE 'HHF01'` with
    the message `This machine holds no lease now, so nothing was changed.` unless all hold: `net_local.state` and
    `net_local.lease` each have their row; the lease's `(term_number, term_machine, term_split)` equals the state's;
    its kind is `normal` or `split`; `until > clock_timestamp() + margin`; `current_setting('synchronous_commit')` is
    `on`; a `normal` lease has a non-null `sync`. `invocation` is not read yet.
  - `net.fence_check() RETURNS trigger`, the same `SECURITY DEFINER` and path: `PERFORM net.assert_lease('0 s',
    NULL)`, then `RETURN NULL`. `CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.journal
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check()`.
  - `net.attach_journal() RETURNS integer`: for every table in `public` (`relkind` `r`), creates or replaces
    `net."journal_<table>"()` (`SECURITY DEFINER`, the same path; a table name over 55 characters, or a table with no
    primary key, raises) and the trigger `net_journal AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW` on the table,
    when missing. The function writes one `net.journal` row as ruling 13 says: `xact` is `md5(<cluster> || ':' ||
    pg_current_xact_id()::text)::uuid`, `<cluster>` from `net_local.state`, or from `pg_control_system()` when it has
    no row; the term and `machine` from `net_local.state` (null when it has no row); `tbl` the table's name; `key`
    the primary key's columns as a JSON object; `cols` and `old` as ruling 13 says, `bytea` columns as `'sha256:' ||
    encode(sha256(value), 'hex')`. It answers how many tables it attached and ends with `REVOKE ALL ON ALL FUNCTIONS
    IN SCHEMA net FROM PUBLIC`.
  - `net.detach_journal() RETURNS integer`: drops every `net."journal_%"` function with `CASCADE`, which drops its
    trigger; answers how many.
  - `net.defer_foreign_keys() RETURNS integer`: `ALTER TABLE ... ALTER CONSTRAINT ... DEFERRABLE INITIALLY IMMEDIATE`
    for every foreign key in `public` that is not deferrable; answers how many.
  - `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC`. No `ALTER DEFAULT PRIVILEGES`: a per-schema default cannot
    take away the global one that lets PUBLIC run new functions, so `attach_journal`'s own revoke, after every
    migration run, covers a function a later migration adds. Nothing on `public`'s tables yet: `migrateDb` attaches.
- Produces, in `db/net.ts`:
  ```ts
  export const LEASE_REFUSED = 'HHF01';
  export const FENCED = 'hornhoof.fenced';            // a superuser session that sets it to 'on' is fenced
  export const JOURNAL_TRIGGER = 'net_journal';
  export const FENCE_TRIGGER = 'net_fence';
  export type LeaseKind = 'normal' | 'split' | 'maintenance';
  export type LeaseSync = 'copy' | 'relay_off' | 'alone';
  export type Term = { number: number; machine: string; split: boolean };
  export const BEFORE_MIGRATIONS: string;   // a DO block: PERFORM net.detach_journal() when to_regprocedure('net.detach_journal()') is not null
  export const AFTER_MIGRATIONS: string;    // 'SELECT net.attach_journal(); SELECT net.defer_foreign_keys();'
  export function isLeaseRefused(err: unknown): boolean;   // code HHF01 on err or on one of its causes
  ```
- `migrateDb(url, folder = MIGRATIONS)`: on its one pool, `BEFORE_MIGRATIONS`, drizzle's migrate, then
  `AFTER_MIGRATIONS` in a `finally` when `to_regprocedure('net.attach_journal()')` is not null; a failure of the
  migrations is still what it throws.
- `HIDDEN` gains `'applied'` and `'tool_calls'`. `CLOSED` becomes `Sign-ins, invites, install codes, sealed plan
  sign-ins, the public link and Hornhoof's records of where changes came from are closed to this tool.`, and both
  descriptions name the same list.
- `global-setup.ts`, after drizzle's migrate: `AFTER_MIGRATIONS`; a `net_local.state` row of term 1 of `test`, split
  false, machine `test`, and its `cluster`; a `net_local.lease` row of that term, kind `normal`, until `infinity`, sync
  `alone`. Then the dump, as today.
- `helpers.ts`: `openTestDb` runs `SET hornhoof.fenced = 'on'` on each PGlite it opens, before anything else (PGlite
  0.5.13 applies no `ALTER DATABASE ... SET` or `ALTER ROLE ... SET` when it loads a dump; checked while planning).
  ```ts
  export async function setLease(db: Db, change: { until?: string; kind?: LeaseKind; sync?: LeaseSync | null; termNumber?: number }): Promise<void>;
  //   UPDATE net_local.lease with what is given; until as timestamptz text ('-infinity', an ISO time)
  ```

- [ ] **Step 1: Write failing tests.**
  - `journal.test.ts`, on `createTestDb()` and `testApp()` databases:
    - `writes one journal row per changed row, with its transaction's uuid`: two inserts in one `db.transaction` share
      one `xact`, a third in its own transaction has another; each row has `term_number` 1, `term_machine` and
      `machine` `test`, and `tbl`, `op` and `key` of its row; a transaction that first runs `SET LOCAL net.xact =
      '<a uuid>'` still gets `md5(<cluster> || ':' || <its pg_current_xact_id()>)`.
    - `keeps the changed columns and their old values`: an update of an agent's `name` gives `cols` `['name']` and
      `old` `{ name: 'Bruno' }`; an insert gives every column of the table and `old` null; a delete gives every column
      and the old row.
    - `keeps a hash of a file, not its bytes`: an `attachments` row deleted gives `old.bytes` matching
      `^sha256:[0-9a-f]{64}$`, the hash of its bytes.
    - `journals an update that changes nothing`: `UPDATE agents SET name = name WHERE id = <id>` gives one row with
      `cols` `[]`.
    - `journals what the orchestrator's role changes`: a write through `ctx.agentSql.run(..., 'write')` gives its row.
    - `refuses a commit once the lease has ended, at the commit and not before`: after `setLease(db, { until:
      '-infinity' })`, inside a transaction the insert succeeds and the `COMMIT` fails with code `HHF01`; the row is
      not there.
    - `refuses a maintenance lease, a normal lease without sync, a lease of another term and a commit without
      synchronous commit`: each of `{ kind: 'maintenance' }`, `{ sync: null }`, `{ termNumber: 2 }` and a transaction
      that runs `SET LOCAL synchronous_commit = local` fails at commit with `HHF01`; `{ kind: 'split', sync: null }`
      commits.
    - `lets a superuser session that does not say it is fenced pass`: with the lease ended, after `SET
      hornhoof.fenced = off` an insert commits and journals its row; after `SET hornhoof.fenced = on` again the next
      fails.
  - `migrations.test.ts`:
    - `migration 0045`, `gives each task event of an older install its own uuid`: migrated up to `0044_link_tls`
      with two task events, then fully: both have a uuid and they differ; and `indexes the tasks by turn and by
      product`: fully migrated, `pg_indexes` lists `tasks_turn_id` on `tasks (turn_id)` and `tasks_product_id` on
      `tasks (product_id)`.
    - `migration 0046`, `adds the fences, and the journal once migrated`: a fresh PGlite fully migrated has the
      schemas `net` and `net_local` and no `net_journal` trigger; after `AFTER_MIGRATIONS` every table in `public` has
      one, `net.journal` has `net_fence` (deferrable, initially deferred), every foreign key in `public` is deferrable
      and initially immediate, every table in `public` has a primary key, and `has_function_privilege('public', oid,
      'EXECUTE')` is false for every function in `net`, also for a function `net.later()` made before a second
      `AFTER_MIGRATIONS`; after `SELECT net.detach_journal()` no `net_journal` trigger is left.
  - `orchestrator-control.test.ts`, in `is refused sign-ins, invites, install codes, the public link, passwords and the
    tables themselves`: the `CLOSED` check takes the new text, and `SELECT * FROM applied` and `SELECT * FROM
    tool_calls` join the statements it refuses.
  - `real/journal.test.ts`, each on its own `realDatabase()` migrated with `migrateDb`, and `state` and `lease` rows
    written by the admin as `global-setup.ts` writes them:
    - `fences the app's commits and lets older builds through`: on a test `pg.Client` with `application_name`
      `hornhoof-app` and `options: '-c hornhoof.fenced=on'` (Task 3 gives `openDb` that option), an insert commits
      under the lease and fails with `HHF01` once the admin ended it; on a plain superuser client the same insert
      commits and journals its row.
    - `fences the agent role whatever it sets`: with the lease ended, a write call of `openAgentSql(url)` that runs
      `SET hornhoof.fenced = off` and an insert into `notebook_notes` fails with `HHF01` at its commit.
    - `takes the journal off for the migrations and puts it back`: a copy of `MIGRATIONS` with one more migration
      that drops `notebook_notes.by_orchestrator` and updates that table, run by `migrateDb(url, copy)`, succeeds,
      and afterwards `net."journal_notebook_notes"` no longer names the column and every table has its trigger; a copy
      whose extra migration fails (`SELECT 1/0`) makes `migrateDb` throw, and every table still has its trigger.
    - `commits a 50 MB file within the app's limit, and journals its hash`: a table `public.big (id int PRIMARY KEY,
      b bytea)` made by the admin and `SELECT net.attach_journal()`; an insert of 50 MB of random bytes and its delete
      each commit on a test client with `-c transaction_timeout=5s -c hornhoof.fenced=on`; the delete's journal row
      has `old.b` `sha256:<hex of those bytes>`.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no tables, no `net`, no `setLease`).
- [ ] **Step 3: Implement** the interfaces above: `schema.ts`, then `npx drizzle-kit generate --name sources`, then
  `npx drizzle-kit generate --custom --name net` and the SQL, then `net.ts`, `migrateDb`, the fixture and helpers.
  The extra migrations live in the test's temporary copy only.
- [ ] **Step 4: Run Done when.** Expected: PASS. A test elsewhere in the suite that now fails at a commit shows a write
  path the fixture or a lease does not cover: report it rather than loosen the fence.
- [ ] **Step 5: Commit** "Journal every change and commit it only under a lease the keeper holds".

