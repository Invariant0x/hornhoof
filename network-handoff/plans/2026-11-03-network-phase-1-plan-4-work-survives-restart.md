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

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/work-survives` on a new branch `work-survives` from main
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
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
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

### Task 1: Sources in the database layer

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** main with plan 3 merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sources.test.ts test/migrations.test.ts
test/lease-store.test.ts` passes, then the whole server suite; from the worktree root `npm run test:real` passes and
`npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/db/sources.ts`, `apps/server/drizzle/0047_steps.sql`, `apps/server/drizzle/0048_calls.sql`
  (with their `meta` files)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts` (`openDb`), `apps/server/test/helpers.ts`
  (`openTestDb`, `createTestDb`), `apps/server/src/modules/keeper/lease-store.ts` (`prune`)
- Test: `apps/server/test/sources.test.ts` (new), `apps/server/test/migrations.test.ts`,
  `apps/server/test/lease-store.test.ts`, `apps/server/test/real/sources.test.ts` (new),
  `apps/server/test/real/lease-store.test.ts`

**Interfaces:**
- Consumes: `applied`, `toolCalls`, `setLease`, `realDatabase`, `openDb`, `APP_NAME`, `LeaseStore.prune` (plan 3).
- Produces:
  ```ts
  // db/schema.ts: applied gains base: text('base') and the indexes applied_base (base) and applied_at (at);
  //   toolCalls gains the index tool_calls_at (at)
  // db/sources.ts
  export type Source = { base: string; next: number; open: boolean; wrote: boolean };
  export const sources: AsyncLocalStorage<Source>;
  export const nodeSource = (node: string, stream: string, n: number): string => `node:${node}:${stream}:${n}`;
  export const webSource = (id: string): string => `web:${id}`;
  export const toolSource = (invocation: string): string => `tool:${invocation}`;
  export const stepOf = (base: string, step: number): string => `${base}:${step}`;
  export function openSource(base: string, next?: number): Source;    // { base, next: next ?? 0, open: true, wrote: false }
  export function withSource<T>(base: string, work: () => Promise<T>, next?: number): Promise<T>;
  //   runs work in sources.run(openSource(base, next), ...); the source's open is false once work settles
  export function outsideSources<T>(work: () => T): T;               // sources.exit(work)
  export const WRITE_TEXT: RegExp;
  //   a statement that changes rows: starts with insert, update or delete, or with `with` and holds one of them
  export function recordSources(db: Db): Db;
  //   the same db, wrapped once (a second call changes nothing), as ruling 1 says. In an open source:
  //   - db.transaction(work, config): unless config.accessMode is 'read only', once work resolved and before the
  //     commit, SELECT pg_current_xact_id_if_assigned() IS NOT NULL; when true, step = next++ and INSERT INTO
  //     applied (source, base) VALUES (stepOf(base, step), base); wrote is set once db.transaction resolved
  //   - a prepared query of db.session whose text matches WRITE_TEXT: its execute runs as the same query on the
  //     session of a db.transaction, which then records as above; it answers what it would have answered
  //   Everything else, and everything outside an open source, runs as before.
  export function recordNow(db: Db): Promise<void>;
  //   in the open source: one transaction that inserts its next step and nothing else (an action outside the database)
  export function listed(db: Db, base: string): Promise<{ steps: number; first: string; at: Date } | null>;
  //   the base's rows of applied: how many, and the first one's source and at (ORDER BY at, source); null when none
  export function touch(db: Db, base: string): Promise<void>;
  //   outside sources: UPDATE applied SET at = at WHERE source = <listed(db, base).first>
  ```
- `0048_calls.sql`: `net.assert_lease(margin interval, invocation uuid, job uuid, answer jsonb) RETURNS void`,
  `SECURITY DEFINER`, `SET search_path = pg_catalog, net_local, pg_temp`: `PERFORM net.assert_lease(margin,
  invocation)`; then, when `invocation` is not null, `INSERT INTO public.tool_calls (id, job_id, answer) VALUES
  (invocation, job, answer)` and `INSERT INTO public.applied (source, base) VALUES ('tool:' || invocation::text ||
  ':0', 'tool:' || invocation::text)`. Then `REVOKE ALL ON FUNCTION net.assert_lease(interval, uuid, uuid, jsonb)
  FROM PUBLIC`.
- `openDb` (every name) and `openTestDb` return `recordSources(drizzle(...))`.
- `LeaseStore.prune(batch)` deletes, in the same statement as plan 3's (one `WITH` per table, each under the same
  `(SELECT sync FROM net_local.lease) = 'alone'`), up to `batch` rows of `applied` with `at` older than 7 days, and up
  to `batch` rows of `tool_calls` with `at` older than 7 days whose job's status is not `running`; it answers the
  rows of all three it deleted.

- [ ] **Step 1: Write failing tests.**
  - `sources.test.ts`, on `createTestDb()` with a company (`setUpCompany` as `helpers.ts` gives it):
    - `records a transaction's source before its commit`: in `withSource('web:a', ...)`, a `db.transaction` that
      renames an agent: `applied` has `web:a:0` with base `web:a`, and `net.journal` gives that row and the rename the
      same `xact`.
    - `numbers the steps of a source that commits more than once`: two transactions and one `db.update` outside a
      transaction in one source give `web:b:0`, `web:b:1` and `web:b:2`, in that order of `at`; `listed` answers
      `steps: 3` and `first: 'web:b:0'`.
    - `records nothing for reads`: a transaction that only selects, one with `accessMode: 'read only'`, a select
      outside a transaction, and an `UPDATE` that matches no row each leave `applied` as it was.
    - `runs a write outside a transaction in one of its own`: `db.insert(...).returning()` in a source answers the
      same row it answers outside one; its `applied` row and the insert share an `xact`; outside a source the insert
      adds no `applied` row.
    - `records nothing once the source has closed`: work that starts a 50 ms timer which writes, and resolves at
      once: the timer's write adds no `applied` row; `outsideSources` inside an open source records nothing either.
    - `rolls the source back with the change`: a transaction that throws after its insert leaves no `applied` row.
    - `lists a source whose first commit failed`: in one source, a transaction whose commit fails with `HHF01`
      (`setLease(db, { until: '-infinity' })` first), then, with the lease back, one that commits: `listed` answers
      `steps: 1` and `first: 'web:c:1'`.
    - `gives two transactions at once two steps`: two transactions of one source started together both commit, as
      `web:e:0` and `web:e:1`.
    - `records an action outside the database`: `recordNow(db)` in a source gives its next step and no other row.
    - `lists and touches`: `listed` is null, then `{ steps: 1 }` after a recorded transaction; `touch` writes one
      journal row of `applied` with op `update`.
    - `wraps a db once`: `recordSources(recordSources(db))` records one row per transaction.
  - `migrations.test.ts`: `migration 0047`, `keeps the base of each step`: `applied` has `base` and the indexes
    `applied_base` and `applied_at`, and `tool_calls` the index `tool_calls_at`; `migration 0048`, `records a database
    call in the lease check`: `net.assert_lease(interval, uuid, uuid, jsonb)` exists, PUBLIC may not execute it, and a
    call with an invocation writes the `tool_calls` row and the `applied` row with its base; with `invocation` null it
    writes neither.
  - `lease-store.test.ts`, `prunes old sources and the calls of ended jobs while alone`: rows of `applied` and
    `tool_calls` written 8 days ago and now (a `tool_calls` row of a running job 8 days old among them): `prune()`
    removes the old `applied` rows and the old calls of ended jobs only; with sync `copy` it removes nothing.
  - `real/sources.test.ts`, on a `realDatabase()` migrated with `migrateDb`, `state` and an endless lease written by
    the admin, and `openDb(url, APP_NAME, { fenced: true })`:
    - `records the source in the commit the fence checks`: a write in a source commits with its `applied` row under
      one `xact`; with the lease set to end in 1 s and a transaction that sleeps 2 s before its write, the commit
      fails with `HHF01` and neither row is kept.
    - `tells writes from reads on Postgres`: the cases of `records nothing for reads`, and a `SELECT ... FOR UPDATE`
      that locks a row, which is recorded.
  - `real/lease-store.test.ts`, `prunes old sources as the keeper`: the same as on PGlite, through `keeperSql(url)`.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no `sources.ts`, no `base`, no four-argument function).
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name steps`, then `npx drizzle-kit generate
  --custom --name calls` and its SQL, then `sources.ts`, `openDb`, `openTestDb` and `prune`. `global-setup.ts` needs no
  change: it migrates and dumps as plan 3 left it.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Record where each change came from in the same commit as the change".

### Task 2: The page's changes, applied once

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/request-sources.test.ts test/errors.test.ts`
passes, then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run
test/api.test.ts test/i18n.test.tsx` passes, then the whole web suite; both `tsc` commands print nothing.

**Files:**
- Create: `apps/server/src/modules/sources/requests.ts`
- Modify: `apps/server/src/app.ts` (`registerRequestSources` before the routes), `apps/server/src/errors.ts`,
  `apps/server/src/modules/conversation/routes.ts` and `apps/server/src/modules/updates/routes.ts` (`startsFirst`),
  the route files Step 1 finds, `apps/web/src/api.ts`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`
