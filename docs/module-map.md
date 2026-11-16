# Module map

What lies where in Hornhoof 0.18.0 (commit `4568a8a5`), who depends on whom, what is unused, and the structure the
refactoring moves towards. Sizes are lines of source without tests. The usage numbers come from the database of a
company in daily use, read on 2026-11-09.

## Sizes

| Part | Source | Tests |
| --- | --- | --- |
| `apps/server` | 42,800 | 78,300 |
| `apps/node` | 21,900 | 30,400 |
| `apps/web` | 26,900 | 33,200 |
| `packages/protocol` | 3,000 | 3,700 |
| `scripts`, `apps/updater` | 4,000 | 2,700 |
| `templates` (54 roles, 179 skills) | 463,000 characters | |

The database has 91 tables. An agent can be offered about 108 tools.

## What a company in daily use showed

- 7,860 agent turns in 8 days. 5,326 of them (68%) went to the orchestrator, the heads, the task watchdog and the rest
  of Operations, and 2,532 to employees who produce work. By program time it is the other way round: 102 of 541 hours.
- The head of development was woken 2,102 times, with a median turn of 11 seconds. The orchestrator 1,200 times, the
  task watchdog 1,175 times.
- Turn 8 took 65 hours: 290 tasks, 2,140 agent turns, 1,501 comments. Turn 17 took 23 hours: 24 tasks, 435 agent turns,
  383 comments.
- 1,381 test runs, 793 of them failed. One task started 234 runs.
- 422 agent turns failed (5.4%); on Antigravity 193 of 914.

## Server modules today

| Module | Lines | What it is | Tables |
| --- | --- | --- | --- |
| `tasks` | 12,500 | Task and turn state, echelons, turnkey, waits, wakes, reminders, review records, the department tree, the pipeline report, unused staging | 11 + 3 waits |
| `outbound` | 4,900 | Email and webhooks to people outside, consent, limits, approvals, support tickets | 18 |
| `testruns` | 3,800 | `run_tests`: describe, plan parts, pick machines, reuse results, harness builds | 7 |
| `db/schema.ts` | 2,400 | Every table in one file | |
| `nodes` | 2,300 | Machines, the node connection, messages from nodes | 6 |
| `conversation` | 2,300 | The queue of agent turns, sessions, words typed by people, live words | `jobs`, `agent_events` |
| `program-operator` | 2,200 | Cases for words a program did not take, the screen, keys, holds | 5 |
| `tools` | 1,900 | The MCP server and the orchestrator's 38 control tools | |
| `agents` | 1,200 | Hiring, instructions, the minute round of timers | 2 |
| `subscriptions` | 780 | Plans, keys, sign-in, budgets | 2 |
| `departments` | 770 | Departments, approval policy, wait policy routes | 3 |
| `updates` | 740 | New versions, node drain before an update | |
| `model-checks` | 730 | A model grades a prompt on examples; only `outbound` uses it | 5 |
| `org`, `terminals`, `events`, `link`, `people`, `computer`, `improvements`, `jobs`, `notebook`, `templates`, `operations`, `setup`, `briefings`, `backlog`, `auth` | 60 to 640 each | | |

### Who depends on whom

Counted by import statements between modules. 44 pairs of modules import each other.

- `tasks` and `conversation` import each other 29 and 13 times, `tasks` and `testruns` 16 and 19, `tasks` and `tools`
  3 and 19, `conversation` and `program-operator` 8 and 12, `nodes` and `testruns` 9 and 12, `nodes` and
  `subscriptions` 1 and 14.
- `tasks` is imported 115 times, `nodes` 81, `conversation` 79, `events` 56, `departments` 48, `testruns` 40.
- `outbound` is imported 6 times, from `app.ts`, `tools/mcp.ts`, `tools/structure.ts`, `agents/timers.ts` and
  `auth/origin.ts`. Nothing in `tasks`, `conversation`, `jobs` or `nodes` imports it.
- `app.ts` wires everything through one `Ctx` object. `agents/timers.ts` runs the minute round for every module.

## Node today

