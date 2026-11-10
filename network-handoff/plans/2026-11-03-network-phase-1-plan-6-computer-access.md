# Network Phase 1, Plan 6: Computer Access per Machine, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Computer access becomes a thing of each machine of the company. The orchestrator asks for a named machine;
only that machine's owner opens it, from any screen, for a day, with a grant signed by the owner's own key, which the
machine's keeper checks against the key its owner brought there in a command; the orchestrator's commands go from the
leader's app to that machine's keeper over the peer link and run as root through that machine's updater; cards, the
window and the log name the machine. The owner who sits at a machine's localhost gets "Give the orchestrator access to
this machine" in the account menu, and the orchestrator is told where a person writes from.

**Architecture:** One migration (`0051_computer_access`): `machine_access` (until when access is open, what was asked,
who opened it) and `computer_runs` (the commands and their answers), both hidden from agents' SQL. On the server side,
`modules/computer/access.ts` becomes per machine and database backed, with the keeper's routes `GET
/api/network/computer` and `POST /api/network/computer/:id`, the people's routes under `/api/machines/:id/access`, and
`GET /api/machines/here`. The tools take a machine. On each machine, its keeper (plan 5's data keeper and plan 5b's
worker keeper alike) asks its leader's app for its access and its commands, writes `computer.json` and the
`computer/<id>.json` files its updater already reads, and posts each answer back. The updater does not change. The
owner's seal: each person's ECDSA P-256 key is made in their browser and kept on the server only wrapped by their
password (`person_keys`, plan 5b's); the browser signs each opening, and a machine's keeper opens only on a grant its
pinned key verifies, so no row and no app on the server can open a pinned machine.

**Tech Stack:** TypeScript on Node 22; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite; React for the web app;
WebCrypto in the browser (ECDSA P-256, PBKDF2-SHA256, AES-GCM) and `node:crypto` in the keeper, no new package; bash and
BusyBox for `updater.sh` (unchanged but for comments); vitest with PGlite; Docker for `npm run test:real` and `npm run
test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` section 8 ("Computer access per machine"), with section 1's
"Open computer access gives the orchestrator root on that machine", section 2's card list ("computer access for that
machine") and the updater's row of 3.1; `notes/specs/2026-11-02-computer-access.md` (today's behavior, which this plan
keeps per machine). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 6's entry.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/computer-access` on a new branch `computer-access` from main
(`git worktree add`, then `npm ci` there once), after plan 5b is merged into main and shipped.

**Handed over** (merged and shipped before this plan starts):
- Today's code: `modules/computer/access.ts` (`ComputerAccess`, `ACCESS_MS`, `RUN_DEFAULT_S`, `RUN_MAX_S`, `WAIT_MS`,
  `ownsComputer`, `serverMachine`, `onMachine`), `modules/computer/routes.ts` (`/api/computer`, `/open`, `/close`,
  `/decline`), `modules/computer/tools.ts` (`ask_computer_access`, `computer`, `computer_result`, registered for the
  orchestrator alone in `modules/tools/mcp.ts`), `modules/tasks/decisions.ts` (`Decisions.computer`,
  `visibleDecisions`, `decisionOwner`), `modules/tasks/routes.ts` (`computerView`, `computerAccess` in `GET
  /api/requests`), `modules/tools/job.ts` (`ToolJob`, `jobOf`), `modules/conversation/prompt.ts` (`turnPrompt`),
  `modules/conversation/routes.ts` (`POST /api/agents/:id/messages`), `UpdaterControl.present()` (`/control/alive`
  within 30 s), `Person.via` (the orchestrator acting for the CEO), `apps/updater/updater.sh`'s `computer_runs` and
  `computer_open` (`untilSec`, `COMPUTER_MAX` 1800, `COMPUTER_OUTPUT` 30000), and in `apps/web`
  `ui/ComputerCard.tsx`, `screens/AgentWindow.tsx`, `screens/Tasks.tsx`, `screens/Shell.tsx` (`AccountMenu`),
  `screens/Machines.tsx`, `types.ts` (`ComputerView`, `ComputerAccessDecision`), the `window.computer*` strings.
- Plan 5: `findThisMachine(db, config)`, `askerOf(req, config)` (`{ own: true } | { own: false; machine }`), `VIA`,
  `OWN_VIA`, `fromTunnel`, the hidden `server:<machine id>` row of the company's owner with role `data`, plan 5's data
  keeper (`GET /api/network/peers` with `x-hornhoof-via: keeper` every `peerEveryMs`, its control folder `/control`),
  `net/peer-door.ts`'s `PeerDoor`; plan 1b's `overLink(req, config)`.
- Plan 5b: `machines.network_id` on every machine with a core (the `server:` row and each worker), `role`, `report_at`,
  `hostname`; `WorkerKeeper`, `WorkerConfig` (with `ownerKey`), `PeerLink.request` (sent as the keeper); the keeper's
  mark (its ruling 17: `KEEPER_MARK`, `keeperAsker`, the `PeerDoor`'s `x-hornhoof-keeper: 1`); `install.sh`'s
  `--owner-key` and `HORNHOOF_OWNER_KEY` in a core's `.env` and the keeper's environment (its ruling 18); the owner's
  key (its rulings 18 and 19): `person_keys`, `machines.owner_pin`, `modules/computer/owner-key.ts` (`KEY_ITERATIONS`,
  `keyPrint`, `isP256`), `modules/computer/keys.ts` (`keyRoutes`: `GET` and `PUT /api/me/key`), `reinvite` deleting the
  key, `modules/keeper/owner-pin.ts` (`PIN_FILE`, `readPin`, `pinKey`), the worker's pin at a redeemed ticket and the
  report's `pin` setting `owner_pin`, and in `apps/web` `owner-key.ts` (`StoredKey`, `DeviceKey`, `KeyStore`,
  `browserKeyStore`, `KeyDeps`, `keyDefaults`, `serverKey`, `deviceKey`, `makeKey`, `withOwnerKey`, `forgetOwnerKey`),
  `ui/PasswordPrompt.tsx` (`PasswordPrompt` with purpose `make`, `useOwnerKey().publicKey`) and `CommandBox` adding
  `--owner-key` to every join command; `revokeMachineRows` in Disconnect; `GET /api/machines` with `core`, `needsCore`
  and `builtin.webPort`; `HORNHOOF_HOST_OS` in `.env`; compose's keeper environment list; `HIDDEN`, `CLOSED` (plan 3);
  `realDatabase`, `migrateDb`, `openDb` (plans 3 and 4); the lab (`apps/server/test/lab/`, `npm run test:lab`).
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges and hosts under
  `hornhoof.test`.
- No new npm dependency: the seal uses WebCrypto in the browser and `node:crypto` on the server. One new migration:
  `0051_computer_access` by `npx drizzle-kit generate --name computer_access` from `apps/server`.
- Ivan's rule: only a machine's owner opens access to it, on their own session; nobody else, the CEO included. A
  turn of the orchestrator, a forged header, another person's session, a row written with SQL or an app on a taken
  server never opens it: a machine's keeper opens only on its owner's signed grant (ruling 13).
- Ivan's rule: no step of this plan asks Ivan to type a command; the orchestrator's tools never ask anyone to, as
  today.