- Test: `apps/server/test/request-sources.test.ts` (new), `apps/web/test/api.test.ts` (new),
  `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: `sources`, `openSource`, `webSource`, `listed`, `touch`, `recordNow` (Task 1).
- Produces:
  ```ts
  // modules/sources/requests.ts
  export const REQUEST_ID = 'idempotency-key';
  export function registerRequestSources(app: FastifyInstance, db: Db): void;
  //   a preHandler for POST, PUT, PATCH and DELETE, but not /mcp, whose REQUEST_ID is a uuid (taken lowercase):
  //   - listed(db, webSource(id)): touch, then 409 { code: 'conflict', message: ALREADY_DONE, reason: 'already_done' };
  //   - not listed: the rest of the request runs in sources.run(openSource(webSource(id)), done), and a route whose
  //     config has startsFirst: true first runs recordNow(db).
  //   The source closes in the request's onSend, which every answered request passes, failed or not.
  //   Any other request, and one without a uuid key, runs as before, in the source it came in (a control tool's
  //   app.inject runs in its tool call's).
  // errors.ts: ErrorReason gains 'already_done';
  export const ALREADY_DONE = 'This change was already made, but its answer was lost. Reload the page to see it.';
  // apps/web/src/api.ts
  export function newRequestId(): string;  // a v4 uuid from crypto.getRandomValues, which plain http has too
  export const RETRY_FOR_MS = 60_000;
  //   request(): POST, PUT, PATCH and DELETE send idempotency-key: newRequestId(), the same on each try. A network
  //   failure, a 2xx whose JSON body cannot be read whole, or a 502 or 503 whose reason is 'starting' or
  //   'not_confirmed' or whose body is not the error JSON, waits Retry-After seconds (kept within 1 to 10, 2 when
  //   missing) and sends again while less than RETRY_FOR_MS has passed since the first failure; then the last
  //   failure is thrown as today. GET is as today.
  ```
- `startsFirst: true` in the route's config: `POST /api/agents/:id/stop`, `POST /api/updates`, and each route Step 1
  finds.
- `en.ts` `errors.already_done`: `ALREADY_DONE`'s text; `ru.ts`: `Это изменение уже сделано, но ответ на него
  потерялся. Обновите страницу, чтобы его увидеть.`

- [ ] **Step 1: Find the routes that act before they write.** List every `POST`, `PUT`, `PATCH` and `DELETE` route
  in `apps/server/src` whose handler reaches a node (`ctx.hub.send`), the updater (`ctx.updater`), the computer
  access, the link's files or a process before, or without, a write of its own (start from `grep -rn
  "hub.send\|ctx.updater\.\|ctx.computer\.\|writeFileSync\|spawn("`). Each gets `startsFirst: true`; the report
  names them.
- [ ] **Step 2: Write failing tests.**
  - `request-sources.test.ts`, on `testApp()` with a company set up:
    - `applies a change once when the page sends it again`: `POST /api/tasks` (as `ui/NewTask.tsx` sends it) twice
      with one `idempotency-key` gives one task; the first answers as today, the second 409 with reason
      `already_done`; `applied` has `web:<key>:0` with base `web:<key>`.
    - `records nothing for a change that changed nothing`: a `POST` with a key that fails validation (400) adds no
      `applied` row, and sent again answers 400 again.
    - `leaves requests without a key as they were`: two creates without a key give two tasks; a key that is not a
      uuid, and a key on `POST /mcp`, give no `web:` row.
    - `commits the first step of an action outside the database`: `POST /api/agents/:id/stop` with a key while the
      agent's turn runs on a connected `connectNode`: the node gets one `job.cancel`; the same key again answers
      `already_done`, and no second `job.cancel` comes.
    - `closes the source when its answer goes`: on a Fastify app of its own with `registerRequestSources` on
      `createTestDb()`, a keyed route that answers at once and writes from a 50 ms timer: the write adds no `web:`
      row.
  - `api.test.ts`, with `fetch` mocked and fake timers:
    - `sends one request id with a change and keeps it on retry`: a `POST` whose first `fetch` rejects, second answers
      503 with reason `starting` and `Retry-After: 1`, and third 200 makes three calls with one `idempotency-key` and
      resolves with the third's data.
    - `treats an answer cut short as lost`: a 200 whose `json()` rejects, then a 200 that reads, makes two calls with
      one key.
    - `gives up a minute after the first failure`: `fetch` rejecting always makes the `POST` reject with status 0 once
      60 s have passed, and not before.
    - `does not send again what the server refused`: 503 with reason `maintenance`, 503 with reason `read_only`, and
      409 with reason `already_done`, each reject after one call with that reason.
    - `sends a change again that was not confirmed`: a 503 with reason `not_confirmed`, then 200, makes two calls with
      one key.
    - `sends no key with a read`: a `GET` carries no `idempotency-key`, and a `GET` whose `fetch` rejects rejects after
      one call.
    - `makes request ids without randomUUID`: with `crypto.randomUUID` removed, `newRequestId()` matches
      `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/` and two differ.
  - `i18n.test.tsx`, `shows a known reason in the chosen language` gains `already_done` in both.
- [ ] **Step 3: Run** Done when. Expected: FAIL (no hook, no key from the page).
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Send a request id with each change from the page, and apply it once".

### Task 3: Tool calls answered once

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/tool-calls.test.ts test/tools.test.ts
test/orchestrator-control.test.ts` passes, then the whole server suite; from the worktree root `npm run test:real`
passes and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tools/calls.ts`
- Modify: `apps/server/src/modules/tools/mcp.ts` (`toolsFor` takes the invocation and runs `guardTools` first),
  `apps/server/src/modules/tools/database.ts` (its `ToolJob` gains `id`), `apps/server/src/db/agent-sql.ts` (`run`'s
  `call`, the write role's grant), `apps/server/test/helpers.ts` (`agentSqlOn` the same),
  `apps/server/src/auth/tunnel.ts` (`fromTunnel` exported, unchanged)
- Test: `apps/server/test/tool-calls.test.ts` (new), `apps/server/test/real/agent-sql.test.ts`

**Interfaces:**
- Consumes: `withSource`, `toolSource`, `sources`, `listed`, `touch`, `outsideSources` (Task 1); `notConfirmed`,
  `isLeaseRefused`, `PRE_COMMIT`, `SqlAnswer` (plan 3); `fromTunnel(req, config)` of `auth/tunnel.ts` (main).
- Produces:
  ```ts
  // modules/tools/calls.ts
  export const INVOCATION = 'x-hornhoof-invocation';
  export function invocationOf(req: FastifyRequest, config: Config): Promise<string | null>;
  //   the header, lowercase, when it is a uuid and fromTunnel(req, config) (the keeper's address, ruling 13); else null
  export const STARTS_FIRST: ReadonlySet<string>;   // the names of ruling 7, and those Step 1 adds
  export const ANSWER_MAX = 256 * 1024;
  export const PENDING = (startedAt: Date): string;
  //   `This call started at ${HH:MM} UTC and its result is not in yet. Do not run it again; look at its result first.`
  export const ALREADY_RAN = 'This call already ran, but its answer was not kept. Look at its result before you repeat it.';
  export const MAY_HAVE_RUN = 'Hornhoof could not confirm this change. The call may have run; look at its result before you repeat it.';
  export const TOO_LARGE = 'This call ran, but its answer was too large to keep. Look at its result again.';
  export const ID_TAKEN = 'This call id belongs to another job, so the call did not run. Send it again.';
  export function currentInvocation(): string | null;   // the open source's invocation when its base is a toolSource
  export function guardTools(server: McpServer, ctx: Ctx, job: ToolJob, invocation: string | null): void;
  //   wraps server.registerTool before any module registers; the wrapped handler gets every argument the SDK gives
  //   (args and extra, or extra alone) and answers an MCP result ({ content, isError? }):
  //   - without an invocation, it runs as today;
  //   - with one: a tool_calls row of that id for another job: ID_TAKEN with isError, and nothing runs. A row of this
  //     job: UPDATE tool_calls SET at = at, then its answer, or PENDING(row.at) when it has none. No row, but
  //     listed(db, toolSource(id)): touch, then ALREADY_RAN with isError. Otherwise the tool runs: for a name in
  //     STARTS_FIRST a tool_calls row (id, job, answer null) commits first, outside sources; the handler runs in
  //     withSource(toolSource(id)); its answer is kept outside sources (INSERT ... ON CONFLICT (id) DO UPDATE SET
  //     answer = excluded.answer WHERE tool_calls.answer IS NULL), as TOO_LARGE's when longer than ANSWER_MAX as JSON;
  //   - a handler that throws with notConfirmed(err) answers MAY_HAVE_RUN, and with isLeaseRefused(err) the lease's
  //     message, each with isError; such an answer is kept only on a started row, as MAY_HAVE_RUN. Any other error
  //     as today.
  // db/agent-sql.ts
  export const PRE_COMMIT_SETTINGS: string;  // PRE_COMMIT's three SET LOCAL statements; PRE_COMMIT is these, then the lease check
  export const RECORD_CALL = "SELECT net.assert_lease('2 s', $1, $2, $3::jsonb)";
  //   run(text, mode, call?: { invocation: string; jobId: string; answer: (results: SqlAnswer[]) => unknown })
  //   mode write with call: PRE_COMMIT_SETTINGS, then RECORD_CALL with the invocation, the job and answer(results) as
  //   JSON (TOO_LARGE's answer when longer than ANSWER_MAX), then COMMIT; without call, as plan 3 left it. The write
  //   role gains EXECUTE on net.assert_lease(interval, uuid, uuid, jsonb).
  ```
- `mcp.ts`: `POST /mcp` passes `await invocationOf(req, ctx.config)` to `toolsFor`. The `database` tool in mode `write`,
  when `currentInvocation()` is set, gives `run` a `call` whose `answer` builds the tool's own answer from the results
  (its 30,000-character cut included), so the kept answer is what the agent would have read; after such a `run` the open
  source's `next` is 1, since `net.assert_lease` took step 0.

- [ ] **Step 1: Find the tools that act outside the database.** List every tool `toolsFor` registers whose handler,
  or the route a control tool calls through `app.inject`, reaches a node (`ctx.hub.send`), the updater, the computer
  access, the link's files, a process, another turn or the network. Each one not in ruling 7 joins `STARTS_FIRST`;
  the report names them.
- [ ] **Step 2: Write failing tests.**
  - `tool-calls.test.ts`, on `testApp({ TUNNEL_HOST: 'localhost' })` listening on `127.0.0.1` (so the test's own
    requests come from the keeper's address) with a company, an MCP client as `tools.test.ts` makes, and a raw `POST
    /mcp` helper that sets `x-hornhoof-invocation`:
    - `answers a retried call from what it kept`: `remember` twice with one invocation id gives one note and the same
      answer twice; `tool_calls` has the answer and `applied` lists `tool:<id>:0`.
    - `runs two calls with two ids`: the same `remember` with two ids gives two notes.
    - `tells a retry that the answer was lost`: after the first call its `tool_calls` row is deleted: the second
      answers `ALREADY_RAN` with `isError`, there is still one note, and the `applied` row was touched.
    - `commits a started row before acting`: a tool named `run_tests` registered through `guardTools` on an
      `McpServer` of the test's own, whose handler reads `tool_calls` for its id, finds the row with a null answer; a
      second call with the same id while the first waits answers `PENDING` with the first's time and touches the
      row; once the first answers, a third call gets its answer.
    - `keeps a may-have-run on a started row only`: a started tool whose handler throws `NotConfirmed` answers
      `MAY_HAVE_RUN`, and so does its retry; a `remember` that throws `NotConfirmed` before its write keeps no row,
      and its retry runs and makes one note.
    - `knows every tool that starts first`: each name of `STARTS_FIRST` is a tool `toolsFor` gives the orchestrator
      or an employee.
    - `keeps answers with their job`: with a `tool_calls` row of the same id for another job, the call answers
      `ID_TAKEN` with `isError` and adds no note.
    - `says a change may have run when its commit was not confirmed`: a handler that throws `NotConfirmed` answers
      `MAY_HAVE_RUN` with `isError`; one that throws a `HHF01` error answers the lease's message.
    - `keeps the database tool's answer in its own commit`: on `agentSqlOn`, a write call with an id that runs
      `UPDATE agents SET name = name || '!' WHERE ...`: its `tool_calls` row holds the tool's answer and shares the
      update's `xact`; the same id again answers that answer, and the name has one `!`.
    - `keeps a large answer as too large`: a tool registered through `guardTools` that answers 300 KiB of text keeps
      `TOO_LARGE`'s answer; the agent still gets the 300 KiB the first time.
    - `runs a call without an id as today`: no `tool_calls` row, no `tool:` row.
    - `takes an invocation id from the keeper alone`: on a second `testApp({ TUNNEL_HOST: 'keeper.invalid' })`, and on
      one without `TUNNEL_HOST`, a `remember` with a uuid in `x-hornhoof-invocation`, sent twice, runs as a call
      without one: two notes, no `tool_calls` row and no `tool:` row.
  - `real/agent-sql.test.ts`, `records a database call in the commit that the fence checks`: `run(..., 'write', call)`
    keeps the `tool_calls` and `applied` rows; with the lease ending in 1 s and `SELECT pg_sleep(2); UPDATE agents
    SET name = name`, it fails with `HHF01` and keeps neither.
