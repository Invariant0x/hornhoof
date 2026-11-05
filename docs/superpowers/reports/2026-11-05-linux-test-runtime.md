# Linux test runtime measurements, task 378

## Method

BEFORE: run_tests 101, source c3c6c815321f6c3c222cb35a4cb6d560326bcdff. Four parts with two workers each; every package tested on every shard except protocol (once). The identical command is retained on task 378 as `command.sh` (attachment e17e3f43-cf5c-46df-a071-01a92cafc77d). HH_BENCH_STAGE measures elapsed package wall time; reporter file values include collection/setup and test/teardown. Lazy PGlite initialization can occur during the first SQL statement, so subtracting setupMs does not remove all database startup. File timings overlap and must not be summed as suite wall time.

The pool is heterogeneous. Reported Linux runtimes include x64 (8 and 16 CPUs) and Linuxkit arm64 (8 CPUs). A changed host assignment, cache or load can affect the comparison; percentages from this run alone do not establish the parent task target against turn 7.

## Before

| Part | Runtime | Install (s) | Server (s) | Node (s) | Web (s) |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Linux x64, 8 CPUs | 42.179 | 204.529 | 87.328 | 26.373 |
| 2 | Linux x64, 16 CPUs | 4.361 | 138.185 | 62.422 | 4.329 |
| 3 | Linux arm64, 8 CPUs | 8.423 | 305.988 | 74.477 | 15.550 |
| 4 | Linux x64, 16 CPUs | 4.531 | 71.384 | 52.624 | 13.244 |

Part elapsed times from run records: 592.805 / 213.265 / 412.202 / 146.894 seconds. Run wall time: 593.089 seconds, including queueing. Part 4 waited for the machine used by part 2. Part 1 additionally ran lint (90.131 s), test typecheck (41.634 s), release tests (87.179 s), protocol (4.339 s), release/shell checks and protocol build.

| Package | Cases before | Cases after |
| --- | ---: | ---: |
| packages/protocol | 211 | Pending |
| apps/server | 2802 | Pending |
| apps/node | 1650 | Pending |
| apps/web | 1399 | Pending |

### Ten slowest files outside the migrations startup suite

These are total observed file times, including each file's own setup. Database work remains in server test timings.

| File | Total (s) | Setup (s) | Tests (s) |
| --- | ---: | ---: | ---: | ---: |
| apps/server/test/test-runs.test.ts | 135.857 | 12.549 | 122.587 |
| apps/server/test/tasks-wake.test.ts | 118.948 | 14.515 | 103.812 |
| apps/server/test/decisions.test.ts | 99.310 | 8.468 | 90.553 |
| apps/server/test/failures.test.ts | 95.620 | 12.230 | 83.010 |
| apps/server/test/conversation.test.ts | 89.706 | 14.772 | 74.426 |
| apps/server/test/terminals.test.ts | 81.232 | 14.245 | 66.482 |
| apps/server/test/updater.test.ts | 68.216 | 0.105 | 68.111 |
| apps/server/test/agent-switch.test.ts | 64.463 | 12.664 | 51.354 |
| apps/server/test/tasks-reconcile.test.ts | 63.401 | 9.724 | 53.422 |
| apps/node/test/terminal-host-agy.test.ts | 61.815 | 0.624 | 61.191 |

### Ten slow files without PGlite fixtures

This separate view focuses on work outside server database startup. The updater is measured here but remains outside the edit scope.

| File | Total before (s) |
| --- | ---: |
| apps/server/test/updater.test.ts | 68.216 |
| apps/node/test/terminal-host-agy.test.ts | 61.815 |
| apps/node/test/terminal-host-agy-tools.test.ts | 61.536 |
| apps/node/test/terminal-host-receipts.test.ts | 55.074 |
| apps/node/test/terminal-host-waits.test.ts | 52.082 |
| apps/node/test/terminal-host-live-review.test.ts | 51.530 |
| apps/node/test/terminal-host-hook-delivery.test.ts | 43.274 |
| apps/node/test/terminal-host-busy-claude.test.ts | 40.546 |
| apps/node/test/terminal-host-say.test.ts | 36.904 |
| apps/node/test/terminal-host-lifecycle.test.ts | 36.464 |

### Other package measurements