- Messages between keepers and the app change only by additions; a keeper one version apart keeps working, and fails
  toward closed access, never toward open.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`. Types, from the worktree root: `npx tsc -p apps/server/tsconfig.json --noEmit`, and `apps/web`
  likewise when touched, each printing nothing. `bash -n` and `shellcheck` on `apps/updater/updater.sh` print nothing
  when it is touched. Never run prettier.

## Rulings made while planning

1. **Access belongs to a machine with a core.** The machines that can have access are the live rows with a
   `network_id`: the server's hidden `server:` row and each worker. A machine without a core (a node-only join, a Mac
   without Docker) has none; its card keeps plan 5b's "Make <host> a full machine of the company", and the tools say
   so. On the Machines tab the server's card (`builtin`) carries the `server:` row's access.
2. **Only the machine's owner opens it, and declines a request for it.** The owner is the row's `person_id`, active,
   on their own session (`me.via` unset); the `server:` row is the company owner's (plan 5), so the CEO opens the
   server's machine and nobody else's. Every other person, a person who sees the whole company, the CEO on another
   person's machine and the orchestrator get 403 `not_machine_owner`; a disabled owner is signed out (401). Closing
   takes power away, so the owner or the CEO closes; nobody else does. (Deviation to rule on: the spec names only who
   opens.) Opening checks again inside its transaction, under the locks Disable and Disconnect take, in their order:
   the person's row, then the machine's row, then its `machine_access` row.
3. **The state is a table the leader's app alone writes.** `machine_access(machine_id, until, asked_reason, asked_at,
   opened_by, opened_at)`, hidden from agents' SQL and closed (plan 3's `HIDDEN` and `CLOSED`), so no agent opens
   access by writing a row. Each keeper writes its own `computer.json` from what the app answers it; its updater still
   checks `untilSec` before each command and while it runs, exactly as today.
4. **Commands are rows, which keepers fetch.** `computer_runs` holds each command, its machine, the job that asked,
   its state (`waiting`, `sent`, `done`, `lost`), its exit code and the last 30 000 characters of its output. The
   app writes it `waiting`; the target machine's keeper takes it while that machine's access is open (`sent`), writes
   `computer/<id>.json`, and posts the `.out.json` answer back (`done`). The spec says only that commands go app to
   keeper to updater; a table, rather than memory, carries them across the peer link and across an app restart.
   (Deviation to rule on.) Each ask of a keeper names the runs whose files it still holds; a `sent` run stays `sent`
   while its keeper holds it, however long its updater is away, and becomes `lost` only when an ask 30 s or more after
   it was sent does not hold it (the keeper never got it, or lost its file). `lost` means the outcome is unknown, and a
   run is never sent twice. A machine gets its next run only once none of its runs is `sent`, since its updater runs
   one at a time anyway.
5. **Keepers ask, the app never calls a keeper.** The peer link's HTTP/2 requests go from the worker to the data
   machine, so every keeper, the server's own included, asks `GET /api/network/computer` every 2 s while its machine's
   access is open or a run of it is out, else every 15 s. The answer carries the access and the runs to take. The app
   keeps in memory when each machine last asked with its updater alive; a machine is reachable when that was within a
   minute. Nothing of this polling is written to the database. A keeper's carrier runs from the keeper's start, in every
   mode, each request bounded at 10 s; one that has had no answer (200 or 404) for 60 s since its start or its last
   answer writes `computer.json` closed: when it cannot hear a close, it closes. While the app does not lead
   (`ctx.mode`), these routes answer 503, which is no answer. Only a keeper's own request reaches these routes: plan
   5b's mark (its ruling 17), as for its own peer routes; a person's request through a worker's web port still names
   that worker (ruling 8), but never as its keeper.
6. **The tools take a machine.** `machines` lists the company's machines with a core: name, id, role, owner, system,
   whether it holds the data, whether it is reachable, until when access is open, and a request waiting.
   `ask_computer_access(machine?, reason)`, `computer(machine?, command, timeoutSeconds?)` and `computer_result(id)`
   take the machine by id or by name (case-insensitive, unique among them); left out, it is the server's machine, as
   today. `computer` runs only while that machine's access is open, and only in a turn that answers the CEO (as
   today) or one the machine's owner started (`jobs.created_by`: their message, or the note of their open) into which
   no other words came. A new `jobs.others_spoke`, which agents' SQL cannot change (plan 3's grants let it change only
   a turn's status), is set and committed before any words of anyone but the turn's creator go into a running turn
   (`sayLive`); `computer` reads it under the job row's lock in the transaction that makes the run. So the owner
   directs commands on their machine, and the CEO, who directs the orchestrator, too, once the owner opened it. One
   limit: whoever owns the orchestrator's subscription runs its program on their own machine and can type into it
   there, outside Hornhoof; Hornhoof cannot tell those words from the turn's. (Deviation to rule on: the spec says only
   who opens.)
7. **The card says what it gives.** On every machine: "Open access lets the orchestrator change anything on
   <machine>."; on a machine of the role `data`, "..., the company's data included."; on a Mac, "On a Mac this reaches
   Docker's Linux system, not macOS itself."; on a machine whose system is not known, "If <machine> is a Mac, this
   reaches Docker's Linux system, not macOS itself." The system is the keeper's `HORNHOOF_HOST_OS` (reported), else the
   row's `os` from the node's join. A native macOS helper is later (spec).
8. **Where a person sits.** A request whose `Host` is `localhost`, `127.0.0.1` or `[::1]` (any port), with no
   `x-forwarded-host` or one of those, that did not come over the link (plan 1b's `overLink` false), came from the
   machine whose front door passed it: the worker when plan 5's `PeerDoor` named one in `x-hornhoof-via` without the
   keeper's mark (ruling 5), else the server's machine. The account menu offers "Give the orchestrator access to this
   machine (<machine>)" to that machine's owner while it is reachable and closed. A person's message to the orchestrator
   from there carries one line for the orchestrator, "<name> writes this from <machine>; access to it is open until
   18:20." (or "...is closed."), which is how it is told where the CEO sits. A forged `Host` gains nothing: opening
   still needs the owner's session.
9. **Disconnect closes access.** In plan 5b's `revokeMachineRows`: the machine's `machine_access` row goes, its
   `waiting` runs end `done` with exit 126 and "Access to <machine> is closed.", its `sent` runs `lost`. Disabling a
   person disconnects their machines (today's code), so it closes theirs too.
10. **An open window on the server survives this update; a new build closes the others.** The keeper writes
   `computer.json` with `by: "keeper"`; an app before this plan writes it without. Whichever of the app and the data
   keeper starts first and finds a `computer.json` without `by` moves it, by one rename, to `computer.legacy.json`; the
   keeper then writes `computer.json` closed, so an open window waits for the import below. The first time the app leads
   after its start (plan 3's fence lets it write only then), before it serves any computer route, it imports
   `computer.legacy.json` into the server's machine row (open until that `untilSec` when it is ahead, `opened_by` the
   company's owner, else closed; its `asked` as the request), commits, and deletes the file; the routes answer 503 until
   that is done. This covers the first update and a step back to plan 5b's build and forward again, where the old app
   wrote the file. And when the data keeper's report (plan 5's `POST /api/network/report`) brings a `commit` other than
   the one its row holds, a new build leads: in the same transaction every other machine's access closes and its waiting
   runs end, since no owner could close it while the leader changed. The app never writes `computer.json` or `computer/`
   files.
11. **One version apart.** A keeper that gets 404 from `GET /api/network/computer` (an app before this plan) writes
   `computer.json` closed and asks again at 15 s; a failed read keeps what it wrote for 60 s, then closes it. A keeper
   before this plan never asks and never sends the keeper's mark, so its machine is not reachable until it follows the
   build (plan 5b). Until plan 9 the server's machine is the one data machine, and it leads; a data machine that does
   not lead comes with plan 9, which carries its access. `GET /api/computer` and `POST /api/computer/open|close|decline`
   stay, as the server's machine's, under ruling 2.
12. **The rehearsal runs a command only on the team lead's stand.** On Ivan's companies the team lead reads; whether to
   open access on his machines is Ivan's, and no step asks him to.
13. **The owner's seal.** A machine's keeper opens its computer only on a grant signed by its owner's key, so nothing
    the app or the database holds can open it: not a row written with SQL, not an app run on a taken server. A grant is
    `{ payload, signature }`: the payload the UTF-8 JSON `{"v":1,"machine":"<network id>","until":<s>,"at":<s>,
    "nonce":"<16 random bytes, base64url>"}` exactly as signed, the signature ECDSA P-256 with SHA-256 in its IEEE P1363
    form (64 bytes, base64url), as WebCrypto gives it (`node:crypto` checks it with `dsaEncoding: 'ieee-p1363'`). A
    keeper takes one only when it verifies against its pin, `machine` is its own network id, `at` is at most 5 minutes
    ahead of its clock, `until` is ahead and at most `at` + 24 hours + 5 minutes, and its nonce is not spent. It keeps
    the grant it holds while the app sends it again; a grant that ends (the app answers closed, its `until` passes, or
    another takes its place) spends its nonce, kept in the keeper's volume until that `until`, so no old grant opens it
    again. It is open until the earlier of the grant's `until` and the app's; the app alone closes it, at any time,
    since closing takes power away. The pin is plan 5b's (its ruling 18): a worker's keeper pins the key its owner's
    command carried when it redeems that ticket, and no answer ever gives one; since every join command carries the key,
    every worker holds one. A worker without a pin opens nothing, and its card tells its owner in one line. The data
    keeper takes the same rule once it holds a pin (its `HORNHOOF_OWNER_KEY`, which a later plan's join of a data
    machine writes); until then the server's machine, whose database is its own, takes its app's word, and ruling 10
    carries its open window. ECDSA P-256 rather than Ed25519: P-256 has been in WebCrypto in every browser for a decade,
    and Node verifies it alike. (Ruled by the lead.)
14. **The key is made in the browser and kept on the server only wrapped.** Plan 5b makes it (its ruling 19: ECDSA
    P-256, wrapped by PBKDF2-SHA256 at 600 000 iterations and AES-GCM, `person_keys`) the first time a join command is
    shown, and every join command carries it. This plan uses it: on a device that does not hold it, the browser asks for
    the password once at the first opening, unwraps the key as a non-extractable `CryptoKey`, and keeps it in IndexedDB
    as plan 5b keeps the one it made, until sign-out, the app's 401 `signed_out`, or a public key on the server that is
    not its own; so each later opening on that device and origin is one click. It signs each opening (ruling 13).
15. **A reset takes the key away.** Hornhoof has no password change today, only the reset: a new invite (`reinvite`),
    which ends the person's sessions and, since plan 5b, deletes the person's `person_keys` row, so the old wrapped key
    cannot be used, and the browser drops its stored key at the 401 that follows. Signed in again, the owner makes a new
    key when a join command is next shown; each of their machines takes it only from a new command run there, and until
    then its card says so in one line (`computerKeyNotHeld`). Whoever reset the password, or accepted the invite in the
    owner's stead, can make a key in the owner's name, but no machine takes it without a command run on that machine, so
    a reset never lets anyone else sign for that owner. A password change, when Hornhoof gets one, rewraps the same key
    in the browser with the old and the new password.
16. **What the seal does not close.** JavaScript changed on a fully taken server could capture the password the next
    time the owner types it, or sign with the key held in the owner's browser. This plan does not try to close that.
    It closes the cheap path: rows written with SQL, and an app that answers keepers as it likes. A taken server can
    also keep from a keeper the close its owner pressed, so a window the owner opened can last to its grant's `until`,
    a day at most: the owner signed that long.

## Review Focus

1. Opening by anyone but the machine's owner on their own session: the CEO on another person's worker, a person who
   sees the whole company, a department's person, the orchestrator through its token (`me.via`), a disabled owner, a
   request with a forged `Host` or `x-hornhoof-via`. Each is 403 and writes nothing. Tests in Task 2 (`opens only for
   the machine's owner`).
