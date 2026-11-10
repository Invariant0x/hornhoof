# Why Hornhoof server tests are slow: measured

Lane: wt/speed (apps/server only). Machine: a-host, 16 CPUs, load 6, vitest --maxWorkers=2, nice 10. Real repos untouched.
The experiment patch is network-build/runs/test-speed-experiment.diff (helpers.ts timers and switches, migrations.test.ts).
Not measured on home-api (3 CPUs): absolute times there are about 2.4x longer (tasks-wake 57 s here, 139 s there).

## 1. Where a test's time goes (instrumented helpers.ts)
Whole server suite, baseline run, 1850 tests, 992 s of test time, 540 s wall:
- open a PGlite from the dump: 1374 opens, mean 325 ms, 45% of all test time
- first-run setup request (setUpCompany): 64 ms per test, 8%
- buildApp: 56 ms per test, 8%
- closing app and db: about 3 ms per test, 0.3%
- the test's own requests and SQL, plus the 32 fresh `new PGlite()` of migrations.test.ts: about 39%
tasks-wake alone (91 tests, mean 550 ms): open 57%, setup 12%, buildApp 8%, own work about 23%.
The 325 ms open is not initdb (that is paid once). Microbenchmark: loading the 40 MB dump (22 MB data, 16 MB WAL
segment) and starting Postgres costs about 270 to 330 ms whatever the flags.

## 2. What is avoidable (before and after, same machine, alternating runs)
| Idea | Result |
|---|---|
| A. One PGlite per file, `truncate ... restart identity cascade` of the 29 public tables before each test (25 ms) | tasks-wake 45, 53, 42 s -> 19.8, 20.4, 19.6 s. Whole suite 540 s -> 323 s wall (-40%), 1842 of 1850 pass |
| B. Fresh unmigrated DB from a dump of one initdb, in migrations.test.ts (`new PGlite()` costs 1.4 s) | migrations.test.ts 73, 63, 56 s -> 35, 29, 30 s |
| C. Precompiled wasm module (`pgliteWasmModule`) | no gain: tasks-wake 49, 57, 44 s against 45, 53, 42 s. Drop it |
| D. `relaxedDurability` | microbenchmark only: 325 -> 282 ms, within noise; the store is memory. Not worth it |
| E. `--pool=threads` | no gain: 6 files 103 and 79 s against 99 and 75 s |
| F. `--no-isolate` | 81 s once, 94 s the other time (noisy), and 1 test failed both times. Rejected |
| G. `clone()` of PGlite as the reset | 496 ms, slower than a reopen. Rejected |
Not tried: reusing one built app (see risks), snapshotting the state after setUpCompany.

## 3. Across the suite, and what breaks
- A needs a switch in helpers.ts only (openTestDb, createTestDb, testApp). 8 failures in the full run, two causes:
  1. DDL leaks past truncate. map-state.test.ts creates the trigger hh_stop in 7 tests and the next test inherits it
     ("The server stopped here"). Files that run DDL: map-state, orchestrator-control, tasks-history, migrations.
     Fix: those files keep a database of their own (a regex list in the experiment, better an explicit helper option).
  2. db.test.ts "closes it once that test ends" tests the close itself; it keeps its own database too.
  After the opt-out, those 5 files pass together (129 of 129).
- Sequences and ids restart with `restart identity`; time-based tests (6 files use fake timers) passed. Roles and grants
  made by agentSqlOn persist in the shared database; harmless so far because `granted` re-runs idempotently, but a
  test that revokes or alters a role would leak. Unawaited background work of an app from test N could write into
  test N+1's data (the app closes first, so low risk; not seen).
- Risk: medium for A (hidden order coupling shows up as a flaky failure; the guard is a lint rule against DDL in tests
  that use the shared database). B: low, same schema state as a fresh initdb, 4 of 4 runs passed.
- The leftover cost after A is setUpCompany plus buildApp, about 24% of the 568 s that remain. Reusing the built app
  across tests is riskier (in-memory caches, hubs, timers) and not tried.

## 4. Share of tests that need no database
34 of 118 test files never mention testApp, createTestDb, appOn or PGlite: 435 of 1588 `it(` lines, 27%. Counted by grep
of the `it(`/`test(` lines, so `it.each` expansions are undercounted (the run has 1850 tests). Those files are already
cheap, so they are not a saving. Inside the 84 DB files I did not count how many tests could be pure functions; most go
through app.inject, so that would be a refactor, not a switch.

## Ranking (minutes saved per risk)
1. A, one database per file with truncate, DDL files opt out: about 3.5 minutes of 9 on this machine (about 40%; on
   home-api, from 26 minutes to about 15 if it scales). Medium risk, small diff. RECOMMENDED FIRST.
2. B, cheap fresh database in migrations.test.ts: about 30 s of wall on its own, and it is the longest file, so it
   bounds the suite wall time with 2 workers. Low risk.
3. Snapshot after setUpCompany or reuse of the app: up to about another 20% of what remains. Not measured. High risk.
4. C, D, E, F, G: no gain, do not do.

## What I did not check
- Combined A plus B plus opt-outs as one full run (the two full runs allowed are used); the combined number is an
  estimate of about 320 s. The 5 DDL files were run together and passed.
- The run on home-api, the apps/node and packages suites, typecheck:tests and release checks (the 26 minutes may include them).
- Stability of A over many repeats: tasks-wake 3 times, the rest once.
