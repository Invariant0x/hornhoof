# Product Test Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a product's pinned test environment with isolated reusable preparation and preserve manual commands.

**Architecture:** One strict protocol owns the manifest, description snapshot and preparation receipts. The node reads exact Git objects, builds immutable node-owned caches and gives each part private copies under the existing outer check slot. The server records the pinned snapshot before planning product parts and retains cache-owner affinity per host, repository scope and runtime.

**Tech Stack:** TypeScript, Zod, native Git, filesystem locks and atomic publication, Drizzle/PostgreSQL, Vitest.

**Spec:** Hornhoof #399 and #280, including the head's frozen contract at 2026-11-05T14:28:43.023Z; /tmp/task-399-design/task-363-design-final.md, task-363-integration-addendum-v2.md and design-280-kimi.md. The task body and later head decisions override historical illustrations.

## Replay preparation follow-up, 2026-11-05 22:27 UTC

The head requested an external reproducible package before admission is restored.
Implement this increment inline. Its scope is an immutable offline workload,
read-only audit driver and explicit execution/comparability contract. The driver
must refuse measurement; it must never accept caller-provided admission JSON as
authority. A runnable measurement adapter is not claimed by this increment.
The current observed deployment is UNFIT. No production runner, admission path,
queue, deployment or measurement is added.

**Files:** `apps/node/test/preparation-replay{,.test}.ts`,
`apps/node/test/fixtures/preparation-replay/*`,
`docs/check-queue-replay.md`; external Git bundle and evidence archive on #399.

**Interfaces:** `inspectReplayFixture(root)` validates the exact regular-file
inventory and SHA256 bytes. `replayCommand(args,root)` accepts only `plan` and
refuses `measure` before opening inputs or starting any workload.

**Review focus:** input drift, missing inputs, preexisting generated outputs,
symlink inputs and caller-supplied false admission must fail closed. The audit
does not establish equivalent execution, cache behavior or isolation.

- [ ] Write failing audit/refusal tests; push a RED-only checkpoint and run just
  `preparation-replay.test.ts` through targeted command-mode `run_tests`.
- [ ] Freeze fixture files and hashes, implement the audit/refusal driver, and
  document exact source pins, API/call sites, phase boundaries, cache/order/load
  policy and the unimplemented measurement adapter.
- [ ] Run the same targeted tests with coverage, test types, scoped ESLint,
  existing-coverage crapper and dryer through `run_tests`; no benchmark execution.
- [ ] Obtain one fresh read-only review of this increment, attach the bundle,
  command and raw outcomes; report UNFIT and remaining prerequisites explicitly.

## Global Constraints

- Base 05d27e284dbbe51f129b3df00c9c805db193d6a6, branch task-399 in its own worktree.
- Top-level version is literal 1; dependencies is one object; profiles reference eligible suite IDs; split replaces selection.
- Empty services is valid. Artifacts are strict {path,format,env?} or {service,path}; the latter path is relative to that service's prepared root and may be '.'.
- main.testOne owns one withCheckSlot before tests.started and all preparation/execution/cleanup. Helpers consume its callback signal without another admission acquisition.
- Never execute repository commands as the cache owner or send Git credentials to commands, manifests, snapshots or receipts.
- No hardlinks/alternates into a shared mirror or cache. Dependency key B never changes key A. READY requires complete validated fsynced publication.
- Respect B's files, #391's 0065 migration and #392's template/task files. Do not edit test/helpers.ts or the queue implementation.
- Generate 0066 only after coordinating the unchanged 0065 snapshot/journal with b30ac28f. Do not merge 0066 into turn-8 before 0065.
- Only targeted tests and compiler/lint/coverage/crapper/dryer checks. No root npm test, full remote run or mutation run. Do not raise test timeouts.
- English repository text, Ivan Korol <invariant0x@icloud.com>, no commit trailers, no main merge or release workflow.

## Review Focus

- Forged/stale/oversized describe replies cannot replace a pinned run's immutable snapshot or expose another repository's credentials.
- Interrupted or concurrent cache writers never publish partial READY state or leave a permanently held lock; consumers cannot mutate shared payloads.
- Symlinks, file names beginning with '-', traversal and workspace links cannot escape the intended checkout or turn selected paths into options.
- Source-only changes reuse preparation; lock/migration/script/runtime changes invalidate only affected keys; an unavailable owner is a cold fill.
- Cancellation and partial service startup stop processes before slot release, including manual compatibility and server restarts during describe.

