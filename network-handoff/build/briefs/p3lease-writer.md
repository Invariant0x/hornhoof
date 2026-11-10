You are the writer for Task 4 of 2026-11-03-network-phase-1-plan-3-fences-and-journal in Hornhoof's network build. Read everything below before you start.

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

# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p3lease`, Hornhoof repo, branch `task-p3lease`. Kind: known behaviour, test-first as the plan says. A mutator target at the end of phase 1, so the table of its cases matters.
- This is a split of Plan 3 Task 4. You write ONLY the pure file: `apps/server/src/modules/keeper/lease.ts` and `apps/server/test/lease.test.ts`: `LEASE_MS`, `LATE_MS`, `BACK_MS`, `Clocks`, `Held`, `LeaseStep`, `leaseValid`, `nextLeaseStep`, exactly as the task's Interfaces say. `lease-store.ts`, `fake-lease.ts`, `keeper.ts`, `s/keeper.ts`, `app-mode.ts`, `helpers.ts` and their tests stay for that task's own writer, so nothing calls this yet. That is fine.
- Your lane stands on batch 6 and Plan 3 Tasks 1 and 2, which are below your `lanebase` (tag). `Term` and `LeaseKind` come from `apps/server/src/db/net.ts`, already there. Import them with a type import.
- No clock in the tests: `Clocks` are plain numbers. Test both clocks apart, each boundary on both sides of it: exactly `LEASE_MS`, exactly `LATE_MS`, exactly `BACK_MS`, the wall going back, the monotonic clock jumping while the wall does not. Read the order of `nextLeaseStep` in the Interfaces and show that the order matters where it does.
- The later writer of Plan 10 Task 3 extends this file, so keep the names as the plan gives them.
- Your author check names `lease.test.ts`; the rest of the task's "Done when" belongs to the later writer.

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

### Task 4: The keeper's lease and fence 4

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/lease.test.ts test/lease-store.test.ts
test/keeper.test.ts test/keeper-link.test.ts test/app-mode.test.ts` passes, then the whole server suite; from the
worktree root `npm run test:real` passes and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/lease.ts`, `apps/server/src/modules/keeper/lease-store.ts`,
  `apps/server/test/fake-lease.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/keeper.ts`,
  `apps/server/src/modules/keeper/app-mode.ts`, `apps/server/test/helpers.ts` (`createTestSql`)
- Test: `apps/server/test/lease.test.ts`, `apps/server/test/lease-store.test.ts` (new),
  `apps/server/test/keeper.test.ts` and `apps/server/test/keeper-link.test.ts` (their keepers get `lease:
  fakeLease()`), `apps/server/test/app-mode.test.ts`, `apps/server/test/real/lease-store.test.ts` (new)

**Interfaces:**
- Consumes: `Term`, `LeaseKind`, `JOURNAL_TRIGGER`, `FENCE_TRIGGER` (Task 2); `REFUSED_FUNCTIONS`, `stripSettings`,
  `keepErrors`, `notConfirmed`, `HIDDEN`, `agentRole`, `readerRole` (Task 3 and today); `APP_NAME`, `KEEPER_NAME` (plan
  2).
