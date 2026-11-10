You are the writer for Task 12 of 2026-11-03-network-phase-1-plan-1-relay-contract in Hornhoof's network build. Read everything below before you start.

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
5. Migration numbers: take the plan's numbers as written.
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
`hornhoof/templates/skills/dev-engineering-rules.md`. Uncle Bob's three gates (crapper under 10, dryer no pair at 0.8, mutator killed) apply to
every line you change.

**Test runs:** a few tests at a time locally with `/home/altera/hornhoof-network/network-build/light.sh <command>`, from your lane. Full suites,
coverage and mutator go to the test machine, never locally: `REMOTE_EDGE_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run <label> '<command>'`
(`REMOTE_HORNHOOF_TREE=<your lane>` for a Hornhoof lane). It runs in a snapshot of your lane at the usual absolute paths, so inside
it the repository is `/home/altera/hornhoof-network/hornhoof-edge` or `.../hornhoof`, whichever your lane is. Your own gates' results come back to your lane. If `remote.sh` does not exist yet, it is being built: write
your code and focused tests, and check for it before your gates; wait for it rather than run a heavy thing locally.
Gates, inside `remote.sh run`, with `lanebase` as the base:
- relay: `/home/altera/hornhoof-network/network-build/gates-relay.sh lanebase`, then `/home/altera/hornhoof-network/network-build/mutate.sh /home/altera/hornhoof-network/hornhoof-edge lanebase relay/relay.py '<python3.12> -m unittest <scoped modules>'` for each changed non-test file.
- Hornhoof: `/home/altera/hornhoof-network/network-build/gates-hornhoof.sh lanebase server '<test files>'`, then `/home/altera/hornhoof-network/network-build/mutate.sh /home/altera/hornhoof-network/hornhoof lanebase <file> 'cd apps/server && npx vitest run <test files> --maxWorkers=1'`.
A survivor is killed by a new test (see it fail first), or listed in your report with why it is equivalent, for the lead to rule on.

# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p1t12`, Hornhoof. It starts from Hornhoof 73d086ba plus Task 11's new fake relay, which another writer is still finishing (`apps/server/test/fake-relay.ts`, `fake-relay.test.ts`); a few of its tests may still change. Do not edit those two files here: anything you need of the fake goes in your report, for the lead.
- Plan line references were read at an older main; check each against the code. A fact that proved wrong goes in your report.
- The whole-suite part of the task's Done when goes through `remote.sh`: `npm test -- --testTimeout=90000` from the repo. `tsc`: `npx tsc -p apps/server/tsconfig.json --noEmit`.
- The link key goes only into the `authorization` header, never into a result, an error or a log line. Tests compare it with booleans and fixed messages.
- Report: `/home/altera/hornhoof-network/network-build/runs/p1t12-report.md`.

# The plan, from its top to the end of Review Focus (quality rules inserted after its Global Constraints)

# Network Phase 1, Plan 1: The Relay Contract, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hornhoof.org keeps the promises the network's leader rule rests on (one route per name, who holds a name
and since which registration, a sync record only the holder sets, eviction within a measured bound, a health answer
tied to frps, stcp services per name, a key change), and stops being able to read company traffic: it routes each
connection by its TLS server name and passes the encrypted bytes to the company's machine. All of it is proven against
a real frps 0.71.1 and Caddy and mirrored by the fake relay Hornhoof's tests use; Hornhoof gains a relay client that
reads every answer fail-closed.