- [ ] **Step 3: Run** Done when. Expected: FAIL (no `calls.ts`, `run` takes no call).
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Keep each tool call's answer under its invocation id, and run outside effects once".

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

### Task 6: The built-in node signs in with its machine's key, through front

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Task 5 committed. **Done when:** from
`apps/node`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keys.test.ts test/commands.test.ts` passes; from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/socket.test.ts test/compose.test.ts` passes, then
both whole suites; both `tsc` commands (node, server) print nothing.

**Files:**
- Modify: `apps/node/src/keys.ts` (`builtinKey`), `apps/node/src/main.ts` (`run --builtin`),
  `apps/server/src/modules/nodes/socket.ts` (`identify`), `compose.yaml`
- Test: `apps/node/test/keys.test.ts`, `apps/node/test/commands.test.ts`, `apps/server/test/socket.test.ts`,
  `apps/server/test/compose.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // apps/node/src/keys.ts
  export function builtinKey(nodeKey: string, machineId: string | null): string;
  //   with a machine id: `builtin.${machineId}.${hex HMAC-SHA256(key nodeKey, message 'hornhoof builtin node ' + machineId)}`;
  //   without one: nodeKey
  // apps/server modules/nodes/socket.ts identify(): a bearer `builtin.<m>.<64 hex>`, m 32 or 64 lowercase hex, whose
  //   HMAC matches (timing-safe) is BUILTIN, as the bare NODE_KEY is; one that does not match gets 401
  ```