| Group | Lines | What it is |
| --- | --- | --- |
| `terminal/` | 7,200 | tmux, typing words into a program, receipts, hooks, the tools bridge, the operator's observer, the window a person watches. `host.ts` alone is 3,331 lines, and 48 of the node's 78 checks of a program's name outside `providers/` are in it |
| `test-*.ts`, `tests.ts` | 5,100 | Running a part of a test run: mirror, harness, services, fingerprints, impact |
| `command-guard.ts` | 1,900 | A shell parser that refuses a whole test suite in an agent's own workspace |
| `providers/` | 1,500 | Running each program without a terminal (`claude -p`, `codex exec`, `kimi --prompt`, `agy --print`), its events, limits and install |
| the rest | 6,200 | `main.ts`, connection, runner, git, sign-in, browser, isolation |

## Web today

`screens/` 7,300, `ui/` 9,500, `i18n/` 3,100, the rest 4,000. It follows the server's routes and has no structure
problem of its own; `types.ts` (688 lines) repeats shapes that also live in `packages/protocol`.

## The same thing done several times

- **Waking an agent.** More than twenty causes, produced in `engine.ts`, `wake.ts`, `turns.ts`, `silent.ts`,
  `failures.ts`, `restarts.ts`, `external-wait.ts`, `wait-escalation.ts`, `wait-monitor.ts`, `reconcile.ts`,
  `agents/timers.ts`, `program-operator/cases.ts`, `testruns/runs.ts` and others.
- **Running a turn again.** Four routes: `afterRestart`, `continueOnce`, `retryTurn`, `retryUnheardWords`.
- **Noticing that nobody moves a task.** The silent and going-on counters (`engine.ts`), `wakeMissing`
  (`reconcile.ts`), the silent program alarm (`silent.ts`), the quiet department notice (`wait-monitor.ts`), wait
  escalation, and the task watchdog, an employee woken every 10 minutes to ask every agent.
- **Words that did not reach a program.** The node presses Enter again and types again, the operator's observer raises
  an alarm after 60 seconds and a case goes to an employee, and the server restarts a silent program. Nothing makes the
  first wait for the second.
- **Running tests.** Thirteen ways, from `npm test` to `run_tests` with a hand-written command. Eight layers decide
  what to run and where: part planning, pace learning, timings, fingerprints, result reuse, impact selection, impact
  mutation, harness builds.
- **Rules in skills.** Word for word little repeats: 14 sentences stand in three or more of the 178 skill files, 1.7% of
  their text. What costs is how much a role is given at once, and rules that say the same thing in different words.

## Unused

Checked by searching for importers outside tests.

- `tasks/staging-*.ts` (8 files), `db/workspace-store.ts`, `db/workspace-repository-url.ts`, node `staging-git.ts`: no
  importer. Their 12 tables are never written.
- Five external recovery tables and `computer_access_intents`: no code at all.
- `planningHistory` (`testruns/plan-history.ts`), `test-impact-replay*.ts`, `independentView`, the wake cause
  `changes`, `gateCounts`, `encodeNativeDecision`: only tests use them.
- The skill `hh-questions` was given to nobody; since 2026-11-10 every employee carries it.
- `outbound` and `model-checks`: reachable, but that company has no row in any of their 23 tables, and the web
  calls 2 of their 28 routes.

## Faults found while mapping

- A turnkey turn could not end: the report that closes a task refused finished turnkey work under it as unreviewed
  code. Fixed with a test on the branch `fix-turnkey-close`.
- Words a program never recorded are said again every 10 minutes with no end (`tasks/failures.ts`,
  `retryUnheardWords`).
- A turn that failed for a reason without a name wakes the same agent with "go on" and counts nowhere
  (`tasks/wake.ts`, `checkHeld`).
- The timer "for work" of the task watchdog looks at any open task of the whole company, so one task that waits for a
  person keeps it waking every 10 minutes (`agents/timers.ts`, `workFor`).
- A nudge from the watchdog is a turn on the task; three such turns without a move raise the task as stuck.
- The quiet department notice gets a new key each time the head answers, so it comes again every 15 minutes.
- The node types words again after 15 quiet seconds even when the program took them and its log is late.
- A wait declared at the same moment as a message on its task sometimes stays, though the message should end it
  (`tasks/external-wait.ts`, `placeWait`). Its test fails 1 run in 20 on 0.18.0 and 5 in 20 on the branch `refactor`,
  where the timing differs. Not fixed.

