# Machine check queue implementation plan

**Goal:** Run heavy checks through one machine queue with visible positions and explicit waiting evidence.

**Spec:** Hornhoof tasks #356 and #297; prior measurements in #284.

**Constraints:** Base f289196b, branch task-356. No edits to tests.ts, terminal host/state/programs/signals/transcripts, providers or Dockerfile. No root test suite, run_tests, mutation runs, timeout increases or skipped checks.

**Architecture:** FIFO admission with cancellation and release in finally. One common slot API for remote checks and local command wrappers. Machine identity must span subscription nodes, using their existing host fingerprint. Live authenticated queue evidence suppresses only stalled-program alarms, never missing-node alarms.

## Task 1: Queue and capacity

- [x] Write acceptance tests: capacity overflow waits in FIFO order with visible positions; failure releases and cancellation removes the waiter.
- [x] Observe assertion failures against direct execution, then implement admission.
- [ ] Measure the CPU budget and load before choosing capacity; pin the decision in pure function tests.
- [ ] Check dynamic capacity, pre-aborted input, callback failures and nested commands.
- [ ] Commit the queue API and its tests.

## Task 2: Machine coordination and command entry

- [ ] Confirm required cross-node wiring with the head; isolated volumes cannot share an in-memory queue.
- [ ] Write and observe failing tests for common admission across nodes and command output/exit/cancellation.
- [ ] Integrate the shared coordinator, withCheckSlot and a generic hh-check command without editing neighbour-owned files.
- [ ] Check reconnect, stale requests, nested commands and ownership boundaries.
- [ ] Commit and send the contract to the tests.ts owner.

## Task 3: Waiting evidence and proof

- [ ] Write failing watchdog and operator tests for queue waiting, completed waits and lost heartbeats.
- [ ] Connect typed authenticated queue observations and verify these tests.
- [ ] Run migrations.test.ts and the three prior timeout cases ten times under at least the prior concurrent load; retain loadavg and cleanup evidence.
- [ ] Run targeted dependency tests, affected tsc, typecheck:tests, scoped eslint, crapper and dryer.
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
