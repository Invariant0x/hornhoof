# Plan 1 Task 6 round 4: merged findings and lead judgment

## Both reviewer lists before judgment

Kimi (runs/p1t6-review4-kimi.md): no Critical, no Important; C3 and I8 closed. Independently ran123 tests on Python3.12, all passed in386.093s. Verified first-failing C3/I8 cases on isolated reconstructed pre-fix copies, post-fix behavior and prior regressions. One new Minor: offline-record assertion can falsely fail if frps clears the record between wait/read (test_peers.py904-906). Prior M1-M6 kept.

Antigravity (runs/p1t6-review4-agy.md): no Critical, no Important; C3 and I8 closed. Independently ran123 tests on Python3.12, all passed in382.094s. Verified native pre-fix acceptance/refusal and diagnostic mutation detection including a silenced-check mutant in TMPDIR. One new Minor: CLIENT guard in legacy_run_id_proven is redundant/unreachable through Login after the early boundary guard (relay.py342-343). Prior M1-M6 kept.

Merge: the two new Minor findings are distinct. Both reviewers agree both mandatory findings are closed and earlier C1/C2/I1-I7/G1 remain intact. Both exited0. Final status/diff/publishable-file hashes for BOTH repositories match their saved before snapshots. The lead created its own authorized records in L during review; source/index invariance is what the snapshots establish, not an unchanged entire L folder. No reviewer mutation detected.

## Lead judgment

C3 CLOSED. A legacy CLIENT-shaped run id now refuses before an absent/offline dashboard answer can permit it. Negative native tests cover absent/offline identity state, no online reservation and legitimate fixture-client startup afterward. The fake dashboard additionally pins a literal offline answer; real frps clears offline runID, as directly observed. Non-CLIENT legacy reconnect, initial empty runID, explicit-ID reconnect, online proof and cross-binding guards remain.

I8 CLOSED. Both lifecycle checks are exact is-None boolean assertions with fixed messages. Permanent safely captured diagnostics fail before the fix, detect the injected observation, reject a silenced check, and pass after the fix without rendering the generated visitor key. Only the two requested assertions changed.

M7 KEPT MINOR, not fixed: native offline-record assertion could falsely fail if the record is cleared between wait/read. User-visible production behavior stays correct; the literal offline state is separately pinned. Cost: a future false test failure/retry.
M8 KEPT MINOR, not fixed: the prior CLIENT-shaped legacy proof guard remains as redundant defense after early Login validation; its refusal line is unreachable through Login and helper coverage is80%, CRAP2.0. Cost: a small redundant branch. Kept to honor the narrow authorized fix, rather than add unrelated cleanup.

M1-M6 remain kept as previously recorded. No open Critical or Important. Fourth round is accepted, no fifth review.

## Verification and acceptance

Writer separate Codex exec: runs/p1t6-codex-fix4.md/.log. Only relay.py/test_peers.py changed since round3. README/test_route.py unchanged. All prior staged/unstaged Task6 work preserved. Writer18 focused tests per interpreter passed;123 full tests passed on each Python version twice, actual gates passed. No dependency or production-scope deviation.

Lead actual Done when: nice -n10 python3 -m unittest discover -s relay/test -v ->123 passed, Python3.14,388.793s (runs/p1t6-lead-round4-done314.log).
Lead actual gates: L/gates-relay.sh75e8a3d (space before argument) ->123 full Python3.12 coverage tests passed in403.502s; changed maximum CRAP9.0609/do_POST, login_reason9.0, run_id_conflict9.0, old admin29.4 improved from285.4 at task base, create_binding26.2 unchanged; dryer no candidates at0.8. Exact log runs/p1t6-lead-round4-gates.log.

Inspected source snapshot p1t6-fix4-inspected matches final writer/lead-tested source. Formal review snapshots p1t6-review4-before and p1t6-review4-network-before unchanged. The four task files are authorized to stage/commit as Ivan instructed, without trailers. Completion ledger follows only after the commit succeeds. Task7 may start after that commit.
