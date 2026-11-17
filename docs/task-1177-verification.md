# Task 1177 verification

Status: DONE_WITH_CONCERNS. This is author verification of the named area, not the release's final suite.

Code candidate: 3390423c6f86ae183987551b529520554f33168f
Fresh integration base: 359c2efaa27e9afb8842d0113dd5d6804aca467c
Evidence branch: task-1177-evidence, parented at the exact code candidate. The hand-in records its resulting commit. Evidence files do not modify the checked code branch.

## Change and cause

All 28 keeper-peer scenarios use controlled time and explicit lease, network, report, sync, backup, slot and beat steps. Native socket/session completion no longer repeats unrelated keeper rounds and database reads. The existing worker clock and production keeper/app-call implementation were not changed. The recorded child fixture tests our start/input/exit handling without starting frpc. Real peer HTTP/TLS paths and database state remain exercised.

The four-second relay scenario still covers 727 virtual seconds, both outage windows and the original mode/word assertions. Every original keeper assertion is retained. The comparison fixture retains complete strict values. Test timeout 20 s and hook timeout 10 s are unchanged; no threshold was raised.

Cold embedded-database preparation runs at collection through the common prepareSharedDatabase entry point authorized by the head. The incoming base contributed the same method; the merge conflict was solely its comment. Each file runs in a fresh isolated fork. Named run 00 checks fixed-clock-fixture.test.ts, shared-test-database.test.ts and keeper-peer.test.ts; runs 01-20 check only keeper-peer.test.ts. Build and static checks completed before test execution.

## Before and after

The all-28 comparison baseline is da43f7b7bc9cd1a7aeb5e8389ad039b692c5e6df: 26 passed, 2 timed out, file time 116367 ms, sampled 1-minute load 18.85-24.94. Its first case includes cold setup (14142.425 ms); after timings exclude the separately reported collection preparation. The baseline already contains the first direct-step repair of the target relay-hiccup case. Its original earlier measurement was 12955 ms on 41d37dd3d4f919e63ed39f4f0ce0d898e440f4c5, with 28 passing cases in 48924 ms and sampled 1-minute load 15.76-18.75; original log and load samples are in the archive. That first console log did not retain timings for all fast cases, so the table consistently uses the complete expanded baseline JSON.

Tables: task-1177-times.csv/.xlsx list every case's before duration/status and min/median/max across the 20 final runs, full source SHAs and pass counts. task-1177-load.csv/.xlsx list every run's file duration, slowest case, separately logged collection preparation, UTC samples and 1/5/15-minute load ranges. All durations are native runner diagnostics, not subtraction of the controlled application clock.

Final result: 20 consecutive keeper-peer runs x 28 = 560 passed; zero failed, skipped or unhandled errors. Run 00 also passed all 74 assertions across the three named files (console: 72 passed and 2 expected failures). Total final-candidate executions: 634. File duration min/median/max: 2912.962 / 4373.886 / 8014.996 ms. Slowest individual final-series case: 1509.038 ms. Recorded final-series 1-minute load: 6.99-10.40. Database preparation min/median/max in the twenty runs: 632 / 1114.5 / 2221 ms, outside scenario deadlines and disclosed separately. Run 00 keeper preparation: 787 ms. No parallel build or deliberately generated operating-system load. These are observed measurements, not a claim about benchmarked execution at every possible load.

## Executed commands on the final code candidate

- npm run build -w @hornhoof/protocol: exit 0, 0.560 s. Full output: checks/protocol-build.log.
- npm run build -w @hornhoof/server: exit 0, 4.243 s. Full output: checks/build.log.
- npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit: exit 0, 18.951 s. Full output: checks/types.log.
- npx --no-install eslint apps/server/test/fixed-clock-fixture.test.ts apps/server/test/helpers-db.ts apps/server/test/keeper-peer-time.ts apps/server/test/keeper-peer.test.ts apps/server/test/shared-test-database.test.ts: exit 0, 12.449 s. Full output: checks/lint.log.
- NODE_OPTIONS=--max-old-space-size=6144 node --input-type=module - /tmp/task-1177-proof-3390423c < docs/task-1177-series.txt: exit 0. Run 00: three literal named files, 74 assertions. Runs 01-20: the literal keeper-peer.test.ts file, 28 assertions each. Exact selection, unchanged source, zero pending/errors, isolated forks and unchanged timeout settings checked on every run. Script is committed in the code candidate; full JSON, diagnostics and load data are in proof/.
- git diff --no-index -- /tmp/task-1177-functions-base.ts /tmp/task-1177-functions-candidate.ts: exit 0 with empty output (archived as functions/base.ts and functions/candidate.ts). Complete freshPglite and ownDatabases declarations were extracted from 359c2efaa27e9afb8842d0113dd5d6804aca467c and 3390423c6f86ae183987551b529520554f33168f and compared byte for byte. docs/task-1177-unchanged-functions.txt records their identical SHA256 digest.

An initial build after taking in the protocol changes failed because the local generated protocol declarations were stale. Rebuilding the protocol, then the server, resolved all errors without a source edit. Both failed and passing logs are preserved. Dependencies were already installed from the unchanged lockfile; no lockfile or manifest changes occurred in this merge.

## RED evidence and self-review

The expanded baseline records the two lease timeouts. An instrumented run at 3ffbc81aa13bf5f11aaac9df095780b44287a2ce plus its saved timing-only patch failed the final peer-door case after 21135.697 ms, with 15522.157 ms spent repeating network rounds while awaiting native completion. Direct readiness waits replaced those rounds. The profile source record contains the instrumentation patch and is not represented as an untouched-commit receipt.

A three-file run on 454318e56eebbc08d9becd09d6a57b0a7ef1a453 exposed a shared-database comparison-control allocation: 22712.939 ms total, 21818.704 ms setup. Immutable independent comparison values are now prepared at collection; assertions remain strict. The area run on 216a1d5e07c9cb8eb3ffc0eac3d73a0ab1506fa0 exposed a probe-close-bind port race (EADDRINUSE), followed by a collateral cold-database timeout. Fixture listeners now bind atomically to port 0, use the actual returned address and register cleanup before startup. The unavailable-app fixture keeps ownership of its address. No production listener changed. Raw failing results for these intermediate findings are retained.

Manual self-review checked unchanged assertions, exact virtual endpoint and outage windows, fixture clock guards/cache isolation, shared snapshot lifecycle, native cancellation, recorded child cleanup and real peer routes. Security inspection found test/measurement changes only: no production permission, secret-handling or deployment changes. No changed pure production function requires mutation testing. Turnkey work has no independent gate claim.

## Concerns

The expanded check:author is NOT GREEN: migrations.test.ts had 8 timeouts out of 41 at sampled 1-minute load 13.8-32.7. It calls only freshPglite and ownDatabases; their bodies are unchanged from the merge base, as the empty function diff shows. Full names, output and command: docs/task-1177-author-before.txt in the code candidate. The remaining selected caller files were not all executed; collection is not represented as execution. The head explicitly authorized closure against the three named files, twenty final-candidate keeper runs, build, types including tests and lint, and assigned migration timeouts to #1185. No limits were increased. No run_tests, local whole suite, main integration or release approval is claimed.

6a052242 без trailer, attestation в 3410fd97

The head accepted that DCO attestation on the task. Later commits are signed off; no history was rewritten. The task report records the observed fast-forward integration separately.

Observed integration: normal fast-forward of turn-31 from 359c2efaa27e9afb8842d0113dd5d6804aca467c to 3390423c6f86ae183987551b529520554f33168f; remote tip verified. See task-1177-integration.txt.
