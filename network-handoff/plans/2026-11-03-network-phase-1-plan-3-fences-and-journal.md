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

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/fences-and-journal` on a new branch `fences-and-journal` from
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
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
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

### Task 1: Real Postgres for the tests

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** main with plan 2 merged. **Done when:** from
the worktree root `npm run test:real` passes with Docker running, and from `apps/server`
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/compose.test.ts` passes.

**Files:**
- Create: `apps/server/test/real/pg.ts`, `apps/server/test/real/postgres.test.ts`
- Modify: `apps/server/test/real/run.sh`, `CONTRIBUTING.md` (its `test:real` line names Postgres too)
- Test: `apps/server/test/real/postgres.test.ts`, `apps/server/test/compose.test.ts`

**Interfaces:**
- Produces, in `test/real/pg.ts`:
  ```ts
  export function realServer(): string;   // HH_REAL_PG; throws 'run with npm run test:real' when unset
  export async function realDatabase(): Promise<{ url: string; admin: pg.Client; drop(): Promise<void> }>;
  //   CREATE DATABASE hh_<12 random hex> on the container; admin: a connected superuser client on it;
  //   drop(): ends admin, DROP DATABASE ... WITH (FORCE), then DROP ROLE IF EXISTS of agentRole and readerRole of
  //   that database name. Each test file calls it in beforeAll and drop() in afterAll.
  ```
