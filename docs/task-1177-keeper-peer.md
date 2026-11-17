# Task 1177: direct keeper-peer scenarios

Current integration base: `a27bc368b1e027af70883d06d1da9ba2b07985ab`.
The incoming merge did not change the task's five test/helper files or the lockfile.
The hand-in names the exact checked candidate. Run receipts, raw timing/load data and the 28-case before/after table are retained on `task-1177-evidence` and attached to task 1177, preserving the checked source SHA.

## Cause and repair

The original four-second relay test dispatched hundreds of unrelated recurring database reads while advancing twelve virtual minutes. Direct lease, sync and word steps retain the complete 727-second scenario and both outage windows.

The expanded file uses the existing controlled clock, explicit frozen-time fixture reuse and a recorded child lifecycle. The normal fake-clock fixture guard and shared-database isolation checks remain intact. Cold shared database preparation occurs during collection through the same `prepareSharedDatabase` entry point as task 1178. Test and hook timeouts are unchanged.

A later instrumented run exposed another amplification in the test fixture. On `3ffbc81aa13bf5f11aaac9df095780b44287a2ce` plus timing-only probes, API series 4 failed the final peer-door case after 21,135.697 ms, including 15,522.157 ms in network rounds. Waiting for native port completion replayed the entire keeper and reread unchanged database state. Earlier series 4 also failed upload, throughput and address cases after 23,063 / 27,850 / 23,768 ms.

Port readiness now awaits `peerPorts` directly. Session and socket completion waits run no keeper rounds. A changed network view, report, backup, slot sweep or beat gets its own explicit step. Lease scenarios advance only their own virtual clocks and lease decisions. A tunnel step waits for an already running read before issuing its next read. Bootstrap rereads only when its first answer renewed a stale certificate, rather than while listen is pending. The production keeper code has not changed.

Every original keeper assertion remains; successful upload and copy response, read mode after fencing and the exact virtual endpoint are also asserted. An intermediate verification found and corrected a local `state` name collision before the final series.

## Commit provenance

Merge `6a0522420770ae21ff1c3072f9c971dbf90d57e5` was pushed without the requested sign-off trailer by mistake. Its author's DCO attestation is recorded explicitly in this documentation commit's message. The task branch has not been rewritten or force-pushed. Subsequent commits, including later merges, carry the sign-off trailer.

## Verification findings before the final series

At `3410fd979dbce6bc4ffc801a98f962a1b0a4b740`, author lint passed on all five files (exit 0, 314 s). Types found a cleanup callback returning `VitestUtils`; the callback now returns void. The interrupted author check is preserved in `task-1177-author-before.txt` and is not a passing receipt.

The first selected caller file, `migrations.test.ts`, completed 41 cases with eight timeouts. It imports `freshPglite` and `ownDatabases`, whose bodies this task did not change, and never calls `fixture` or `prepareSharedDatabase`. No migration implementation or assertion was changed to address those findings. The other 39 selected files were not all executed. The observed failures were:

- Migration 0112, command states, times and whole requests: 20,433 ms.
- Migration 0116, pulse, fences and merge sources: 32,419 ms.
- Migration 0118, one move: 23,825 ms.
- Migration 0118, the handover a state ended with: 31,162 ms.
- Migration 0119, each handover's kind: 47,790 ms.
- Migration 0119, parked job messages: 56,510 ms.
- Migration 0119, kept led term, hidden link and saved copy: 37,806 ms.
- Migration 0131, fallback lists while preserving plans and cards: 41,640 ms.

Oracle also reported an earlier 60-second timeout of “carries computer access over the peer link” under load 25 to 30. On this branch that case is in `worker-keeper.test.ts:628`, outside task 1177's current file. The attempted acknowledgement to Oracle hit Hornhoof's ten-message limit; no delivery is claimed. The shared worker clock and the `f5171f05` production app-call mechanism remain unchanged.

## Prepared comparison input

The three-file check on `454318e56eebbc08d9becd09d6a57b0a7ef1a453` passed all 28 keeper cases, including the former failing port case in 727 ms. It exposed a comparison-control allocation in `shared-test-database.test.ts`: its rights/roles case took 22,712.939 ms, with 21,818.704 ms in setup. That comparison had allocated another pristine embedded database inside the scenario.

The file now prepares immutable rows, rights, connection setting and planner values from an independent migrated copy during collection, and closes that copy before scenarios start. Comparisons retain their complete values and strict equality. The separate case that creates a second database and proves its independence remains unchanged. On `b3c45ec2f7fc8861e366d6bf9b6adba0e6a061e4`, the three named files passed: 72 passed and 2 expected failures, 74 executed. Server types including tests also exited 0.

## Authorized verification

The head's 02:50 and 03:15 decisions retain the three named files, twenty consecutive isolated keeper-peer runs on the final source SHA, server build, server types including tests and eslint. The head assigned the eight migration timeouts to task 1185. The expanded author check remains a concern, not a passing receipt. `task-1177-unchanged-functions.txt` records an empty diff and identical complete declarations for `freshPglite` and `ownDatabases` against the merge base. The head's collection-time preparation decision of 00:56 was restored explicitly in the task body after its earlier beforeAll wording reappeared. Neither timeout was raised.

The verification command is saved in `task-1177-series.txt`. It uses the installed Vitest API without watch mode, checks the exact named-file selection, requires the original 20-second test and 10-second hook limits, and isolates each file in a fresh fork. Run 00 executes the three area files; runs 01 through 20 execute only `keeper-peer.test.ts`. Each records the source SHA, JSON results, module diagnostics, load every two seconds, load at every case's start/end, and the separately logged database preparation duration. Any failed or skipped case, unhandled error, file-selection mismatch or source-tree change stops the series. No build runs alongside it.

Manual self-review checked the opt-in frozen-clock guard, database isolation and snapshot completion, unchanged assertions and production limits, recorded child termination, cancellation of unfinished waits and the retained actual peer HTTP/TLS path. Security inspection found only test/measurement changes and no production access, secret, process-execution or deployment change. No independent checker, whole-suite result or main integration is claimed.

The head accepted the merge attestation in the task body at 03:15: 6a052242 has no trailer; attestation is in 3410fd97. Every subsequent task commit carries Signed-off-by.

## Port ownership

The first area run on `216a1d5e07c9cb8eb3ffc0eac3d73a0ab1506fa0` stopped before the twenty repetitions: the first keeper case failed with `EADDRINUSE` on `127.0.0.1:24002`, then the next case timed out while reopening the failed test's discarded database. A fixture probe had released the selected port before the keeper bound it, allowing another worker to take it.

Fixture listeners now bind atomically to port 0 and use the actual bound addresses. They never test a port's availability by opening and closing it first. The unavailable-app stand retains its listener, resets incoming connections while unavailable and serves the real app after availability changes, so its address never becomes another process's to take. Keeper cleanup is registered before startup, including partial startup failures. Every original keeper assertion is preserved. No production listener, timeout, clock or keeper implementation changed. The saved API command now uses the repository's ordinary server project configuration, including its workspace cwd and protocol aliases.
