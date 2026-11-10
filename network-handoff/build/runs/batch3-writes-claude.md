# Review: batch 3, slice writes (relay/relay.py one writer with group commit), commit 6f9da7d on batch-3

Reader: Claude (second reader works independently). Read only; nothing changed in either repository.

How checked: the package diff line by line against relay.py on batch-3 (WriterQueue at relay/relay.py:423-608,
transaction() at 1069-1087, callers at 683-695, 1095-1180, 1236-1253, 1575-1622); the ledger's five "Relay writes"
rulings; one focused run `light.sh nice -n 10 python3 -m unittest relay/test/test_writes.py -v`: 12 tests, OK, 1.76 s.
The writer's own check log (runs/remote-relay-writes-check-20261104-225459-1071032.log) shows 108 tests OK including
test_restart_burst.

## Critical

None.

## Important

None.

What the brief said to look hardest at, and why each holds:

- A write answered before its commit (R2.4): an owner reads `ticket.outcome()` only after `wait_for_turn` returns, and
  `wait_for_turn` returns False only on `ticket.done`, which `hand_back` sets after `commit_batch` ran COMMIT or
  rolled back (relay.py:470-486, 517-524, 572-582, 594-608). The holder returns its own outcome after the same
  `hand_back`. test_a_burst_of_logins reads `last_seen` from another connection after each answer, so under WAL a
  premature answer would read None and fail the test. synchronous=FULL is unchanged (db() at 94-102) and pinned by
  test_a_commit_waits_for_the_disk.
- A statement on another thread's connection: `commit_batch` runs the batch's statements on the holder's own
  thread-local connection, on the holder's thread; sqlite3's check_same_thread is never crossed. Only sql and args
  travel between threads.
- A guarded write's rows-changed: `store_sync` and `store_visitor_key` now read `write()`'s rowcount, which Python's
  sqlite3 fills from sqlite3_changes() for INSERT/UPDATE/DELETE including INSERT ... SELECT ... ON CONFLICT DO UPDATE
  WHERE (0 when the SELECT yields nothing or the DO UPDATE WHERE is false). `release_binding` and `store_link_key`
  keep SELECT changes() inside `transaction()`, where every `write()` takes the `conn.in_transaction` shortcut on the
  same connection (relay.py:604-605), so changes() is still that connection's. grep finds no other SELECT changes().
  Both shared-commit tests ([True, True, True, False]) confirm the per-statement count.
- A holder that dies: `write_the_queue` hands back in `finally` (579-582), `transaction()` hands back in `finally`
  (1086-1087), `begin_writing` failing with WriteBusy leaves the unclaimed ticket and frees the writer. Followers
  keep their own budgets (test_a_write_refused_behind_another_process). The one gap is a BaseException inside
  `commit_batch`, see Minor 3.
- Shutdown: no graceful stop exists (main() at 1625-1633, daemon threads); SIGTERM kills mid-commit, WAL recovery
  drops an unfinished COMMIT, and no owner has been answered for it. Unchanged by this commit.
- Two processes: `relay.py admin` is the only other writer; the service's head meets it through `begin_writing`'s
  busy_timeout bounded by the head's budget, the queue behind keeps waiting (relay.py:548-556, 572-582); admin's
  side is Minor 4.
- Python 3.12: `collections.deque[WriteTicket]`, `type[...]`, `X | None`, `enterContext` (3.11) are all fine.
- Secrets: nothing logged; the tests' KEY is a fixed 'k' and no key value reaches a message. No em dash in either
  file (grep for U+2014). Sign-off: absent, as ledger line 41 rules (Ivan's commit instruction overrides the DCO line).
- Gates: the ledger records worst changed CRAP 5.0 and no dryer pair; the functions are small and single-purpose, and
  `roll_back` removes the duplicated rollback that transaction() carried.

## Minor

1. relay.py:490-500, 517-524 (ledger ruling 3): a claimed plugin ticket whose owner gives up still lands. For
   NewProxy that is a pending row at generation+1 for a registration frps refused; it reads `held` for up to
   PENDING_S (10 s) with a client that is not connected, then empties, and frpc retries after 30 s. The ruling names
   the cost and I accept it; a cheap tightening would let a ticket carry its deadline so `claim_statements` skips a
   ticket whose budget is already spent instead of claiming it, which shrinks the window to the fsync itself.
2. TDD evidence: the package shows only test_a_burst_of_logins failing on the old code for the right reason
   (`relay error: busy`). The other eleven tests reach `self.relay.writer`, which the old code lacks, so on the old
   code they fail with AttributeError, not for the behavior they name; test_a_commit_waits_for_the_disk passes on
   both. Process only, no harm to a person.
3. relay.py:572-578 `commit_batch` catches Exception while `transaction()` catches BaseException. A BaseException on
   the holder's thread would skip `roll_back`, leave that connection in a transaction holding SQLite's lock, and
   every later `write()` on other threads would end in WriteBusy until restart, while `write()` on that same thread
   would bypass the queue through the `in_transaction` shortcut. Not reachable today (KeyboardInterrupt goes to the
   main thread, nothing raises SystemExit in a handler), so Minor; `except BaseException` with a re-raise after
   setting the errors would close it.
4. relay.py:1575-1576 (ledger ruling 5): `admin()` does not catch WriteBusy, so `relay.py admin list` under a lock the
   service holds past 0.8 s ends in a Python traceback rather than a sentence. Pre-existing shape, the ruling names
   the cost.
5. test_writes.py:611-618: the test named "refused on time" asserts WriteBusy but never measures when; the timing
   promise is carried by test_a_plugin_call_stops_waiting (asserts waited < 0.9 s against a 0.25 s budget, loose) and
   by test_restart_burst's under-1000-ms check. Enough together; the name overstates the single test.
6. test_writes.py:580-587 relies on the burst's threads queueing within the first holder's 30 ms commit; the comment
   at 403-404 explains the margin and the run here took 1.76 s for the file, so it is not flaky in practice, only
   timing-based by nature.

## Rulings in the ledger, judged

1. One writer with group commit, FULL kept: right; it is the only design that keeps R2.4's fsync per answer and still
   fits a 40-link burst in one budget.
2. write() returns rows changed: right and necessary once a statement runs on another connection; both callers
   converted, the transaction bodies correctly left alone.
3. A claimed plugin write may land after its refusal: accepted, see Minor 1.
4. An API write in a commit under way waits for the outcome: right; a 503 for a landed sync record would make the
   client's retry stale_epoch, which is worse than a slow answer.
5. init_db's CREATE TABLE IF NOT EXISTS through the writer: harmless; a no-change COMMIT does not fsync, and the
   cost named is the admin traceback of Minor 4.
