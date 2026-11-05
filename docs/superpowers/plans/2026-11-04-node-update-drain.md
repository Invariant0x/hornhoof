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
- The app goes in first and the nodes follow: an update never replaces a node with work unless it is confirmed or urgent. The hold still survives an app restart, since it lies in the control folder.
- Deadline expiry preserves jobs and identifies the affected turns to Operations in each company.
- Confirmation must cover the current number of interrupted turns, including other companies affected by the restart.

### 1. Coordinator and allocation

Files: protocol index, updates/drain.ts and node-drain.ts, nodes update routes/lifecycle, conversation/queue.ts, testruns/runs.ts, jobs/dispatch.ts, config.ts. Tests: node-drain.test.ts, placement.test.ts, testruns tests.

- [x] Write and run failing integration tests for authenticated preparation, ongoing work, deadline/retry, restart generation, API view and allocation.
- [x] Implement the shared coordinator and MachineDrain union. Keep hub.isReady unchanged.
- [x] Connect existing placement and run allocation. Recheck before delivery.
- [x] Verify targeted tests and commit.

### 2. Update controls and installer handshake

Files: updates/routes.ts and control.ts, node update command, scripts/install.sh, apps/updater/updater.sh. Tests: updates.test.ts, node update command tests, install-script.test.ts, updater.test.ts.

- [x] Write and run failing tests for confirmation, planned shell updates, errors and urgent bypass.
- [x] Add confirmation with a fresh count, and the authenticated service handshake. The installer waits through deferred retries without stopping live work.
- [x] Verify bash behavior with repository stubs and commit.

### 3. Evidence and delivery

- [x] Record duration measurements, default wait/retry rationale, and the update paths found in the source. Distinguish source evidence from the historical incident.
- [x] Push task-299; run changed-area tests and checks on a free Linux machine with npm ci.
- [x] Read full logs, run crapper and dryer on the changed files, review the complete diff.
- [ ] Submit with exact branch/commit/evidence, then merge into fresh turn-7 as #299 directs.

## Ledger

- Read #298/#299 and repository rules. CLAUDE.md is absent. The task overrides CONTRIBUTING sign-off and full-suite advice.
- API agreed in #299: MachineDrain waiting/postponed/restarting; confirmTurns with turns_would_stop; AgentState.machineDrain next to limitUntil, with ready staying true.
- No SQL tool is exposed to this developer. Requested an aggregate-only SELECT through the head in #299.
- npm ci completed with exit 0. npm reported 15 moderate vulnerabilities; dependency updates are outside this task.
- Taken over from 07296884 on 2026-11-04 after its model outage; its shell work was never pushed and was redone here.
- Replaced waiting before the install with app first, nodes after, for every release. The order the head agreed for the first release then needs no branch of its own: an updater from before starts the app alone, and the updater it starts replaces the nodes. A failed update touches no node, so going back cuts no turn.
- Measured turn lengths (7 days, done, n=1710): p50 34 s, p90 887 s, p95 1674 s, p99 5438 s, max 11798 s. Wait 90 minutes, retry 15 minutes.
- Why these: 90 minutes (5400 s) stands just under the p99 of turns that ended well (5438 s), and a turn that started before the wait has already run part of its length. 15 minutes (900 s) stands just over their p90 (887 s), so most of the work the node took back while postponed ends before it holds again.
- Update paths in the source, before this task:
  - Machines: `updateCommand` in nodes/command.ts gives `curl .../install.sh | bash`; `node_mode` goes over `existing_nodes` and `start_node` stops and removes each node at once.
  - Server: updates/routes.ts writes request.json; updater.sh `install` runs `install.sh server`; `start_server_services` calls `prepare_builtin_stop` and compose recreates the node; `sweep_nodes` calls `start_node` for the other nodes on that computer.
  - `program-updates.ts` updates agent programs and restarts no container.
- Not proved: what started the cuts of 2026-11-04 16:10. The texts "restarted, Hornhoof updated it" and "its container was created again" come from tasks/restarts.ts and fit the paths above, but only a log of Operations or of that computer can name who ran the update. Nobody gave one.
- Order of a release, for its notes:
  1. The app goes first: a running node on another image stays on it and its turns go on. This also holds for an updater from before, such as 0.6.1, which starts the new installer without saying the nodes are free.
  2. The new updater then asks the server with the built-in node's key. The server keeps new work off the nodes on that computer, and work goes to another free node of the plan or waits.
  3. When the last turn and run part end, the installer of the running build replaces the nodes, and each takes work again with its new boot.
  4. At the deadline nothing stops: Operations hears with the machine and its turns, the node works again, and the wait repeats 15 minutes later.
  5. Other machines move when someone runs the install command there. It waits the same way. Against a server from before this wait it leaves the node as it is and says to update the server first.
  6. `urgent` in the API and `--urgent` for install.sh replace the nodes at once, as before.
- A failed update touches no node, so going back cuts no turn.
