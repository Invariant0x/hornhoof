# Where the time of turns and tasks goes (2026-11-17)

Measured on the live company hornhoof-team from 2026-11-14 13:00 to 2026-11-17 13:00 UTC: turns 29 and 31 of Development
(28 and 30 are the open turns of Operations and Design and hold no tasks), about 410 tasks, about 5,300 agent turns
(`jobs`), 38 whole runs of releases, and 674 commits and 317 merges on `turn-32` since 2026-11-14. Read only.

Three kinds of hours appear below, and they do not add up to each other:

* **task-hours**: the time a task stands in a state, summed over tasks that stand there at once;
* **agent-hours**: the time agents' programs ran, which is plan time spent;
* **calendar hours**: time on the clock, for one release or one task.

## How a finished task's time splits

256 tasks with an executable or document result (turnkey, code, document), created after 2026-11-14 13:00 and not
cancelled, stood 1,542 task-hours from creation to close (median 2.1 h, 90th percentile 19.4 h, worst 44.5 h). Each moment
of a task is counted once, in the first state of this list that holds it:

| State | Task-hours | Share | Tasks | Median | Worst |
| --- | ---: | ---: | ---: | ---: | ---: |
| Its agent works on it | 329 | 21% | 241 | 0.6 h | 11.7 h |
| Turn queued, its agent busy with another turn | 108 | 7% | 106 | 0.2 h | 14.4 h |
| Turn queued, agent free, no plan or node slot | 144 | 9% | 244 | 0 | 6.9 h |
| A test run of the task | 12 | 1% | 8 | 1.2 h | 4.2 h |
| A question to a person | 19 | 1% | 6 | 0 | 14.3 h |
| `wait_for` a release to ship or the next turn to open | 462 | 30% | 63 | 4.4 h | 38.0 h |
| `wait_for` someone else to merge, or a go-ahead to merge | 86 | 6% | 28 | 0.4 h | 19.1 h |
| `wait_for` a review or security verdict, or a review wait | 52 | 3% | 45 | 0 | 16.4 h |
| `wait_for` a test or check run | 29 | 2% | 12 | 0.5 h | 19.3 h |
| `after` another task | 33 | 2% | 7 | 4.8 h | 11.3 h |
| Other waits (people, reports, logs) | 22 | 1% | 12 | 0.5 h | 12.8 h |
| Nothing recorded (idle) | 243 | 16% | 256 | 0 | 20.9 h |

The reason of each `wait_for` is the agent's own line in `task_events`; it was sorted by words (release, version, tag,
turn opening; merge, fast-forward, rebase; verdict, review; run, tests) and spot-checked by hand. The median task spends
48% of its time with its agent at work; the rest is waiting.