**Architecture:** relay.py stays one Python file on the standard library, the frps plugin and the link API in one
process. Whether a route is live comes only from frps's dashboard API (`/api/proxy/<type>/<name>`: `status` and
`clientID`), read on every route answer and sync post. The generation, the holder and `since` come from the relay's own
table, written when the plugin lets a registration through (`NewProxy`), under a lock per name, after it checked frps
holds no route for the name. The plugin does not use `CloseProxy`: frps sends it asynchronously, unordered against the
next `NewProxy` of the same run id, and not at all when frps dies (frp `server/control.go:678-679`). frps drops a
silent client through tcpMux keepalive instead of heartbeats. frps takes port 443 and routes by the TLS server name: a
company's `https` proxy gets the encrypted stream as it came, and everything else goes through the droplet's own frpc
(client `edge`) to Caddy, now on loopback, as today. The plugin answers frps's `NewUserConn` for every new connection
to an `https` or `stcp` proxy, which blocks a name at once without a restart. Hornhoof's `Relay` class gets `route`,
`setSync`, `health`, `changeKey` and `visitorKey`, which never take a bad answer for a good one; nothing in Hornhoof
calls them until plan 1b.

**Tech Stack:** Python 3.12 standard library (`http.server`, `sqlite3`, `ssl`, `unittest`), frps and frpc 0.71.1 and
Caddy 2.11 as real binaries under test, systemd units on the droplet; TypeScript, Fastify (fake relay), zod, vitest on
Hornhoof's side.

**Spec:** `notes/specs/2026-11-02-single-network-design.md`, 3.4 "The relay contract" (R1 to R5), 3.2 path 2, 3.4
"Without a public link", 3.10 (TLS ends at the company's machine), section 10 "A stolen machine" (the change-key
call), section 12 second bullet. Overview: `notes/plans/2026-11-03-network-phase-1-overview.md` (plan 1,
discrepancies 10 to 14 and 19 to 25, decisions 1, 3 and 4, "Our own TLS on the public link"). Relay today:
`~/.hornhoof-edge/droplet/relay/` and `notes/ops/hornhoof-org.md` (main checkout). Open-source model:
`notes/ops/going-public.md` and Hornhoof's own `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and
`.github/`. frp facts: tag v0.71.1 of `github.com/fatedier/frp`, paths below are in that tree.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches the droplet, GitHub or another task, and stops and reports when a test of an earlier
task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**Two repositories.** "Relay repo" is `hornhoof-edge`, a new git repository at `/home/altera/hornhoof-network/hornhoof-edge`
that Task 1 builds from the public part of `~/.hornhoof-edge/droplet` (overview decision 1). It goes public later, so
it is an open-source project from its first commit and holds nothing private. The team lead pushes it to GitHub; the
executor never does. `~/.hornhoof-edge/droplet` keeps the droplet's base setup and gives up the files the repo now
owns. "Hornhoof" is `/home/altera/hornhoof-network/hornhoof`, worked on in a new worktree on branch `relay-contract`
from main.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  This plan adds no UI strings.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. In the relay repo every commit is also signed off
  (`commit -s`, the DCO line `Signed-off-by: Ivan Korol <<owner's address, the lead's alone>>`). Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `relay/test/.bin/`, `deploy.env`.
- Nothing private in the relay repo (overview decision 1): no droplet IP, no hostname but hornhoof.org and names under
  it, no key, token, password, ssh config or certificate, no company's link name. Private values stay in
  `~/.hornhoof-edge/`, and the deploy reads them from there; the repo carries only examples. `relay/test/test_public.py`
  (Task 1) checks every tracked file on every test run, so each commit passes it.
- Tests first. Hornhoof, from `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole
  suite from the repo root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`, plus
  `npx tsc -p apps/server/tsconfig.json --noEmit`. Relay, from the relay repo root:
  `python3 -m unittest discover -s relay/test -v`. Never run prettier.
- relay.py: Python standard library only, and it must run on the droplet's Python 3.12 (Ubuntu 24.04): no syntax
  newer than 3.12. frps and frpc exactly 0.71.1, sha256-checked; Caddy in tests at the one 2.11 release
  `relay/test/caddy.sh` pins, checked against Caddy's release checksums.
- Fail closed: any error, timeout, unknown value or missing field in an answer about a route reads as unknown, never
  as empty (R2). The relay answers 503 when it cannot tell whether a route is live.
- frps calls the plugin with no timeout, inside each client's control loop (`pkg/plugin/server/http.go:50`,
  `pkg/msg/handler.go:185-186`): every dashboard read the plugin makes has a 1 s timeout, and a timeout refuses the op.
