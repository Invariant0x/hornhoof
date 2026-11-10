# You are the reviewer (read-only)

Another agent wrote the task below. You review it; you do not fix it.

- Do NOT edit, create, move or delete any file in either repository or under `~/.hornhoof-edge/`. Do not commit,
  push, run prettier or any formatter. Temporary files only under `$TMPDIR`.
- Never read `~/.hornhoof-edge/ssh_config` or any key file; never print `~/.hornhoof-edge/private-words` (tests may
  read it).
- Read the change (the files named below), compare it line by line with the brief: the plan's top part, its Review
  Focus, its Global Constraints, the build rulings and the build lead's rulings, and the task's Files, Interfaces and
  Steps. Then run the task's **Done when** yourself and read its output.
- Look hardest at: behavior that differs from the Interfaces; tests that would pass even if the code were wrong (weak
  asserts, sleeps instead of waits, skipped checks); anything private or any em dash in a tracked file; fail-open
  reads; processes or ports left behind; Python syntax newer than 3.12 in relay files; facts in docs that are not true
  at this commit.
- Report, as your final message, a list of findings, each: severity (Critical: wrong or unsafe, must fix; Important:
  a gap against the brief or a weak test, must fix; Minor: style or nice to have), `file:line`, what is wrong, and
  what would make it right. Then the Done when command you ran and its result (counts of tests passed/failed). If you
  find nothing at a severity, say so. Keep it short and concrete.

# Build rulings (they override the plan)

1. One branch for everything. A plan's "Repo" line that names its own worktree or branch (relay-contract, backups, ...)
   means the Hornhoof worktree `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on branch `network`.
   "Starts from: main with plan N merged and shipped" and "Handed over" mean "plan N's tasks are complete on this branch".
   The relay repo is `/Users/0x/Projects/hornhoof-edge`, local only: no remote, no push.
2. Never deploy, ship or rehearse. Skip every step a plan marks as the team lead's or Ivan's: deploying the relay to the
   droplet, hornhoof.org, or any ssh; a rehearsal on a stand; `install.sh` against a real company; an Update; a
   `request.json` on a company; a merge into main; a push; anything on GitHub.
3. Code that a plan says depends on plan 1 being deployed is written and tested against the local relay the tests and
   the lab start. Never against the real one.
4. Private files the plan puts in `~/.hornhoof-edge/` stay there and never enter a repo. Never print a key, token,
   password or the content of `~/.hornhoof-edge/ssh_config`. Do not read `ssh_config`, any key file, or print the file
   `~/.hornhoof-edge/private-words` (tests may read it; never echo its lines).
5. Migration numbers: take the plan's numbers as written.


# What to review

Plan 1 Task 5, written by Codex in `/Users/0x/Projects/hornhoof-edge` on `main`, not committed: the change is
`git -C /Users/0x/Projects/hornhoof-edge diff 6faf6c8` plus the untracked `relay/test/test_sync.py`. The build lead's
notes to the writer said: the sync post writes through `write()`; "on disk before the answer" means committed under
`PRAGMA synchronous=FULL` before the 200; the holder check and the write take the per-name lock and the write is
guarded by the generation read. Ruling during the task: an `epoch` or `generation` above 2**63 - 1, or a JSON bool
where an integer is wanted, is 400 `invalid`. Codex reports "shared authentication extraction" (a helper shared by
the route and sync endpoints) and six extra tests.
Run Done when with the droplet's Python: `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`. Then
the gates: `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh 6faf6c8`
(every function the task added or changed under CRAP 10; admin 285.4 and create_binding 26.2 not raised; no dryer pair
at 0.8 or above with new code). Look hardest at R2.4 row by row, Review Focus 2 (the sync post of the machine that
lost the race is refused), fail-closed answers (a pending row is not held for sync), and what the README now says.

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

**Two repositories.** "Relay repo" is `hornhoof-edge`, a new git repository at `/Users/0x/Projects/hornhoof-edge`
that Task 1 builds from the public part of `~/.hornhoof-edge/droplet` (overview decision 1). It goes public later, so
it is an open-source project from its first commit and holds nothing private. The team lead pushes it to GitHub; the
executor never does. `~/.hornhoof-edge/droplet` keeps the droplet's base setup and gives up the files the repo now
owns. "Hornhoof" is `/Users/0x/Projects/Hornhoof-archive`, worked on in a new worktree on branch `relay-contract`
from main.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  This plan adds no UI strings.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. In the relay repo every commit is also signed off
  (`commit -s`, the DCO line `Signed-off-by: Ivan Korol <invariant0x@icloud.com>`). Never commit `notes/`, `.claude/`,
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
"Commit and Push" and "Push your branch" below do not apply to you: the build lead commits, nobody pushes. The gates (crapper, dryer) run through the build lead's gate script named in the task notes, on this task's files only; mutator runs once at the plan's end, not per task.
For the relay that means: Python standard library only (no dotenv, no pytest: tests are `unittest`), runnable on Python 3.12; type annotations on new function signatures where the code around does so. fastapi.md applies to no file here.

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

## ECC python rules

### coding-style.md
# Python Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with Python specific content.

## Standards

- Follow **PEP 8** conventions
- Use **type annotations** on all function signatures

## Immutability

Prefer immutable data structures:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    name: str
    email: str

from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
```

## Formatting

- **black** for code formatting
- **isort** for import sorting
- **ruff** for linting

## Reference


### fastapi.md
# FastAPI Rules

Use these rules for FastAPI projects alongside the general Python rules.

## Structure

- Put app construction in `create_app()`.
- Keep routers thin; move persistence and business behavior into services or CRUD helpers.
- Keep request schemas, update schemas, and response schemas separate.
- Keep database sessions and auth in dependencies.

