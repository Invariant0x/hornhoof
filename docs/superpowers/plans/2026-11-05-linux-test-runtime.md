# Linux Test Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove clock waiting and balance long test files without reducing regression coverage.

**Architecture:** Control time only after real I/O milestones; retain actual tmux, HTTP and child hook clients. Extract file-local fixtures and move unchanged registration groups into balanced files. Compare test-name multisets and package totals.

**Tech Stack:** TypeScript, Node 22, Vitest, tmux, bash, PGlite.

**Spec:** `docs/superpowers/specs/2026-11-05-linux-test-runtime.md`

## Global Constraints

- Production behavior remains unchanged.
- Do not skip cases, add retries or increase test timeouts.
- Keep installer stubs in their existing directory, unchanged.
- All exclusions in the spec apply; no mutation tools.
- Full run_tests is allowed only for the two benchmark runs.
- English repository text, no em dashes, Ivan Korol commits without trailers.

## Review Focus

- Virtual time must not outrun real prompt acceptance: wait for running/tool state before observation.
- Cancellation must preserve real Escape delivery before advancing the grace period.
- An old 3000 ms hook deadline must still be caught despite removing wall-clock delays.
- Retried hooks must still finish exactly once after client exit; ownership and HTTP remain real.
- Moving tests must preserve expanded parameterized names, assertions and fixture isolation.

### Task 1: Terminal wait clocks

**Files:** Modify `apps/node/test/terminal-host-waits.test.ts`; create `apps/node/test/terminal-test-clock.ts` if a shared helper is necessary.

**Interfaces:** Consumes existing setUp/host/tmux/sent and Vitest timer APIs. Produces test-only cancellation helper `cancelTurn(stop: AbortController, run: Promise<RunResult>): Promise<RunResult>`.

- [x] Run the existing file, confirming the two Antigravity failures seen in baseline 101.
- [x] Observe reports only after the accepted running state; preserve no-idle, pid/session, tool and screen timestamp assertions.
- [x] Replace Kimi/CUT 6500 ms wall waits with Date jumps beyond the old windows and at least three completed reports; keep explicit pending-result assertions.
- [x] During cancellation fake only setTimeout/clearTimeout, wait for the real Escape command to complete, then advance 5000 ms. Use real timer polling for I/O milestones and restore timers in finally.
- [x] Temporarily force running program reports idle in production host state logic; run the affected lost-end/CUT cases and require assertion failures, restore, then run the file green.
- [x] Commit with the command and result in the report.

### Task 2: Hook deadline clocks

**Files:** Modify `apps/node/test/{hook-delivery,hook-retry-delivery,hook-client,terminal-host-hook-delivery}.test.ts` and `apps/node/test/fakes/hook-clock.cjs`; create `apps/node/test/hook-test-clock.ts`.

**Interfaces:** Consumes real child hooks/Bridge/procFixture. Produces a test-only child clock that registers requested AbortSignal deadlines and advances them over IPC; parent helper waits for acknowledgment and real request milestones.

- [x] Register deadlines at their actual requested durations. Clock advancement expires the signal with TimeoutError; child reports clock acknowledgment over IPC.
- [x] Replace slow ownership sleeps by explicit gates, retaining >3000 ms logical ownership delay in hook-delivery. Verify the caller still owns its connection, one delivered Stop and clean child exit.
- [x] Drive three deadline expiries while ownership is gated; after child exit release checks and assert one completion, next turn untouched and three checks.
- [x] Drive hook-client timeout attempts via the same child clock, preserving disconnected retry/pid/id/body and forbidden-error checks.
- [x] Replace terminal-host list-panes sleeps with a gate and host Date advancement; prove hook deadline behavior independently with the direct client clock. Preserve real hook completion and alive-program assertions.
- [x] Temporarily set production stop deadline to 3000 ms, require hook-delivery RED; temporarily remove retries and require hook-client/retry RED; restore each. Run all four files green, then commit.

### Task 3: Balanced server files

**Files:** Extract `apps/server/test/install-script-helpers.ts`, `test-runs-company.ts`, `decisions-company.ts`. Modify original install-script/test-runs/decisions files. Create install-script-{served,join,browser}, test-runs-{hosts,work,commit,wait}, decisions-answers-{department,ceo,fallback} test files.

**Interfaces:** Installer exports SCRIPT/SERVER/IMAGE/CODE/SUB_A/SUB_B/install/indexOf. Runs exports GIB/idle/company/nextOf/gets/done. Decisions exports company/everyKind/ownersOf/staffed/registerAnswerCases; the last registers unchanged matrix bodies for the supplied kinds.

- [x] Collect original full names using runtime Vitest collection, not static parsing; expect 94/99/58 cases.
- [x] Move installer served group alone; browser tests alone; join/platform/sign-in tests together; retain remaining tests in original. Only served imports server testApp.
- [x] Move test-runs by complete groups into hosts (19), original (19), work/pool (12), commit/freshness (24), waiting (25).
- [x] Move decisions matrix by kind: department devQuestion/salesQuestion (13), ceo devApproval/devPeople (11), fallback devPlain/mktQuestion plus actions (13); retain pure/list/map/stream groups in original (21).
- [x] Compare expanded name multisets and assertion text before/after. Expect exact equality and 251 cases.
- [x] Intentional faults: installer STUB_RUN=fail in locked-down-container condition; wrong commit in done helper; decisionOwner always CEO. Each unchanged assertion must fail; restore, run all changed families green and commit each family separately.

