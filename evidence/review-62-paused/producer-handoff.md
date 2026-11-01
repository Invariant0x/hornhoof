# Task 62 native capture handoff

R2 accepts the completed read-only task 75 with both reviews. This source and design handoff does not activate quota classification or establish the product outcome of tasks 62, B0 or 52. Product source remains exact 054913b; this revision changes only owner evidence and synthetic negative vectors.

## Source and ownership

Accepted task 72 qualifies only upstream `@moonshot-ai/kimi-code` 2.4.1, commit `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7`. Its 24 manifest payloads were rehashed locally. Manifest SHA256 is `31ac91f9b13bbe7bfc1691964ca179411780464ce823fb676e02929db483e7cb`. The five synthetic error payloads in the new fixture are copied from the accepted serializer output, SHA256 `bbfcbe1a5b71e6fe0703d5c766e0a10396f2a15465ae580037e271fe503a4362`. No upstream module or CLI was executed here. Root envelopes are synthetic constructions from the qualified source, not captured provider events.

Only new native metadata, reader and independent tests change on this branch. Frozen 165 remains an ancestor, not an amended commit. Saved 66/57b8a1 is not merged. Host, runner, main, transcripts, programs, providers, usage, tmux, protocol, server and migration files are unchanged in this increment. Existing LineTail text semantics are exercised through its public API.

The exact contract was published in task 62 before code edits. Task 74 owns actual job/attempt phase hooks and durable diagnostic snapshots, not native quota authority. Task 66 owns raw usage normalization and the canonical budget store. Task 60 owns artifact transfer. No second job manager, receiver or usage store is introduced.

## New local APIs

`projectNativeRecord(unknown): NativeRecord | null` validates the source layout and returns only these immutable, bounded fields:

| Record | Retained fields |
| --- | --- |
| turn.prompt | type, agentId, optional turnId/promptId, original numeric Unix-ms time |
| turn.ended | type, agentId, turnId, reason, optional durationMs/root traceId, original time, optional error |
| error | optional name, code, nested retryable, optional details.statusCode/requestId/traceId |
| metadata | type, protocol_version, created_at |

Absent IDs remain absent, null request/trace IDs remain null, and root traceId is independent from error.details.traceId. TurnPrompt permits missing turnId as the source schema does; that record supplies no turn anchor. Unknown types, wrappers, wrong numeric encodings and missing nested retryable are not normalized into a supported record. Other agents and late/out-of-order events retain their actual identifiers/times locally; the reader has no current-job authority to reassign or reject them on behalf of a job.

Identifiers are bounded local private metadata for a future causal comparison. These objects are not HTTP, log or wire DTOs. Prompt/input/origin/content/reasoning, exception message/stack/cause, auth/request objects, file paths and caller claims such as jobId/sessionId/trusted/source/version are not returned. No quota label, reset time or retry time is inferred.

`NativeRecordReader(file, options).read(): NativeRead` opens only a regular, non-symlink final path using O_NOFOLLOW/O_NONBLOCK, pins the descriptor for that call, and closes it in every path. It returns:

- `records[]`: immutable `{record, generation, byteStart, byteEnd, capturedAt}`; half-open UTF-8 byte range includes the terminating newline.
- `cursor`: immutable `{generation, byteOffset, readOffset, atBoundary}`. byteOffset is the last complete physical line boundary; readOffset can include an unfinished line. Malformed/unsupported lines still occupy byte ranges, with bounded discard counts.
- `caughtUp`: the reader consumed the file size observed at the final check. This is not an input fence, a durable writer receipt, or a statement that an unfinished line is complete.
- `continuity`: opened, continuous, replaced, truncated, rewritten, unavailable or changed during the read; plus counters bytesRead/discarded/oversized. No raw diagnostic data or exception text is returned.

Hard ceilings per call are 65,536 new payload bytes, 32,768 bytes per retained physical line including newline, and 128 complete lines, including discarded ones. Limits may only be lowered. No loop drains an unbounded file. An oversized line is discarded through its newline before resynchronizing. Partial UTF-8 bytes are combined before decoding, and invalid UTF-8 is discarded.

The new-payload `bytesRead` counter excludes bounded continuity verification reads. The preceding and new anchors are each at most 65,536 bytes; preparation and validation perform at most three additional bounded anchor reads. They never scan the historical file prefix. Replacement, observed shrink, changed preceding anchor, missing file and detected concurrent changes invalidate local generation/partial state. Failed I/O exposes only the fixed unavailable state.

Generation is a random reader-local identity tied to observed dev/inode and anchor continuity, not a verified writer append generation. A new reader has a different generation. Identical physical records at different ranges are preserved separately, and one reader does not return the same consumed range twice. Cross-reader replay and semantic duplicate rejection belong to a qualified producer, not this reader.

## Exact source and future consumer boundary

Task 72 references `turnOps.ts` TurnPrompt/TurnEnded, Event2 numeric time, loopService native start/terminal dispatch, eventDispatcherService durable append, and wire metadata protocol 1.5. The pinned final writer was read separately with `git show ...:packages/agent-core-v2/src/persistence/backends/node-fs/appendLogStore.ts`, encodeBatch: JSON.stringify(record) plus newline, without wrapper. That source read is not writer execution or runtime qualification.

