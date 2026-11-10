You are the writer for Task 6 of 2026-11-03-network-phase-1-plan-1b-company-certificate in Hornhoof's network build. Read everything below before you start.

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
**You do not run mutator** (Ivan's word): it runs once, at the end of phase 1, on the riskiest code only.

**How to write tests (Ivan's word).** Uncle Bob's way, without chasing coverage. Put a task's logic in a pure function, tested directly, with no database and no process. Add one or two integration tests per route or per seam, for what only they can show, not one per branch. A test checks what a person of the code would see; if it would still pass with the code wrong, throw it out. Do not add a test only to cover a line or to raise a number. To get a function under CRAP 10, split it first. Do not rewrite or speed up old tests; run only those your change reaches.

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

- Your lane: `/home/altera/hornhoof-network/wt/p1bt6`, Hornhoof, on branch network's commits so far (plan 1's fake relay and client, 1b T1, 1b T4, 2 T4).
- Read your rows in `/home/altera/hornhoof-network/network-build/parallel-map.md`: sections 1, 2, 3 (the seams the lead checks at landing), 4 (drift) and 5 (rulings, all taken). Build ruling 5: migration numbers are the plan's plus 11.
- Plans were read at an older main; check each file and line named against the code before you rely on it. A fact that proved wrong goes in your report.
- Report: `/home/altera/hornhoof-network/network-build/runs/p1bt6-report.md`.
- Docker runs on the test machine, walled off from everything else: `REMOTE_HORNHOOF_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run --dind <label> '<command>'`. The plan's Pebble tests and `npm run test:real` run there, and each real run goes in your report for the ledger. Add a `test:real` command as the plan says. Never point anything at real Let's Encrypt.
- `selfSigned` and `certInfo` are in `apps/server/src/modules/tls/x509.ts`, committed: read them. PEM text ends with a newline. A certificate's SAN names keep their case; compare names lowercased.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 1b: The Company's Own Certificate, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The https of a company's hornhoof.org link ends at the company's own machine. The app gets and renews a
Let's Encrypt certificate for its link name through the tunnel, serves it on a TLS port that the link's frpc reaches
with the visitor's address in a PROXY v2 header, and moves the tunnel to `https` once the relay passes TLS through.
Every link name now shows in public certificate logs, so nothing before sign-in tells who the company is, search
engines are told to stay away, sign-in limits count per address and outlive a restart, and the session cookie on the
link is `__Host-` prefixed.

**Architecture:** A new module `apps/server/src/modules/tls/` holds: the stand-in certificate and the reading of a
certificate (`x509.ts`, on `@peculiar/x509`); a thin wrapper that drives `acme-client` for the ACME core, the
account, the order, HTTP-01 and finalize (`acme.ts`); renewal information as a small module of its own on top
(`ari.ts`: the certificate id from the authority key identifier and the serial, and one unauthenticated GET); the
HTTP-01 answers (`challenges.ts`); the TLS listener on port 8443 inside the container (`proxy-header.ts`,
`listener.ts`); the database row (`store.ts`); the check it makes through the link after a switch (`checks.ts`); and
`LinkTls` (`manager.ts`), which decides when to order, renew and back off and which mode the tunnel runs in. The
listener hands each decrypted connection to Fastify's own http server, so every route, hook and WebSocket works on
it unchanged. The tunnel container keeps reading `tunnel.json`; only the frpc config it writes for `https` mode is
new. Port 8080 keeps answering localhost, the updater, the node container and every link still in `http` mode, as
today.

**Tech Stack:** TypeScript on Node 22 (`node:tls`, `node:net`, `node:https`, fetch), `acme-client` 5.4.0,
`@peculiar/x509` 1.14.3, Fastify 5, drizzle with PGlite tests, vitest, React for the web; Pebble 2.10.1 (Let's
Encrypt's test CA) in Docker for `npm run test:real`; frpc 0.71.1 with an `https` proxy.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.10 (TLS on the link ends at the company's machine; the
certificate and its key live in the database, the key under `HORNHOOF_SECRET` as the link key is). Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`: plan 1b, "Our own TLS on the public link" (HTTP-01 through the
tunnel, Let's Encrypt's limits, "A known consequence: names become public" and its mitigations), decision 2
(`test:real`), discrepancy 23 (`SECURITY.md:53`). Plan 1
`notes/plans/2026-11-03-network-phase-1-plan-1-relay-contract.md` (see "Handed over by plan 1"). RFC 8555 (ACME), RFC
9773 (ARI), RFC 5280 (certificates), the PROXY protocol v2 (haproxy `proxy-protocol.txt`, section 2.2). `acme-client`
5.4.0's source (`github.com/publishlab/node-acme-client`, tag `v5.4.0`), which the paths under "Open points" refer to.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/home/altera/hornhoof-network/hornhoof`, in a new worktree
`/home/altera/hornhoof-network/hornhoof/.claude/worktrees/company-certificate` on a new branch `company-certificate`
from main (`git worktree add`, then `npm ci` there once), after plan 1 is merged into main.

**Handed over by plan 1** (written, and merged before this plan starts):
- `Relay.health(timeoutMs?: number): Promise<{ up: boolean; relayStarted: number | null; passthrough: boolean }>` in
  `apps/server/src/modules/link/relay.ts`, which never throws (plan 1 Task 12).
- `FakeRelay` in `apps/server/test/fake-relay.ts` with `passthrough: boolean`, `frpsDown: boolean` and the old `down`
  (plan 1 Task 11).
- On the relay: port 80 redirects `http://<name>.hornhoof.org/<path>` to https with the path kept (plan 1 Task 8 pins
  `/.well-known/acme-challenge/t`); frps on 443 passes a name's TLS connections unread to its `https` proxy (R7.1),
  whose frpc sends the visitor's address in a PROXY v2 header (R7.3); health says `passthrough: true` (R4.1); a
  session with no client id (`legacy`, today's tunnels) may register the `http` or the `https` proxy named after the
  binding, with `subdomain` equal to the name (plan 1 Task 9). This plan keeps the link's frpc on today's login with
  no client id; plan 2 gives it one.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests make their keys and certificates at run time, and
  `test:real` copies Pebble's test CA out of its container at run time; none is committed.
- Two new runtime dependencies of `@hornhoof/server`, at exact versions: `acme-client` 5.4.0 for the ACME core (JWS,
  account key use, nonces, the order and challenge flow, finalize, the CSR) and `@peculiar/x509` 1.14.3, already in
  acme-client's tree, for the stand-in and for reading certificates. No other new dependency, and no hand-written
  JWS, nonce or order code. ARI is this plan's own code (`ari.ts`), since acme-client has none.
- Migrations only by `npx drizzle-kit generate --name <name>` from `apps/server`; never edit an existing migration.
  Task 1 adds one, Task 3 the next and Task 7 the last, in that order, so those tasks never run side by side.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from the worktree root:
  `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; types: `npx tsc -p apps/server/tsconfig.json
  --noEmit` and, for web tasks, `npx tsc -p apps/web/tsconfig.json --noEmit`, both printing nothing. From Task 6 on,
  `npm run test:real` from the worktree root needs Docker and runs Pebble. Never run prettier.
- A private key (the account's or a certificate's) is stored only as `encryptSecret(pem, config.secret)`, and never
  goes into a log line, an API answer, an error message or `tunnel.json`. The tunnel container never holds a
  certificate key.
- Fail toward a working link: anything unknown about the relay keeps the tunnel's current mode; anything unknown or
  missing about the certificate means `http`.
- A one-machine install answers on localhost as today: port 8080, the full `/api/health`, the `hh_session` cookie.
  The updater's health check (`http://app:8080/api/health`) and the node container (`http://app:8080`) see no change.
- Let's Encrypt's limits (overview): after a failed validation the machine waits at least an hour before it orders
  for that name again; the app checks its own challenge answer through the link before it asks the CA to validate;
  renewals carry ARI's `replaces`.


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

- **acme-client does the ACME core; ARI sits on top** (the team lead's ruling). `acme.ts` calls acme-client's own
  steps, not its `auto()`, because `auto()` has no way to pass `replaces`: `createAccount`, `createOrder`,
  `getAuthorizations`, `getChallengeKeyAuthorization`, `verifyChallenge`, `completeChallenge`,
  `waitForValidStatus`, `finalizeOrder`, `getCertificate`, and `crypto.createPrivateEcdsaKey` and
  `crypto.createCsr` for the keys and the CSR. `ari.ts` builds RFC 9773's certificate id from the certificate's
  authority key identifier and serial (read with `@peculiar/x509`; Node's `X509Certificate` gives no authority key
  identifier), reads `renewalInfo` from the directory with a plain GET, and asks it with one unauthenticated GET. A CA
  without `renewalInfo` gets renewal at two thirds of the lifetime. TLS-ALPN-01, the overview's fallback, is not built:
  acme-client's `crypto.createAlpnCertificate` makes it a small change once the redirect path ever fails.
- **The app checks its own answer first**, with acme-client's `verifyChallenge`: it asks
  `http://<host>/.well-known/acme-challenge/<token>` on port 80 and follows the redirect to https without checking the
  certificate, the same path Let's Encrypt takes (`src/verify.js`). Only then is the challenge completed. A failed
  self-check costs nothing at Let's Encrypt and is tried again in 5 minutes; a failed order waits an hour, or longer
  when the CA's Retry-After says so. A new company's tunnel needs a few seconds to come up, and without the self-check
  its first order would burn a failed validation and an hour.
- **The tunnel's mode** is kept in the database (`link_tls.mode`), so a restart writes the same `tunnel.json` and the
  link does not blink. It is `https` only while all hold: the row's certificate is for the link's current name, it has
  more than 24 hours left, and the relay's latest health answer said `up` and `passthrough`. A health answer with `up`
  and not `passthrough` means `http`; no answer, or `up: false`, keeps the mode. Before a switch to `https` the manager
  asks health once more. After it, the manager probes `<link url>/api/health` over https with the certificate checked,
  every 3 s for up to 60 s; unless the answer is 200 from its own certificate, it goes back to `http` and tries `https`
  again no sooner than an hour later. The listener holds the certificate before the tunnel is switched; each probe try
  opens a new connection, and the probe gives up after 60 s in all; an app that starts in `https` probes once more; the
  hour's block is kept in the database, so a restart does not lift it. The overview names only the switch back on
  `passthrough`; the probe covers a relay that says `passthrough` but does not carry the name, which would otherwise
  take the link down.
- **The listener** listens on port 8443 inside the app container, which compose does not publish; the tunnel
  container reaches it as `app:8443` on the default network. Every connection must open with a PROXY v2 header within
  5 s, or it is closed. The header's source address is believed only when the connection comes from the tunnel
  container (the same rule as X-Forwarded-For today); otherwise the visitor is the socket's own address. Every request
  on 8443 counts as over the link. ALPN offers `http/1.1` only. The stand-in is a self-signed certificate for the
  link's host name (or `hornhoof.invalid` while there is none), made in memory and never stored.
- **"Over the link"** means the request came over https through the tunnel container (today's `cameOverHttps`) or
  through the listener. It is worked out once per request into `req.overLink`.
- **Over the link the session is `__Host-hh_session`; an older `hh_session` is moved to it once** (the team lead's
  ruling: nobody signs in again). A `hh_session` cookie there could have been set by a page on another company's
  name, since every name shares the site hornhoof.org, so over the link it is read only for that move, and only for a
  session made before the Update: the migration marks the sessions it finds (`before_host_cookie`), and every newer
  session is made unmarked. The move gives the person a new session with a new id under `__Host-hh_session`, clears
  `hh_session`, and lets the old session live one more minute for requests already on their way. Localhost keeps
  `hh_session` as today.
- **Sign-in counts in the database.** Each try is written before the password is checked, in one statement that
  writes it only while the address and the email are under their limits, so a burst counts; it is deleted when the
  sign-in works. So failures count and successes do not, which is what `SECURITY.md` already promises ("Failed
  sign-ins are capped"); today's in-memory limiter counts every try. Limits: 10 per email and address in 15 minutes,
  50 per email in an hour (both as today), and 30 per address in an hour across all emails (new). An IPv6 address
  counts by its /64. The table keeps SHA-256 hashes of the email and the address, never the text, and loses rows older
  than an hour at every try. The invite limit stays in memory: invite tokens cannot be guessed.
- **One Let's Encrypt account per company, with no contact email.** Its first order accepts Let's Encrypt's
  Subscriber Agreement for the company (`termsOfServiceAgreed: true`). The team lead ruled to show it: one line, with a
  link to the agreement, in setup next to the new link and in Settings beside where the link's encryption ends;
  `SECURITY.md` says it; and the Update that ships this plan says it in its title, since every existing company
  accepts on its first order after that Update.
- **Renewal.** The renewal time is a uniform random moment inside ARI's suggested window, drawn again only when the
  window moves away from it, and now when the window has passed. ARI is asked again after its Retry-After, held
  between 1 hour and 24 hours. Without ARI in the directory, renewal comes at two thirds of the lifetime. Every
  certificate gets a new key. No ACME profile is asked for.
- **`ACME_DIRECTORY`** picks the CA: unset or empty is Let's Encrypt's production directory, `off` turns certificates
  off and puts the tunnel on `http` whatever the stored mode says, anything else must be an https directory URL.
  Compose passes it to the app, so an operator can turn it off in `.env` and restart the app, which is the way back if
  the switch ever takes a link down; `SECURITY.md` and the README's Questions say so. Tests run with `off` unless
  they set it. Only `main.ts` starts the manager's timers.
- **The expiry warning lives in the Machines tab**, as the overview says, for people who see the whole company (the
  only ones `/api/link` answers); Settings shows where the link's encryption ends.
- **Setup waits for the certificate up to 90 s** before it shows the new link, then shows it anyway with a line that
  the connection is encrypted to hornhoof.org for now.
- **Challenge answers live in memory**, served on every port and transport. One app holds one company's link until
  plan 2.
- **Names are public from the first certificate** (overview, accepted by Ivan on 2026-11-02). The setup hint that a
  random name is "hard to guess" and the guide's lines that rest on it change: a random name no longer hides that a
  link exists, but it does not say whose company it is.
- **A random link name is the default**, as the overview's mitigation says ("Random names stay the default"). Today
  setup makes the link's name from the company's name as it is typed, and Share access suggests it too
  (`Setup.tsx:66-69`, `Settings.tsx:23`), so the first certificate would publish the company's name. Both start with a
  long random name instead; the person may still type any name.

## Open points: what acme-client does not do

Checked against acme-client 5.4.0's source. None needs a hand-written ACME client; each is for the team lead to
confirm or overrule.

1. **No problem type and no Retry-After in its errors.** A refused request becomes `new Error(<the problem's detail
   text>)` (`src/api.js:53`, `src/util.js:195-208`), so a rate limit cannot be told from a bad request, nor its
   Retry-After read. The plan reads both with one response handler on `acme.axios`, the axios instance acme-client
   exports for its settings (`src/index.js`, `src/axios.js`): it keeps the last ACME problem document it saw (its
   `type` and the `retry-after` header) in `acme.ts`, which turns each failed step into an `AcmeError`. Only one ACME
   flow runs at a time in the app (Task 8 runs one pass at a time), so the last problem is the failed step's. Without
   this, every failure waits one hour, as the overview's floor, and a rate limit is retried hourly.
2. **Its own 429 and 5xx retry sleeps the whole Retry-After inside the call** (`src/axios.js`, `retryMaxAttempts: 5`).
   A rate limit's Retry-After can be days, and the manager's one pass would hang that long. `acme.ts` sets
   `acme.axios.defaults.acmeSettings.retryMaxAttempts = 0` and `acme.axios.defaults.timeout = 15000` once, for the
   process, and leaves the waiting to the manager's backoff. badNonce answers are still retried by acme-client itself,
   up to 5 times (`src/http.js:27`, `:302`).
3. **No ARI.** acme-client 5.4.0 has no `renewalInfo` call. Its `createOrder(data)` sends `data` as it is
   (`src/api.js:147-148`), so `replaces` goes through untouched; `ari.ts` covers the rest.
4. **No release since 2024-07** (5.4.0), and it brings axios, node-forge, asn1js and debug. Task 10 runs `npm audit
   --omit=dev` and the team lead decides on anything it reports.

## Review Focus

1. A switch to `https` that the relay does not carry (the registration refused, or `passthrough` said while the name
   is not routed): the link is back in `http` mode within about two minutes and does not flap. Test in Task 8
   (`goes back to http when the switch does not serve the certificate`).
2. Renewal failing for days (Let's Encrypt down, the tunnel down): one try an hour at most, the old certificate served
   until a day before it ends, then `http`; the Machines tab warns from 14 days before. Tests in Tasks 8 and 9.
3. A rename or a removal while a certificate exists: the new name never runs `https` on the old name's certificate,
   and the old certificate leaves the listener. Tests in Task 8.
4. An app restart (every Update) in `https` mode: `tunnel.json` is written `https` from the database at once, before
   any health answer, so the link does not drop to `http` and back. Test in Task 8 (`keeps https across a restart`).
5. A burst of wrong sign-ins from one address (100 at once, each with another email): exactly 30 of them reach the
   password check, and the rest get 429. Test in Task 3.

---


# The task

### Task 6: ACME through acme-client, renewal information on top, tested against Pebble

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/challenges.test.ts test/ari.test.ts
test/acme-fake.test.ts` passes; from the worktree root `npm run test:real` passes with Docker running, and the output
of `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000` names no file under `test/real/`; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tls/challenges.ts`, `apps/server/src/modules/tls/acme.ts`,
  `apps/server/src/modules/tls/ari.ts`, `apps/server/test/real/run.sh`, `apps/server/vitest.real.config.ts`
- Modify: `apps/server/src/app.ts` (`ctx.challenges`, the route), `apps/server/vitest.config.ts` (exclude
  `test/real/**`), `apps/server/package.json` (`"test:real": "sh test/real/run.sh"`), `package.json`
  (`"test:real": "npm run build -w @hornhoof/protocol && npm run test:real -w @hornhoof/server"`),
  `.github/workflows/images.yml` (job `test-real`; `images` needs `[test, test-real]`), `CONTRIBUTING.md` (one line:
  `npm run test:real` needs Docker and runs the tests against Pebble)
- Test: `apps/server/test/challenges.test.ts`, `apps/server/test/ari.test.ts`, `apps/server/test/acme-fake.test.ts`,
  `apps/server/test/real/acme.test.ts`

**Interfaces:**
- Consumes: `selfSigned`, `certInfo` (Task 4); from `acme-client`: `Client`, `crypto.createPrivateEcdsaKey`,
  `crypto.createCsr`, `directory.letsencrypt.production`, `axios`; from `@peculiar/x509`: `X509Certificate`,
  `AuthorityKeyIdentifierExtension`.
- Produces:
  ```ts
  // challenges.ts
  export class Challenges { answer(token: string, keyAuthorization: string): void; forget(token: string): void; get(token: string): string | undefined }
  export function challengeRoutes(app: FastifyInstance, challenges: Challenges): void;
  // GET /.well-known/acme-challenge/:token, token /^[A-Za-z0-9_-]{1,128}$/: 200 text/plain with the key authorization, else 404
  // app.ts: Ctx gains challenges: Challenges
  // acme.ts
  export const LETS_ENCRYPT: string;  // acme.directory.letsencrypt.production
  export type ChallengeHooks = { answer(token: string, keyAuthorization: string): void; forget(token: string): void };
  export type AcmeErrorKind = 'not_ready' | 'refused' | 'invalid' | 'unreachable';
  export class AcmeError extends Error {
    constructor(kind: AcmeErrorKind, opts?: { type?: string | null; retryAfterS?: number | null; detail?: string });
    readonly kind: AcmeErrorKind;
    readonly type: string | null;          // the problem document's type, like urn:ietf:params:acme:error:rateLimited
    readonly retryAfterS: number | null;   // from Retry-After, in seconds
  }
  export function newAccountKey(): Promise<string>;  // a P-256 key, PKCS#8 PEM
  export type Backoff = { attempts: number; min: number; max: number };  // acme-client's backoffAttempts, backoffMin, backoffMax (ms)
  export class AcmeAccount {
    constructor(directoryUrl: string, accountKeyPem: string, accountUrl?: string | null, opts?: { backoff?: Backoff });
    account(): Promise<string>;  // the account URL: made with termsOfServiceAgreed and no contact, or found by its key
    issue(host: string, hooks: ChallengeHooks, opts?: { replaces?: string; selfCheck?: boolean }): Promise<{ certPem: string; keyPem: string }>;
    //   certPem: the chain; keyPem: the certificate's new P-256 key, PKCS#8; selfCheck defaults to true
  }
  // ari.ts
  export type RenewalWindow = { start: Date; end: Date; retryAfterS: number };
  export function certIdFrom(keyIdentifierHex: string, serialHex: string): string;  // RFC 9773 4.1
  export function certId(certPem: string): string | null;  // null when the certificate has no authority key identifier
  export function renewalInfo(directoryUrl: string, certPem: string): Promise<RenewalWindow | null>;  // null: no renewalInfo
  ```
- `acme.ts`, once at module load, on `acme.axios` (with one cast, since acme-client's types know no `acmeSettings`):
  `defaults.acmeSettings.retryMaxAttempts = 0`, `defaults.timeout = 15000`, and one response handler added after
  acme-client's own (Open points 1 and 2). For every answer it keeps `{ status, type, detail, retryAfterS }` when the
  `content-type` starts with `application/problem+json` and the body's `type` is a string, and null for any other
  answer and for a request that got none. Retry-After is seconds or an HTTP date. acme-client's request handler makes
  every ACME answer, 4xx included, reach the fulfilled side; a request with no answer reaches the rejected side.
- One `new acme.Client({ directoryUrl, accountKey, accountUrl, backoffAttempts, backoffMin, backoffMax })` per
  `AcmeAccount`, with `opts.backoff` or `{ attempts: 10, min: 2000, max: 10000 }`, about 74 s for the self-check and
  for each wait for a status.
- `account()`: `createAccount({ termsOfServiceAgreed: true })`, then `getAccountUrl()`.
- `issue`, in this order: `account()` when no URL is held; `createOrder({ identifiers: [{ type: 'dns', value: host }]
  })` with `replaces` added when given (a variable typed `Parameters<acme.Client['createOrder']>[0] & { replaces?:
  string }`, since that type has no such field and the package root does not export it); `getAuthorizations(order)`; for
  each authorization not yet `valid`: its `http-01` challenge (none: `refused`),
  `getChallengeKeyAuthorization(challenge)`, `hooks.answer(token, keyAuthorization)`, when `selfCheck`
  `verifyChallenge(authz, challenge)`, whose throw gives `not_ready` before the challenge is completed, then
  `completeChallenge(challenge)` and `waitForValidStatus(authz)`; `hooks.forget` for every answered token in a
  `finally`; then `createPrivateEcdsaKey('P-256')`, `createCsr({ altNames: [host] }, key)` (no common name), `const
  finalized = await finalizeOrder(order, csr)`, `getCertificate(finalized)`, and `{ certPem, keyPem: key.toString() }`.
  `finalizeOrder` answers a new object and leaves `order` as it was, and an order that was `ready` from the start has no
  certificate URL of its own (`src/client.js:351-365`, `:598-607`), so `getCertificate` takes `finalized`, as
  acme-client's own `src/auto.js:180-181` does.
- Errors: a throw from any step but the self-check becomes an `AcmeError`. A kept problem with a status below 500 gives
  `refused` with its `type` and `retryAfterS`. When `waitForValidStatus(authz)` threw with none kept, the authorizations
  are read again: an `invalid` one gives `invalid` with its `http-01` challenge's `error.type`. Anything else (a 5xx,
  no answer, a timeout, still pending after the backoff) gives `unreachable`, with the kept problem's `type` and
  `retryAfterS` when there was one. The message is `acme <kind>` and the problem's `detail` (else acme-client's
  message) cut to 200 characters; never a key, a CSR or a JWS.
- `ari.ts`: `certIdFrom` is base64url without padding of the key identifier, a `.`, and base64url without padding of
  the serial's DER content octets. `certId` reads the first certificate of the chain with `@peculiar/x509`: the
  `AuthorityKeyIdentifierExtension`'s `keyId`, and `serialNumber` with `00` put back in front when its first byte is
  `80` or more (`@peculiar/x509` 1.14.3 strips that byte, `build/x509.cjs.js:2482`, and so does Node's
  `X509Certificate`; RFC 9773 wants the octets as encoded). `renewalInfo`: a GET of the directory; null when it has no
  `renewalInfo` or `certId` is null; else a GET of `<renewalInfo with no trailing slash>/<certId>` (Pebble's ends in
  `/`, Let's Encrypt's does not). A 200 whose `suggestedWindow` has two dates with `start < end` gives the window, and
  `retryAfterS` from Retry-After (seconds or an HTTP date) or 21600 without one; any other answer gives `refused`, with
  the problem's `type` when there is one; no answer gives `unreachable`. Node's `fetch`, with
  `AbortSignal.timeout(15000)` and `redirect: 'error'`; no signing, no account.
- `test/real/run.sh` (POSIX sh, `set -eu`): fails with `test:real needs Docker` when `docker info` fails; runs
  `ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199` as
  `hornhoof-pebble-$$` with `-e PEBBLE_VA_NOSLEEP=1`, `-p 14000:14000 -p 15000:15000`, `--add-host
  acme.test:host-gateway`, command `-config test/config/pebble-config.json -strict`; removes the container and its
  temp folder on exit (`trap`); waits up to 30 s for `curl -ksf https://localhost:14000/dir`; `docker cp
  <container>:/test/certs/pebble.minica.pem <temp>/ca.pem`; then runs `npx vitest run -c vitest.real.config.ts` with
  `NODE_EXTRA_CA_CERTS=<temp>/ca.pem`, `PEBBLE_DIRECTORY=https://localhost:14000/dir`,
  `PEBBLE_MANAGEMENT=https://localhost:15000`, and exits with its status. Pebble keeps its default 5% of refused
  nonces, which acme-client's own badNonce retry meets in most runs (`acme-fake.test.ts` pins it); its default config
  validates HTTP-01 on port 5002, picks a random profile when none is asked, and reuses an account's valid
  authorization half the time (`PEBBLE_AUTHZREUSE`, `wfe.go:1562-1565`).
- `vitest.real.config.ts`: `include: ['test/real/**/*.test.ts']`, the same `globalSetup` as `vitest.config.ts`,
  `testTimeout: 120000`, `fileParallelism: false` (port 5002 is shared). The tests throw `run with npm run test:real`
  when `PEBBLE_DIRECTORY` is unset.
- CI job `test-real` in `images.yml`, beside `test`: `runs-on: ubuntu-latest`, the same pinned `actions/checkout` and
  `actions/setup-node` (node 22, npm cache), `npm ci`, `npm run test:real`.

- [ ] **Step 1: Write failing tests.**
  `challenges.test.ts`: `answers a token it holds as text, and nothing else` (`/.well-known/acme-challenge/abc_-1`
  gives 200 `text/plain` with the key authorization after `answer`, 404 after `forget`, 404 for an unknown token and
  for `a.b`; it needs no session and works over the link with `viaLink()`).
  `ari.test.ts`:
  - `builds the certificate id as RFC 9773 shows it`: `certIdFrom('69885b6b87464041e1b37b847ba0ae2cde01c8d4',
    '0087654321')` is `aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE`.
  - `keeps the serial's leading zero`: `certId` of `await selfSigned('acme.hornhoof.org', { serial: '0089abcdef' })`
    ends in `.AImrze8`, its first part decodes to the 20 bytes of the certificate's authority key identifier, and it
    holds no `=`.
  - `asks the renewal information of the certificate`, against a directory served by a local `http.createServer` in
    the test with `renewalInfo: 'http://127.0.0.1:<port>/renewal-info/'`: the GET's path is `/renewal-info/<certId>`
    with one slash; a window answer with `Retry-After: 3600` gives that window and `retryAfterS: 3600`, and without
    Retry-After `21600`; a 404 with an `application/problem+json` body of type `urn:ietf:params:acme:error:malformed`
    gives `refused` with that type; a window whose `start` is after its `end` gives `refused`.
  - `has none to give without ARI`: a directory with no `renewalInfo` gives `null` and fetches nothing else.
  - `says unreachable when nothing answers`: a directory URL on a closed port gives `unreachable`.
  `acme-fake.test.ts`, against a fake ACME server on a local `http.createServer` (a directory with `newNonce`,
  `newAccount` and `newOrder`; `newNonce` answers HEAD with a `replay-nonce`, and so does every answer; the fake checks
  no signature):
  - `tells a rate limit and its Retry-After, without waiting it out`: `newAccount` answers 429,
    `application/problem+json` `{ "type": "urn:ietf:params:acme:error:rateLimited", "detail": "too many" }`,
    `Retry-After: 7200`: `account()` rejects within 2 s with an `AcmeError` `refused`, that type and `retryAfterS:
    7200`, and the fake saw one `newAccount`.
  - `says unreachable for a server error, at once`: a 500 with no body gives `unreachable` within 2 s, after one
    `newAccount`.
  - `says unreachable when nothing answers`: a closed port gives `unreachable`.
  - `never puts a key in an error`: no message of the errors above contains `PRIVATE KEY` or the body of the account
    key's PEM.
  - `sends again after a refused nonce`: the first `newAccount` answers 400 `application/problem+json` with type
    `urn:ietf:params:acme:error:badNonce`, the second 201 with a `Location`: `account()` gives that URL, after two
    `newAccount`.
  - `downloads the certificate of an order that was ready from the start`: `newOrder` answers 201 with a `Location`,
    `status: 'ready'`, no authorizations and a `finalize` URL; `finalize` answers `status: 'processing'`; the order's
    URL then answers `status: 'valid'` with a `certificate` URL, which answers the chain of `await
    selfSigned('acme.test')`: `issue('acme.test', hooks, { selfCheck: false })`, on an `AcmeAccount` with `backoff: {
    attempts: 3, min: 50, max: 50 }`, gives that chain and a `keyPem`, and the hooks were never called.
  `test/real/acme.test.ts`, against Pebble, with a `testApp()` listening on `0.0.0.0:5002` and hooks that answer
  through `app.ctx.challenges` and record each token:
  - `makes an account and finds the same one again by its key`: a second `AcmeAccount` with the same key and no URL
    gives the same URL.
  - `orders a certificate over HTTP-01, answered by the app's own route`: `issue('acme.test', hooks, { selfCheck: false
    })` gives a chain whose `certInfo` names are `['acme.test']` and whose `certId` is set, and whose first certificate
    `checkPrivateKey`s the `keyPem`; every recorded token is forgotten after.
  - `asks when to renew, and renews once with replaces`: `renewalInfo(PEBBLE_DIRECTORY, a)` has `start < end`, both
    between `a`'s `notBefore` and `notAfter`; after a POST to `${PEBBLE_MANAGEMENT}/set-renewal-info/` with `{
    Certificate: a, ARIResponse: JSON.stringify({ suggestedWindow: { start: <an hour ago>, end: <a minute ago> } })
    }`, its `end` is in the past; `issue(..., { replaces: certId(a), selfCheck: false })` gives `b` with another
    serial; the same `replaces` again throws `refused` with type `urn:ietf:params:acme:error:alreadyReplaced`.
  - `says invalid when the app does not answer the challenge`: on a new account (so no valid authorization of an
    earlier test is reused), hooks whose `answer` does nothing, `selfCheck: false`: `invalid`, with a `type`.
  - `does not ask the CA to validate while its own check fails`: an `AcmeAccount` on a new account key, with `backoff: {
    attempts: 2, min: 100, max: 100 }`, and hooks whose `answer` does nothing, `selfCheck` left on: `not_ready` (nothing
    answers `http://acme.test/` from the test's side); with `vi.spyOn(app.ctx.challenges, 'get')`, no request reached
    the app's challenge route within one second after it.
  The app listens with `app.listen({ port: 5002, host: '0.0.0.0' })`, the port Pebble's default config validates on.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/challenges.test.ts test/ari.test.ts
  test/acme-fake.test.ts`, then `npm run test:real` from the root. Expected: FAIL (no module). If Pebble cannot
  resolve `acme.test` through `--add-host`, stop and report: the fallback is pebble-challtestsrv as Pebble's
  `-dnsserver`, a decision for the team lead. If acme-client turns out unable to do a step above, stop and report
  which call; do not write that step by hand.
- [ ] **Step 3: Implement** the interfaces, `run.sh`, the configs, the scripts and the CI job.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Get certificates through acme-client with renewal information on top, tested against Pebble
  in CI".

