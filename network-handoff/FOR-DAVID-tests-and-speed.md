# For David AI: tests and speed, what the lead of the network build thinks

Ivan asked me to write this to you directly, for your own task on optimization and speed. It is my view after one day of leading this build, with the numbers I measured. Decisions already taken by Ivan are marked; the rest is advice. Measured on home-api unless said, with others' load on it.

## What I measured

| What | Number |
|---|---|
| Hornhoof's whole suite | about 3900 tests, 251 files, about 65 minutes of worker time, 26 minutes real time on 3 CPUs; with queue, tsc, lint and gates 48 minutes for Plan 1 Task 11, a change to one test helper |
| A typical Hornhoof test | 1.5 to 2 s each: tasks-wake 91 tests 139 s, decisions 58 tests 110 s, migrations 33 tests 208 s. It seems each test opens a PGlite database from a dump and builds the app. test-speed is measuring where the time goes: `network-build/runs/test-speed-report.md` when it is done |
| The relay's suite | 169 tests, about 8.5 minutes, about 3 s each: real frps, frpc and relay processes, on purpose |
| Mutator, per task | about 9 weak tests and no product bug across seven tasks, at about 1 to 2 minutes per relay mutant. It missed gaps a reviewer found on a task where it reported 22 of 22 killed: it changes operators, and does not remove whole conditions |
| Two independent reviewers | 1 Critical and about 30 Important accepted across seven tasks, and most real product bugs: the relay's unread-body hole, a sign-out a minute after an Update, a socket leak in `front`, a next owner inheriting a sync record. Antigravity on Argon and Claude each caught what the other missed |

## test-speed's measurement

`network-build/runs/test-speed-report.md`, experiment patch `network-build/runs/test-speed-experiment.diff`, on a-host. Over the server suite's 1850 tests, 45% of a test's time goes to opening PGlite from the dump (325 ms), 8% each to setUpCompany and buildApp; closing costs nothing. One PGlite per file with a truncate between tests (25 ms): tasks-wake 45-53 s to 20 s, the whole server suite 540 s to 323 s, 40% less. 8 of 1850 tests fail that way: DDL triggers in map-state that truncate does not undo, and db.test.ts checks closing; those files keep their own database. An empty database from the dump in place of `new PGlite()` in migrations.test.ts: that file 56-73 s to 29-35 s. No gain from precompiled wasm, `--pool=threads`, relaxedDurability, `clone()`; `--no-isolate` is noisy and breaks one test. 27% of tests touch no database, by a count of `it(`. Not checked: both changes together in one whole run (about 320 s by estimate), on home-api, or the node and protocol suites.

## What was slow, in order

1. Review rounds, which are also what found the bugs.
2. Running the whole suite for every task, by the writer after each round and by the lead again.
3. Waiting: background notices do not reliably reach a subagent, and writers that ended their turn to wait sat idle for two hours until I checked live processes. Keep a subagent in a foreground wait, or check runs against processes.
4. A machine oversubscribed by my own slot setting.

## What I recommend for Hornhoof

**Ivan's rulings of 2026-11-04 in this build, worth taking as the project's rule:**
- A task checks only the tests its change reaches (`vitest related`), types and lint. The whole suite runs at a plan's end or before a merge, and at once for migrations, scripts and the install and update path. Script: `network-build/hh-related.sh`.
- Approved work lands in batches, with one check for the batch.
- Two reviewers on risky work, one on simple work; the plan's end still gets both.
- Mutator only on the riskiest pure logic with its fast tests, once at the end of a phase. Never per task, never against tests with real processes or databases: it reruns the tests per mutant, so its cost is the tests' cost.
- New tests: Uncle Bob's way without chasing coverage: logic in a pure function tested directly, one or two integration tests per route or seam, no test only to cover a line. To meet CRAP 10, split first. Reviewers report a missing test only with a named harm to a person.
- Old tests are not rewritten.

**My advice, not yet decided by anyone:**
- The root of the suite's cost is that almost every test is an integration test through real SQL and HTTP. They do catch real bugs, so keep them, but stop growing them by the hundred: the network plans would add many. New logic in pure functions is what stops the growth.
- If test-speed confirms that opening a database per test takes most of the time, one database per file, with a reset between tests, may cut the whole suite a lot. Do it once, in `test/helpers.ts`, as its own task, after phase 1, because tests depending on sequences or ids may break. I do not ask for it now.
- `npm test -- --testTimeout=90000` from the root does not reach vitest: the flag stops at the root script, so the default 20 s applies and slow tests fail on a busy machine. Use `npm test --workspaces --if-present -- --testTimeout=90000`.
- CLAUDE.md and BRIEF.md still say mutator on every task and two reviewers on every task. Please update them, as every new agent reads them first.
- A task's gate should name its CRAP only for functions it changes, with coverage from that function's own tests: a narrow list makes a good function score badly.

## What the speed gains cost

A break no import reaches is found at a plan's end, within one plan's changes. A bug only the second reviewer would catch waits for the plan's review. Weak tests outside the mutator's reach stay unmeasured. I think these are good trades, and Ivan has taken them; you may see it differently for the main line.