- `run --builtin` reads `HORNHOOF_MACHINE_ID` (empty is none) and signs in with `builtinKey(NODE_KEY, it)`.
- `compose.yaml`: the `node` service's `HORNHOOF_SERVER` is `http://front:8080`, it gains `HORNHOOF_MACHINE_ID:
  ${HORNHOOF_MACHINE_ID:-}` and depends on `front`; the `app` service gains `HORNHOOF_MACHINE_ID:
  ${HORNHOOF_MACHINE_ID:-}`.

- [ ] **Step 1: Write failing tests.**
  - `keys.test.ts`, `derives the built-in node's key from its machine`: `builtinKey(k, m)` equals the value the test
    computes with `node:crypto`; two machine ids give two keys; `builtinKey(k, null)` is `k`.
  - `socket.test.ts`, `takes the built-in node's machine key and the bare key`: a socket with `builtinKey(NODE_KEY,
    m)` connects as the built-in node; the same with one hex digit changed, or with another machine id in front of
    `m`'s HMAC, gets 401; the bare `NODE_KEY` still connects as the built-in node.
  - `compose.test.ts`, `sends the built-in node through front with its machine id`: `node.environment` has
    `HORNHOOF_SERVER: http://front:8080` and `HORNHOOF_MACHINE_ID`, `node.depends_on` names `front`;
    `app.environment` has `HORNHOOF_MACHINE_ID`.
  - `commands.test.ts`, `signs the built-in node in with its machine key`: as `run --builtin`'s test does, with
    `HORNHOOF_MACHINE_ID` set, `server.headers[0]` is `Bearer builtin.<m>.<hex>`; the existing test, with
    `HORNHOOF_MACHINE_ID` removed from the env first, still sees the bare key.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Sign the built-in node in with its machine's key, through front".