## Task 1: Canonical protocol and fixtures

**Files:** packages/protocol/src/test-environment.ts, src/index.ts, test/test-environment.test.ts and owned test fixtures.

**Interfaces:** Export Command/TestService/TestPrepare/TestEnvironmentV1 schemas and inferred types, RepositoryScope, RuntimeCapability, environment snapshot/receipt schemas, parseTestEnvironment. listTestUnits/buildTestInvocation live in the node module because they validate filesystem paths and write private selection files. Commands are {program,args,cwd}; repository scope is {companyId,repositoryOwnerId,repoUrlHash}. Describe uses UUID requestId, exact commitSha, scope and repository; response includes original manifest bytes/hash, validated manifest, input digests/inventory, runtime capabilities and a typed problem.

- [x] Write strict command/path primitive tests first; observe rejection failures before implementation. No-service manifest acceptance follows after reset is reconciled.
- [x] Implement stable command/scope/runtime primitives and verify their direct tests (command/scope/runtime complete).
- [x] Reconcile reset: the head corrected #399 at2026-11-05T15:10:33.690Z. Null or nonempty {suiteIds,scope,command,inputs} records are required; command:null requires fixture input paths.
- [x] Test frozen B manifest, both Python fixture variants, strict tagged unions, duplicate IDs, profile/service references, forbidden paths, limits and unsupported versions; observe RED, implement and verify GREEN.
- [x] Test inventory from tracked paths and cwd-relative argv/JSON selection, including a leading-dash filename and honest whole-package execution.
- [x] Add bounded describe/run/result protocol frames and receipt validation; run protocol tests/build/types and commit the complete contract. Send B the parser SHA and fixture result.

## Task 2: Exact Git mirror and immutable cache primitives

**Files:** apps/node/src/test-mirror.ts, test-cache.ts and test/{test-mirror,test-cache}.test.ts.

**Interfaces:** checkoutCommit(source,scope,commitSha,destination,context): Promise<string>; readCommit(source,scope,commitSha,context) returns tracked entries and bounded blob reads. Context carries cacheRoot, deadline, signal and log. Cache functions accept a key, declared payload paths and an isolated builder; return {key,path,hit,inputDigest}. Keys hash canonical commands, sorted input paths/presence/bytes and actual runtime fingerprints, not commit/suite/manifest as a whole.

- [ ] Test an exact old SHA after branch movement, independent objects/no alternates, credential-free clone configuration and serialized fetch; observe RED.
- [ ] Implement private scope paths, trusted Git environment, retained refs, a detached --no-hardlinks clone and cancellable interprocess locking; verify GREEN.
- [ ] Test same-input hits, lock A->B preservation, migration misses, ordinary-source hits, mutated private copies, corrupted payloads, killed writers and overlapping requests; observe RED.
- [ ] Implement checksummed immutable payloads, validated relative links, fsync+atomic publication, independent restore and released-on-crash locks. Missing locking/isolation capability is explicit, never a claimed hit.
- [ ] Run targeted node tests/coverage, types/lint/CC/duplication checks and commit the cache layer.

## Task 3: Node describe and product execution

**Files:** apps/node/src/test-environment.ts, tests.ts, main.ts; new test/test-environment.test.ts and existing relevant runner tests.

**Interfaces:** readTestEnvironment(source,scope,sha,context) returns the bounded description without repository execution. prepareDependencies/prepareEnvironment/openEnvironment return receipts and an idempotent close. B provider methods retain prepareServiceArtifacts(definitions,checkout,context) and openServices(definitions,artifacts,partContext); context and result shapes match the attached test-services.ts. File artifacts are repo-relative; service artifacts are relative to artifacts.paths[serviceId].

- [ ] Test missing/invalid/symlink manifests and exact manifest/input inventory digest without install execution; observe RED, implement metadata read and trusted runtime inventory, verify GREEN.
- [ ] Test cold/warm dependencies and file artifacts, private restores, profile-scoped service requests and failure/cancellation cleanup through a typed service adapter; observe RED.
- [ ] Implement preparation under the existing slot, explicit runtime/isolation matching, cache=none behavior, safe command argv, part reset and service cleanup. Preserve existing manual shell command text and run_work semantics; manual checkout uses the mirror.
- [ ] Test product execution against the immutable snapshot, mismatch failure, no-service behavior, receipt phase timings and JSON/argv subsets. Preserve exact-SHA evidence and result redaction.
- [ ] Wire describe/replay and additive capability reporting in main. Do not alter check-queue.ts. Run targeted node/compatibility tests and commit.