2. Agents' SQL never reaches `machine_access` or `computer_runs`, also when granted after a downgrade. Tests in Task 1.
3. A command never runs on a machine whose access is closed: closed in the table, closed after the run was taken (the
   keeper writes `computer.json` closed at its next round, 2 s while open, and the updater stops it within a second), a
   404 from an older app, a machine disconnected meanwhile. Tests in Task 2 (`refuses and ends runs when access closes`)
   and Task 4.
4. A command runs at most once: a keeper or app restarted between taking and answering, an answer posted twice, a
   run file left from before. Tests in Task 4 (`runs each command once`).
5. A run lands only on its machine, and its answer comes only from its keeper: a keeper takes only its own machine's
   runs, an answer for another machine's run is 404, and a request through a worker's web port (from its browser or
   its LAN), which reaches the leader as that worker but without the keeper's mark, gets 403 and takes nothing. Tests
   in Task 2 (`keeps each machine's runs to its keeper`) and Task 4 (`carries computer access over the peer link`); the
   mark itself is plan 5b's.
6. Words that direct commands on another person's machine come only from its owner or the CEO: another person's
   message, an employee's words or a task's wake into the owner's running turn, the orchestrator editing its own
   events or jobs through SQL. Tests in Task 1 (`keeps others_spoke out of agents' reach`) and Task 3 (`runs only in a
   turn that answers the CEO or the machine's owner`).
7. A machine opens only on its owner's grant: a `machine_access` row written with SQL, an old grant sent again after a
   close, a grant for another machine, one past its `until` or longer than a day, one signed by another key (the
   CEO's, or the owner's new key after a reset and before a new command), a pin offered in any answer, a ticket of
   another person that failed. Each leaves the keeper closed and runs nothing. Tests in Task 2 (`opens a pinned
   machine only with its owner's grant`), Task 4 (`opens only on its owner's grant`) and Task 7's rehearsal (writes
   with `psql`); the pin's own tests are plan 5b's (`pins only from a redeemed ticket`).

---

### Task 1: The tables for access per machine

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** main with plan 5b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts
test/orchestrator-control.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/drizzle/0051_computer_access.sql` (with its `meta` files)
- Modify: `apps/server/src/db/schema.ts` (the two tables, `jobs.others_spoke`),
  `apps/server/src/db/agent-sql.ts`
  (`HIDDEN`), `apps/server/src/modules/tools/database.ts` (`CLOSED`)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/orchestrator-control.test.ts`

**Interfaces:**
- Produces, in `db/schema.ts`:
  ```ts
  export const RUN_STATES = ['waiting', 'sent', 'done', 'lost'] as const;
  export type RunState = (typeof RUN_STATES)[number];
  export const machineAccess = pgTable('machine_access', {
    machineId: uuid('machine_id').primaryKey().references(() => machines.id),
    companyId: companyId(),
    until: timestamp('until', { withTimezone: true }),            // open while in the future
    askedReason: text('asked_reason'),                              // at most 500 characters, as the tool takes
    askedAt: timestamp('asked_at', { withTimezone: true }),
    openedBy: uuid('opened_by').references(() => people.id),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    grant: jsonb('grant').$type<{ payload: string; signature: string }>(),   // the owner's signed grant (ruling 13)
  }, () => [check('machine_access_asked', sql`(asked_reason IS NULL) = (asked_at IS NULL)`)]).enableRLS();
  export const computerRuns = pgTable('computer_runs', {
    id: id(),
    companyId: companyId(),
    machineId: uuid('machine_id').notNull().references(() => machines.id),
    jobId: uuid('job_id').references(() => jobs.id),
    agentId: uuid('agent_id').references(() => agents.id),
    command: text('command').notNull(),                             // at most 20 000 characters, as the tool takes
    timeoutS: integer('timeout_s').notNull(),
    state: text('state', { enum: RUN_STATES }).notNull().default('waiting'),
    exit: integer('exit'),
    output: text('output'),                                         // the last 30 000 characters
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
  }, t => [index('computer_runs_machine_state').on(t.machineId, t.state),
    check('computer_runs_state', sql`state IN ('waiting', 'sent', 'done', 'lost')`),
    check('computer_runs_timeout', sql`timeout_s BETWEEN 1 AND 1800`)]).enableRLS();
  ```
  `jobs` gains `othersSpoke: boolean('others_spoke').notNull().default(false)` (ruling 6). When the generated SQL
  lacks a check or `ENABLE ROW LEVEL SECURITY`, the agent stops and reports.
- `HIDDEN` gains `'machine_access'` and `'computer_runs'`; `CLOSED`'s sentence adds "the machines' computer access and
  the commands run there".

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0051`, `adds access per machine, journaled and closed`: after migrating fully and
    `AFTER_MIGRATIONS`, both tables exist with a `net_journal` trigger and `relrowsecurity` true; `computer_runs.state`
    refuses `queued` and `timeout_s` refuses `0` and `1801` with `23514`; a `machine_access` row with a reason and no
    `asked_at` fails with `23514`.
  - `orchestrator-control.test.ts`: the hidden-table cases gain both tables; `stays out of computer access when
    granted it`: with a row in each and the orchestrator's role granted `SELECT, INSERT, UPDATE, DELETE` on them, as
    plan 5's grant builder would after a downgrade, `SELECT` returns no row and `INSERT` fails with `42501`; `keeps
    others_spoke out of agents' reach`: the orchestrator's role reads `jobs.others_spoke` and its `UPDATE jobs SET
    others_spoke = false` fails with `42501`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name computer_access`, then `HIDDEN` and
  `CLOSED`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the tables for computer access per machine and the commands run there".

### Task 2: The server's side: access per machine, runs, routes and decisions

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/computer.test.ts test/decisions.test.ts
test/network-join.test.ts test/nodes.test.ts test/grant.test.ts test/owner-keys.test.ts` passes,
then the whole server suite; from the worktree root `npm run test:real` passes; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/computer/grant.ts`
- Modify: `apps/server/src/modules/computer/access.ts` (rewritten per machine),
  `apps/server/src/modules/computer/routes.ts`, `apps/server/src/modules/network/routes.ts` (the keeper's two routes),
  `apps/server/src/modules/computer/keys.ts` (a new key is published), `apps/server/src/modules/network/join.ts`
  (`revokeMachineRows`), `apps/server/src/modules/tasks/decisions.ts`, `apps/server/src/modules/tasks/routes.ts`,
  `apps/server/src/modules/nodes/routes.ts` (`GET /api/machines` gains `access`), `apps/server/src/app.ts`
  (`ctx.computer`), `apps/server/src/errors.ts` (reasons), `apps/server/src/modules/events/stream.ts` (who hears `{
  type: 'computer' }`), `apps/server/src/modules/computer/tools.ts` (kept working on the server's machine until Task 3)
- Test: `apps/server/test/computer.test.ts` (rewritten per machine), `apps/server/test/decisions.test.ts`,
  `apps/server/test/network-join.test.ts`, `apps/server/test/nodes.test.ts`, `apps/server/test/grant.test.ts` (new),
  `apps/server/test/owner-keys.test.ts` (plan 5b's), `apps/server/test/real/computer-races.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's tables; plan 5's `findThisMachine`, `askerOf`, `VIA`, `POST /api/network/report`; plan 5b's
  `revokeMachineRows`, `GET /api/machines`, `keeperAsker`, `KEEPER_MARK`, `person_keys`, `owner_pin`, `keyPrint`,
  `keyRoutes`; plan 1b's `overLink`; plan 2's `ctx.mode`; `enqueueTurn`, `appendEvent`, `orchestratorOf`.
