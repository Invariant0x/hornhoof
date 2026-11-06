# Test part planning implementation plan

> **For agentic workers:** Use executing-plans to implement these increments in this task's isolated worktree. The task authorizes implementation and the turn's common review; no separate plan approval or subagents.

**Goal:** Choose up to ten balanced test parts from historical file times and current compatible capacity, with explicit preparation and collection costs and a recorded reason.

**Architecture:** A pure planner consumes canonical TestUnit selections, scoped historical durations and trusted capacity observations. Environment adapters translate its selections without discovering another inventory. An integration port binds a prepared candidate and its environment snapshot before the existing runner records and executes the plan.

**Tech Stack:** TypeScript, existing protocol/TestEnvironment types, Vitest and pytest adapters.

**Spec:** Hornhoof tasks #588 and #313, sections 2 and 3. Existing environment contract is packages/protocol/src/test-environment.ts.

## Global constraints

- Work on task-588 from turn-8@353a099a6b6a47477e47f2de7b88c9ab8bd85675; Ivan Korol <invariant0x@icloud.com>, no trailers, force or main.
- All author checks run remotely through run_tests on exact published SHA. No full suite or local heavy checks.
- Do not change shared runs.ts, refs.ts, describe.ts, protocol or schema without the current owner's narrow handoff.
- #535 and #378 take priority. Actual pool distribution is NOT_RUN until observed; unit plans are not runtime receipts.

## Review focus

- Repeated file names across suites and indivisible selectionUnit groups must not drop or duplicate tests.
- Unknown/invalid timings are explicit estimates, never fabricated measurements. Deterministic fallback order survives input reordering.
- Invalid costs/capacity and unavailable machines cannot produce fictitious capacity or claimed speedup.
- Extra setup/collection cost can make an additional machine undesirable even when it reduces the largest test bucket.
- Prepared source and canonical repository identity must not be replaced by an agent branch, cache owner or unbound client SHA.

### Increment 1: pure planning

Files: create apps/server/src/modules/testruns/plan.ts and apps/server/test/test-run-plan.test.ts.

Interface: planTestParts({units, durations, availableMachines, costs:{setupMs,collectMs}, unknownFileMs}) returns nonempty parts with each selected unit exactly once, timing provenance, one-machine estimate, evaluated alternatives and a reason. Zero available machines produces one queued part, not a readiness claim. Whole-package selectionUnit groups remain indivisible. Equal-cost alternatives choose fewer parts.

- [x] Write behavioral tests for small/large runs, free/busy capacity, balanced uneven files, ten-part cap, extra-machine costs, unknown/zero timings, whole-package grouping, deterministic selection and invalid inputs.
- [x] Publish a minimal unimplemented entry and observe the targeted tests fail through run_tests (751, 22/22).
- [x] Implement the cost comparison and balancing, then remotely verify tests/coverage/types/test-types/lint/CRAP/dryer (798, 51/51 combined).
- [x] Record exact source/run/part/stage and resource facts (798 on 8f54ed0705477aeb16ee75e6b19faf7b47d849d2).

### Increment 2: environment and history adapters

Files: new focused modules beside plan.ts and tests beside test-run-plan.test.ts; reuse existing timings.ts parsing/storage, TestUnit and TestEnvironment inputs.

- [ ] Pin the private prepared-candidate/snapshot/selected-unit seam with owners 6d and staging 70032 before shared edits.
- [ ] Write RED cases for scoped historical timing lookup, Vitest and pytest file selections, paths with spaces, whole-package units and unsupported split descriptions.
- [ ] Implement only the agreed adapters, without a second inventory or arbitrary shell command/image authority.
- [ ] Verify narrow adapter and existing environment regressions remotely, and hand the checked signature/SHA to staging.

CLI acceptance lives in test/test-run-invocations.cli.ts with vitest.run-planning.config.ts because it requires a prepared fixture-local pytest interpreter. This separate fixture suite is not yet registered in the product descriptor; register its runtime and outside-graph node-helper dependency in the agreed serial integration before claiming final acceptance. The child fixture calls the existing node buildTestInvocation over literal descriptor data; it is not another production runner. Synthetic fixture weights are not performance measurements. Native Vitest --shard is checked separately from weighted explicit file lists; the latter must not be sharded a second time. Raw assertion/setup JSON and assertion/collection JUnit captures are format examples for staging, not culprit authority or new failure wire.

Checkpoint 860 on 2247071193a8f0343737f12c06030c60b3cdb909 passed all eight CLI cases and twelve authorcheck stages. Its thirteen actual child captures are attached to task 588, with raw log and hashes. This establishes fixture execution and format examples only, not weighted native sharding or actual pool allocation.

