Review complete. All verification done; the repository is untouched (same 4 pending paths, same staged state).

## Review findings — Task 6 round 4 (Kimi reviewer)

**Critical: none.** C3 is closed correctly.

**Important: none.** I8 is closed correctly, and no interface deviations found.

**Minor:**

1. `relay/test/test_peers.py:904-906` — `test_wire_legacy_reserved_identity_offline_refused` asserts `len(entries) == 1` and `online is False` immediately after the wait loop. If frps cleared the offline record between the wait and the read, the assert fails spuriously (the unit-level offline case is pinned at `LoginReadBudgetTests.test_legacy_run_id_namespace_with_absent_and_offline_answers`, so coverage would not be lost). Stable across the writer's two runs, the lead's runs and my run; same nature as kept M2. Optional: tolerate `entries == []` as an already-cleared offline record. Not a round4 regression; no fix requested.

Everything else checked out:

- **C3 closure verified natively.** On a reconstructed pre-round4 copy (guard removed, under `$TMPDIR`, since deleted): `test_wire_legacy_reserved_identity_absent_refused` fails with "a legacy login reserved an absent network identity" (accepted=True), the offline wire test fails the same way, and the unit case fails for both absent and offline (`{'reject': False}` instead of refusal). On the real tree all pass. The guard at `relay/relay.py:671` (`not client_id and CLIENT.fullmatch(run_id)`) refuses before any dashboard read in every state; genuine non-CLIENT legacy reconnects still pass (`test_wire_genuine_legacy_reconnect_after_disconnect_kept`, `run_id_conflict` fall-through), as do same-binding proven reconnect, explicit-ID own reconnect, peer run_id==client_id, and all cross-binding ledger guards. Matches ruling line 62 exactly; no namespace broadening beyond CLIENT-shaped legacy run ids.
- **I8 closure verified.** Pre-round4 copy (the two `assertIsNone` restored): both `VisitorKeyDiagnosticTests` fail only at the "captured failure rendered a visitor key" check while still detecting exactly one failure/zero errors. Fixed assertions at `test_peers.py:638,662` are exact `observed is None` booleans with fixed messages; capture is in-memory only, prints nothing, and all prior safe hash/label diagnostics are preserved.
- Round4 writer touched only `relay/relay.py` and `relay/test/test_peers.py` (mtimes Nov 4 09:13 vs Nov 3 for README/test_route). No em dashes anywhere in the four files. All relay files parse on Python 3.12. No key/token/visitor value printed by tests or relay logs (`trace_plugin` logs op/name/client/ms only; `visitor_key_answer` logs the name). Kept minors M1–M6 untouched. README statements match the interfaces at this commit.
- Prior round3 fixes intact: whole suite green including C1 takeover wire tests, C2 lifecycle/race/rollback tests, I1–I7 diagnostics, and the min(0.5 s, time left) Login dashboard reads (rejected 0.7 s answer still refused within budget).

**Done when, run once:**
`PYTHONDONTWRITEBYTECODE=1 nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`
**Result: Ran 123 tests in 386.093 s — OK (123 passed, 0 failed, 0 errors).**

No test-owned relay/frp processes or listening ports left behind (post-run `ps`/`lsof` audit clean). No files edited, staged or committed in either repository. Lead gates from the ledger (max changed CRAP 9.0609 do_POST, login_reason 9.0, run_id_conflict 9.0, admin 29.4, create_binding 26.2, dryer none) are consistent with what I read; I ran no gate/dryer scripts myself per the brief.
