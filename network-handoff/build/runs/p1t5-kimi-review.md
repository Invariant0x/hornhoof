## Review: Plan 1 Task 5 — the sync record (R2.4)

### Findings

**Critical:** none.

**Important:** none. I checked R2.4 row by row against `relay/relay.py:362-422, 790-808`:

- Table schema matches exactly (`relay/relay.py:117-124`); `PRAGAGMA synchronous=FULL` is set on the connection (`relay/relay.py:90`); the post writes through `write()` (autocommit, so committed before the 200).
- Holder check and write both run under `route_lock(name)` (`set_sync`), the holder check requires the DB row state `'held'` (a `pending` row reads `held` in the route answer but is refused — `sync_holder`, `relay/relay.py:393-398`), and the write is guarded in SQL by generation, client and `'held'` (`store_sync`, `relay/relay.py:401-410`).
- 400 `invalid` covers exact fields, `state`, `copy`-null-when-on, and the ruling (bool or `> 2**63-1` integer → 400, via `type(value) is int`, `relay/relay.py:375-390`). 404/401 reuse the route's auth via `authorize_link` (the reported shared extraction). 503 on `FrpsUnknown`; 409 `not_holder` before 409 `stale_epoch` (interface order); 200 `{sync: sync_of(name)}` read back after commit.
- Review Focus 2: a post from a non-holder client or wrong generation gets 409 `not_holder` (`test_sync.py:73-91`).
- Tests are strong: full-dict equality on the record, read-only `sqlite3` check right after the 200 plus `restart_relay()` (`test_sync.py:108-115`), a barrier-synchronized concurrency test asserting `[200, 409]` with `stale_epoch` (`test_sync.py:199-213`), no sleeps-as-waits (`_wait` predicates), no skipped checks. The six extra tests match what Codex reported.
- README additions are true at this commit and contain no em dash; `test_public.py` (private words, hosts, no em dash) passes.

**Minor:**

1. `relay/relay.py:794-795` — `sync_answer` answers `415 unsupported_media_type` for a non-JSON Content-Type, a status the task's interface does not list (it only specifies `400 invalid` for body problems). It mirrors `create_binding`'s existing behavior and is tested (`test_sync.py:188-197`), so it is consistent house style, but strictly it is an extra answer beyond the brief.
2. `relay/relay.py:420-421` — a failed guarded write in `store_sync` is mapped to `not_holder` rather than `stale_epoch`. Unreachable while the per-name lock serializes all sync writers and route registrations, and the choice is fail-closed, so no change is required; noting it only because the mapping is approximate.

No Python newer than 3.12, no processes or ports left behind (verified after both runs), nothing private in tracked files, no formatter run, nothing committed.

### Done when

Ran `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`: **74 tests ran, 74 passed, 0 failed** (`OK`, 332.5 s), including all 13 `test_r2_4_*` tests.

### Gates

Ran `gates-relay.sh 6faf6c8`: every function the task added or changed is under CRAP 10 (highest: `sync_answer` 8.0, `set_sync` 4.0); `admin` 285.4 and `create_binding` 26.2 unchanged; dryer found no pair at 0.8 or above.