- Today's tunnels keep working unchanged after the deploy: frpc 0.71.1 with `transport.heartbeatInterval = 30` and
  `heartbeatTimeout = 90` set, one http proxy named after the binding, no client id
  (`apps/server/src/modules/link/client.ts:20-45`).
- The relay never logs or returns a link key, visitor key or stcp secret, except the one answer that hands a key out,
  and never logs or keeps a visitor's address from `NewUserConn`.
- hornhoof-edge's README says what is true at each commit; from Task 9 on it says plainly that the relay sees only
  encrypted bytes and the name being reached, for every company whose link uses `https`.
- Nothing touches the droplet before Task 13. Its restart follows overview decision 4: one restart, starting between
  06:00 and 07:15 UTC (03:00 and 04:15 at UTC-3), only while no connection on port 443 is busy, never on a night the
  droplet waits to reboot.


# Quality rules (from the team lead, 2026-11-03)

These come after the plan's Global Constraints. Where they disagree, the plan's Global Constraints and the build rulings win: no prettier and no formatter (black, isort, ruff format are not run), the plan's file layout, the plan's names, the plan's test framework.
"Commit and Push" and "Push your branch" below do not apply to you: the build lead commits, nobody pushes. The gates (crapper, dryer, mutator) run on every task, on the changed code, through the commands in the task notes.
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

- **Health stays at `/api/v1/health`** on hornhoof.org (overview discrepancy 10): `/api/health` on a company's host
  is the app's own route.
- **Client ids are frp's own `clientID`.** frps refuses a second login with a `clientID` that is online
  (`server/registry/registry.go:207-215`, `server/control.go:213`), which is R1's "second live login refused". The same
  value goes into `metadatas.client`, because `NewProxy` carries the login's metas but not its `client_id`
  (`pkg/plugin/server/types.go:40-44`). Ids: `<link>-<machine8>-link`, `<link>-<machine8>-peer`, and
  `<link>-<machine8>-visit` for a visitor-only client. A tunnel with no client id is a today's tunnel, client `legacy`.
- **A login with a live run id replaces that session in frps** (`server/service.go:819`, `server/control.go:167`),
  which the spec does not expect. That is how an frpc gets its own session back after a network blip, so the plugin
  keeps it, but only when the live session with that run id has the same client id (read from
  `/api/clients?runId=`).
- **Visitors need no link key.** Section 10 gives workers no link key, but every frpc logs in to frps and today's
  `Login` check wants the key. So each link gets a visitor key (R6.2): a login with it may only run stcp visitors and
  register nothing. The stcp secret opens a service; the visitor key keeps strangers off frps.
- **A registration the plugin let through and frps has not shown yet is `pending` and reads as held for 10 s**, so a
  second registration in that gap is refused by the plugin and the generation names the one frps took.
- **One route per name rests on the proxy name.** frps keys http routes by domain, location and `routeByHTTPUser`
  (`pkg/util/vhost/router.go:170-185`) and lets groups share one (`server/group/http.go:82-108`), but proxy names are
  unique across clients (`server/control.go:871-873`), and the plugin lets in only the proxy named after the binding.
  The plugin also refuses `locations`, `route_by_http_user` and `group`, as it refuses custom domains today.
- **relayStarted** is the latest of: relay.py's start, the time the relay's watcher saw frps answer again after a
  failure, and frps's last start, which systemd writes to `/run/frps/started` (`ExecStartPost`).
- **Blocking a name restarts nothing** (overview decision 3). frp 0.71.1 has no call that closes one proxy or one
  client, and the plugin's `Ping` check reaches only clients that send heartbeats (`client/control.go:243`). None is
  needed. For a name in http mode, Caddy answers 410 before frps (`import blocked.caddy` comes ahead of the frps
  handler in the Caddyfile), so its public traffic stops at once. For a name in https mode and for stcp services,
  frps asks the plugin about every new connection (`NewUserConn`, `server/proxy/proxy.go:268-285`) and the plugin
  refuses those of a blocked or freed name (Task 10). In both, the plugin refuses the name's next login and
  registration; a today's tunnel still goes at its next refused `Ping`; a tunnel on the network's settings lingers,
  carrying nothing new, until it reconnects and is refused. Connections already open stay until they close;
  `ban --cut` restarts frps when they must go too.
