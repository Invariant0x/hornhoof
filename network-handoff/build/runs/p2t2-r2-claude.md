# Plan 2 Task 2, review round 2 (Claude fable, read only)

Package: `network-build/runs/p2t2-r2.diff`, lane `wt/p2t2`, against `lanebase`. Scope: the three Important findings of
round 1 and what the fix changed. Nothing accepted or deferred is reopened.

## Verdicts

### 1. A failed migration does not say why: ADDRESSED

`apps/server/src/migrate.ts:197-203` `reasonOf` walks `loggable(err)` and its `cause` chain and joins the first
message with the innermost one on one line with `: `.

How checked: ran the four focused files through `light.sh` in the lane (`db-pool`, `migrate`, `migrate-masking`,
`cli`): 4 files, 10 tests pass. Then a scratch script (outside the repo) called the lane's `runMigrate` against
`127.0.0.1:1`; the one line reads
`Could not bring the database up to this build: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle": connect ECONNREFUSED 127.0.0.1:1`.
The real reason is there.

Fails without the fix: yes. Round 1's real Postgres run and the pre-fix code gave only
`...: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`, which `test/migrate.test.ts:316`
(`toContain('ECONNREFUSED')`) rejects.

### 2. The test cannot see a password or an empty reason: ADDRESSED

- `test/migrate.test.ts:310-317`: the real connect asserts the prefix, one line, `ECONNREFUSED` present, password absent.
- `test/migrate-masking.test.ts`: mocks `migrateDb` to throw `Error('Failed query', { cause: Error('could not connect
  to postgres://user:<password>@db...') })`; asserts the line holds `postgres://hornhoof:***@db` and not the password.
- The plan's two-argument call `runMigrate(env, print)` is unchanged (`migrate.ts:207`).

Masking on every path, checked with the scratch script against `loggable` walked the way `reasonOf` walks it, a
probe password that is not in any file, and printing a line only after confirming it did not hold the password:
- Error whose cause is a string holding an address: masked.
- Address in an Error cause at depth 3: masked, reason kept.
- Address in a cause at depth 4: `loggable` keeps three causes (`errors.ts:116`), so that cause is dropped; nothing
  leaks, the reason is just shorter. pg and drizzle errors are one or two levels deep, so this does not bite.
- Address in the top-level message, and a thrown non-Error string: masked.
- `Error('')`: reason is empty, the line ends after the colon. Not a leak and not a realistic driver error.

Fails without the fix: yes, both ways. With the pre-fix `loggable(err).message` alone the masking test's line is
`...: Failed query` and `toContain('could not connect to postgres://hornhoof:***@db')` fails; with the raw
`err.cause.message` instead of `loggable`, `not.toContain` of the password fails.

### 3. `openDb` is not run by any test: ADDRESSED

`test/db-pool.test.ts:256-261`: `openDb(url, 'hornhoof-keeper', { statementTimeoutMs: 2000 })`, reads the pool from
drizzle's `$client`, asserts `application_name` and `statement_timeout: 2000`, ends the pool. Passes in the run above.

Fails without the fix: there was no code fix; the writer says so in the report (it passed at once, it pins the
behavior). It would fail if `openDb` dropped `opts` or the name, since `toMatchObject` needs `statement_timeout: 2000`.
That is what the lead asked for: one test, nothing more on the constants.

## New Critical or Important in what the fix changed

None.

## Minor, in what the fix changed

- `migrate.ts:202`: a reason deeper than three causes is cut off by `loggable`'s `CAUSES_KEPT`, so a very deep chain
  prints only the top message. Safe (nothing leaks) and not reached by pg or drizzle errors. No change asked.
- `reasonOf` is 50 percent covered per the writer's crapper (CRAP 6.0, under 10). The two-cause branch is covered by
  the masking test; the one-message branch only by a top-level error, which no test throws. No harm named, so not a
  finding under Ivan's rule.

## Rules

No em or en dash in the changed files. Nothing staged or committed in the lane (`git status`: modified and untracked
only). No password was printed in this review; the scratch script used a probe value and printed a line only after a
boolean check.
