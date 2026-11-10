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


# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/b9fix`, Hornhoof repo, branch `task-b9fix`. Kind: a fix round after a batch's review, each fix from a failing test. Security class: the fence. A read of your delta follows.
- Your fix list is `/home/altera/hornhoof-network/network-build/runs/batch9-merged.md`. Read it, then the three reports it names, from their top. Your lane holds the batch's code: Plan 3 Tasks 1 and 2, the pure `lease.ts`, on batch 6.
- The plan is `/home/altera/hornhoof-network/plans/2026-11-03-network-phase-1-plan-3-fences-and-journal.md`: rulings 1, 2, 12, 13, 19, Review Focus 2, Task 2. Spec: `/home/altera/hornhoof-network/specs/2026-11-02-single-network-design.md`, lines 372-416 and 666-679.
- Edit `apps/server/drizzle/0057_net.sql` in place: it has not landed, nothing ran it on a company. Function bodies do not touch the snapshot; check that `drizzle-kit` sees nothing to generate.
- PGlite runs fenced in the tests, and shares one session. Real Postgres shows what PGlite cannot: `test/real/journal.test.ts` is run on the test machine in your own run, with `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/b9fix /home/altera/hornhoof-network/network-build/remote.sh run --dind b9fix-real 'cd /home/altera/hornhoof-network/hornhoof && npm run test:real'`. Say its log in your reply. The queue may take minutes.
- This changes a migration and a test helper, so your author check runs wide; that is expected. Commit subject: what the fix does, in plain words.
- Plan 3 Task 3's writer works beside you on `client.ts`'s `openPool` and `openDb`: stay in `migrateDb`, its helpers, and what they call, so the batch's cherry-pick stays small.
