# Linux test runtime measurements, task 378

## Method

BEFORE: run_tests 101, source c3c6c815321f6c3c222cb35a4cb6d560326bcdff. Four parts with two workers each; every package tested on every shard except protocol (once). The identical command is retained on task 378 as `command.sh` (attachment e17e3f43-cf5c-46df-a071-01a92cafc77d). HH_BENCH_STAGE measures elapsed package wall time; reporter file values include collection/setup and test/teardown. Lazy PGlite initialization can occur during the first SQL statement, so subtracting setupMs does not remove all database startup. File timings overlap and must not be summed as suite wall time.

The pool is heterogeneous. Reported Linux runtimes include x64 (8 and 16 CPUs) and Linuxkit arm64 (8 CPUs before, 10 CPUs after). A changed host assignment, cache or load can affect the comparison; percentages from this run alone do not establish the parent task target against turn 7.

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
| packages/protocol | 211 | 211 |
| apps/server | 2802 | 2802 |
| apps/node | 1650 | 1650 |
| apps/web | 1399 | 1399 |

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

Run 101 failed eight cases: server staff/turns tool-list expectations; agents employee-card fields; wait-notice-migration legacy row fields; two migration-history legacy row cases; two terminal-host-waits Antigravity observations including its initial idle state. The six server failures are outside task 378. The terminal observations were corrected to start at accepted work without permitting idle during that work; all node tests pass in run 103.

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

### Scoped verification before the AFTER run

- `vitest run --root apps/server test/install-script test/test-runs test/decisions --maxWorkers=2`: 13 files, 251/251 passed. The full affected server run with V8 coverage also passed 251/251.
- `vitest run --root apps/node test/terminal-host-waits.test.ts test/hook-delivery.test.ts test/hook-client.test.ts test/hook-retry-delivery.test.ts test/terminal-host-hook-delivery.test.ts --maxWorkers=2`: 17/17 passed; the final source also passed with V8 coverage.
- `npx tsc -p apps/node/tsconfig.json --noEmit`, `npx tsc -p apps/server/tsconfig.json --noEmit`, `npm run typecheck:tests`: exit 0.
- `npx --no-install eslint <25 changed TypeScript/CJS files>`: exit 0, no diagnostics. `dryer --threshold 0.8 <same files>`: exit 0, no duplicate candidates.
- `crapper --root apps/node --use-existing-coverage <changed node files>` and the corresponding server command: exit 0. Package roots matter because their LCOV source paths are package-relative. New utility scores: hookClock 9.7, client 8.2, cancelTurn 5.0, acceptedReports 4.0; extracted matrix registration 9.0, installer 6.0, run company 6.3. The unchanged `toldOf` test helper remains CC 3 / reported CRAP 12.0 because Vitest excludes test files themselves from coverage; its 25-case waiting family passed in the complete 251-case run. No claim that every legacy function scores below 10.

An initial overly broad `--coverage.include=test/**` attempted to parse data and shell fixtures and emitted exclusions. Those outputs were not accepted as a clean coverage gate. Clean reruns use explicit utility paths only: node hook-test-clock.ts, hook-test-client.ts, terminal-test-clock.ts and fakes/hook-clock.cjs; server install-script-helpers.ts, test-runs-company.ts and decisions-company.ts. The server utility coverage probe runs six existing cases (locked-down install, planless run, queued second run, and department decision answers 200/403/404); all six passed. That 251-case scoped result predates the full AFTER run; run 103 adds one timeout in the affected family, as disclosed below. The child CJS preload is exercised by real clients and intentional faults; it is not instrumented by the parent Vitest process.

### Fresh review and decisions

The independent read-only reviewer found no critical or important implementation defects in the reviewed five commits. Its minor stderr-drain finding was treated as important for suite reliability: a gated real stderr pipe reproduced an empty diagnostic after process exit (RED), then awaiting the child `close` event passed all three client cases (GREEN). The gate covers Node's automatic pipe resumption as well as the explicit reader. The client fixture and terminal clock helpers were moved into test utilities to make their actual coverage measurable; their test names and bodies remain unchanged apart from this additional scheduling condition.

Decisions on every item the reviewer set aside:

| Item | Decision and cost if wrong |
| --- | --- |
| AFTER runtime/counts and remaining gates | Measured below; failed validation remains explicit, avoiding a premature success claim. |
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
| 01c96e10650ea13466e26a656cb888147dd15048 | AFTER run 103 | Documentation and evidence commit, no additional code changes |
| 408, 409, 374 | Not merged into this branch | Assigned remedies for the six baseline server failures; record their exact SHAs separately if later merged |

The final Linux comparison follows below.

## After

AFTER: run_tests 103, all four parts at 01c96e10650ea13466e26a656cb888147dd15048. The command bytes, four-part layout, two workers per Vitest command, Node v22.23.4 and 45-minute part limit match run 101. All four command environments report Linux. No neighboring fixes were merged into this source. Raw logs are task attachments `tests-103-1.log` through `tests-103-4.log`. Structured extraction is attached separately for recomputation.

**Validation remains incomplete.** Package counts are preserved and node/protocol/web passed, but server has 30 failed cases: six baseline assertion failures and 24 new 20000 ms timeouts on part 3. One timeout is in the moved test-runs-commit file. Three timed-out migration cases also report ENOTEMPTY during cleanup. No overall speedup or whole-suite green is established. Positive percentage deltas below mean slower, negative mean faster.

### Part wall times and provenance

| Part | BEFORE runtime | AFTER runtime | Before s | After s | Delta |
| --- | --- | --- | --- | --- | --- |
| 1 | 6.8.0-147-generic, x64, 8 CPUs | 6.8.0-147-generic, x64, 8 CPUs | 592.805 | 610.069 | +2.9% |
| 2 | 6.12.86+deb13-amd64, x64, 16 CPUs | 6.12.86+deb13-amd64, x64, 16 CPUs | 213.265 | 188.033 | -11.8% |
| 3 | 6.10.14-linuxkit, arm64, 8 CPUs | 6.12.54-linuxkit, arm64, 10 CPUs | 412.202 | 1190.711 | +188.9% |
| 4 | 6.12.86+deb13-amd64, x64, 16 CPUs | 6.12.86+deb13-amd64, x64, 16 CPUs | 146.894 | 125.716 | -14.4% |

End-to-end run wall time including queueing: 593.089 s to 1191.028 s (+100.8%). Part 4 queued behind part 2 in both runs. The part-3 physical worker changed between the runs, as did its Linuxkit kernel and reported CPU count (8 to 10). No concurrent load or CPU quota measurement was captured. These facts identify a changed environment, not proof that environment alone caused the timeouts.

### Package stage wall time by part

Each cell gives BEFORE / AFTER seconds (percentage delta). These are stage wall times, not sums of reporter file durations.

| Part | Server | Node | Web |
| --- | --- | --- | --- |
| 1 | 204.529 / 226.401 (+10.7%) | 87.328 / 87.018 (-0.4%) | 26.373 / 26.626 (+1.0%) |
| 2 | 138.185 / 113.933 (-17.6%) | 62.422 / 61.890 (-0.9%) | 4.329 / 4.324 (-0.1%) |
| 3 | 305.988 / 1083.321 (+254.0%) | 74.477 / 66.447 (-10.8%) | 15.550 / 25.750 (+65.6%) |
| 4 | 71.384 / 75.359 (+5.6%) | 52.624 / 30.948 (-41.2%) | 13.244 / 12.177 (-8.1%) |

Cumulative package stage wall times across shards follow. Since shards overlap, their sum is not the elapsed duration of the run.

| Package | Before s | After s | Delta | Cases before / after | After outcome |
| --- | --- | --- | --- | --- | --- |
| packages/protocol | 4.339 | 4.261 | -1.8% | 211 / 211 | all passed |
| apps/server | 720.086 | 1499.014 | +108.2% | 2802 / 2802 | 30 failed / 2772 passed |
| apps/node | 276.851 | 246.303 | -11.0% | 1650 / 1650 | all passed |
| apps/web | 59.496 | 68.877 | +15.8% | 1399 / 1399 | all passed |

Part 1 ancillary stages also completed with exit 0: lint 90.366 s, test typecheck 41.686 s, release tests 87.673 s, protocol build 3.667 s, release check 0.053 s, shell syntax 0.005 s and shellcheck 1.283 s. Protocol tests took 4.261 s. These stages contribute to part-1 wall time and must not be attributed to test splitting.

