# Machine check queue implementation plan

**Goal:** Run heavy checks through one machine queue with visible positions and explicit waiting evidence.

**Spec:** Hornhoof tasks #356 and #297; prior measurements in #284.

**Constraints:** Base f289196b, branch task-356. No edits to tests.ts, terminal host/state/programs/signals/transcripts, providers or Dockerfile. No root test suite, run_tests, mutation runs, timeout increases or skipped checks.

**Architecture:** FIFO admission with cancellation and release in finally. One common slot API for remote checks and local command wrappers. Machine identity must span subscription nodes, using their existing host fingerprint. Live authenticated queue evidence suppresses only stalled-program alarms, never missing-node alarms.

## Task 1: Queue and capacity

- [x] Write acceptance tests: capacity overflow waits in FIFO order with visible positions; failure releases and cancellation removes the waiter.
- [x] Observe assertion failures against direct execution, then implement admission.
- [x] Measure the CPU budget and load before choosing capacity; pin the decision in pure function tests.
- [x] Check dynamic capacity, pre-aborted input, callback failures and nested commands.
- [x] Commit the queue API and its tests.

## Task 2: Machine coordination and command entry

- [x] Confirm required cross-node wiring with the head; isolated volumes cannot share an in-memory queue.
- [x] Write and observe failing tests for common admission across nodes and command output/exit/cancellation.
- [x] Integrate the shared coordinator, withCheckSlot and a generic hh-check command without editing neighbour-owned files.
- [x] Check reconnect, stale requests, nested commands and ownership boundaries.
- [x] Commit and send the contract to the tests.ts owner.

## Task 3: Waiting evidence and proof

- [x] Write failing watchdog and operator tests for queue waiting, completed waits and lost heartbeats.
- [x] Connect typed authenticated queue observations and verify these tests.
- [x] Run migrations.test.ts and the three prior timeout cases ten times under at least the prior concurrent load; retain loadavg and cleanup evidence.
- [x] Run targeted dependency tests, affected tsc, typecheck:tests, scoped eslint, crapper and dryer.
- [ ] Review the final diff independently, commit, push task-356, submit evidence to the head.

## Review focus

- Queue limits remain common across projects, subscriptions and local/remote command paths.
- Cancelled or crashed commands do not leak capacity or suppress alarms forever.
- A disconnected node cannot start unchecked work or hide a missing-node alarm.
- Position callbacks cannot corrupt the queue or leak other agents' command text.
- Nested build/test runners cannot deadlock by acquiring their own slot twice.

## Ledger

- npm ci completed: 407 packages, 15 existing moderate audit findings; dependencies unchanged.
- Initial baseline before protocol build failed during Vite startup; after protocol build, 57/57 targeted tests pass in 75.04 s.
- queue-red.log: expected ['a'], received ['a','b','c']; cancelled waiter ran.
- queue-green.log: 2/2 acceptance tests pass. No application integration claimed yet.
- Native worktree creation failed outside the repository; manual task-356 worktree created at the required base.
- CONTRIBUTING sign-off conflicts with the task; commit without trailers.
- Queue now has six direct tests: capacity changes, already-cancelled checks, failing position output and nested slot reuse. Nested call first timed out at 20000 ms, then passed with an active AsyncLocalStorage context.
- Increment checks: node tsc and scoped eslint exit 0; crapper maximum CC 6; dryer no duplicate candidates. Final whole-task checks remain pending.
- Capacity probe on CPUs1-9 with 32 bounded background CPU0 processes: one selected run passed in 12.59 s; two concurrent selected runs passed in 26.07/26.66 s; four concurrent runs failed, including the original fresh migration 20000 ms timeout. CPU/memory pressure must be separated before claiming a safe general budget. Raw files are in /tmp/task-356-evidence.
- Pending head decision: coordinate subscription nodes by host in server/modules/check-queue and wire node/main, terminal/bridge and server/nodes/messages. Existing isolated Docker volumes make a node-local pool insufficient for the physical-machine goal.
- Teammate #354 requires exact signal.reason cancellation and holding an active slot until run settles, including process-group shutdown. Three tests pin this; the grant-to-callback cancellation race failed first and now passes. Final increment checks: 9/9 tests, node tsc/eslint exit 0, CC at most 6, no duplicate candidates.
- #354 does not own slot integration. Head was asked to name its owner and settle the conflicting boundaries: architect #280 requests checkout/cache/services inside the slot, #354 proposes command-only. Proposed accounting: acquire before tests.started, then start the execution deadline.
- The contended CPU0 probe reached its 300 s outer bound, then cleaned all 32 synthetic processes (before-cleanup.json). The surviving Vitest child finished after cleanup: one original wait-target timeout, two migration cases passed. This is not a successful three-timeout reproduction. Four-way probe on CPUs1-9 separately reproduced original migration timeout failures. No test thresholds changed.
- Started a bounded after experiment using the tested FIFO class, CPU0 background 32 processes, target checks on the same CPUs1-9 as the concurrency probe. Ten full repetitions plus queued competing commands requested, 1400 s overall budget and 1500 s synthetic worker lifetimes. Its result proves the queue core only, not unimplemented cross-node production integration. Logs /tmp/task-356-evidence/after-*; script apps/node/.check-queue-probe/after.mjs is temporary and will be removed.

## Implementation decisions and current evidence