Checked and not a fault: a wake that is not queued leaves the outbox only when a turn already waits on the task or its
agent is gone or has no plan, and the minute round wakes a holder that became available again.

## Done on the branch `refactor`

- Removed: the staging and workspace store with its 12 tables, the node's external git, task folders and workspace
  retiring, the test planning history, the hook answer encoder, the wake cause `changes`, `gateCounts`,
  `independentView` and smaller pieces nothing read. About 7,000 lines: 2,600 of source and 4,400 of their tests.
- Comments moved to the declarations they describe or reworded to what the code does, in every server and node module.
- A quiet program is an alarm after 10 minutes (a running tool after 30), goes to whoever sees its screen, and is called
  about again each time the quiet doubles.
- Bounded: the wait between tries of words a program did not record doubles up to four hours; five failed turns in a
  row on a task block it for whoever gave it out; a timer for work skips its round while every open task waits on
  purpose.

## The structure to move towards

One rule decides where code goes: Hornhoof's own code moves work, and a program only does work. Whatever the server
can decide from its own records, it decides without waking a model.

### Server

| Module | Holds | Comes from |
| --- | --- | --- |
| `work` | Tasks and turns as records and one state machine. No knowledge of nodes, programs or test machines | `tasks/engine.ts`, `turns.ts`, `tree*`, `views.ts` |
| `conveyor` | What happens after each move: the next stage and its owner, closing a parent, closing a turn, merging. Echelons and turnkey are two routes here | `tasks/echelons-*`, `turnkey.ts`, `review-*`, the relays heads do by hand today |
| `runs` | One queue of agent turns, one rule for running a turn again, one detector of a task nobody moves, one table of wake causes | `conversation/queue.ts`, `tasks/wake*`, `failures.ts`, `restarts.ts`, `silent.ts`, `reconcile.ts`, `wait-*`, `agents/timers.ts` |
| `machines` | Nodes, their connection, load, updates of nodes | `nodes`, `updates/node-drain.ts` |
| `programs` | A program on a machine: its session, limits, sign-in, and what is left of recovery | `subscriptions`, `program-operator`, `terminals` |
| `checks` | The whole-suite run and its parts | `testruns` |
| `company` | Departments, employees, people, instructions from templates, notebook, briefing, backlog, improvements | `departments`, `agents`, `people`, `templates`, `notebook`, `briefings`, `backlog`, `improvements`, `operations` |
| `desk` | What a person sees and answers: requests, chat, the event stream, the map | `events`, `org`, `tasks/decisions.ts`, routes |
| `platform` | Database, auth, setup, public link, updates | `db`, `auth`, `setup`, `link`, `updates` |
| `extensions/outbound` | Outbound, support and model checks, registered in one place and absent unless switched on | `outbound`, `model-checks` |

Dependencies go one way: `desk` and `extensions` use `conveyor`, which uses `work` and `runs`; `runs` uses `machines`
and `programs`; `platform` is under all of them.

### Node

| Module | Holds |
| --- | --- |
| `connection` | The link to the server and what was not confirmed yet |
| `run` | The life of one agent turn on this machine |
| `programs/<name>` | Everything about one program in one folder: start, how it takes words, how it says a turn ended, limits, install |
| `delivery` | One way a turn's words reach a program and one way its end is known |
| `bridge` | Tools and hooks over local HTTP |
| `window` | The terminal a person watches and types into |
| `checks` | Running a part of a test run |
| `workspace` | The agent's folder, git, isolation |

## Order of work

Each step removes more than it adds and is measured on the next turn by four numbers: agent turns per task, the share
of turns that go to coordination, failed turns, and minutes from the first word to the merge.

1. Stop the loops without new mechanisms: the faults listed above, and the timers of the task watchdog and the weak
   point collector off while the detectors in code do the same.
2. Remove what is unused.
3. Move `outbound` and `model-checks` behind one registration.
4. `runs`: one rule for running a turn again, one detector of a standing task, wake causes as one table.
5. `conveyor`: the server makes the hand-offs it already verifies, and a head is woken only for a decision.
6. `delivery`: compare, on the four real programs, a turn run without a terminal and a turn handed over through hooks,
   then keep one and split `host.ts` along it.
7. `checks`: one way for an author to check a change and one whole-suite run per turn.
8. Skills: each rule in one place.
9. Web and `packages/protocol`: shared shapes once.