## Task 4: Persisted snapshot, product mode and owner affinity

**Files:** apps/server/src/modules/testruns/{runs,tools,pick,load,describe}.ts, nodes/messages.ts, db/schema.ts; generated 0066 migration/metadata; new test/test-environment-runs.test.ts and migration tests.

**Interfaces:** requestDescription binds requestId, assigned authenticated node, scope and SHA to the run; acceptDescription validates once and persists the snapshot before parts. Product planning consumes profile eligibility, requiredSuiteIds and tracked inventory. Cache affinity is keyed by physical host, repository scope and runtime fingerprint; one active part per node remains unchanged. The manual RunInput branch retains command/parts; product branch has suite/profile and no command.

- [ ] Test mode conflict400 before side effects, manual compatibility, pinned description exchange, foreign/stale replies, immutable snapshot and restart/retry behavior; observe RED.
- [ ] Generate additive nullable run snapshot/hash and part receipt columns plus necessary persisted describe state after migration0065 is available. Test upgrade with existing rows and old null evidence.
- [ ] Implement additive capability dispatch, asynchronous describe state, validated snapshot persistence and product part messages. Never run Git/repository code on the server.
- [ ] Test owner preference on sibling nodes, cold ownership replacement, correct runtime eligibility and whole-package/final-check leaves without duplicating #313's staging algorithm; observe RED, implement and verify GREEN.
- [ ] Expose snapshot/receipts/phase timings through runState without losing commitSha, queuePosition or GitHub status behavior. Commit after targeted server checks.

## Task 5: Atomic run completion against wait_for

**Files:** apps/server/src/modules/tasks/external-wait.ts, testruns/runs.ts and targeted test-runs/external-wait tests. engine.ts remains owned by cc79818e; coordinate before editing it.

- [x] Read the head's #399 addendum and current turn-8 implementation. Reproduce unreadMessage=false -> run end with no wait -> stale move(wait) using an explicit barrier, for tests/work.
- [x] Apply the smallest atomic fix, preserving foreign waits and closed tasks; no timer-based repair or uncontrolled reread.
- [x] Verify both operation orders, one delivery, null externalWait and no extra wake at the former deadline. Record exact SHA and commands.

## Task 6: Real cross-slice integration and measured evidence

**Files:** owned protocol/node/server tests, docs and task evidence artifacts; no B/C source edits.

- [ ] Integrate the actual B provider/manifest when available and parse the actual manifest plus C's Python/no-service descriptions with the canonical parser. Run preparation/execution/cleanup integration without substituting a configured required runtime.
- [ ] Measure identical pinned fixture/workload on a documented turn-7 preparation path and the new cold/warm paths; retain runtime/machine identity, test counts, phase samples and computed percentages. Identify a missing historical baseline explicitly rather than inventing one.
- [ ] Run all affected targeted tests with fresh coverage, protocol/app builds, typecheck:tests, scoped ESLint, package-scoped crapper --use-existing-coverage (existing CC no increase, new<10) and dryer.
- [ ] Request one fresh read-only whole-branch review; one RED/GREEN fix pass for material findings. Record review exclusions and rulings.
- [ ] Verify current0065/0066 journal order with b30ac28f, commit/push task-399 and submit report/raw evidence. Main and release remain outside scope.

## Ledger

- Read #399 twice, #280 completely including frozen14:28 contract, #308, #389 and #391; read all three architecture documents and current callers/runner boundaries. Repository rules match the just-read05d27e28 tree; no CLAUDE.md or formatter configuration exists.
- npm ci completed from the lockfile:407packages,15 existing moderate audit findings; no dependency changes.
- Ruling: version:1 supersedes schemaVersion; split/profiles/artifact/fullPackageGlobs use the frozen baseline, not historical Kimi illustration shapes.
- Resolved by the head at2026-11-05T15:10:33.690Z: reset uses suite-scoped records; fixture command:null requires nonempty inputs. The rewritten task was reread before implementation.
- B API and manifest downloaded from task389; service path '.' is relative to artifacts.paths.pg, file paths are repo-relative. This interpretation was sent to B.
- b30ac28f reserves0065; journal/snapshot are in origin/task-391@6a0eb1c3.0066 must not enter turn-8 before0065.
- Inline execution chosen for shared protocol/caller dependencies. One fresh whole-branch review remains required at completion.

