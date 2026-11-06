# Author Check on Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When explicitly enabled, submit runs the repository's author check remotely on the exact submission commit and uses its trusted result to continue or return the task.

**Architecture:** A task-side coordinator captures the existing review, delegates execution to the existing test run pool and stores the pending submission in the task log. The existing run completion path parses the command's structured output, calls `recordAuthorCheck`, then resumes the existing submit or returns the task to its author or head. No new runner, quality record format or database migration is needed.

**Tech Stack:** TypeScript, Drizzle ORM, Zod, Vitest, existing Hornhoof task engine and test run pool.

**Spec:** Hornhoof task #590, `docs/author-check-port.md`, `.hornhoof/author-check.md`.

## Global Constraints

- The feature is off by default and current submissions are unchanged until the head enables it.
- Every quality stage runs through one `run_tests` command on the pinned submission SHA. The server never runs lint, types, tests, coverage, CRAP or dryer locally.
- `recordAuthorCheck` remains the only trusted quality producer. A plan is command input, not evidence; the runner validates its digest and commits.
- A repeat or race for the same task and SHA reuses the existing run. No force push, main change, full root suite, mutator or template edits.
- `passed` and nonfailed `partial` may continue; unavailable stages and numbers stay visible and are never relabeled as a full pass.

## Review Focus

- A branch moving between review capture and run pinning must reject the stale submission; Task 2 tests the exact SHA comparison.
- A duplicate submit or two submit calls racing must not create a second run; Task 2 tests repeated and concurrent calls.
- Missing or malformed `AUTHOR_CHECK` output must return an honest failure rather than creating a PASS; Task 3 tests it.
- The third failed attempt must go to the head, while the first two return to the author with output; Task 3 tests all three.
- A disabled setting or a submission without adapter input must preserve the old submit behavior and unavailable quality; Task 1 tests both.

---

### Task 1: Opt-in configuration and submission input

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/modules/tasks/review-context.ts`
- Modify: `apps/server/src/modules/tasks/tools.ts`
- Test: `apps/server/test/author-check-submit.test.ts`

**Interfaces:**
- `Config.authorCheck: boolean`, default `false`, enabled by `AUTHOR_CHECK=1`.
- `ReviewSubmission` accepts optional `authorCheckPlan: string`; it is passed only to the remote command.
- `submitWithAuthorCheck(ctx, job, taskId, input): Promise<Moved>` delegates to `submit` when the feature or adapter input is absent.

- [ ] **Step 1: Write the failing tests** for disabled behavior, missing adapter input and config parsing.
- [ ] **Step 2: Run the focused test remotely and confirm RED** because the coordinator and config field do not exist.
- [ ] **Step 3: Implement the config field, optional plan input and delegation boundary.**
- [ ] **Step 4: Run the focused test remotely and confirm GREEN.**
- [ ] **Step 5: Commit the increment.**

### Task 2: Pinned, idempotent remote scheduling

**Files:**
- Create: `apps/server/src/modules/tasks/author-check-submit.ts`
- Modify: `apps/server/src/modules/testruns/runs.ts`
- Modify: `apps/server/src/modules/tasks/engine.ts`
- Test: `apps/server/test/author-check-submit.test.ts`

**Interfaces:**
- The coordinator uses the existing submission validation and `captureReview`.
- The internal `RunInput` supports deduplication under the existing company/run-number transaction lock.
- A pending task event binds `{ runId, summary, evidence, review }`; `externalWait.run` binds the same run.
- The command is `npm run -s check:author -- --sha <sha> --base <base> --plan <shell-quoted plan>` and fits the protocol's 4000-character limit.

- [ ] **Step 1: Write failing tests** that submit creates one pinned remote run, repeat and race reuse it, and a moved branch is rejected.
- [ ] **Step 2: Run them remotely and confirm RED** with no coordinator or deduplication.
- [ ] **Step 3: Implement shared submission validation, exact pin comparison, run deduplication and the pending task event.**
- [ ] **Step 4: Run the focused tests remotely and confirm GREEN** without executing any quality stage locally.
- [ ] **Step 5: Commit the increment.**

### Task 3: Trusted completion and attempt policy

**Files:**
- Create: `apps/server/src/modules/tasks/author-check-completion.ts`
- Modify: `apps/server/src/modules/testruns/runs.ts`
- Modify: `apps/server/src/modules/tasks/engine.ts`
- Test: `apps/server/test/author-check-submit.test.ts`

**Interfaces:**
- The run completion path recognizes the pending run, ends its existing wait and delegates before the generic run notification.
- The completion parser adds server-owned `runId` and `partId`, then calls `recordAuthorCheck`.
- Nonfailed `passed` or `partial` resumes `submit` with the captured review; failed, cancelled or malformed results return output to the author. Attempt three uses the existing blocked-to-head path.

- [ ] **Step 1: Write failing tests** for green continuation, red lint returning output, three failed attempts, malformed output and no duplicate completion.
- [ ] **Step 2: Run them remotely and confirm RED** at the existing completion boundary.
- [ ] **Step 3: Implement structured output parsing, trusted recording, idempotent completion and task transitions.**
- [ ] **Step 4: Run focused server tests remotely and confirm GREEN.**
- [ ] **Step 5: Commit the increment.**

### Task 4: Verification and integration

**Files:**
- Modify only files with findings from the previous tasks.
- Update: `.hornhoof/author-check.md` with the disabled-by-default submit setting and plan flow.

- [ ] **Step 1: Run the affected server tests with coverage, server types, test types, changed-file ESLint, crapper and dryer through `run_tests` on the exact source SHA.**
- [ ] **Step 2: Merge into fresh `origin/turn-8` without force and repeat the affected checks on the merge SHA.**
- [ ] **Step 3: Report exact runs and remaining NOT_RUN items: three real enabled submissions, timing, full root suite and mutator.**
