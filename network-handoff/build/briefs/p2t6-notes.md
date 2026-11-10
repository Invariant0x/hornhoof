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

- Your lane: `/home/altera/hornhoof-network/wt/p2t6`, Hornhoof repo, branch `task-p2t6`. Kind: known behaviour, test-first as the plan says. Security class: the network boundary, TLS.
- Your lane stands on batch 6 (2 T3, 1b T7, sql-check) and on 1b T8 and 2 T5, both handed in and waiting for their batch. Their commits sit below your `lanebase` (tag), so they are not yours. Fix rounds on the app's modes and the certificate check are being done beside you and reach your base later. `AppMode`'s public shape stays; `store.ts`'s `isKeyOf` and `mayRunHttps` gain checks. Do not change those parts.
- Left to you by Task 5, in its writer's words: the TLS door's `x-forwarded-proto` and `linkVisitor`, `keeper.json`'s link, the `linkTls` port (0 for now), and frpc. Its http door adds `x-forwarded-proto: https`, the front port never does, and `/api/health` through front answers in maintenance as a read; keep that.
- `LinkTls` in `apps/server/src/modules/tls/manager.ts` takes a listener through `serveOn`; with none it counts as not holding the certificate, so http. Its ruling reads: "plan 2 says link-tls.test.ts gives LinkTls a fake Served". Meet that here: what `served.ts` hands it must be what the listener really holds.
- `PublicLinks.sync()` runs in turn with `set` and `remove` through a private `writeSettings`, because the manager is a second writer of `tunnel.json`. If the keeper becomes the writer of the tunnel's settings in this task, it stays one writer at a time.
- One carry for you, in your file: 1b T7 is under you now, so add the plan's `acmeDirectory` assertion (Let's Encrypt's) to "loads the keeper's environment and nothing more" in `apps/server/test/config.test.ts`.
- Plan 3 Task 4 will add `lease` to `KeeperOptions`: do not add it.
