# Planned node updates implementation plan

> **Execution:** inline, under the already approved task #299. Use executing-plans and test-driven-development.

**Goal:** planned updates let running turns and run parts finish before replacing a node.

**Architecture:** one coordinator beside updates/drain.ts owns waiting, postponement, retry and restart state. Placement and run allocation consult it without changing connection readiness. Installers ask the same coordinator before stopping a node. Restart state survives a server restart in the existing control directory.

**Tech stack:** TypeScript, Fastify, Drizzle, Vitest, bash.

**Spec:** Hornhoof tasks #298 and #299; API agreement with #300 in #299 comments.

## Constraints

- Branch task-299 from origin/turn-7; never change main.
- English code and commits, no em dashes, no commit trailers.
- npm ci; test changed areas only. Heavy verification uses run_tests on a free Linux machine.
- No mutator. Run crapper, dryer, tsc, lint and typecheck:tests.
- Wait and retry defaults follow measured job durations; both are configurable.

## Review focus

- A reconnect of the same node generation must not release a restart hold.
- Allocation already in progress when draining begins must not deliver a new job.
- The built-in node and personal nodes on the server host must survive the app replacement without new work in between.
- Deadline expiry preserves jobs and identifies the affected turns to Operations in each company.
- Confirmation must cover the current number of interrupted turns, including other companies affected by the restart.

### 1. Coordinator and allocation

Files: protocol index, updates/drain.ts and node-drain.ts, nodes update routes/lifecycle, conversation/queue.ts, testruns/runs.ts, jobs/dispatch.ts, config.ts. Tests: node-drain.test.ts, placement.test.ts, testruns tests.

- [ ] Write and run failing integration tests for authenticated preparation, ongoing work, deadline/retry, restart generation, API view and allocation.
- [ ] Implement the shared coordinator and MachineDrain union. Keep hub.isReady unchanged.
- [ ] Connect existing placement and run allocation. Recheck before delivery.
- [ ] Verify targeted tests and commit.

### 2. Update controls and installer handshake

Files: updates/routes.ts and control.ts, node update command, scripts/install.sh, apps/updater/updater.sh. Tests: updates.test.ts, node update command tests, install-script.test.ts, updater.test.ts.

- [ ] Write and run failing tests for confirmation, planned shell updates, errors and urgent bypass.
- [ ] Add confirmation with a fresh count, and the authenticated service handshake. The installer waits through deferred retries without stopping live work.
- [ ] Verify bash behavior with repository stubs and commit.

### 3. Evidence and delivery

- [ ] Record duration measurements, default wait/retry rationale, and the update paths found in the source. Distinguish source evidence from the historical incident.
- [ ] Push task-299; run changed-area tests and checks on a free Linux machine with npm ci.
- [ ] Read full logs, run crapper and dryer on the changed files, review the complete diff.
- [ ] Submit with exact branch/commit/evidence, then merge into fresh turn-7 as #299 directs.

## Ledger

- Read #298/#299 and repository rules. CLAUDE.md is absent. The task overrides CONTRIBUTING sign-off and full-suite advice.
- API agreed in #299: MachineDrain waiting/postponed/restarting; confirmTurns with turns_would_stop; machine_updating in AgentState.
- No SQL tool is exposed to this developer. Requested an aggregate-only SELECT through the head in #299.
- npm ci completed with exit 0. npm reported 15 moderate vulnerabilities; dependency updates are outside this task.
