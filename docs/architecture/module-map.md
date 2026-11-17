# Module map

What lies where in Hornhoof on the branch `turn-31` (commit `c430ade5`, the candidate of 0.31.0), what each part
depends on, where code repeats itself and where imports go round in circles. It replaces the map of 0.18.0, which is
in the history of `docs/module-map.md`.

Lines are lines of code: blank lines and comment lines are not counted. A module of the server is a folder under
`apps/server/src/modules`, or a folder or file directly under `apps/server/src`; in the node, the web and the protocol a
module is a folder or a file directly under `src`. Imports are counted from source files only, never from tests. A
type-only import (`import type`, or braces that hold only types) is left out of the cycles, as it disappears when the
code is built.

## Sizes

| Part | Files | Source | Tests |
| --- | --- | --- | --- |
| `apps/server` | 524 | 66,900 | 129,100 |
| `apps/web` | 192 | 30,600 | 31,300 |
| `apps/node` | 103 | 19,400 | 28,400 |
| `packages/protocol` | 28 | 2,400 | 3,100 |

The largest source files: `apps/node/src/terminal/host.ts` (3,450 lines with comments), `apps/server/src/db/schema.ts`
(2,822), `apps/web/src/i18n/en.ts` (2,487), `apps/server/src/modules/tasks/engine.ts` (1,483),
`apps/server/src/modules/conversation/queue.ts` (1,357) and `apps/node/src/main.ts` (1,052).

## Server

`app.ts` builds one `Ctx` (database, bus, config and the ports to GitHub and the nodes) and registers every module's
routes; `main.ts` starts it behind `front.ts`, the web port, and `keeper.ts`, the process that keeps the machine's
place in the company. Out: what the module itself imports from other modules. In: how many modules import it.

| Module | Files | Lines | Out | In | What it does |
| --- | --- | --- | --- | --- | --- |
| `tasks` | 85 | 11,552 | 16 | 23 | Tasks and turns: the engine of task moves, echelons and turnkey, waits and wakes, reminders, review records, attachments, decisions for people, the department tree and the pipeline report |
| `keeper` | 60 | 9,826 | 13 | 10 | The machine's keeper: who leads the company, following the leader, copies of the database, handing over and taking over, backups on machines, read-only mode |
| `outbound` | 26 | 4,557 | 12 | 5 | Mail to people outside: catalog of messages, consent, limits, approvals, delivery over SMTP, support replies, its model checks |
| `testruns` | 28 | 3,235 | 11 | 11 | `run_tests` and `run_work`: describing a product, planning parts, picking machines, reuse of results, the test harness, receipts, the GitHub status |
| `merge` | 16 | 2,854 | 7 | 7 | Merging a database that worked apart back into the leader's: facts, rules, plans, applying, conflicts for the CEO |
| `conversation` | 16 | 2,748 | 20 | 21 | The queue of agent turns, an agent's inbox, words people type, live words, who a decision is for |
| `tools` | 18 | 2,638 | 31 | 12 | The MCP server agents call (`mcp.ts`), the guard that runs a call once, the orchestrator's control tools, watching, staffing and structure cards |
| `nodes` | 27 | 2,550 | 20 | 18 | Machines and their node connection: joining, messages from nodes, check slots, commands, hooks a program sends, parked jobs |
| `program-operator` | 23 | 1,894 | 10 | 5 | A program that did not take its words: cases, the screen, keys, holds, recovery and the operator's tools |
| `backups` | 9 | 1,390 | 10 | 4 | Backup bundles: which machines hold them, recovery files, restore and total loss |
| `subscriptions` | 9 | 1,350 | 16 | 7 | Plans and API keys: credentials, sign-in, models, leases, fallback to another plan |
| `departments` | 11 | 1,189 | 12 | 16 | Departments and products, their repositories and branches, approval policy, hiring, rosters |
| `assistants` | 13 | 1,141 | 12 | 3 | A person's own assistant agent: its messages, files, skills and tools |
| `network` | 11 | 1,140 | 18 | 13 | The company's network of machines: joining, authority, renewal, switching the server |
| `agents` | 10 | 1,140 | 17 | 12 | Employees: assignment, instructions, order, role and model, timers, running turns |
| `updates` | 10 | 930 | 13 | 10 | New versions of Hornhoof and the drain of a node before its update |
| `copies` | 12 | 921 | 6 | 6 | Which machines keep a copy of the data, their order and score, moving the server |
| `tls` | 9 | 883 | 3 | 5 | Certificates from ACME for the company's own address |
| `telegram` | 7 | 823 | 7 | 4 | Telegram bots: messages in and out, voice transcription, tools |
| `computer` | 7 | 808 | 7 | 7 | The orchestrator's access to a person's computer: grants, keys, commands |
| `link` | 7 | 633 | 7 | 16 | The public link `<name>.hornhoof.org`: relay, tunnel, visits |
| `model-checks` | 9 | 597 | 7 | 1 | A model grades a prompt on a set of examples; only `outbound` uses it |
| `feedback` | 6 | 574 | 6 | 2 | Feedback from people to Hornhoof's GitHub issues |
| `org` | 4 | 564 | 11 | 5 | The company map: layout, lines between agents, returns along a line |
| `events` | 6 | 439 | 5 | 17 | The event bus, notifications and the live stream to the web |
| `people` | 2 | 406 | 11 | 7 | People, invites and their access |
| `terminals` | 6 | 382 | 4 | 3 | A person watching or typing into an agent's terminal through the relay |
| `improvements` | 3 | 339 | 8 | 4 | The Improvements list and its tools |
| `vault` | 4 | 323 | 4 | 3 | Site sign-ins agents use, with one-time codes |
| `google` | 3 | 303 | 4 | 2 | Google Sheets |
| `jobs` | 3 | 271 | 8 | 5 | Sending a turn to a node: dispatch and its views |
| `templates` | 1 | 265 | 0 | 3 | Loading roles, skills and department templates |
| `notebook`, `briefings`, `backlog`, `operations`, `setup`, `sources`, `auth` | 1 to 3 each | 57 to 208 | | | A head's notebook, briefings, the backlog, the roles Operations always has, the setup link, the change header, sign-in routes |