| Package | Slowest observed file | Total (s) |
| --- | --- | ---: |
| apps/node | test/terminal-host-agy.test.ts | 61.815 |
| apps/node | test/terminal-host-agy-tools.test.ts | 61.536 |
| apps/node | test/terminal-host-receipts.test.ts | 55.074 |
| apps/web | test/Subscriptions.test.tsx | 22.917 |
| apps/web | test/Machines.test.tsx | 16.548 |
| apps/web | test/Department.test.tsx | 12.747 |
| packages/protocol | test/test-timings-reporter.test.ts | 2.911 |
| packages/protocol | test/protocol.test.ts | 0.523 |
| packages/protocol | test/test-timings-units.test.ts | 0.295 |

Installer explicit split target: 46.941 s reporter total (43.865 s ordinary Vitest test summary), 94 cases.

### Baseline failures

Run 101 failed eight cases: server staff/turns tool-list expectations; agents employee-card fields; wait-notice-migration legacy row fields; two migration-history legacy row cases; two terminal-host-waits Antigravity observations including its initial idle state. The six server failures are outside task 378. The terminal observations will be corrected to start at accepted work without permitting idle during that work.

## Changes and fault probes

Production behavior is unchanged. Terminal observation starts with accepted running work and still rejects every subsequent idle report. Kimi and interrupted Antigravity cross the former lost-end windows on a controlled Date clock. Cancellation advances its 5000 ms grace period only after the actual tmux Escape command completes. Hook clients retain actual requested deadlines and real HTTP; IPC advances only their AbortSignals. Ownership gates preserve real kernel-table fixture checks. The final retry test releases ownership after the client exited and still requires exactly one completed first turn.

The terminal-host hook integration uses an explicit owner gate and a host Date jump. The direct hook delivery test separately proves the former 3000 ms deadline regression with a child clock; this division avoids introducing a clock broker into tmux descendants.

Runtime Vitest collection (`vitest list ... --no-static-parse --json`) before/after gave equal full-name multisets: installer 94 (59/10/23/2), test runs 99 (19/19/12/24/25), decisions 58 (21/13/11/13). A TypeScript scanner comparison also found identical multisets of all 812 assertion expressions. Original describe names, assertions and parameter expansions remain intact. Installer stubs and neighboring task files are unchanged. Shell-only installer partitions no longer import the server test app.

Intentional faults were temporary and restored in `finally` before the clean run:

| Family | Temporary wrong behavior/condition | Command (`npx --no-install vitest run --root ...`) | Observed RED |
| --- | --- | --- | --- |
| Terminal waits | Report idle after 60000 ms despite a running turn | `apps/node test/terminal-host-waits.test.ts -t 'both end channels\|mid-tool'` | Three no-idle assertions failed |
| Hook delivery | Stop deadline 15000 to 3000 ms in hh-hook-send.cjs | `apps/node test/hook-delivery.test.ts` | Two owner checks `[false,true]`, expected one |
| Hook retries | Stop/interrupt attempt count 3 to 1 | `apps/node test/hook-client.test.ts test/hook-retry-delivery.test.ts` | Three assertions failed, missing attempts 2/3 |
| Host hook completion | Replace stop answer with `Lost the answer.` | `apps/node test/terminal-host-hook-delivery.test.ts -t 'closes claude'` | Delivered answer mismatch |
| Installer split | `STUB_RUN=fail` in locked-down-container fixture | `apps/server test/install-script-join.test.ts -t 'starts one locked-down' --maxWorkers=2` | Actual exit 1, expected 0 |
| Run split | Completion fixture reports SHA b instead of a | `apps/server test/test-runs.test.ts -t 'runs on a machine that joined without a plan' --maxWorkers=2` | Passed-result assertion failed |
| Decisions split | decisionOwner always returns CEO | `apps/server test/decisions.test.ts -t "gives a department's question to the one person" --maxWorkers=2` | Actual ceo, expected dan |

The repository's contribution guide requests a sign-off trailer; task 378 explicitly requires no trailers, which takes precedence. No trailer is added.

### Scoped verification

