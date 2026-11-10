# Switch to the conveyor model v4 (Ivan, 2026-11-04 evening)

Ivan asked: reset your agents and go on from where you stopped, by the new model, so the build goes faster. The model
is `specs/2026-11-04-conveyor-v4.md`. It is written for Hornhoof's companies; its sections 4, 4a, 4b and 4c apply here.
This file says what it means for this build, in the order to do it. `CLAUDE.md` and `BRIEF.md` are updated to match
and bind you and everyone you give work to.

## Why

12 of 176 tasks in about 8 hours: at this pace phase 1 takes about five days. Each task gets a writer, your check, two
reviewers and 2 to 3 rounds (ledger: four tasks with 2 rounds, two with 3), and the plan's end gets another review.
Most of the time goes to per-task review rounds and to agents waiting on each other, not to writing.

## 1. Reset the agents, now

1. Start nothing new under the old rules.
2. test-speed: let it finish and write `runs/test-speed-report.md`; it feeds this build and the company's fast suite.
   Put one line about it in `QUESTIONS.md`.
3. Every writer in progress: stop at the nearest green point, or where it stands if red, and commit its work on its task
   branch in its worktree as `WIP <plan> <task>: <where it stopped>`, with the last test output in the body. No push.
   Then shut it down.
4. Reviewers and re-reviewers: shut down. Findings they already wrote stay in `runs/` and go into the batch review.
5. Ledger: `Ruling: switched to conveyor v4 (Ivan, 2026-11-04) - why: per-task review rounds cost most of the time -
   cost if wrong: a defect is found at the batch review instead of per task and fixed in the same batch`.
6. Go on from the ledger. Completed tasks are not redone. A task with a WIP commit resumes from it with a fresh writer
   on the new brief.

## 2. How a task goes now

1. Kind. The plans give exact tests, so almost every task is known behaviour: test-first as its plan says. A bug: a
   failing test that reproduces it, then the fix. A task whose way is unclear (a library or protocol not used here yet):
   one acceptance test from the plan first, then make it work, decompose into pure functions, cut what is extra, then
   direct fast tests on the pure functions. Old code without tests: characterization tests first, then structural
   commits apart from behaviour commits.
2. Writer: a fresh agent per task, in its own worktree on `task-<plan>-<n>`, on an area no other open task touches (the
   area stays locked until the earlier task there has landed). Sonnet for simple tasks, Opus for security work;
   Antigravity can write simple tasks too.
3. Author check, one command, run by the writer before hand-in: related tests (`hh-related.sh` against the task's base),
   types, lint, crapper under 10 and dryer 0.8 on the changed functions, crapper reading the coverage of that same
   related run (no second coverage run). At most two tries to fix its own red, then it comes to you.
4. Hand-in: the commit and the path of the check's log in `runs/`. That log on that commit is the evidence; nobody
   reruns it. You check the hand-in against the plan's task (did it build what the plan says), no review agent per
   task.

## 3. Batches

1. A batch: handed-in tasks, up to about 800 changed lines, or a plan's end, whichever comes first.
2. Land it on a staging branch `batch-<n>` from `network` and run one check: `hh-related.sh` against the batch's base;
   the whole suite (`hh-suite.sh` on home-api) only when the batch holds a migration, a script, the install or update
   path, or a plan's end. Green: fast-forward `network`. Red: bisect by tasks; the breaking task goes back to its writer;
   a failure that only two tasks together cause comes to you.
3. One review of the batch, by readers who wrote none of it, read only. Security class (keys, TLS and certificates,
   relay routing, sign-in and access, secrets, anything on the network boundary): two at once, a fresh Claude on the
   most capable model and Antigravity `--mode plan`. Everything else: one. Over about 800 lines: split by vertical
   slices of tasks, not folders; every reviewer gets the shared contracts (protocol, schema, the relay contract) and one
   is named for the interactions between slices.
4. One fix round. Every fix starts with a failing test. Only for a blocking finding on security, data or the spec, the
   reviewer who raised it reads the fix's delta (`<reviewed commit>..<fix commit>`) at medium effort, minutes; other
   fixes are covered by their tests and the next batch's check. No third round. A Critical still open after that goes
   to `QUESTIONS.md` and its plan stops, as before.
5. Ledger line per task as before, with `review: batch <n>` instead of per-task reviewers and rounds.
6. A plan's end: the whole suite once; the plan-end review reads only the interactions between its batches, one reviewer
   (two for a security plan).

## 4. Tests

- As in `CLAUDE.md`: pure logic with fast tests, a few integration tests per seam, only what the change reaches per
  task, the whole suite per batch only when the list above says so, mutator once at the end of phase 1.
- `hh-related.sh` misses two cases: a change in `packages/protocol` runs only protocol's own tests, not the apps that
  use it; a change in `templates/` runs nothing. For those, run the whole package of each affected app (server for
  templates; server, node and web for protocol).
- Deterministic tests: nothing depends on the date, the time zone, the order of tests, randomness or ids; a flaky test
  is fixed at its cause, never retried.

## 5. Keep everyone busy, keep the machines calm

- While a batch is checked or reviewed, writers take the next ready tasks in other areas (`parallel-map.md`): as many
  writers as there are ready tasks on separate areas, up to six, within the Claude plan's limits.
- Heavy runs (whole suites, Docker) only on home-api; on a-host at most two test runs at once, `nice -n 10`,
  `--maxWorkers=2`.

## 6. Measure

Keep in the ledger per task: written, handed in, landed. After the next three batches, write to `QUESTIONS.md` the tasks
per hour before (12 in about 8 hours) and after, and what waits longest now.

## What does not change

`CLAUDE.md`'s rules on security, git, this machine and home-api; the plans and their Global Constraints; TDD.
