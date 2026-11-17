# Task 1190: future stage owners after employee removal

Status: DONE_WITH_CONCERNS, ready for independent Review. This is an author handoff, with Security and Tests still required.

Base: `11aa5777c4a5f74a550c0e53570ec35ebae39f53` from origin/turn-31 at the authorized start. Checked executable commit: `47d80c905b5d671f8825c77a5eb7dd0252cfd73b` on task-1190. The delivery adds only this report after that commit; the attached manifest records the exact delivery commit and verifies that difference. No code changes follow the passing checks. The head integrates for 0.31.1; no push or merge to turn-31 or main was made.

## Result and scope

Removing an employee replaces its pending future stage owners with eligible staff of the same role and department. Initial checker selection and future replacement share stageStaff and checkerFor, preserving product/team scope, abilities, model capability, self-check exclusion and preference for another provider. Future stages remain pending and their replacements receive no turn. Without a replacement, one normal Hornhoof letter lists the tasks and stages for the department head, using the existing internal fallback when necessary.

The change is limited to actual employee removal (removedAt). Switching an employee off or moving it into a team retains the existing behavior. The planned Development executor is updated before any candidate exists; submitted producer identities, completed/skipped stages and closed tasks retain their history.

update_task accepts stage with ownerAgentId for a future pending stage. It keeps the current assignee, route phase and candidate, and refuses the producer, a weaker checker, unavailable/ineligible owners, missing owner and stages that are not future pending work. Pure future assignment creates no wake. Existing handoff revalidates the actual candidate and checker.

Changed implementation: echelons-assign.ts, echelons-future.ts, echelons-update.ts, engine.ts and tasks/tools.ts. Tests: development-echelons-future-owners.test.ts and development-echelons-tools.test.ts. Documents: task-1190-plan.md and this report. The head confirmed these within 12 approved exact paths. Both fire_employee registrations call the same DELETE /api/agents/:id path used by the department screen; that shared server path was exercised. No database migration, protocol shape, web source or dependency changed.

## Requirement evidence

| Requirement | Executed evidence |
| --- | --- |
| Removed future Review owner gets an eligible replacement | future-owners: replaces a removed future reviewer; role/scope/model/provider selection |
| No eligible replacement produces one letter | future-owners: two tasks in one head inbox letter, pending owners remain null, repeated handling produces no extra letter |
| Planned future Development stays coherent | future-owners: replacement updates executor and Architecture hands forward to it |
| Head can preassign future work | future-owners: current author/status unchanged and no wakes; tools: real SDK MCP update_task with stage preserves current owner |
| Refuse an ineligible checker | future-owners: producer, weaker and switched-off checker; tools: MCP refuses producer with an explicit reason |
| Preserve current work and history | future-owners: completed/closed/candidate preservation; agents: both sub-unit cases, staff/switch/handoff/control/wake callers |

## Passing checks

The named run completed 11 files, 189 tests, zero failures, exit 0. Own acceptance files contributed 7 and 6 cases. All four records below have clean source snapshots at start and finish and sourceUnchangedDuringRun true. Full raw outputs and machine-readable command/source/exit records are attached in the evidence archive.

| Check record | Checked commit | Exit | Full output |
| --- | --- | --- | --- |
| candidate-named | `47d80c905b5d671f8825c77a5eb7dd0252cfd73b` | 0 | `candidate-named.log` |
| candidate-types | `47d80c905b5d671f8825c77a5eb7dd0252cfd73b` | 0 | `candidate-types.log` |
| candidate-lint | `47d80c905b5d671f8825c77a5eb7dd0252cfd73b` | 0 | `candidate-lint.log` |
| candidate-build | `47d80c905b5d671f8825c77a5eb7dd0252cfd73b` | 0 | `candidate-build.log` |

candidate-named, cwd `/data/work/agents/8a3de50f-4897-4e27-ab3f-3c95af082d16/hornhoof-task-1190/apps/server`:

```sh
npx --no-install vitest run test/development-echelons-future-owners.test.ts test/development-echelons-tools.test.ts test/development-echelons-staff.test.ts test/development-echelons-controls.test.ts test/development-echelons-handoff.test.ts test/development-echelons-wake.test.ts test/agent-switch.test.ts test/agents.test.ts test/tasks-engine.test.ts test/map-state.test.ts test/wait-producers.test.ts --maxWorkers=1
```

candidate-types, cwd `/data/work/agents/8a3de50f-4897-4e27-ab3f-3c95af082d16/hornhoof-task-1190`:

```sh
npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit
```

candidate-lint, cwd `/data/work/agents/8a3de50f-4897-4e27-ab3f-3c95af082d16/hornhoof-task-1190`:

```sh
npx --no-install eslint apps/server/src/modules/tasks/echelons-assign.ts apps/server/src/modules/tasks/echelons-future.ts apps/server/src/modules/tasks/echelons-update.ts apps/server/src/modules/tasks/engine.ts apps/server/src/modules/tasks/tools.ts apps/server/test/development-echelons-future-owners.test.ts apps/server/test/development-echelons-tools.test.ts
```

candidate-build, cwd `/data/work/agents/8a3de50f-4897-4e27-ab3f-3c95af082d16/hornhoof-task-1190`:

```sh
npm run -s build -w @hornhoof/server
```

## RED and superseded runs

- red-future-review: real DELETE reproduction failed because Review stayed ownerless despite an eligible replacement; exit 1.
- red-future-acceptance: 6 failed and 1 passed before implementation, exit 1, at architecture commit 57a210a49454a6e003f2ec198b21b0255da64473 with the new test hashed in its record.
- green-future-acceptance: 7 passed, exit 0, on the recorded working tree before MCP schema work.
- red-future-tool: one selected MCP test failed because the tool schema dropped stage and changed the current assignee; exit 1, with 5 filtered cases.
- green-future-tools: both files, 13 passed, exit 0, on the recorded working tree before the final commit refactoring.
- final-named on f8027aa43aeb4aa2a1b92854a063cd49280d63e3: 187 passed, 2 failed, exit 1. The caller failures found replacement being applied during team moves as well as removal. Commit 47d80c905b5d671f8825c77a5eb7dd0252cfd73b limits the new selection to removed employees. candidate-named repeats all 11 files after that repair and passes all 189.
- runner-argument-error and author-wrapper: command launch/usage errors, not test execution or PASS.
- author-wrapper-exact on superseded f8027aa43aeb4aa2a1b92854a063cd49280d63e3: deliberately terminated during selection after the caller defect was known. The recorder observed child exit -15 (SIGTERM), outer recorder shell status 241. It selected/executed no recorded test suite and has no PASS. It was not rerun on the final executable commit; the head's named local gate list is the completed evidence above.

## Concerns and next owner

No whole suite or run_tests was called. The full release proof belongs to its release owner. No completed check:author, coverage-backed CRAP, Dryer, mutation, browser or release result is claimed. The change has no web source; the running-product checks were the real HTTP removal route and real MCP SDK calls against the built application fixture.

Timing is retained without claiming T5: the new seven-case integration file took 12.877 s and the MCP caller file 9.719 s; several cases exceeded 1 s. Unchanged callers also exceeded the budget, including map-state.test.ts at 121.010 s. No timeout or test threshold was raised. New acceptance tests control Date and contain no real sleeps or polling waits.

Independent Review owns its repairs on task-1190, followed by mandatory independent Security for access risk and Tests on the resulting exact candidate. Integration remains with the head after the release boundary.
