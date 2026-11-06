# Test execution V2 implementation plan

> **For agentic workers:** Use executing-plans inline. Task 588 and the head's 2026-11-06 decision approve this work; no separate design approval or subagents.

**Goal:** Execute every selected suite at the pinned commit, with one explicit preparation gate before distributed batches and capability rejection before side effects.

**Architecture:** Keep the existing snapshot/selection envelope and durable testParts dependency graph. Version the new batch/prepare selections, so the old strict V1 parser cannot silently execute a prefix. Reuse authenticated runtime-capability metadata, existing physical-machine admission and preparation caches. Registry/history/reason persistence remains an explicit private port where the shared schema is not released.

**Tech Stack:** TypeScript, Zod, existing node test runtime, Fastify/Drizzle test fixtures, Vitest and pytest.

**Spec:** Task 588 body and head comment at 2026-11-06T10:22:55.145Z; actual writer handoff confirmed by 6d for protocol/test-environment, matching tests, server/testruns/describe, node/tests and node/test-environment. Base origin/turn-8 c8ec81a51c1d5cb3e02034914a066d01afcbc8d8 merged into task-588 without conflicts.

## Global constraints

- All new T2 checks run through targeted run_tests on exact published SHA. No full suite, local heavy checks, deployment, mutation tool or new queue.
- Do not edit main.ts, runs.ts, refs.ts, schema.ts, index.ts or the journal. The node tests.ts lease is ours until an explicit checked release; 546 hooks follow it.
- Canonical manifest ownership is being checked with 6d before activation. Legacy finalChecks retain their post-suite meaning.
- Commit as Ivan Korol <invariant0x@icloud.com>, no trailers or force. Main is untouched.

## Review focus

- Every batch member is validated before checkout/commands; partial, foreign, duplicate or invalid shard selections fail closed.
- expectedCommitSha comes from the actual server-owned pinned run and must match the accepted snapshot and node message, including repository scope.
- An old node never receives a V2 plan as executable V1. Native executor capability is authenticated metadata, not a repository claim.
- Preparation failure/cancellation prevents all dependent batches; existing persisted after/status data handles reconnects without a second FSM.
- A failed suite cannot become a successful batch because a later suite passes. Receipts identify all outcomes, including unrun work after cancellation.

## Contract

The outer TestExecution remains {snapshot, selection}, matching the existing persisted envelope and runs.productMessage. Legacy selections stay unchanged. New strict selections:

- batch: {kind:'batch', version:2, expectedCommitSha, selections:[{kind:'suite',suiteId,files,shard:{index,count}}]}. The coordinates are suite-local. Suite IDs are distinct and all members belong to the canonical profile inventory.
- prepare: {kind:'prepare', version:2, expectedCommitSha}. Commands and once-only suites come only from the pinned manifest policy, never the message.
- manifest execution: {version:2, oncePreparation?:{profiles,suiteIds,commands}}. Once-only suites run at full inventory before the declared commands; remaining suites use batches. Existing finalChecks stay separate.
- Native feature support uses the existing authenticated RuntimeCapability channel with reserved id hornhoof-test-execution, version 2.0.0. Manifest V2 requires that capability via requiredTestRuntimes/supportsTestProfile. testEnvironmentVersion remains descriptor V1; index/main need no new fields.
- Receipt V2 keeps common source/runtime/cache/phase fields and records the exact selection plus ordered outcomes. Legacy receipt V1 remains parseable. Server acceptance checks the source, manifest, assigned selection, authenticated runtimes and complete successful outcomes before a part can pass.

## Task 1: protocol and capability boundary

Files: packages/protocol/src/test-environment.ts, matching test-execution-batch.test.ts and existing environment tests.

- [ ] Write focused parser/manifest/capability/receipt cases before code. Valid batch, prepare and receipt must fail on the real V1 source; existing rejection controls may already pass.
- [ ] Run the focused expected RED remotely, retain every outcome and exact SHA.
- [ ] Implement strict bounded shapes, profile/inventory/source checks, explicit preparation policy and feature capability, preserving V1.
- [ ] Check focused protocol regressions/types/lint/coverage/CRAP/dryer remotely and publish the exact contract.

## Task 2: node execution

Files: apps/node/src/tests.ts, test-environment.ts, focused matching tests/new helper modules where needed.

- [ ] RED before code: expectedM/scope mismatch has no side effects, every batch suite executes, earlier failure stays failed, timeout/cancel leaves truthful outcomes, preparation derives only pinned commands, native shard receives local coordinates.
- [ ] Implement the existing runProductPart path with one environment lifetime per batch, bounded selection files, native shard invocation and exact receipts. Preserve manual runs and V1.
- [ ] Publish/check focused node regressions and compiled API. No 546 output hooks in this slice.

## Task 3: server planning and durable gate

Files: apps/server/src/modules/testruns/describe.ts, owned plan modules, matching integration tests.

- [ ] RED before code: actual run/snapshot mismatch, old capability, mixed batches, successful preparation unlocks all batches, failed preparation blocks them, duplicate description delivery creates one plan.
- [ ] Call the checked planner with server-owned candidate/inventory and current productPlaces observations. Reserve the total part budget for preparation and unchanged final leaves. Use existing after prerequisites.
- [ ] Read history/record reason through explicit private ports until canonical repository binding/schema is released. Do not alias cache ownership to repository identity.
- [ ] Accept only complete bound V2 receipts. Verify real DB fixtures and affected legacy runs remotely.

## Task 4: integration and acceptance

- [ ] Once manifest ownership is confirmed, register the real opt-in configuration/explicit once policy and CLI runtime/dependency impacts without altering ordinary manual configs.
- [ ] Run one targeted distributed run through the supported parts route, keep actual run/part/SHA/machine/load facts and exact selection union. This is not a full suite or a deployed-runtime claim.
- [ ] Reconcile remaining producer/registry/durable-history gaps with 6d/587 and head. No submit before integration.
- [ ] Merge fresh turn-8 into task-588, check affected code on that exact commit, merge/push the turn branch as authorized, then submit with honest NOT_RUN boundaries.
