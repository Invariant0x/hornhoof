# Pipeline report

Task #353 of department task #308. Hornhoof measures its pipeline for any turn, keeps a snapshot when a turn closes and reports by department, every number with its change in percent against the previous turn and the baseline turn.

## Pieces, in the order they are built

1. Fields and storage: `tasks.work_kind`, `tasks.risk_class`, `turn_snapshots`, `test_part_timings`, one migration with the backfill.
2. Task tools: `create_task`, `update_task`, `plan_turn` and `add_tasks` take the fields, `tasks`, `task` and the API return them.
3. Pure facts (`modules/tasks/pipeline-facts.ts`): stages, critical path, waits by reason, returns, failures, kinds.
4. Reading and snapshot (`modules/tasks/pipeline-report.ts`): facts of any turn, saved on close before the next turn opens, rebuilt from events for a turn closed before this code.
5. Test times (`packages/protocol/src/pipeline-report.ts`, `modules/testruns/timings.ts`): a timing line in the log of each part of a run, read from the log on the task.
6. Report: rows with percent changes, `pipeline_report` for the orchestrator, `GET /api/departments/:id/pipeline`, the third tab of the speed panel.

## What each number means

Every time is in seconds unless it says otherwise. A task is "work" when it has an executor and is not the review of a turn.

| Number | Definition |
| --- | --- |
| Issued | The last `started` event when the task waited for others, else the first `assigned` event, else its creation, never before the turn opened. |
| To acceptance | Issued to `closed_at` of a done work task, median and worst. |
| To first hand-in | Issued to its first `submitted` event that is not the merge, median and worst. |
| Critical path | The longest chain of work and review tasks along `after`, and from a review to the work under the tasks it covers. Each task counts from issued to its end. It is apart from agent time. |
| Whole turn | Opened to closed, or to now. |
| Agent time | The speed panel's per-agent time, summed over the department. |
| Stages | Summed over work tasks. Work: issued to first hand-in. Review: hand-in to the last verdict before the work moves on. Fixes: a returning verdict to the next hand-in. Merge: the last passing verdict, or a hand-in without gates, to the merge. Review of the turn: its task from creation to close. |
| Test run waits | Each run of kind tests from its creation to its end, with the time its parts waited for a machine and ran. Work runs are counted the same way, apart. |
| External waits | Each `wait_for`, by what it names (employee, time, CEO, machine, other), from its `updated` event to the event that ended it, less the time a run of the same task was going on, so a wait for a run counts only as a run. |
| Person waits | Each request from its creation to its answer. |
| Task waits | Creation to `started` of a task that came after others. |
| Queue | Each turn of a task from its creation to its start. |
| Returns | `tasks.bounces`, summed. |
| Fix rounds | Hand-ins after the first, merges left out. |
| Failures | Failed turns of a task, without those Hornhoof ended itself or that no program caused: `handed_on`, `waiting`, `cancelled`, `stale`, `removed`, `switched_off`, `message_not_delivered`, and those cut off by a restart. |
| Interrupted | Turns with an `interruption`. |
| Test selection misses | No source until test selection (#309) records it, so the report says there is no data rather than zero. |
| Later bugs | Bug tasks created after a done task closed that name it as `#number`. A heuristic: a bug that only mentions a task counts too. It is read at report time, as it grows after the snapshot. |
| Test times | For each file the median over the parts it ran in, in setup, tests and teardown. Setup is a file's time outside its tests (the runner's preparing and collecting, and the hooks of the whole file, which have no time of their own) plus what `timed` in the test helpers marks. Teardown is what `timed` marks. A log from before the timing lines gives a file's total only. |

The baseline is turn 7 when the company has run it, else its first turn that ran. Reports never use fixed minutes, only percent against these turns.

The report screen colours a change only where the department wants the number lower. How much work there was (`tasks.*`, `kinds.*.tasks`, `tests.files`, `agents.total`, `agents.work`, `waits.*.parts`) gets a sign but no verdict.

## Release

Additive only: two nullable columns and two new tables. The previous release runs on the new schema and ignores them.
