# Plan 2 Task 2, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p2t2-r1-claude.md: 0 Critical, 2 Important, 4 Minor), Antigravity Argon high (runs/p2t2-r1-agy.md: 0 Critical, 3 Important). Judged under Ivan's rule on tests: a missing test counts only with a named harm.

## Important: one fix round, each from a test that fails first

1. **A failed migration does not say why.** (both, reproduced; also the real Postgres run) A wrong password, a dead database or a full disk all read `Failed query: CREATE SCHEMA...`. Ruling on the plan's wording: the line gives the real reason too: `loggable(err).message` plus the innermost cause from `loggable(err).cause`, which errors.ts already masks, on one line.
2. **The test cannot see a password in the line, or an empty reason.** (Antigravity 2, Claude) The harm is a database password in the install's logs. Assert the reason is there (ECONNREFUSED), and exercise masking on a failure whose raw text holds a `postgres://user:password@` address: the password is gone from the line. Keep the plan's two-argument call working.
3. **`openDb` is not run by any test.** (Antigravity 3) The harm: the keeper's 2 s statement timeout dropped, so a stalled database hangs the keeper. One test: `openDb` hands the name and timeout to its pool, and ends it. Nothing more on the name constants.

## For the ledger

Nothing that installs or runs Hornhoof at this commit runs migrate.js: Dockerfile's CMD is still dist/main.js, compose has no migrate service. The branch is not installable between 2 T2 and 2 T7, by the plan's order; no one is hit, since nothing ships. Task 7's review must check the Dockerfile's CMD, not only that dist/migrate.js exists in the image.

## Deferred minors

pool.end() in every case untested, for plan 3's harness; the test's real connect to 127.0.0.1:1 has no connect timeout; pool name is a free string; a non-null assertion on rows[0]; `node dist/migrate.js` not run, only through tsx, Task 7's image covers it.
