# Product Test Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a product's pinned test environment with isolated reusable preparation and preserve manual commands.

**Architecture:** One strict protocol owns the manifest, description snapshot and preparation receipts. The node reads exact Git objects, builds immutable node-owned caches and gives each part private copies under the existing outer check slot. The server records the pinned snapshot before planning product parts and retains cache-owner affinity per host, repository scope and runtime.

**Tech Stack:** TypeScript, Zod, native Git, filesystem locks and atomic publication, Drizzle/PostgreSQL, Vitest.

**Spec:** Hornhoof #399 and #280, including the head's frozen contract at 2026-11-05T14:28:43.023Z; /tmp/task-399-design/task-363-design-final.md, task-363-integration-addendum-v2.md and design-280-kimi.md. The task body and later head decisions override historical illustrations.

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

**Interfaces:** Export Command/TestService/TestPrepare/TestEnvironmentV1 schemas and inferred types, RepositoryScope, RuntimeCapability, environment snapshot/receipt schemas, parseTestEnvironment, listTestUnits and buildTestInvocation. Commands are {program,args,cwd}; repository scope is {companyId,repositoryOwnerId,repoUrlHash}. Describe uses UUID requestId, exact commitSha, scope and repository; response includes original manifest bytes/hash, validated manifest, input digests/inventory, runtime capabilities and a typed problem.

- [x] Write strict command/path primitive tests first; observe rejection failures before implementation. No-service manifest acceptance follows after reset is reconciled.
- [ ] Implement stable command/scope/runtime primitives and verify their direct tests (command/scope complete; runtime remains).
- [ ] Reconcile reset with the head before executing its parser steps. Proposed baseline: null or nonempty {suiteIds,scope,command,inputs} records, including command:null for fixture reset. This contradicts the abbreviated Command[] in #399; question is recorded in its log.
- [ ] Test frozen B manifest, both Python fixture variants, strict tagged unions, duplicate IDs, profile/service references, forbidden paths, limits and unsupported versions; observe RED, implement and verify GREEN.
- [ ] Test inventory from tracked paths and cwd-relative argv/JSON selection, including a leading-dash filename and honest whole-package execution.
- [ ] Add bounded describe/run/result protocol frames and receipt validation; run protocol tests/build/types and commit the complete contract. Send B the parser SHA and fixture result.

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

## Task 5: Real cross-slice integration and measured evidence

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
- Pending head reconciliation: reset Command[] versus suite-scoped fixture records. No reset-dependent implementation is approved by inference.
- B API and manifest downloaded from task389; service path '.' is relative to artifacts.paths.pg, file paths are repo-relative. This interpretation was sent to B.
- b30ac28f reserves0065; journal/snapshot are in origin/task-391@6a0eb1c3.0066 must not enter turn-8 before0065.
- Inline execution chosen for shared protocol/caller dependencies. One fresh whole-branch review remains required at completion.

- Protocol primitive increment:8/8 new tests failed on undefined exports, then passed against strict Command and RepositoryScope. Whole protocol226/226; build, test typecheck, scoped ESLint, package-scoped crapper existing coverage and dryer all exit0. No canonical manifest acceptance is claimed yet.
- Ruling: while the reset decision is pending, start independent mirror/cache work using the stable Command/RepositoryScope primitives; the descriptor-specific part of Task1 remains pending. No extra queue or B-file edits.
