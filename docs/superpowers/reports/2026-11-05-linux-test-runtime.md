# Linux test runtime measurements, task 378

## Method

BEFORE: run_tests 101, source c3c6c815321f6c3c222cb35a4cb6d560326bcdff. Four parts with two workers each; every package tested on every shard except protocol (once). The identical command is retained as a task artifact. HH_BENCH_STAGE measures elapsed package wall time; reporter file values include collection/setup and test/teardown. Lazy PGlite initialization can occur during the first SQL statement, so subtracting setupMs does not remove all database startup. File timings overlap and must not be summed as suite wall time.

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

Pending.

## After

Pending the same Linux benchmark after implementation and scoped checks.