- **frps takes port 443; Caddy moves behind it** (overview, "Our own TLS on the public link", with the reasons against
  an SNI router in front). `vhostHTTPSPort = 443`, `proxyBindAddr = "0.0.0.0"`. The droplet's own frpc, client
  `edge`, registers one `https` proxy named `edge` with `customDomains = ["hornhoof.org", "*"]` that points at Caddy on
  `127.0.0.1:8443` and sends a PROXY v2 header; frps refuses `*.hornhoof.org` as a custom domain under its
  `subDomainHost` (`pkg/config/v1/validation/proxy.go:81-90`), and `*` is its catch-all
  (`pkg/util/vhost/router.go:153-154`). Tunnels keep coming in as wss through Caddy to frps's loopback bind port, so
  today's frpc settings stay valid. The plugin lets `edge` in only with the 32-byte token in
  `/etc/hornhoof-relay/edge.env`: every tunnel reaches frps from Caddy on loopback, so an address proves nothing.
- **A company's `https` proxy looks like its `http` one**: named after the binding, `subdomain` equal to the name, no
  custom domain, no group, no locations. The `routes` row keeps its type (Task 2), and a name holds one route of
  either type, since proxy names are unique across types (`server/control.go:871-873`).
- **A freed name waits for its old tunnel** (overview decision 3). Releasing changes nothing live: Hornhoof stops its
  own tunnel when it renames (`apps/server/src/modules/link/link.ts:74-89`). Until frps shows the old route gone,
  `GET /names/<name>` says `taken` and `POST /bindings` with that name answers 409 `taken`, so no new company is
  handed a name another machine still serves; while frps cannot tell, both answer 503 `unknown`, which Hornhoof's
  `check` and `bind` already read as `relay_unreachable`. A random name skips the check: a fresh 24-character name has
  no old route, and `check_name` runs in the loop that picks one.
- **Quiet means the kernel's bytes, not frps's.** frps adds a connection's bytes to its counters only when the
  connection closes (`server/proxy/http.go:151-157`, `server/proxy/proxy.go:318-323`), so a live event stream or copy
  shows nothing there. `ss -tin` gives `bytes_sent` and `bytes_received` for every open TCP connection; the deploy waits
  for a minute in which none on port 443 moved more than 64 KiB.
- **No separate contract document.** The contract is the table below; both test suites name each test by its row id.

## The contract

Base `https://hornhoof.org/api/v1`. "Key" is the link's key, `Authorization: Bearer <key>`. Times are Unix seconds.

