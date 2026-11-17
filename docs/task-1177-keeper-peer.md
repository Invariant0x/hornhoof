# Task 1177: direct keeper-peer scenarios

Current integration base: `41baacd7b4b59350a1c91418d6020ba182fbdd67`.
The incoming merge did not change the task's five test/helper files or the lockfile.
Verification of the merged candidate is in progress.

## Cause and repair

The original four-second relay test dispatched hundreds of unrelated recurring database reads while advancing twelve virtual minutes. Direct lease, sync and word steps retain the complete 727-second scenario and both outage windows.

The expanded file uses the existing controlled clock, explicit frozen-time fixture reuse and a recorded child lifecycle. The normal fake-clock fixture guard and shared-database isolation checks remain intact. Cold shared database preparation occurs during collection through the same `prepareSharedDatabase` entry point as task 1178. Test and hook timeouts are unchanged.

A later instrumented run exposed another amplification in the test fixture. On `3ffbc81aa13bf5f11aaac9df095780b44287a2ce` plus timing-only probes, API series 4 failed the final peer-door case after 21,135.697 ms, including 15,522.157 ms in network rounds. Waiting for native port completion replayed the entire keeper and reread unchanged database state. Earlier series 4 also failed upload, throughput and address cases after 23,063 / 27,850 / 23,768 ms.

Port readiness now awaits `peerPorts` directly. Session and socket completion waits run no keeper rounds. A changed network view, report, backup, slot sweep or beat gets its own explicit step. Lease scenarios advance only their own virtual clocks and lease decisions. A tunnel step waits for an already running read before issuing its next read. Bootstrap rereads only when its first answer renewed a stale certificate, rather than while listen is pending. The production keeper code has not changed.

Every original assertion remains; successful upload and copy response, read mode after fencing and the exact virtual endpoint are also asserted. An intermediate verification found and corrected a local `state` name collision before the final series.

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
