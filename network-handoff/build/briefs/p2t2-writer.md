You are the writer for Task 2 of 2026-11-03-network-phase-1-plan-2-keeper-and-front in Hornhoof's network build. Read everything below before you start.

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
- Never commit, never `git add`, never push: the build lead commits after review. No new remote, no branch on GitHub.
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

- You write the code and tests for the ONE task below, test first: write the failing tests, run them and see them
  fail, then the code, then run the task's **Done when** and read its output.
- NEVER commit. Where the task says "Commit", stop at that point's tests passing and go on with the next step instead.
- Change only the task's files. No `npm install`/`npm ci` unless the task names a dependency to add. Never run prettier
  or any formatter. You do not dispatch subagents.
- Shell is bash on Debian Linux, x86_64, GNU tools.
- Python for the relay: standard library only, runnable on Python 3.12 (the droplet's). Run the relay tests with both
  `/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12` and
  `/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`. There is no pytest.
- Stop and report (do not guess) when a fact the task rests on proves wrong in the code, or a test of an earlier task
  fails and you cannot find why.
- At the end, write your report to the report file named in your notes: the skills and rule files you read, files changed, test commands run and their
  results, how each new test failed before the code, the gate numbers, anything you could not do, and every place you
  deviated from the plan, with why. Say only what you observed. Reply to the lead with the status (DONE,
  DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT) and at most five lines.

# How this build works now: lanes, skills and rules

You work in your own lane, your own clone of the repository, at the path in the notes below. Other writers work beside you in
theirs. Work only in your lane: do not touch the real repositories (`/home/altera/hornhoof-network/hornhoof`,
`/home/altera/hornhoof-network/hornhoof-edge`) or another lane. The lead reviews your lane's change and lands it; you never stage or
commit, and you do not rebase. The tag `lanebase` marks where your lane started, and your lane may be moved forward by the lead
(`lane.sh refresh`) when earlier work lands: conflict markers then are yours to settle.

**Rules that bind you, and they are not optional, Ivan's word:** `/home/altera/hornhoof-network/CLAUDE.md` and the build rulings below.
Before you write a line, read these skills and follow them, and name them in your report, or the lead sends the task back:
`test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion` before you claim anything, in
`/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`. For Hornhoof also `hornhoof/AGENTS.md` and
`hornhoof/templates/skills/dev-engineering-rules.md`. Uncle Bob's gates crapper (under 10) and dryer (no pair at 0.8) apply to every line you change.
**You do not run mutator** (Ivan's word): it runs once per plan, at the plan's review, on all its tasks' changes, and its survivors come back to you as findings.

**Test runs:** a few tests at a time locally with `/home/altera/hornhoof-network/network-build/light.sh <command>`, from your lane. Full suites,
coverage and mutator go to the test machine, never locally: `REMOTE_EDGE_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run <label> '<command>'`
(`REMOTE_HORNHOOF_TREE=<your lane>` for a Hornhoof lane). It runs in a snapshot of your lane at the usual absolute paths, so inside
it the repository is `/home/altera/hornhoof-network/hornhoof-edge` or `.../hornhoof`, whichever your lane is. Your own gates' results come back to your lane. If `remote.sh` does not exist yet, it is being built: write
your code and focused tests, and check for it before your gates; wait for it rather than run a heavy thing locally.
Gates, inside `remote.sh run`, with `lanebase` as the base:
- relay: `/home/altera/hornhoof-network/network-build/gates-relay.sh lanebase`.
- Hornhoof: `/home/altera/hornhoof-network/network-build/gates-hornhoof.sh lanebase server '<test files>'`.
**You do not run a repository's whole suite.** It takes about 30 minutes in a queue of three slots, so the lead runs it once, when your lane lands. You run your task's own test files and those that touch what you changed, tsc, `npm run typecheck:tests` and `npm run lint`, and the gates above. A task's Done when that names the whole suite means the lead's run.
Start a run in the background if you like, and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <label>` in the foreground, calling it again while it says WAITING. Never end your turn while a run of yours is pending.

# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p2t2`, Hornhoof, on branch network's work so far: plan 1's fake relay and client, maybe still landing.
- Read your rows in `/home/altera/hornhoof-network/network-build/parallel-map.md`: sections 1 (what you touch and what collides), 3 (the seams the lead checks at landing), 4 (where the plan has drifted from the code) and 5 (rulings, all taken). Build ruling 5: migration numbers are the plan's plus 11.
- Plans were read at an older main; check each file and line named against the code before you rely on it. A fact that proved wrong goes in your report.
- This task changes how every company updates: a mistake here strands an install. Its tests use a stub docker: real Docker is never reachable in your runs, and must stay so. Plan steps for a rehearsal, a push or an Update are not for this build.
- Report: `/home/altera/hornhoof-network/network-build/runs/p2t2-report.md`.
- Ruling 3 of the map, taken: `migrateDb` keeps `applyMissingMigrations` after drizzle's migrate: the app's start ran it and `migrate` takes that job, or a database short of a merged migration stays short.
- 1b T4's lane adds lines to `package.json` and `package-lock.json`, which may touch yours softly: keep your edit there small.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 2: Keeper and Front on One Machine, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every install runs two new containers from the app image: `front`, which serves the company's web port and
passes every request and socket on, and `keeper`, which sets the app's mode, runs the public link's frpc as its child
with the network's client id and transport, ends the link's TLS, and passes what comes in to the app. The `tunnel`
container goes, `db` starts with the settings logical copies need, migrations run once in a `migrate` container
before the app starts, and the app answers in `lead`, `read`, `maintenance` or `off`. A host-wide port registry gives
each company its web and peer ports. One Update moves today's installs in, and back if the new build fails.

**Architecture:** Three new entry points in `apps/server/src`, built by the same `tsc` into `dist/`: `front.ts`,
`keeper.ts` and `migrate.ts`. A small pass-through on `node:http` (`net/proxy.ts`) carries requests, streams and
WebSockets for both `front` and the keeper. The keeper (`modules/keeper/`) reads the link and its certificate from the
database every 3 s, feeds plan 1b's TLS listener and today's `TunnelKeeper` (now fed by a function, not a file),
derives maintenance from the updater's `status.json`, and gives the app its word in `keeper.json` in the control
folder every second. The app's `AppMode` reads that file, starts and stops the work only a leader does, and an
`onRequest` gate refuses what the mode does not allow. The updater (revision 2) stops the app for the database copy,
removes the services a build does not name before it installs that build, limits how long an install may take, and
checks health where that build answers. `install.sh` gets the start order, the machine id, the port registry, and
hands an update to the new build's updater when an older one runs it.

**Tech Stack:** TypeScript on Node 22 (`node:http`, `node:net`, `node:tls`), Fastify 5 with `@fastify/websocket`,
drizzle on node-postgres, vitest with PGlite, `ws` in tests; bash (macOS 3.2 for the tests, Alpine in the updater) for
`install.sh` and `updater.sh` with their stub tests; Docker Compose v2 (`depends_on` with
`service_completed_successfully`, `up --wait`); frpc 0.71.1; Postgres 17.11.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.1 (what runs where), 3.9 "Modes", 3.10 (the link ends at
the keeper), section 6 (ports and several companies per machine) and section 9 ("Move in by Update", "The maintenance
state"). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 2's entry. Plan 1
`notes/plans/2026-11-03-network-phase-1-plan-1-relay-contract.md` and plan 1b
`notes/plans/2026-11-03-network-phase-1-plan-1b-company-certificate.md` (see "Handed over by plans 1 and 1b").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in a new worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/keeper-and-front` on a new branch `keeper-and-front` from main
(`git worktree add`, then `npm ci` there once), after plan 1b is merged into main.

**Handed over by plans 1 and 1b** (merged, and plan 1 deployed, before this plan starts):
- Plan 1, on hornhoof.org: an frpc may log in with `clientID = "<link>-<machine8>-link"` and the same value in
  `metadatas.client` (R1), with `transport.heartbeatInterval = -1`, `transport.tcpMuxKeepaliveInterval = 10` and no
  `heartbeatTimeout` (R3). A name with a live route refuses a second registration, and frpc sends a refused proxy again
  every 30 s (`client/proxy/proxy_wrapper.go:50`), so an frpc started again may wait up to about 40 s for its route.
- Plan 1b, in `apps/server/src/modules/tls/`: `listener.ts` with `LINK_TLS_PORT = 8443`, `linkVisitor(socket)` and
  `class LinkListener { constructor({ app, config, log }); listen(port, host?); use(host, cert); close(graceMs?) }`;
  `proxy-header.ts` with `readProxyV2`; `x509.ts` with `certInfo` and `selfSigned`; `store.ts` with `tlsOf(db,
  companyId)` and `linkMode(db, config): Promise<'http' | 'https'>`; `manager.ts` with `LinkTls` (`serveOn(listener:
  Served)`, `start()`, `stop()`, `kick()`) and `type Served = { use(host: string | null, cert: { certPem: string;
  keyPem: string } | null): Promise<void> }`, started by `main.ts` alone. `config.acmeDirectory` from `ACME_DIRECTORY`.
- Plan 1b, elsewhere: `modules/link/tunnel.ts` `Settings` with `mode`; `modules/link/client.ts` `configFor` with the
  `https` proxy block (`localIP = "app"`, `localPort = 8443`, `transport.proxyProtocolVersion = "v2"`);
  `modules/link/link.ts` `writeTunnelSettings` writing `mode`, and `PublicLinks.sync(): Promise<boolean>`;
  `auth/tunnel.ts` `overLink(req, config)`, with `cameOverHttps` and `clientAddress` taking `linkVisitor` first;
  `req.overLink`; `GET /api/health` answers `{ ok: true }` over the link; `test/helpers.ts` with `TUNNEL =
  '192.0.2.10'` and `viaLink(token?)`, and `testApp` defaulting to `ACME_DIRECTORY: 'off'`.
- Where main's code differs from these names, the agent stops and reports.

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


# Quality rules (from the team lead, 2026-11-03)

These come after the plan's Global Constraints. Where they disagree, the plan's Global Constraints and the build rulings win: no prettier and no formatter (black, isort, ruff format are not run), the plan's file layout, the plan's names, the plan's test framework.
"Commit and Push" and "Push your branch" below do not apply to you: the build lead commits, nobody pushes. The gates crapper and dryer run on every task, on the changed code, through the commands in the task notes. Mutator runs once per plan, at its review, by the lead: writers do not run it (Ivan's word).
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

- **One Update moves an install, whatever updater runs it.** The move-in is driven by the updater already running, and
  its way back runs the old installer, whose `compose up` cannot start `app` while `front` still holds the web port:
  today `drop_orphans` runs only after an install that worked (`updater.sh:284-300`). So this build's updater (revision
  2) removes the containers of the services a build's compose file does not name before it runs that build's
  installer, and checks health at `front` when that build has one. This build's installer, run by an updater that does
  not say `HORNHOOF_UPDATER_REV=2`, changes nothing yet but `.env` and `compose.yaml`, which the old installer writes
  back on the way back, then starts a helper container of its own build's updater image (`updater.sh --take-over`).
  The helper starts this build's `updater` service, as `swap_updater` does (`updater.sh:318-324`), which stops the old
  updater; the new one finds the update in its note and goes on with it (`interrupted`, `updater.sh:450-474`, the path
  an updater restarted during an update takes today). Compose removes the old updater before it starts the new one,
  so the helper waits for the new one's word in `status.json`; without it, it marks the update `rollback` and starts
  the old updater image again, which goes back by itself. One release, one Update, also for an install that skipped
  builds, and a failed move-in goes back under the new updater. After a move-in that went back, the new updater stays
  and runs the next Update, since the old installer leaves the updater container as it is.
- **The database copy is taken with the app stopped.** Today the copy is taken while the old app works on, and the
  handover makes that window longer. Revision 2 stops `app` right before the dump, so every change the app confirmed is
  in the copy; `front` and the keeper answer maintenance meanwhile, and the app is stopped through the install anyway.
  An update an older updater began is copied again once the new updater takes over. A failed dump starts the app
  again. Each install also has a time limit, 15 minutes, after which the updater stops `migrate` and `app` and goes
  back, so a migration or a database start that hangs never keeps the company in maintenance.
- **Migrations run in a one-shot `migrate` service** that `app` waits for (`depends_on: migrate: condition:
  service_completed_successfully`), so every `compose up` that starts the app migrates first, as the owner, with
  application name `hornhoof-migrate` and no timeouts. The installer stops `app` before it, so the old build never runs
  on a schema it does not know, and starts `front` and the keeper before it, so the maintenance answer is up while it
  runs. Spec section 9 says the updater runs `migrate`; here the updater runs the build's installer, which runs it.
- **The maintenance state comes from the updater's own status file.** On one machine there is no copy to promise
  anything to, so the keeper derives it: `status.json` says `running` with step `backup`, `install`, `health` or
  `rollback`. Step `pull` is not maintenance, since the old build works on while images download (`updater.sh:371-372`).
  The file outlives every container, so a restart of the keeper, the app or the updater keeps the state, and it ends
  only when the updater records success, failure or a finished rollback, as spec section 9 asks. A status file the
  keeper cannot read or parse changes nothing; a missing one means no update runs, since nothing but a person removes
  it. The keeper writing the state into its control folder and `net_local.maintenance` comes with the plans that have
  `net_local` and copies (3 and 9).
- **The app takes its mode from `keeper.json`** in the control folder, which the keeper writes every second: no port
  and no token, since the node, where agents run, does not mount the folder. Before the first fresh word the app is
  `off`. A word older than 10 s changes nothing: the app keeps the mode it has, so a keeper restart does not stop work;
  plan 3, where commits need the keeper's lease, decides what a long-gone keeper means. An app with `HORNHOOF_KEEPER`
  unset (tests, `npm run dev`, a compose file of an older build) leads as today.
- **`maintenance` is `read` with its own reason** (spec 3.9): reads are served, so the Update panel shows its steps
  while the app is up; changes, sockets and lead work are not. While the app is down (migrations, restarts), the keeper
  answers `/api/*` with the same maintenance reason, which the Update panel shows as maintenance.
- **Read mode here is the spec's, less three parts left to the plans that need them:** every `/mcp` call is refused
  (a POST, so no read tools yet); a new sign-in is refused (the short-lived signed cookie and the recovery API belong
  to plans 9 and 10); nodes are refused, not let in for status (plan 4 gives them outboxes that keep their messages).
  On one machine the keeper never asks for `read` in this plan; plan 3 does. Leaving `lead` closes every open
  WebSocket, so a node or a terminal already connected sends nothing more until the app leads again; node messages
  still queued then are dropped, and a session is handed over to the link's cookie only in `lead`. A change admitted
  while leading ends as it would: in this plan the app leaves `lead` only for an update, which stops it before the
  copy. Plan 3, which asks for `read` while the app runs on, drains those changes.
- **Ports inside the containers.** `front` listens on 8080 and publishes `HORNHOOF_PORT`. The keeper listens on 7080
  for `front` (default network), on `127.0.0.1:7081` for the link's `http` mode and on `127.0.0.1:8443` for its
  `https` mode, both reached only by its own frpc child. 7070 is the peer link's (spec section 6, "keeper 7070"),
  published as `HORNHOOF_PEER_PORT` with nothing listening until the peer link's plan, so the port is held from now on.
- **Who believes which header.** `front` replaces `x-forwarded-for` with the socket's address and drops
  `x-forwarded-proto` and every `x-hornhoof-*` header. The keeper drops the same, and sends the app exactly one
  `x-forwarded-for`: on 7080 the one `front` wrote, only when the socket is `front`'s address (looked up by name each
  time, as `fromTunnel` does), else the socket's; in `http` mode the first entry of what frps wrote; in `https` mode
  the PROXY header's source. It adds `x-forwarded-proto: https` for link traffic only. The app keeps `TUNNEL_HOST`
  (no rename, so the tests keep their names), now `keeper` in compose, so `cameOverHttps`, `overLink` and
  `clientAddress` work unchanged, and 1b's `linkVisitor` leaves the app. `x-forwarded-host` passes untouched, since
  `origin.ts` reads it for an owner's own proxy in front of localhost.
- **The keeper reads the link from the database**, as spec 3.10 says a standby will: `public_links` for name, key and
  tunnel, `link_tls` for the certificate, and 1b's `linkMode` for the mode, every 3 s, through its own pool
  (application name `hornhoof-keeper`, `statement_timeout` 2 s). A failed read keeps the frpc and the certificate it
  has. The app still writes `tunnel.json`: the updater keeps a copy of it with each backup (`updater.sh:227-236`) and
  the installer reads the link's address from it (`install.sh:715-722`). `LinkTls` stays in the app, since only a
  leader orders certificates; its `Served` becomes the keeper's word in `keeper.json` that it serves that certificate.
  The keeper starts frpc again only when the settings change, since each start may cost the link up to 40 s.
- **The machine id is `HORNHOOF_MACHINE_ID` in `.env`**, which `install.sh` writes once and never changes: run by hand,
  the machine's host id (`host_id`, the hash the server already knows the machine by, so the machine's own key never
  leaves it); from the updater, whose container cannot read that key, 32 random hex digits. machine8 is its first 8
  characters. The plans that give machines certificates take this value.
- **The port registry** is a text file `registry` in the Docker volume `hornhoof-ports`, read and written through a
  short container of the app image, run by hand and from the updater alike, so no compose file mounts it yet and none
  declares it `external`; the updater's mount (spec section 6) comes with the first updater job that needs it. One
  line per company folder: `<folder> <web port> <peer port>`. Nothing removes a line, since there is no server
  uninstall today.
- **Folders stay as today**: `~/hornhoof`, and `~/hornhoof-<name>` with `--name`. `~/hornhoof-<company>` for a
  joined machine comes with joining (plan 5).
- **`front` holds nothing yet.** It answers 502 with `Retry-After: 5` while the keeper does not answer; holding
  requests up to 60 s is plan 4's.
- **Every hop opens a new connection per request** (no keep-alive pool), so a connection the next hop closed while
  idle never takes a request. Inside a compose network that costs nothing that shows.

## Review Focus

1. A move-in whose new build never answers, whose installer fails or hangs, or whose handover fails, run by the old
   updater or the new one: the install is back in today's shape, `app` on the web port answering with the old commit
   and `tunnel` carrying the link, with no `front`, `keeper` or `migrate` container left, and nothing the old app
   confirmed lost. Tests in Task 1 (`moves in by handing over, and goes back to the old build when the new one fails`,
   `stays on the old build, working, when the new installer cannot start the hand-over helper`, `brings the older
   updater back to go back when this build's updater does not start`, `stops an installer that does not end, and goes
   back`) and Task 8 (`hands an update to this build's updater when an older updater runs it`, `stops when the
   hand-over helper does not start`).
2. Four companies installed on one computer, one of them stopped and pruned between installs: each keeps its own web
   and peer ports, and no port is handed out twice. Tests in Task 9.
3. A terminal WebSocket and an event stream through `front` and the keeper that stay quiet a while, and a large
   upload: nothing buffers or cuts them, and closing either end closes the other. Tests in Task 4.
4. A request to localhost, or from the built-in node straight to the keeper or the app, with a forged
   `x-forwarded-for` or `x-forwarded-proto: https`: the app sees the true address and does not take it as over the
   link. Tests in Tasks 4 and 5.
5. The keeper restarting while the app leads: the app stays in `lead`, and the link comes back under the same client
   id. Tests in Tasks 3 and 6.

---


# The task

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

