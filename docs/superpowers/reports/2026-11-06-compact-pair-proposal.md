# One compact-output paired run proposal for378/222

Status: prepared, NOT_EXECUTED. Head accepted369 as a scheme preflight and requested this one-run proposal while the full-suite exception is with the orchestrator. No new run_tests, run_work, full suite, authorcheck or replay was launched for this preparation. The command below has not been syntax/unit/lint tested; it is a reviewable command draft, not a checked replacement driver.

## Exact proposed job

- Existing ordinary run_tests, task378, branch task-378-fixed-pair-proposal, parts1, minutes120. The source API declares TEST_MINUTES_MAX=120; no unsupported memory/image/hostname/file fields are proposed.
- Both fixed sources execute sequentially inside that one part: CONTROL6d0c79b0ced4ab2fc4f771a46479680664d6b663 then OPTIMIZEDb98035e6d1b6b75715a5839ff0a4ea243878e65a, four logical shards each, maxWorkers2, original test limits/assertions, no retry/skip/exclusion.
- The same archive037b48a88284eebfca0f52c909731b338ab74cc45fe33972b882398614e5752d is already in the temporary branch.369 proved this input path, both refs and local object import. No origin fetch or Git credentials are needed.
- The tested edc driver and evidence files remain byte-identical at hashes763cf461e67290355858d6f3064f2c6c9c14c93dfad0ae66255230110a6de293 andee255d499893cbbc814b016bee3806ceebaf3395f0924e570961ca7d66001ec9. Its old wrapper is not used. The new command hash isdf0fb56755029e18dc9825e457219624bc24e0831fdab8b7e972b1719436aeaa.
- A native request with the exact outer40SHA and the command is attached separately after publication. It checks that SHA before `bash docs/superpowers/reports/2026-11-06-compact-pair-command.sh.txt`. No creation call is made until the separate head/CEO exception decision.

The existing driver retains its62 stages,24 preparation/26 suite/12 check stages. Each of eight fresh source directories uses an empty npm cache and builds protocol and node before CLI tests. Preparation, checks and suites remain separate; the measured suite does not absorb build time. The expected package counts from the unchanged pair are protocol218/server2965/node1712/web1430,6325 per variant. The compact wrapper additionally requires those exact counts and62 stages; any mismatch is a failed/incomplete result.

## Compact native log

The driver writes its normal stage/result/footer lines live. Child command output and the full resource journal stay worker-local; they are not printed as rawBase64 or journal bytes. After the driver ends, the command verifies the local gzip artifact sizes/hashes and each raw-stage hash, then emits one readable HH_PAIR_COMPACT JSON packet containing:

- Every file and package timing, with variant/SHA/logical shard/stage/phase, and the executed commands, source/config fingerprints and final counts/result.
- All stage outcomes from the live driver log, their phase times, per-stage all-sample load/free-memory ranges, and first/last full resource samples plus cgroup memory-current ranges. Missing resource values remain unavailable. The checked driver still rejects identity/quota drift.
- Every raw-stage byte count/SHA256, original Vitest/TAP passed/failed/skipped/todo summary lines, the local journal byte count/SHA256 and gzip metadata, and driver stdout/stderr byte counts/hashes. A detected nonzero skip/todo/cancel counter makes the wrapper fail. Hashes attest identities and do not substitute for delivering those bytes.
- Failed-stage diagnostic tails up to2048characters, explicitly marked truncated when longer. Any failed/timeout/cancel/incomplete outcome remains failed; a bounded excerpt never makes it GREEN.

The unchanged700KiB console budget reserves64KiB for runner/clone/command lines and an INVALID footer, leaving636KiB for relayed driver output plus the final compact packet. Overflow does not remove timings/checks to obtain PASS: it produces HH_PAIR_COMPACT_INVALID and exit1. The full journal is never squeezed into that packet. The driver's existing50MiB/file and18evidence+2reserved output-slot limits are unchanged for local evidence generation; this does not add an author-readable test export capability.

As artifact preparation only, filtering numeric/command/stage records from the already preserved diagnostic106 journal produced252032bytes for880 retained records. That is an old-data size estimate, not execution or validation of this new command, not a guarantee of future size, and not performance evidence. The command has its own explicit budget check.

## Resource and time conditions

The platform chooses a compatible executor through the existing pool. No machine is pinned and no private queue, Docker daemon, installation or rights change is introduced. The command rejects non-Linux or Node other than22.23.4 before suites; architecture, CPU/memory quotas and worker identity are recorded and must stay the same throughout both halves. One part keeps the halves in one execution context; it does not by itself prove exclusive physical-host isolation. Actual admission/common-slot facts must come from the normal platform receipt, not invented fields.

369 observed16CPUs/cpuset0-15/cpu.max=max100000/memory.max=max and load1 0.45..1.37 over46.622seconds. It reserves neither those conditions nor a future quiet window. The earlier4GiB allowance was a proposal, not a run_tests parameter or measured quota. A120-minute timeout is the one proposed whole-part limit, not a raised individual-test deadline. If the admitted resource cannot keep comparable conditions, report that limitation; no blind retry is authorized.

## Is the full journal required?

It is not mathematically required to recompute per-file, per-package and per-phase timings or verify case counts: the compact packet includes those records in full. It is required for an independent audit of arbitrary raw failures, every captured line and the full five-second resource history. A hash alone cannot provide that audit, and worker-local temporary files are not durable author-readable delivery.

The earlier head instruction on378 after106 explicitly required complete raw logs outside bounded console. The new instruction changes what to print; this proposal makes the remaining retention boundary explicit. If head accepts the compact native log as the evidence package for the exceptional comparison, numerical review can proceed with the stated limitation. It must not be described as delivery of the complete raw journal. A failed/incomplete pair is diagnostic only and cannot prove full-suite GREEN or acceleration. No new transport is built or awaited here.

## Preserved boundaries and next action

This remains a new sequential paired replay, not historical distributed wall101 or proof of30% against turn7.353FAIL,106FAIL/HH_PAIR_INVALID and103/0049FAIL remain. The checked driver114/138 and source checks329/330/369 are not repeated. The temporary proposal branch never merges into turn-8 and is removed only after222.

Await head's separate decision on this exact one-run proposal and the exception requested through the orchestrator. This preparation has no permission to start it. The head can also decide whether a narrow remote command-format check is needed before the exceptional full comparison; none was launched under the current no-new-runs instruction.