- Protocol primitive increment:8/8 new tests failed on undefined exports, then passed against strict Command and RepositoryScope. Whole protocol226/226; build, test typecheck, scoped ESLint, package-scoped crapper existing coverage and dryer all exit0. No canonical manifest acceptance is claimed yet.
- Ruling: while the reset decision is pending, start independent mirror/cache work using the stable Command/RepositoryScope primitives; the descriptor-specific part of Task1 remains pending. No extra queue or B-file edits.

- Head resolved reset and rewrote#399. Reread the new body; suite-scoped reset is now explicit current truth. Resume Task1 manifest steps before independent mirror/cache.

- Canonical schema RED17 acceptance failures ->GREEN25 total; bounded source/hash RED3 ->GREEN28 total. Frozen B JSON and both C Python descriptions pass; invalid reset/profile/reference/union/path cases fail. This validates description structure, not actual fixture isolation.

- Protocol description/wire increment: RED4 ->GREEN4, malformed JSON/false environment-hit regressions RED2 ->GREEN6; frames/runtime-fields RED2 ->GREEN8. Whole protocol254/254, final targeted36/36 after CC extraction; build/types/lint passed. New maximum CC7, dryer clean.
- Node metadata increment: discovery RED4 ->GREEN4, invocation RED2 ->GREEN6, selective keys RED1 ->GREEN7. Main discovery/cancel wiring RED2, corrected test transport to preserve HTTPS wire validation while reading local Git through the reader adapter. Refused-request tracking and timeout-code regressions each RED1 ->GREEN; affected node88/88. Node test types and scoped lint passed; existing runNode CC166->161, new maxCC7, dryer clean. Product execution/preparation and server snapshots are still outstanding.
- Ruling: test_mode_conflict is the stable ApiError.reason with existing generic validation code, and prefixes the MCP error text. One additive ErrorReason line in src/errors.ts is necessary plumbing outside the exclusive file list; no other error behavior changes. Cost if wrong: align the transport reason name before exposing product mode.

- Head resolved generated inputs at16:32: actual bytes of earlier completed artifacts participate in later keys. Self/forward references/cycles and missing results fail. Generated-input RED2/GREEN10; CC extraction follows before commit.
- Head expanded#399 at16:46 with the existing#296/#347/#367 wait race. Reread the body and receiving-code-review skill before integrating; this is not yet reproduced or fixed. Task5 added before final integration.

- Native migration0066 was regenerated after fresh turn-8/#391 atcaa01f45. SQL is byte-identical to the independently checked preview. Native migration2/2 passed; journal65->66 preserved. B is now available directly in turn-8; do not retain a temporary service adapter.
- Controlled wait race RED2 showed stale acceptance and one deadline expiration for both modes. Atomic task-version change before result commit gives GREEN2. Affected server tests147/147; source tsc, typecheck:tests and scoped ESLint0; endWaitForRun CC4->3, new helpers CC<=3, dryer clean. A task result now advances the current holder's task revision even without an installed wait, requiring a reread for concurrent actions; foreign/closed state stays unchanged.

- B follow-up from turn-8@a484ecac608d03762221a74449a199ef51a124c4 merged atafacb2fa. It includes actual dist inputs and retained service preparation leases. Producer results remain distinct from this task's checks.
- The head approved a measured replay of turn-7 code f289196b97c9d6fea391248d76e422214f2638ad against the same pinned fixture/current machine, not fabricated historical phase data. Equivalent readiness, isolated caches and all versions/phase boundaries must be recorded.
- Runtime matching uses numeric major/minor/patch prefixes as the frozen design says; unsupported range expressions fail closed. Service-only runtimes are requested only for the active profile.
- Node cache internal-hardlink RED1/GREEN17: all inode links must be inside the declared payload, then independent cache and consumer files are created. External links remain rejected. LCOV/tsc/lint/crapper/dryer passed; new maxCC7.
- Product server exchange RED3/GREEN3: optional-command mode, authenticated assigned request, SHA/scope/hash validation, snapshot-before-parts, separate final leaf, invalid-evidence failure and pending-description cancellation. JSONB may reorder scope keys; compare its three fields semantically. Runtime-affinity and receipt validation are still pending.
- Native privileged integration is unavailable here: actual UID1000; unshare -Ur true fails Operation not permitted. Default execution must fail closed without distinct job/builder users; helper-level contract tests cannot be claimed as live UID isolation.

