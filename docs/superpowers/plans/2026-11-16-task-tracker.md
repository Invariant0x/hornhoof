# Task tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goals, a responsible person, a why, due dates, status history, time facts and pipelines on top of the existing tasks, a product manager in every department, and a new Tasks screen (List, Board, Graph) that replaces the old board.

**Architecture:** Additive migration `0132_task_tracker` (goals, goal history, pipelines and their stages, six task columns, one company flag for the one-time upgrade). The engine keeps one path: `move()` and the three insert paths learn the new fields; status changes outside `move()` write `fromStatus`/`toStatus` too. A pipeline is data the server reads when the task's holder changes; it creates and moves no work. The web screen reads the same task lines with new fields, plus goals and pipelines, and draws three views of them; the card stays `ui/TaskPanel.tsx`.

**Tech Stack:** TypeScript, Fastify, Drizzle on Postgres (PGlite in tests), Zod, MCP tools, React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-task-tracker-design.md` (mockup next to it).

## Global Constraints

- Migration number `0132` (highest seen: `0131` on origin/task-1079 and origin/task-1114; `0130` on origin/task-1075). Journal idx 130, tag `0132_task_tracker`, snapshot `0132_snapshot.json`.
- `goals.title` up to 120, `goals.why` up to 300; `tasks.why` up to 300; `pipelines.name` up to 80, `pipelines.why` up to 300; `pipeline_stages.name` up to 60.
- Goal status: `active`, `reached`, `dropped`. Task statuses unchanged.
- Product manager roles: `OPS-PM`, `DEV-PM`, `MKT-PM`, `SAL-PM`, `BIZ-PM`, `DSN-PM`, `SUP-PM`, `FIN-PM`, `HOM-PM`, `HHD-PM`; title en "Product manager", ru "Продакт-менеджер"; `kind: member`, `tier: fast`, `default: true`; body at most 180 characters; one shared skill `hh-keep-tracker`.
- No em dashes anywhere; Russian with "е", never "ё"; code, comments, commits in English; every string in `en.ts` and `ru.ts`.
- Web: style book tokens and existing classes only; new layout rules go into `docs/style-book.md` as PROPOSAL; 44 px touch targets; status always in words; no ellipsis or clipping; nothing scrolls sideways at phone width; logical CSS properties.
- Commits by Ivan Korol, `-s`, no co-author lines; push to `origin task-tracker` only.

## Review Focus

1. A goal set as its own ancestor through an edit two levels down: refused, the tree unchanged. Test in Task 2.
2. A responsible person who is disabled while holding goals and open tasks in two departments: each passes to that department's decision owner with one history line each, closed tasks untouched. Test in Task 4.
3. A pipeline edited while tasks stand on a stage it removes: those tasks fall back to "Not started" (no stage), never point at a missing stage. Test in Task 5.
4. A task whose new holder holds no stage role (a checker from another department): stays on its stage. Test in Task 5.
5. A product manager calling `tidy_task` on a task of another department, or with `responsible` naming a person who is neither the department's owner nor already on the goal: refused with words. Test in Task 7.

---

### Task 1: Migration 0132 and schema

**Files:**
- Modify: `apps/server/src/db/schema.ts` (tasks columns, new tables `goals`, `goalEvents`, `pipelines`, `pipelineStages`, `companies.trackerDue`; `TASK_EVENT_KINDS` gains `status`)
- Create: `apps/server/drizzle/0132_task_tracker.sql`, `apps/server/drizzle/meta/0132_snapshot.json`, journal entry
- Test: `apps/server/test/task-tracker-migration.test.ts`

**Interfaces:**
- Produces: `goals` (id, companyId, number, departmentId, parentGoalId, title, why, responsiblePersonId, targetValue, currentValue, unit, dueAt, status, createdByPersonId, createdByAgentId, createdAt, updatedAt, version); `goalEvents` (same shape as `taskEvents` with `goalId`); `pipelines` (id, companyId, departmentId, name, why, position, archivedAt, created by, createdAt, updatedAt, version); `pipelineStages` (id, companyId, pipelineId, parentStageId, name, ownerRole, ownerAgentId, position); `tasks.goalId|responsiblePersonId|why|dueAt|pipelineId|pipelineStageId`; `companies.trackerDue boolean` (true for companies that existed before the migration).

- [ ] Write the migration test: on a database migrated to just before `task_tracker`, insert a company and an open task, migrate, then assert the task row has the new columns null or empty, the company has `tracker_due = true`, a new company gets `false`, a goal whose parent is itself is refused by `goals_not_own_parent`, a stage with both or neither owner is refused by `pipeline_stages_one_owner`.
- [ ] Run it: fails (no migration).
- [ ] Add the schema, run `npx drizzle-kit generate --name task_tracker` in `apps/server`, rename to `0132_*`, add `UPDATE companies SET tracker_due = true;` at the end.
- [ ] Run the test and `migrations.test.ts`, `migration-metadata.test.ts`, `migration-history.test.ts`: pass.
- [ ] Commit.

### Task 2: Goals: store, progress, history, routes

**Files:**
- Create: `apps/server/src/modules/tracker/goals.ts` (rules and writes), `apps/server/src/modules/tracker/routes.ts` (goals and pipelines routes), `apps/server/src/modules/tracker/history.ts` (one history writer for goals, shared actor columns with tasks)
- Modify: `apps/server/src/app.ts` (register routes), `apps/server/src/modules/events/bus.ts` (`{ type: 'tracker'; spot }`)
- Test: `apps/server/test/tracker-goals.test.ts`

**Interfaces:**
- Produces: `goalProgress(goal, goals, tasks): number | null` (0..1; number target first, else done / (open + done) of top-level tasks in its subtree); `createGoal(ctx, actor, input)`, `editGoal(ctx, actor, id, change & { version })`, `setGoalStatus(ctx, actor, id, status, version)`; `goalViews(ctx, companyId): GoalView[]` with `{ id, number, title, why, department, parentId, responsible, targetValue, currentValue, unit, dueAt, status, progress, done, total, version }`; routes `GET /api/goals`, `POST /api/goals`, `PATCH /api/goals/:id`, `PUT /api/goals/:id/status`, `GET /api/goals/:id` (with history `log: LogLine[]`).
- Rights: company goal: `me.isOwner || me.isCeoDelegate`; department goal: `canReach(access, { departmentId })`. Agents through Task 7.

- [ ] Tests: a three-level tree with progress from a number target (212 of 500 → 0.424) and from tasks (2 done of 3 open and done, one cancelled not counted); a loop through a grandchild refused (Review Focus 1); a department goal under a company goal allowed, a company goal under a department goal refused; a person without the department refused 403; stale `version` refused 409; every write adds a goal history line and publishes `tracker`.
- [ ] Watch them fail, implement, watch them pass, commit.

### Task 3: Task fields, status history, time facts

**Files:**
- Create: `apps/server/src/modules/tasks/time-facts.ts`, `apps/server/src/modules/tracker/responsible.ts`
- Modify: `apps/server/src/modules/tasks/engine.ts` (`move`, `insertNewTask`, `insertIndependent`, `cancel`, `answer`, `startWork`, `NOT_A_MOVE`), `apps/server/src/modules/tasks/turns.ts` (`insertGiven`), `apps/server/src/modules/tasks/views.ts` (`TaskLine`, `TaskDetail`), `apps/server/src/modules/tasks/sight.ts` (mask new fields)
- Test: `apps/server/test/tracker-status-history.test.ts`, `apps/server/test/tracker-responsible.test.ts`

**Interfaces:**
- Produces: `responsibleFor(db, companyId, { explicit?, parentId?, goalId?, spot }): Promise<string>` (explicit, else parent's, else goal's, else `decisionPerson` with `{ source: 'request', kind: 'question', topic: 'task', spot }`); `timeFacts(db, tasks): Promise<Map<string, TimeFacts>>` with `TimeFacts = { inStatusSince: string; workSeconds: number; waitsOn: { who: { kind: 'person' | 'agent'; id: string; name: string } | null; since: string }[] }`.
- `TaskLine` gains `goal: { id; number; title } | null` (a subtask shows its top task's goal), `responsible: { id; name } | null`, `why`, `dueAt`, `pipeline: { id; name } | null`, `stage: { id; name } | null`, `time: TimeFacts`. `TaskDetail` gains `neededFor: AfterView[]` and `goalPath: { id; number; title }[]`.
- `NewTask` gains `goalId?`, `responsiblePersonId?`, `why?`, `dueAt?`, `pipelineId?`, `pipelineStageId?`.

- [ ] Tests: `move()` to blocked writes `{ fromStatus: 'open', toStatus: 'blocked' }`; `startWork` writes a `status` event open to working; an answer that takes a task out of waiting carries both; a cascading cancel writes them on every child; a new task's `created` event says `toStatus: 'open'`; `inStatusSince` from the last such event, else the last event; `workSeconds` sums two finished jobs and one running (fake clock); `waitsOn` names the person and since when for an open person wait. Responsible: explicit, parent, goal, decision owner (named owner of the department, else the one person whose access lists it, else the CEO), stored at creation for all three insert paths.
- [ ] Watch fail, implement, pass, commit.

### Task 4: Responsibility passes on; one-time upgrade

**Files:**
- Create: `apps/server/src/modules/tracker/upgrade.ts`
- Modify: `apps/server/src/modules/people/routes.ts` (after a status or access change, and in `disablePerson`), `apps/server/src/app.ts` (run the upgrade when the app leads, beside `startOperationsCheck`)
- Test: `apps/server/test/tracker-upgrade.test.ts`

**Interfaces:**
- Produces: `passResponsibility(ctx, companyId): Promise<void>` (open tasks and active goals whose person is disabled or no longer reaches the place go to the decision owner, one history line each, `fields: ['responsible']`); `upgradeCompany(ctx, companyId)`: under the company lock, only while `trackerDue`: fills open tasks by `responsibleFor`, hires one product manager into each top-level department whose template has a `*-PM` role and has none, clears `trackerDue`.

- [ ] Tests: Review Focus 2; upgrade fills open tasks (parent rule first, closed tasks stay empty), hires one product manager per top-level department with none, keeps one already there, and running it twice hires nobody twice; a department made from no template gets none.
- [ ] Watch fail, implement, pass, commit.

### Task 5: Pipelines

**Files:**
- Create: `apps/server/src/modules/tracker/pipelines.ts`
- Modify: `apps/server/src/modules/tracker/routes.ts`, `apps/server/src/modules/tasks/engine.ts` (`move`: stage follows a new holder)
- Test: `apps/server/test/tracker-pipelines.test.ts`

**Interfaces:**
- Produces: `StageInput = { key: string; id?: string; parent: string | null; name: string; ownerRole?: string; ownerAgentId?: string }`; `savePipeline(ctx, actor, { departmentId, name, why, stages }, id?, version?)`; `archivePipeline`; `stageFor(tx, pipelineId, holderAgentId): Promise<string | null>` (first stage in tree order, depth first by `position`, whose `ownerAgentId` is the holder or whose `ownerRole` the holder's `roleKey` is); `boardColumns(stages, tasks)` lives on the web (Task 9). Routes `GET /api/pipelines?department=`, `POST /api/pipelines`, `PATCH /api/pipelines/:id`, `POST /api/pipelines/:id/archive`.

- [ ] Tests: a fork tree saved and read back in tree order; Review Focus 3; a task joins a pipeline by PATCH with executor, subtasks and route unchanged; a holder change moves it to the first stage of the new holder's role; Review Focus 4; a stage owner of another department refused; a person without the department refused.
- [ ] Watch fail, implement, pass, commit.

### Task 6: People's task routes: create, PATCH, after

**Files:**
- Modify: `apps/server/src/modules/tasks/routes.ts`, `apps/server/src/modules/tasks/engine.ts` (`setAfter` for people, reusing the engine's after checks)
- Test: `apps/server/test/tracker-task-routes.test.ts`

**Interfaces:**
- Produces: `POST /api/tasks` takes `goal`, `responsible`, `why`, `due`, `parent` (a subtask goes to the head of its parent's department), `pipeline`, `stage`; `PATCH /api/tasks/:id` with `version` and `title`, `brief`, `why`, `goal`, `responsible`, `due`, `pipeline`, `stage`; `PUT /api/tasks/:id/after` `{ after: number[], version }`; `GET /api/tasks?responsible=<person>` filter. `editTask(ctx, actor, taskId, change)` in engine (one `move` with `kind: 'updated'`, `fields`).

- [ ] Tests: allowed by `actsOnTask`, refused to another (403) and on a stale version (409); executor, status, parent and route not accepted (400 strict body); responsible must reach the place; goal of the company; pipeline of the task's department; after through the engine's circle check.
- [ ] Watch fail, implement, pass, commit.

### Task 7: Agent tools

**Files:**
- Modify: `apps/server/src/modules/tasks/tools.ts` (create_task, add_tasks, update_task take `goal`, `responsible`, `why`, `due`, `pipeline`, `stage`), `apps/server/src/modules/templates/load.ts` (`GRANTS` gains `tracker`), `apps/server/src/modules/tools/mcp.ts`
- Create: `apps/server/src/modules/tracker/tools.ts` (`goals`, `set_goal`, `set_pipeline`, `tidy_task`)
- Test: `apps/server/test/tracker-tools.test.ts`

**Interfaces:**
- `goals` for everyone; `set_goal` and `set_pipeline` for heads, the orchestrator and holders of the `tracker` grant, within their department (any for the orchestrator); `tidy_task` only with the `tracker` grant: `title`, `brief`, `why`, `goal`, `pipeline`, `stage`, `responsible` (the department's decision owner or a person already responsible on the goal), own department only.
- Product manager nudge: `nudgeProductManagers(db, departmentId)` sets the timer of the department's `tracker` holders due no sooner than 15 minutes after their last round; called when a task or goal of the department is created or changes status.

- [ ] Tests: Review Focus 5; `tidy_task` refuses executor, status, urgency, waits (the tool has no such inputs: strict schema); a head's `create_task` with `goal` and `why` stores them; the nudge makes a timer due, and twice in a row within 15 minutes keeps one round.
- [ ] Watch fail, implement, pass, commit.

### Task 8: Templates: product manager roles and skill

**Files:**
- Create: `templates/roles/<dept>/<CODE>-PM.md` (10), `templates/skills/hh-keep-tracker.md`
- Modify: `templates/SOURCES.md`, `packages/protocol/src/index.ts` (`COMPANY_TEMPLATES` staff), tests that count rosters (`templates.test.ts`, `operations-required*.test.ts`, `setup*.test.ts`, web `StaffCard.test.tsx` as needed), `.hornhoof/test-environment.json` templates impact rule if a new test reads `templates/`
- Test: `apps/server/test/templates-tracker.test.ts`

- [ ] Tests: every department template has exactly one `*-PM` role with the fixed titles, fast, default, member, a timer of 240 minutes, the skill on; the skill grants `tracker`, has en and ru, no em dash, no "ё", within the skill size limit, listed in SOURCES; every company template hires one per department.
- [ ] Watch fail, write the texts, pass, commit.

### Task 9: Web data and pure logic

**Files:**
- Create: `apps/web/src/tracker.ts` (filters, list groups, board columns, graph tree and layout, My tasks, View as), `apps/web/test/tracker.test.ts`
- Modify: `apps/web/src/types.ts`, `apps/web/src/tasks.ts` (`useGoals`, `usePipelines`, `useGoal`), `apps/web/src/routes.ts` (`tasks` route gains `goal`, `department`, `view` query)

**Interfaces:**
- `listGroups(tasks, asksYou)`, `boardColumns(tasks, pipeline | null)` (status columns Not started, In work, Review, Waits, Done; or a pipeline's stages in tree order plus Not started and Done), `graphTree(root, goals, tasks)`, `layoutTree(tree)` (x by depth, y by leaves, as the mockup), `mine(tasks, goals, personId)`, `filterTasks(tasks, chips)`.

- [ ] Unit tests for each, failing first; implement; commit.

### Task 10: Web screen

**Files:**
- Rewrite: `apps/web/src/screens/Tasks.tsx`
- Create: `apps/web/src/ui/TrackerSide.tsx`, `apps/web/src/ui/TrackerList.tsx`, `apps/web/src/ui/TrackerBoard.tsx`, `apps/web/src/ui/TrackerGraph.tsx`, `apps/web/src/ui/GoalPanel.tsx`
- Modify: `apps/web/src/ui/TaskPanel.tsx` (path, kind, why, facts, time, Graph from here, links both ways, materials, history words for status, edit form), `apps/web/src/screens/Shell.tsx`, `apps/web/src/screens/Department.tsx` (drawer opens the tracker for the department), `apps/web/src/theme.css`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`, `docs/style-book.md` (PROPOSAL: left panel, board, graph)
- Test: `apps/web/test/Tasks.test.tsx`, `apps/web/test/TaskPanel*.test.tsx`, `apps/web/e2e/tasks-board/tasks-board.spec.ts`

- [ ] Component tests first: My tasks and View as filter right, every view opens the same card, a subtask opens its own card, the graph re-roots with a breadcrumb back; then the browser spec: no sideways scroll at 375 px, both themes, en and ru, graph pans and zooms with the map's zoom bar.
- [ ] Implement with existing tokens and classes; new rules as PROPOSAL in the style book.
- [ ] Commit.

### Task 11: Deletions and review

- [ ] Delete what nothing uses: summary tiles, the active and department views and their helpers in `task-board.ts`, `ui/TaskBoard.tsx` pieces not used by the kept turns view, the drawer's own task list, `lastGate`, unused i18n keys, CSS classes and exports (`npm run check:unused` style search with `grep` over `apps/web/src`).
- [ ] Guide: `guide/tasks-and-turns.md` describes the tracker; release notes en and ru for the orchestrator.
- [ ] Review the whole branch diff against AGENTS.md; fix findings; type checks, the touched test files, `typecheck:tests`, `test:release`, the browser spec.
