The leftover unittest tree belongs to the build lead's own `codex exec` session (PPID 97966), not to me, so I leave it untouched. All processes I started have finished. Here is the final report.

---

# Task 6 fix round 1, report

## Verdict

All accepted findings fixed. Full relay suite green on both Pythons against the final code:
- `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test` -> 101 tests, OK (372 s)
- `python3 -m unittest discover -s relay/test` (3.14) -> 101 tests, OK (370 s)

No commit made. `relay/test/test_peers.py` staged (`git add`) so `git ls-files` sees it; nothing else staged.

## Files changed (only the four authorized)

- `relay/relay.py`: C1, C2, I6 production fixes.
- `relay/test/test_peers.py`: all new tests (C1, C2, I1-I3, I5-I7).
- `relay/test/test_route.py`: one fixture-only change (sanctioned): the busy-Login fixture in `test_login_refuses_busy_when_the_write_lock_is_held` now omits its arbitrary `run_id: 'r1'`, so it still exercises the busy `touch()` write (a run id would now hit the dashboard read first). All contention assertions untouched and passing.
- `README.md`: I4.

## Findings, regressions and initial failures

- **C1** (Critical). Pinned against the local frps 0.71.1 binary first: a legacy (no clientID) session shows `clientID == runID` in `/api/clients`; `?runId=<rid>` returns exactly the matching record; unknown run id -> 200 `[]`; `?runId=` (empty) returns everything (so the empty-string case is not a filter regression). Regressions `test_r1_3_legacy_login_with_foreign_run_id_refused` and `test_r1_3_legacy_run_id_of_another_binding_refused` both **failed first** with `{'reject': False, ...}` (the empty-client_id legacy path skipped `run_id_conflict`). Positive control `test_r1_3_legacy_reconnection_kept` passed before and after. Fix: `login_reason` now checks every non-empty run id; `run_id_conflict` compares the live `clientID` against the client's own dashboard identity, which for a legacy login is the run id itself; new `run_id_recorded_elsewhere` refuses a run id the route ledger holds for another binding (the case the dashboard cannot distinguish, since a legacy victim's `clientID` equals its run id). Dashboard reads stay on the one plugin deadline via `_dash_get`.
- **C2** (Critical). Regressions `test_r6_2_visitor_key_dies_with_the_binding_api` and `..._admin` **failed first**: the `visitor_keys` row survived release on both paths. Fix: new `release_binding()` deletes the visitor key and the binding in one `BEGIN IMMEDIATE` transaction under the same lock budget as `write()` (the busy-503 API path still answers 503 `Retry-After: 1`); API DELETE and `admin release` use it; `admin unban` was extracted to `unban_binding()` so `admin()` itself gains no branches (its CRAP 285.4 may not rise). New `store_visitor_key()` re-checks the authorizing key's hash inside the single INSERT statement, so a request authorized against the old binding cannot store a credential for a rebound one (proven by the in-process `VisitorKeyStoreTests`, including "old stored hash unchanged" on a stale write). Planned columns and hash-only storage unchanged; every write goes through `write()`.
- **I1** (test-only). Existing production behavior was correct; the gap was the test. `test_r5_1_peer_services` now asserts no `routes` row and route `{state: empty, generation: 0}` with no link client; new `test_r5_1_stcp_registration_keeps_the_link_route` pins client/since/generation of a held link across peer registrations.
- **I2** (test-only). `stcp_proxies` takes a target port per service; a second, self-naming echo server (`extra_echo`) serves `-data`, the stack echo serves `-app`; each visitor's answer is verified by identity; both servers are registered for cleanup before use, so they stop on failure too.
- **I3** (test-only). Probe in TMPDIR showed the old check **passed** an HTTP 200/403 with an empty body while the raw-bytes check **fails** it and passes a true silent close. `echo_closes_silent` now requires zero raw bytes before EOF/reset: `sendall` and `recv` guarded for reset/broken pipe, any received byte fails, timeout fails. Verified against real frps with a wrong stcp secret.
- **I4**. README "What it never does" no longer claims tunnels reach only the app; it now describes the `-peer` services `-data`/`-app` truthfully and states the relay fixes service names, not the ports they connect to.
- **I5**. `test_dash_clients_run_id_filter_against_real_frps` pins the filtered query with a second online client (exactly one record; unknown run id -> 200 `[]`), so an unfiltered `/api/clients` regression fails. New in-process `LoginReadBudgetTests` pins the exact request path, accepts a fast good answer, refuses a 0.7 s answer and a 3 s hang within the shared 1 s budget, and proves a spent budget never reaches the dashboard. Lead ruling kept: the per-plugin-read cap stays `min(0.5 s, time left)`; AGY's 1.0 s cap not applied.
- **I6**. Regressions **failed first**: explicit `null` `client_id` read as legacy (`reject: False`), non-string `metas.client` on NewProxy was coerced, and an empty dashboard `clientID` parsed. Fix: `malformed_id_reason` rejects present-but-non-string `client_id`/`metas.client`/`run_id` (absent stays the legacy empty string, as real frpc sends); `CLIENT.fullmatch` in both `client_id_reason` and `offer_reason` (trailing newline fails); `dash_client_records` rejects empty `clientID`. Malformed metadata refuses before any route/generation write (asserted). Also pinned: empty-string `run_id` stays allowed.
- **I7**. Malformed id cases (short m8, non-hex, uppercase, unknown kind, trailing newline, trailing text) all refuse; visitor-key session refused for an http NewProxy; visitor-key POST with no Authorization and with the visitor key as Bearer both 401; contention under a held write lock answers 503 `busy` with `Retry-After: 1` and the stored hash unchanged. Existing successful controls and rotation tests untouched and passing. Note: the visitor NewProxy refusals, the 401s and the busy 503 were already-correct production behavior; the tests now pin them.

The three kept minors were not touched.

## Deviations and things I could not do

1. **`gates-relay.sh 75e8a3d` could not be run**: the script does not exist anywhere on this machine (searched both repos, home, /tmp), and `crapper`/`dryer`/`mutator` are not installed as binaries. As the closest substitute I did a manual CRAP review of every new/changed function (all under CC 8, well under CRAP 10 with the suite's coverage; `admin()` unchanged after extracting `unban_binding()`; `create_binding` untouched) and checked the new code for duplication pairs (only the small transaction scaffold is shared between `release_binding`/`unban_binding`, below 0.8 by inspection). Ask the lead to run the real gates.
2. **Facts pinned, not guessed**: frps 0.71.1 legacy dashboard identity (`clientID == runID`), filtered clients shape, and empty-runId-returns-all were verified with the local binary via a TMPDIR probe before writing the C1/I5 tests.
3. Leftover processes: one `python3.12 -m unittest discover` tree (hornhoof-eviction stack) is still running, but it belongs to the build lead's own `codex exec` session (PPID chain verified), so I did not stop it. Every process I started has finished; TMPDIR probes were deleted.
4. Test counts: suite went from 74 to 101 tests (all new tests are in `test_peers.py`).
