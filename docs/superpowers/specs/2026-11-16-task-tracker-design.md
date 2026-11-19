# Task tracker: design

Date: 2026-11-16. The tracker shows who is responsible for each task.

## 1. Why

A company in Hornhoof already has tasks, subtasks, stages, waits and a history, but people cannot see how they connect. At Northwind two people (Juno and Ellis) shared responsibility for several departments without knowing whose task was whose, tasks were known by numbers ("1103"), and nobody could see which goal a task served, who waits for whom, or how long something has stood still. The CEO wants a tracker like ClickUp (also Jira or Asana): goals, tasks, subtasks, one responsible person, status, result, history, and several views of the same work, in Hornhoof's own look.

Success: a person opens Tasks and at once sees what waits for them and what they are responsible for, by human titles and the goal each one serves; the CEO sees the same screen as Juno or Ellis see it; a department's head and its product manager see every pipeline of the department and where each piece of work stands.

## 2. Goals, non-goals, anti-goals

Goals:

1. Goals as their own thing: a company goal that splits into department goals and smaller goals; tasks belong to a goal.
2. One responsible person per task and per goal, besides the executing agent.
3. Several pipelines per department, each a tree of stages from the head with forks.
4. Three views of the same work: List, Board (the kanban), Graph. Graph is a canvas like the map.
5. A task card where everything about the task lies: why, who, goal, links both ways, subtasks (each opens its own card), materials, history, time.
6. Time: how long a task is in its status, how much work it took, whom it waits for and since when.
7. A product manager agent in every department of every company, who keeps the tracker in plain words.
8. It reaches every new company through the templates, and existing companies through the update.

Non-goals (first version):

- A timeline (Gantt) view, custom saved views ("+ View" in ClickUp), custom fields, story points, sprints. The CEO asked to keep the screen light; due dates and time facts show in the list, on cards and in the card instead.
- People dragging cards between status columns (section 9.3).
- People attaching files to a task (attachments stay under agents, `schema.ts:1334`).
- Translating task texts per viewer. Texts are in the company's working language, as today.
- Joins in pipelines (a stage waiting for two branches). Pipelines are trees.

Anti-goals, which make it a failure even if it works:

- A second model next to an existing one: a second task list, a second card, a third pipeline model, a second status set. The tracker extends what exists and deletes what it replaces (section 13).
- Statuses that lie. A status on the board always comes from the real work of the engine, never from a person moving a card.
- Responsibility that changes rights. Like department ownership, it changes attention, counts and filtering only (`design-map.md:5`).
- Leftovers: unused code, styles, strings or tables after the work. The CEO asked for a code review at the end that removes them.
- Anything outside the brand style: invented colours, sizes or spacing.

## 3. What exists and is built on

Facts from the code at `0c0f5cc0e` (turn-31 with main):

