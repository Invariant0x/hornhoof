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

- Your lane: `/home/altera/hornhoof-network/wt/p1a1`, relay repo, branch `task-p1a1`. Kind: known behaviour, test-first as the plan says. Security class: keys. Task A1's "Tasks 1 to 13 deployed" is paper; it needs only what has landed. The deploy stays David's and Ivan's.
- From a pre-flight against today's code: `MAX_BODY` is at `relay.py:49`. `key_answer` also serves the visitor key: only `visitor=False` reads `key`, and the visitor path keeps ignoring a body. `read_json` can return a non-object: that is `invalid`. Add K to `Stack.private` in tests. Compare keys with `secrets.compare_digest`. The docstring's line for this route changes.
- Mind the R6.1 work that landed since the plan: `ping_keys` keeps retired hashes for live tunnels, and `link_refusal` reads them on `NewUserConn`. A chosen key must retire the old one exactly as a random key does: use the same path, no second copy.

## Two more things in this lane, each from a failing test, in their own commit after A1's

1. From the last review, deferred to the next relay lane: `admin_add` checks `check_name` but not `name_live`, and `relay/hornhoof-relay` does not load `/etc/hornhoof-relay.env`, so `RELAY_FRPS_PASSWORD` is missing there. An operator who frees a name and runs `hornhoof-relay add <name>` while the old owner's http-mode tunnel is connected sends that name's visitors to the old owner. Make `add` refuse a live name as the public API does, using `requested_name_reason`; on `FrpsUnknown` print to stderr and exit 1, not 0. Source the env file when it can be read. `test_r7_4_a_new_owner_never_opens_the_old_owners_tunnel` may then have to put its second binding into SQLite directly. Report at `network-build/runs/batch7-delta-agy.md`, its Important 1.
2. Its Minor: `README.md:43` and `relay/relay.py`'s comments near lines 1285 to 1312 say retired hashes in `ping_keys` serve only a heartbeat, while `link_refusal` now also takes them on `NewUserConn` for a tunnel already logged in. Say what is true.
