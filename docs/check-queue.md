# Heavy checks on one machine

Heavy checks share one FIFO queue across the subscription nodes on a physical machine. The server groups authenticated node load reports by their physical host fingerprint, with the registered machine key as the fallback. Requests cannot choose a machine identity, release another node's slot, or claim another node's conversation.

The queue stores its metadata on the server, outside the users and folders of jobs. Job cleanup and killing a job user do not delete the queue. No command environment or output is sent to the server coordinator.

Nodes report their tracked check IDs in hello and load frames. The server applies snapshots in sequence on the current socket. A running lease omitted by its own node frees its slot once the grant predates the server's frame receipt by more than one load interval. Pending local claims and holders still cleaning up stay on the list. Reports without the list leave leases alone.

## Local commands

An agent runs noninteractive checks of its change in its own workspace. Install dependencies from the lockfile once per workspace and again when the lockfile changes. Name one or more regular test files, including browser tests when the browser is installed there. Browser installation is allowed. Types, lint, format, builds, coverage, quality and changed-code mutation also run there.

A whole test suite does not run in a workspace: the repository's own CI runs it for the exact commit of a release, and a release relies on that. `run_tests` runs the checks of a task, split into groups over free machines, on the turn's branch, a release branch or main. A runner given no files, or a selection using a directory, glob, loop or variable, counts as a whole suite. Watch modes and task runners that run everything are refused in the terminal. For local checks, the wrapper uses the same guard as the terminal:

```sh
hh-check -- npx vitest run test/a.test.ts test/b.test.ts
hh-check -- npx tsc --noEmit
hh-check -- npm run build -w apps/node
```

The wrapper preserves stdout, stderr and the command's exit status. While waiting it prints `Waiting for a machine check slot. Position 2.` Positions start at one for the next waiting command. A nested wrapper reuses its parent's live slot only for the same agent.

An agent's own type checks, tests, lint and browser tests wait for a slot with nothing for the agent to add. The node puts a `node` of its own in front of the real one on the agent's `PATH`, which `npx`, npm scripts and a tool started by its name reach too. When an agent starts TypeScript (`tsc`), Vitest, ESLint, Jest or Playwright, that `node` runs `hh-check --wait -- node ...`: the command waits for a slot like for a lock, then runs right in the agent's shell, with its own terminal, folder and environment, and holds the slot until it ends. What runs inside it holds the same slot. Nothing is refused this way. With no slot to be had, as with no turn or with the node away from Hornhoof, the command runs at once, as it would with no queue.

The bridge authenticates the calling process and requires a current agent turn. Commands it starts become live process roots for that agent, so nested wrappers and bridge calls retain the same ownership checks. It starts commands as the agent user, never as root, with the caller's environment. Working-directory changes happen after dropping privileges. Cancellation stops the process group, waits up to five seconds before KILL, and holds the slot until process cleanup finishes.

## Node API

```ts
await withCheckSlot(async signal => {
  // Resolve checkout, prepare dependencies and services, run the check, clean up.
  // Every child process must honor this signal, including loss of the node lease.
}, { signal: callerSignal, label: 'Check project', onPosition: position => report(position) });
```

`withCheckSlot` is exported by `apps/node/src/check-queue.ts`. Options also accept `agentId` and `jobId` for conversation ownership. A waiting cancellation rejects with the exact `signal.reason` and never invokes the callback. A running callback retains its slot until its promise settles. The callback signal includes the caller's cancellation and lease loss. Nested calls reuse the current slot and combine cancellation signals.

`main.ts` uses this API around the complete `runPart` call, including preparation and cleanup. It acquires before `tests.started`, so the execution deadline inside `runPart` starts after admission. An authenticated `tests.waiting` report clears the assigned part's execution start while it waits. `tests.started` begins that clock and removes the queue hint. A queued part does not hit the execution timeout or its late-result margin. Browser installation and verification also receive the current slot cancellation and retain admission through their process cleanup. No test timeout is increased. `test_run` and `work_run` expose `queuePosition` on waiting parts.

## Capacity and liveness

The calibration probe passed two concurrent selected migration checks on nine available CPUs and failed at four without changing the 20-second test limit. Admission reserves five CPU equivalents per check and uses `max(1, floor((cpus - loadavg) / 5))`. High load admits one check at a time. A fresh measurement can reduce future admission without killing running checks.

Load reports older than 90 seconds are not refreshed by a slot request. Nodes losing the connection cancel queued requests and abort active callback signals. The server holds active reservations through a 90-second cleanup interval. A 90-second startup hold lets workers discover a server restart and stop old process groups before fresh work starts.

Queue waiting defers stalled-program alarms in the task watchdog and first-activity alarms in the program operator. Their normal quiet interval starts again after waiting ends. Missing-node alarms remain active. The operator cannot send keys to an agent while it waits for a check slot.

The capacity calibration is conservative and based on the supplied workload. It does not impose a per-process CPU affinity or replace each command's cancellation and execution limit. Commands started outside the wrapper, the agent's `node` or the node API do not participate in admission.

## Validation

At source commit `6b8e11007a4484399617890619a8c85cb47afdb5`, the completed coordinator/client API passed ten consecutive full migration/wait runs (57 tests each), with three additional selected checks offered each round through another node identity. Thirty competitors also passed. With 32 bounded CPU0 background workers and checks on CPUs1-9, measured loadavg was 34.17-44.20 and at most one check ran at a time. Waiting positions progressed from three to one. All workers exited, confirmed by a process-table readback. The existing 20000 ms test limit was unchanged.

This proof uses the production coordinator/client and wire parsers in a local two-node harness. Authenticated ownership, CLI output, nested commands, cancellation and watchdog behavior have separate targeted integration tests. A live multi-container deployment and live macOS were not available in this Linux environment.