- `tasks` (`apps/server/src/db/schema.ts:1072-1131`): `parentId` tree, `departmentId`, `productId`, statuses open, working, review, waiting, blocked, done, cancelled; `assigneeAgentId` (current stage owner) and `executorAgentId` (the agent given the result), `createdByPersonId`; `after` ("waits for", the only link, `engine.ts:136-192`); `paused`, `urgent`, `small`, `externalWait`; `title` 120, `brief` 600, `body` 20000.
- `task_events` (`schema.ts:1164`): history, but a move records no status before and after.
- `task_waits` (`schema.ts:1847`): what a task waits on, with an owner person or agent and dates.
- `jobs` (`schema.ts:768`): each agent turn with its task, started and finished.
- Echelons: the fixed check route inside one task (architecture, development, review, cleanup, security, tests; `packages/protocol/src/echelons.ts:4`), shown in `ui/TaskWorkflow.tsx`. This is not a pipeline and stays as it is.
- The department screen draws one linear chain of employees from role metadata (`gate`, `schema`; `screens/schema.ts:60-180`, `Department.tsx:505-531`).
- Web: `screens/Tasks.tsx` (tiles, "Waiting for you", a board of goal cards in three views), `ui/TaskPanel.tsx` (the read-only side panel over any page), `ui/NewTask.tsx`, `ui/canvas.tsx` (`usePanZoom`, the map's zoom bar), `ui/SortTable.tsx`, `screens/task-board.ts` (plain-word states), employee states `working, queued, handed, waiting, idle, off` (`types.ts:135`).
- Rights: everyone sees every task but the work of another person's assistant (`sight.ts:20`); `actsOnTask` decides who changes one (`sight.ts:25`).
- Agent tools: heads and the orchestrator create and edit tasks (`tools.ts:130-143`); workers cannot. A skill's `grants` gives a role extra tools (`templates/load.ts:16`).

## 4. Data model

All changes are additive migrations with tests. Names are a suggestion; the builder may rename to match the code around.

### 4.1 Goals

New table `goals`:

| Column | Meaning |
|---|---|
| `id`, `number` | `number` counts up across the company, like tasks |
| `departmentId` | null: a company goal |
| `parentGoalId` | the goal it is part of; any depth; no loops |
| `title` | up to 120, a result in plain words ("500 B2C subscribers") |
| `why` | up to 300, one or two sentences |
| `responsiblePersonId` | the person who answers for it |
| `targetValue`, `currentValue`, `unit` | optional number target ("212 of 500 subscribers") |
| `dueAt` | optional |
| `status` | active, reached, dropped |
| `createdBy...`, `createdAt`, `updatedAt`, `version` | as on tasks |

Progress of a goal: `currentValue / targetValue` when a target is set, otherwise the share of done tasks among the open and done tasks under it and under its smaller goals (cancelled ones do not count).

A goal's history goes into `task_events`-like rows: the builder either generalises `task_events` to carry a `goalId` or adds `goal_events`; one history mechanism, not two copies of its code.

### 4.2 New task fields

| Column | Meaning |
|---|---|
| `goalId` | the goal a top-level task serves. A subtask takes its parent's goal and does not store its own |
| `responsiblePersonId` | the person who answers for the task |
| `why` | up to 300, why the task exists, in plain words. `brief` stays what the result is |
| `dueAt` | optional date |
| `pipelineId`, `pipelineStageId` | the pipeline a task belongs to and the stage it stands in (section 5) |

Who is responsible when nobody names one: the parent task's person, else the goal's person, else the person who takes the department's decisions by the existing rule (`decisionOwner`, `apps/server/src/auth/decision-owner.ts:69`: the department's owner, else the one person whose access lists the department, else the CEO). It is stored at creation, so there is one rule and no fallback at read time. The migration fills open tasks by the same rule; closed tasks stay empty.

When a responsible person is disabled or loses access to the task's department, their open tasks and goals pass to the department's decision owner by the same rule, with a line in the history. A change of the department's owner does not move tasks that already have a person.

### 4.3 Status history

Every status change of a task writes `fromStatus` and `toStatus` into an event's `data`, wherever it happens: in `move()` (`engine.ts`) and in the places that change the status without it today (for example open to working when work starts), which write no event yet. So the card shows "in work since 11:20" and the history shows time per status. Older events have no such data; for them "since" falls back to the last event of the task, and the card says nothing it cannot know.

### 4.4 Pipelines

New tables:

- `pipelines`: `id`, `departmentId`, `name` (up to 80), `why` (up to 300), `order`, `archivedAt`, created by, version.
- `pipeline_stages`: `id`, `pipelineId`, `parentStageId` (null: the first stages, right after the head), `name` (up to 60), `ownerRole` (a role id such as `MKT-SOCIAL`) or `ownerAgentId`, `order`.

A pipeline is a tree: forks are several stages with the same parent. Example from Northwind Marketing, "Social": 3D content producer, then three branches at once: Instagram and TikTok, X, video producer then YouTube.

## 5. How work goes through a pipeline

A pipeline is the department's map of who hands work to whom. It does not create or move work by itself, and there is no new path in the engine.

- A task belongs to a pipeline when its `pipelineId` is set: by the head or the orchestrator when they create or update it, by the product manager tidying it, or by a person in the card. Existing tasks join the same way; nothing about their executor, subtasks or route changes.
- The stage it stands in is `pipelineStageId`. Whenever the task's current owner changes (`assigneeAgentId`, which is the current stage owner of its echelon route), the server moves it to the first stage, in tree order, whose role the new owner holds. If the new owner holds no stage's role (a checker from another department, for example), the task stays where it was. The head, the orchestrator and the product manager can also set the stage.
- Hand-offs stay what they are today: a head creates the next task for the next employee, often waiting for the first one with `after`. A fork is several such tasks in different branches.
- Any role may own a stage, a checking role too. Nothing is created per stage, so a stage owned by a checker adds no second check: the task simply stands there while that checker holds it.

