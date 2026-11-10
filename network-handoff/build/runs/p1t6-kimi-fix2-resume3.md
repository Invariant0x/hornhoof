# Task 6 fix2 test-completion report

## Changes (test_peers.py only; production, staging, commits untouched)

**I6 premature route read.** `test_newproxy_malformed_run_id_keeps_existing_route` rewritten: after a real network client holds the route, the row is set to `pending` in SQLite, then the malformed NewProxy (`user.run_id = []`) is sent, then SQLite is inspected directly with no route API read in between. It requires the explicit `this run id belongs to another client` refusal and generation, client, state `pending` and exact run_id all unchanged.
- First failure: `p1t6-lead-early-route-read-probe.py` failed its detection assertion on the old test (route read before validation invisible on a held row).
- After: normal test passes on 3.12 and 3.14; the probe passes by observing the strengthened test reject the injected premature route read (1 failure, 0 errors, source/test stable).

**I8 remaining key-bearing diagnostics.** All visitor-key issuance status assertions now use fixed messages (10 sites across `test_r1_3_foreign_client_id_refused`, `test_r5_1_peer_services`, `test_r5_1_peer_limits`, `test_r6_2_visitor_key_needs_the_link_key`, `test_r6_2_visitor_key_busy_keeps_the_old_hash`, `test_r6_2_visitor_key_dies_with_the_binding_api`, `test_r6_2_visitor_key_dies_with_the_binding_admin`, `test_r6_2_visitor_key`). Every stored visitor hash comparison converted to boolean form with a fixed message so a plaintext-store regression renders no credential (lifecycle rotation and stale/ban retention, busy retention, admin unban checks, store tests; 9 sites).
- First failure: `p1t6-lead-extra-diagnostics-probe.py` showed both unsafe cases detected but credential leaked: True (issuance status diagnostic; lifecycle hash diagnostic).
- After: probe passes, both unsafe cases still fail internally (1 failure, 0 errors each) with no generated key in captured output. Original label, store-output and HTTP-output privacy probes rerun: all PASS. Remaining `body`-in-message assertions are plugin answers, route bodies and 401/404 error dicts, which are never key-bearing; audited and kept.

## Verification
- Focused `relay.test.test_peers` on `/opt/homebrew/bin/python3.12`: 43 tests, OK.
- Focused `relay.test.test_peers` on `python3` (3.14): 43 tests, OK (this is the 3.14 coverage for the strengthened tests; no old 3.14 run is claimed to cover them).
- Full Done when `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`: 117 tests, OK, 379 s, exit 0.
- Real gates `gates-relay.sh 75e8a3d --no-tests` (permitted: relay.py byte-identical to the fresh coverage run just completed): exit 0. Crapper: every changed/new function under 10 (worst `run_id_conflict` 9.0; `admin` 29.4, `create_binding` 26.2). Dryer: no duplicate candidates.
- Probe sweep, all PASS: early-route-read, extra-diagnostics, label, store-output, http-output, new-owner-retention, service-identity (plus delete-lifetime, delete-ban, legacy-unrecorded, newproxy-id and dryer-check passing from the prior step).
- No owned frps/frpc/relay process remains; `git status` shows only the four authorized files, staged state preserved, HEAD 75e8a3d.

## Remaining gaps
None known. Full fresh 3.12 and 3.14 suites on the final source are left to the lead as stated in the notes.
