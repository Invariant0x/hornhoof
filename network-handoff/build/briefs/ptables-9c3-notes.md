# How this build works now: conveyor v4, Ivan's word

Rules that bind you, not optional: `/home/altera/hornhoof-network/CLAUDE.md`, the build rulings below, and
`/home/altera/hornhoof-network/FROM-DAVID-conveyor-v4.md`, sections 2 to 4. You are a fresh writer for one task, in your own lane, your own clone of
the repository, on the branch `task-<lane>`. Other writers work beside you in theirs. Do not touch the real repositories or another lane.

**Skills.** Before you write a line, read and follow, and name in your hand-in: `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion`, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`. For Hornhoof also `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.

**The task's kind** is in your notes. Known behaviour, nearly every task, since plans give exact tests: test-first, as the plan says. A bug: a failing test that reproduces it, then the fix. An unknown way (a library or protocol not used here yet): one acceptance test from the plan first, then make it work, split into pure functions, cut what is extra, then direct fast tests on the pure functions. Old code with no tests: characterization tests first, then structural commits apart from behaviour commits.

**How to write tests.** Uncle Bob's way, without chasing coverage. Logic in a pure function, tested directly, with no database and no process. One or two integration tests per route or seam, for what only they can show, not one per branch. A test checks what a person of the code would see; if it would pass with the code wrong, throw it out. No test only to cover a line or raise a number. To get a function under CRAP 10, split it first. Tests are deterministic: nothing depends on the date, the time zone, the order of tests, randomness or ids; a flaky test is fixed at its cause, never retried. Old tests are not rewritten. Never a secret in a test's message: compare with booleans.

**While you work,** run a few tests at a time from your lane with `/home/altera/hornhoof-network/network-build/light.sh <command>`, with at most `--maxWorkers=2`. You do not run a repository's whole suite, and you do not run mutator.

**Hand-in, one command, once, on your final commit:**

1. Commit your work on your branch: write the message to a file (English, a subject as the plan's Commit step names it, then why; no trailers; no em dashes), then `/home/altera/hornhoof-network/network-build/lane.sh commit <lane> <file>`.
2. The author check, on that commit. Hornhoof: `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof && /home/altera/hornhoof-network/network-build/author-check.sh lanebase'`. Relay: `REMOTE_EDGE_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof-edge && /home/altera/hornhoof-network/network-build/author-check-relay.sh lanebase "<the unittest modules your change reaches>"'`. It may queue. Start it in the background and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <lane>-check` in the foreground, calling it again while it says WAITING. Never end your turn while it is pending.
3. Red: at most two tries to fix your own red, each commit followed by the check. Still red: stop and tell the lead.

**Reply to the lead:** the status (DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT), the commit, and the log path `network-build/runs/remote-<lane>-check-*.log`, in at most five lines. That log on that commit is the evidence, and nobody reruns it. There is no review agent per task; tasks land in batches, and the batch gets one review and one fix round. A deviation from the plan, and every place where the plan proved wrong, goes in your commit message's body and your reply, as a line `Ruling: <what> - why: <why> - cost if wrong: <cost>`. Never push. No subagents.


# Notes for this lane from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/ptables`, Hornhoof repo, branch `task-ptables`. Kind: known behaviour, test-first as each plan says. No database, no process, no clock: these are pure tables, and they are mutator targets at the end of phase 1, so the table of cases matters. Test each row and each boundary on both sides.
- This lane holds three small parts, three commits, one author check on the last. Each has its own brief with the plan's top: `network-build/briefs/ptables-9c3-brief.md`, `ptables-97-brief.md`, `ptables-9c9-brief.md`. Read all three first. "Starts from" lines are paper here: each part goes ahead of its plan because it needs nothing that has not been written.
  1. Plan 9c Task 3, whole: `apps/server/src/modules/keeper/switch-step.ts`, `apps/server/test/switch-step.test.ts`. Write the tables as they are; the rows of plans 10 and 11 come with those tasks.
  2. Plan 9 Task 7, only `apps/server/src/modules/keeper/sync-step.ts`, `apps/server/test/sync-step.test.ts`. `sync.ts`, `slots.ts`, the keeper and `lease-store.ts` stay for that task's own writer. `SyncRecord` has `state, copy, epoch, generation, at`. `hold`'s rows belong to 9c Task 9, not here.
  3. Plan 9c Task 9, only `apps/server/src/modules/keeper/update-steps.ts`, `apps/server/test/update-steps.test.ts`. `UpdaterStatus` is at `modules/updates/control.ts:6`, with no `promise` step today, so in the sample's type write `step: UpdaterStatus['step'] | 'promise'`; that task adds it to the union later and drops the local part. Do not change `control.ts`.
- `Term`, `LeaseKind`, `LeaseSync` are in `apps/server/src/db/net.ts`, below your `lanebase` (Plan 3 Tasks 1 and 2, not landed yet). Use type imports.
- Commit subjects name only the part you wrote when it is a part (2 and 3), since the plan's subject stays for that task's own writer. If a plan's text and the code disagree, stop and say which, with a Ruling line.
- `/* */` comments, as `apps/server` writes them (AGENTS.md: match the code around you).
