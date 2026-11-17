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
