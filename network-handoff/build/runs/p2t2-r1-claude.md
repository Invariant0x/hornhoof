# Review of Plan 2 Task 2, round 1 (Claude, read only)

Lane `/home/altera/hornhoof-network/wt/p2t2`, package `runs/p2t2-r1.diff` against `lanebase`. Lines below are the lane's files.

## What I ran

- `light.sh npx vitest run test/db-pool.test.ts test/migrate.test.ts test/cli.test.ts` from `apps/server`: 3 files, 8 tests pass.
- `npx tsc -p apps/server/tsconfig.json --noEmit` from the lane root: prints nothing, exit 0.
- A one-off `tsx -e` in the lane calling `runMigrate` and `migrateDb` against `127.0.0.1:1` with a dummy password, to see the
  line a person gets and what `loggable` keeps in `cause`. No file in the repositories was changed; `git status` shows only the
  writer's seven files.
- Grep over the lane for anything that still starts the app without the new entry point: `Dockerfile`, `compose.yaml`,
  `scripts/install.sh`, `apps/updater/updater.sh`, `guide/install.md`, root `package.json`, `.github/workflows`.
- Checked against the Interfaces line by line, the parallel-map rows for 2 T2 (sections 1, 3, 4) and ruling 3, and `pg`'s own
  code for `application_name` and `statement_timeout` (`node_modules/pg/lib/client.js:551-559`, both go in the startup packet).

## Findings

### Critical

None.

### Important

1. **`apps/server/src/migrate.ts:19`: a failed migration tells the person the query, not the cause.** For a wrong password, a
   database that is down, or a host that does not resolve, the one line is
   `Could not bring the database up to this build: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`. Reproduced: with
   `127.0.0.1:1` the line is exactly that, while `loggable(err).cause.message` is `connect ECONNREFUSED 127.0.0.1:1`
   (`errors.ts:122` turns a `DrizzleQueryError` into `Failed query: <sql>`; the driver's reason sits in `cause`, which
   `loggable` already keeps at `errors.ts:129`, password masked by `hidden` at `:115`). What a person gets: after Task 7 this is
   the only thing the `migrate` container says before the updater's 15 minute limit rolls the install back; a wrong
   `POSTGRES_PASSWORD` in `.env` and a dead `db` look the same, and the first query named is misleading, since no schema
   problem exists. The plan's Interfaces name `loggable(err).message` verbatim, so the writer kept it (report says so); this is
   the plan's wording to rule on, not the writer's slip. What would make it right: append the innermost cause,
   `...: Failed query: CREATE SCHEMA ...: connect ECONNREFUSED 127.0.0.1:1`, through `hidden`, and let the test
   `fails plainly when the database does not answer` assert the line contains `ECONNREFUSED` (then the `not.toContain('s3cret')`
   check carries weight; today the line holds no address at all, so that assertion passes for the wrong reason). Ruling for
   the ledger either way.

2. **Nothing that installs or runs Hornhoof at this commit runs `migrate.js`; the app starts on an unmigrated database.**
   `Dockerfile:53` is still `CMD ["node", "apps/server/dist/main.js"]`; `compose.yaml` `app` has no `command` and no
   `migrate` service; `guide/install.md:58` runs `docker compose up -d --build`; `updater.sh` runs the build's installer, which
   runs that compose file. The `start` script change (`package.json:8`) is reached by nobody in production. So at landing 9 of
   the order (`parallel-map.md` section 2), a fresh install from source gets an app that crashes on `setupLink`'s first query
   against an empty database and restarts in a loop (`restart: unless-stopped`), and an Update to this commit gets an app
   running on the old schema, which `applied()` in the updater counts as unchanged and `healthy` may even pass. This is the
   plan's own sequencing (Task 7 adds the `migrate` service; the Files of Task 2 do not include `Dockerfile` or `compose.yaml`;
   seam "2 T2 and T7" names it), and build ruling 2 means no person is hit now. Reported because the lead asked for it: the
   ledger should say that the branch is not installable between 2 T2 and 2 T7, and Task 7's review must check the `Dockerfile`
   CMD as well as compose, since the writer's seam line names only `dist/migrate.js` existing in the image.

### Minor

3. `apps/server/src/db/client.ts:40-49`: the promise "ends its pool in every case" is not tested. Nothing observes `pool.end()`;
   the failure test would pass with the `finally` removed (the pool has no live socket, so vitest does not hang either). An
   honest test is hard without a database, so I do not ask for a bad one; noting it for plan 3's real Postgres harness
   (`3 T1` consumes `migrateDb`).

4. `apps/server/test/migrate.test.ts:17`: the test opens a real TCP connection to `127.0.0.1:1` with no connect timeout in the
   pool. On Linux and macOS port 1 refuses at once, so it is fast; on a host that drops rather than refuses it would hang.
   Acceptable for now, same address as the existing `db-pool` test.

5. `apps/server/src/db/client.ts:21`: `openPool`'s `name` is a free string; `APP_NAME`, `MIGRATE_NAME`, `KEEPER_NAME` are the
   three legal values, and the test writes the literals instead of the constants. A union type `PoolName` would make the
   illegal value impossible to write (ub-mode "Type System Discipline"). Not in the Interfaces, so a note, not a gap.

6. `apps/server/src/db/client.ts:47`: `pool.query('SELECT count(*) FROM drizzle.__drizzle_migrations')` runs on a pool that
   `migrate` has already used, fine; `rows[0]!` is a non-null assertion on a query that always answers one row. Fine, just
   noting the `!`.

## Checked and found right

- Interfaces: `APP_NAME`, `MIGRATE_NAME`, `KEEPER_NAME`, `openPool(url, onDropped, name, opts?)`, `openDb(url, name, opts?)`,
  `migrateDb(url): Promise<number>` match the brief; `createDb` is gone and no caller remains (`grep` over `src` and `test`).
  `main.ts:15` and `cli.ts:93` open `openDb(url, APP_NAME)` and migrate nothing. `openAgentSql` untouched.
- Ruling 3 of the map applied: `migrateDb` runs drizzle's `migrate` then `applyMissingMigrations`, counts after both, pool named
  `MIGRATE_NAME` with no `statement_timeout` (`opts` omitted).
- `statement_timeout` only when given: `...(opts.statementTimeoutMs === undefined ? {} : {...})`, and the test checks
  `not.toHaveProperty('statement_timeout')` on the app pool. `pg` sends both options in the startup packet, so the test on
  `pool.options` stands for what Postgres receives.
- Entry point detection copies `cli.ts` (`realpathSync(process.argv[1])` against `import.meta.url`); `process.exit` with the
  code; `dev` and `start` scripts as the brief writes them.
- No secret printed: the test URL's password `s3cret` does not reach the line (confirmed by the run); `hidden` masks
  `user:pass@` in anything `loggable` returns.
- No em dash in the diff. Comments say why. Functions small; writer's CRAP figures plausible from reading (`runMigrate` has
  two branches, the rest one path).
- TDD: the report's red reasons (module missing for `migrate.test.ts`; `options` without `application_name` for
  `db-pool.test.ts`) are the reasons the plan's Step 2 expects. Not re-run red by me (read only).
- `git status`: nothing staged or committed, the lead's rule.

## Counts

Critical 0, Important 2, Minor 4.
