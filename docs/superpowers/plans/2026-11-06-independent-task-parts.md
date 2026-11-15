# Independent Task Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require an explicit independent part or a reason for its absence when a task gains dependencies, and start that part without weakening the parent's dependency.

**Architecture:** `independentPart` creates a real child task with no `after`, while the parent retains its real dependencies. The declaration and reason are stored in existing created/updated task events, so no SQL migration or old-row rewrite is needed. Existing task views expose the declaration and linked child.

**Tech Stack:** TypeScript, Drizzle ORM, Zod, React, Vitest, Playwright for the affected task panel if needed.

**Spec:** Hornhoof #569 and narrowed #572; no idle signal work from cancelled #570.

## Global Constraints

- `independentPart:{title,brief,body,executor}` and `independentNone:string` are mutually exclusive and required whenever create/update sets nonempty `after`; both are forbidden with empty `after`.
- Existing tasks with `after` and no declaration remain readable and operational. Updates that do not set `after` do not introduce a retroactive requirement.
- The independent child starts immediately with the same department, product, gates and turn-review mode. The parent keeps its `after` and cannot start early.
- A child closing early must not open turn review while its parent still has an unfinished `after`.
- Every behavior starts with a remotely observed RED. All checks use targeted `run_tests` on exact SHAs; no whole suite, mutator, release, or node update.
- Template guidance belongs to #571. No template edits here.

## Review Focus

- An invalid declaration leaves no parent or child rows: Task 1 validation tests.
- A restricted reader must not learn a hidden independent child or executor: Task 2 visibility tests.
- An early child result must not close the parent or open turn review: Task 1 dependency tests.
- Updating an old task must not silently rewrite its history or duplicate a child: Task 1 update tests.
- Long independent text wraps in the task panel without horizontal overflow: Task 2 web tests.

---

### Task 1: Declaration and Atomic Independent Child

**Files:**
- Create: `apps/server/src/modules/tasks/independent.ts`
- Modify: `apps/server/src/modules/tasks/engine.ts`
- Modify: `apps/server/src/modules/tasks/tools.ts`
- Modify: `apps/server/src/modules/tasks/routes.ts`
- Test: `apps/server/test/tasks-after.test.ts`, `apps/server/test/tasks-routes.test.ts`

**Interfaces:**
- Consumes: existing `createTask`, `updateTask`, `create_task`, `update_task`, and person `POST /api/tasks` flows.
- Produces: optional `independentPart:{title,brief,body,executor}` and `independentNone:string` inputs; exactly one is required when setting nonempty `after`.

- [ ] **Step 1: Write failing tests**

Cover rejection without either field and with both, no writes on rejection, independent child wake and parent waiting, absence reason, old-task compatibility, update validation, same-turn/gate inheritance, no duplicate child, and no premature parent completion or turn review.

- [ ] **Step 2: Verify RED through run_tests**

Run `test/tasks-after.test.ts` and `test/tasks-routes.test.ts`. Expected: declaration/child assertions fail, with existing unaffected tests still running.

- [ ] **Step 3: Implement the declaration and child creation**

Validate before writing. Insert parent and child atomically. Store declaration metadata in the existing created/updated event JSON. The child has `after:[]`; the parent is unchanged otherwise. `workUnderDone` returns without opening review while the parent has `openAfter`. Repeating an update reuses the child. Clearing `after` hides the current declaration from DTO while retaining event history and the historical child.

- [ ] **Step 4: Verify GREEN through run_tests**

Run the same two files. Expected: all selected tests pass.

- [ ] **Step 5: Commit and push**

Commit as the repository's author and no trailers.

### Task 2: Server and Web Visibility

**Files:**
- Modify: `apps/server/src/modules/tasks/views.ts`, `apps/server/src/modules/tasks/sight.ts` if masking requires it
- Modify: `apps/web/src/types.ts`, `apps/web/src/ui/TaskPanel.tsx`
- Modify: `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`
- Test: server task read tests, `apps/web/test/TaskPanel.test.tsx`, affected browser task panel tests

**Interfaces:**
- Produces: `independentPart` on task lines/detail, with declaration, linked child reference/status and executor, or the absence reason. Hidden children and agents remain hidden.

- [ ] **Step 1: Write failing visibility tests**

Assert the declaration appears in agent task reads, person list/detail reads, and the English/Russian task panel. Assert an old task has no synthetic part and a restricted reader gets no hidden metadata. Include long text wrapping.

- [ ] **Step 2: Verify RED through run_tests**

Run the focused server and TaskPanel tests. Expected: missing field/render assertions fail.

- [ ] **Step 3: Implement metadata reads and rendering**

Load the latest declaration event and linked child without per-row rewrites. Mask hidden references. Render one reusable related section with the existing style system and both locales.

- [ ] **Step 4: Verify GREEN and quality checks**

Run affected server/web tests with coverage, both app TypeScript configs and test types, changed-file ESLint, crapper, dryer and diff checks through `run_tests`. Run only the affected browser task panel checks if the final markup needs geometry confirmation.

- [ ] **Step 5: Commit, merge fresh turn-8 and submit**

Verify the merge SHA with affected checks. Report the exact form, why a child task was chosen, all evidence, and production assignment NOT_RUN if not exercised.
