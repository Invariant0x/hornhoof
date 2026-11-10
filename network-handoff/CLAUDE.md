# Rules for the network build on this machine

This folder (`~/hornhoof-network`) is where Hornhoof's network phase 1 is built. The owner is Ivan Korol. David AI (Claude
on Ivan's Mac) set it up and checks the results at the end. Every rule here applies to you and to everyone you give work
to: teammates, subagents, Antigravity. Put these rules into every brief you write.

## Talking

- Ivan watches this terminal. Say what you are doing in Russian, short and simple, one or two lines between steps.
- Files, code, commits, ledger lines, briefs: English.

## Code

- TDD for everything: the failing test first, watch it fail for the right reason, then the code, then watch it pass.
  A bug is fixed only after a test reproduces it.
- Uncle Bob's clean code: small functions, names that say what things are, no duplicated logic.
- Tests the Uncle Bob way, without chasing coverage (Ivan, 2026-11-04): logic in a pure function with direct, fast
  tests; one or two integration tests per route or seam; no test only to cover a line or raise a number. Old slow tests
  are not rewritten.
- Gates on every task, on the changed code: `crapper` (every changed function CRAP under 10, split first), `dryer
  --threshold 0.8` (no duplicate pair). A task runs only the tests its change reaches (`network-build/hh-related.sh`),
  types and lint; the whole suite runs at a plan's end or before a merge, and at once for migrations, scripts and the
  install and update path.
- How tasks, batches and reviews go: `FROM-DAVID-conveyor-v4.md` (Ivan, 2026-11-04 evening). One author check per
  task, one review per batch, one fix round; no review agents per task. Tests are deterministic (no dependence on
  the date, the time zone, the order of tests, randomness or ids); a flaky test is fixed at its cause, never retried.
- `mutator` never per task and never against tests with real processes or databases (it reruns the tests per mutant).
  It runs once at the end of phase 1, only on the riskiest pure logic, against that logic's fast tests. A survivor is
  killed by a new direct test or ruled on in the ledger with why. Tools in `~/hornhoof-network/quality/bin`.
- Hornhoof's own rules: `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.
- Comments: plain sentences that say why. Never use em dashes, in code, docs, commits or messages.
- Each plan has Global Constraints; they bind.

## Git

- Commit only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit ...`.
- No trailers: no Co-Authored-By, no "Generated with", no Claude-Session lines.
- Never commit `notes/`, `.superpowers/`, `.claude/`, `node_modules/`, `archive/`, `companies/`, `deploy.env`, `.metrics/`.
- No push, no new remote, no pull request, no branch on GitHub. `hornhoof-edge` has no remote and keeps none. The
  `hornhoof` clone works on its local branch `network`.
- Never rewrite history that is already committed (no rebase, no reset of committed tasks, no force).

## Security

- Never print a secret value: keys, tokens, passwords, generated visitor keys. A generated key lives only in its one
  response; tests compare it with booleans and fixed messages.
- Never put Ivan's email or any personal data into a request to an outside service.
- Never read or copy credentials: not `~/.claude` credentials, not `~/.gemini`, not `~/.ssh`, not any Docker volume. The
  one key you use is `~/hornhoof-network/.ssh/home-api`, for the test machine below.
- Nothing on the relay droplet: no ssh to it, no deploy. Its keys are not on this machine; never ask for them.
- GitHub: reading is fine (the clone is done). Public release downloads with their checksum checked are fine (see
  `network-build/briefs/plan1-task8-download-approval.md`). Nothing is sent to GitHub.

## This machine

- It is a-host. It also runs Ivan's company Hornhoof in Docker (containers named `hornhoof-*`) and belongs to his family.
- Never touch Docker that is not yours: no stop, restart, exec, rm, prune, nothing under `/var/lib/docker`. Docker is not
  needed for this build; if a plan step asks for it, write it to `QUESTIONS.md` and go on with other work.
- No sudo. Work only inside `~/hornhoof-network`. Other folders in the home belong to the machine's owner: do not read or
  change them.
- Keep the load moderate, the company runs here: `nice -n 10` on test and gate runs, vitest with `--maxWorkers=2`, at most
  two heavy runs at once. About 7 GB of memory is free.
- The Claude plan here has limits. If you hit one, wait for the reset; never switch accounts.

## The test machine home-api

Ivan lends his home server for heavy test runs: 8 cores, 94 GB of memory, about 50 GB of free disk. Use it for the full
Hornhoof suites, Docker-based tests and anything too heavy for this machine.

- Reach it only with `ssh -F ~/hornhoof-network/.ssh/config home-api` (user ubuntu). The key in
  `~/hornhoof-network/.ssh/home-api` is this build's own; never copy it anywhere and never print it.
- Work there only inside `~/hornhoof-network-tests`. Copy code in with rsync over that ssh; nothing goes back but results.
- It also runs Ivan's other projects and his company's node: the containers `hornhoof-machine-*` and `k3d-*`, and
  everything outside `~/hornhoof-network-tests`, are not yours. Never stop, restart, exec into, remove or prune them.
- Node and Docker: Node is not installed on the host, so run Node and the Hornhoof suites inside a container of your
  own. `sudo -n docker` works; use sudo only for `docker`, and only on containers, images and volumes you created,
  all named with the prefix `hnb-`. No other sudo. Never `docker system prune` or `docker image prune -a`.
- Disk is 80% full: remove your own containers, images and build caches when a run ends.

## When you cannot go on

- An irreversible or destructive step, a security-sensitive step, or a side effect outside this folder (push, deploy,
  anything on the droplet): do not do it. Write it to `~/hornhoof-network/QUESTIONS.md` with what and why, and go on with
  work that does not depend on it. David AI reads that file.
- Every decision you make where a plan is unclear goes into the ledger as `Ruling: <what> - why: <why> - cost if wrong:
  <cost>`.
