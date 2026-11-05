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