- `run.sh` also starts `postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1` (the
  image of compose's `db`) as `hornhoof-pg-$$`, with `-e POSTGRES_PASSWORD=<32 hex from /dev/urandom>`, `-p
  127.0.0.1::5432`, and after the image the command `-c wal_level=logical -c max_replication_slots=10 -c
  max_wal_senders=10 -c max_prepared_transactions=0`. It waits up to 60 s for `docker exec hornhoof-pg-$$ pg_isready
  -h 127.0.0.1 -U postgres` (over TCP, which the image's first-start server does not open), reads the port with
  `docker port hornhoof-pg-$$ 5432/tcp`, and runs vitest with `HH_REAL_PG=postgres://postgres:<password>@127.0.0.1:
  <port>/postgres` beside Pebble's variables. The `trap` removes this container too. When `HH_REAL_PG` is set
  already, run.sh starts no container and uses it.

- [ ] **Step 1: Write failing tests.**
  - `postgres.test.ts`, `runs Postgres 17.11 with the settings of the company's db`: `SHOW server_version` starts with
    `17.11`; `wal_level` is `logical`; `max_prepared_transactions` is `0`.
  - `postgres.test.ts`, `brings a fresh database up to this build`: `migrateDb(url)` answers the number of entries in
    `drizzle/meta/_journal.json`; a query on `openDb(url, APP_NAME)` works, and `pg_stat_activity` shows its session
    with `application_name` `hornhoof-app`.
  - `compose.test.ts`, `starts the real tests' Postgres as compose starts db`: `test/real/run.sh` contains the `image`
    of compose's `db` service and each `-c` setting of its `command`.
- [ ] **Step 2: Run** Done when. Expected: FAIL (`run with npm run test:real`; run.sh names no Postgres).
- [ ] **Step 3: Implement** `pg.ts` and the run.sh change. `realDatabase` connects with `pg.Client` from the server's
  own dependency.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run the real tests against the company's Postgres 17.11 too".

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

### Task 3: The orchestrator's SQL, the app's commits and their errors

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sql-check.test.ts test/confirm.test.ts
test/fence-lint.test.ts test/db-pool.test.ts test/errors.test.ts test/orchestrator-control.test.ts
test/journal.test.ts` passes, then the whole server suite; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx
vitest run test/i18n.test.tsx` passes; from the worktree root `npm run test:real` passes and both `tsc` commands print
nothing; the report has Step 1's list.

**Files:**
- Create: `apps/server/src/db/sql-check.ts`, `apps/server/src/db/confirm.ts`
- Modify: `apps/server/package.json` and `package-lock.json` (`libpg-query`), `apps/server/src/db/agent-sql.ts`,
  `apps/server/src/db/client.ts` (`stripSettings`, `openPool`, `openDb`), `apps/server/src/main.ts`,
  `apps/server/src/cli.ts`, `apps/server/src/modules/tools/database.ts`, `apps/server/src/errors.ts`,
  `apps/server/src/modules/keeper/app-mode.ts` (exports `READ_ONLY_MESSAGE`), `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`, `apps/server/test/helpers.ts` (`agentSqlOn`)
- Test: `apps/server/test/sql-check.test.ts`, `apps/server/test/confirm.test.ts`, `apps/server/test/fence-lint.test.ts`
  (all new), `apps/server/test/db-pool.test.ts`, `apps/server/test/errors.test.ts`,
  `apps/server/test/orchestrator-control.test.ts`, `apps/server/test/journal.test.ts`, `apps/web/test/i18n.test.tsx`,
  `apps/server/test/real/agent-sql.test.ts` (new)

**Interfaces:**
- Consumes: `LEASE_REFUSED`, `isLeaseRefused`, `setLease` (Task 2); `realDatabase` (Task 1).
- Produces:
  ```ts
  // db/sql-check.ts
  export class SqlRefused extends Error { readonly kind: 'statement' | 'function' | 'syntax' }
  export const ONLY_STATEMENTS = 'This tool runs only SELECT, INSERT, UPDATE, DELETE and WITH statements; Hornhoof begins and commits the transaction itself.';
  export async function checkAgentSql(text: string): Promise<void>;
  //   libpg-query's parse; a parse error throws SqlRefused('syntax') with the parser's message; a statement that is not
  //   SelectStmt (without intoClause), InsertStmt, UpdateStmt or DeleteStmt throws SqlRefused('statement',
  //   ONLY_STATEMENTS); a FuncCall anywhere in the tree whose name is refused (ruling 4; the last part of funcname,
  //   lo_ as a prefix; any call qualified with net or net_local), or a refused name as a field (the last String of a
  //   ColumnRef with two or more fields, or a String in an A_Indirection's indirection), throws
  //   SqlRefused('function', `This tool does not call ${name}.`)
  // db/confirm.ts
  export class NotConfirmed extends Error {}   // 'The database could not confirm the commit, so the change may or may not be saved.'
  export function confirmCommits(client: pg.ClientBase): void;
  //   watches client.query in every form pg takes (text, text and values, a config object, each with or without a
  //   callback; a Submittable passes unwatched), as ruling 5 says: a call it watches that got a notice fails with
  //   NotConfirmed (cause: the notice) instead of its result; a call that failed keeps its own error. Twice on one
  //   client is once.
  export function keepErrors(client: pg.ClientBase): void;
  //   an 'error' listener for the client's whole life that does nothing, so an error between two queries cannot end
  //   the process; pg-pool still sees it, and the client's next query fails. Twice on one client is once.
  export function notConfirmed(err: unknown): boolean;
  //   on err or one of its causes: NotConfirmed; code 57P01, 25P04, ECONNRESET or EPIPE; a message starting
  //   'Connection terminated' or equal to 'Client has encountered a connection error and is not queryable' (what
  //   drizzle's ROLLBACK on a dead connection throws in place of the first error)
  export const requestRoute: AsyncLocalStorage<string>;   // '<METHOD> <route pattern>' of the request running, as 'GET /api/tasks/:id'
  export function logTimeouts(client: pg.ClientBase, log: (line: string) => void): void;
  //   notes when each BEGIN goes out on the client and requestRoute's store at that moment; the first error with code
  //   25P04 the client gets, as a query's error or between two queries, logs `The 5 s limit ended a transaction of
  //   <route> after <ms> ms.` (ruling 20): <route> that store, or `work outside a request` without one; <ms> the
  //   whole milliseconds since that BEGIN. A COMMIT, END or ROLLBACK that succeeds more than 2000 ms after its BEGIN
  //   logs `A transaction of <route> ran <ms> ms.` the same way. Twice on one client is once.
  // db/client.ts
  export function stripSettings(url: string): string;   // url without its options and application_name parameters (ruling 18)
  export function openPool(url: string, onDropped: (err: Error) => void, name: string, opts?: { statementTimeoutMs?: number; fenced?: boolean }): pg.Pool;
  //   connects to stripSettings(url) and runs keepErrors on each client it connects, for every name; name APP_NAME:
  //   options '-c transaction_timeout=5s -c client_min_messages=warning', plus ' -c hornhoof.fenced=on' when fenced,
  //   and confirmCommits and logTimeouts(client, console.warn) on each client; other names as in plan 2
  // db/agent-sql.ts
  export const PUBLIC_REVOKES: string;   // one DO block: REVOKE EXECUTE ... FROM PUBLIC on every overload in pg_catalog of the names in ruling 4
  export const REFUSED_FUNCTIONS: string[];   // those names, 'lo_*' standing for the prefix
  export const PRE_COMMIT = "SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = 0; SET LOCAL client_min_messages = warning; SELECT net.assert_lease('2 s', NULL)";
  // errors.ts: ErrorReason gains 'not_confirmed'; export const NOT_CONFIRMED = 'Hornhoof could not confirm this change. It may be saved; look before you try again.'
  ```
- `openAgentSql`: runs `PUBLIC_REVOKES` before the grants. `role()` takes each role's settings: the write role `RESET
  statement_timeout` and `SET transaction_timeout = '5s'`, the read role `statement_timeout = '15s'` as today, both
  `idle_in_transaction_session_timeout = '30s'`. The write role gets `GRANT USAGE ON SCHEMA net` and `GRANT EXECUTE ON
  FUNCTION net.assert_lease(interval, uuid)`; the read role nothing in `net`. Each agent pool's address starts from
  `stripSettings(url)`, and the pool runs `keepErrors` and `confirmCommits` on every client it connects. `run` in mode
  `write` sends `PRE_COMMIT` after the text and before `COMMIT`. `agentSqlOn` in `helpers.ts` applies `PUBLIC_REVOKES`
  with the grants and runs `PRE_COMMIT` under the write role the same way.
- `main.ts` and `cli.ts` open `openDb(url, APP_NAME, { fenced: config.keeper })`.
- The `database` tool runs `checkAgentSql(sql)` before `ctx.agentSql.run`. A `SqlRefused` answers `Hornhoof did not run
  this SQL: <message>`, followed in mode `read` for kind `statement` by a space and `READ_ONLY`. An error for which
  `notConfirmed(err)` is true answers `The database answered: <message> The call may have run; check before repeating
  it.` Everything else as today. In the write description, `Several statements run in one transaction and are undone
  together when one fails; a call may take 15 seconds.` becomes `Only SELECT, INSERT, UPDATE, DELETE and WITH statements
  run, several in one transaction that Hornhoof begins and commits, undone together when one fails; a call may take 5
  seconds.`; in the read one, `Several statements run in one transaction;` becomes `Only SELECT and WITH statements run,
  several in one transaction;`.
- `registerErrorHandling` adds, first, a `preHandler` hook that runs the rest of each request inside ``
  requestRoute.run(`${req.method} ${req.routeOptions.url}`, done) ``, and, before its 500: `isLeaseRefused(err)` answers
  503 `{ code: 'unavailable', message: READ_ONLY_MESSAGE, reason: 'read_only' }`; `notConfirmed(err)` answers 503 `{
  code: 'unavailable', message: NOT_CONFIRMED, reason: 'not_confirmed' }` and logs one warning line with
  `loggable(err)`.
- `en.ts` `errors.not_confirmed`: `NOT_CONFIRMED`'s text; `ru.ts`: `Hornhoof не смог подтвердить это изменение.
  Возможно, оно сохранено: проверьте, прежде чем повторять.`
- The lint (`fence-lint.test.ts`) reads every `.ts` file under `apps/server/src` and fails, naming file and line, on a
  line with `session_replication_role`; `SET CONSTRAINTS` and `IMMEDIATE`; `synchronous_commit` and `off`, `local` or
  `remote_write`, except in `src/modules/keeper/lease-store.ts`; `TRUNCATE`; `DISABLE TRIGGER`; `PREPARE
  TRANSACTION`; `new pg.Pool(`, `new Pool(`, `new pg.Client(` or `new Client(` outside `src/db/client.ts`,
  `src/db/agent-sql.ts` and `src/modules/keeper/lease-store.ts`. All case-insensitive.

- [ ] **Step 1: List the app's transactions that wait on more than the database** (ruling 20). In `apps/server/src`,
  every `.transaction(` (36 in main while planning, plus what plans 1b and 2 added) whose callback, or a function it
  awaits, awaits anything but queries on its own `tx`: a node message, git, fetch, the file system, a timer, ACME, a
  child process, a queue that waits on other work, slow crypto, or a query on the outer `db`. Each one moves out of the
  transaction, or gets a test that keeps it under 1 s, or goes to the team lead before Step 4. The task's report gives
  the list, also when it is empty. While planning none of main's 36 did: the callbacks passed in (`move()`'s `also`,
  `appendEvent`'s `also`, `locked`'s `fn`) use only `tx`, and `hashPassword` and the relay's `bind` run before their
  transactions.
- [ ] **Step 2: Write failing tests.**
  - `sql-check.test.ts`:
    - `lets reads and row changes through`: `SELECT 1`, `WITH x AS (SELECT 1) SELECT * FROM x`, `INSERT ...`,
      `UPDATE ...`, `DELETE ...`, `WITH d AS (DELETE FROM notebook_notes RETURNING id) SELECT count(*) FROM d`, `SELECT
      pg_sleep(1)`, and two of them in one text resolve.
    - `refuses what is not a row change, also after a first statement`: `COMMIT`, `BEGIN`, `SET LOCAL
      synchronous_commit = local`, `RESET transaction_timeout`, `SET CONSTRAINTS ALL IMMEDIATE`, `DO $$ BEGIN END $$`,
      `CALL p()`, `PREPARE TRANSACTION 'x'`, `MERGE INTO ...`, `EXPLAIN SELECT 1`, `SELECT 1 INTO t`, `CREATE TABLE t
      (id int)`, and each of them after `SELECT 1; ` reject with kind `statement` and `ONLY_STATEMENTS`.
    - `refuses the functions that reach other sessions, settings, large objects or hidden queries`:
      `SELECT pg_cancel_backend(1)`, `SELECT pg_catalog.pg_terminate_backend(1)`, `SELECT pg_reload_conf()`, `SELECT
      set_config('transaction_timeout', '0', true)`, `SELECT set_config('search_path', 'public', true)`, `SELECT
      lo_from_bytea(0, '\x00')`, `SELECT loread(0, 1)`, `SELECT query_to_xml('select 1', true, true, '')`, `SELECT *
      FROM ts_stat('select 1')`, `SELECT ts_rewrite('x'::tsquery, $$SELECT 'x'::tsquery, 'y'::tsquery FROM
      net.assert_lease('0s', NULL)$$)`, `SELECT net.assert_lease('0 s', NULL)`, `SELECT 1 FROM agents WHERE id IN
      (SELECT id FROM agents WHERE pg_cancel_backend(1))`, `UPDATE agents SET name = set_config('a.b', 'c', true)`,
      and the field spellings `SELECT (pg_backend_pid()).pg_cancel_backend` and `SELECT a.pg_terminate_backend FROM
      agents a` reject with kind `function`, the message naming the function.
    - `says what the parser says about a typo`: `SELEC 1` rejects with kind `syntax` and a message containing
      `syntax error`.
  - `confirm.test.ts`, on a fake client (an `EventEmitter` with `query` and `getTransactionStatus`, which emits a
    notice while a query runs when the test asks):
    - `fails a commit that got a warning`: `COMMIT` and `end` with a notice reject with `NotConfirmed`, its cause the
      notice; without one they resolve.
    - `fails a statement outside a transaction that got a warning`: status `I`, an `INSERT` with a notice rejects;
      status `T`, the same resolves; `ROLLBACK` and `BEGIN` with a notice resolve.
    - `watches every form of query`: a config object, text with values, and a callback each behave the same.
    - `keeps the database's own error`: a `COMMIT` that fails with `HHF01` and got a notice rejects with that error.
    - `notConfirmed` is true for `NotConfirmed`, `{ code: '57P01' }`, `{ code: '25P04' }`, `{ code: 'ECONNRESET' }`,
      `{ code: 'EPIPE' }`, `new Error('Connection terminated unexpectedly')`, `new Error('Client has encountered a
      connection error and is not queryable')` and a `DrizzleQueryError` whose cause is one of them, and false for `{
      code: '23505' }`.
    - `keeps an error between queries from ending the process`: after `keepErrors` twice, the client has one `error`
      listener, and `emit('error', new Error('gone'))` does not throw.
    - `names the route of a transaction the limit ended`: with `logTimeouts` on the fake client and `Date.now` moved by
      the test, a `begin` sent inside `requestRoute.run('GET /api/org', ...)` and an `error` event with code `25P04`
      120 ms later log `The 5 s limit ended a transaction of GET /api/org after 120 ms.` once, also when the next
      query then fails with `25P04` too; without a store the line says `work outside a request`; code `57P01` logs
      nothing.
    - `warns of a transaction that ran over 2 s`: a `begin` inside `requestRoute.run('POST /api/tasks', ...)` and a
      `commit` that resolves 2100 ms later log `A transaction of POST /api/tasks ran 2100 ms.`; a `commit` 1900 ms
      after its `begin` logs nothing; a `rollback` 2500 ms after a `begin` outside a request logs `A transaction of
      work outside a request ran 2500 ms.`.
  - `fence-lint.test.ts`, `keeps the app's code from getting past a fence`: the rules above hold for `apps/server/src`
    as it is, and each rule fails on a one-line sample (the test runs the rules on the samples too).
  - `db-pool.test.ts`, `fences the app's pool and ends its transactions after 5 s`: `openPool(url, () => {}, APP_NAME,
    { fenced: true }).options.options` is `-c transaction_timeout=5s -c client_min_messages=warning -c
    hornhoof.fenced=on`; without `fenced` it lacks the last part; a `KEEPER_NAME` pool has no `options`.
  - `db-pool.test.ts`, `takes the settings out of the address`:
    `stripSettings('postgres://u:p@h:5432/d?options=-c%20a%3Db&sslmode=disable&application_name=x')` is
    `postgres://u:p@h:5432/d?sslmode=disable`; the same address without parameters comes back as it was; an `APP_NAME`
    pool opened with the first has a `connectionString` without `options=` or `application_name=`.
  - `errors.test.ts`, `runs each route inside requestRoute`: a route `/api/x/:id` that awaits a 10 ms timer and then
    answers `requestRoute.getStore()` answers `GET /api/x/:id` for `GET /api/x/1`.
  - `errors.test.ts`, `answers a refused lease as read_only and a lost commit as not_confirmed`: a route that throws a
    `DrizzleQueryError` caused by `{ code: 'HHF01' }` answers 503 with reason `read_only`; one that throws
    `NotConfirmed`, and one that throws `{ code: '57P01' }`, answer 503 with reason `not_confirmed` and
    `NOT_CONFIRMED`.
  - `journal.test.ts`, `answers read_only to a write when the lease has ended`: on `testApp()` with a company set up,
    after `setLease(db, { until: '-infinity' })`, `GET /api/me` answers 200 and an employee's rename through the API
    answers 503 with reason `read_only`.
  - `orchestrator-control.test.ts`: in `is refused sign-ins, invites, install codes, the public link, passwords and the
    tables themselves`, `/permission denied|must be owner/` also takes `Hornhoof did not run this SQL`; new, `refuses
    SQL that would get past a fence`: `COMMIT`, `SET LOCAL synchronous_commit = local; UPDATE agents SET name = name`,
    `SELECT pg_cancel_backend(1)` and `SELECT 1; SET CONSTRAINTS ALL IMMEDIATE` each answer `isError` with `Hornhoof
    did not run this SQL:`, and no agent's name changed; `answers in five seconds`: the write tool's description
    says `a call may take 5 seconds`.
  - `i18n.test.tsx`, `shows a known reason in the chosen language` gains `not_confirmed` in both.
  - `real/agent-sql.test.ts`, on a `realDatabase()` migrated with `migrateDb`, `state` and an endless `lease` written
    by the admin, and `openAgentSql(url)`:
    - `refuses the agent roles what would undo a fence`: through `run(..., 'write')`: `ALTER TABLE tasks DISABLE
      TRIGGER net_journal` (`must be owner`), `SET session_replication_role = replica`, `SELECT * FROM net_local.lease`,
      `SELECT * FROM net.journal`, `INSERT INTO net.journal (xact, tbl, op, key, cols) VALUES (gen_random_uuid(), 'x',
      'insert', '{}', '{}')`, `SELECT * FROM applied`, `SELECT * FROM tool_calls`, `SELECT net.attach_journal()`,
      `SELECT pg_cancel_backend(1)`, `SELECT lo_from_bytea(0, '\x00')`, `SELECT set_config('transaction_timeout', '0',
      true)`, `SELECT query_to_xml('select 1', true, true, '')` and `SELECT ts_rewrite('x'::tsquery, 'SELECT
      ''x''::tsquery, ''y''::tsquery')` each fail with code `42501`, or `must be owner` for the first; `SELECT
      net.assert_lease('2 s', NULL)` passes in mode `write` and fails with `42501` in mode `read`.
    - `keeps its own settings whatever the address says`: with the address given `options=-c hornhoof.fenced=off -c
      transaction_timeout=0` and `application_name=x` (set with `searchParams`), on `openDb(that, APP_NAME, { fenced:
      true })` `SHOW hornhoof.fenced` is `on`, `SHOW transaction_timeout` is `5s` and
      `current_setting('application_name')` is `hornhoof-app`; through `openAgentSql(that)`, `SHOW
      transaction_timeout` in mode `write` is `5s`.
    - `keeps the process up and names the route when the limit ends an idle transaction`: a small Fastify app with
      `registerErrorHandling` and a route `GET /slow` whose `db.transaction`, on `openDb(url, APP_NAME, { fenced: true
      })`, runs `SELECT 1`, waits 6 s in Node and runs `SELECT 1` again: `inject` answers 503 with reason
      `not_confirmed` (`transaction_timeout` ended the idle session; what drizzle throws is its `ROLLBACK`'s error),
      `console.warn` got one `The 5 s limit ended a transaction of GET /slow after <ms> ms.` with `<ms>` from 5000 to
      6500, no uncaught error reaches vitest, and the pool's next query works. The same transaction outside a request,
      with the admin's `pg_terminate_backend` of its session in place of the wait, rejects with `notConfirmed(err)`
      true and logs no such line.
    - `ends a transaction of the app that runs over 5 s`: `db.transaction` running `SELECT pg_sleep(6)` rejects with
      `notConfirmed(err)` true, `console.warn` got `The 5 s limit ended a transaction of work outside a request after
      <ms> ms.`, and the pool's next query works.
    - `cannot cancel another session of its own role`: one write call runs `SELECT pg_sleep(2)` while a second, given
      the first's pid from `pg_stat_activity`, runs `SELECT pg_cancel_backend(<pid>)` and fails with `42501`; the
      first succeeds.
    - `refuses PREPARE TRANSACTION`: on the admin, `BEGIN` and `PREPARE TRANSACTION 'x'` fail with `prepared
      transactions are disabled`.
    - `refuses before COMMIT a text that sleeps past the lease`: with the lease until now + 3 s, `SELECT pg_sleep(2);
      UPDATE agents SET name = name` fails with `HHF01` and leaves no journal row.
    - `ends a call that runs over 5 s`: `SELECT pg_sleep(6)` in mode `write` fails, and `notConfirmed(err)` is true.
    - `waits at commit for a copy and reports a cancelled wait as not confirmed`: with `ALTER SYSTEM SET
      synchronous_standby_names = 'FIRST 1 (nobody)'` and `pg_reload_conf()` (reset and reloaded in `afterEach`), an
      insert on `openDb(url, APP_NAME, { fenced: true })` waits with `wait_event` `SyncRep`; the admin's
      `pg_cancel_backend` on it makes the insert reject with `NotConfirmed` while the row is committed; the same with
      the client's own `SET statement_timeout = 300` instead of the cancel; `pg_terminate_backend` instead makes it
      reject with `notConfirmed(err)` true; a write call of the agent role, cancelled the same way, rejects with
      `NotConfirmed`.
- [ ] **Step 3: Run** Done when. Expected: FAIL (no check, no wrapper, no reason, the old role settings).
- [ ] **Step 4: Implement** the interfaces above, after installing the dependency as the Global Constraints say.
- [ ] **Step 5: Run Done when.** Expected: PASS.
- [ ] **Step 6: Commit** "Parse the orchestrator's SQL, end transactions after 5 seconds, and report a commit not
  confirmed".

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

### Task 5: The keeper answers `/api/network/lease`

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper-link.test.ts test/keeper.test.ts` passes,
and from the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/modules/keeper/keeper.ts`
- Test: `apps/server/test/keeper-link.test.ts`

**Interfaces:**
- Consumes: `Keeper.term()` (Task 4); plan 2's link doors.
- On the link's `http` door and the link's TLS server, before the pass-through: `GET /api/network/lease?nonce=<n>`
  with `n` matching `^[A-Za-z0-9_-]{16,128}$` answers 200, `Content-Type: application/json`, `Cache-Control:
  no-store`, `{ machine: config.machineId, term: keeper.term(), nonce: n }`; with any other nonce, 400 with `no-store`
  and `{"error":{"code":"validation","message":"nonce must be 16 to 128 letters, digits, - or _."}}`. Other methods
  and paths, and every request on the front door, pass on as today.

- [ ] **Step 1: Write failing tests** in `keeper-link.test.ts`:
  - `answers the lease itself on the link`: through the link's `http` door, `GET /api/network/lease?nonce=` with 22
    random base64url characters answers the keeper's machine id, the fake lease's term and the nonce, with
    `Cache-Control: no-store`, and the echoing target got nothing; the same through the TLS server, sent a PROXY v2
    header and a TLS client with the link's host as servername.
  - `answers no term without a lease`: with a store whose `take` throws, `term` is `null`.
  - `refuses a nonce it would not send`: `abc` and 129 characters answer 400 with the message above.
  - `leaves the lease path to the app on the front door`: the echoing target gets the request.
- [ ] **Step 2: Run** Done when. Expected: FAIL (the request reaches the target).
- [ ] **Step 3: Implement** the answer.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Answer the lease proof from the keeper on the public link".

### Task 6: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** Tasks 1 to 5 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Update is
Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` → pass; `npx tsc
  -p apps/server/tsconfig.json --noEmit` and `npx tsc -p apps/web/tsconfig.json --noEmit` → no output.
- [ ] **Step 2: Check the public-repo rule.** `git diff main --stat` lists no key or certificate file; `git grep -nE
  "BEGIN (EC )?PRIVATE KEY|BEGIN CERTIFICATE" -- ':!*.md'` prints nothing and exits with status 1; `git diff main |
  grep -nE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'` shows only `127.0.0.1`, `0.0.0.0` and addresses in `192.0.2.0/24`,
  `198.51.100.0/24` and `203.0.113.0/24`.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.4, 3.7, 3.9, 3.10 and section 9, the
  overview's plan 3 entry and this plan's rulings; the CLI agent that did not write a task reviews it too (Gemini for
  Codex's tasks, Codex for Gemini's); one fix pass, each fix with its failing test first.
- [ ] **Step 4: Rehearse** (team lead), on a throwaway company on a machine of Ivan's. It is the team lead's test
  stand, the one install the team lead makes, updates and removes; nothing in it touches Ivan's companies, their
  folders or their registry lines:
  - Build the branch's images by hand (`gh workflow run images.yml --ref fences-and-journal`), and a broken one from a
    throwaway branch `fences-and-journal-broken`: one commit on `fences-and-journal` that adds a migration, made the way
    the repo makes them, which drops `notebook_notes.by_orchestrator` and updates `notebook_notes`, and makes
    `apps/server/src/main.ts` exit 1 before it listens; never merged, deleted afterwards. Read the index digests with
    `docker buildx imagetools inspect ghcr.io/invariant0x/<image>:<commit>`.
  - Install the current release (plan 2's) as `install.sh server --name rehearsal`, set it up with a random link, and
    connect one plan node to it on localhost. Each update below is a `request.json` written into the volume
    `hornhoof-rehearsal_control` through a short container of the updater image run with `--entrypoint sh`, as in plan
    2, and each ends within 20 minutes.
  - The lease checks, from `~/hornhoof-rehearsal`: `docker compose exec -T db psql -U hornhoof -d hornhoof -tAc "SELECT
    kind, sync, until > now() FROM net_local.lease"` prints `normal|alone|t`; `SELECT count(*) FROM net.journal`
    grows after a change made on localhost; `SELECT pg_total_relation_size('net.journal')` prints a number, which the
    report gives; `docker compose logs keeper` has `This machine leads under term` and no
    `does not lead here` line; `/api/health` says `mode` `lead`; the plan node is online; within 60 s `curl -s
    https://<link>/api/network/lease?nonce=<22 random characters>` names the keeper's machine and the nonce.
  - In this order:
    1. Forward, from the release, to the branch build: it ends `done`, and the lease checks pass.
    2. Fence 4: `docker compose pause keeper` for 20 s, then `unpause`. Within 15 s of the pause a change on localhost
       answers the read-only message, and `/api/health` says `read`; within 10 s of the unpause the keeper's log has
       `The lease ended (a tick came` and a new term, and a change works again.
    3. A failed update to the broken build: it ends `rolled_back`, its log says the database went back to the copy, and
       the lease checks pass on the branch build's commit.
    4. Back, a downgrade to the release: it ends `done`, and a change on localhost works and journals its row.
    5. Forward again to the branch build: it ends `done`, the lease checks pass, and the term is higher than in 1.
  - Then remove the link in Share access, `docker compose down -v` in `~/hornhoof-rehearsal` only, remove that folder,
    and remove its registry line by hand. Any step that fails: stop and report, and Ivan is not asked to update.
- [ ] **Step 5: Merge** (team lead). The Update's title is the subject of the commit the images are built from, so the
  team lead writes the merge commit into main with exactly this subject (97 characters, no double quote):
  ```text
  Fence every commit with the keeper's lease, journal each change, and guard the orchestrator's SQL
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** Ivan presses Update on his own companies himself, one at a time;
  the team lead never runs an install, an update or a `request.json` on them. After each, the team lead runs the lease
  checks, reading only (the `psql` queries, the journal's size among them, `docker compose logs keeper`, `/api/health`,
  the Machines tab), and reports; an hour after the Update, `docker compose logs app | grep -cE 'The 5 s limit ended a
  transaction|A transaction of .* ran [0-9]+ ms'` prints 0, and when it does not, the team lead reports each line's
  route and time. When one fails, or the
  Update does not end within 20 minutes, the team lead tells Ivan which release to go back to, the one before, and how:
  in Versions, that release's Install button, or, when the app does not answer or only reads, `HORNHOOF_VERSION=<that
  release> install.sh server` (with `--name <name>` for a named company) on that machine; and that afterwards the
  orchestrator cannot change rows with SQL until the next Update. Ivan does it; then stop and report.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/fences-and-journal` once main
  has the branch.

## Addendum: plan 2's "drains those changes" (p2:146-148)

Plan 2 says: "A change admitted while leading ends as it would: in this plan the app leaves `lead` only for an update,
which stops it before the copy. Plan 3, which asks for `read` while the app runs on, drains those changes." The audit
asked whether this plan's rulings 8 and 9 cover that. They do not say it: ruling 8 is about the next term, ruling 9
about what the app shows. What covers it is the fence, and no task is needed.

A change admitted in `lead` that is still running when the app turns `read` is not drained, and must not be: spec
3.4's fence 4 ends its session, "Termination, not cancel", and the source retries (3.9). Each way it can end has its
test here:
- its session is ended, also while its commit waits: `notConfirmed`, answered 503 `not_confirmed` (ruling 5; Task 3's
  `answers a refused lease as read_only and a lost commit as not_confirmed`; Task 4's `ends the app's and the agents'
  sessions, and no other` and `ends a commit that waits when the lease ends`);
- it reaches `COMMIT` on a new connection once the lease has ended: fence 1 refuses it, answered 503 `read_only` (Task
  3's `answers read_only to a write when the lease has ended`);
- the lease is whole, and only the keeper's word went stale (ruling 9): its commit passes fence 1 under that lease, is
  journaled and is confirmed. That is a good write; `read` is what the app shows, the lease is what binds.

A handler that commits more than once loses only its later steps, and its source retries them (plan 4's numbered
steps). A wait for running changes to finish would hold a lease open past a machine's right to it, against spec 3.4,
so no plan adds one. Read p2:148 as "fences those changes".