- Produces, in `modules/computer/access.ts` (`ComputerAccess`, `ownsComputer` and `serverMachine` go; `ACCESS_MS`,
  `RUN_DEFAULT_S`, `RUN_MAX_S`, `WAIT_MS`, `onMachine` stay):
  ```ts
  export const SEEN_MS = 60_000;                  // a machine is reachable when its keeper asked within this
  export const RUN_KEEP_MS = 24 * 3_600_000;      // done and lost runs are deleted after this
  export const HELD_GRACE_S = 30;                 // a sent run its keeper does not hold this long after sent_at is lost
  export const OUTPUT_MAX = 30_000;
  export const LEGACY_FILE = 'computer.legacy.json';
  export type AccessMachine = { id: string; networkId: string; name: string; personId: string; role: MachineRole | null; os: 'linux' | 'darwin' | null; data: boolean };
  export type AccessView = {
    machine: AccessMachine; reachable: boolean; until: string | null; asked: { reason: string; at: string } | null;
    canOpen: boolean; canClose: boolean;          // for the person who asks: ruling 2
    key: 'not_needed' | 'held' | 'not_held';      // ruling 13: whether opening needs a grant, and whether the machine
                                                  //   holds the key of its owner on the server now
  };
  export type RunResult = { exit: number; output: string };
  export type Waited = RunResult | 'running' | 'gone';
  export class Computers {
    constructor(ctx: Pick<Ctx, 'db' | 'config' | 'log'>, opts?: { now?: () => Date });
    machines(companyId: string): Promise<AccessMachine[]>;
    //   live rows of the company with a network_id; name: hostname, else 'the company server' for a server: row;
    //   data: role is 'data'
    find(companyId: string, nameOrId?: string): Promise<AccessMachine | 'none' | 'ambiguous'>;
    //   by id, else by name case-insensitively among machines(); left out, findThisMachine's
    seen(machineId: string, updaterAlive: boolean): void;   // a keeper asked
    reachable(machineId: string): boolean;                   // asked with its updater alive within SEEN_MS
    openUntil(machineId: string): Promise<string | null>;
    views(me: Person): Promise<AccessView[]>;                // every machine me may open or close, or that asks me
    view(me: Person, machineId: string): Promise<AccessView | null>;
    ask(machineId: string, reason: string): Promise<void>;
    open(me: Person, machineId: string, grant?: Grant): Promise<{ until: string; asked: { reason: string; at: string } | null }>;
    close(me: Person, machineId: string): Promise<void>;     // also ends its waiting runs (exit 126)
    decline(me: Person, machineId: string): Promise<boolean>;
    start(job: { id: string; agentId: string; companyId: string }, machineId: string, command: string, timeoutS: number): Promise<string>;
    wait(runId: string, companyId: string, ms?: number): Promise<Waited>;   // polls the row every 500 ms
    take(machineId: string, held: string[]): Promise<{ access: { untilSec: number; until: string; grant: Grant | null } | null; runs: { id: string; command: string; timeout: number }[] }>;
    answer(machineId: string, runId: string, result: RunResult): Promise<boolean>;   // false: no sent run of it
    moveLegacy(controlDir: string): void;                    // ruling 10, at start, before the app listens
    importLegacy(controlDir: string): Promise<void>;         // ruling 10, the first time the app leads
    ready(): boolean;                                        // importLegacy done; until then the routes answer 503
    newBuild(tx: Db, serverMachineId: string): Promise<void>;   // ruling 10: every other machine closed
    here(req: FastifyRequest, companyId: string): Promise<AccessMachine | null>;   // ruling 8
  }
  export function canOpen(me: Person, m: Pick<AccessMachine, 'personId'>): boolean;   // me.id is personId, active, !me.via
  export function canClose(me: Person, m: Pick<AccessMachine, 'personId'>): boolean;  // canOpen, or me.isOwner && !me.via
  // errors.ts: ErrorReason gains 'not_machine_owner' | 'machine_unreachable' | 'no_core' | 'grant_needed' |
  //   'bad_grant' | 'key_not_held' | 'no_key'
  // modules/computer/grant.ts, ruling 13, used by the app and by the keeper (Task 4)
  export const GRANT_SKEW_S = 300;
  export const GRANT_MAX_S = 24 * 3600 + GRANT_SKEW_S;
  export type Grant = { payload: string; signature: string };
  export type GrantFacts = { v: 1; machine: string; until: number; at: number; nonce: string };
  export function readGrant(grant: Grant, publicKey: string, machine: string, nowS: number): GrantFacts | null;
  //   the signature (ECDSA P-256, SHA-256, dsaEncoding 'ieee-p1363') against publicKey (SPKI DER, base64url), then
  //   exactly the five fields, v 1, machine the given network id, nonce 22 base64url characters, at <= nowS + 300,
  //   nowS < until <= at + GRANT_MAX_S; anything else, a throw included, null
  ```
