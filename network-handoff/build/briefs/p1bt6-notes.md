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
**You do not run mutator** (Ivan's word): it runs once, at the end of phase 1, on the riskiest code only.

**How to write tests (Ivan's word).** Uncle Bob's way, without chasing coverage. Put a task's logic in a pure function, tested directly, with no database and no process. Add one or two integration tests per route or per seam, for what only they can show, not one per branch. A test checks what a person of the code would see; if it would still pass with the code wrong, throw it out. Do not add a test only to cover a line or to raise a number. To get a function under CRAP 10, split it first. Do not rewrite or speed up old tests; run only those your change reaches.

**Test runs:** a few tests at a time locally with `/home/altera/hornhoof-network/network-build/light.sh <command>`, from your lane. Full suites,
coverage and mutator go to the test machine, never locally: `REMOTE_EDGE_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run <label> '<command>'`
(`REMOTE_HORNHOOF_TREE=<your lane>` for a Hornhoof lane). It runs in a snapshot of your lane at the usual absolute paths, so inside
it the repository is `/home/altera/hornhoof-network/hornhoof-edge` or `.../hornhoof`, whichever your lane is. Your own gates' results come back to your lane. If `remote.sh` does not exist yet, it is being built: write
your code and focused tests, and check for it before your gates; wait for it rather than run a heavy thing locally.
Gates, inside `remote.sh run`, with `lanebase` as the base:
- relay: `/home/altera/hornhoof-network/network-build/gates-relay.sh lanebase`.
- Hornhoof: `/home/altera/hornhoof-network/network-build/gates-hornhoof.sh lanebase server '<test files>'`.
**You do not run a repository's whole suite.** It takes about 30 minutes in a queue of three slots, so the lead runs it once, when your lane lands. You run your task's own test files and those that touch what you changed, tsc, `npm run typecheck:tests` and `npm run lint`, and the gates above. A task's Done when that names the whole suite means the lead's run.
Start a run in the background if you like, and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <label>` in the foreground, calling it again while it says WAITING. Never end your turn while a run of yours is pending.

# Notes for this task from the build lead

- Your lane: `/home/altera/hornhoof-network/wt/p1bt6`, Hornhoof, on branch network's commits so far (plan 1's fake relay and client, 1b T1, 1b T4, 2 T4).
- Read your rows in `/home/altera/hornhoof-network/network-build/parallel-map.md`: sections 1, 2, 3 (the seams the lead checks at landing), 4 (drift) and 5 (rulings, all taken). Build ruling 5: migration numbers are the plan's plus 11.
- Plans were read at an older main; check each file and line named against the code before you rely on it. A fact that proved wrong goes in your report.
- Report: `/home/altera/hornhoof-network/network-build/runs/p1bt6-report.md`.
- Docker runs on the test machine, walled off from everything else: `REMOTE_HORNHOOF_TREE=<your lane> /home/altera/hornhoof-network/network-build/remote.sh run --dind <label> '<command>'`. The plan's Pebble tests and `npm run test:real` run there, and each real run goes in your report for the ledger. Add a `test:real` command as the plan says. Never point anything at real Let's Encrypt.
- `selfSigned` and `certInfo` are in `apps/server/src/modules/tls/x509.ts`, committed: read them. PEM text ends with a newline. A certificate's SAN names keep their case; compare names lowercased.
