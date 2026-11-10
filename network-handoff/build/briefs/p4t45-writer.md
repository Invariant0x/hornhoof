You are the writer for Task 4 of 2026-11-03-network-phase-1-plan-4-work-survives-restart in Hornhoof's network build. Read everything below before you start.

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

- Your lane: `/home/altera/hornhoof-network/wt/p4t45`, repo hornhoof, branch `task-p4t45`. Kind: known behaviour, test-first as the plan says. It starts from `batch-2`, a staging branch with 1b T2, 2 T1, T2, T8, T9 and T10 on top of the main line, in its last check.
- Read your rows in `/home/altera/hornhoof-network/network-build/parallel-map.md`: sections 1, 2, 3 (the seams checked at landing), 4 (drift) and 5 (rulings, all taken). Build ruling 5: migration numbers are the plan's plus 11. Plans were read at an older main; check each file and line named against the code before you rely on it.
- This lane is Task 4's protocol part, then Task 5, one writer, split by ruling 6 of the map, two commits. The server part of Task 4 comes later and is not yours. No server of plan 4 is needed: `main.test.ts`'s fake server plays it. Ruling 5 of the map, taken: `job.program`, `agent.hook_rejected` and `agent.unheard` join `NUMBERED`; `agent.restarted` (a live answer, as `agent.said`) and `node.stopping` stay out; Task 5 routes `n/terminal/host.ts`'s sends through the outbox it adds; `agent.unheard` commits more than once, so its handler gets numbered steps or goes in one transaction. A change in `packages/protocol` makes the author check run server, node and web whole, once, on your final commit.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 4: Work That Survives a Restart, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every change the app makes for a node message, a page's request or an agent's tool call records where it
came from in `public.applied`, in the same transaction, and a retry of a source already listed is answered, never
applied again. Nodes number the messages that change the company's data, keep them in their volume until the server
confirms them, send the rest again after hello, and come back within 10 s. `front` stamps each MCP tool call with an
invocation id and sends it again across a restart of the app; `tool_calls` keeps each call's answer, and the tools that
act outside the database commit a "started" row first. The page sends a request id with each change and keeps it
when it tries again. The built-in node signs in with a key of its own machine and goes through `front`, and `front`
and the keeper hold requests while the next hop restarts.

**Architecture:** One migration from `schema.ts` (`0047`, `applied.base` and the indexes pruning needs) and one of
SQL (`0048`, a four-argument `net.assert_lease` that records a database tool call). `db/sources.ts` holds the source
of the work running now in an `AsyncLocalStorage` and wraps the app's drizzle `db`: each transaction that wrote, and
each write outside a transaction (run in a transaction of its own), inserts its step of the source into `applied`
before its commit. Three places open a source: a change request with an `Idempotency-Key`
(`modules/sources/requests.ts`), a numbered node message (`modules/nodes/messages.ts`), and a tool call with an
invocation id (`modules/tools/calls.ts`). The protocol (`packages/protocol`) gains message numbers, a stream id and
`ack`, all optional, so builds one apart still talk. The node keeps an append-only outbox file in its volume. The
pass-through (`net/proxy.ts`) learns to hold, and `front` gains a path for `/mcp` that buffers, stamps and resends a
call. The keeper's lease store prunes `applied` and `tool_calls` beside the journal.