| Row | Promise | Relay test | Fake test |
|---|---|---|---|
| R1.1 | A registration of a name with a live or pending route, of either type (`http`, `https`), is refused, from any client, and moves no generation. | Tasks 2, 9 | Task 11 |
| R1.2 | A registration in a load-balancer group, or with `locations` or `route_by_http_user`, is refused. | Task 2 | none (the fake has no groups) |
| R1.3 | A second live login with one client id is refused; a live session is taken over only with its own run id and client id. | Task 6 | Task 11 |
| R1.4 | Two companies on one machine (same machine8, two link names) log in side by side. | Task 6 | Task 11 |
| R1.5 | A name with no binding whose old route is still live is not bound again: `GET /names/<name>` says `taken`, `POST /bindings` answers 409 `taken`; both 503 while the relay cannot tell. | Task 7 | Task 11 |
| R2.1 | `GET /links/<name>/route` with the key answers `{state: "held" \| "empty", client, since, generation, relayStarted, evictionBound, sync}`; `client` names the maker of registration `generation`. | Task 2 | Task 11 |
| R2.2 | The generation grows by one with every registration let through and survives relay.py and frps restarts. | Task 4 | Task 11 |
| R2.3 | 401 wrong key, 404 unknown name, 503 while the relay cannot tell; never an "empty" it is not sure of. | Tasks 2, 4 | Task 11 |
| R2.4 | `POST /links/<name>/sync {client, generation, state: "on" \| "off", copy, epoch}` with the key is taken only from the client holding the route in that generation, only with a higher epoch, on disk before the answer, kept across restarts; a missing record reads `{state: "off", copy: null, epoch: 0, generation: 0, at: null}`. | Task 5 | Task 11 |
| R3.1 | A silent client's route goes within `evictionBound` (30 s); the measured time is printed. | Task 3 | Task 11 (`drop`) |
| R3.2 | A live but idle client keeps its route, on today's settings and on the network's. | Task 3 | none |
| R4.1 | `GET /health` answers 200 `{ok: true, frps: true, relayStarted, passthrough}` only while frps accepts logins, else 503 `{ok: false, frps: false}`; `passthrough` is `true` while frps's https port accepts connections (Task 9; `false` before). | Tasks 4, 9 | Task 11 |
| R5.1 | A `-peer` client may offer stcp services `<link>-<machine8>-data` and `<link>-<machine8>-app` and nothing else; a visitor with the link's visitor key reaches them with the right secret only, and registers nothing. | Task 6 | Task 11 |
| R6.1 | `POST /links/<name>/key` with the key answers `{key}`, a new one; the old key is refused at once by the API and at login; live tunnels stay. | Task 7 | Task 11 |
| R6.2 | `POST /links/<name>/visitor-key` with the key answers `{visitorKey}`, replacing the one before. | Task 6 | Task 11 |
| R7.1 | A TLS connection for `<name>.hornhoof.org` reaches the name's `https` proxy with its bytes as they came: the client sees the company's own certificate, and the relay never holds a key for it. | Task 9 | none (the fake has no TLS) |
| R7.2 | Every other connection on 443 (hornhoof.org, www, reserved, blocked, unknown and http-mode names, no server name) reaches Caddy through `edge`, as today: the stub, the API, the tunnels' wss, 404, 410, http-mode companies. | Tasks 8, 9 | none |
| R7.3 | The visitor's address reaches the company (a PROXY v2 header from its frpc) and Caddy (`X-Forwarded-For` to http-mode companies and relay.py). | Task 9 | none |
| R7.4 | A new connection to a blocked or freed `https` name, or to a blocked name's stcp services, is refused at once, with no restart; one already open stays. | Task 10 | none |
| R7.5 | Only `edge`, with its token, may register `hornhoof.org` or `*`; any other custom domain is refused. | Task 9 | none |

## Review Focus

1. relay.py restarts (a deploy) while tunnels are live: during the restart readers get no answer (unknown); after it
   the route is held with the same generation, and no tunnel dropped. Test in Task 4.
2. Two machines of one company register the name within the same second: exactly one holds it, `client` names it,
   the generation moved once, and a sync post from the other is refused. Tests in Tasks 2 and 5.
3. A burst of plugin calls (frps restarts with many tunnels): no SQLite "database is locked" becomes a refused login
   or a lost generation, and no plugin call takes over 1 s. Test in Task 4 (40 clients at once).
4. A today's tunnel after the deploy: still served, idle for minutes without being dropped, still cut when its
   binding is blocked. Tests in Tasks 3 and 7.
5. A crowd opens a passthrough company at once (a page with 50 files, 20 visitors): frps asks the plugin about every
   new connection, so none may be refused and none may wait over 50 ms on relay.py. Test in Task 10 (200 connections
   in 2 s).

---


# The task

### Task 12: Hornhoof reads the relay fail-closed

