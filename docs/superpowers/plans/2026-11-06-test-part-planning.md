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

- [ ] Write behavioral tests for small/large runs, free/busy capacity, balanced uneven files, ten-part cap, extra-machine costs, unknown/zero timings, whole-package grouping, deterministic selection and invalid inputs.
- [ ] Publish a minimal unimplemented entry and observe the targeted tests fail through run_tests.
- [ ] Implement the cost comparison and balancing, then remotely verify tests/coverage/types/test-types/lint/CRAP/dryer.
- [ ] Record exact source/run/part/stage and resource facts.

### Increment 2: environment and history adapters

Files: new focused modules beside plan.ts and tests beside test-run-plan.test.ts; reuse existing timings.ts parsing/storage, TestUnit and TestEnvironment inputs.

- [ ] Pin the private prepared-candidate/snapshot/selected-unit seam with owners 6d and staging 70032 before shared edits.
- [ ] Write RED cases for scoped historical timing lookup, Vitest and pytest file selections, paths with spaces, whole-package units and unsupported split descriptions.
- [ ] Implement only the agreed adapters, without a second inventory or arbitrary shell command/image authority.
- [ ] Verify narrow adapter and existing environment regressions remotely, and hand the checked signature/SHA to staging.

### Increment 3: final phases and runner integration

Current gaps: TestExecution represents one suite per leaf; productLeaves emits whole suites and post-suite final checks. There is no explicit globally-once protocol/static phase before all shards and no private expected-candidate/selected-units startRun input. Do not reinterpret arbitrary finalChecks as static commands or invent a public free-SHA flag.

- [ ] Agree and test an explicit internal plan/phase port with the runner owner; record any missing environment field as unsupported.
- [ ] Write RED cases for once-only preparation/static checks before suite parts, exact prepared candidate binding and durable reason reporting.
- [ ] Wire only the agreed insertion, preserve manual runs and the current physical-host admission.
- [ ] Verify the final exact SHA and affected regressions. Observe real pool distribution and machine table only if a supported path exists; otherwise report NOT_RUN with the exact port gap.
- [ ] Merge fresh turn-8 as directed by #588, recheck affected tests on the merge SHA, ordinary push and submit with concerns.