- `vitest run --root apps/server test/install-script test/test-runs test/decisions --maxWorkers=2`: 13 files, 251/251 passed. The full affected server run with V8 coverage also passed 251/251.
- `vitest run --root apps/node test/terminal-host-waits.test.ts test/hook-delivery.test.ts test/hook-client.test.ts test/hook-retry-delivery.test.ts test/terminal-host-hook-delivery.test.ts --maxWorkers=2`: 17/17 passed; the final source also passed with V8 coverage.
- `npx tsc -p apps/node/tsconfig.json --noEmit`, `npx tsc -p apps/server/tsconfig.json --noEmit`, `npm run typecheck:tests`: exit 0.
- `npx --no-install eslint <25 changed TypeScript/CJS files>`: exit 0, no diagnostics. `dryer --threshold 0.8 <same files>`: exit 0, no duplicate candidates.
- `crapper --root apps/node --use-existing-coverage <changed node files>` and the corresponding server command: exit 0. Package roots matter because their LCOV source paths are package-relative. New utility scores: hookClock 9.7, client 8.2, cancelTurn 5.0, acceptedReports 4.0; extracted matrix registration 9.0, installer 6.0, run company 6.3. The unchanged `toldOf` test helper remains CC 3 / reported CRAP 12.0 because Vitest excludes test files themselves from coverage; its 25-case waiting family passed in the complete 251-case run. No claim that every legacy function scores below 10.

An initial overly broad `--coverage.include=test/**` attempted to parse data and shell fixtures and emitted exclusions. Those outputs were not accepted as a clean coverage gate. Clean reruns use explicit utility paths only: node hook-test-clock.ts, hook-test-client.ts, terminal-test-clock.ts and fakes/hook-clock.cjs; server install-script-helpers.ts, test-runs-company.ts and decisions-company.ts. The server utility coverage probe runs six existing cases (locked-down install, planless run, queued second run, and department decision answers 200/403/404); all six passed. The full 251-case result above remains the affected-test gate. The child CJS preload is exercised by real clients and intentional faults; it is not instrumented by the parent Vitest process.

### Fresh review and decisions

The independent read-only reviewer found no critical or important implementation defects in the reviewed five commits. Its minor stderr-drain finding was treated as important for suite reliability: a gated real stderr pipe reproduced an empty diagnostic after process exit (RED), then awaiting the child `close` event passed all three client cases (GREEN). The gate covers Node's automatic pipe resumption as well as the explicit reader. The client fixture and terminal clock helpers were moved into test utilities to make their actual coverage measurable; their test names and bodies remain unchanged apart from this additional scheduling condition.

Decisions on every item the reviewer set aside:

| Item | Decision and cost if wrong |
| --- | --- |
| AFTER runtime/counts and remaining gates | Keep pending until measured; a premature success claim would hide regressions. |
| Combined 30% against turn 7 | Parent 222 with task 321 owns this assessment; no causal claim from a later baseline. |
| Six unrelated baseline server failures | Keep assertions and source unchanged; head assigned remedies to 408, 409 and 374. Whole-suite green remains unclaimed. |
| Coverage completeness | Correct the selector to code utilities and disclose exclusions; claiming provider-child coverage from parent data would overstate evidence. |
| Whole-suite stability and platforms | The authorized AFTER run provides Linux evidence only; no claim of coverage on unmeasured platforms. |
| Live providers and real kernel ownership | Preserve real HTTP/tmux with fixture process tables; live provider verification is outside this test-runtime refactor. |
| Excluded tools | Keep the explicit task exclusion in force; no result inferred. |
| Unchanged production defects/cleanup | Leave them to owners; changing them would confound the measurement and scope. |

The only execution-plan deviation was verifying all three independent server structural commits with one combined 251-case run instead of three identical repeats. Exact full-name and assertion manifests pin attribution. No minor review findings remain deferred.

### Change provenance

| Commit/task | Included in this measurement branch | Role |
| --- | --- | --- |
| c3c6c815 | Both BEFORE and AFTER base | Turn-8 snapshot including tasks 308, 328 and 358 |
| ce2de9ef | AFTER | Accepted-turn observation and controlled cancellation |
| 4164cafe | AFTER | Controlled hook deadlines and ownership gates |
| 9228f237 | AFTER | Installer split |
| f07cd2d0 | AFTER | Test-run split |
| 581fc95a | AFTER | Decisions split |
| 6aea787e53c5433ab5ebf1d87d9893f1f6e1e2c7 | AFTER | Pipe drainage and measurable test utilities |
| 408, 409, 374 | Not merged into this branch | Assigned remedies for the six baseline server failures; record their exact SHAs separately if later merged |

The final Linux comparison follows below.

## After

Pending the same Linux benchmark after implementation and scoped checks.
