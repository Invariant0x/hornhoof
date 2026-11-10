# Task 6 fix2 completion report

## Files changed (only the four authorized; no staging, no commit, HEAD still 75e8a3d)
- `relay/relay.py`
- `relay/test/test_peers.py` (staged state preserved: `AM`)
- `README.md`, `relay/test/test_route.py` (fix1 changes untouched)

## Items fixed, each with a first failure on current source

**C1 (Critical, unrecorded legacy hijack).** New `FrpsWireSession` helper in test_peers.py speaks the real frp 0.71.1 v1 wire with stdlib only: plain TCP, yamux (12-byte headers; only data frames carry payloads; the fork's keepalive ping carries its id in the length field and takes flagACK; windowUpdate length is a delta), one msg.Login per stream (type 'o', 8-byte length, JSON with the wire key `metas` pinned against the local binary; token auth `md5(token + timestamp)` with the empty test token). Pinned fact: SYN and Login must be sent in one segment, a lone SYN segment is mishandled. 6 native tests; first run: both takeover tests failed with hijack accepted. Fix: `run_id_conflict(run_id, client_id, name)` + `legacy_run_id_proven` enforcing the lead ruling (online session + legacy login requires clientID == run_id, run_id not fullmatching CLIENT, and a same-binding routes row with client='legacy'). Lead probe failed before, passes after.

**I6.** `malformed_user_reason` + hardened `call_metas`/`trace_run_id`/`trace_client` (the trace path crashed on non-dict user, dropping the connection). Tests: [], ['r'], null, int, bool, non-dict user, fresh route, held route, empty-run_id still registers. Lead probe failed before, passes after.

**I2.** Both services now use named echoes; exact parsed identities asserted for data and app. Mutation probe passes (detects both-wired-to-data), unmutated test passes.

**C2 coverage + stale DELETE + concurrent ban (two Criticals).** New `VisitorKeyLifecycleTests` (7 tests, all event-wait tests now resume and bounded-join in finally): coordinated issuer/release with hooked `write`; real HTTP issuance paused after auth with concurrent DELETE+rebind (old 404, no stale credential); release rollback on second-delete failure; admin ban/unban on real and placeholder bindings via captured subprocess output; stale DELETE regression (failed first: 204 erased the new owner); concurrent-ban regression (failed first: 204 erased the ban). Production: `transaction()` contextmanager (BEGIN/COMMIT through `write()`, rollback guaranteed, spent budget refuses), `release_binding(name, expected_hash)` rechecks hash AND `banned_at IS NULL` inside the transaction; DELETE handler answers 404 on a stale release; admin release stays unguarded; 503 busy with Retry-After:1 preserved. Issuance test strengthened: new owner's current hash lands before the resume and must survive exactly; the lead's stale-delete-store mutant probe now fails the test (detected). Mutant checks (in-memory only): untransactional release rejected by issuer and rollback tests; missing-404-branch mutant rejected; unconditional-release mutant rejected by stale-DELETE and ban tests; no-ban-guard mutant rejected by the ban regression.

**I8.** Credential-bearing subTest labels replaced with safe case names; `test_r6_2_visitor_key` store assertions converted to boolean with fixed messages; key-bearing HTTP bodies removed from assertion messages. All four privacy probes (label, store, http, plus mutation detection) fail before and pass after, printing counts/booleans only.

**G1.** The duplicated budget/lock/error block in `release_binding` is gone; acquisition lives only in `write()`. Dryer check failed before (0.82 pair), now: no duplicate candidates. `offer_reason` split (`service_offer_reason`) after crapper showed it at exactly 10.0.

## Final verified state
- Full suite `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`: **117 tests, OK** (381 s), plus the coverage run inside the gates (117, OK) = 3.12 run twice in the final phase; earlier fix2-phase runs: 116+116.
- Full suite `python3` (3.14): **117 tests, OK** (379 s).
- Real gates `gates-relay.sh 75e8a3d`: exit 0. Crapper worst changed function `run_id_conflict` 9.0, all changed/new functions under 10; `admin` improved 48.0 to 29.4, `create_binding` unchanged 26.2. Dryer: no pair >= 0.8.
- All 10 lead probes pass: legacy-unrecorded, newproxy-id, service-identity, delete-lifetime, delete-ban, test-output, store-output, http-output, new-owner-retention, dryer-check.
- No owned frps/frpc/relay process remains; the PIDs named by the lead no longer exist and no orphan relay/frp processes were found. No commit, no staging changes, no lead-record edits.

## Deviations
- One comment-only docstring line in relay.py's module header documents the new 404 on DELETE; no README change was needed for the fixes (README's fix1 text remains accurate).
- The positive-control wire test asserts per the lead ruling that an unrecorded legacy run id reconnect is refused (accepted cost: eviction wait and frpc retry); the reconnect that stays is pinned in `test_wire_legacy_reconnect_with_proven_route_kept`.