## Async

- Use `async def` for endpoints that perform I/O.
- Use async database and HTTP clients from async endpoints.
- Do not call `requests`, sync SQLAlchemy sessions, or blocking file/network operations from async routes.

## Dependency Injection

```python
@router.get("/users/{user_id}")
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ...
```

Do not create `SessionLocal()` or long-lived clients inside route handlers.

## Schemas

- Never include passwords, password hashes, access tokens, refresh tokens, or internal auth state in response models.
- Use `response_model` on endpoints that return application data.
- Use field constraints instead of hand-written validation when Pydantic can express the rule.

## Security

- Keep CORS origins environment-specific.
- Do not combine wildcard origins with credentialed CORS.
- Validate JWT expiry, issuer, audience, and algorithm.
- Rate-limit auth and write-heavy endpoints.
- Redact credentials, cookies, authorization headers, and tokens from logs.

## Testing

- Override the exact dependency used by `Depends`.
- Clear `app.dependency_overrides` after tests.
- Prefer async test clients for async applications.


### patterns.md
# Python Patterns

> This file extends [common/patterns.md](../common/patterns.md) with Python specific content.

## Protocol (Duck Typing)

```python
from typing import Protocol

class Repository(Protocol):
    def find_by_id(self, id: str) -> dict | None: ...
    def save(self, entity: dict) -> dict: ...
```

## Dataclasses as DTOs

```python
from dataclasses import dataclass

@dataclass
class CreateUserRequest:
    name: str
    email: str
    age: int | None = None
```

## Context Managers & Generators

- Use context managers (`with` statement) for resource management
- Use generators for lazy evaluation and memory-efficient iteration

## Reference


### security.md
# Python Security

> This file extends [common/security.md](../common/security.md) with Python specific content.

## Secret Management

```python
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]  # Raises KeyError if missing
```

## Security Scanning

- Use **bandit** for static security analysis:
  ```bash
  bandit -r src/
  ```

## Reference


### testing.md
# Python Testing

> This file extends [common/testing.md](../common/testing.md) with Python specific content.

## Framework

Use **pytest** as the testing framework.

## Coverage

```bash
pytest --cov=src --cov-report=term-missing
```

## Test Organization

Use `pytest.mark` for test categorization:

```python
import pytest

@pytest.mark.unit
def test_calculate_total():
    ...

@pytest.mark.integration
def test_database_connection():
    ...
```

## Reference


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

### Task 5: The sync record (R2.4)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 4 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py`; `README.md` (What it stores: each link's sync record, on or off, the copy's machine, its
  epoch, the registration it came in and when)
- Test: `relay/test/test_sync.py`

**Interfaces:**
- Consumes: `route_of` (Task 2), `write` (Task 4).
- Produces:
  - Table `sync(name TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('on', 'off')), copy TEXT, epoch INTEGER
    NOT NULL, generation INTEGER NOT NULL, at INTEGER NOT NULL)`; the connection runs `PRAGMA synchronous=FULL`.
  - `sync_of(name: str) -> dict`: `{state, copy, epoch, generation, at}`, or `{state: 'off', copy: None, epoch: 0,
    generation: 0, at: None}` with no row. `route_of` adds it as `sync`.
  - `POST /api/v1/links/<name>/sync`, `application/json`, body exactly `{client: str (1 to 100), generation: int >= 1,
    state: 'on' | 'off', copy: str (1 to 100) | null, epoch: int >= 1}`, `copy` non-null when `state` is `on`, no
    other field: else 400 `invalid`. 404 and 401 as the route; 503 `unknown` on `FrpsUnknown`; 409 `{error:
    'not_holder'}` unless the route reads `held` from frps's `online` (not from a `pending` row) and the row's `client`
    and `generation` equal the body's; 409 `{error: 'stale_epoch'}` unless `epoch` is above the stored one; else the
    row is written and committed, and only then 200 `{sync: sync_of(name)}`.

- [ ] **Step 1: Write failing tests** in `test_sync.py`:
  - `test_r2_4_missing_reads_off`: a fresh binding's route has `sync == {state: 'off', copy: None, epoch: 0,
    generation: 0, at: None}`.
  - `test_r2_4_holder_sets_it`: `acme-aaaaaaaa-link` holds `acme` at generation 1; post `{client:
    'acme-aaaaaaaa-link', generation: 1, state: 'on', copy: 'bbbbbbbb', epoch: 1}`: 200, and the route's `sync` says
    the same with `at` set.
  - `test_r2_4_others_refused`: another client (`not_holder`), generation 2 (`not_holder`), epoch 1 again
    (`stale_epoch`), and the route `empty` after the holder stopped (`not_holder`) each give 409; the record stays.
  - `test_r2_4_pending_is_not_held`: on a binding with no client, the test writes a `routes` row `('globex', 1,
    'globex-aaaaaaaa-link', 'r1', 'http', 'pending', <now>)` into `relay.db`; the route reads `held`, and a sync post as that
    client at generation 1 gets 409 `not_holder`.
  - `test_r2_4_on_disk_before_answer`: right after the 200, a read-only `sqlite3` connection to `relay.db` finds the
    row; after `restart_relay()` the route's `sync` is unchanged.
  - `test_r2_4_bad_bodies`: `state: 'maybe'`, a missing `epoch`, `copy: null` with `on`, an extra field: 400 each.
  - `test_r2_4_unknown_frps`: `dashboard=False`: 503 and no row.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_sync.py -v`. Expected: FAIL (404 on the path).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS.
- [ ] **Step 5: Commit** "Keep a sync record per link that only its holder sets".