**Repo:** Hornhoof worktree of Task 11, branch `relay-contract`. **Starts from:** Task 11 committed. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/relay-client.test.ts test/link.test.ts`
passes, the whole suite passes from the worktree root (`VITEST_MAX_WORKERS=2 nice -n 10 npm test --
--testTimeout=90000`), and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files (Hornhoof):**
- Modify: `apps/server/src/modules/link/relay.ts`
- Test: `apps/server/test/relay-client.test.ts` (new)

**Interfaces:**
- Consumes: the fake relay of Task 11.
- Produces, in `relay.ts` (`check`, `bind`, `unbind` unchanged):
  ```ts
  export type SyncRecord = { state: 'on' | 'off'; copy: string | null; epoch: number; generation: number; at: number | null };
  export type Route =
    | { known: true; state: 'held' | 'empty'; client: string | null; since: number; generation: number; relayStarted: number; evictionBound: number; sync: SyncRecord }
    | { known: false; why: 'unreachable' | 'slow' | 'refused' | 'malformed' };
  export type SyncPost = { client: string; generation: number; state: 'on' | 'off'; copy: string | null; epoch: number };
  export type SyncResult = { stored: true; sync: SyncRecord } | { stored: false; why: 'not_holder' | 'stale_epoch' | 'unknown' };
  route(name: string, key: string, timeoutMs?: number): Promise<Route>;                         // default 2000; never throws
  setSync(name: string, key: string, post: SyncPost, timeoutMs?: number): Promise<SyncResult>;  // never throws
  health(timeoutMs?: number): Promise<{ up: boolean; relayStarted: number | null; passthrough: boolean }>;  // never throws
  changeKey(name: string, key: string): Promise<string>;   // throws ApiError as bind does
  visitorKey(name: string, key: string): Promise<string>;  // throws ApiError as bind does
  ```
  zod: the route body is a `z.object` that allows extra fields (R2 may grow), `state` exactly `z.enum(['held',
  'empty'])`, integers `z.number().int().nonnegative()`, `sync` required with `state` exactly `z.enum(['on',
  'off'])`. A non-200 is `refused`, a timeout `slow`, a failed fetch `unreachable`, a body that does not parse
  `malformed`. `setSync` gives `stored: true` only for a 200 whose `sync` equals the post's `client`-free fields
  (`state`, `copy`, `epoch`, `generation`), `not_holder` and `stale_epoch` only for a 409 naming them, and `unknown`
  for everything else. The link key goes only into the `authorization` header, never into a result, an error or a
  log line.

- [ ] **Step 1: Write failing tests** in `relay-client.test.ts`:
  - `reads a held route and an empty one`: after `register('acme', 'acme-aaaaaaaa-link')`: `known: true, state:
    'held', client: 'acme-aaaaaaaa-link', generation: 1`; after `drop('acme')`: `empty`, generation 1.
  - `reads anything else as unknown, never as empty`: `frpsDown` gives `{known: false, why: 'refused'}`; a wrong key
    `refused`; `routeAnswer = 'garbage'` gives `malformed`; `'hang'` with `timeoutMs = 200` gives `slow` within 400
    ms; a closed port gives `unreachable`; `routeAnswer = 'badstate'` gives `malformed`.
  - `takes an extra field in a route answer`: `routeAnswer = 'extra'` gives `known: true`.
  - `posts the sync record as the holder`: `stored: true` and the next route's `sync` equals it; the same epoch again
    gives `stale_epoch`; another client gives `not_holder`; `frpsDown` gives `unknown`.
  - `tells relay health`: `up: true` with `relayStarted` and `passthrough: true`; `passthrough: false` when the fake says
    false and when the field is missing (a relay from before Task 9); `up: false` and `passthrough: false` while
    `frpsDown`, and while `down`.
  - `changes the key and gets a visitor key`: `changeKey` returns a key the fake now takes, the old one refused;
    `visitorKey` returns the fake's; with `down` both throw with reason `relay_unreachable`.
  - `never puts the key in a result or an error`: for every call above, `JSON.stringify` of its result or error does
    not contain the key.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/relay-client.test.ts`. Expected: FAIL
  (`route` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and `test/link.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** "Read who holds the link, its sync record and relay health, and fail closed".