- Produces:
  ```ts
  // modules/keeper/lease.ts
  export const LEASE_MS = 10_000;
  export const LATE_MS = 6_000;    // a gap over this between two ticks, on either clock, is a tick more than 5 s late
  export const BACK_MS = 1_000;    // the wall clock going back more than this
  export type Clocks = { wall: number; mono: number };    // Date.now() and performance.now()
  export type Held = { term: Term; kind: LeaseKind; sent: Clocks };   // the last renewal that committed, by when it was sent
  export type LeaseStep = { do: 'take'; kind: LeaseKind } | { do: 'fence'; why: string } | { do: 'renew'; kind: LeaseKind; endSessions: boolean };
  export function leaseValid(held: Held | null, now: Clocks): boolean;
  //   held, and now is less than LEASE_MS after held.sent on both clocks
  export function nextLeaseStep(o: { now: Clocks; last: Clocks | null; held: Held | null; maintenance: boolean }): LeaseStep;
  //   in order: held null: take (kind maintenance or normal); a late tick (now.mono - last.mono or now.wall -
  //   last.wall over LATE_MS, or last.wall - now.wall over BACK_MS): fence; !leaseValid: fence; else renew with
  //   endSessions true only when maintenance begins (held.kind is not maintenance)
  // modules/keeper/lease-store.ts
  export type Sql = { query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }> };
  export type LeaseStore = {
    take(kind: LeaseKind, until: Date): Promise<Term>;
    //   fence(), then one statement: state to (the highest of state's and lease's number, else 0) + 1 with this
    //   machine, split false, and the lease of that term with kind, until and sync 'alone'
    renew(term: Term, kind: LeaseKind, until: Date, endSessions: boolean): Promise<boolean>;
    //   UPDATE ... WHERE the term is that term AND until > clock_timestamp(): false when no row changed; endSessions
    //   then ends the sessions after the update committed
    fence(): Promise<void>;          // until '-infinity', then endSessions()
    endSessions(): Promise<number>;  // pg_terminate_backend of every other session of this database whose
                                     //   application_name is APP_NAME or whose user is its agentRole or readerRole
    problems(): Promise<string[]>;   // [] when every fence holds
    prune(batch?: number): Promise<number>;
    //   one statement (ruling 19): DELETE FROM net.journal WHERE id IN (SELECT id FROM net.journal WHERE at < now() -
    //   interval '7 days' ORDER BY at LIMIT batch) AND (SELECT sync FROM net_local.lease) = 'alone'; answers the rows
    //   it deleted; batch PRUNE_BATCH when not given
    close(): Promise<void>;
  };
  export const PRUNE_BATCH = 10_000;
  export function leaseStore(sql: Sql, opts: { machineId: string }): LeaseStore;
  export function keeperSql(url: string, opts?: { timeoutMs?: number }): Sql & { close(): Promise<void> };
  //   one pg.Client at a time on stripSettings(url), application_name KEEPER_NAME, options '-c
  //   synchronous_commit=local', keepErrors on it, no statement_timeout, connectionTimeoutMillis and query_timeout
  //   timeoutMs (2000); queries run one after another, each waiting for the one before to settle; a connect or query
  //   that fails or times out drops that client without waiting for its end, and the next query opens a new one
  // KeeperOptions gains: lease: LeaseStore | null; now?: () => Clocks; pruneEveryMs?: number (60000)
  // Keeper gains: term(): Term | null   (held's term while leaseValid, else null)
  // test/helpers.ts: export async function createTestSql(): Promise<{ db: Db; sql: Sql }>   (one PGlite from openTestDb, both views)
  // test/fake-lease.ts: export function fakeLease(opts?: { problems?: string[]; take?: (kind: LeaseKind) => Promise<Term>; prune?: () => Promise<number> }): LeaseStore & { calls: { method: string; args: unknown[] }[] }
  ```
- `problems()`, each a line, in this order: `public.<table> has no journal trigger` for a table of `public` without a
  `net_journal` trigger whose `tgenabled` is `O`; `net.<table> has no fence trigger` for a table of `net` without
  `net_fence` as a deferrable, initially deferred constraint trigger whose `tgenabled` is `O` (what `attach_journal` and
  the migration leave; `D`, `R` and `A` are changes Hornhoof never makes, and `R` or `D` stop the fence); `PUBLIC may
  still run <name>` for a function of `REFUSED_FUNCTIONS` in `pg_catalog`, or any in `net`, that PUBLIC may execute; for
  each agent role that exists: `<role> is a superuser`, `<role> may signal other sessions` (a member of
  `pg_signal_backend`), `<role> may reach <schema.table>` (any right on a table of `net` or `net_local`, or on
  `public.applied` or `public.tool_calls`), `<role> may run <function>` (a function of `net` but `assert_lease`);
  `max_prepared_transactions is <n>, not 0`.
- The keeper, added to plan 2's, every `everyMs`: `maintenance` is `updaterBusy(controlDir)`, or what it was when that
  is null; `nextLeaseStep`; then the step on `opts.lease`, with `until` at `sent.wall + LEASE_MS`, `sent` taken right
  before the call. A take that resolves sets `held`; a renew that answers true replaces `held` with its term, the kind
  it renewed and its `sent`; a fence clears `held`; a call that throws or answers false leaves `held`, so the lease
  lapses by itself. Every `linkEveryMs` `problems()`; a throw keeps the last answer. Every `pruneEveryMs` on the
  monotonic clock, the first one `pruneEveryMs` after the start, `prune()` unless `maintenance`. `mode()`: `maintenance`
  while `maintenance`; `lead` when `leaseValid(held, now())`, `held.kind` is `normal` and the last `problems()` answered
  `[]`; otherwise `read`. With `lease: null` it never leads. Log lines, each once per change: `This machine leads under
  term <number>.`; `The lease ended (<why>): the sessions of the app and the agents were ended, and Hornhoof only reads
  here until it takes a new term.` (`<why>`: `a tick came <s> s after the one before`, the larger gap of the two clocks,
  `the clock went back <s> s` or `no renewal for 10 s`; `<s>` in seconds rounded to a tenth, as JavaScript prints it);
  `Could not take a lease: <message>.`; `Could not prune the journal: <message>.` (a prune that works logs nothing);
  `Hornhoof does not lead here until this is fixed: <problems joined by '; '>.`.