Outside `modules`: `db` (11 files, 3,315 lines; imported by 45 modules) holds the schema, the client, the selections
many queries share and the write sources; `auth` (14, 856; 36 modules) the session, internal calls of the
orchestrator, decisions and access; `net` (9, 1,487) the front port, the doors of the leader and the peers;
`errors.ts` (41 modules), `config.ts`, `crypto`, `benchmark`, and the entry points `main.ts`, `front.ts`, `keeper.ts`,
`cli.ts` and `migrate.ts`.

### Who depends on whom

- By imports of values, `db` is used 483 times, `auth` 168, `errors.ts` 149, `tasks` 132, `nodes` 107 and
  `conversation` 104.
- 68 pairs of server modules import each other. The heaviest: `conversation` and `tasks` 14 and 33 imports,
  `tasks` and `testruns` 12 and 17, `tasks` and `tools` 5 and 23, `nodes` and `tasks` 7 and 19, `nodes` and `testruns`
  9 and 14, `conversation` and `program-operator` 8 and 13, `departments` and `tasks` 5 and 15, `nodes` and
  `subscriptions` 4 and 14, `keeper` and `net` 21 and 1, `copies` and `network` 11 and 4.
- `db/schema.ts` names three types of `tasks` (`WakeCause`, `WaitNoticeMessage`, `WaitNoticeGuard`) through
  `import()` types; that is no import at run time.

### Cycles

At run time, 42 of the server's modules are in one cycle of imports: every one but `templates`, `modules/auth`,
`crypto`, `benchmark` and the entry points (`app.ts` among them) reaches every other one. At the level of files there are three cycles:

- 78 files around `tasks/engine.ts`: the waits (`wait-*.ts`, `external-wait.ts`), wakes (`wake.ts`, `again.ts`,
  `failures.ts`, `silent.ts`, `restarts.ts`, `orphan-turns.ts`), the echelons (`echelons-*.ts`), `testruns/runs.ts`,
  `testruns/harness.ts`, `conversation/queue.ts`, `jobs/dispatch.ts`, `nodes/messages.ts`, `updates/drain*.ts`,
  `program-operator/recovery.ts` and `access.ts`, and `subscriptions/fallback.ts`. A task move wakes an agent, a wake
  queues a turn, a turn's end moves a task: all of it is one knot.
- `errors.ts` and `modules/keeper/app-mode.ts`: errors take the read-only message from the keeper, and the keeper's
  mode takes `ApiError` from errors.
- `tasks/tree.ts` and `tasks/tree-waits.ts`.

## Node

`main.ts` (871 lines of code) connects to the server and runs every turn; `runNode` in it is the most complex function
of the whole repository after the web's agent window.

