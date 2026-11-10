# Batch 3, relay writes: what the lead accepted from its one review

Readers: Claude fable (runs/batch3-writes-claude.md: 0 Critical, 0 Important, 6 Minor), Antigravity Argon high (runs/batch3-writes-agy.md: 2 Critical, 2 Important, each reproduced, and read it for how). Judged by what a person gets. One fix round, each from a test that fails first.

## Critical

1. **A refused registration still lands, and breaks takeover.** Not only on a stalled disk: with little budget left behind one queued write, `plugin('NewProxy')` refuses while its claimed statement commits. Route reads held by a client that was refused, for 10 s, refusing that client's retries; then `routes.generation` no longer matches `sync.generation`, so a standby's takeover check 5 stops and asks the CEO in place of taking over. This overturns the writer's ruling 3. Make it right: a ticket carries its deadline; `claim_statements` refuses an expired ticket before running its SQL; once claimed into a commit, a plugin write waits for that commit's outcome, like API writes. A refused NewProxy never lands or moves a generation; test that. Say what a stalled disk then costs a plugin call's budget.
2. **A failed ROLLBACK leaves a zombie transaction.** `roll_back` swallows the error and keeps the connection in `_local`, and `write()` reads `conn.in_transaction` as "inside `with transaction()`", so a later write on that kept-alive thread runs inside it, answers 200 with nothing on disk (R2.4), holds the write lock, and every other write answers busy until a restart. Track `with transaction()` by an explicit thread-local flag; a connection still in a transaction after ROLLBACK is closed and dropped; `commit_batch` catches BaseException, so that no ticket goes back uncommitted with no error.

## Important

3. **One client's bad value rolls back other companies' writes.** A lone surrogate from JSON (`"\ud800"`) in a `run_id` or a sync `copy`, or an int too large, raises outside `sqlite3.Error` in `WriteTicket.run`, and rolls back the whole batch. Catch per statement so that a value fails alone. `sync_text` refuses a lone surrogate, so that POST /sync answers 400 `invalid` in place of dropping the connection. Test with a lone surrogate beside a good write.
4. **Read-only admin commands now take the write lock.** `init_db`'s no-op DDL through `write()` makes `admin list` and `banned-caddy` take the cross-process lock 7 times each; under a long commit `hornhoof-relay ban` can mark a name banned and then fail before it rewrites blocked.caddy, leaving a banned host live at Caddy. `init_db` reads `sqlite_master` first and runs its DDL, through `write()`, only when something is missing. This overturns ruling 5. `admin()` turns a WriteBusy into a plain line, not a traceback.

## A test failure to explain

`test_wire_legacy_login_matching_peer_run_id_refused` errored on 3.14 at setUp: frps's /healthz did not answer in 15 s (`runs/batch3a.log`, `harness.py:356`); 3.12 passed, and it has not been seen before. Read the end of that error, and find the cause. A flaky test is fixed at its cause, never retried, and not by a longer wait unless you can show the wait is what is wrong. If the log cannot tell you, add what will tell the next time, and say so.

## Minor: while you are there

`transaction()`: `try:` right after `wait_for_turn`, so that `writer.taken` is always released. `write()`'s docstring: rowcount is -1 for DDL. From Claude: the refused-on-time test asserts its timing, if that is cheap.
