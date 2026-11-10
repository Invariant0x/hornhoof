# Why are Hornhoof's tests slow? Measure, propose, change nothing in the repositories

Ivan asks why a whole suite takes about 26 minutes. Lead's data from one run on home-api, with 3 CPUs and load from others: 251 test files, 3937 s of worker time. Top: migrations.test.ts 33 tests 208 s, tasks-wake 91 tests 139 s (1.5 s per test), decisions 58 tests 110 s, conversation 52 tests 106 s. Log: network-build/runs/p1t11-landing.log. Each test seems to open its own PGlite database from a dump, then a full app (apps/server/test/helpers.ts, global-setup.ts).

Your lane: /home/altera/hornhoof-network/wt/speed, for experiments only: it is thrown away. Never touch the real repositories. CLAUDE.md binds you.

Find out, by measuring, not by guessing:
1. For a typical slow test file, what share of a test's time goes to opening the database, building the app, the test's own requests and SQL, closing. Instrument in your lane.
2. Which of those is avoidable, with evidence: run one file with the idea applied in your lane and give before and after. Ideas to try: one database per file with a rollback or truncate between tests; reusing one built app; a cheaper reset; which tests truly need a fresh database; vitest pool settings (forks or threads, isolate); PGlite settings such as fsync off, relaxed durability or an in-memory store; a shared PGlite cost at startup.
3. What it would take across the suite, and what could break: a test that depends on sequences, ids or time. Say the risk of each idea.
4. What share of tests are logic that could run as a pure function with no database at all? A rough count by sampling is fine; say how you counted.

Run things through /home/altera/hornhoof-network/network-build/light.sh locally, one file at a time, or remote.sh with REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/speed, and wait with remote-wait.sh in the foreground: compare like with like, the same machine, several repeats. Do not run the whole suite more than twice. Report what you observed and what you did not check.

Write /home/altera/hornhoof-network/network-build/runs/test-speed-report.md, at most 80 lines, ranked by minutes saved per risk taken, with the one change you recommend first. Reply with at most six lines. English in files, no em dashes. No subagents.
