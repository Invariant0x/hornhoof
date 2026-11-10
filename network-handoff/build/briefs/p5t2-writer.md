You are the writer for Task 2 of 2026-11-03-network-phase-1-plan-5-authority-and-peer-link in Hornhoof's network build. Read everything below before you start.

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

- Your lane: `/home/altera/hornhoof-network/wt/p5t2`, Hornhoof repo, branch `task-p5t2`. Kind: known behaviour, test-first as the plan says. Security class: keys, certificates.
- The plan's "Starts from" line is paper here: this task goes ahead of its plan, because it needs nothing that has not landed. Your lane stands on batch 6. It is a whole task: `apps/server/src/modules/network/authority.ts` and `apps/server/test/authority.test.ts`.
- `MachineRole` belongs to Plan 5 Task 1, which has not landed. Declare it in `authority.ts`: `export type MachineRole = 'data' | 'worker';`. Its owner's text, for you to keep to, is `export const MACHINE_ROLES = ['data', 'worker'] as const; export type MachineRole = (typeof MACHINE_ROLES)[number];` in `schema.ts`, and that task will turn your line into a re-export. Do not touch `schema.ts`.
- `toPem` at `apps/server/src/modules/tls/x509.ts:16` is private and holds the reason a final newline matters in a chain: export it and use it, do not copy it. Import `x509.ts` first; its line 5 sets the crypto provider.
- A planner tried on Node 22.23.2 with `@peculiar/x509` 1.14.3: an Ed25519 self-signed CA and a CRL with `cessationOfOperation` read back. Whether OpenSSL takes that CRL is your test to show, not a known fact. If the library or OpenSSL proves the plan wrong, stop and report.
- The rest of Plan 5 is not there; nothing calls this yet, and that is fine.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 5: The Company's Authority and the Peer Link, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each company gets its own certificate authority, made by the leading app and kept in the database under
`HORNHOOF_SECRET`. The keeper of the machine the company runs on makes the machine's Ed25519 key in a volume of its own,
gets a certificate for it with the data role, renews it weekly, and reports the machine's uptime, disk sync time and
free disk. It then serves the peer link on the peer port: HTTP/2 over mutual TLS, trusting only the company's authority
and refusing in the TLS handshake every client without a valid certificate of it (none, another authority's, an expired
or a revoked one), passing a peer's CONNECT stream to the app with `x-hornhoof-via` naming the peer, and to `db` only
for the data role. With a public link it offers the peer link and the app through hornhoof.org as two stcp services.
Nothing joins yet: plan 5b brings the machines that use all this.

