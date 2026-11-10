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

- Your lane: `/home/altera/hornhoof-network/wt/p1t8`, relay repo. It starts from Tasks 1 to 6 committed plus Task 7's code, which another writer is still finishing in the real tree (its harness change turns `ROOT` and `BIN` from `.resolve()` to `.absolute()`; when it lands your lane is refreshed, so keep your harness edits away from those two lines).
- This task downloads Caddy's public release from GitHub: allowed, only with the checksum check the task requires, see `/home/altera/hornhoof-network/network-build/briefs/plan1-task8-download-approval.md`. Nothing is sent to GitHub. A mismatch fails and nothing runs.
- `~/.hornhoof-edge` is not on this machine; the task needs nothing from it. `openssl` is available locally. All tests are local: no real hornhoof.org, no real company, ever. Do not give Caddy a real domain's ACME path; the task's replacements keep every certificate on the test CA.
- Caddy gets test ports, not 80 or 443. A replacement that finds nothing raises.
- "Done when" means the whole relay suite through `remote.sh`, both Pythons. `relay/relay.py` should not change in this task.
- Report: `/home/altera/hornhoof-network/network-build/runs/p1t8-report.md`.