The 125 coordination-only parents (a third of all tasks) stood 1,054 task-hours, 48% of them waiting for their children.
Their reports up the chain are quick: from the last child closed to the parent closed, median 1 minute, 90th percentile
1.4 h, worst 9.8 h (#876), 34 h in all.

## Findings

Ranked by what they cost. "Fixed" means changed on branch `iv-turn-speed` with tests.

1. **Finished work waits for a release to ship.** A release had to be the head of the turn branch, and every result of
   the turn had to be in it, so while a whole run and an approval were under way nothing could join the turn branch. Heads
   told members to hold finished, checked work "until 0.29.0 ships and turn 30 opens", and members did. Cost: 462
   task-hours on 63 tasks (median 4.4 h, worst 38.0 h on #1013, 36.0 h on #1022, 25.6 h on #1012), and the next releases
   started later by the same hours. Do: a release is any commit of the turn branch with a green whole run, the branch goes
   on taking work, and what joined after that commit goes into the next release. **Fixed** in the server (`release_turn`)
   and in `dev-ci-release`, `dev-lead` and `dev-task-flow`.

2. **Turnkey work waits for the head to merge it or to say go.** Turnkey members finished, then waited with lines like
   "Head merges task-1232 into turn-31 or tells me to fast-forward it myself". The server already lets a turnkey holder
   close its task once the turn branch holds its branch; the skill only said "hand in the branch". Cost: 86 task-hours on
   28 tasks (median 0.4 h, worst 19.1 h on #1014, 16.5 h on #1041), plus a head turn for every such question. Do: the
   holder merges its own branch into the turn branch and reports done in the same turn, waiting for nobody. **Fixed** in
   `dev-task-flow` and `dev-lead`.

3. **Every merge of the turn branch into a task branch reran the checks.** 166 merges of a turn branch into 65 task
   branches in three days (median 2 per branch, worst 19 into the release-notes branch), each followed by the task's named
   checks again, though every test runs together once per release. Local checks took 82 agent-hours of tool time
   (Playwright 32, Vitest 32, builds, types and lint 18), plus about 31 agent-hours of agents polling their own background
   checks with `sleep` loops; the share spent after merges is not separable in the data. Do: take the turn branch in only
   where it conflicts, a clean merge needs no new checks, and after a conflict check the files touched. **Fixed** in
   `dev-task-flow`.

4. **Turns that hang or are cut off burn plan time and stop their task.** 355 agent-hours went to turns that ran over an
   hour and ended with no result: 62 cancelled (169 h), 13 ended by a machine restart (116 h, median 6.7 h each, worst
   16.4 h), 14 stale (60 h). Tasks stood with nothing recorded after a turn alarm (`node_silent`) for 70 task-hours (12
   cases, median 4.8 h, worst 17.4 h on #1108 and #1111). The two agents that answer such alarms are queues of their own: Program
   operator had a turn waiting in 56.6 of 72 hours (worst wait 33 h), Head of operations in 47.5 of 72 hours (worst
   23.5 h). Do: Operations puts more than one operator on alarms, or splits the operator's work, so an alarm is looked at
   within minutes. **Not fixed**: by Ivan's rule a hung terminal is a signal for an Operations employee to look at the
   screen, not a code rule per failure kind, and staffing is the department's own decision.

5. **Releases take many whole runs.** 38 whole runs of releases in four days, 4 green: 0.23.6 took 12 runs over 17.8 h,
   0.29.0 13 runs over 6.5 h, 0.31.0 4 runs and no green in 5.3 h. 21 runs failed on test files, mostly one or two and a
   different one almost every time (`turns.test.ts`, `improvements.test.ts`, `motion.spec.ts`, `turn-releases-migration.test.ts`,
   `terminal-host-view-size.test.ts`, `keeper-peer.test.ts`, `Inbox.test.tsx`, `phones.spec.ts` and others), 7 lost a part
   to a cancelled machine or a failed setup (5.0 h). In all, 23 calendar hours of release runs, with the turn branch
   frozen behind them until finding 1. Do: one task per file that failed only under load, making it independent of speed;
   reruns take only what failed or changed. **Not fixed** here: each file is its own task for the turnkey team.

6. **Turns queue for a plan or node slot while the agent is free.** 144 task-hours on 244 tasks (worst 6.9 h on #1152);
   by agent, Head of Development 63 h, Code reviewer 36 h, Neo 29 h, Design's Gemini designer 21 h, mostly on the one
   Opus plan the department shares. Do: fewer agents on that plan at once or more plans. **Not fixed**: capacity, and Ivan
   said no to moving that plan to another machine.

7. **Turns queue behind the same agent's longer turn.** 108 task-hours on 106 tasks (worst 14.4 h on #1052). Head of
   Development ran 1,260 turns in four days (about 13 an hour), most of them reports, messages and wait ends, each a turn
   of its own. Do: fewer messages to heads; findings 1 and 2 remove the go-ahead and merge requests. **Partly fixed** by
   findings 1 and 2.

8. **Releases wait for a person's yes.** 10 release approvals waited 35.4 h for a person (median 1.75 h, worst 9.8 h);
   0.29.0 was green at 05:15 and approved at 09:41. Development has autonomous release on, but it approves only a release
   whose every commit a checker other than its author passed, and turnkey work, now most of the work, has no such checker,
   so every release still asks a person. Do: let autonomous release count a turnkey holder's own review and security check,
   as Ivan's rule on turnkey members says. **Not fixed**: it changes the condition of autonomous release itself and needs
   Ivan's word.

9. **Paused and blocked tasks stand with nothing to show.** 54 task-hours paused (median 10.7 h) and 53 task-hours
   blocked (median 5.8 h, worst 20.9 h on #1092). These are decisions, not conveyor gaps. **Not fixed**: nothing to change
   in code or skills.

10. **Record-only commits.** 47 of 674 commits only record something: 19 commit check logs into `docs/evidence/` or
    `docs/task-*` (94 such files, 719 KB, on `turn-32`), 25 add one task's line to the release notes, 3 record a report;
    the notes branch took 19 merges of the turn branch. Their own tool time is small, under an hour; the cost is the merges
    and reviews they cause and the files the repository keeps. Do: proof goes into submit or report, long logs as
    attachments; release notes are written once, when the release is prepared. **Fixed** in `hh-task-flow`,
    `dev-ci-release` and `dev-release-notes`.

11. **Design references are made three times.** 12 design variants (Claude, Gemini, Codex) in three days, 6 of them
    cancelled. This is a choice of the Design department, not a gap. **Not fixed**.

## What changed

* `release_turn` takes any commit the turn branch holds, with its own green whole run, not only the head. The release
  brings the results that commit holds and names the ones it leaves (`left`); those go into the next turn when the tag
  closes this one, as before. Coverage and autonomous approval are judged on what the release brings.
* `dev-task-flow`: a turnkey holder merges its branch into the turn branch itself and closes the task in the same turn,
  waits for no go-ahead, release or next turn, and checks again only after a conflict it resolved.
* `dev-lead`, `dev-ci-release`: the turn branch never stops for a release; nobody is told to hold a finished result;
  `release_turn` takes the commit the whole run checked.
* `hh-task-flow`: logs and proof of checks go into submit or report, never into commits of their own.
* `dev-release-notes`, `dev-ci-release`: release notes are written once per release, with no note committed per task.

## How it was measured

Each task's lifetime from `tasks.created_at` to `closed_at` (or 13:00 UTC on 2026-11-17) was cut at every start and end of
its turns (`jobs`), test runs, questions (`requests`), waits (`task_waits`, with the reason line `wait_for` wrote to
`task_events`) and children. A queued turn counts from `max(created_at, not_before)` to `started_at`; it is "agent busy"
where the same agent ran another turn meanwhile. Tool time is the gap between a `tool` and its `tool_result` in
`agent_events`, under 6 h. Release runs are `test_runs` on `release-*`, `turn-*` and `main`, with the failed files and
errors of their parts.
