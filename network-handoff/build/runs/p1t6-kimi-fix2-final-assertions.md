# Task 6 fix2 I8 rotation/rebind diagnostics report

## First failure (as required, run before any edit)
`p1t6-lead-rotation-diagnostics-probe.py` on stable source: all four cases detected their unsafe mutation but leaked the generated key (1 failure, 0 errors, credential leaked: True for rotation-status, rotation-reuse, binding-reuse, issuance-auth-bypass), probe exit 1.

## Changes (relay/test/test_peers.py only, 4 assertion sites)
- `test_r5_1_peer_limits`: second rotation issuance now asserts `status == 200` with a fixed message (raw key-bearing body removed); key rotation inequality converted to `assertTrue(second['visitorKey'] != visitor_key, ...)` with a fixed message.
- `test_r6_2_visitor_key_dies_with_the_binding_api`: rebind key inequality converted to `assertTrue(rebound['key'] != self.key, ...)` with a fixed message.
- `test_r6_2_visitor_key_needs_the_link_key`: both expected-401 visitor-key issuance assertions use fixed messages, no raw bodies.
- `test_r6_2_visitor_key`: expected 401 and 404 issuance assertions use fixed messages.
- Audit: no `assertNotEqual` remains anywhere in the file; every visitor-key endpoint status assertion message is now fixed (200, 401 and 404); remaining body-rendering assertions are plugin answers, route bodies and non-key error dicts only. No check weakened: all comparisons are exact, only diagnostics are sanitized. Fixture constants (k1/v1) untouched.

## Results
- Lead rotation probe after: all four cases fail internally (1 failure, 0 errors each) with credential leaked: False; source/test stable; probe exit 0.
- Focused affected methods (`test_r5_1_peer_limits`, `test_r6_2_visitor_key`, `test_r6_2_visitor_key_needs_the_link_key`, `test_r6_2_visitor_key_dies_with_the_binding_api`): 4 tests OK on `/opt/homebrew/bin/python3.12` and on `python3` (3.14).
- Regression privacy probes all PASS: label, store-output, http-output, extra-diagnostics, early-route-read.
- Production unchanged: `relay/relay.py` sha256 `ea547f78a5e61...5c91a1`, identical to the hash recorded after the last production edit. `git status` shows only the four authorized files with staged state preserved; no commits, no owned frps/frpc/relay processes.

Per instructions I did not rerun full suites or gates; the prior full 3.12 suite and actual gates stand for all other code, and the lead runs fresh full Done when on both Pythons and fresh coverage gates independently.
