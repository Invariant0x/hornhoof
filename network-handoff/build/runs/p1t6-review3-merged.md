# Plan 1 Task 6: merged review round 3 and lead judgment

## Evidence before judgment

- Codex: runs/p1t6-review3-codex.md, Done when 117 passed, 0 failed/errors, 384.429 s. Reports no remaining Critical; C1 live takeover, C2 lifecycle/races/rollback, I1-I7 and G1 closed. Reports residual Important I8 at test_peers.py637/660: assertIsNone(visitor_key_hash()) renders the actual generated visitor key under a deliberately injected plaintext observation. Safe in-memory checks produced one failure and zero errors per case, with credential in captured diagnostics, never printed.
- Antigravity: runs/p1t6-review3-agy.md, completed CLI exit0, Done when 117 passed, 0 failed/errors, 383.865 s. Reports no Critical, one Important offline legacy client-ID squatting gap, one new Minor constructor cleanup gap, prior M1-M4 retained. Its native local frps check showed one binding can reserve another binding's client ID while that client is offline, and the legitimate client then cannot log in. It closes C1 live takeovers, C2, I1-I8 and G1.
- Merge before judgment: the lists are not equivalent. Antigravity's I8 closure covers the existing probes; Codex supplied two additional observations not covered by those probes. Preserve that residual finding. Antigravity's new namespace-squatting result is independent of the fixed online takeovers and must be graded on its availability impact.
- Final before/after comparisons for BOTH repositories are unchanged: runs/p1t6-review3-before.* and runs/p1t6-review3-network-before.*. No reviewer source/index mutation. Both reviewers report no remaining test relay/frp processes. No metric rewrite during review.
- Lead: full Done when117 passed on Python3.12 in379.528s and3.14 in377.617s; source snapshot unchanged. Fresh gates117 coverage tests passed in424.709s; max changed CRAP9.1 (Handler.do_POST), admin29.4 improved from285.4 at task base, create_binding26.2 unchanged, dryer no candidates at0.8. Exact logs p1t6-lead-final-done312.log, -done314.log, -gates.log. Final pending-row/privacy counterexample checks passed in -probes.log.

## Lead judgment

C3 Critical, open: offline legacy client-ID squatting. Source relay/relay.py307-346 and663-681 puts CLIENT-shaped run-id refusal only in the online legacy-proof path. An absent/offline dashboard answer falls through without that refusal. The already-pinned frps fallback identity is client_id or run_id, so this crosses binding identity namespaces before a legitimate client starts. Antigravity reproduced the native acceptance and subsequent legitimate-client refusal against local frps0.71.1. A person using a second company on the same machine can be locked out by a different binding holder. This violates the client-ID ownership interface and R1.4, so the lead upgrades Antigravity Important1 to Critical. It does not displace an already-online session and does not grant the foreign company's route or service access. The earlier ruling about absent/offline legacy reconnects was followed literally; its permissiveness now has a confirmed unsafe case. This requires a reviewed follow-up decision, not a guessed exception.

I8 Important, open: two remaining generated-credential diagnostic assertions in relay/test/test_peers.py637/660. Accept Codex's additional counterexample despite Antigravity's broader closure statement. Exact production storage/release currently passes; the gap is the accepted test-diagnostic requirement under injected plaintext observation. No fix launched after round3 because the mandatory Critical stop already applies.

Closed: old C1 online takeover, C2 issuance/release/rebind/ban races and rollback, I1-I7, G1. The final gates pass but do not cover the newly demonstrated offline namespace gap.

Minor M5, kept: FrpsWireSession constructor does not immediately close its socket if login response wait raises; Stack teardown stops frps and bounds the test-only resource lifetime. Source test_peers.py717-737/808-811. No production effect.
Minor M6, kept (lead inspection): module DELETE listing at relay.py7 implies404 whenever a name has a new owner; ordinary obsolete-key requests get401, while the guarded request authorized before rebind gets404. Both refuse the request; documentation is imprecise about the race. No code change.
M1-M4 stay kept as previously ruled: blocked-before-key ordering, possible eviction-test log-offset false failure, README event-list omission, delayed-dashboard socket stderr noise.

## Stop

Three total review rounds are complete. Ivan's explicit rule says to stop when three rounds still leave a Critical. Therefore no third fix writer, no fourth review, no staging change and no commit. Task6 remains pending on relay HEAD75e8a3d with exactly README.md, relay/relay.py, relay/test/test_peers.py (AM staged state preserved), relay/test/test_route.py. Tasks7-12 are not started. Task13 and A1 remain outside scope.

No deployment, SSH, company access, GitHub contact, push, merge, amend or commit rewrite was performed. No private SSH/key file was read or generated credential printed. The Task8 public-GitHub test-dependency exception remains an unanswered clarification and was not treated as permission.