At this branch's unchanged source:

- runner.ts runJob retains actual msg.jobId, while RunInput/RunResult do not carry a native causal receipt.
- main.ts startJob's tracked adapter invokes host.run. Task 74 owns adding actual HH job/attempt identity at this boundary.
- host.ts turnIn drains old text, creates a turn whose jobId is null, then pastes and sends Enter. None is a causal native acknowledgement. Do not turn drain-before-paste into such an acknowledgement.
- programs.ts findKimiWire identifies a candidate session/main wire path, not a process-bound native session or a writer generation.
- host.ts tailFor/drain and transcripts.ts LineTail/kimiWire remain unchanged. Native capture is not hooked into them. There is no production importer of native-reader; native-records is imported only by native-reader.
- the existing server currentRefusal requires a failed running conversation, matching provider/session and an event time inside the job interval. Those guards cannot independently attest native runtime/start/cursor. Its optional DTO must not be filled by a merely parsed line.

A future locally constructed binding must independently establish all of the following before emission:

1. Exact launched artifact digest, runtime identity and approved artifact-to-source/build manifest matching the source/error/writer profile. A version string, protocol metadata, --version result, or caller boolean does not establish it.
2. Actual HH job/node/subscription/agent and node-created process generation bound to the launched process. Use existing ownership, not another job store or a tmux name as a process identity.
3. Verified native session/main-agent file and writer append generation, with a complete byte cursor captured before delivering the HH input. A reader-local generation is only supporting metadata.
4. A supported acknowledgement binding that exact HH input reference to native promptId/turnId, or an independently proved exclusive ordered acceptance boundary that handles owner input, steering, retry, reconnect and compaction. First later turn, nearest timestamp, duration subtraction and turnStep are insufficient.
5. Matching durable turn.prompt and causally terminal failed turn.ended in the same bound context. Multiple internal turns must not create multiple HH failures. Match the complete source name/code/status/nested retryable tuple only after the prerequisites above.
6. Preserve event time as observedAt only after qualification, and retain separate immutable capture time. Reject future/pre-run/stale/unbound or ambiguous events without re-aging them. Deduplicate within the bound process/session/writer generation/native turn/range; do not rebind outbox/reconnect events or treat them as recovery.

No live capture/input API is implemented because steps 1 through 4 are not proved. Accepted task 75 has completed its read-only qualification; its corrected handoff replaces the earlier plain-text handoff. Both reviews accepted it at 2026-11-01T11:36:39.737Z and 11:41:21.585Z. Packet: 28,327 bytes, SHA256 `6c7a47cfde33df6f58f7f1d23992279c00b0d883ae56c2a60fb8ce375114ac5f`; corrected handoff SHA256 `4720d067a93fe663e37e4bbf5ecf9a25128bbb4de37065d451c43aa250e93871`. Its 14 manifest payloads and SHA256SUMS (15 entries including manifest) match after safe recovery here. No CLI audit, public download or runtime metadata audit was repeated.

## Accepted 75 facts, Minors and remaining capability

FACT: the author's installed package declares 2.4.1; installed main.mjs and package.json byte-match the official archive. Main SHA256 is `fd15d5c9b48892bb4f1d5fe82df9f790c8c19a44ca9a81054cc592b6fb9e2c90`. Registry provenance payload attributes source commit `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7`. Sigstore chain verification was not performed. These are accepted 75 observations, not a new Codex read of Kimi's installed filesystem. The running process's loaded JavaScript artifact, runtime version and loaded-artifact/source equivalence remain UNKNOWN; historical identity remains UNKNOWN. No --version ran: bootstrap/update/native cleanup precede its parse.

SOURCE_CONFIRMED GAP: current interactive paste, raw owner input and queued steering share a native stream. UserPromptSubmit lacks promptId/HH input ref; TurnStarted lacks HH input ref. Durable turn.prompt contains native IDs, but neither those IDs, phase74 nor a first later turn establish the HH input's causal acceptance. The exact remaining capability is an attested launched artifact tied to the actual child, plus a supported current HH input acceptance receipt bound to that process/session/native prompt/turn/file generation, or a proved ordered fence preserving owner input. Node-created PID/start generation, session-created/file generation and before-input complete byte cursor are separate requirements. No caller-supplied verified flag can replace them.

Minor 1 resolution, SYNTHETIC_ONLY: the future design predicate must require `isFalse(goal_or_background_or_reload)` and `isFalse(typed_before_ack)`, where isFalse accepts exactly boolean false. Missing, null, zero and empty string are UNKNOWN. The owner copy in `handoff75-r2/design-fence.mts` and its tests first reproduced the permissive truthiness error (17 pass, 8 fail), then passed 25 tests after strict comparison. The suite has 16 original negative vectors, 8 additional missing/null/type negatives, and one positive design vector. This boolean model is not runtime admission, a producer, or proof that a product path is ready. Task75's delivered packet stays immutable.