- Node product execution now includes exact-checkout/snapshot verification, isolated minimal-input builders, private dependency/artifact restores, direct B service preparation/open/close, uncached fresh services and cache:none. Process-service integration uses the real provider and guardian, with OS UID/chown/IPC identity boundaries doubled; fake /proc represents those fake UIDs. It proves file/process-group contracts, NOT native UID or PG/image readiness. Parent service directories must be traversable (0755); RED exposed that missing parent, then GREEN preserved cold state and independent warm consumers.
- Server runtime/receipt checks reject missing or mismatched success evidence, persist snapshot before parts, maintain scope/host/runtime owner hints, recover persisted describe requests, and fail unanswered descriptions once. Metadata reading itself needs no execution runtime; execution waits for an eligible node. Product mode rejects64-character pins, preserving legacy manual support.
- On infrastructure recovery inventory, task-399 HEAD40ca2a6c and all working edits remained. The old /tmp/task-399-evidence folder was absent; fresh evidence is now under .superpowers/evidence/task-399. Historical RED observations remain in the task log/ledger; their lost raw files are not represented as newly verified final logs.
- Head added407 runNode complexity validation. Reproduced source CC166 atb8769b5f and168 at5c67fb00; literal origin/main64472f8c has173. Current399 test-message extraction gives161 with affected main tests. Integration/source+coverage verification after the hotfix remains pending.
- Urgent CEO464/task466 gives Simon619a0e6a exclusive delivery/assignment ownership. task-399@40ca2a6c was pushed/read back; committed and working interface patches plus the handoff inventory were uploaded/read back on399 and reported on466. Shared main/protocol/server-node-message edits and turn-8 integration wait for the exact handoff and authorized hotfix. No terminal host/routes/hook or job runner edits here.
- Measured replay still waits for the real shared coordinator: the compiled check CLI /bin/true probe again returned404 after recovery. The head explicitly rejected a private substitute. Native UID/PG/image remain NOT_RUN. This is not final acceptance of399.
- Head later clarified466 through Simon: he uses his own main-based clone; independent399 main/protocol/server-node-message edits need not wait. The broad handoff freeze is lifted; concrete hotfix inclusion/conflicts will be coordinated through the head, with no parallel delivery implementation.
- Additional product result regression reproduced exitCode7 becoming null, then preserved the selected command's real exit status. Repository reconfiguration after metadata was also reproduced: queued product parts must refuse the changed scope instead of sending a pinned snapshot with a replacement repository. Both have RED/GREEN checks in persistent evidence.
- Controlled shared-UID race RED: with a second machine slot granted, runPart entered twice while the cancelled first part was still in cleanup. A per-node disposable-user resource mutex now runs INSIDE the already granted machine slot, with started emitted only after its admission. It uses the existing portable FIFO primitive, never calls withCheckSlot again, reports resource wait, and aborts a waiter with its original reason. Cleanup retains the machine lease.
- Metadata interruption RED: a cancelled reader failed the entire run immediately. Cancellation, timeout and commit_unavailable replies now retry with a fresh request ID at the SAME pinned SHA/scope, up to three assignments. Explicit run cancellation still ignores late replies; permanent manifest problems remain fatal. Retry/exhaustion GREEN records one final part/result.

- Head authorized the early frozen421 protocol-only checkpoint456 before442. It was isolated on task-456@790d77dbc9f59acd69b686a5c1ed92acf2f206a4, with172 focused protocol tests and remote readback;455/434 received its exact exports. The saved399 staged tree255c77f2c18cd0d2886ca9bcde93271ee7f68aa5 was verified unchanged before resuming399. No admission/runtime capability is inferred from those types.
- Fresh whole-branch read-only review completed against integrated basea484ecac. Three Important findings were confirmed by controlled tests: persisted describe delivery after lending/access revocation (RED2), unswept shared builder state on success/failure (RED2), and manual completion before disposable UID quiescence (RED1). The fix pass revalidates and cancels obsolete metadata assignments, sweeps builder-owned shared locations after stopping its writers, and awaits the same UID boundary for manual compatibility. A new mock's TS2322 literal-widening error was also corrected with contextual vi.fn<typeof runTests> typing.
- Final: Ruling: raise the review's service-ID grammar note from Minor to Important because a schema-accepted manifest could not run with the integrated provider. Restrict only service.id to B's existing grammar; no B source/API or frozen fields changed. Direct parser RED1 reproduced db.primary acceptance; the narrowed schema rejects it. Cost: formerly accepted but non-runnable dotted service IDs now fail at the boundary instead of during preparation. B was informed on389.
- Final: Ruling: preserve the offline reader reconnect grace while invalidating an online reader that lost current eligibility; replay cannot send credentials to that revoked node. A replacement has a fresh request ID at the same pinned SHA. Cost: an explicitly revoked assignment waits for an eligible reader rather than continuing in its old context.
- Final: Ruling: review exclusions remain evidence limits, not accepted runtime claims. Native UID/PG17/image checks and measured replay remain unavailable; primitive Git/process/cache tests cover only their controlled cases. Real OS identity boundaries are doubled in product fixtures. Adversarial filesystem/concurrency and native cancellation timing are not comprehensively proven. Unchanged B/engine/host/release internals belong to their owners; current source review does not accept them. Final fresh turn-8/#407/hotfix integration and merged metrics are still required. Cost: this source checkpoint is not task399 acceptance and must not enable a release or runtime capability.
- Deferred minors: none after regrading the functional service-ID defect. All four material review findings enter the single RED/GREEN fix pass; no second reviewer or broad cleanup was added.