A board for a pipeline has one column per stage, in tree order, plus "Not started" (tasks of the pipeline nobody holds yet) and "Done". A task outside any pipeline is not on a pipeline board; the status board shows everything.

The department screen does not change in this work: its canvas shows the department's structure (roles, employees, gates) and stays as it is. Pipelines live in the tracker: in the left panel under their department, as board columns, and as the Graph view's second mode.

Who defines pipelines: the department's head, its product manager and the orchestrator through a tool, and people who reach the department on the screen (a simple form: name, why, stages with a parent and an owner role). Templates ship no pipelines; the product manager drafts them from its department's roster and the tasks it sees in its first turns. Until then the department has the status board only.

## 6. Time facts

Computed on the server in one function, sent with each task:

- `inStatusSince`: from 4.3.
- `workSeconds`: the sum over the task's `jobs` of finished (or now) minus started.
- `waitsOn`: open `task_waits` rows: whom (person or agent) and since when. The card says "waits for Max 3 days".
- Standing still is not a new threshold: a task "stands" when it is waiting, blocked or paused, for as long as `inStatusSince` says. Existing stuck detection (`engine.ts:1136-1240`) is not duplicated.

## 7. Server API

Extend, do not duplicate:

- `GET /api/tasks` and the task detail carry the new fields, the time facts, and "needed for" (the reverse of `after`, computed).
- `POST /api/tasks` takes `goalId`, `responsiblePersonId`, `why`, `dueAt`, `parentId` (a person adds a subtask; it goes to the head as tasks from people do today), and `pipelineId` with an optional `pipelineStageId` (section 5).
- New `PATCH /api/tasks/:id`: `title`, `brief`, `why`, `goalId`, `responsiblePersonId`, `dueAt`, `pipelineId`, `pipelineStageId`, with `version`. Allowed by `actsOnTask`. Executor, status, parent and route are not editable here.
- What a task waits for (`after`) stays with the agents, who set it through their tools; the card shows it and "needed for" read-only. People get no route of their own for it: nothing on the screen would call one.
- New `goals` routes: list (with progress), create, edit, set status. Company goals: the CEO and delegates; department goals: whoever reaches the department.
- New `pipelines` routes: list with stages, create, edit, archive.
- Every write lands in the history and goes out on the existing live channel.

## 8. Agent tools and the product manager

### 8.1 Tools

- `create_task` and `add_tasks` take `goal`, `responsible`, `why`, `due` and `pipeline`. `update_task` takes the same. No new tool for heads.
- New `goals` (read, everyone) and `set_goal` (create and edit; heads, the orchestrator, product managers).
- New `set_pipeline` (heads, the orchestrator, product managers).
- New `tidy_task` for product managers: `title`, `brief`, `why`, `goal`, `pipeline` and stage, `responsible` (suggesting only the department's owner or a person already on the goal), within its own department. It cannot change executor, status, urgency, pause, waits or route: the head gives out work.

### 8.2 The product manager role

One role per department template: `OPS-PM`, `DEV-PM`, `MKT-PM`, `SAL-PM`, `BIZ-PM`, `DSN-PM`, `SUP-PM`, `FIN-PM`, `HOM-PM`, `HHD-PM` (title en "Product manager", ru "Продакт-менеджер"), `kind: member`, `tier: fast`, `default: true`, and one shared skill (for example `hh-keep-tracker`) that grants the tools above. Each role file is short (the body limit is 180 characters); the skill holds the instructions:

- Every task and goal of the department has a short human title, a short "why", a responsible person and a goal. Titles say the result, not the method, in the people's language; no bare numbers.
- Rewrite agents' texts for people without changing their meaning; the detail stays in `body`.
- Group work under goals; propose new goals to the department's responsible person rather than inventing targets.
- Keep goal numbers current from the reports.
- Draft the department's pipelines from its roster and keep them current.
- Never give out work or change who does it; ask the head.

It wakes when a task or goal of its department is created or changes status, and on a slow timer (like `OPS-WATCH`, `templates/roles/operations/OPS-WATCH.md`), never on every event. Company templates (`packages/protocol/src/index.ts:267+`) add one to each department's staff. Template rules apply: general texts, en and ru, no em dashes, no "ё", listed in `templates/SOURCES.md`, the instruction size limit, and the Operations default-role test updated.

Existing companies: the update hires one product manager into each top-level department that has none (section 12).

## 9. Screens

The mockup is the layout reference. Exact look follows the style book (section 10).

### 9.1 Layout

Tasks replaces today's Tasks screen and opens from the Tasks tab of the usual header. The header (logo, Map, Tasks, People, Subscriptions and API, Machines, account) stays exactly as on every other screen; the tracker adds no icon rail of its own (the mockup's narrow left strip of icons came from ClickUp and is dropped). Under the header: the left panel, then the main area, then the card as a side panel.

