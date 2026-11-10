# How this build works now: lanes, skills and rules

You work in your own lane, your own clone of the repository, at the path in the notes below. Other writers work beside you in
theirs. Work only in your lane: do not touch the real repositories (`/home/altera/hornhoof-network/hornhoof`,
`/home/altera/hornhoof-network/hornhoof-edge`) or another lane. The lead reviews your lane's change and lands it; you never stage or
commit, and you do not rebase. The tag `lanebase` marks where your lane started, and your lane may be moved forward by the lead
(`lane.sh refresh`) when earlier work lands: conflict markers then are yours to settle.

**Rules that bind you, and they are not optional, Ivan's word:** `/home/altera/hornhoof-network/CLAUDE.md` and the build rulings below.
Before you write a line, read these skills and follow them, and name them in your report, or the lead sends the task back:
`test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion` before you claim anything, in
`/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`. For Hornhoof also `hornhoof/AGENTS.md` and
`hornhoof/templates/skills/dev-engineering-rules.md`. Uncle Bob's gates crapper (under 10) and dryer (no pair at 0.8) apply to every line you change.
**You do not run mutator** (Ivan's word): it runs once per plan, at the plan's review, on all its tasks' changes, and its survivors come back to you as findings.

**Test runs:** a few tests at a time locally with `/home/altera/hornhoof-network/network-build/light.sh <command>`, from your lane. Full suites,
coverage and mutator go to the test machine, never locally: `REMOTE_EDGE_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run <label> '<command>'`
(`REMOTE_HORNHOOF_TREE=<your lane>` for a Hornhoof lane). It runs in a snapshot of your lane at the usual absolute paths, so inside
it the repository is `/home/altera/hornhoof-network/hornhoof-edge` or `.../hornhoof`, whichever your lane is. Your own gates' results come back to your lane. If `remote.sh` does not exist yet, it is being built: write
your code and focused tests, and check for it before your gates; wait for it rather than run a heavy thing locally.
Gates, inside `remote.sh run`, with `lanebase` as the base:
- relay: `/home/altera/hornhoof-network/network-build/gates-relay.sh lanebase`.
- Hornhoof: `/home/altera/hornhoof-network/network-build/gates-hornhoof.sh lanebase server '<test files>'`.
Hornhoof's whole suite: `cd /home/altera/hornhoof-network/hornhoof && /home/altera/hornhoof-network/network-build/hh-suite.sh`, inside `remote.sh run`.
Start a run in the background if you like, and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <label>` in the foreground, calling it again while it says WAITING. Never end your turn while a run of yours is pending.

# Notes for this task from the build lead

- A fix round on Plan 1 Task 8, in the lane `/home/altera/hornhoof-network/wt/p1t8`. Its writer's session has ended; you take over its lane as it stands. Read its report `network-build/runs/p1t8-report.md`.
- Your whole job: `network-build/runs/p1t8-r1-merged.md`. Nothing else in this task changes. The task's text below is background.
- The whole relay suite on both Pythons and `gates-relay.sh lanebase` through `remote.sh`, with `REMOTE_EDGE_TREE=/home/altera/hornhoof-network/wt/p1t8`, once at the end. A failure of test_restart_burst alone with `relay error: busy` is a known finding, not yours.
- Append a fix report to `network-build/runs/p1t8-report.md`: the test, how it failed first, the fix, command results, the skills you read.
