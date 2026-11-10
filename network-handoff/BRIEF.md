# Build Hornhoof's network phase 1, from where it stands

You lead this build from now on. Read `CLAUDE.md` in this folder first: its rules bind you and everyone you give work to.
You do most of the work yourself and organize it: an agent team or subagents, and Google's Antigravity CLI (`agy`) on this
machine. David AI checks the result at the end; you do not wait for him between tasks.

## What is here

- `specs/2026-11-02-single-network-design.md`: the spec, the authority the plans argue from.
- `plans/`: 17 plan files. Start with `2026-11-03-network-phase-1-overview.md`: it gives the order of the plans and what
  depends on what.
- `hornhoof-edge/`: the relay repository (Python, local only). Plan 1 builds here.
- `hornhoof/`: Hornhoof's repository, cloned at origin/main 73d086ba, on the local branch `network`. Later plans build
  here. Run `npm ci` once before its first task.
- `network-build/`: the build record so far. `progress.md` is the ledger: every `Task N: complete` line is done, every
  `Ruling:` line stands. `briefs/` holds the briefs, `runs/` the reports and logs, `runs/codex-lead-journal.md` the
  previous lead's journal. The previous lead was Codex on Ivan's Mac; it is stopped. `mkbrief.sh` and `gates-relay.sh`
  point to Mac paths: change them to this folder before using them.
- `plugins/superpowers`: loaded into this session. Use its skills: subagent-driven-development or executing-plans with
  this ledger, test-driven-development, systematic-debugging, requesting-code-review, verification-before-completion.

## Where it stands

- Plan 1 (relay contract): Tasks 1 to 6 are complete and committed in `hornhoof-edge` (last commit dce89a9).
- Plan 1 Task 7: its writer finished the core change, uncommitted in `hornhoof-edge` (`relay/relay.py`,
  `relay/hornhoof-relay` help text, new `relay/test/test_keys.py`). Its reports are `runs/p1t7-codex.md` and
  `runs/p1t7-codex-detail.md`; its brief `briefs/plan1-task7.md`. The fixture change it needed is approved:
  `briefs/plan1-task7-fixture-approval.md`. What remains: watch the two old cases fail, apply exactly the approved
  fixture edits, run the full suite on both Pythons, the gates, the review, then commit and write its ledger line.
- Then Plan 1 Tasks 8 to 12 (Task 8's public downloads: `briefs/plan1-task8-download-approval.md`), then the other plans
  in the overview's order.

## Step 0: set up the tools

1. Uncle Bob's tools into `~/hornhoof-network/quality`, built the way `hornhoof/apps/node/Dockerfile` builds them (the
   stage with `CRAPPER_COMMIT`, `DRYER_COMMIT`, `MUTATOR_COMMIT`, `TREE_SITTER`): fetch unclebob/crapper, dryer and
   mutator at those exact commits, apply `hornhoof/apps/node/quality/mutator-worker-modules.patch` to mutator, one venv per
   tool with the pinned tree-sitter packages, wrappers in `quality/bin`, download the same grammars, and run
   `test_mutator_workers.py`. Each tool's README is in its folder.
2. Python: the relay suite ran on 3.14 and 3.12. 3.12 is in uv; get 3.14 with `uv python install 3.14`.
3. Check `agy` answers with a one-line prompt before you rely on it.
4. Write the setup as a ledger line.

## How each task goes

From 2026-11-04 evening: `FROM-DAVID-conveyor-v4.md`, sections 2 and 3 (Ivan's conveyor model v4). In short: a fresh
writer per task in its own worktree, test-first, one author check command before hand-in; tasks land in batches on a
staging branch with one check; one review per batch (two reviewers for security work), one fix round, every fix from a
failing test; a ledger line per task with `review: batch <n>`. Antigravity writes with
`agy -p "$(cat brief)" --mode accept-edits --sandbox --dangerously-skip-permissions --effort high --output-format text`
and reviews with `--mode plan`. A Critical still open after the fix round: stop that plan, write a stop report into the
ledger and `QUESTIONS.md`, and go on with a plan that does not depend on it.

At the end of each plan: the whole suite once, one review of the interactions between its batches (two reviewers for a
security plan), one fix pass, the ledger line `Plan P: complete`.

## When you are done, or nothing can go on

Write `~/hornhoof-network/REPORT.md`: per plan and task, the commits, tests, gates, reviewers and rounds; every Ruling;
the deferred minors; what is waiting in `QUESTIONS.md`. Then say in the terminal, in Russian, that the build is done or
stands, and why.