It opens by who the person is: everyone lands on their own "My tasks", and the left panel puts the departments they answer for first. The CEO lands on their own tasks too and can look at anyone's screen with "View as" (9.4).

- Left panel:
  - "Waits for me" (requests and waits addressed to the viewer, as "Waiting for you" today), "My tasks" (responsible for), "Working now" (with a count; filters to tasks whose agents work now).
  - "Responsible": the people who answer for departments or goals, each with the departments they answer for and a count of their open tasks.
  - "Departments": each with its responsible person and how many employees work now; it opens to the department's goals, pipelines and employees. Each employee shows a state mark (working, waits, free) with words and the task it is on; working ones come first, the rest fold under "N more". Products (child departments) are a filter inside their department.
  - "Turns and releases": today's turns view, kept as an item here.
- Top: where you are (department, pipeline or person), "View as" (section 9.4), search.
- View tabs: List, Board, Graph. Filter chips: status, executor, responsible, goal. Nothing more on this row.

### 9.2 Views

- **List**: grouped by status (words, not colour only); columns name with number in muted text, executor, responsible, goal, due. Subtasks open under their task. Every row opens its card.
- **Board**: columns by status by default: Not started, In work, Review, Waits (including waits for a person), Done (cancelled under a filter). With a pipeline chosen, columns are its stages (section 5). Cards show title, avatars of executor and responsible, due, subtasks done of all, and "waits for X N days" when it waits.
- **Graph**: a canvas exactly like the map: dotted background, drag to move, wheel and the map's zoom bar (minus, percent, plus, show all) to zoom, no scrollbars. It reuses `usePanZoom` and the zoom bar from `ui/canvas.tsx`, not a copy. It draws a tree from a root: by default the chosen goal (or every goal of the department); goal, then smaller goals, then tasks, then subtasks. Solid lines: part of. Dashed lines with a word: waits for, needed for. A strip at the node's start: status, with the status word in the node. Click a node: its card. "Graph from here" in the card re-roots the tree; a breadcrumb leads back up. With a pipeline chosen, a second mode draws the pipeline's stages with the number of tasks in each.

### 9.3 The card

`ui/TaskPanel.tsx` becomes the card; there is no second card. It adds: the path (goal, smaller goal, parent task) as links; kind (goal, task, subtask); title, status, why; facts (responsible, executor, pipeline and stage, due, time facts); "Graph from here"; subtasks, each opening its own card; links both ways ("waits for", "needed for"); materials (attachments, the result report, links in comments); history in plain words, including status changes. Editable fields per section 7 for those allowed. Goals open the same panel in a goal layout (progress bar, target, smaller goals and tasks).

Cards are not dragged between columns: the engine moves them. The card offers what the engine allows today: pause, resume, cancel, urgent (with the same rights).

### 9.4 "My tasks" and "View as"

"My tasks" lists open tasks and goals the viewer is responsible for, then what waits for them. "View as" picks another person: the screen shows their "Waits for me" and "My tasks". It filters only: the viewer still sees only what `seesTask` lets them see. Available to the CEO and CEO delegates, as the decisions' person filter is today.

### 9.5 Width, languages, themes

- Phone width: the left panel becomes a drawer; board columns stack as sections; list rows wrap; the card takes the full width; the canvas takes the screen and the zoom bar stays reachable. No sideways page scroll anywhere.
- en and ru for every string, in plain words; layout for 1.5 to 2 times longer text and right-to-left through logical properties.
- Light and dark themes through tokens only.

## 10. Brand style