### Task 7: front and the keeper hold, and front stamps tool calls

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Tasks 3 and 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/proxy.test.ts test/front.test.ts
test/front-calls.test.ts test/keeper.test.ts test/keeper-link.test.ts` passes, then the whole server suite; `npx tsc
-p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/net/front-calls.ts`
- Modify: `apps/server/src/net/proxy.ts`, `apps/server/src/net/front.ts`, `apps/server/src/modules/keeper/keeper.ts`
- Test: `apps/server/test/proxy.test.ts`, `apps/server/test/front.test.ts`, `apps/server/test/front-calls.test.ts`
  (new), `apps/server/test/keeper.test.ts`; any other test of plan 2 that expects 502 from a keeper or `startFront`
  whose target is down passes `holdMs: 0`

**Interfaces:**
- Consumes: `INVOCATION` (Task 3); plan 2's pass-through and keeper doors.
- Produces:
  ```ts
  // net/proxy.ts
  export const HOLD_MS = 60_000;          // front
  export const KEEPER_HOLD_MS = 45_000;   // the keeper, so that its answer reaches front inside front's hold
  //   PassOptions gains:
  //   holdMs?: number;                   // 0: as plan 2. A connect that fails (refused, not found, unreachable, or
  //                                      //   connectMs passing) is tried again every 500 ms until holdMs after the
  //                                      //   request came; nothing of the request is read before it connects
  //   holding?: (req) => Refusal | null; // asked before each new try; an answer ends the hold with it (the keeper's maintenance)
  //   held?: (req) => Refusal;           // the answer once holdMs ran out; heldAnswer when not given
  //   A client that goes away ends its hold. A body is piped only once the target's socket connected.
  export function heldAnswer(req: http.IncomingMessage): Refusal;
  //   503, Retry-After: 5; under /api/ and /mcp, application/json {"error":{"code":"unavailable","message":"Hornhoof
  //   did not answer for a minute. Try again in a few seconds.","reason":"starting"}}; otherwise text/plain the lines
  //   `Hornhoof did not answer for a minute. Try again in a few seconds.` and `Hornhoof не ответил за минуту.
  //   Попробуйте еще раз через несколько секунд.` An upgrade gets the same status line and body.
  // net/front-calls.ts
  export const CALL_HOLD_MS = 50_000;
  export const CALL_BODY_MAX = 1024 * 1024;     // the app's own body limit, which /mcp has
  export const CALL_ANSWER_MAX = 4 * 1024 * 1024;
  export const CALL_LOST = 'Hornhoof did not answer this call in time. It may have run; look at its result before you repeat it.';
  export const CALL_NOT_SENT = 'Hornhoof could not be reached in time, so this call did not run. Try it again shortly.';
  export function frontCalls(opts: { keeper: Target; holdMs?: number }): (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  //   takes POST /mcp and answers true; anything else false. Reads the body: one over CALL_BODY_MAX answers 413
  //   {"error":{"code":"validation","message":"Request body is too large"}}, as the app would; a JSON array (a
  //   batch) answers 400 {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Hornhoof takes one call per
  //   request."}}. A request with method 'tools/call' and an id gets a fresh randomUUID() as x-hornhoof-invocation
  //   (an incoming one is dropped, as every x-hornhoof-* is). Each try is a new connection to the keeper with front's
  //   x-forwarded-for. A tools/call's answer is read whole (up to CALL_ANSWER_MAX; a longer one streams on as it
  //   comes, and is not tried again) before it goes to the agent. A connect that fails, a reset, an answer that
  //   breaks off, a 502, or a 503 whose reason is 'starting' is tried again with the same body and id every 500 ms,
  //   until holdMs (CALL_HOLD_MS) after the first failure. Any other answer goes to the agent as it came. When
  //   holdMs runs out: 200, application/json, {"jsonrpc":"2.0","id":<the request's id>,"result":{"content":[{"type":
  //   "text","text":<CALL_NOT_SENT when no try connected, else CALL_LOST>}],"isError":true}}; for a body that is not
  //   a tools/call, the last answer, or heldAnswer when none came.
  ```
- `startFront` gains `holdMs?: number` (`HOLD_MS`): `frontCalls` first (with `CALL_HOLD_MS`), then `passThrough` with
  `holdMs`.
- The keeper: `KeeperOptions` gains `holdMs?: number` (`KEEPER_HOLD_MS`); each door's `passThrough` gets it and
  `holding` that answers the maintenance refusal while `mode()` is `maintenance`, so a held request ends with it at
  once. The front door's `headers()` adds `x-hornhoof-invocation` from the request when the socket is `front`'s (as
  for `x-forwarded-for`) and the value is a uuid.

- [ ] **Step 1: Write failing tests.**
  - `proxy.test.ts`, `holds a request while the target is down, up to holdMs`: with `holdMs` 3000 and the target's
    port taken from a listener that was closed, a `POST` with a 1 MiB body sent while the target is down gets 200 and
    its whole body once the target listens on that port 700 ms later; with the target never up, 503 and `heldAnswer`
    after about 3 s; a WebSocket held the same way opens once the target is up; a client that goes away during the
    hold leaves no connection behind. Plan 2's `answers for a target that is down` keeps its 502 without `holdMs`.
  - `proxy.test.ts`, `ends a hold with the answer holding gives`: `holding` answering a 503 after 400 ms ends a held
    request with it.
  - `front-calls.test.ts`, with a fake keeper (`http.createServer`):
    - `stamps each tool call with its own id`: two identical `tools/call` bodies reach the keeper with two different
      uuids in `x-hornhoof-invocation`; a `tools/list` arrives with none; an `x-hornhoof-invocation` the agent sent
      never arrives.
    - `sends a call again with the same id until it is answered`: a keeper that destroys the first try's socket
      before answering and answers the second with 200 gives the agent that 200; the keeper saw one id twice.
    - `sends a call again whose answer broke off`: a keeper that writes the head and half the JSON, then destroys the
      socket, and answers the next try whole: the agent gets only the whole answer.
    - `sends a call again while the app is starting`: a keeper that answers 503 with reason `starting`, then 200,
      gives the agent the 200, under one id.
    - `answers a call lost in time`: with `holdMs` 1500, a keeper that always destroys the socket gives the agent
      `CALL_LOST` with the request's id and `isError`; no keeper at all gives `CALL_NOT_SENT`.
    - `passes other answers as they came`: a keeper answering 401 gives the agent 401 and its body; one answering 503
      with reason `maintenance` gives that 503 at once.
    - `refuses a batch and a call too large for the app`: a JSON array answers 400 and a body of 1 MiB and one byte
      answers 413; neither reaches the keeper.
  - `front.test.ts`, `stamps tool calls and holds the rest`: through `startFront`, a `tools/call` reaches the target
    with an invocation id, and a `GET` sent while the target is down arrives once it is up.
  - `keeper.test.ts`: plan 2's `answers maintenance while the app is down during an update, and starting otherwise`
    becomes `answers maintenance at once while the app is down during an update, and holds otherwise`: with `holdMs`
    1000 and the app down, `heldAnswer` comes after about 1 s, and maintenance at once.
  - `keeper.test.ts`, `holds while the app is down, and answers maintenance at once`: with the app target down, a
    `GET` on the front door gets 200 once the app listens 700 ms later; with `status.json` `running`/`install`, the
    maintenance 503 comes at once, also for a request held before it was written.
  - `keeper.test.ts`, `passes front's invocation id and no one else's`: with `frontHost: 'localhost'` a uuid in
    `x-hornhoof-invocation` reaches the app; `front.invalid` drops it; a value that is not a uuid is dropped.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no hold, no stamps).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Hold requests in front and the keeper while the next hop restarts, and stamp each tool call".

### Task 8: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `work-survives`. **Starts from:** Tasks 1 to 7 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Update is
Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` → pass; the four
  `tsc` commands → no output.
- [ ] **Step 2: Check the public-repo rule.** `git diff main --stat` lists no key or certificate file; `git grep -nE
  "BEGIN (EC )?PRIVATE KEY|BEGIN CERTIFICATE" -- ':!*.md'` prints nothing and exits with status 1; `git diff main |
  grep -nE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'` shows only `127.0.0.1`, `0.0.0.0` and addresses in `192.0.2.0/24`,
  `198.51.100.0/24` and `203.0.113.0/24`.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.9 and section 9 step 11, the overview's plan 4
  entry and this plan's rulings, with the lists Tasks 2, 3 and 4 reported; the CLI agent that did not write a task
  reviews it too (Gemini for Codex's tasks, Codex for Gemini's); one fix pass, each fix with its failing test first.
- [ ] **Step 4: Rehearse** (team lead), on a throwaway company on a machine of Ivan's, the team lead's test stand as in
  plan 3: install the current release (plan 3's) as `install.sh server --name rehearsal`, set it up with a random link,
  connect one plan node to it on localhost; build the branch's images by hand (`gh workflow run images.yml --ref
  work-survives`) and read their digests; each update a `request.json` through a short updater container, as in plan
  2. The checks, from `~/hornhoof-rehearsal`: plan 3's lease checks; `/api/health` says `lead`; the Machines tab shows
  the built-in node and the plan node online; `docker compose exec -T db psql -U hornhoof -d hornhoof -tAc "SELECT
  split_part(source, ':', 1), count(*) FROM applied GROUP BY 1"` lists `web` after a change made on localhost, and
  `node` while a turn runs. In this order:
  1. Forward, from the release to the branch build: it ends `done` and the checks pass. Before it, the team lead
     compares the node image digests of the two builds, as Step 6 will, and after it records which node containers
     started again, by their start times (`docker inspect -f '{{.Name}} {{.State.StartedAt}}'` on each node
     container, before and after); since the node image changed, ruling 10 expects all of them, the plan node too.
     `docker compose exec -T node printenv HORNHOOF_SERVER HORNHOOF_MACHINE_ID` shows `http://front:8080` and the
     machine id of `.env`.
  2. A turn on the plan node (a message to the orchestrator), and `docker compose restart app` while it runs: within
     70 s the node is online again, the turn ends `done`, its events show each tool step once, and `docker compose
     logs app` has no `machine_restarted` for it. The same with `docker compose restart front` while a turn runs.
     When the team lead holds an API key for tests, the same with a turn on the built-in node.
  3. A change sent twice with one key: `curl` signs in on localhost, then `POST`s a new task twice with one
     `Idempotency-Key`: one task, and the second answer is 409 with reason `already_done`.
  4. Back, a downgrade to the release: it ends `done`, the plan node works with it, and a change on localhost works.
  5. Forward again to the branch build: it ends `done`, and the checks pass; the team lead notes whether the node
     containers were kept (`node_unchanged`) or started again, by their start times.
  Then remove the link in Share access, `docker compose down -v` in `~/hornhoof-rehearsal` only, remove that folder,
  and remove its registry line by hand. Any step that fails: stop and report, and Ivan is not asked to update.
- [ ] **Step 5: Merge** (team lead). The Update's title is the subject of the commit the images are built from, so the
  team lead writes the merge commit into main with exactly this subject (86 characters, no double quote):
  ```text
  Apply node messages, tool calls and page changes once, and keep them through a restart
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** Before each Update, the team lead compares, reading only, the
  digest of the node image the company runs with the new release's node digest, and tells Ivan in one line whether
  running turns will end (ruling 10: for this build they will, on every node the Update sweeps); when they will, Ivan
  picks a moment between turns. Ivan presses Update on his own companies himself, one at a time; the team lead never
  runs an install, an update or a `request.json` on them. After each, the team lead runs the checks above and plan 3's,
  reading only, and reports; an hour after the Update, plan 3's `grep -cE` on `docker compose logs app` prints 0. When
  one fails, or the Update does not end within 20 minutes, the team lead tells Ivan which release to go back to, the one
  before, and how: in Versions, that release's Install button, or, when the app does not answer or only reads,
  `HORNHOOF_VERSION=<that release> install.sh server` (with `--name <name>` for a named company) on that machine. Ivan
  does it; then stop and report.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/work-survives` once main has
  the branch.
