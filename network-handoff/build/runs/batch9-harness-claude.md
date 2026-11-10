# Batch 9, slice harness: review by Claude

Read: the package, the lane tree `wt/p3lease` (pg.ts, run.sh, auth-locks.test.ts, postgres.test.ts, compose.test.ts,
session.ts moveOlderSession, sign-in-limit.ts, client.ts, compose.yaml), the writer's red and green logs
(`runs/remote-p3t1-bite-*`, `remote-p3t1-real-*`, `remote-p3lease-check-*`). No file changed, no test rerun.

Critical: none.
Important: none.

I checked the points where a test could pass with the code wrong, and they hold:
- Hand-over test 1: both moves take `FOR SHARE` on the person (compatible), then both wait on the held session row, so
  `untilWaiting(2)` is the right condition. The assert covers two distinct tokens, both signed in, and the old row ending
  within a minute. The bite log shows it red with the lock gone ([200, 401]).
- Hand-over test 2: the disable can only be the second waiter because it needs the person's row `FOR UPDATE`, which the
  hand-over's `FOR SHARE` blocks. With the lock gone the disable would not wait, `untilWaiting(2)` would time out, and the
  test is red. Final asserts (0 sessions, new cookie answers 401) name the harm.
- Sign-in test: red with the lock taken out (35 let through instead of 30, bite log). The row count assert pins the
  stored tries, not only the answers.
- run.sh: TCP `pg_isready` handles the image's two-start boot. The port is read from `docker port` with `${published##*:}`,
  fine for IPv4 or IPv6 output. The trap removes both containers. The password is made from /dev/urandom and never echoed.
  Pebble still starts when `HH_REAL_PG` is set, as ruled.
- pg.ts: the database name is 12 random hex, so the interpolated `CREATE DATABASE`/`DROP DATABASE` is safe.
  `DROP DATABASE ... WITH (FORCE)` first, roles after, in the right order.
- No em dashes, no secret, no private name in the package.

## Minor

1. `apps/server/test/real/auth-locks.test.ts:30` (afterAll): if `beforeAll` fails after `realDatabase()` (a migration
   error, say), `app.close()` throws a TypeError on `undefined`, `real.drop()` never runs, the database stays on the
   container and the real cause is hidden. Guard each step (`app?.close()`, `db && poolOf(db).end()`) or call
   `real.drop()` first. Same shape, smaller, in `pg.ts:46`: `drop()` stops at the first failed statement, so a failed
   `DROP DATABASE` leaves the roles too.
2. `auth-locks.test.ts:118` (sign-in test): `untilWaiting(2)` releases the lock when two sessions wait, while the pool
   (default 10) may hold up to ten. The bite log shows it still goes red, but on a slow run fewer tries overlap and the
   test bites less. Waiting for the pool's size (10) would make it deterministic. Not needed for the fix round if the
   writer is short of time.
3. `compose.test.ts:12` types `command` as `string[]`, and the new case calls `command.join`. Compose also allows
   `command` as one string; if Plan 2 Task 7 writes it that way, this case fails with `join is not a function`, not with
   a message about run.sh. Accept both forms (`[command].flat().join(' ')`) so it fails for the right reason.
4. `run.sh` start_postgres: the password goes to `docker run -e POSTGRES_PASSWORD=...`, so it shows in `ps` and
   `docker inspect` of a-host for the run's length. Random and local, but `-e POSTGRES_PASSWORD` with the value taken
   from the environment keeps it off the command line.
5. `pg.ts:54` `poolOf` reads drizzle's `$client` through a cast; if drizzle renames it the tests fail at run time, not at
   type check. One line, logged in the ruling; fine to leave.

## What Task 4's writer will trip over

- `realDatabase().drop()` removes only `agentRole(name)` and `readerRole(name)`. Any role the lease, keeper or fence adds
  (a role for the fence tests, a non-superuser app role) is created at server level and will outlive the database on the
  next run unless `drop()` lists it too. A test that creates its own role should drop it in its own cleanup.
- `admin` and `url` are the `postgres` superuser. The fence is the app's own for superusers (ruling 1) and the agent roles
  are fenced by role, so a test of the role path needs a connection as `agentRole`/`readerRole` with a password set by
  the test; pg.ts offers none. Use `urlOf`-style helpers from a shared place rather than copying (`urlOf` is not exported).
- `realServer()` is read on every call; tests that start the `Db` for the keeper need `application_name` of the app
  (`APP_NAME`) for the `pg_stat_activity` waits, as `appSessionsWaitingOnALock` does. A keeper that opens a second pool
  with another name will not be counted there, which is correct, but a new wait helper should say so.
- `fileParallelism: false` in `vitest.real.config.ts` serialises files, so the database per file is for cleanliness, not
  for isolation. A lease test that takes a server-wide lock or changes a server setting (`ALTER SYSTEM`) would still
  affect the next file.