- Follow `docs/style-book.md` (v1.4), `docs/hornhoof-themes.md`, `templates/skills/dev-frontend-ui.md` and `CONTRIBUTING.md`.
- The mockup used colours that are not tokens (a violet for review, per-person avatar colours, per-department letter colours). The build uses existing tokens instead, or proposes additions.
- The style book has no rules for a left panel, a board or a graph. The builder writes them as PROPOSAL additions with a reference page; the head of Design approves them (style book, section 8) before the final styling lands. Non-visual work does not wait for that approval.
- Status is always shown with words, never by colour alone. Touch targets 44 px. No ellipsis or clipping of text or buttons.

## 11. Acceptance

The tests follow `templates/skills/dev-tdd.md`; every item below is a failing test first.

1. A goal tree of any depth, with progress from a number target or from tasks; loops refused.
2. A task's responsible person: explicit, else parent, else goal, else the department's decision owner; stored at creation; the migration fills open tasks by the same rule; a disabled person or one who lost access hands their open tasks and goals to the decision owner, with a history line.
3. Every status change, inside and outside `move()`, writes `fromStatus` and `toStatus`; `inStatusSince`, `workSeconds` and `waitsOn` are right for a task with several jobs and waits.
4. An existing task joins a pipeline without any change to its executor, subtasks or route; when its current owner changes to an employee holding a stage's role it moves to that stage, and when the new owner holds none it stays; the pipeline board puts each task in its stage's column, tasks nobody holds yet in "Not started", and closed ones in "Done".
5. People edit title, brief, why, goal, responsible and due through `PATCH` with `actsOnTask` and `version`; others get refused.
6. A product manager can tidy texts and goals in its department and is refused executor, status, urgency, waits and route, and anything in another department.
7. Every department template has a product manager; company templates hire one; the templates tests pass (en and ru, sources, size, no em dashes, no "ё").
8. The update hires one product manager into each top-level department of an existing company that has none, and only once.
9. Web: My tasks and View as filter right; every view opens the same card; subtasks open their own card; the graph pans, zooms and re-roots; nothing scrolls sideways at phone width, in both themes and both languages.

Risk classes: data (new tables and a migration of open tasks) and access (who edits, the product manager's limits, View as).

## 12. Rollout

- Built on branch `task-tracker` (from `turn-31-with-main`), merged into the open turn after 0.31.0, through the whole suite in CI (not on the CEO's Mac).
- The update migrates the data (4.2), and hires the product managers into existing companies' top-level departments. The orchestrator is told in the release notes, en and ru.
- The in-app guide (`guide/tasks-and-turns.md`) describes the tracker, and its outdated part about "planned turns" goes.

## 13. What this replaces and deletes

In the same work:

- The old Tasks screen board and its three views, the summary tiles, and `ui/TaskBoard.tsx` pieces (`GoalCard`, `BoardSection`, `Fold`, `Progress`) that nothing else uses after it. `screens/task-board.ts` state words are reused, not copied.
- The department screen's own task list in its Tasks drawer: the drawer opens the tracker for that department.
- The i18n strings, CSS classes and exports that become unused, including `lastGate`, which no code uses today.
- At the end, a code review of the whole change (the `code-review` skill) and a search for unused exports, classes, strings and tables; whatever turns up goes.

## 14. Calls I made (the CEO did not decide these)

1. Goals are their own table, not top-level tasks.
2. A pipeline is a map of stages (trees without joins) that tasks are placed on; it creates and moves no work, and the engine gets no new path. A task's stage follows the role of whoever holds it.
3. The department screen stays as it is; pipelines live only in the tracker. A department has no pipeline until one is drafted.
4. People do not drag cards between status columns; statuses come only from the engine.
5. The product manager tidies texts, goals and pipelines but never gives out work or changes who does it.
6. The product manager's tier is fast, and it wakes on its department's task events and a slow timer.
7. Existing companies get a product manager in each top-level department by the update.
8. View as is for the CEO and delegates only.
9. People do not attach files in the first version.
10. Nobody named: the responsible person comes from the existing decision owner rule, not a new one; a disabled person's or a person without access's open work passes to that owner.

## 15. Left to the builder

- Exact names of tables, columns, routes and tools, matched to the code around.
- How many employees the left panel shows before "N more".
- The product manager's timer length and wording of its skill, within the template rules.
- The order of the plan, given that non-visual work goes first and final styling waits for the head of Design.
