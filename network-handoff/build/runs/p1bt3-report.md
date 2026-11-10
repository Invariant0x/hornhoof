# Plan 1b Task 3 report (writer)

Status: DONE_WITH_CONCERNS (one dryer pair, old code, see Gates).

## Read first
Skills: test-driven-development, systematic-debugging (no failure needed it beyond type errors fixed from the compiler message), verification-before-completion. Rules: CLAUDE.md, hornhoof/AGENTS.md, hornhoof/templates/skills/dev-engineering-rules.md, the brief, parallel-map rows.

## Files (lane /home/altera/hornhoof-network/wt/p1bt3, nothing staged)
- New: apps/server/src/auth/sign-in-limit.ts, apps/server/test/sign-in-limit.test.ts, drizzle/0054_sign_in_attempts.sql, drizzle/meta/0054_snapshot.json
- Changed: src/db/schema.ts (signInAttempts), src/db/agent-sql.ts (HIDDEN), src/modules/auth/routes.ts, src/auth/limit.ts (new `refuse`, used by `guard` and by login, so the 429 message is in one place), drizzle/meta/_journal.json (generated), test/migration-history.test.ts (53 to 54), test/migration-metadata.test.ts (snapshot 0054), test/orchestrator-control.test.ts (both lists gain SELECT * FROM sign_in_attempts).

## Red first
sign-in-limit.test.ts run before any code: whole file failed, the module `../src/auth/sign-in-limit.js` did not exist (the plan's reason). Extra check: with the `pg_advisory_xact_lock` statement deleted from the code, the 100-at-once test failed and the other 11 passed; code restored.

## Runs
- Done when files plus migration-history and migration-metadata (light.sh, vitest): 7 files, 136 tests passed (run twice, last after the final edit).
- remote: `tsc -p apps/server/tsconfig.json --noEmit` exit 0 and silent; `npm run typecheck:tests` exit 0; eslint on apps/server/src and the new test exit 0 (p1bt3-checks4).
- Not run by me: whole suite, mutator.

## Gates (gates-hornhoof.sh lanebase, p1bt3-gates2)
- crapper: highest changed function is POST /api/auth/login 9.0; the new module's functions are 1.0 to 3.0. All under 10.
- dryer 0.8: one pair, score 1.00, apps/server/src/db/agent-sql.ts:78-99 (grantsFor) and :103-111 (readerGrantsFor). Both are old code; I changed only the HIDDEN line (15). I left it, outside this task.

## Deviations and rulings
- Ruling: `Db` is generic over the driver, so `execute` returns `unknown`; a one-line `rowsIn` in sign-in-limit.ts reads `.rows` (both drivers answer it). Test has the same small helper. Cost if wrong: none for a driver that answers `{ rows }`.
- Ruling: the three limits' scopes and windows live once (`scopeOf`, `inWindow`, `SIGN_IN_LIMITS`) and build both the insert and the read of full limits, instead of the plan's literal SQL text; the generated SQL is the same shape. The interval is `<seconds>::int * interval '1 second'`, not the literal `interval '15 minutes'`. Cost if wrong: none seen; the test of 10 and 30 limits passes.
- Ruling: `longestWait` is the pure function the plan asked for in spirit; it returns 1 second and the 15 minute window when no limit is full any more (a race where tries expired between insert and read). Tested.
- Ruling: the plan's statement-order check is written as: the statement right before each insert is the lock with `[SIGN_IN_LOCK]`. PGlite runs a transaction whole, so they are adjacent. 
- The old in-memory login limiters are removed from the login route; `limiter` and `guard` stay for invites. No test of limit.test.ts changed.
- No facts of the plan proved wrong. Newest-migration tests that needed the bump were migration-history and migration-metadata (not migrations.test.ts); I added no migration test for the new table, as it adds no data change.