### BEFORE top ten, paired with AFTER

The ranking excludes migrations.test.ts, which task 321 owns. For split families, AFTER means the longest resulting file, a measure of file granularity rather than total work. All other rows compare the same file path. File timings retain PGlite and collection overhead.

| BEFORE file/family | Before s | After s | Delta | Comparison |
| --- | --- | --- | --- | --- |
| apps/server/test/test-runs.test.ts | 135.857 | 202.378 | +49.0% | max partition: test/test-runs-commit.test.ts; one timeout |
| apps/server/test/tasks-wake.test.ts | 118.948 | 106.159 | -10.8% | same path |
| apps/server/test/decisions.test.ts | 99.310 | 50.033 | -49.6% | max partition: test/decisions-answers-ceo.test.ts |
| apps/server/test/failures.test.ts | 95.620 | 220.527 | +130.6% | same path |
| apps/server/test/conversation.test.ts | 89.706 | 231.707 | +158.3% | same path |
| apps/server/test/terminals.test.ts | 81.232 | 198.912 | +144.9% | same path |
| apps/server/test/updater.test.ts | 68.216 | 70.881 | +3.9% | same path |
| apps/server/test/agent-switch.test.ts | 64.463 | 124.914 | +93.8% | same path |
| apps/server/test/tasks-reconcile.test.ts | 63.401 | 338.155 | +433.4% | same path |
| apps/node/test/terminal-host-agy.test.ts | 61.815 | 61.323 | -0.8% | same path |

### AFTER top ten, paired with BEFORE

All ten happen to be server files on the changed part-3 worker. This concentration is evidence that this run does not isolate the effect of edits. Newly created partitions have no same-file BEFORE measurement; a percentage is deliberately not invented for them.

| AFTER file | Before s | After s | Delta |
| --- | --- | --- | --- |
| apps/server/test/tasks-reconcile.test.ts | 63.401 | 338.155 | +433.4% |
| apps/server/test/test-evidence.test.ts | 55.507 | 273.783 | +393.2% |
| apps/server/test/approval-policy.test.ts | 53.879 | 255.039 | +373.4% |
| apps/server/test/conversation.test.ts | 89.706 | 231.707 | +158.3% |
| apps/server/test/failures.test.ts | 95.620 | 220.527 | +130.6% |
| apps/server/test/test-runs-commit.test.ts | new partition | 202.378 | n/a |
| apps/server/test/terminals.test.ts | 81.232 | 198.912 | +144.9% |
| apps/server/test/program-operator-cases.test.ts | 59.467 | 198.525 | +233.8% |
| apps/server/test/setup.test.ts | 26.570 | 173.288 | +552.2% |
| apps/server/test/turns-reads.test.ts | 31.522 | 170.112 | +439.7% |

For context, the excluded and unchanged migrations.test.ts itself grew from 199.416 s to 802.452 s (+302.4%) on part 3. Its tests are untouched by this branch.

### Work outside PGlite startup

The ten slowest BEFORE files without PGlite fixtures, paired with their unchanged AFTER paths. The updater remains excluded from edits. The terminal-waits BEFORE result includes two failed idle-boundary assertions; AFTER all ten cases pass.

| File | Before s | After s | Delta |
| --- | --- | --- | --- |
| apps/server/test/updater.test.ts | 68.216 | 70.881 | +3.9% |
| apps/node/test/terminal-host-agy.test.ts | 61.815 | 61.323 | -0.8% |
| apps/node/test/terminal-host-agy-tools.test.ts | 61.536 | 65.127 | +5.8% |
| apps/node/test/terminal-host-receipts.test.ts | 55.074 | 54.865 | -0.4% |
| apps/node/test/terminal-host-waits.test.ts | 52.082 | 29.655 | -43.1% |
| apps/node/test/terminal-host-live-review.test.ts | 51.530 | 51.451 | -0.2% |
| apps/node/test/terminal-host-hook-delivery.test.ts | 43.274 | 8.738 | -79.8% |
| apps/node/test/terminal-host-busy-claude.test.ts | 40.546 | 40.513 | -0.1% |
| apps/node/test/terminal-host-say.test.ts | 36.904 | 36.708 | -0.5% |
| apps/node/test/terminal-host-lifecycle.test.ts | 36.464 | 36.071 | -1.1% |