- `keeper.ts`: `lease` is `leaseStore(keeperSql(databaseUrl), { machineId })` when both are set; else `null`, with
  once `The keeper takes no lease: HORNHOOF_MACHINE_ID is not set. Run the install command again.` or `The keeper
  takes no lease: DATABASE_URL is not set.`. `stop()` closes it.
- `AppMode.check()`: when no fresh word comes, the mode is `lead`, and the last fresh word is more than `staleMs` old,
  the mode becomes `read`, with its log line. Nothing else of plan 2 changes.

- [ ] **Step 1: Write failing tests.**
  - `lease.test.ts`, `picks each tick's step from the two clocks`, one table, `t0 = { wall: 1e12, mono: 5e3 }`, `held`
    normal sent at `t0` unless a row says otherwise, `last` one second before `now`:

    | held | last | now (from t0) | maintenance | step |
    |---|---|---|---|---|
    | none | none | +0 | no | take normal |
    | none | none | +0 | yes | take maintenance |
    | normal | +0 | wall +1 s, mono +1 s | no | renew normal, endSessions false |
    | normal | +1 s | wall +8 s, mono +8 s | no | fence, `a tick came 7 s after the one before` |
    | normal | +1 s | wall +8 s, mono +2 s | no | fence (late on the wall clock) |
    | normal | +1 s | wall -1.5 s, mono +2 s | no | fence, `the clock went back 2.5 s` |
    | normal | +1 s | wall +0.5 s, mono +2 s | no | renew normal |
    | normal | +9 s | wall +10 s, mono +10 s | no | fence, `no renewal for 10 s` |
    | normal | +9.5 s | wall +10.2 s, mono +9.8 s | no | fence (lapsed on the wall clock) |
    | normal | +0 | +1 s | yes | renew maintenance, endSessions true |
    | maintenance | +0 | +1 s | yes | renew maintenance, endSessions false |
    | maintenance | +0 | +1 s | no | renew normal, endSessions false |
    | none | +1 s | +9 s | no | take normal |

    and `leaseValid` false for `null`, for `now` 10 s after `sent` on either clock alone, true 9.9 s after on both.
  - `lease-store.test.ts`, on `createTestSql()` (the fixture's endless lease, term 1 of `test`):
    - `takes the next term and a lease of it`: `take('normal', until)` answers `{ number: 2, machine: <id>, split:
      false }`; state and lease say term 2 of that machine, kind normal, sync `alone`, that `until`.
    - `renews only the lease of its term that has not ended`: with `t` from `take('normal', until)`, `renew(t, ...)`
      answers true and moves `until`; `renew` of the fixture's term 1 answers false; after `fence()`, `renew(t, ...)`
      answers false and `until` stays `-infinity`.
    - `a renewal that arrives after the fence changes nothing`: with `t` from `take`, then `fence()`, `renew(t, ...)`
      with its `until` an hour ahead answers false and `until` stays `-infinity`.
    - `prunes journal rows older than 7 days while alone`: with 5 `net.journal` rows written with `at` 8 days ago and
      3 written now (one `INSERT ... SELECT ... FROM generate_series` each), `prune(3)` answers 3 and leaves 2 old rows
      and the 3 new; `prune()` answers 2 and leaves the 3 new; `prune()` then answers 0.
    - `prunes nothing unless the lease says alone`: the same old rows written first, then `UPDATE net_local.lease SET
      sync = 'copy'`: `prune()` answers 0 and every row stays; the same with the lease row deleted.
    - `gives up on a database that never answers`: against a `node:net` server that accepts and never writes,
      `keeperSql('postgres://u:p@127.0.0.1:<port>/d', { timeoutMs: 300 })`'s `query('SELECT 1')` rejects within 1 s;
      the next query opens a second socket; two queries sent together never hold two sockets open at once.
    - `names what keeps it from leading`: on the fixture, `problems()` has `PUBLIC may still run pg_cancel_backend`;
      after `PUBLIC_REVOKES`, `grantsFor('postgres_agent')` and `readerGrantsFor('postgres_reader')`, each one
      `sql.query`, it is `[]`; then, one at a time and undone after: `DROP TRIGGER net_journal ON notebook_notes` gives
      `public.notebook_notes has no journal trigger`; `GRANT EXECUTE ON FUNCTION pg_cancel_backend(integer) TO PUBLIC`
      gives `PUBLIC may still run pg_cancel_backend`; `GRANT SELECT ON net.journal TO postgres_agent` gives
      `postgres_agent may reach net.journal`; `GRANT EXECUTE ON FUNCTION net.attach_journal() TO postgres_agent` gives
      `postgres_agent may run attach_journal`; `DROP TRIGGER net_fence ON net.journal` gives `net.journal has no fence
      trigger`; `ALTER TABLE notebook_notes DISABLE TRIGGER net_journal`, `... ENABLE REPLICA TRIGGER net_journal` and
      `... ENABLE ALWAYS TRIGGER net_journal` each give `public.notebook_notes has no journal trigger`; `ALTER TABLE
      net.journal DISABLE TRIGGER net_fence` and `... ENABLE REPLICA TRIGGER net_fence` each give `net.journal has no
      fence trigger`.
  - `keeper.test.ts`, keepers with an injected `now` the test moves and `everyMs` 50:
    - `leads once it holds a lease, and reads without one`: with `fakeLease()`, `keeper.json` says `lead` and
      `term()` is the taken term; with a store whose `take` throws, `read`, and the log has `Could not take a lease:`
      once over 10 ticks; with `lease: null`, `read`.
    - `renews each second until ten seconds after it sent`: the calls have `renew` with `until` `sent.wall + 10000`.
    - `fences a late tick and takes a new term at the next`: after `now` moves 8 s at once, the next tick calls `fence`,
      `keeper.json` says `read` and the log has `The lease ended (a tick came 8 s after the one before)`; the tick after
      calls `take` and the mode is `lead` again.
    - `reads when renewals fail for ten seconds`: a store whose `renew` answers false: `lead` until 10 s after the
      last good send, then `fence` and `read`.
    - `writes a maintenance lease while the updater installs`: `status.json` `running`/`install` gives `renew` with
      kind `maintenance` and `endSessions` true once, and `keeper.json` `maintenance`; `done` gives kind `normal` and
      `lead`.
    - `leads after maintenance that was running when it started`: with `status.json` `running`/`install` before the
      first tick, the keeper calls `take` with kind `maintenance`, then renews with kind `maintenance` and
      `endSessions` false, and `keeper.json` says `maintenance`; after `done`, renewals have kind `normal` and the
      mode is `lead`; no renewal had `endSessions` true.
    - `prunes the journal once a minute, not in maintenance`: with `pruneEveryMs` 3000 and `now` moved 1 s a tick,
      `fakeLease()` gets `prune` once `now` has moved 3 s from the start and again at 6 s, and not before; none while
      `status.json` says `running`; a `prune` that throws three times logs `Could not prune the journal:` once.
    - `does not lead while the database lacks a fence`: `fakeLease({ problems: ['public.tasks has no journal trigger']
      })` gives `read` and the log `Hornhoof does not lead here until this is fixed: public.tasks has no journal
      trigger.` once; the problems cleared, `lead` within one `linkEveryMs`.
    - plan 2's cases keep passing with `lease: fakeLease()`.
  - `app-mode.test.ts`, `goes to read when no fresh word came for 10 s while leading`: in `lead`, with the file left
    as it was and `now` moved 10.5 s, `check()` gives `read`; a fresh `lead` word gives `lead`; in `maintenance` the
    same wait keeps `maintenance`.
  - `real/lease-store.test.ts`, on a `realDatabase()` migrated, with `openAgentSql(url)` started:
    - `ends the app's and the agents' sessions, and no other`: an idle client of an `APP_NAME` pool, an agent role
      session (a write call that runs `SELECT pg_sleep(3)`), a `KEEPER_NAME` client and a `MIGRATE_NAME` client;
      `endSessions()` answers 2; `pg_stat_activity` keeps the keeper's and migrate's; the sleeping call fails with
      `notConfirmed(err)` true; the app pool's next query works on a new connection.
    - `ends a commit that waits when the lease ends`: with `synchronous_standby_names = 'FIRST 1 (nobody)'`, an insert
      on the fenced app pool waits, `fence()` makes it reject with `notConfirmed(err)` true, and the lease's `until`
      is `-infinity`.
    - `renews without waiting for a copy`: with the same setting, `renew` of the term `take` answered is true within
      1 s.
    - `opens a new connection after its own is ended`: the admin ends the idle `keeperSql` session; no uncaught error
      reaches vitest, the first query after fails, the next succeeds.
    - `a renewal that arrives after the fence changes nothing`, as on PGlite.
    - `prunes as the keeper after the lease ended`: old `net.journal` rows written by the admin, then `fence()`:
      `prune()` on `keeperSql(url)` deletes them, since the keeper's session passes the fence trigger as a superuser
      that is not fenced.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no lease module, the keeper leads without a lease).
- [ ] **Step 3: Implement** the interfaces above. `take` is one `WITH ... INSERT ... ON CONFLICT` statement, so a
  term and its lease commit together.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Renew the lease from the keeper each second, and end it with the sessions on a late tick".