**Architecture:** One migration from `schema.ts` (`0049_network`): the machine's network id, role, signing key and
measures on `machines`, and the tables `authority`, `certificates` and `peer_secrets`.
`modules/network/` holds the authority (`authority.ts`, pure, on `@peculiar/x509` and Node's `X509Certificate`), the
database side (`store.ts`) and the routes the keeper calls (`routes.ts`, `/api/network/*`, taken only from the
keeper, by `x-hornhoof-via`). The keeper gains `machine-keys.ts`, `certificate.ts` and `measures.ts` in
`modules/keeper/`, and the peer link in `net/peer-server.ts` (the TLS handshake against the authority and its
revocation list, sessions, CONNECT) and `net/peer-door.ts` (the loopback HTTP door that adds `x-hornhoof-via` before
the app). A second frpc child of the keeper (`modules/link/peer-client.ts`) offers
the two stcp services.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:tls`, `node:crypto` with Ed25519, `node:fs` `statfs`);
`@peculiar/x509` 1.14.3 (plan 1b) on Node's webcrypto; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite;
frpc 0.71.1; vitest with PGlite; Docker for `npm run test:real`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.2 (the authority, certificates with roles, keepers over
mutual TLS on HTTP/2, CONNECT streams, `x-hornhoof-via`, what each role's certificate reaches, path 2's two stcp
services), 3.3 (the load report's uptime, fsync time and free disk), 3.4 "One data machine", 3.8 "Keys" (the Ed25519
signing key in the certificate) and section 10 ("Peer link", "The authority's key", "Secrets"). Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`, plan 5's entry and discrepancies 1 and 16. Plans 1 to 4 (see
"Handed over by plans 1 to 4").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in a new worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/peer-link` on a new branch `peer-link` from main (`git worktree
add`, then `npm ci` there once), after plan 4 is merged into main and shipped.

**Handed over by plans 1 to 4** (merged and shipped before this plan starts):
- Plan 1, on hornhoof.org: an frpc logged in as `<link>-<machine8>-peer` with the link key may offer the stcp services
  `<link>-<machine8>-data` and `<link>-<machine8>-app`, each with a secret of at least 32 characters and `allowUsers`
  left empty, and nothing else (R5.1).
- Plan 1b: `@peculiar/x509` 1.14.3 in `apps/server`, its crypto provider set to Node's webcrypto in
  `modules/tls/x509.ts`.
- Plan 2: `net/proxy.ts` (`passThrough`, `PassOptions`, `serve`, `socketAddress`, `firstForwarded`, `Target`); the
  keeper (`KeeperOptions`, `Keeper`, `KEEPER_PORTS = { peer: 7070, front: 7080, linkHttp: 7081 }`), with
  `HORNHOOF_PEER_PORT` published to 7070 and nothing listening there; `config.machineId` (`HORNHOOF_MACHINE_ID`);
  `TunnelKeeper` (`read`, `clientFor`), `linkClientId`, `configFor`, `clientFor`, `FrpcLocal`, `tunnelSettings(db,
  config)`; compose's `keeper` service and `compose.test.ts`'s exact list of its environment keys; the app's
  `TUNNEL_HOST: keeper`; every door of `front` and the keeper drops incoming `x-hornhoof-*` headers.
- Plan 3: the keeper's `leaseStore` (`take` writes sync `alone`, `renew` keeps it) and its ruling 7, which hands the
  check that no other data machine is listed to the plan that lists them; `HIDDEN` and `CLOSED` of the database tool;
  `AFTER_MIGRATIONS`, which attaches the journal to every table of `public` after each migration run; the keeper sets
  `lead` only under a valid lease; `openTestDb` and `createTestDb` give a fenced PGlite with an endless lease.
- Plan 4: migrations up to `0048_calls`; `fromTunnel(req, config)` exported from `auth/tunnel.ts`; the app's compose
  environment has `HORNHOOF_MACHINE_ID`; `PassOptions.holdMs` and the keeper's front door passing
  `x-hornhoof-invocation` only from `front`'s address.
- Today's code: `machines` (`db/schema.ts:107-125`), `builtinMachine` (`modules/nodes/nodes.ts:34-45`) and its three
  callers, `encryptSecret` and `decryptSecret` (`crypto/secrets.ts`) with `config.secret`, `people.is_owner`,
  `config.commit`, `hashToken` (`crypto/tokens.ts`).
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and certificates made at run time.
- No new dependency. Certificates are made with `@peculiar/x509` (plan 1b) and read and checked with Node's
  `X509Certificate`; keys are Node's Ed25519.
- One new migration, never an edit of an older one: `0049_network` by `npx drizzle-kit generate --name network` from
  `apps/server`.
- A private key (the authority's, a machine's) never goes into a log line, an answer, `keeper.json` or a file outside
  the keeper's own volume; the authority's key is stored only encrypted, as the link key is. The peer secrets travel
  only to the keeper that offers them.
- The keeper starts before `migrate` (plan 2), so a keeper of this build runs a while on the schema of plan 4's build:
  every read of a table or column this plan adds keeps what the keeper has when it fails, and nothing the keeper does
  each second reads them.
- Fail toward a working company: a certificate, a peer secret or a measure the keeper cannot get changes nothing the
  company runs today (the app, the link, `front`, the lease); it is tried again.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from
  the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; the real tests: `npm run
  test:real`, which needs Docker. Types, from the worktree root: `npx tsc -p apps/server/tsconfig.json --noEmit` and,
  for the web task, `npx tsc -p apps/web/tsconfig.json --noEmit`, each printing nothing. Never run prettier.


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

1. **Plan 5 comes in two.** The overview's plan 5 is about twice plan 4. This plan gives the company its authority and
   its server the peer link, and changes nothing anyone sees; plan 5b brings the machines that join: the small core
   on a joined machine, the paths to the leader, finding it, addresses, the Machines tab, Disconnect, workers
   following the leader's build, and the lab. Each merges alone and leaves a one-machine company working as today,
   and the peer port gets a release of its own to show it refuses what it should before anything uses it.
2. **One authority per company, made by the leading app the first time a keeper asks.** Its key is Ed25519, its
   certificate is self-signed for 20 years (`CN=Hornhoof company <company id>`, a CA with path length 0), and both sit
   in `authority`, the key under `HORNHOOF_SECRET` as the link key is (spec section 10). Only the app signs, and only
   while it leads, so only the leader uses the key. The table is hidden from the orchestrator's SQL.
3. **A machine's certificate carries its Ed25519 key**, the signing key of spec 3.8, also used for TLS 1.3: 30 days,
   `CN=<machines.id>`, the subject alternative names `urn:hornhoof:machine:<machines.id>` and
   `urn:hornhoof:role:<data|worker>`, server and client use. Its keeper asks for a new one once it is older than 7 days
   (spec section 10, "renewed weekly"); a peer machine asks through `CONNECT app` while its certificate is valid,
   with 23 days to spare. An expired certificate fails at the handshake like any other bad one (ruling 12), so spec
   section 10's "an expired certificate may only ask for a new one" waits for plan 5b, the first plan with machines
   that can be away that long, and may not loosen this port's handshake. The keeper that loses its volume makes a new
   key: its own app gives the leader's machine a certificate for it; a joined machine joins again (plan 5b).
4. **Plan credentials stay sealed to node keys, and the machine's age key comes with plan 7.** Discrepancy 1 proposed
   sealing them to machine keys, but a machine key lives in the keeper's volume, which no node reads, so a node could
   no longer open its own plan's sign-in. Step 0's ruling (one key per node) is kept, and nothing before backups needs
   a machine's X25519 key, so plan 7 makes it with the bundles that use it.
5. **The keeper asks the app, and the app believes only its keeper, by a header no door lets through.** Every request
   the keeper's front door and link door pass on reaches the app from the keeper's address too, so the address alone
   says nothing. `/api/network/*` answers only a request from the keeper's address (`fromTunnel`) that carries
   `x-hornhoof-via`: `keeper` for the keeper's own request, about the machine the app runs on, or a peer machine's id,
   set by the peer door from the peer's certificate. Every door drops an incoming `x-hornhoof-*` header (plan 2) and
   the peer door writes its own, so a page, a visitor of the link, a node or a peer cannot send either value. Messages
   from a peer machine are app requests carried through `CONNECT app`, a new certificate too; only `hello` is the
   keeper's own.
6. **The leader's own machine is a hidden row of its own.** The certificate names a row of `machines`: the live row
   whose `network_id` is `config.machineId`, else a new one for the company's owner (who cannot be disabled) with
   `machine_key` `server:<machine id>`, no hostname and the role `data`. It is never the row of a computer someone
   joined, so Disconnect and disabling a person, which revoke those, never reach it. The routes that list, change or
   disconnect machines and the test pool skip `server:` rows, so nothing anyone sees changes; plan 5b shows the
   network's machines and can relate this row to a joined computer with the same host id. A database keeps one live
   `server:` row: a new one retires the others and revokes their certificates, as after a restore onto an install with
   another machine id, so an old identity never counts as another data machine (ruling 9).
7. **Two doors on the peer link.** Port 7070, published as `HORNHOOF_PEER_PORT`, is the whole peer link, by role. Port
   7071, on `127.0.0.1` only, is what the `-app` stcp service reaches: `hello` and `CONNECT app`, whatever the
   certificate's role (spec 3.2: that service "reaches only an app"). `CONNECT db` is taken only on 7070 from a data
   certificate. `CONNECT app` reaches this machine's app whatever its mode; a copy passing it to the leader comes with
   plan 9.
8. **Revocation is an X.509 CRL the leading app signs, so the handshake refuses a revoked certificate.** `certificates`
   keeps every serial issued, with its machine, until it expires, so all of a machine's certificates can be revoked
   (plan 5b's Disconnect); the revoked ones not yet expired are the list. `GET /api/network/peers` gives them and, while
   the app leads, a CRL of them signed with the authority's key (from a day ago to a year on, each entry with the reason
   `cessationOfOperation`). The keeper keeps the last CRL in its volume and gives it to the TLS server, and takes a new
   one when the list changes. Node's `crl` option turns on OpenSSL's revocation check for the whole chain, so a server
   without a CRL refuses everyone: the keeper does not listen before it holds a certificate and a CRL. It reads the list
   every 5 s and closes every open session whose certificate is on it or has expired. Only the leader takes sessions in
   this plan; plan 5b hands workers the CRL.
9. **The check that the machine is alone (plan 3, ruling 7) runs apart from the lease.** The keeper reads, every
   10 s, whether another machine of the role `data` is listed, and then neither takes nor renews a lease with sync
   `alone`; the lease lapses and the app reads. It is not in the renewal statement, since the keeper of this build
   renews on plan 4's schema until `migrate` has run. No other machine gets the data role before plan 9.
10. **The stcp services run only with a public link.** They need a name at the relay. A company without a link gets
    them once a plan binds it a hidden name (spec 3.4 "Without a public link"). Their secrets are 32 random bytes in
    base64url, made by the app on first use while it leads, in `peer_secrets` (hidden); outside `lead` a missing
    secret means no services yet.
11. **Measures are the keeper's last values on the machine's row.** Every 20 s it samples one 4 KiB write with fsync
    in its volume and keeps 24 hours of samples; it reports the 99th percentile (none with fewer than 10 samples), the
    volume's free bytes and the kernel's uptime (Docker's Linux system on a Mac), with the published ports and its
    commit, every 20 s while the app leads. History and the 7-day online share come with plan 5b.
12. **The peer port answers nothing without a valid certificate of the company (the team lead's condition).** With no
    machine joined yet, the server asks every client for a certificate and refuses in the handshake
    (`rejectUnauthorized: true`, `ca` the authority, `crl` its list) one that is missing, of another authority,
    expired, or on the list. OpenSSL answers a missing one with the alert `certificate required`; for the other three
    Node ends the connection once OpenSSL's handshake is through and before it hands out the socket, so the client sees
    the handshake end unfinished, no HTTP/2 session starts, and the app sees nothing. Session tickets are off
    (`SSL_OP_NO_TICKET`): a resumed TLS 1.3 session sends no certificate, and with tickets on a certificate revoked
    after the first connection came back in. All of this was tried on Node 22.23.2 against OpenSSL 3.6's `s_client`
    with Ed25519 certificates. The authority's key usage includes `cRLSign`, or OpenSSL takes no list it signs.
13. **What plans 3 and 4 left to "the plan that brings a second data machine" goes to plan 9.** Plan 3's ruling 6
    (frpc stops at lease end) and plan 4's ruling 9 (the built-in node's identity, `jobsOf` and test parts per
    machine) wait for a second data machine, which neither this plan nor plan 5b brings: a worker runs no app and no
    built-in node. Plan 3's ruling 7, the check itself, is here (ruling 9).
14. **The network's tables are closed to the orchestrator twice.** `authority`, `certificates` and `peer_secrets` are
    in `HIDDEN`, and have row level security on with no policy, so a role that is neither their owner nor a superuser
    sees no row and changes none, whatever it is granted. The second guard holds after a downgrade to plan 4's build,
    whose grant builder does not know these tables and grants the orchestrator every table of `public` it does not
    hide; the app and the keeper connect as the owner and pass. The new `machines` columns are read-only to the
    orchestrator as `machines` is today.
15. **A dump restores with its `HORNHOOF_SECRET`.** The authority's key and the peer secrets are sealed with it, as
    the link key is today. With another secret the authority does not open: the certificate route answers 500 with one
    log line, the peer link stays shut, and everything else works; plan 7, which carries backups to other machines,
    brings the secret with them. Another machine id takes the identity as ruling 6 says.
16. **The peer link opens only once the keeper has checked its certificate and its list with the app in this run.**
    After a start, the volume's certificate and CRL serve only once an answer of `GET /api/network/peers` says the
    certificate is of the database's authority and for this machine's row, and that the CRL lists the serials revoked
    now. A mismatch, as when a failed Update restored the database of before it while the keeper's volume kept a
    certificate of the discarded authority, asks for a new certificate or waits for a new CRL first. Until then
    nothing listens on the peer port, so a revoked certificate never gets in through a stale list while the app
    starts, and the lease, `front` and the public link do not wait for any of it.

## Review Focus

1. A client at the peer port or the app door without a certificate, with one of another authority, an expired one or
   a revoked one: refused in the TLS handshake, the app sees nothing, and a resumed session cannot skip the check; a
   session whose certificate gets revoked or expires closes within 6 s. Tests in Task 2 (`refuses an expired
   certificate at the handshake`, `refuses a revoked certificate at the handshake by its CRL`), Task 5 (`refuses at
   the handshake every client without a valid certificate`, `does not resume a TLS session`, `closes a session once
   its certificate is revoked`), Task 6 (`reads revocations as they come`) and Task 7's probe from another machine.
2. A worker's certificate never reaches `db`, on either door, and nothing reaches `db` through the app door. Tests in
   Task 5 (`takes CONNECT db only from a data certificate on the peer door`).
3. A forged `x-hornhoof-via`, from a node, the link, `front`, a peer's request or a direct request to the app, never
   reaches the app's network routes as sent, and a request through the keeper's front or link door, which comes from
   the keeper's address, never reaches them at all. Tests in Task 3 (`believes the via header from the keeper alone`),
   Task 5 (`names the peer to the app by its certificate`) and Task 6 (`keeps the network routes from the keeper's
   other doors`).
4. The keeper started again with its volume kept: the same key and certificate, until it is older than 7 days; with the
   volume lost: a new key and a certificate for it, and the old serial still valid until it expires; with the
   database restored to before this build: a new certificate before the port opens (Task 6, `takes a new certificate
   when the database does not know its own`). Tests in Task 4
   (`makes the machine's key once and keeps it`, `asks for a certificate when it holds none, and keeps it`, `renews a
   certificate older than 7 days`) and Task 3 (`gives its own machine a data certificate`).
5. The Update from plan 4's build, the keeper starting on the old schema before `migrate`, and the way back: the
   company keeps leading alone, and no read of a new table stops the keeper. Tests in Task 6 (`leads alone on the
   schema before this plan`) and Task 7's rehearsal.

---


# The task

### Task 2: The authority and machine certificates

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/authority.test.ts` passes; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/network/authority.ts`
- Test: `apps/server/test/authority.test.ts` (new)

**Interfaces:**
- Consumes: `@peculiar/x509` as plan 1b set it up (`modules/tls/x509.ts` sets the crypto provider; import it first).
- Produces:
  ```ts
  // modules/network/authority.ts
  export const AUTHORITY_YEARS = 20;
  export const CERT_DAYS = 30;
  export const RENEW_AFTER_DAYS = 7;
  export const SKEW_MS = 5 * 60_000;            // notBefore is this much before now
  export type Authority = { certPem: string; keyPem: string };   // keyPem: Ed25519, PKCS#8
  export function makeAuthority(companyId: string, now?: Date): Promise<Authority>;
  //   subject and issuer CN=Hornhoof company <companyId>; basicConstraints CA, path length 0, critical; keyUsage
  //   keyCertSign and cRLSign, critical; subjectKeyIdentifier; notBefore now - SKEW_MS, notAfter + AUTHORITY_YEARS years
  export type Issued = { certPem: string; serial: string; until: Date };
  export function issueCertificate(authority: Authority, req: { machineId: string; role: MachineRole; signKey: string; now?: Date }): Promise<Issued>;
  //   signKey: the machine's Ed25519 public key, SPKI PEM (refused with 'Not an Ed25519 public key.' otherwise).
  //   subject CN=<machineId>; SAN URI urn:hornhoof:machine:<machineId> and urn:hornhoof:role:<role>; basicConstraints
  //   not a CA, critical; keyUsage digitalSignature, critical; extKeyUsage serverAuth and clientAuth;
  //   authorityKeyIdentifier; notBefore now - SKEW_MS, notAfter now + CERT_DAYS days; serial 16 random bytes whose
  //   first byte is in 0x10..0x7f, so it is 32 hex digits with no sign byte; serial lowercase
  export type CertFacts = { machineId: string; role: MachineRole; serial: string; notBefore: Date; notAfter: Date; signKey: string };
  export function certFacts(certPem: string): CertFacts;
  //   read with Node's X509Certificate; serial lowercase; signKey the SPKI PEM of its public key; throws 'This
  //   certificate names no machine of a company.' when either URI is missing or the machine is not a uuid
  export function issuedBy(authorityPem: string, certPem: string): boolean;
  //   Node's X509Certificate: checkIssued and verify(authority's public key); dates are not looked at
  export function needsRenewal(facts: CertFacts, now: Date): boolean;   // now - (notBefore + SKEW_MS) > RENEW_AFTER_DAYS days
  export function makeCrl(authority: Authority, serials: string[], now?: Date): Promise<string>;
  //   PEM, by X509CrlGenerator; issuer the authority's subject; thisUpdate now - 1 day, nextUpdate now + 365 days; one
  //   entry per serial with the reason X509CrlReason.cessationOfOperation, so no entry has an empty extension list;
  //   signed with Ed25519
  ```

- [ ] **Step 1: Write failing tests** in `authority.test.ts`, with keys made by `generateKeyPairSync('ed25519')`:
  - `makes an authority that signs only certificates`: its certificate is self-issued (`checkIssued` of itself), a
    CA (`ca` true in `X509Certificate`), valid 20 years from 5 minutes ago, and its key verifies its signature.
  - `issues a machine certificate for a key and a role`: `certFacts` of it gives the machine id, `worker`, a serial of
    32 lowercase hex digits, `notAfter` 30 days from now and `notBefore` 5 minutes ago, and the same SPKI PEM;
    `issuedBy` is true; two certificates get two serials.
  - `tells a certificate of another authority`: `issuedBy` of a second authority's certificate is false.
  - `refuses a key that is not Ed25519`: an EC P-256 public key throws.
  - `carries mutual TLS 1.3 between two machines`: an `http2.createSecureServer` with one machine's key and certificate,
    `ca` the authority, `requestCert: true`, `rejectUnauthorized: true`, and a client `http2.connect` with the other's:
    a request answers, and the server sees the client's `urn:hornhoof:machine:` in `subjectaltname`; a client with a
    certificate of another authority gets no answer.
  - `refuses an expired certificate at the handshake`: a client certificate issued with `now` 31 days ago, against
    the server of the mutual TLS case: the server emits `tlsClientError` and never `secureConnection`, the client
    gets no answer, and `issuedBy` is still true (dates are not looked at).
  - `refuses a revoked certificate at the handshake by its CRL`: that server with `crl: await makeCrl(authority,
    [serial of B])`: client B is refused as above and client C answers; with `makeCrl(authority, [])` B answers too;
    the CRL read back by `X509Crl` names B's serial with the reason `cessationOfOperation`. When OpenSSL does not take
    a CRL that `@peculiar/x509` 1.14.3 makes, the agent stops and reports.
  - `asks for renewal after 7 days`: `needsRenewal` false at 6 days 23 hours after issue, true at 7 days 1 hour.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `authority.ts`. When `@peculiar/x509` 1.14.3 cannot sign with Ed25519 on Node 22's
  webcrypto, the agent stops and reports.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Make a certificate authority per company and Ed25519 certificates for its machines".