### Task 4: Verification and Linux comparison

**Files:** Create `docs/superpowers/reports/2026-11-05-linux-test-runtime.md`; benchmark command and logs stay in ignored `.metrics/task-378` and task attachments.

**Interfaces:** Consumes baseline run 101 and identical command.sh; produces evidence/report and pushed task-378 commit.

- [x] Run all affected tests with coverage, tsc node/server, typecheck:tests, eslint, crapper --use-existing-coverage and dryer. Require exit 0 for scoped checks.
- [x] Obtain one fresh whole-branch review, resolve important findings using failing tests, commit and push task-378.
- [ ] Run the identical four-part benchmark AFTER through run_tests, set wait_for for 30 minutes and end turn.
- [ ] Read all logs. Report per-part/package/file times and percentage deltas with hardware caveats, exact package counts after >= before, and all unrelated failures without hiding them. Submit evidence and branch SHA.

Execution note after run 103: same command and all package counts verified, full result failed. Twenty-four new timeouts on the changed part-3 worker include one moved case; the full local affected file passed 24/24 diagnostically. The failed remote result remains unmodified. Comparable full-suite validation and submit remain pending a suitable Linux pool/slot or a head decision. The earlier wait_for acknowledgment timed out.


## Controlled continuation

### Task 5: Common integration control and targeted diagnosis

**Files:** Own `apps/node/test/terminal-host-waits.test.ts` on task-378-control; integrate existing upstream fixes without editing protected files. Record provenance in the report.

**Interfaces:** Consumes origin/turn-8 initially 0b4b238ce6a84007974cea919a8e032aa5639081 (includes408/374), plus409 when supplied. Produces pinned control and optimized SHAs, with control an ancestor of optimized and source differences limited to378 optimizations.

- [ ] Pin and record the integration commit and the408/374 provenance. Await409's supplied commit; do not implement its fix.
- [ ] On task-378-control characterize the two existing idle-boundary failures. Apply only accepted-report prefix selection, retaining all no-idle, PID/session, tool/screen assertions and real wait durations. Run the full10-case file green; prove an old-window idle fault still fails.
- [ ] Merge this common control into task-378. Preserve the upstream new queued-run test when integrating the split file. Compare expanded registration names and assertion multisets against the updated control.
- [ ] Read the full24 timeout/cleanup failure records and lifecycle code; no unproven fixes to excluded files. Run departments, migration-metadata, migrations, program-operator-evidence/migration/recovery, program-updates, test-runs-commit, watch-machine-drain, work-tree-route with maxWorkers2 and original limits. Record load/limits alongside diagnostics.
- [ ] Commit/push both branches and record exact control/optimized/fix SHAs, candidate-only paths, config/lock equality and test counts.

### Task 6: One-worker paired driver

**Files:** Task artifact `.metrics/task-378/controlled/paired-driver.mjs` and its Node test fixture; attach the tested files. No production runner changes.

**Interfaces:** Consumes full40-character control/optimized SHAs as explicit arguments and an ancestor check. Produces labeled HH_PAIR environment/resource/stage/timing/result records for control/optimized x logical shards1..4.

- [ ] Write a small fixture-repository acceptance test first: eight fresh worktrees, exact commits, stages, maxWorkers2, logical HH_TEST_PART/PARTS, separate empty npm caches, failures retained, and differing configs rejected. Initially missing driver must fail.
- [ ] Implement async child execution and5-second resource snapshots so sampling continues during tests. Run each logical shard with the same commands as command.sh, including ancillary stages only on logical part1. Keep all checks; report every failed stage and continue the paired comparison unless setup/identity makes it invalid.
- [ ] Filter routine console output into labeled structured timing summaries; retain complete output of failed stages. Never print credentials or full environment. Validate constant identity/limits/config hashes across the pair; preserve all package counts.
- [ ] Run fixture tests green, bash/Node syntax checks where applicable, and get one fresh read-only review of this new measurement driver before a full run. Record limits on page-cache/background-load control.

### Task 7: Authorized paired run and report

**Files:** Existing measurement report and task attachments.

**Interfaces:** Consumes the reviewed driver, two pinned SHAs and completed targeted diagnostics. Produces one parts1 run_tests result with both variants, then a qualified final report.

- [ ] Ensure409 is common to both variants and all required targeted checks have completed at original limits. Push the final branch and attach driver/manifest before launching.
- [ ] Launch one parts1 run_tests job, replaying four logical shards sequentially per SHA. Use wait_for for30minutes and end the turn.
- [ ] Parse variant/part/package/file records and counts, compare load/limits, preserve failures, and label sequential timing correctly. If load is still incomparable, report the exact observed limitation for Operations.
- [ ] Recheck required scoped gates after any source changes, commit/push report and submit with all concerns; do not claim an unmeasured historical turn7 percentage.
