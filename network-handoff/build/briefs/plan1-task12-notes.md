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
`hornhoof/templates/skills/dev-engineering-rules.md`. Uncle Bob's three gates (crapper under 10, dryer no pair at 0.8, mutator killed) apply to
every line you change.

**Test runs:** a few tests at a time locally with `/home/altera/hornhoof-network/network-build/light.sh <command>`, from your lane. Full suites,
coverage and mutator go to the test machine, never locally: `REMOTE_EDGE_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run <label> '<command>'`
(`REMOTE_HORNHOOF_TREE=<your lane>` for a Hornhoof lane). It runs in a snapshot of your lane at the usual absolute paths, so inside
it the repository is `/home/altera/hornhoof-network/hornhoof-edge` or `.../hornhoof`, whichever your lane is. Your own gates' results come back to your lane. If `remote.sh` does not exist yet, it is being built: write
your code and focused tests, and check for it before your gates; wait for it rather than run a heavy thing locally.
Gates, inside `remote.sh run`, with `lanebase` as the base:
- relay: `/home/altera/hornhoof-network/network-build/gates-relay.sh lanebase`, then `/home/altera/hornhoof-network/network-build/mutate.sh /home/altera/hornhoof-network/hornhoof-edge lanebase relay/relay.py '<python3.12> -m unittest <scoped modules>'` for each changed non-test file.
- Hornhoof: `/home/altera/hornhoof-network/network-build/gates-hornhoof.sh lanebase server '<test files>'`, then `/home/altera/hornhoof-network/network-build/mutate.sh /home/altera/hornhoof-network/hornhoof lanebase <file> 'cd apps/server && npx vitest run <test files> --maxWorkers=1'`.
A survivor is killed by a new test (see it fail first), or listed in your report with why it is equivalent, for the lead to rule on.

# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p1t12`, Hornhoof. It starts from Hornhoof 73d086ba plus Task 11's new fake relay, which another writer is still finishing (`apps/server/test/fake-relay.ts`, `fake-relay.test.ts`); a few of its tests may still change. Do not edit those two files here: anything you need of the fake goes in your report, for the lead.
- Plan line references were read at an older main; check each against the code. A fact that proved wrong goes in your report.
- The whole-suite part of the task's Done when goes through `remote.sh`: `npm test -- --testTimeout=90000` from the repo. `tsc`: `npx tsc -p apps/server/tsconfig.json --noEmit`.
- The link key goes only into the `authorization` header, never into a result, an error or a log line. Tests compare it with booleans and fixed messages.
- Report: `/home/altera/hornhoof-network/network-build/runs/p1t12-report.md`.