| Group | Files | Lines | What it does |
| --- | --- | --- | --- |
| `terminal/` | 31 | 6,195 | tmux, typing words into a program, receipts, hooks, the tools bridge, transcripts, recordings and the window a person watches. `host.ts` alone is 3,450 lines |
| `test-*.ts`, `tests.ts` | 18 | 4,689 | Running a part of a test run: mirror, harness, services, discovery, fingerprints, impact and its mutation, the cache |
| `command-guard.ts` | 1 | 1,587 | A shell parser that refuses a whole test suite in an agent's own workspace |
| `providers/` | 9 | 1,327 | Each program (Claude, Codex, Kimi, Antigravity and the API ones): start, events, limits, install |
| `web-page/` | 7 | 968 | `hh-browse`: reading a page that scripts build |
| the rest | 37 | 4,700 | connection, runner, outbox, credentials, sign-in, isolation, workspace, skills, browser, updates, `hh-xlsx` |

At run time, 17 files are in one cycle: `providers/*` take terminal states, transcripts and failures from `terminal/`,
and `terminal/` takes the adapters from `providers/index.ts`; `account.ts`, `credentials.ts`, `isolation.ts` and
`program-exit.ts` are in it through `providers/`.

## Web

| Group | Files | Lines | What it does |
| --- | --- | --- | --- |
| `ui/` | 117 | 13,001 | Components: cards, windows, settings, the agent's terminal, the task panel |
| `screens/` | 37 | 8,950 | The screens: map, department, agent window, tasks, settings, setup, the shell |
| `i18n/` | 4 | 4,990 | Every text in English and Russian |
| `map-*.ts` | 5 | 909 | Laying out the company map: blocks, roads, people and their bridges |
| `skins/` | 7 | 497 | The skins people choose and make |
| the rest | 22 | 2,283 | `api.ts`, live updates, routes, tasks, updates, `types.ts` |

`screens/` imports `ui/` 170 times and `ui/` imports `screens/` 5 times; with the `map-*.ts` files they make one cycle of
six modules. The most complex functions of the repository are the web's: `AgentWindow` (cyclomatic complexity 241),
`MapScreen` (122), `DepartmentView` (120), `AgentCard` (114) and `Shell` (57).

## Protocol

28 files, 2,400 lines: the messages between server and node (`index.ts` and the files it gathers), and the parts the
web takes without the schema library, each its own entry of the package: `program-operator`, `approval-policy`,
`efforts`, `link`, `map`, `pipeline-report`, `signin`, `waits`, `echelons` and `redaction`. The protocol imports
nothing of the apps. It has no cycle at run time; counting types, `map.ts`, `index.ts` and `efforts.ts` import each
other.

## The same thing written more than once

`dryer` (threshold 0.82, at least 4 lines) finds 88 pairs of functions that are the same in form, 58 of them exactly.
Those with the most copies:

- Starting and stopping a timer that ticks: the same `start` and `stop` in `keeper/beats.ts`, `keeper/question.ts`,
  `keeper/watch.ts`, `keeper/proofs.ts` and `tls/manager.ts`; the same `start` and `stop` around a watcher in
  `keeper/handing.ts`, `keeper/lead-update.ts` and `keeper/taking.ts`.
- Turning a refusal into a tool's error text: `answer` or `refused` in `testruns/tools.ts`, `improvements/tools.ts`,
  `tools/approval-policy.ts`, `assistants/mcp.ts` and `vault/tools.ts`, each with its own `say`.
- Small helpers kept more than once: parsing JSON or giving null (`backups/bundle.ts`, `model-checks/dataset.ts`,
  `tls/ari.ts`), reading a file or giving null (`node/src/load.ts` and `web-page/processes.ts`), hiding secrets in a
  text (`node/src/redact.ts` and `program-operator/access.ts`).

## Complexity

`crapper --no-coverage` scores 10,415 functions: 461 have a cyclomatic complexity of 10 or more, 112 of 20 or more and
47 of 30 or more. Beside the web's screens above, the highest are `runNode` (node `main.ts`, 175),
`handleNodeMessage` (`nodes/messages.ts`, 74), `UnitWriter.prepared` (`merge/apply.ts`, 67), the route
`GET /api/org` (64), the Claude adapter (63), `registerWatchTools` (60), `nextEntryStep` (`keeper/takeover-step.ts`,
58), the keeper's constructor (56) and `sendNext` (`conversation/queue.ts`, 55).

## How to measure it again

- Sizes, imports and cycles: read every `.ts` and `.tsx` file of the four parts, resolve each relative import and each
  import of `@hornhoof/protocol`, and find the strongly connected parts of the graph of modules and of files.
- Exports nobody uses: for every exported name, search every source, test and script for it as a word.
- Duplicates and complexity: `dryer -s apps/server/src -s apps/node/src -s apps/web/src -s packages/protocol/src` and
  `crapper --no-coverage` with the same source roots.