Next independent adapter: an opt-in product-side PlannedVitestSequencer in test/planned-vitest-sequencer.ts consumes the existing node-written HH_TEST_FILES JSON selection. Its custom shard method retains the planner's exact file set while inheriting the framework's sorting. Unit boundaries must reject empty, malformed, escaping, duplicate or uncollected selections; native CLI cases must prove the uneven 1+2 allocation, all project variants across sequence groups, and refusal without --shard. Default root/workspace configs remain unchanged. This uses the public Vitest 5.0.5 BaseSequencer contract (https://vitest.dev/config/sequence), not a new node capability or wire version. The initial 406f2679 checkpoint contained explicit unimplemented entries until remote RED was observed; production activation still needs the owner's descriptor/phase handoff.

876 on 406f267963563cc93d45000ee2d11076f3fe5d2a failed all fifteen selection cases and the three new CLI cases, with successful preparation and lint. Full raw log SHA256 f35a9eda2968cadeb771db9598f7e13410282c7c6f8c38d2fd86c3d61acf4ccf is retained. Ruling: the early-refusal case now checks that no test file body executes, preserving the original selected tests and failing unselected guard. Its earlier report-null expectation was incorrect: actual Vitest JSON reporting emits a report even after a sequencer error. The opt-in fixture adds the default reporter alongside JSON so startup diagnostics remain visible. Neither change weakens exit or file-execution assertions.

The adapter retains BaseSequencer.sort, validates the selected paths against relevant specifications across all groups, then filters each actual shard group without applying a second count split. Runtime wire activation and canonical descriptor registration remain pending.

885 on 3c312cd88bf5f1f973569016b6cc797c29fa25b6 remains FAILED: all 26 behavioral cases passed, but test types rejected the upstream-internal filenamePattern property and CRAP reported selectionInput=12 at conservative 0% child-process coverage. Full log SHA256 e5522f7bc3fbe9777209febb5ba841d477312c8ec58224ed870b034985642a7e is retained. No exception or lowered threshold. The type fix uses public parseCLI plus getRelevantTestSpecifications, preserving filename-filter validation without an internal field. Add a real CLI filter-conflict regression. Expose the existing byte reader as an explicit path-taking helper and cover actual filesystem reads, absent input, malformed JSON/UTF-8 and the byte bound directly; these characterize already implemented reader behavior rather than claiming child-process coverage was mapped. Keep child-only class coverage conservative.

890 on 42f1828b1ced40ed840384738e92232b3775d473 remains FAILED: 31/32 cases passed, types/test-types/lint/CRAP max 6/dryer passed. Reader direct coverage is 100%; complete adapter coverage stays 15/22 lines, 6/11 functions, 10/12 branches because its class runs in real children. The new filter-conflict fixture supplied only one collected file for native --shard=1/2, so Vitest's pre-shard file-count guard rejected it before the custom adapter. Ruling: supply both unrelated files as CLI filters, preserving the assigned first file, exit assertion, missing-selected-file error assertion and zero-executed-tests assertion. No implementation change or threshold change. The full 64104-byte log SHA256 18e64a1070f569bde57c69fcc3c4fc237910d608683f204692497695437c6777 is retained. Future runner integration must bind per-suite shard coordinates, not blindly reuse the total number of logical parts spanning multiple suites/frameworks; native count must not exceed that suite's collected file count.

893 on 881baa625b9cb28d778ddb4300aef838a66ebdb7 passed all 32 cases and eleven authorcheck stages. Full evidence ZIP 7d4ea541-755d-4abe-9599-2dee77e2695c is on task 588, with all earlier failed logs retained; the checked opt-in adapter API/SHA was sent to 6d. The node/shared schema slot is still not released.

Next independent data seam: plan-shards.ts::withSuiteShards(parts) retains every part/selection and adds suiteShards[{suiteId,index,count}], counting only logical parts containing that suite. It must keep single/whole-package suites at one local shard, preserve multi-suite batches, and reject empty selections, duplicate suites and post-suite final leaves. This is not a TestExecution schema extension, node capability or authorization. First observe eight unit RED cases against the explicit unimplemented entry, then connect the checked data to planEnvironmentParts and add actual mixed Vitest/pytest CLI coverage before declaring the increment checked.

### Increment 3: final phases and runner integration

Current gaps: TestExecution represents one suite per leaf; productLeaves emits whole suites and post-suite final checks. There is no explicit globally-once protocol/static phase before all shards and no private expected-candidate/selected-units startRun input. Do not reinterpret arbitrary finalChecks as static commands or invent a public free-SHA flag.

- [ ] Agree and test an explicit internal plan/phase port with the runner owner; record any missing environment field as unsupported.
- [ ] Write RED cases for once-only preparation/static checks before suite parts, exact prepared candidate binding and durable reason reporting.
- [ ] Wire only the agreed insertion, preserve manual runs and the current physical-host admission.
- [ ] Verify the final exact SHA and affected regressions. Observe real pool distribution and machine table only if a supported path exists; otherwise report NOT_RUN with the exact port gap.
- [ ] Merge fresh turn-8 as directed by #588, recheck affected tests on the merge SHA, ordinary push and submit with concerns.