**Tech Stack:** TypeScript on Node 22 (`node:async_hooks`, `node:crypto`, `node:http`); Fastify 5; drizzle-orm 0.45.4
on node-postgres and PGlite; `@modelcontextprotocol/sdk` 1.32 (stateless Streamable HTTP with JSON answers); `ws`; zod
in `packages/protocol`; the React web app; vitest with PGlite; Docker for `npm run test:real`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.9 ("Where a change came from", "Node messages survive",
"Tool calls", "Built-in node", and the holding sentence of "Finding the leader"), 3.4 "The orchestrator's SQL" (the
lease check records the call), section 9 step 11 (node messages readable across one version) and section 12 ("Node
and front"). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 4's entry and its discrepancies 5 to
7. Plans 2 and 3 (see "Handed over by plans 2 and 3").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in a new worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/work-survives` on a new branch `work-survives` from main
(`git worktree add`, then `npm ci` there once), after plan 3 is merged into main and shipped.

**Handed over by plans 2 and 3** (merged and shipped before this plan starts):
- Plan 3, `db/schema.ts`: `applied` (`source` text primary key, `at`) and `toolCalls` (`tool_calls`: `id` uuid primary
  key, `jobId` not null referencing `jobs`, `answer` jsonb, `at`), both in `HIDDEN` and both empty; migrations up to
  `0046_net`. `net.assert_lease(margin interval, invocation uuid)` (it does not read `invocation`), granted to the
  write role; `db/net.ts` (`LEASE_REFUSED`, `isLeaseRefused`, `AFTER_MIGRATIONS`); `migrateDb`.
- Plan 3, `db/confirm.ts`: `NotConfirmed`, `confirmCommits`, `keepErrors`, `notConfirmed`, `requestRoute`,
  `logTimeouts`; `db/client.ts`: `stripSettings`, `openPool`, `openDb(url, name, opts?)` with `fenced`;
  `db/agent-sql.ts`: `PRE_COMMIT`, `PUBLIC_REVOKES`, `REFUSED_FUNCTIONS`, `SqlAnswer`, `openAgentSql` whose `run(text,
  mode)` sends `PRE_COMMIT` before `COMMIT` in mode `write`; `db/sql-check.ts`; `errors.ts` reasons `read_only` and
  `not_confirmed`; `modules/keeper/app-mode.ts` `READ_ONLY_MESSAGE`.
- Plan 3, the keeper: `modules/keeper/lease-store.ts` with `LeaseStore.prune(batch?)` (journal rows older than 7 days
  while the lease's sync is `alone`, `PRUNE_BATCH` 10,000, once a minute), `keeperSql`, `leaseStore`.
- Plan 3, tests: `openTestDb` and `createTestDb` give a fenced PGlite with an endless lease; `setLease(db, change)`;
  `agentSqlOn`; `test/real/pg.ts` with `realDatabase`; `npm run test:real`.
- Plan 2: `net/proxy.ts` (`passThrough`, `PassOptions` with `target`, `headers`, `unreachable`, `connectMs`; `serve`,
  `socketAddress`, `firstForwarded`, `startingAnswer` 502 with `Retry-After: 5`), `net/front.ts` `startFront({ port,
  host?, keeper })`; the keeper (`KeeperOptions`, its front door on 7080 trusting `x-forwarded-for` only from
  `front`'s address, every door dropping incoming `x-hornhoof-*` headers and passing a 101 answer as it came, and
  `unreachable` answering maintenance in `maintenance`); `AppMode`, `modeGate` (in `off` a change gets 503 with
  reason `starting`), `whileLeading` (the `NodeHub`'s `onMessage` and `onClose` run only while leading); nodes refused
  outside `lead`; `config.machineId` from `HORNHOOF_MACHINE_ID` (32 or 64 lowercase hex) and `.env` carrying it; the
  built-in node at `http://app:8080`.
- Plan 1b: `handOverSession` runs in an `onRequest` hook.
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys made at run time.
- No new dependency.
- Two new migrations, never an edit of an older one: `0047_steps` by `npx drizzle-kit generate --name steps` and
  `0048_calls` by `npx drizzle-kit generate --custom --name calls`, both from `apps/server`; in `0048_calls.sql` each
  statement is its own chunk, separated by `--> statement-breakpoint`.
- Messages stay readable across one version (spec section 9): a node of plan 3's build works with this server as it
  did, and a node of this build works with plan 3's server as it did. Every field this plan adds to a message is
  optional, and every message it adds is one an older side drops (`parseNodeMessage` and `parseServerMessage` answer
  `null` for an unknown type, and zod drops unknown keys).
- Fail toward a change applied once: a source `applied` lists is never applied again but where ruling 5 says; when
  its answer is lost, the caller is told so (`already_done`, `ALREADY_RAN`, `PENDING`), never given a second run.
- Plan 3's rules hold: nothing in `apps/server/src` opens a pool or client outside the three files that own them, and
  the fence lint passes.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/node`,
  `apps/web` and `packages/protocol` the same with their test file. After a change to `packages/protocol`, run `npm run
  build -w @hornhoof/protocol` from the worktree root before the server's or the node's tests. The whole suite from
  the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; the real tests: `npm run
  test:real`, which needs Docker. Types, from the worktree root, for each part a task touched: `npx tsc -p
  apps/server/tsconfig.json --noEmit`, `npx tsc -p apps/node/tsconfig.json --noEmit`, `npx tsc -p
  apps/web/tsconfig.json --noEmit`, `npx tsc -p packages/protocol/tsconfig.json --noEmit`, each printing nothing.
  Never run prettier.


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

1. **The database layer records sources, not each handler.** The spec puts the source in the same transaction as the
   change. The node handlers alone make their writes in many separate statements (hello, status, `job.done`,
   `tests.done`, `turn.open`), the routes and tools in many more, and their follow-ups (`afterJob`, `pump`, wakes) in
   transactions of their own. So `recordSources` wraps the app's drizzle `db` once: inside an open source, a
   transaction that wrote inserts its step into `applied` before its commit, and a write outside a transaction runs
   in a transaction of its own that does the same. Each transaction takes the next step number as it records, so two
   at once never share one; a step whose commit failed leaves a gap, and a source is listed when any of its steps
   committed (`applied.base`). Whether a transaction wrote is `pg_current_xact_id_if_assigned() IS NOT NULL`: every
   change to a row takes a transaction id, so every change is recorded; a few things that change no row of `public`
   may take one too (`SELECT ... FOR UPDATE`, `nextval`, a temporary table, an `INSERT ... ON CONFLICT DO NOTHING`
   that met its conflict late), and then list a source that changed nothing, which only makes its retry hear that it
   was done. The wrap reaches into drizzle 0.45.4's session (`db.session.prepareQuery`), the one place that does, and
   its tests fail if drizzle changes it. A source closes when its work settles (a request's, when its answer is
   sent), so a timer it left behind records nothing. `applied` is a table of `public`, so each step, touch and prune
   is journaled like any change.
2. **A tool call's retry gets the first answer back; a page's retry hears that it was done.** `tool_calls` keeps a
   call's MCP answer for its job. The spec keeps it in the change's own transaction, but a handler commits its
   changes before its answer exists, so the answer is kept right after the work, in a commit of its own, except the
   database tool's, which `net.assert_lease` keeps in the change's own commit. When the answer was lost in between,
   the retry hears `ALREADY_RAN`. An answer made of a passing error (a commit not confirmed, a lease refused) is kept
   only on a "started" row, as `MAY_HAVE_RUN`; any other call keeps none, so its retry runs or hears `ALREADY_RAN`. The
   page keeps no answer: a page's answer can carry a session cookie, an invite link or an install command, and is
   shaped by who asks, so a listed page change answers 409 `already_done`, and the person reloads to see it. A node
   message needs no answer, since its answer is the `ack`.
3. **The page's request id travels as `Idempotency-Key`.** `front` and the keeper drop every `x-hornhoof-*` header
   that comes in (plan 2), and this name is the one HTTP drafts use. The page tries a change again with the same key,
   for up to 60 s after its first failure, after a network error, a 2xx whose JSON breaks off, or a 502 or 503 whose
   reason is `starting` (`front`, the keeper, or the app before it leads) or `not_confirmed` (the key makes that retry
   safe) or that carries no error JSON; never after `maintenance`, `read_only` or any other answer. A route that acts
   outside the database before it writes a row (`POST /api/agents/:id/stop` sends `job.cancel`, `POST /api/updates`
   writes the updater's request, and the others Task 2 finds) commits its first step before it acts, so its retry
   hears `already_done` too. 1b's session handover runs in `onRequest`, before the source opens: it is a change of its
   own, applied once by its own guard, and no step of the request.
4. **Node messages carry `n`, numbered within a `stream` of their node.** `job.event` already has a `seq` of its own,
   per job. A node numbers the messages that change the company's data (`job.started`, `job.event`, `job.done`,
   `tests.started`, `tests.done`, `cred.sealed`, `login.done`, `agent.context`, `removed`) from 1 within a stream, a
   uuid made with its outbox file, so a node whose volume was wiped never reuses a source. The source is
   `node:<node>:<stream>:<n>`, with the node the server authenticated, so one node cannot spend another's numbers.
   Hello, `load`, `status`, the terminal's messages, `turn.open`, `agent.start` and `agent.said` stay unnumbered: they
   are snapshots or live answers that are worth nothing late, as today. The server says that it confirms in its
   upgrade answer's header `Hornhoof-Acks: 1`, which plan 2's hops pass as they came. With it, the node keeps each
   numbered message until `ack { upto }`, which the server sends on the socket the message came on once it committed,
   was listed already, or failed for a reason that will not pass. Without it (plan 3's server), the node drops what
   it sent but `job.done` and `tests.done`, which wait for their old acks, as today. Numbers go out in order: a job's
   end is kept from the moment the job leaves `running`, as today, and numbered when its turn to be sent comes.
5. **A message that fails for a passing reason holds back the ones after it; a message the app died in is handled
   again only where that is safe.** The spec confirms "the highest number below which every message committed or
   failed for good". A lease refused, a commit not confirmed, a database out of reach, busy or in conflict
   (`40001`, `40P01`, `55P03`, `57P03`, `53300`, connection codes), or a 503 of the app is passing: the server drops
   that socket's queued messages unhandled and closes it with 1013, and the node sends them again in order after its
   next hello. `job.done` and `tests.done` commit more than once and are sent again today until they are confirmed,
   and their own guards make a second run safe (a second `tests.done` still keeps a log the first lost), so they are
   handled again when listed, their steps numbered on after the ones that committed. Every other numbered message is
   skipped when listed, and Task 4 checks that each commits once. On stop, the hub lets each socket's queue finish,
   up to 5 s, before the database closes, so a restart does not cut a handling in half.
6. **The node's outbox is a file in its volume.** `outbox.jsonl` in the data folder, mode 0600, owned by root like
   `node.json`. Past 20,000 entries the oldest `job.event` goes first. The ends of jobs and test parts are never
   dropped: a node that cannot reach the server gets no new work, so it holds at most the ends of what it ran. This
   replaces today's `MAX_UNCONFIRMED` of 50, which dropped the oldest end, and its job, as `machine_restarted`.
7. **These tools commit "started" before they act:** `run_tests`, `run_work`, `stop_tests`, `stop_work`, `computer`,
   `test_subscription`, `update_hornhoof`, `cancel_update`, `set_public_link`, `remove_public_link`,
   `tell_orchestrator`, `message_employee`, `stop_employee`, `cancel_task`, `disconnect_machine` and
   `remove_subscription`: each reaches a node, the updater, the computer access, a file or another turn, and a second
   run could stop the next turn, send a message again or start another install. Task 3 adds any other tool whose
   handler, or the route it calls, does so. The rest change only rows, and the task tools wake agents through
   `pending_wakes` in their own transaction, so `applied` covers them.
8. **`front` keeps its calls in memory, not in a file, and takes one call per request.** The spec's "small persisted
   outbox" outlives a restart of `front`, but such a restart cuts the agent's own connection to it, so a kept call
   could never be answered; the agent's next try is a new call. A call that `front` gives up answers the agent with a
   tool error that says whether it may have run. An MCP batch, which `front` could not stamp call by call, is refused.
9. **The built-in node signs in with a key of its machine, and stays one node to the hub.** Its key is
   `builtin.<machine id>.<HMAC-SHA256 of NODE_KEY over "hornhoof builtin node <machine id>">`, so `NODE_KEY` itself
   never travels, and it points at `http://front:8080`. The hub keeps one built-in identity, as today, and the bare
   `NODE_KEY` still signs in (a node of plan 3's build). Two built-in nodes can exist only once a second data machine
   joins: plan 5 splits the identity and makes `jobsOf` and test parts per machine before that, since the hub's 26
   uses of `BUILTIN` in nine files are best changed with the plan that tests two machines.
10. **Turns survive an Update only while the node's image stays.** `install.sh` leaves the built-in node and the
    plan nodes running when the node's image is unchanged (`node_unchanged`). A new node image restarts every node of
    the company that the Update sweeps, the plan nodes too, and ends every turn running on them, on a subscription or
    an API key alike, since an agent does not outlive its node. This build changes the node's code (the outbox), so
    its node image changes, and its first Update also changes the built-in node's settings (`front`, the machine id):
    it ends every turn that runs. So before Ivan presses Update, the team lead compares the node image digest of the
    running build with the new one and tells Ivan in one line whether running turns will end; when they will, Ivan
    picks a moment between turns.
11. **The node waits at most 10 s between tries to connect,** on one machine too, so it is back soon after the app
    is. The spec says "on a network"; a node away for a long time costs a connect every 10 s. A node the server
    refused (401, or a close with 4001) waits 60 s, as today, and a handshake that gets no answer ends after 20 s.
12. **Holding, within one budget.** `front` holds a request whose connect to the keeper fails, trying again every
    500 ms for up to 60 s (`HOLD_MS`); the keeper does the same toward the app for up to 45 s (`KEEPER_HOLD_MS`), so
    its answer reaches `front`, and the page, inside `front`'s minute. Each answers 503 with `Retry-After: 5` and
    reason `starting` once its hold ran out. Only a connect that failed is tried again; a hop that dies after taking
    a request answers plan 2's 502, and the page tries again with its key. `front`'s `/mcp` path tries a call again
    with its invocation id after a connect that failed, a reset, an answer cut off, a 502 or a 503 with reason
    `starting`, for up to 50 s after its first failure (`CALL_HOLD_MS`), and passes only whole answers on: 50 s leaves
    the agent's MCP client, which gives up after 60 s, time to read `front`'s own error. In `maintenance` the keeper
    answers at once, since an update takes minutes.
13. **The invocation id is believed from `front` alone, and answers stay with their job.** The keeper passes
    `x-hornhoof-invocation` on only from `front`'s address, as it does `x-forwarded-for`, and the app takes it only
    from the keeper's address, by the check it uses for `x-forwarded-for` (`fromTunnel`, on `TUNNEL_HOST`). So the
    built-in node, which can still reach `app:8080` directly on the compose network, never stamps a call. The app also
    reads a kept answer only for the calling job, and an id another job holds runs nothing.
14. **The keeper prunes `applied` and `tool_calls` with the journal** (extending plan 3's ruling 19): while the
    lease's sync is `alone`, rows of `applied` older than 7 days, and rows of `tool_calls` older than 7 days whose job
    is no longer `running`, at most 10,000 of each per round, on the indexes `0047` adds. A node message sent again
    after 7 days is applied again; a node keeps nothing unconfirmed that long but a message the server applied and
    then failed to confirm. Each node event now journals its row, its step and, 7 days later, the step's deletion, so
    a round of 10,000 journal rows a minute keeps up with about 3,000 events a minute, far above what Ivan's company
    sends. Plan 8 replaces this with pruning that knows the merges.
15. **Nodes stay out in `read`** (plan 2): their outboxes keep what they would send, so letting them in for status
    waits for the plans that need it.

## Review Focus

1. The app restarting (or `docker compose restart app`) while turns run on the built-in node and on a plan node: what
   the nodes sent meanwhile arrives once, in order, and the turns end as they would have, not as `machine_restarted`.
   Tests in Task 4 (`applies a numbered message once`, `takes a message again after a passing failure, and nothing
   after it`, `lets queued messages finish when the app stops`), Task 5 (`sends numbered messages again until the
   server confirms them`, `keeps its messages through its own restart`) and Task 8's rehearsal.
2. A change sent from the page while the app restarts: it is held or sent again with its key, applied once, and the
   page shows its answer, or `already_done` when the first answer was lost. Tests in Task 2 (`applies a change once
   when the page sends it again`, `sends one request id with a change and keeps it on retry`, `commits the first step
   of an action outside the database`) and Task 7 (`holds a request while the target is down, up to holdMs`).
3. A tool call whose answer was lost, sent again by `front`: the kept answer, `PENDING` or `ALREADY_RAN`, never a
   second run; two identical calls both run. Tests in Task 3 and Task 7 (`sends a call again with the same id until
   it is answered`, `sends a call again whose answer broke off`, `stamps each tool call with its own id`).
4. A node of plan 3's build with this server, and this node with plan 3's server (Ivan going back by Versions): both
   work as before. Tests in Task 4 (`talks to a node of the build before as today`) and Task 5 (`talks to a server
   of the build before`).
5. A node that was away for hours while its agents worked: its outbox stays within its cap, keeps every job's end,
   and survives a cut-off write; the server takes the backlog one message at a time, each well inside the 5 s limit.
   Tests in Task 5 (`caps the outbox, but never an end`, `recovers from a line cut short`) and Task 4.

---


# The task

### Task 4: Node messages, numbered and confirmed by the server

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 3 committed. **Done when:** from
`packages/protocol`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/protocol.test.ts` passes; then `npm run
build -w @hornhoof/protocol` from the worktree root; from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest
run test/node-messages.test.ts test/socket.test.ts test/conversation.test.ts test/hub.test.ts
test/tasks-reconcile.test.ts` passes, then the whole server suite; both `tsc` commands (protocol, server) print
nothing.

**Files:**
- Modify: `packages/protocol/src/index.ts`, `apps/server/src/modules/nodes/hub.ts` (`keyOf` exported),
  `apps/server/src/modules/nodes/messages.ts`, `apps/server/src/modules/nodes/socket.ts` (the header),
  `apps/server/src/app.ts` (`onNumbered`), `apps/server/test/helpers.ts` (`FakeNode` gains `upto: number[]`: each
  `ack`'s `upto` lands there, not in `next()`)
- Test: `packages/protocol/test/protocol.test.ts`, `apps/server/test/node-messages.test.ts` (new),
  `apps/server/test/socket.test.ts`

**Interfaces:**
- Consumes: `withSource`, `nodeSource`, `listed`, `touch` (Task 1); `isLeaseRefused`, `notConfirmed` (plan 3);
  `whileLeading` (plan 2).
- Produces:
  ```ts
  // packages/protocol
  export const NUMBERED = ['job.started', 'job.event', 'job.done', 'tests.started', 'tests.done', 'cred.sealed', 'login.done', 'agent.context', 'removed'] as const;
  //   each of these messages gains n?: number (an integer from 1); hello gains stream?: string (a uuid)
  //   ServerMessage gains { type: 'ack'; upto: number } (an integer from 0)
  export function isNumbered(m: NodeMessage): boolean;   // its type is in NUMBERED
  export const ACKS_HEADER = 'hornhoof-acks';            // '1' on the upgrade answer of a server that sends ack
  // modules/nodes/messages.ts
  export const AGAIN_WHEN_LISTED: ReadonlySet<string>;   // 'job.done' and 'tests.done' (ruling 5)
  export function passing(err: unknown): boolean;
  //   on err or one of its causes: isLeaseRefused, notConfirmed, an ApiError with status 503, or code 40001, 40P01,
  //   55P03, 57P03, 53300, ECONNREFUSED, ECONNRESET, ETIMEDOUT or one starting with 08
  export function handleNumbered(ctx: Ctx, id: NodeIdentity, stream: string, msg: NodeMessage & { n: number }): Promise<boolean>;
  //   base = nodeSource(keyOf(id), stream, msg.n); when listed: a type in AGAIN_WHEN_LISTED runs handleNodeMessage in
  //   withSource(base, ..., listed.steps), any other gets touch; else handleNodeMessage in withSource(base, ...).
  //   Then true; an error that is passing gives false; any other is logged as 'A node message failed.' is today,
  //   then true
  ```
- `socket.ts`: the upgrade answer of `/api/nodes/socket` carries `Hornhoof-Acks: 1` (`app.websocketServer`'s
  `headers` event, for that path only).
- `hub.ts`: `HubOptions` gains `onNumbered(id: NodeIdentity, stream: string, msg: NodeMessage & { n: number }):
  Promise<boolean>`, and `Entry` gains `stream: string | null` (from the socket's first hello that names one; a later
  hello's stream is ignored) and `refused: boolean`. A numbered message with `n` on an entry with a stream takes its
  place in the socket's chain with the stream it had when it came, as `onNumbered`: `true` sends `ack { upto: n }`
  on that message's own socket; `false` sets `refused` and closes that socket with 1013 `Hornhoof could not take this
  now; send it again.` Once `refused` is set, every link of that chain still waiting runs nothing. A message without
  `n`, or on an entry without a stream, runs through `onMessage` as today, with no source and no ack. `stop()` stops
  taking messages, waits up to 5 s for each socket's chain to settle, then closes the sockets with 1001.
- `app.ts`: `onNumbered` runs `handleNumbered` only while `ctx.mode.current()` is `lead`, and gives `false`
  otherwise, so nothing that nothing handled is acked; the `onClose` hook awaits `ctx.hub.stop()` before the
  database closes. `job.ack` and `tests.ack` are sent as today.

- [ ] **Step 1: Check what each numbered message commits.** For each type of `NUMBERED` but `job.done` and
  `tests.done`, read its handler and what it awaits: it must commit at most once, follow-ups included. One that
  commits more than once is put in one `db.transaction` when its writes allow it, else named in the report.
- [ ] **Step 2: Write failing tests.**
  - `protocol.test.ts`, `numbers what changes data and stays readable`: a `job.event` with `n: 3` parses with `n`; one
    without `n` parses; a hello with a `stream` parses; `ack { upto: 4 }` parses as a server message; a `job.event`
    with `n: 0` is `null`; a message with a key no schema names still parses (zod drops it).
  - `node-messages.test.ts`, on `testApp()` listening, a company with an API-key subscription and a plan node, and
    `connectNode`:
    - `says it confirms on the upgrade`: the upgrade answer of `/api/nodes/socket` has `hornhoof-acks: 1`.
    - `applies a numbered message once`: a running turn's `job.event` with `n: 5`, sent twice on one stream, gives one
      `agent_events` row and two `ack { upto: 5 }`; `applied` lists `node:builtin:<stream>:5:0`.
    - `keeps each node's numbers apart`: the built-in node and the plan node, each with a running turn, send a
      `job.event` with the same stream and `n`: both are stored.
    - `handles a job's end again when listed`: `job.done` with `n: 7`, `ok: false` and `error: 'agent_failed'`, sent
      twice, ends the job once with one `failed` event (`afterJob`'s); the base's steps go on from where the first
      left off; both copies get `ack { upto: 7 }`, and `job.ack` comes for each as today.
    - `takes a message again after a passing failure, and nothing after it`: with `setLease(db, { until: '-infinity'
      })`, `job.event`s with `n` 8 and 9 sent together: the socket closes with 1013, no ack comes, no row is added;
      with the lease back, a new socket's hello and the same two messages give two rows and acks 8 and 9 in order.
    - `takes a deadlock as passing`: with `vi.mock` of `src/modules/events/store.js` that keeps its other exports and
      makes `appendEvent` throw an error with code `40P01` once when the test sets a flag, the socket closes with
      1013; the same message on a new socket is stored and acked.
    - `acks a message that failed for good`: the same mock throwing `new Error('broken')` once: that `job.event` is
      acked and the error logged; the next message is handled.
    - `acks on the socket the message came on`: with `appendEvent` held 300 ms by the mock, a second socket of the
      same node that connects meanwhile gets no `ack` of the first socket's message.
    - `lets queued messages finish when the app stops`: with `appendEvent` held 300 ms, `app.close()` right after a
      `job.event` is sent: the event is stored and acked before the socket closes with 1001.
    - `talks to a node of the build before as today`: a hello without a stream and `job.event`s without `n` are
      stored, no `ack` comes, the same event sent twice is stored twice, and `job.done` without `n` gets `job.ack`.
  - `socket.test.ts`: every test as it is.
- [ ] **Step 3: Run** Done when. Expected: FAIL (no `n`, no header).
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Number the node messages that change data, and confirm each once it is applied".

### Task 5: The node's outbox

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 4 committed. **Done when:** `npm run build -w
@hornhoof/protocol` from the worktree root; from `apps/node`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/outbox.test.ts test/main.test.ts test/connection.test.ts test/isolation.test.ts test/commands.test.ts` passes,
then the whole node suite; `npx tsc -p apps/node/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/node/src/outbox.ts`
- Modify: `apps/node/src/main.ts`, `apps/node/src/connection.ts`, `apps/node/src/isolation.ts` (`secureNode`)
- Test: `apps/node/test/outbox.test.ts` (new), `apps/node/test/main.test.ts` (its `fakeServer` takes `{ acks }` and
  then sends the header), `apps/node/test/connection.test.ts`, `apps/node/test/isolation.test.ts`

**Interfaces:**
- Consumes: `NUMBERED`, `isNumbered`, `ack`, `ACKS_HEADER` (Task 4).
- Produces:
  ```ts
  // apps/node/src/outbox.ts
  export const OUTBOX_FILE = 'outbox.jsonl';
  export const OUTBOX_MAX = 20_000;
  export type End = Extract<NodeMessage, { type: 'job.done' | 'tests.done' }>;
  export type Entry = { n: number; msg: NodeMessage };
  export class Outbox {
    constructor(dir: string, opts?: { max?: number; flushMs?: number });   // max OUTBOX_MAX, flushMs 1000
    readonly stream: string;     // read from the file, or a new uuid with a new file
    add(msg: NodeMessage): Entry;   // the next n; the message carries it; kept
    hold(end: End): void;           // kept with no n yet: a job's or a part's end before its turn to be sent
    number(id: string): Entry | null;  // gives the held end of that job or part its n; null when none is held
    held(): string[];               // the jobs and parts whose ends are held
    pending(): Entry[];             // the numbered entries, in order of n
    ack(upto: number): void;        // drops every numbered entry up to upto
    ackJob(jobId: string): void;    // drops that job's end (the old job.ack)
    ackPart(partId: string): void;  // drops that part's end (the old tests.ack)
    dropSent(upto: number): void;   // drops every numbered entry up to upto but the ends (an older server)
    doneJobs(): string[];           // the jobs whose ends are held or numbered
    doneParts(): string[];          // the parts whose ends are held or numbered
    close(): void;                  // writes what waits
  }
  //   The file, mode 0600, is appended a line per change; drops are written by rewriting it (to a temp file, then a
  //   rename) at most once per flushMs. On open, a last line without its newline, or not JSON, is cut off the file
  //   before anything is appended, and the next n is above every n the file holds or held (a rewrite keeps it).
  //   Past max, the oldest job.event goes first (the oldest entry that is not an end when none is left); ends are
  //   never dropped by the cap.
  ```
- `main.ts`: numbered messages go through `outbox.add`, but a job's end is held with `hold` where `keep` is today
  (before the job leaves `running`) and numbered with `number` where `emit(done)` is today; a part's end the same
  where `keepTest` and its `emit` are. On open: the hello carries `stream`, `running` adds `doneJobs()` and `tests`
  adds `doneParts()`, as the unconfirmed maps did, which go; every held end is numbered; every pending entry is sent
  in order, then each new one as it is numbered. When the upgrade answer had `hornhoof-acks: 1`, `ack` drops what it
  confirms. When it did not: after sending the pending entries, `dropSent(<the last n sent>)`, and each later
  numbered message is dropped once sent unless it is an end. `job.ack` and `tests.ack` call `ackJob` and `ackPart`
  either way. A `tests.run` for a part whose end the outbox holds is skipped, as `unconfirmedTests.has` does today.
  Unnumbered messages that cannot be sent wait in memory as today. `stop()` calls `close()`.
- `connection.ts`: `onOpen(send, acks)` gets `acks` true when the upgrade answer had `hornhoof-acks: 1`; the default
  backoff stops growing at 10,000 ms; `backoff` gains `refusedMs` (60,000), the wait after a 401 or a close with
  4001, as today's 60 s; the socket gets `handshakeTimeout` `handshakeMs` (20,000). `secureNode`: `outbox.jsonl`
  joins the root-owned files.

- [ ] **Step 1: Write failing tests.**
  - `outbox.test.ts`, on a temp folder:
    - `numbers messages and keeps them across a restart`: three added; a new `Outbox` on the folder has the same
      `stream` and pending `n` 1 to 3, and its next `add` gets 4.
    - `drops what the server confirmed`: `ack(2)` leaves `n` 3, also after reopening.
    - `numbers a held end when its turn comes`: an end held, then a `job.event` added (`n` 1), then the end numbered
      gets `n` 2; `doneJobs()` lists the job from `hold` on; the held end survives a reopen.
    - `keeps a job's end until either ack`: an end stays after `ack` of a lower `n`, and goes on `ackJob` of its job;
      a `tests.done` goes on `ackPart`.
    - `drops live messages when it talks to an older server`: of five entries, `dropSent(3)` keeps the ends among the
      first three, and entries 4 and 5.
    - `writes the file for its owner only`: `outbox.jsonl`'s mode is `0600`.
    - `caps the outbox, but never an end`: with `max` 10, fifteen `job.event`s and 60 ends keep the 60 ends and the
      newest events that fit, none dropped while it is an end.
    - `recovers from a line cut short`: three added, half a line written to the file by hand, a new `Outbox` on it
      adds one more, and another new `Outbox`, with no `close()` before it, has four entries, `n` 1 to 4.
  - `main.test.ts`, with `fakeServer()`:
    - `sends numbered messages again until the server confirms them`: a server with `{ acks: true }` that drops the
      socket after two `job.event`s without an ack gets both again, in order, after the next hello; after it acks
      them and drops the socket again, nothing numbered comes after the hello.
    - `keeps its messages through its own restart`: a `job.event` made while no server listens, `stop()`, and a new
      `runNode` on the same folder: once a server listens, the event arrives after hello, with the same stream and
      `n`.
    - `talks to a server of the build before`: a server without the header gets the pending messages right after
      hello; when it drops the socket, the next connection sends again only the `job.done` it did not `job.ack`.
    - `does not run a part again whose end waits for its ack`: a `tests.run` for a part whose `tests.done` was sent
      and not acked starts nothing.
    - main's tests of `job.done` and `tests.done` sent again until acked, and `commands.test.ts`'s `run --builtin`
      tests, keep passing as they are.
  - `connection.test.ts`, `waits at most 10 s between tries`: with fake timers and nothing listening, the waits are 1,
    2, 4 and 8 s, then 10 s each; after a 401 the next wait is 60 s. `gives up a handshake that gets no answer`: with
    `handshakeMs` 300, a server that takes the TCP connection and answers nothing gets a new try. `knows a server
    that confirms`: `onOpen` gets `acks` true from a server that sends the header, false from one that does not.
  - `isolation.test.ts`, `secureNode` makes `outbox.jsonl` root-owned when it exists.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no outbox).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the node's messages in its volume until the server confirms them".