- Plan 5b's `PUT /api/me/key`, once it writes a row, and a report whose `pin` changes `owner_pin` each publish `{ type:
  'computer' }`, so the screens load the views' `key` again.
- `open` with a machine whose keeper reported a pin (`owner_pin` set) or that is not the server's machine needs a grant
  (ruling 13): none is 400 `grant_needed`; `me` with no `person_keys` row is 409 `no_key`; `readGrant(grant, me's
  publicKey, the row's network_id, now)` null is 400 `bad_grant`; `keyPrint(me's publicKey)` other than `owner_pin`
  is 409 `key_not_held` "<machine> does not hold your key yet. Run a new command from Connect a machine on it: it
  takes your key only from there."; then `until` is the grant's and the grant is stored. On the server's machine with
  no pin, `until` is now + `ACCESS_MS` as before, and a grant sent is checked the same way and stored. `key` in a view:
  `not_needed` for the server's machine with no pin, `held` when `owner_pin` is `keyPrint` of its owner's key, else
  `not_held`. `take` answers the stored grant with the access; closing clears it.
- `ctx.computer` becomes `Computers`. `open` throws 403 `forbidden` 'Only the owner of <machine> opens access to it.'
  (`not_machine_owner`) unless `canOpen`; 404 `no_core` for a machine that is not one of `machines()`; 409 `conflict`
  "Hornhoof cannot reach <machine> now: its core has not answered for a minute." (`machine_unreachable`) unless
  `reachable`. In one transaction it locks `me`'s `people` row `FOR SHARE`, then the `machines` row `FOR UPDATE`, then
  the `machine_access` row, and checks again that the person is active, the row live with a `network_id` and its
  `person_id` `me.id`; then it upserts the row with `until` (the grant's, else now + `ACCESS_MS`), the grant,
  `opened_by`, `opened_at`, clears the request, and answers what was asked. `close`, `decline`, `take`, `answer`,
  `newBuild` and `revokeMachineRows` lock in the same order (the `machines` row before its `machine_access` row and
  runs). `close` and `decline` take `canClose` and `canOpen`.
- Every change publishes `{ type: 'computer' }` to the company and appends a `computer` event to the orchestrator's
  window with `machine` (`onMachine`) and the person, as today's routes do. `events/stream.ts` sends `{ type:
  'computer' }`, which carries nothing, to everyone in the company (today only to the CEO), so each person's screens
  load their own views again. An open that answers a request enqueues
  the note turn with `createdBy: me.id` and `answersCeo` when `me` is the CEO: "<Person> opened access to <machine>
  until <until>. Go on with what you asked it for: <reason>".
- `take(machineId, held)`, in one transaction: first each `sent` run of the machine not in `held` whose `sent_at` is
  `HELD_GRACE_S` or more ago becomes `lost` (a `sent` run in `held` stays `sent`, however old), and the company's
  `done` and `lost` runs older than `RUN_KEEP_MS` go; then the row's access; when open and none of the machine's runs
  is `sent`, its oldest `waiting` run set `sent` with `sent_at` now and returned (so `runs` holds at most one); when
  closed, every `waiting` run of it ends `done`, exit 126, output "Access to <machine> is closed." `answer` sets
  `done`, `done_at`, `exit` and the last `OUTPUT_MAX` characters of `output` only for a `sent` run of that machine.
  `wait` on a `sent` run of a machine that is not reachable answers `running`, and the tool says so (Task 3).
- Routes, in `modules/network/routes.ts`, each first `keeperAsker(req, config)` (403 `not_keeper` as plan 5's routes
  otherwise), the machine being the asker's live row with a `network_id` (`findThisMachine` for `own`; 404
  `not_a_machine` otherwise):
  - Both answer 503 `unavailable` while `ctx.mode.current()` is not `lead` or `ready()` is false.
  - `GET /api/network/computer?updater=1|0&held=<ids>` (`held`: up to 8 uuids, comma separated, else 400):
    `seen(machine, updater === '1')`, then `take(machine, held)`, answered as JSON.
  - `POST /api/network/computer/:id`, `bodyLimit` 256 KiB, body `{ exit: integer 0..255, output: string }`:
    `answer`; 204, or 404 `not_found`.
- Routes for people, in `modules/computer/routes.ts`:
  - `GET /api/machines/access`: `views(me)`.
  - `POST /api/machines/:id/access/open`, `/close`, `/decline`: as above, answering `view(me, id)`; `open`'s body is
    `{ grant?: { payload, signature } }`, each a string of at most 4096, else 400.
  - `GET /api/machines/here`: `{ machine: AccessMachine | null, view: AccessView | null }` by ruling 8.
  - `GET /api/computer` and `POST /api/computer/open|close|decline` stay, for the server's machine
    (`findThisMachine`), answering its `view` in today's `ComputerView` shape plus `machineId`.
- `GET /api/machines` (plan 5b): each machine and `builtin` gain `access: AccessView | null` (the server's card the
  `server:` row's).
- Plan 5's `POST /api/network/report`: for `own`, when the body's `commit` differs from the row's stored `commit`,
  `newBuild(tx, row)` in the same transaction (ruling 10): every other machine's `until` null, its waiting runs `done`
  with exit 126.
- `computer/tools.ts` keeps today's tools working on the server's machine (`find(companyId)`, `start`, `wait`,
  `reachable`) so this task's suite passes; Task 3 rewrites them.
- `Decisions.computer` becomes `computers: { machine: AccessMachine; asked: { reason: string; at: string }; agentId:
  string; ownerPersonId: string }[]`, one per machine with a request whose owner is `me` (`ownerPersonId` the row's
  `person_id`), counted as today; `GET /api/requests` answers `computerAccess: ComputerAccessDecision[]` with `id` the
  machine's id and `view` its `AccessView`. `decisionOwner`'s `computer_access` case goes, and so does its case in
  `decisions.test.ts`.
- `revokeMachineRows` (plan 5b) also deletes the machines' `machine_access` rows, ends their `waiting` runs `done`
  with exit 126 and "Access to <machine> is closed.", and sets their `sent` runs `lost`.
- Ruling 10, in `app.ts`: `moveLegacy(config.controlDir)` at start before the app listens (a rename of a
  `computer.json` without `by` to `LEGACY_FILE`, never over an existing one; a missing file or a lost race is
  nothing); `importLegacy` the first time `ctx.mode.current()` is `lead`, retried on the next second while it fails:
  with `LEGACY_FILE` and a row from `findThisMachine`, in one transaction that row's `until` (the file's `untilSec`
  when ahead, else null), `opened_by` (the company's owner when open) and request (the file's `asked`) are set; after
  the commit the file is deleted, then `ready()` is true. Without the file, or without the row, it is ready at once and
  the file stays for a later start.

- [ ] **Step 1: Write failing tests.** `computer.test.ts` keeps today's file's setup (a company with a running
  orchestrator turn), with plan 5b's worker rows made directly in the database (a `network_id`, role `worker`, a
  person, and `owner_pin` the print of that person's key, made with `globalThis.crypto.subtle` as the browser makes it,
  with their `person_keys` row), `ctx.computer.seen(id, true)` for reachable ones, and a helper that signs a grant as
  the browser does; an owner's open of a worker below carries their grant:
  - `opens only for the machine's owner`: on the server's machine the CEO opens; on Marat's worker only Marat opens,
    and the CEO, a person who sees the whole company, a department's person, the orchestrator through its headers
    (`orchestratorHeaders`) each get 403 `not_machine_owner` and write no row, and Marat once disabled gets 401
    `signed_out`; the same with `host: localhost:8080` and `x-hornhoof-via: <Marat's worker>` from the keeper's
    address; `decline` likewise.
  - `lets the CEO close any machine's access`: the CEO closes Marat's open worker; another person gets 403.
  - `asks for a named machine and opens for a day`: an ask for Marat's worker shows in Marat's `GET
    /api/machines/access` and `GET /api/requests` (`computerAccess` with that machine's id) and in no one else's;
    Marat's open sets `until` to his grant's, a day on, clears the request, appends `computer` events naming the
    machine, and enqueues the note with `created_by` Marat and `answers_ceo` false.
  - `refuses and ends runs when access closes`: open, a run started, `close`: the run is `done` with exit 126; a
    closed machine's `take` answers `access: null` and ends a waiting run so.
  - `keeps each machine's runs to its keeper`, each request from the keeper's address: runs for the server's machine
    and for a worker, both open: `GET /api/network/computer` with `x-hornhoof-via: keeper` takes only the server's,
    with `x-hornhoof-via: <worker>` and `x-hornhoof-keeper: 1` only the worker's; with `x-hornhoof-via: <worker>` and
    no mark (a person through the worker's web port) 403 and the run stays `waiting`; the worker's keeper posting an
    answer for the server's run gets 404 and changes nothing.
  - `takes one run at a time`: three runs for one open machine: the first `take` gives the oldest, the next gives
    none until it is answered, then the second.
  - `answers a run once and keeps one its keeper holds`: a sent run answered twice: the second 404; a sent run the
    keeper names in `held` stays `sent` an hour later (fake clock) and the machine gets no next run; one it stops
    naming 31 s after `sent_at` is `lost`, `wait` on it says `gone`, and it is never sent again.
  - `tells where a person sits`: `GET /api/machines/here` with `host: localhost:8080` and no via gives the server's
    machine; with `x-hornhoof-via: <worker>` from the keeper's address and `host: localhost:8081` the worker; with
    `host: 192.0.2.5:8080`, with `x-forwarded-host: corp.hornhoof.test`, or over the link (`viaLink()`), null.
  - `opens a pinned machine only with its owner's grant`: Marat's worker with `owner_pin` the print of Marat's key
    (made in the test with `globalThis.crypto.subtle` as the browser makes it, and his `person_keys` row): his open with
    no grant is 400 `grant_needed`; with a grant signed by the CEO's key, for another machine's network id, with
    `until` two days on, or with `at` an hour ahead, 400 `bad_grant`; with his good grant, open until its `until`, and
    `GET /api/network/computer` as his keeper answers that grant; once his `person_keys` row is replaced by a new key,
    his grant by the new key is 409 `key_not_held`; a worker with no `owner_pin` is 409 `key_not_held` and its view's
    `key` is `not_held`; the server's machine with no pin opens without a grant (`key` `not_needed`).
  - `grant.test.ts`: `reads a grant as the browser signs it`: a grant made with WebCrypto (`ECDSA`, `P-256`,
    `SHA-256`) reads back its five fields; one byte changed in the payload or the signature, a sixth field, `v` 2, a
    nonce of 21 characters, `until` equal to `at` + `GRANT_MAX_S` + 1, `until` in the past and a DER signature in place
    of P1363 each give null.
  - `owner-keys.test.ts` (plan 5b's), `tells the screens of a new key`: a `PUT` that writes a key reaches Marat's event
    stream as `{ type: 'computer' }`, and so does a worker's report that changes its `owner_pin`.
  - `carries what an older app wrote, once it leads`: a `computer.json` with no `by`, `untilSec` in an hour and an
    `asked`: at start it is moved to `computer.legacy.json`; while `ctx.mode` is not `lead` nothing is written and `GET
    /api/network/computer` answers 503; once it leads the server's machine is open until then with that request, the
    legacy file is gone, and a second start changes nothing (the owner's close in between stays); the same file with
    `untilSec` null closes the server's machine; with `by: "keeper"` nothing moves.
  - `closes other machines when a new build leads`: an open worker; the data keeper's report with the stored `commit`
    changes nothing; with another `commit` the worker is closed and its waiting run `done` with exit 126, and the
    server's machine stays open.
  - `opens nothing for a machine that is not the asker's`: every route of this task with every header a page, a link
    visitor or a peer can send changes no other machine's row or run (Review Focus 6).
  - `tells every person to look again`: a `computer` change reaches Marat's event stream, not only the CEO's.
  - `is not reachable without its keeper`: a worker never seen, or seen 61 s ago (fake clock), gives 409
    `machine_unreachable` on open; a machine without `network_id` 404 `no_core`.
  - `decisions.test.ts`: the request for a worker counts for its owner and shows in no other person's list.
  - `network-join.test.ts`, `cuts a disconnected machine off`, extended: a disconnected worker's access row is gone,
    its waiting run `done` with exit 126 and its sent run `lost`.
  - `nodes.test.ts`, `shows each machine's access`: `GET /api/machines` gives each core machine and `builtin` their
    `access`, with `canOpen` true only for the owner.
  - `real/computer-races.test.ts`, on a `realDatabase()` migrated with `migrateDb` and two `openDb` connections: a
    `take` and a `close` of the same machine started together leave every run either `sent` before the close or
    `done` with exit 126, never `sent` after the close committed; two `take`s started together give each run to one;
    an `open` paused after its first checks while Marat is disabled and his machine disconnected, then resumed, writes
    no row; an `open` and a Disconnect started together leave no `machine_access` row for the revoked machine.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above, with the lock order of `open`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep computer access per machine, opened only by its owner, with commands its keeper takes".

### Task 3: The tools take a machine, and the orchestrator is told where a person writes from

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/computer.test.ts test/tools.test.ts
test/prompt.test.ts test/conversation.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/modules/computer/tools.ts`, `apps/server/src/modules/computer/access.ts` (`start`'s check),
  `apps/server/src/modules/tools/job.ts` (`createdBy`, `othersSpoke`), `apps/server/src/modules/conversation/live.ts`
  (`sayLive` marks), `apps/server/src/modules/conversation/queue.ts` and `apps/server/src/modules/tasks/wake.ts` (who
  speaks), `apps/server/src/modules/conversation/prompt.ts` (`turnPrompt`),
  `apps/server/src/modules/conversation/routes.ts` (the message route)
- Test: `apps/server/test/computer.test.ts`, `apps/server/test/tools.test.ts`, `apps/server/test/prompt.test.ts`,
  `apps/server/test/conversation.test.ts`

**Interfaces:**
- Consumes: `Computers` and its `here` (Task 2); plan 5b's `KEEPER_MARK`.
- Produces:
  ```ts
  // modules/tools/job.ts: ToolJob gains createdBy: string | null and othersSpoke: boolean (jobs' columns)
  // modules/computer/access.ts
  export function answersOwner(job: { answersCeo: boolean; createdBy: string | null; othersSpoke: boolean }, machine: { personId: string }): boolean;
  //   ruling 6: job.answersCeo, or job.createdBy is machine.personId and !job.othersSpoke
  //   Computers.start, in its transaction, locks the job row FOR SHARE, reads these three columns again and throws
  //   ApiError(403, 'forbidden', ..., 'not_owner_turn') unless answersOwner; errors.ts gains 'not_owner_turn'
  // modules/conversation/live.ts
  export function sayLive(ctx: Ctx, agentId: string, text: string, opts: { from: string | null; taskId?: string }): Promise<string | null>;
  //   as today, and before the words go: UPDATE jobs SET others_spoke = true WHERE id = <the running job> AND
  //   created_by IS DISTINCT FROM opts.from, committed; queue.ts passes the message's personId (null for an employee
  //   or Hornhoof), wake.ts null
  // modules/conversation/prompt.ts
  export function turnPrompt(author: { name: string; title: string }, text: string, from?: { machine: string; until: string | null }): string;
  //   with from, one line before the text: "<name> writes this from <machine>; access to it is open until <until>." or
  //   "...; access to it is closed."; without it, exactly today's prompt
  ```
- Tools, for the orchestrator as today:
  - `machines` (new, no input): one line per machine of `ctx.computer.machines()`: name, id, role, owner's name,
    `linux`, `darwin` or `unknown`, `holds the company's data` for role `data`, `reachable` or `not answering`,
    `access open until <until>`, `closed` or `asked: <reason>`, and for a `key` of `not_held` `its owner must give it
    their key first (its card says how)`. Its description says computer access is per machine and only each machine's
    owner opens it, with their own key.
  - `ask_computer_access`: `{ machine?: string (1..200), reason: string (1..500) }`. `none`: "There is no machine of
    the company with a core named <machine>. Call machines for their names." `ambiguous`: "More than one machine is
    called <machine>. Name it by its id from machines." Unreachable: "Hornhoof cannot reach <machine> now: its core
    has not answered for a minute. Tell its owner in a line; never ask anyone to type commands." Open: "Access to
    <machine> is open until <until>. Use computer with machine <id>." Else `ask`, the event, and "The owner of
    <machine>, <person>, sees your request and opens access with one click. You get a note then and go on; until then
    go on with other work or end your turn." With `key` `not_held`, that answer adds: "<machine> does not hold their
    key yet, and its card tells them what to do. Do not tell anyone to type commands."
  - `computer`: `{ machine?: string, command: string (1..20 000), timeoutSeconds?: 1..1800 }`. In this order:
    `none`/`ambiguous` as above; closed: "Access to <machine> is closed. Ask its owner for it with ask_computer_access
    and the reason in a line, then go on once it opens."; not `answersOwner` (checked first from `job`, then again by
    `start`): "Only the CEO or <owner>, who owns <machine>, can ask for this, and other words came into this turn or it
    is not theirs. Ask them first."; unreachable as above; then `start` and `wait`. Its description names the machine's
    root, `/host`, `chroot /host`, and on a Mac Docker's Linux system, as today's does.
  - `computer_result`: `{ id: uuid }`, `wait(id, job.companyId)`; a run of another company is `gone`; a run still
    `sent` to a machine that is not reachable: "<machine> does not answer now; the command's outcome is unknown until
    it does."; `lost`: "The command's outcome is unknown: <machine>'s core lost it. Look at the machine before you run
    it again."
- The message route: when the sender's request has a machine by ruling 8 and the agent is the orchestrator, the
  prompt is `turnPrompt(me, text, { machine: name, until })`; the shown message is unchanged.

- [ ] **Step 1: Write failing tests.**
  - `computer.test.ts`:
    - `runs a command on the machine it names`: access open on Marat's worker; in a turn Marat started, `computer` with
      `machine: <its name>` makes a `waiting` run of that machine; a fake keeper (`GET /api/network/computer` with its
      via and `x-hornhoof-keeper: 1`, then `POST` of `{ exit: 0, output: 'ok' }`) makes the tool answer "Exit code
      0.\nok"; in a turn of the CEO without `machine` the run is the server's.
    - `runs only in a turn that answers the CEO or the machine's owner`: on Marat's open worker, a turn with
      `created_by` Marat runs, the note turn of Marat's open runs, and a turn that answers the CEO runs; a turn of
      another person, Marat's turn into which another person's message came (`enqueueTurn` while it runs, through a
      fake node that holds the words), an employee's words, or a task's wake each get the line above and make no run,
      and `others_spoke` was committed before the fake node received the words; an `UPDATE` of `agent_events` by the
      orchestrator's role changes nothing of this.
    - `finds machines by name, and says when it cannot`: two machines named `mac` give the ambiguous line; an unknown
      name the none line; a name in other case finds it.
    - `tells the orchestrator a machine does not answer`: a machine not seen for 61 s gives the unreachable line at
      once, for `ask_computer_access` and for `computer`.
  - `tools.test.ts`: the orchestrator's tool list gains `machines`; `machines` lists the server's machine and a
    worker with role, system, reachable and access.
  - `prompt.test.ts`: `turnPrompt` with `from` adds exactly the line above; without it, today's text.
  - `conversation.test.ts`, `tells the orchestrator where a person writes from`: a CEO message with `host:
    localhost:8080` gives a job whose prompt has "writes this from" and the server's machine name; through a link
    request, none.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the orchestrator's computer tools take a machine, and tell it where a person writes from".

### Task 4: Each machine's keeper carries its access and commands

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/computer-keeper.test.ts test/keeper.test.ts
test/worker-keeper.test.ts test/network-routes.test.ts test/compose.test.ts test/updater.test.ts` passes, then the
whole server suite; from the worktree root `npm run test:lab` passes after the disk check of Step 4; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing; `bash -n` and `shellcheck` on `apps/updater/updater.sh` print
nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/computer.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts` (plan 5's data keeper runs it),
  `apps/server/src/modules/keeper/worker.ts` (the carrier) and `worker-config.ts` (`hostOs`),
  `apps/server/src/config.ts` (`hostOs` and `ownerKey` for the data keeper), the reports of both keepers (`os`, and the
  data keeper's `pin`), `apps/server/src/modules/network/routes.ts` (the report's `os`), `compose.yaml` (the keeper's
  `HORNHOOF_HOST_OS`), `apps/updater/updater.sh` (comments only), `apps/server/test/lab/join.test.ts` (one more step)
- Test: `apps/server/test/computer-keeper.test.ts` (new), `apps/server/test/keeper.test.ts`,
  `apps/server/test/worker-keeper.test.ts`, `apps/server/test/network-routes.test.ts`,
  `apps/server/test/compose.test.ts`, `apps/server/test/updater.test.ts`

**Interfaces:**
- Consumes: Task 2's keeper routes, `readGrant`, `Grant`; plan 5's data keeper and its way of asking its app with
  `x-hornhoof-via: keeper`; plan 5b's `PeerLink.request` (sent as the keeper), `readPin`, `keyPrint`, the report's
  `pin`; `UpdaterControl.present()`'s rule (`/control/alive` within 30 s).
- Produces:
  ```ts
  // modules/keeper/computer.ts
  export const OPEN_EVERY_MS = 2_000;
  export const CLOSED_EVERY_MS = 15_000;
  export const DEAF_MS = 60_000;          // no 200 or 404 for this long since start or the last one: closed
  export const ASK_MS = 10_000;           // each request's bound
  export type ComputerAsk = (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;
  export const GRANTS_FILE = 'grants.json';  // { held: Grant | null, spent: { nonce, until }[] }, 0600
  export class ComputerCarrier {
    constructor(opts: { controlDir: string; dir: string; machine: string; ask: ComputerAsk;
      pin: () => string | null; trustApp: boolean; log: (line: string) => void; now?: () => Date;
      openEveryMs?: number; closedEveryMs?: number; deafMs?: number });
    //   machine: this keeper's network id; trustApp: true for the data keeper alone, which with no pin takes its
    //   app's word (ruling 13)
    start(): void;
    tick(): Promise<void>;     // one round, for tests
    stop(): Promise<void>;     // aborts the round in flight, writes nothing after it, then computer.json closed once
  }
  // WorkerConfig gains hostOs: 'linux' | 'darwin' | null (HORNHOOF_HOST_OS; anything else null)
  // POST /api/network/report takes also an optional os: 'linux' | 'darwin', written on the asker's row only when
  //   present; a keeper with no HORNHOOF_HOST_OS leaves it out, and the row keeps the os of its node's join
  // Config gains ownerKey: string | null (HORNHOOF_OWNER_KEY, as workerConfig reads it)
  ```
- The pin (ruling 13): a worker's is plan 5b's, `readPin(config.dir)`. The data keeper's is its `ownerKey` from
  `loadConfig`, read at start, which no step of this plan writes; its report now sends `pin: keyPrint(ownerKey)`, or
  null, as the worker's does since plan 5b.
- What a 200 opens: with a pin, an `access` whose `grant` passes `readGrant(grant, pin, machine, now)` and whose nonce
  is not in `spent`; it is open until the earlier of the grant's `until` and `access.untilSec`, and that grant is
  `held`. A grant that does not pass leaves it closed, one log line per hour at most. The held grant moves to `spent`,
  with its `until`, when an answer is closed, carries another grant, or comes after its `until`; `spent` drops the
  entries whose `until` has passed; `grants.json` is written whole and then moved before `computer.json` changes.
  Without a pin: the data keeper (`trustApp`) opens as `access` says; a worker stays closed. Runs are written as below
  either way: on a closed machine its updater answers each with exit 126.
- At `start()` (ruling 10): a `computer.json` without `by` is moved, by one rename, to `computer.legacy.json` unless
  that file exists already (the app may have moved it first), and then `computer.json` is written closed; a file with
  `by` stays as it is, so a restart stops no command, and the deaf clock runs from here. It makes `computer/` when
  missing.
- A round of `ComputerCarrier`, each request aborted after `ASK_MS`:
  1. `GET /api/network/computer?updater=<1 when controlDir/alive is under 30 s old, else 0>&held=<the uuids of the
     computer/<id>.json files there>`. On 200: it writes `computer.json` `{ untilSec, until, asked: null, by: "keeper"
     }` (closed: `untilSec` and `until` null) whole and then moved, when it differs from what is there; then each run
     as `computer/<id>.json` `{ id, command, timeout }` whole and then moved, unless `<id>.json`, `<id>.started` or
     `<id>.out.json` is there already. On 404 it writes `computer.json` closed. Anything else (503 included) changes
     nothing, one log line per hour at most, until no 200 or 404 came for `deafMs`: then it writes `computer.json`
     closed. Every write checks first that the carrier was not stopped.
  2. Then each `computer/<id>.out.json` whose `<id>` is a uuid: `POST /api/network/computer/<id>` with its `exit` and
     `output`; on 204 or 404 both files go; on anything else they stay for the next round. It removes a `<id>.json`
     only so, after its answer: the updater answers only while that file is there.
  3. The next round comes after `openEveryMs` while the last answer was open or a run file is there, else after
     `closedEveryMs`.
- Plan 5's data keeper runs a `ComputerCarrier` from its start, in every mode, whose `ask` is its app with
  `x-hornhoof-via: keeper`, with `machine` its `config.machineId`, `dir` its `KEEPER_DIR`, `pin` its `config.ownerKey`
  and `trustApp` true; plan 5b's worker keeper runs one whose `ask` is `PeerLink.request`, with `machine` its
  `config.machineId`, `dir` its `config.dir`, `pin: () => readPin(config.dir)` and `trustApp` false, and when it becomes
  `disconnected` it awaits `stop()`. Each keeper's report gains `os` from `HORNHOOF_HOST_OS` (`loadConfig` for the data
  keeper, `workerConfig` for the worker), left out when unknown.
- `compose.yaml`: the keeper's `environment` gains `HORNHOOF_HOST_OS: ${HORNHOOF_HOST_OS:-}`.
- `updater.sh`: the comments that say the app writes `computer.json` and the command files say the keeper does; no
  line of code changes.
- The lab (`join.test.ts`): m2 joined in plan 5b's step 2 with the CEO's key, whose private key the test keeps. After
  its step 3: as the CEO, who ran the command on m2 and so owns its row, `POST /api/machines/<m2's id>/access/open` with
  a grant signed by that key; a `waiting` run for m2 of `cat /host/etc/hostname`, inserted through m1's `psql` as
  `start` would write it, comes back `done` within 30 s with exit 0 and m2's hostname; after `close`, a new run ends
  `done` with exit 126; then an `UPDATE` through `psql` that sets m2's `until` an hour on and its `grant` back to the
  closed one leaves m2's `computer.json` closed, and a run inserted then ends `done` with exit 126.

- [ ] **Step 1: Write failing tests.**
  - `computer-keeper.test.ts`, with a fake `ask` and a temp control folder, `openEveryMs` 50 and `closedEveryMs` 200:
    - `writes the access and the runs for its updater`: an open answer with one run writes `computer.json` with that
      `untilSec` and `computer/<id>.json`; a fake updater's `.out.json` is posted on the next round and both files go.
    - `closes on a refusal, and when it hears nothing for a minute`: a 404 writes `computer.json` closed; after an
      open answer, a thrown `ask`, a 503, or an `ask` that never settles (aborted at `ASK_MS`) leaves the file open
      for 59 s and closes it at 61 s (fake clock); a carrier started with an open `computer.json` of its own and no
      app closes it at 61 s; a `POST` that never settles does not delay the closing.
    - `opens only on its owner's grant`, with a P-256 pin made by the test: an `access` with no grant, a grant signed
      by another key, one for another network id, one past its `until`, and one longer than a day leave
      `computer.json` closed; the good grant opens it until its `until`; after a closed answer the same grant sent
      again leaves it closed (its nonce spent), and so does it after a restart of the carrier on the same `dir`; a new
      grant opens again; a worker without a pin stays closed on any answer; the data keeper without a pin opens as the
      app says.
    - `moves an older app's file aside`: a `computer.json` without `by` is at `computer.legacy.json` after `start()`
      and `computer.json` is closed with `by`; with `computer.legacy.json` already there, nothing is moved over it.
    - `stops without a late write`: `stop()` while a `GET` that answers open with a run is held, then the answer let
      go: no run file is written and `computer.json` ends closed.
    - `runs each command once`: a run id the app gives again is not written while its `.json`, `.started` or
      `.out.json` is there; a carrier restarted with an `.out.json` left posts it at its first round; an answer the app
      takes with 404 is removed, not posted again; a `.json` with no answer is never removed.
    - `asks often only while access is open`: with a closed answer, two rounds in 400 ms at most; open, at least five.
  - `keeper.test.ts`, `carries computer access for its own machine`: plan 5's keeper with a test app: after `POST
    /api/machines/<server machine>/access/open` by the CEO, its control folder's `computer.json` has the app's
    `untilSec` within 1 s (`peerEveryMs` and the carrier's times short); `reports its pin`: with `HORNHOOF_OWNER_KEY`
    the `server:` row's `owner_pin` is its print, without it null.
  - `worker-keeper.test.ts`, `carries computer access over the peer link`: the joined worker's carrier takes a run
    for its machine through the leader, once its owner opened it with a grant of the pinned key, and posts its answer;
    a `GET /api/network/computer` with `x-hornhoof-via: keeper` sent to the worker's front door gets 403 and the next
    run stays `waiting`; after Disconnect it writes `computer.json` closed.
  - `compose.test.ts`: the keeper's exact environment keys gain `HORNHOOF_HOST_OS`.
  - `network-routes.test.ts` (plan 5's): a report without `os` keeps the row's `os`; with `os: 'darwin'` sets it.
  - `updater.test.ts`: unchanged behavior; its existing computer cases still pass with `computer.json` written by the
    test as the keeper writes it.
- [ ] **Step 2: Run** the vitest part of Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above and the lab step.
- [ ] **Step 4: Check the disk, then run Done when.** As plan 5b's Task 9 Step 3: `df -h` on the Mac and `docker
  system df`; the lab needs its images' sizes times the machines plus one, and 5 GB more; when short, only build
  cache and `hornhoof-lab/*` images go, never a volume; still short: stop and report. Expected: PASS.
- [ ] **Step 5: Commit** "Carry each machine's computer access and commands through its own keeper".

### Task 5: The owner's key on each device

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** Task 4 committed. **Done when:** from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/owner-key.test.ts test/PasswordPrompt.test.tsx
test/i18n.test.tsx` passes, then the whole web suite; `npx tsc -p apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/web/src/owner-key.ts` (`unlockKey`, `signGrant`), `apps/web/src/ui/PasswordPrompt.tsx` (the `unlock`
  prompt, `useOwnerKey().sign`), `apps/web/src/types.ts` (`Grant`), `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`
- Test: `apps/web/test/owner-key.test.ts`, `apps/web/test/PasswordPrompt.test.tsx` (both plan 5b's)

**Interfaces:**
- Consumes: plan 5b's `owner-key.ts`, `PasswordPrompt`, `useOwnerKey`, `keyDefaults` and its test defaults; ruling
  13's grant.
- Produces:
  ```ts
  // apps/web/src/owner-key.ts
  export function unlockKey(server: StoredKey, password: string, deps?: Partial<KeyDeps>): Promise<CryptoKey | null>;
  //   null on a wrong password (the unwrap fails); else non-extractable ['sign'], put in the store
  export function signGrant(privateKey: CryptoKey, machine: string, untilS: number, nowS: number, deps?: Partial<KeyDeps>): Promise<Grant>;
  //   payload JSON.stringify({ v: 1, machine, until: untilS, at: nowS, nonce }) in that order, nonce 16 random bytes
  //   base64url; signature ECDSA with SHA-256 over the payload's UTF-8 bytes (WebCrypto's P1363), base64url
  // apps/web/src/ui/PasswordPrompt.tsx: PasswordPrompt's purpose becomes 'make' | 'unlock', and useOwnerKey() gains
  sign(machine: string): Promise<Grant | null>;
  //   a grant for that network id, at now and until now + 24 h, with deviceKey(serverKey()), unlocked first with the
  //   password when the device holds none; null on Cancel; used only on a view whose key is held
  // types.ts
  export type Grant = { payload: string; signature: string };
  ```
- Strings, EN / RU: `ownerKeyUnlock`: "Enter your password once on this device to sign with your key." / «Введите пароль
  один раз на этом устройстве, чтобы подписывать своим ключом.»

- [ ] **Step 1: Write failing tests.**
  - `owner-key.test.ts`:
    - `unlocks with the password only`: `unlockKey` with a wrong password is null and the store stays empty; with the
      right one it stores a key whose grant verifies against `publicKey`.
    - `signs a grant the keeper reads`: the payload has exactly `v`, `machine`, `until`, `at` and `nonce` (22
      characters) in that order; the signature is 64 bytes and `node:crypto`'s `verify` with `dsaEncoding:
      'ieee-p1363'` takes it; two grants have different nonces.
  - `PasswordPrompt.test.tsx`, `asks for the password once per device`: `sign` with an empty store shows the `unlock`
    prompt once, a wrong password shows "Wrong password.", the right one gives a grant, and the second `sign` asks
    nothing; Cancel gives null; in Russian too.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Unlock each person's key on a device and sign openings with it".

### Task 6: The screens: each machine's card, the requests, the window and the account menu

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** Task 5 committed. **Done when:** from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Machines.test.tsx test/Tasks.test.tsx
test/Orchestrator.test.tsx test/Shell.test.tsx test/i18n.test.tsx` passes, then the whole web suite; `npx tsc -p
apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/web/src/ui/ComputerCard.tsx`, `apps/web/src/screens/AgentWindow.tsx`, `apps/web/src/screens/Tasks.tsx`,
  `apps/web/src/screens/Machines.tsx`, `apps/web/src/screens/Shell.tsx` (`AccountMenu`), `apps/web/src/types.ts`,
  `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`
- Test: `apps/web/test/api-mock.ts` (`decisions()`: `computerAccess` defaults to `[]`, its items counted one by one),
  `apps/web/test/Machines.test.tsx`, `apps/web/test/Tasks.test.tsx`, `apps/web/test/Orchestrator.test.tsx` (today's
  computer cases move from `/api/computer` and `ComputerView` to the per-machine routes and `AccessView`),
  `apps/web/test/Shell.test.tsx`

**Interfaces:**
- Consumes: `GET /api/machines/access`, `POST /api/machines/:id/access/open|close|decline`, `GET /api/machines/here`,
  `GET /api/requests`'s `computerAccess: ComputerAccessDecision[]`, `GET /api/machines`'s `access` (Task 2);
  `useOwnerKey`, `Grant` (Task 5).
- `types.ts`: `AccessView` and `AccessMachine` as Task 2's; `ComputerAccessDecision` gets `id: string` and `view:
  AccessView`; `Decisions.computerAccess` becomes an array.
- Every open, from the card, the Machines tab or the account menu, goes one way: with `key` `held`,
  `useOwnerKey().sign(view.machine.networkId)` first and then `{ grant }` posted (null: nothing is posted); with
  `not_needed`, `{}` posted at once; with `not_held`, no open button, and the owner sees `computerKeyNotHeld` in its
  place. The prompt `useOwnerKey` gives renders where the button was.
- `ComputerCard({ view, onChange, onFailure })` takes an `AccessView` and posts to its machine's routes: with a
  request and `canOpen`, the request with "Open access to <machine> for a day" and "Not now"; open and `canClose`,
  "Access to <machine> is open until <time>" and "Close access"; the lines of ruling 7 under the request.
- `AgentWindow` loads `GET /api/machines/access` and shows one `ComputerCard` per view that asks or is open, reloading
  on `{ type: 'computer' }`; `Tasks` shows one per `computerAccess` item.
- `Machines`: each card with `access` shows, in its owner and system part, `computerOpenUntil` to everyone who sees
  the card while open, "Open access to <machine> for a day" for `canOpen` while closed and reachable, "Close access" for
  `canClose` while open, and with `reachable` false and `canOpen` "Hornhoof cannot reach <machine> now." The words of
  ruling 7 show under the open button.
- `AccountMenu` loads `GET /api/machines/here` when it opens; with a `view` that is `canOpen`, reachable, closed and
  whose `key` is not `not_held`, it offers "Give the orchestrator access to this machine (<machine>)", which opens as
  above and closes the menu.
- Strings, EN / RU, each with `<machine>` the machine's name:
  - `computerAsks`: "The orchestrator asks for access to <machine>" / «Оркестратор просит доступ к машине <machine>»
    (kept); `computerOpen`: "Open access to <machine> for a day" / «Открыть доступ к машине <machine> на сутки»;
    `computerNotNow`, `computerClose`, `computerAccess`, `computerAsked`, `computerOpened`, `computerClosed`,
    `computerDeclined` kept.
  - `computerOpenUntil` (today it also says the company server runs there; that goes): "Access to <machine> is open
    until <time>." / «Доступ к машине <machine> открыт до <time>.»
  - `computerWhat`: "For a day the orchestrator runs commands as root on <machine>, and each one shows in its window.
    Access closes by itself after a day, or when you close it." / «На сутки оркестратор сможет выполнять команды с
    полными правами на машине <machine>, и каждая будет видна в его окне. Доступ закроется сам через сутки или когда
    вы его закроете.»
  - `computerGives`: "Open access lets the orchestrator change anything on <machine>." / «Открытый доступ позволяет
    оркестратору изменить на машине <machine> что угодно.»; `computerGivesData` (today's words that it also opens
    every machine go: ruling 13): "Open access lets the orchestrator change anything on <machine>, the company's data
    included." / «Открытый доступ позволяет оркестратору изменить на машине <machine> что угодно, включая данные
    компании.»
  - `computerMac`: "On a Mac this reaches Docker's Linux system, not macOS itself." / «На Mac этот доступ открывает
    только Linux внутри Docker, а не саму macOS.»; `computerMaybeMac`: "If <machine> is a Mac, this reaches Docker's
    Linux system, not macOS itself." / «Если на машине <machine> стоит macOS, этот доступ открывает только Linux
    внутри Docker, а не саму macOS.»
  - `computerUnreachable`: "Hornhoof cannot reach <machine> now." / «Hornhoof сейчас не может связаться с машиной
    <machine>.»
  - `computerHere`: "Give the orchestrator access to this machine (<machine>)" / «Дать оркестратору доступ к этой
    машине (<machine>)»
  - `computerKeyNotHeld`: "<machine> does not hold your key yet. Run a new command from Connect a machine on it: it
    takes your key only from there." / «Машина <machine> пока не хранит ваш ключ. Выполните на ней новую команду из
    «Подключить машину»: ключ она берет только оттуда.»
  `computerServer` stays for a server row with no name.

- [ ] **Step 1: Write failing tests.**
  - `Machines.test.tsx`: `opens access only on the owner's own machine`: the owner's card has "Open access to Mac for a
    day" and posts `/api/machines/<id>/access/open`; another person's card for the same machine has no button and shows
    "Access to Mac is open until 18:20." once open; the server's card says "the company's data included" and nothing
    of other machines; a Mac says the Docker line; an unreachable machine shows the unreachable line and no button;
    each in Russian too.
  - `Machines.test.tsx`: `opens a machine with its owner's grant`: with `key` `held`, Open posts a `grant` whose payload
    names the machine's network id, asking the password only while the test store is empty; the server's card with
    `not_needed` posts `{}` and asks nothing; with `not_held` the owner sees "Mac does not hold your key yet" and no
    button, another person neither.
  - `Tasks.test.tsx`: two `computerAccess` items show two cards, each posting to its machine.
  - `Orchestrator.test.tsx`: the window shows a card per asking or open machine and closes the one clicked.
  - `Shell.test.tsx`: `offers access to the machine the person sits at`: with `here` naming Mac and `canOpen`, the
    menu has "Give the orchestrator access to this machine (Mac)" and posts `open`; with `canOpen` false, access
    open, `key` `not_held`, or `here` null, no such item.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Show computer access on each machine's card and offer it where its owner sits".

### Task 7: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `computer-access`. **Starts from:** Tasks 1 to 6 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Updates
are Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check of Task 4 Step 4) → pass; the `tsc` commands → no output; `bash -n` and `shellcheck`
  on `apps/updater/updater.sh` → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 5b's Task 10 Step 2.
- [ ] **Step 3: Review.** The team lead reads the branch against spec section 8, the overview's plan 6 entry and this
  plan's rulings, with Ivan's two rules first; the CLI agent that did not write a task reviews it too; one fix pass,
  each fix with its failing test first.
- [ ] **Step 4: Rehearse** (team lead), on the team lead's stand on Ivan's Mac, as in plan 5b: the disk first; then the
  current release (plan 5b's) as `install.sh server --name rehearsal`, the DinD worker `hh-rehearsal-m2` joined with
  the real command, and two branch builds, B1 from Task 4's commit and B2 from the head. In this order:
  1. In the release's orchestrator window, open access to the computer (the stand's CEO is the team lead). Forward
     to B2: it ends `done`; plan 5b's checks pass; `docker compose exec -T db psql ... -c "\d machine_access"` shows
     the table; the stand's machine is open until the same time (ruling 10) and `computer.legacy.json` is gone; the
     worker follows to B2.
  2. In the browser at the stand's localhost, signed in as its owner: "Close access" on the stand's card; then the
     account menu offers "Give the orchestrator access to this machine" with the stand's machine: use it (no pin
     there, so no password). The worker, joined on plan 5b's build, already holds the key (the team lead owns both):
     its card offers "Open access"; open it: the password is asked once on this device and origin, and the access
     opens; reload the page, close and open it again: no password (the key kept in IndexedDB).
  3. A run for the worker, inserted with `psql` as `start` writes it (`cat /host/etc/hostname`), comes back `done`
     within 30 s with the DinD machine's hostname; the same for the stand's machine gives the Docker VM's. A request
     to the worker's own web port from inside it (`docker exec hh-rehearsal-m2 wget` with `x-hornhoof-via: keeper`)
     for `/api/network/computer` answers 403, and a run inserted just before stays `waiting` until the keeper takes it.
  4. Save the worker's `grant` with `psql`, then close the worker's access: the worker's `computer.json` (`docker
     exec hh-rehearsal-m2 ...`) has `untilSec` null within 5 s, and a new run for it ends `done` with exit 126 within
     20 s (a closed machine's keeper asks every 15 s). Then, with `psql`: set its `until` an hour on with no grant; then
     with the saved grant; then insert a run. Within 30 s of each, its `computer.json` still has `untilSec` null, the
     run ends `done` with exit 126, and the worker's `docker compose logs keeper` has the refused-grant line. Close
     its access on the card again.
  5. Open both machines again, then back to the release (plan 5b's): it ends `done`; the old app's window shows
     access to the computer open until the same time (the file the keeper left); the worker's keeper (still B2) gets
     404 and writes `computer.json` closed within 15 s. Close access in the old app's window.
  6. Forward again to B2: both machines' access is closed (ruling 10), none reopened; open the worker's again (one
     click), then Disconnect the worker: its access row is gone and its keeper's `computer.json` is closed.
  Then remove the worker, the link, `docker compose down -v` in `~/hornhoof-rehearsal` only, that folder and its
  registry line. Any step that fails: stop and report, and Ivan is not asked to update.
- [ ] **Step 5: Merge** (team lead): the merge commit into main with exactly this subject (no double quote):
  ```text
  Open computer access per machine, by its owner alone, with commands carried by each machine's keeper
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** As plan 5b's Task 10 Step 6: Ivan presses Update on his own
  companies himself; the team lead never runs an install, an update, a join, a `request.json`, an access opening or a
  command on them. After each, reading only: the release's commit in `/api/health`, `machine_access` and `computer_runs`
  present, each machine's keeper asking (`docker compose logs keeper` without carrier errors), and the Machines tab
  showing "Open access" only on the cards of the machines Ivan owns. Whether to open access anywhere is Ivan's, and no
  step asks him to type a command. When a check fails, or the Update does not end within 20 minutes, the team lead tells
  Ivan which release to go back to and how, in Versions.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/computer-access` and `git
  branch -d computer-access` once main has the merge.