Minor 2 resolution: `session.resume_hint` is absent on the target refusal path. The failed turn throws at installed bundle line 482543, is rethrown at 482317, before writeResumeHint at 482321. A future producer must prove process/session-created/file-generation binding separately on failure; stdout hint cannot supply that binding. Resume remains unqualified.

Reader integration resolution from the second review: reuse existing exact054 `NativeRecordReader` and `projectNativeRecord`. Do not add another cursor to LineTail or rewrite its text API. The earlier 75 handoff suggestion to extend LineTail is superseded by this saved owner reader.

75 describes `managed_headless_new_session_single_input` as a possible source-supported design using the existing direct adapter, ignored stdin, new session and single submit. It is not a qualification of the interactive product path. A managed launcher, CLI/native causal run, new transport or product-path switch is not authorized here and is not implemented. Even that proposed path still needs actual child artifact/source identity and session-created/file-generation proof on failure. All 17 actual producer cases remain NOT_RUN_GAP. Classifier stays OFF and quotaRefusal is omitted for unbound input, unknown runtime or wrong shape. Unknown/generic failures retain ordinary handling; no reset/recovery is inferred.

## One small source bundle for independent gates

The preserved `native-increment.bundle` contains only the three reader commits and requires frozen165. To avoid a hidden base, `handoff75-r2/source-054-from-bd.bundle` includes the two required foundation commits as well, with sole prerequisite `bd696b0724385b6b11da53a24ada2f188b031217`. It is 38,758 bytes, SHA256 `eee319c405f1544b0997270499bc5259d6188ef14a361abfcbaf272efe8ce984`, ref HEAD exact `054913b9b36455e6a5fcd98ae68335a5cd1f199b`, tree `d82120788e5e28c1d5cb4926c85b4bca0502c6bb`. `handoff75-r2/source-manifest.json` records all five ordered commits, exact parents/trees and 18 bounded base64 parts. This is source only, not a repack of 340 evidence files.

Migration `0021_quota_wait` from frozen165 is provisional and preserved unchanged. Final combined journal/order is head17 -> 62 -> 66 -> 67 with DevOps qualification; no renumbering or production migration claim here. The reader adds exactly seven new files over165; the full source bundle changes 29 paths overbd. Saved66 remains `57b8a11935c0a040cec784b0d60a6579a113ee70`, based on165, and B1 authoring need not wait for native proof. Canonical usage/store ownership stays solely66. No shared M or foreign worktree is changed.

Full/root and mutation execution are NOT_RUN; activation=false; git push is NOT_RUN because root-before-push checks have not been authorized/run for62. Independent gates receive this source bundle, not an alleged whole-task/product PASS. The historical 52 reader tests and quality evidence below concern unchanged source and are not relabeled as fresh root qualification.

Bounded filesystem anchors cannot prove that an earlier unobserved prefix was unchanged, exclude rewrite-and-regrow/inode reuse with identical sampled bytes, fence a mutation after validation, or bind a native process/session to this file. Those remain unknown and must not be promoted to append-generation proof. Correct profile-shaped bytes plus a plausible cursor are still unbound.

## Executable results and gaps

`producer-cases.json` maps all 17 future acceptance cases from task 72 to actual helper checks and explicit producer gaps. Every actual producer scenario is NOT_RUN, since no qualified runtime or causal input operation is present. Helper checks are partial evidence, not 17 green activation tests. In particular other process/session/job/agent/start and late/out-of-order tests preserve original metadata and omit untrusted authority; they do not pretend that the reader has a context it does not receive.

The two API skeletons were tested before implementation: projection RED 8 failed/16 passed, then 24 passed; reader RED 18 failed, then combined 42 passed. These were new API scaffolds, not an active always-false classifier. Later real-tempfile fault tests and a physical-duplicate/privacy boundary test brought the selected suite to 52 passed. The fixture is source-shaped synthetic data, with no actual provider call or runtime event.

Final targeted command and output are in native-boundary-final.meta.json/log: node's three terminal-native test files, maxWorkers1, no-file-parallelism, scoped V8 LCOV/text coverage. It reports 3 files, 52 tests, exit0, and both new production files at 100% statements, branches, functions and lines. Production and synthetic-test TypeScript checks and node build exit0. No repository formatter/linter configuration or npm script was found; whitespace/style checks apply only to the seven new files.

Scoped crapper uses `--root apps/node --use-existing-coverage --threshold 10` with those two new source paths: max CRAP6.0/CC6, exit0. The first root-level attempt instead saw the preserved earlier server-only LCOV and reported 0%/exit2; its failure is retained and was corrected by selecting the actual app coverage root, without changing thresholds. Dryer0.8 initially found one duplicated test temp factory; the new per-caller native-files helper removes it, and the final all-new-TS-files check reports no duplicates. Mutator scan lists 65 sites, exit0; no mutations were executed. Full/root/global quality and mutation execution are NOT_RUN pending a separate head slot, not green checks.

Old server/protocol/recovery suites were not repeated and no claim of a fresh full-task PASS is made. No CLI/model/network/runtime qualification, deployment, package install, live session, permission change, main update, or push occurred. Root-before-push remains required. All earlier task 62/66 artifacts and branches are retained.