- Post-review checkpoint verification: protocol38/38, node151/151 and server209/209 on the final source of this increment, including both controlled wait-order tests. Protocol build, production node/server types, test types and targeted ESLint all exit0. New maximum CC9/CRAP9.2 (productCapable); node new maximum CRAP8.1, protocol7.3. Existing large functions remain explicit inherited exceptions with nonincreasing CC: runNode161, runTests52, startRun31, handleNodeMessage70; runState19 unchanged. No threshold was suppressed or raised. All three package-scoped dryer checks at0.8 report no duplicates. The initial mock TS2322 and extra obsolete test-token cleanup call were corrected; all assertions remain and final checks are green. This is a source checkpoint, not final merged acceptance.

- Prepared a private merge of fresh turn-8@2fed0c54662d69d24e5b158200d3ef9c4205642a into task-399; only test-runs.test.ts imports conflicted, and both people's names and399's machine/access names were retained. No turn-8/main publication is authorized by this preparation. A real fake-terminal/socket regression verifies input_left -> input_kept -> only the next assignment executes; omitting the merged input_kept case gives RED, restoring it gives GREEN without timeout-policy changes (the test advances the idle clock past typing grace).
- Refreshed main reference: origin/main now f289196b97c9d6fea391248d76e422214f2638ad, raw runNode CC167; earlier173 belongs to the cached64472f8c snapshot and is not current main. Merged399 runNode CC163;407 source5c67fb00 has168, pre407b8769b5f has166. Remote refs turn-7 and v0.7.0 both resolve to f289196b, whose parent is12ebbe9c895397bb77556ec89987b5ef36798f96. This establishes the approved future replay source, not a measured acceleration.
- Full staged whitespace check reports one inherited extra blank EOF line in upstream apps/node/test/operator-control.test.ts. That file is byte-identical to turn-8 and belongs to its current owner; it was retained. The task diff check against turn-8 exits0. This is an explicit inherited concern, not a suppressed functional check or an edit to another owner's file.

- New CEO/head T2 policy received after the merge background commands had already started. Preserve all such results as LOCAL evidence; every new authorcheck command now runs through one explicit targeted run_tests command on a platform-selected compatible machine. No private queue/local fallback, no retrospective full suite or substitute measured replay. The pre-policy merged server run ended201/209 with8 test timeouts at unchanged20000ms; cause is unproven, these remain real failures. Other local results: protocol143/143,node152/152,production/test types and scopedlint0, merged runNode CC163/CRAP824.7.
- Before the remote candidate, remove the product fixture's assumption that the executing test UID is1000: fake job/builder identities are distinct from its actual UID, and the shared-root filesystem double exposes only the fixture's registered files. Production isolation checks remain unchanged. This test-only portability edit is awaiting the remote T2, not asserted green from earlier local evidence.

- First real remote T2 run118/part1 pinned1767893b9a059ad7f3e1a3ce06908f5eaa0d3ce1 on the platform-selected built-in node. Preflight/format/install/build/source types/test types/protocol tests and lint succeeded; node149/152 failed in three metadata fixtures because their fixed UID20000 equalled the real test UID20000. The existing production capability guard correctly refused that identity. The corrected main fixture now chooses a distinct test-only UID, retaining all capability/queue assertions. No production guard or timeout changed. Server stages did not run, so the8 previous LOCAL timeouts remain unresolved. Remote load samples and complete tests-118-1.log are retained; no measured replay or live isolation acceptance is inferred.