### Changed clock tests and split families

| Node test file | Cases | Before s | After s | Delta |
| --- | --- | --- | --- | --- |
| terminal-host-waits | 10 | 52.082 | 29.655 | -43.1% |
| terminal-host-hook-delivery | 2 | 43.274 | 8.738 | -79.8% |
| hook-delivery | 1 | 3.607 | 0.104 | -97.1% |
| hook-retry-delivery | 1 | 0.819 | 0.557 | -32.0% |
| hook-client | 3 | 0.712 | 0.257 | -63.9% |

The reductions are observed file measurements, not a controlled causal estimate. These tests also have explicit fault probes demonstrating preserved deadline, retry, completion and no-idle behavior.

Splitting trades extra collection/setup for smaller units. File-time sums below are diagnostic totals only, not package wall time.

| Server family | Cases before / after | Before file s | After longest file s | Max delta | After file-time sum s | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| install-script | 94 / 94 | 46.941 | 14.655 | -68.8% | 46.102 | all passed |
| test-runs | 99 / 99 | 135.857 | 202.378 | +49.0% | 335.944 | one timeout |
| decisions | 58 / 58 | 99.310 | 50.033 | -49.6% | 112.807 | all passed |

The original three server files become thirteen files: 251 cases still register, all 812 assertion expressions still match, and AFTER attempts all 251. In run 103, 250 passed and one timed out. Node still has 108 test files; server grows from 161 to 171; total files grow from 348 to 358. No test case was dropped or marked skip in the benchmark.

### Failure inventory and diagnostic limits

The same six server assertion failures remain in parts 1, 2 and 4: staff/turns tool lists (task 408), agents held field (409), wait-notice-migration and two migration-history cases (374). Their fixes are not in either measured source.

Part 3 adds these 24 failed cases, all reported as 20000 ms test timeouts:

| File | Timed-out cases | Edited here |
| --- | --- | --- |
| departments.test.ts | 1 | no |
| migration-metadata.test.ts | 1 | no |
| migrations.test.ts | 14 | no |
| program-operator-evidence.test.ts | 1 | no |
| program-operator-migration.test.ts | 1 | no |
| program-operator-recovery.test.ts | 1 | no |
| program-updates.test.ts | 2 | no |
| test-runs-commit.test.ts | 1 | yes, moved unchanged case |
| watch-machine-drain.test.ts | 1 | no |
| work-tree-route.test.ts | 1 | no |

The three additional cleanup ENOTEMPTY errors belong to already counted migration cases and are not three extra failed tests. The complete unique failure names remain in the structured evidence and raw logs.

The affected case is `one commit for a whole run > asks the repository nothing for a run the rules refuse anyway`. It was moved without changing its body, fixtures or assertions. After reading the failure and confirming no intervening source edits, the following diagnostics ran on this workspace, without retry flags, timeout changes or source fixes:

```sh
npx --no-install vitest run test/test-runs-commit.test.ts -t 'asks the repository nothing for a run the rules refuse anyway' --maxWorkers=2
# exit 0: 1 passed, 23 deselected; case 1095 ms
npx --no-install vitest run test/test-runs-commit.test.ts --maxWorkers=2
# exit 0: 24 passed; duration 15.12 s
```

These diagnostics do not replace the failed remote measurement or establish the exact cause of the different worker behavior. They show that the timeout was not reproduced locally, including with the whole file and its cleanup order. No claim is made that all new timeouts are unrelated to this refactor.

### Remaining decision

The complete before/after observation is recorded, but the acceptance goal of a reliable, balanced improvement is not demonstrated by run 103. A comparable controlled Linux slot or an explicit head decision about accepting these limitations is needed before closing task 378. The current run_tests API chooses a free machine and offers no worker pinning; changing company pool membership is outside this task. Do not raise timeouts, remove cases, mask the new failures or silently replace this run with a lucky rerun. No extra full-suite run has been launched.

The original task-tool transport problem has cleared on this resume: tasks/task/test_run returned and task 378 is working with externalWait null. The previous wait_for acknowledgment was unavailable; its state was not claimed as saved. This is no longer the technical blocker. The remaining blocker is validating the full AFTER result under comparable conditions.
