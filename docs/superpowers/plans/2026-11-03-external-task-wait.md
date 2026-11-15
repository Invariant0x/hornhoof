# External Task Wait Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan inline, task by task. The department reviews the complete turn, as tasks #157 and #158 require.

**Goal:** A task holder can wait for an external event for up to two hours without false reminders, then continue once after a message or the deadline.

**Architecture:** Keep a nullable external wait on the task, separate from its workflow status. Use task moves and the existing durable wake outbox for atomic expiry, and validate queued wakes with the policy from #143. The existing tree and card consumer from #148 receives the same ISO object.

**Tech Stack:** TypeScript, Drizzle/Postgres, Zod, MCP, React, Vitest/PGlite, Playwright.

**Spec:** Hornhoof tasks #157 and #158, plus the head's clarification: a comment, a task-bound employee or orchestrator message, or an answer to ask_person ends the wait; an unbound message does not.

## Global Constraints

- Work on task-158 from fresh origin/turn-5, never merge to main.
- Migration 0050, journal idx 50, after 0048 (#149) and 0049 (#148). Preserve strictly increasing idx/when and the snapshot chain.
- externalWait?: { reason: string; since: string; until: string } | null; dates are canonical ISO strings.
- English code, comments and commits. EN/RU UI, light/dark, phone layout. No em dashes; Russian uses е.
- TDD; only changed-area tests and package type checks. New functions CRAP <10, existing CC does not grow against main. Mutate changed source lines; dryer threshold 0.8.
- The repository's author, no trailers. Submit before integrating fresh turn-5, submit again after integration.

## Review Focus

- A caller names another holder's, an unseen, planned or closed task: no state or wake is changed (Task 1).
- A deadline is invalid, past, multiline, or more than two hours away: refuse; accept the exact upper boundary and normalize date offsets (Task 1).
- Restart or repeated ticks after the deadline: one durable wake; closing, transferring or waiting again cannot dispatch old work (Task 2).
- A message names a different task or no task: retain unrelated waits; task-bound employee/orchestrator messages and person answers end only their task's wait (Task 2).
- A long reason, translated copy and a small viewport: calm waiting state, readable text without sideways scrolling in both themes (Task 3).

## Task 1: Persistent wait and agent tool

**Files:** schema.ts; tasks/external-wait.ts; tasks/engine.ts; tasks/tools.ts; drizzle/0050_external_wait.sql and metadata; test/external-wait.test.ts; test/tasks-tools.test.ts; test/migrations.test.ts.

**Interfaces:** Export ExternalWait from schema; tasks.externalWait is nullable. Export waitFor(ctx, agentId, taskId, {reason, until}, now?) returning Moved. MCP wait_for accepts task reference, reason, until. All task tool roles receive it.

- [x] Write public MCP tests for storing the wait, owner/visibility/closed guards, one-line reason, deadline bounds, and task reads exposing it. Run and observe missing-tool failures.
- [x] Write fresh and upgrade migration assertions for a null default, preserved existing task data, and the deadline index. Run and observe missing-column failures.
- [x] Add the nullable JSON field and deadline index; generate with drizzle-kit, rename to the reserved 0050, and keep the journal/snapshots coherent.
- [x] Implement waitFor with the existing atomic task move and silent reset. Task workflow changes end the previous wait.
- [x] Register wait_for, update the tool inventory test, run the focused tests and server tsc, and commit this increment.

## Task 2: Quiet waiting, durable expiry and early messages

**Files:** schema.ts and unshipped0050 metadata; tasks/external-wait.ts; tasks/engine.ts; tasks/wake.ts; tasks/wake-state.ts; tasks/outbox.ts; tasks/silent.ts; agents/timers.ts; conversation/queue.ts and routes.ts; tools/watch.ts; tools/control.ts; test/external-wait.test.ts and relevant existing tests.

**Interfaces:** checkExternalWaits(ctx, now?) returns the number expired and queues through the wake outbox. queueTaskMessage(ctx, {companyId, agentId, task?, actor, text}, turn) stores a bound message on the agent line before clearing its wait; unbound messages keep ordinary live delivery. waitFor uses the same line and refuses to hide an unread queued task message. Optional task in employee and orchestrator messages is a task reference. New wait_ended wake carries the reason and expected task version and produces one sentence identifying the task; pending_wakes.task_version persists that version. Messages retain their recipient/stage across status-only changes.

- [x] Write tests: three silent turns cause zero reminders/requests; reconcile and program alarms preserve the wait. Run RED.
- [x] Suppress liveness, reconciliation and program alarms while the persisted wait exists. Guard silentTurn as well. Run GREEN.
- [x] Write tests for expiry once across repeated ticks/restart, exact reason text, ordinary liveness after expiry, and queued expiry discarded after close/transfer/new wait. Run RED.
- [x] Expire through versioned task moves and durable wakes; run on startup and the minute sweep. Prevent action wakes while a task waits. Run GREEN.
- [x] Write tests for comments, employee messages with task, orchestrator messages with task, person answers, and unbound/unrelated messages. Run RED.
- [x] Add message binding and the optional parameter to both message tools, clear only the named task's wait, and preserve normal message delivery. Run GREEN.
- [x] Run changed queue, message, liveness and timer tests plus server tsc; commit the increment.

## Task 3: Task views, tree facts, template and user evidence

**Files:** tasks/views.ts; tasks/tree-facts.ts and tree.ts as needed after #148; templates/skills/hh-lead-tasks.md; test/templates.test.ts; task/tree route tests; UI tests only where integration requires changes.

**Interfaces:** TaskLine/TaskDetail and FactTask expose externalWait with reason/since/until ISO; the tree and card consumer are owned by #148.

- [ ] Write route/facts tests showing the active wait and its removal, and a template test naming wait_for for external events. Run RED.
- [ ] Populate the shared object in task views and tree facts; add the neutral English rule to hh-lead-tasks. Preserve #148 UI/types and existing template changes when merging fresh turn-5. Run GREEN.
- [ ] Run the product locally on generated test data. Exercise wait_for, task-bound early message, expiry and task close through public surfaces. Keep logs and check console/requests.
- [ ] Capture task card EN/RU in light/dark and a phone viewport with a long reason. Attach the four required screenshots with hh-attach --task 158.
- [ ] Run final scoped tests, migration fresh/upgrade, tsc for changed packages, available lint, crapper, dryer and changed-line mutator. Verify live agents' tool discovery from the actual server/provider code and report whether a new turn or restart is needed.
- [ ] Commit, push task-158, submit evidence. Merge fresh turn-5, repair the 0048/0049/0050 snapshot chain without rewriting shipped migrations, recheck integration, push turn-5, submit again.
