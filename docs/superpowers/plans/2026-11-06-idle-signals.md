# Idle Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the department head or orchestrator when enabled employees remain free while work waits, and raise a watchdog alarm for sustained low occupancy.

**Architecture:** A pure module classifies employees and evaluates a stable idle episode from a snapshot. The existing minute round supplies task/work facts, persists episode and signal metadata in internal agent events, and uses the existing conversation queue for delivery. No SQL migration or protocol change is planned.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, existing Hornhoof task and conversation modules.

**Spec:** Hornhoof tasks #569 and #570, items 1 and 2 only.

## Global Constraints

- RED before every behavioral increment; all checks run through targeted `run_tests` on an exact pushed SHA.
- Switched-off employees never count as free. Waiting for a run or neighbor is free only when no actionable work remains.
- More than two free employees for 10 minutes signals once; a repeat requires the recipient to finish reacting while the same episode continues.
- Busy ratio below 0.25 for 15 minutes alarms the head. The ratio is a starting guardrail, not a measured optimum.
- No work or no enabled employees means no signal or alarm. No SQL migration, release, node update, whole-suite run, or mutator.
- `schema.ts` stays unchanged until A and Head explicitly include `idle_state` and `idle_signal`; no substitute event kind or storage workaround.

## Review Focus

- A waiting employee with another actionable task is not free: Task 1 mixed-status test.
- Disabled employees or an empty department cannot produce a signal: Task 1 empty-input tests.
- A changed free set, task set, or occupied set starts a new episode: Task 1 identity tests.
- A completed recipient turn permits one repeat, not a per-minute stream: Task 2 reaction and dedup tests.
- Restart recovery preserves the episode and pending signal dedup: Task 2 persisted-event reload tests.

---

### Task 1: Pure Idle Definition and Episode Evaluation

**Files:**
- Create: `apps/server/src/modules/tasks/idle.ts`
- Create: `apps/server/test/idle.test.ts`
- Create: `docs/superpowers/plans/2026-11-06-idle-signals.md`

**Interfaces:**
- Produces: `IDLE_SETTINGS` with 10 minutes, 15 minutes, minimum three free employees and busy ratio 0.25.
- Produces: `isFree({ enabled, hasTurn, actionable })`, true only for an enabled employee with neither a current turn nor actionable work.
- Produces: `evaluateIdle(previous, snapshot)`, returning a stable episode key/since and due `signal`/`watchdog` notifications.

- [ ] **Step 1: Write failing pure tests**

Cover five free employees and three waiting tasks, waiting versus actionable work, disabled employees, no work, below-threshold time, episode identity changes, the 10-minute signal, and the 15-minute watchdog alarm.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npm ci && npm run build -w @hornhoof/protocol && npm test -w apps/server -- test/idle.test.ts`.
Expected: assertion failures against the explicitly unimplemented scaffold, not setup errors.

- [ ] **Step 3: Implement the pure module**

Use sorted employee/task identifiers for the episode identity. Reset the episode when no signal or watchdog condition applies. Keep the original `since` only while the identity is unchanged.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run the same command. Expected: all `idle.test.ts` tests pass.

- [ ] **Step 5: Commit and push the pure increment**

Commit the tests, pure module and this plan with Ivan Korol as author and no trailers.

### Task 2: Minute-Round Delivery and Persistent Dedup

**Files:**
- Modify: `apps/server/src/modules/agents/work.ts`
- Modify: `apps/server/src/modules/agents/timers.ts`
- Modify: `apps/server/src/modules/tasks/idle.ts`
- Modify: `apps/server/src/db/schema.ts` only after A/Head inclusion
- Test: `apps/server/test/idle.test.ts`

**Interfaces:**
- Consumes: existing `agentWork` open-task facts and existing `enqueueTurn`, `liveSubscription`, and job status data.
- Produces: `checkIdleDepartments(ctx, now)` for `minuteRound`, with typed internal `idle_state` and `idle_signal` payloads containing department, episode and signal job identifiers.

- [ ] **Step 1: Write failing integration tests**

Build a company with enabled employees and waiting tasks. Assert recipient choice, free employee and task lists, orchestrator fallback when the head has a turn, no disabled/empty-work signal, no repeat while a signal is queued/running, one repeat after it finishes, 15-minute watchdog delivery, and episode/dedup recovery from persisted events after clearing in-memory state.

- [ ] **Step 2: Run integration tests to verify RED**

Run the focused test through `run_tests` on the pushed test-first SHA. Expected: missing behavior assertions, not import or setup failures.

- [ ] **Step 3: Implement the integration after schema inclusion**

Expose existing `choices(...).next` as actionable work from `agentWork`. Persist only episode changes and emitted signal metadata. Deliver through the existing queue and classify a queued/running recipient turn as unreacted.

- [ ] **Step 4: Run integration and existing timer/work tests to verify GREEN**

Run `test/idle.test.ts`, `test/timers.test.ts`, and `test/watch-tools.test.ts` with coverage on the exact integration SHA. Expected: all selected tests pass.

- [ ] **Step 5: Run quality checks and commit**

Run server TypeScript, test TypeScript, changed-file ESLint, crapper using the completed coverage, dryer and `git diff --check` through `run_tests`. Then commit and push.

### Task 3: Integration and Handoff

**Files:**
- Merge only after Task 2 checks pass.

- [ ] **Step 1: Merge fresh turn-8**

Resolve only actual conflicts, preserve concurrent engine/tools work, and verify the final diff against the reviewed requirements.

- [ ] **Step 2: Verify the final merge SHA**

Rerun the affected tests and quality checks on the merge SHA through `run_tests`.

- [ ] **Step 3: Submit with limits and evidence**

Report exact commits, commands and outcomes. Mark real agent assignment on the production server as NOT_RUN if it was not exercised. Item 3 of #569 belongs to #572 and is not claimed here.