- Head approved the server/node/bridge wiring in the task log at 11:14 UTC. Adapter is in nodes/check-slots.ts; tests.ts and testruns/runs.ts remain untouched.
- Approved execution accounting supersedes the initial absolute-deadline proposal: main.testOne acquires before tests.started and runPart. tests.waiting clears startedAt only for the reporting node's running part; tests.started restores it. The existing LATE_MS logic stays unchanged.
- The owner of testruns/tools.ts confirmed that decorating test_run/work_run handlers does not overlap the neighbour's description changes. queuedRunState preserves the original authorization and adds queuePosition.
- FIFO logic now lives once in protocol.CheckSlotQueue. The node-local prototype class was removed; the product API uses the authenticated server client. Node API callbacks receive a combined cancellation/lease-loss signal. Queue metadata is not owned by a job UID.
- First complete integration checks: node modules 108/108; watchdog/coordinator targeted checks 4/4; CLI output and nonzero exit round trip; authenticated process/current-turn guards; real TERM-ignoring process held its slot until the five-second KILL grace ended.
- Operator and watchdog post-wait tests exposed immediate false alarms after long waits. Their quiet clocks now exclude queue time without changing native program evidence or disabling missing-node alarms.
- Static complexity was compared against f289196b using crapper: no existing function increased; no new function reached CC 10. This is rerun at final validation.
- Five loaded full migration/wait repetitions passed in the first after probe. Repetition six hit that probe's separate 180-second process bound before it produced a test result. It is not counted as a passing repetition. All 32 synthetic workers were terminated and the active child list was empty. A final ten-run experiment on the completed API is still required, with a sufficiently bounded outer run budget and the unchanged 20-second tests.

- Current complete targeted checks: protocol 162/162 (9 files), node 180/180 (8 files), server 136/136 (7 files). Full output in protocol-final.log, node-final.log and server-final.log. Final loaded ten-run proof and independent review remain pending.

## Whole-branch review and fix pass

- The single fresh reviewer inspected f289196b..823e4583, including actual production ownership and process lifecycle dependencies. Four Important findings, no Critical or Minor findings. Docker/PID1 could not be exercised; capacity proof remained pending; unwrapped commands are outside cooperative admission.
- Nested CLI regression with real procOwner failed with exit1, own hook403 and nested wrapper403. Commands started by the bridge are now live process roots scoped to their authenticated agent. Kernel socket ownership is still required; a different agent remains403. Nested wrappers reuse one slot.
- Leader-exit regression failed because an inherited output pipe held the slot. Process-group cleanup now starts on exit, before waiting for close. The test returns the original exit0 and releases the slot with a background child terminated.
- Missing-report regression failed with undefined instead of node_silent. All missing-report alarms now survive waiting and post-wait grace, including when no program state ever arrived.
- A real local fake browser installer ignored lease loss in the RED test. Browser defaultRunner now uses the slot's AsyncLocalStorage signal and retains a five-second cancellation cleanup interval. The test observes TERM promptly, then retains admission through cleanup; no download is needed.
- Ruling: browser.ts cancellation is required to honor the head-approved complete-preparation boundary; change its default runner, leaving protected tests.ts and providers untouched. Cost if wrong: browser preparation needs a separately approved explicit signal parameter instead of ambient context.
- Focused fix checks: CLI/browser27/27; watchdog/program-signs14/14. Full affected checks are rerun after the fix pass.

- The same agent-scoped command roots are recognized by both Linux procOwner and macOS macOwner. macOwner regression failed first; then 16/16 ownership tests passed (command lookup simulated, no live macOS available).
- origin/task-356 readback confirmed 823e458304482abcce41bdc081f4af718b053c2b, and both neighbouring owners received the API contract. This intermediate push is not task completion or integration into turn-8.

- A nested-context check exposed that ambient preparation cancellation still saw the parent signal. RED expected the aborted nested signal but observed an un-aborted parent signal. Nested lease reuse now installs its combined signal in AsyncLocalStorage; all60 related node checks pass.
- Final pre-load regression evidence: server7files137/137; node12files227/227 plus macOS ownership16/16 and last-change related5files60/60. Static checks and final loaded proof are recorded separately.
- Ruling on review exclusions: Docker/PID1 and live macOS cannot be exercised on this Linux/no-Docker machine; retain targeted ownership/process tests and report that limit. Cooperative admission requires hh-check or the slot API; no universal shell interception was requested. Browser cancellation is now checked with a real local installer fixture, not a download. Capacity under final live load remains the outstanding acceptance check.

- Correcting the temporary baseline namespace exposed a real test-helper CC regression: fakeServer3->5. The check-reply branch was extracted into grantCheck; the original helper must return to3 before completion. Commit952bd0a3 is an intermediate fix commit, not a completed gate.

- Final static verification completed after the helper extraction: affected builds, typecheck:tests, scoped eslint all exit0; corrected crapper comparison has increases=[] and newOverLimit=[] (fakeServer3->3, unchanged opened16->16); dryer no duplicate candidates; git diff --check empty. main.test.ts57/57 on the final helper. All source changes are frozen for the loaded proof.

## Final acceptance evidence

- Fixed source6b8e1100: final-probe.mjs completed PASS10 repetitions; maxActive1. Each repeat log has3files57/57, no failed/skipped target tests. Thirty competing selected three-case runs also exit0. loadavg34.17-44.20, positions3->2->1, same32 boundedCPU0 background workers and check CPUs1-9 as calibration. No test timeout changed.
- final-load/cleanup.json:32workers terminated, active=[],allExited=true. Process-table readback found none of these32PIDs. final-readback.json records the checks. The driver completed13:26:50UTC, including cleanup by13:26:55UTC.
- All changed-function CC values are no higher than the task base or origin/main; all new functions are below10. Raw main comparison reports dispatchAlarm5->6, inherited unchanged from task base(CC6). Its function text is byte-identical to f289196b, proven in complexity-main.json. It is outside this task's diff and has not been refactored to hide the existing difference.
- Source is frozen at6b8e1100; the final commit adds only documentation of these results. Final branch publication and task submission are the remaining handoff actions.
