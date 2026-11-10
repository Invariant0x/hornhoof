Task 7 writer report, base dce89a9 on main.

Authorized core work is implemented and focused checks pass. Final Done when and quality gates remain pending because briefs/plan1-task7-fixture-approval.md is absent. test_route.py and test_sync.py were not edited. No final plain full suite or gate coverage suite has run in this session, leaving the requested two plain final full suites available for the approved continuation.

Files changed:

- relay/relay.py: authenticated key rotation, atomic authorizing-hash and ban recheck, persistent heartbeat-only retired hashes, requested-name live-route checks and unknown handling, API documentation, shared key issuance and POST dispatch.
- relay/hornhoof-relay: help comments only, describing immediate 410 and release after the old tunnel is gone.
- relay/test/test_keys.py: 17 tests covering the requested scenarios, legacy traffic through a heartbeat after rotation and relay restart, ownership races, busy/rollback behavior, authentication limits, name ordering/limits and HTTPS/ambiguous dashboard answers.

Action log and evidence, in order:

1. Inspected git status, branch and HEAD, the full network-build progress ledger including every Ruling, Task 6 round 4 merged evidence, the exact fixture proposal, the gate script, current relay source, wrapper, Caddyfile and local test harness. The repository was clean on main at dce89a9. Searched for local AGENTS.md instructions and the required execution skill; read executing-plans, test-driven-development, writing-good-tests and verification-before-completion. User instructions took precedence over skill workspace, commit and review steps.
2. Created this temporary evidence directory. Confirmed frps/frpc binaries and Python 3.12 already exist. No download or install was needed.
3. Wrote eight initial integration tests before production changes. Ran `nice -n 10 python3 -m unittest relay/test/test_keys.py -v`: eight tests, six failures, three tests passed. The failures were /key returning 404 instead of 200, a freed live name reporting free, and the no-dashboard GET/POST returning 200/201 instead of 503. Three existing ban/Caddy behaviors passed on the base and were retained as regressions. See initial-red.log.
4. Implemented the basic endpoint and requested-name checks. Ran the legacy heartbeat test alone: failed after 31.091 s because the real legacy Ping was rejected following two rotations and a relay restart. See heartbeat-red.log.
5. Added deterministic HTTP authorization/write races before guarding the update. Ran `nice -n 10 python3 -m unittest relay.test.test_keys.KeyAuthorizationTests -v`: four tests, two failures. Both paused requests returned 200 instead of 404 and changed the key after release/rebind or ban. Busy and basic auth behavior already passed in this staged implementation. See authorization-red.log.
6. Added the atomic hash/ban guard and heartbeat retention in one transaction, with all statements through write(). Retired hashes are usable only for Ping while their matching current binding remains unblocked. Release/rebind invalidates that matching relationship. Existing route/visitor release guards were unchanged. Updated wrapper comments only.
7. Ran `nice -n 10 python3 -m unittest relay/test/test_keys.py -v`: 12 tests passed in 74.946 s. Added five further coverage/regression cases and ran the nine authorization tests: all passed in 5.451 s. See focused-green314.log and additional-focused314.log. Closed each in-process HTTP thread's SQLite connection in the test fixture to avoid new ResourceWarning noise.
8. Shared key response handling with the existing visitor endpoint and consolidated POST dispatch to avoid duplication and keep complexity small. Visitor storage and release conditions remain unchanged.
9. Copied only public test/source files into an isolated temporary base tree with relay.py reconstructed from dce89a9. Ran the nine authorization tests there: 39 failures including subtests, as expected for absent /key and absent route checks. This is supplementary baseline evidence for tests added after the initial test batch, not a claim that all nine were run before the first production edit. See authorization-baseline-red.log.
10. Ran isolated temporary fault checks without changing repository source: disabled ban authentication, reversed blocked.caddy order, removed heartbeat binding/ban guards, and removed the rotation transaction. The three existing ban/Caddy regressions all failed; the heartbeat guard case failed on a banned retired Ping; rollback failed because the old key no longer matched after the injected retention failure. See ban-mutants.log, ping-mutant.log and rollback-mutant.log. The installed mutator tool was not run.
11. Ran `nice -n 10 /opt/homebrew/bin/python3.12 -m unittest relay/test/test_keys.py -v`: 17 passed in 73.320 s. Ran `nice -n 10 python3 -m unittest relay/test/test_keys.py -v` on the final source: 17 passed in 71.923 s. See focused312.log and focused-final314.log.
12. Ran `nice -n 10 /opt/homebrew/bin/python3.12 -m unittest relay.test.test_public -v`: six passed in 0.036 s, including the private-word scan. No private file content was printed. See public312.log.
13. Ran `sh -n relay/hornhoof-relay` and `git diff --check`: both exited 0. Checked the three changed files for the prohibited characters: clean. Checked the fixture approval marker after focused tests: absent, repeatedly. Did not apply the proposal or begin full verification.
14. All test commands finished and their Stack contexts closed their owned clients, frps and relay processes. A separate global process inventory using ps was denied by the sandbox, so no independent process-table audit was possible. No process was left intentionally running.

Quality gates:

- CRAP maximum among new/changed functions: not measured. The required gate script has not run because final Done when is blocked by pending fixture approval.
- Dryer pairs at or above 0.8: not measured for the same reason. No gate pass is claimed.

Deviations and limitations:

- Final full suites and gate coverage are deferred exactly as the fixture-scope instruction requires. The known two no-dashboard fixtures still use named setup and will conflict with R1.5 until their exact approved fixture edits are authorized. No production name check was weakened.
- Heartbeat-only hash retention and its SQLite table implement the preparation note's live legacy session requirement, including repeated rotation and relay restart. The plan did not prescribe that storage mechanism.
- The key and visitor response handlers share code, and POST routing was simplified to prevent added duplication/complexity. Existing visitor authorization/storage/lifetime rules are preserved.
- Extra authorization, rollback, rate-limit and dashboard cases go beyond the six named scenarios to pin the lead's additional requirements. Deterministic ownership races use an isolated in-process relay with real HTTP and SQLite; traffic/heartbeat scenarios use real owned Stack processes.
- The three preexisting behaviors passed on the base rather than failing for missing functionality. Isolated faulty copies prove their regressions detect broken behavior. Later supplemental tests were also checked against a reconstructed base; the chronology above records which checks preceded which production changes.
- Every heavy command was wrapped in nice -n 10. The sandbox reported `nice: setpriority: Operation not permitted` while still running the command, so lowering scheduling priority could not be enforced.
- No staging, commit, push, formatter, deployment, SSH, real-company action, wrapper root/systemctl operation, dependency installation, or external service access occurred. Only the three allowed repository files changed. Evidence files and isolated fault copies are under this temporary directory; nothing was written into the ledger folder.
