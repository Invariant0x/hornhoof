# Plan 2 Task 2 report: migrations leave the app's start

Status: DONE

## Read first
Skills: test-driven-development, systematic-debugging, verification-before-completion (plugins/superpowers/skills). Rules: CLAUDE.md,
hornhoof/AGENTS.md (lane copy), templates/skills/dev-engineering-rules.md, briefs/p2t2-writer.md, parallel-map.md rows for 2 T2.
systematic-debugging: no failure other than the expected red runs occurred.

## Files changed (lane /home/altera/hornhoof-network/wt/p2t2)
- apps/server/src/migrate.ts (new): runMigrate and entry point.
- apps/server/src/db/client.ts: createDb removed; APP_NAME, MIGRATE_NAME, KEEPER_NAME, openPool(url, onDropped, name, opts), openDb, migrateDb.
- apps/server/src/main.ts, apps/server/src/cli.ts: openDb(url, APP_NAME), no migration.
- apps/server/package.json: dev and start run the migrate entry first (two lines only).
- apps/server/test/db-pool.test.ts (new test, old call to the new signature), apps/server/test/migrate.test.ts (new).

## Red before code
- migrate.test.ts: failed to load, src/migrate.ts did not exist.
- db-pool.test.ts "names each pool to Postgres": options had no application_name or statement_timeout (received only connectionString, max, etc.).

## Runs
- light.sh vitest db-pool, migrate, cli: 3 files, 8 tests pass.
- npx tsc -p apps/server/tsconfig.json --noEmit: nothing printed.
- remote npm run typecheck:tests and npm run lint (label p2t2-chk2): no errors in the log.
- gates-hornhoof.sh lanebase server (label p2t2-gates): dryer, no duplicate candidates. Crapper: all functions I wrote or changed are under 10
  (runMigrate 3, openPool 2, openDb 2, migrateDb 1.1, warnDropped 1). Listed but not mine and unchanged by me: takeLink CRAP 182 (CC 13),
  applyMissingMigrations 20 (moved nothing, same body), read 6, requireDbUrl 6 (main.ts, untouched body).

## Not done / deviations
- migrateDb is not run against a real Postgres (no test database, no Docker); the plan leaves that to Task 7/11. Its pieces are covered only
  by the failing-connection path of runMigrate.
- Ruling 3 of the map applied: migrateDb runs applyMissingMigrations after drizzle's migrate, and counts after both.
- shellcheck and bash -n not run: no shell file changed.
- Mutator not run (Ivan's rule). Nothing staged or committed.

## Proof run on real Postgres (remote.sh run --dind, label p2t2-pg2)
Image postgres:17.11 with the digest compose.yaml names, port published on 127.0.0.1 only; the container was removed at the end. The
migrate entry point was run with `npx tsx src/migrate.ts`, as `dev` runs it. 52 migration files in the lane.
- Run 1: "The database is up to this build: 52 migrations.", exit 0.
- Run 2 on the same database: the same line, count still 52, exit 0.
- `node_codes.dismissed_subscription_ids` (column from the newest migration, 0052) exists; `drizzle.__drizzle_migrations` holds 52 rows.
- Wrong password: exit 1, line "Could not bring the database up to this build: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"".
  Concern: `loggable(err).message` for a drizzle error says the failed query, not the cause (the real reason is in `cause`), so the
  line is safe but not very helpful. The plan names `loggable(err).message` verbatim, so I kept it; a follow-up could add the cause's message.
- Not run: `node dist/migrate.js` (needs a build), and no repo test was added (a real-Postgres test needs plan 3's harness).

## Fix report, review round 1
Red first (light.sh): migrate.test.ts lacked ECONNREFUSED in the line; new migrate-masking.test.ts got only "Failed query".
- 1 and 2: `reasonOf` in src/migrate.ts joins loggable's message with the innermost cause's message (both masked by loggable). The real-connect
  test now asserts ECONNREFUSED. New test/migrate-masking.test.ts mocks migrateDb to fail with a cause holding `postgres://user:<password>@db`;
  the line holds `postgres://hornhoof:***@db` and not the password. The two-argument call is unchanged.
- 3: db-pool.test.ts "hands the name and the statement timeout of openDb to its pool" (reads the pool from drizzle's `$client`, ends it). It
  passed at once, since openDb already did this; it pins the behavior.
- After: 10 tests pass in db-pool, migrate, migrate-masking, cli; tsc silent; typecheck:tests and lint no errors (p2t2-c3); gates (p2t2-g2):
  dryer no duplicates; crapper reasonOf 6.0 (CC 4, 50% covered), runMigrate 3, openDb 1, openPool 2, migrateDb 1.1, all under 10.
- Ledger note kept for Task 7: Dockerfile CMD must run migrate.js, not only ship it.

## Fix report, round 2
Red first: new migrate.test.ts test against localhost:1 printed only "Failed query: ..." (empty AggregateError message). `reasonOf` now uses
`step.message || step.code`. After: 11 tests pass in db-pool, migrate, migrate-masking, cli; tsc silent; eslint on the two changed files silent.
