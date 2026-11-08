# Development workflow preparation for turn 17

Base: `e0d362be11294e0df9a7ef5036389283bffa030b`.
Shared branch: `task-717`, pinned to the base during preparation.
Preparation branch: `task-720`. Continuing implementation owner: task #719.
Task #718 owns the approved design. This document records preparation, not an approved engine design.

## Existing seams and ownership

The current task engine uses numeric `stage`, ordered `gates`, `executorAgentId`,
`assigneeAgentId` and optimistic task versions. A rejected verdict returns work to
the executor. These semantics must remain available for legacy tasks.

| Owner | Paths and contracts |
| --- | --- |
| #719, including preparation #720 | `apps/server/src/modules/tasks/**`, task schema and new migrations, server organization task projection, shared workflow protocol types, corresponding server tests |
| #721 | `apps/web/**`, including map and task presentation |
| #722 | `templates/**`, `apps/server/src/modules/templates/**`, `apps/server/src/modules/departments/templates.ts`, template and new department default tests |
| #723 | Impact, fingerprint and reuse selection; author check and pure mutation selection; agreed test run reuse paths |
| #724 | Test environment and manifest |

The organization map currently exposes a task inside each agent card at
`departments[].agents[].task` in `GET /api/org`. Task list and detail transport use
`TaskLine` and `TaskDetail` in `modules/tasks/views.ts`, read by HTTP and MCP.
The protocol has no existing `StateTask` or `StateBundle` type on this base.
Any new shared workflow type belongs to #719; web-local types belong to #721.

## Proposed additive transport, subject to #718

Use the same `workflow` value on task list, task detail and organization task
projection. A legacy task explicitly reports `workflow: null`; numeric stage,
gates, owner, history and access retain their meaning. Do not derive new workflow
stages from a legacy gate index or rewrite existing departments on upgrade.

The architect's preliminary value is versioned with
`kind: 'development_echelons'`, `version: 1`, `revision`, `stage`, `state`,
`ownerId`, `stages`, `candidate`, `security` and `findings`.
Stage names are `Architecture`, `Development`, `Review`, `Security`, `Tests` in
every locale. Skipped stages carry a reason. The server supplies current stage,
owner and state; the browser displays them without inferring transitions.

The candidate identifies `baseCommit`, `commit`, `branch`, `revision` and
`contributorModels`. Tests must bind to the final candidate and applicable
fingerprint. A Review or Security fix changes the candidate; an earlier author
receipt cannot prove the new candidate. #723 owns fingerprint and reuse policy,
while #719 owns accepting that proof at the workflow transition.

Findings distinguish Review from Security, with separate reported and confirmed
counts. Counts need persisted event/finding identifiers and reviewed commit
provenance, and reprocessing must not count a finding twice. Existing
`gateCounts` and unconfirmed legacy counts are not substitutes for this source.
No automatic threshold disables Security.

For new department defaults, the proposed marker is
`{ kind: 'development_echelons', version: 1 }` in template metadata. The precise
field, creation input and migration remain pending #718. #722 owns template
loading and new department adaptation; #719 owns the persisted schema and engine
interpretation. Existing departments and running assignments are not opted in.

## Requirement to test inventory

Only the first two cases below are executable RED tests in this preparation.
The remaining cases specify required behavior for #719 after #718 settles the
creation and transition inputs. They are not test execution evidence.

| Requirement | Case and observation |
| --- | --- |
| Legacy compatibility in detail transport | `development-workflow-transport.test.ts`: legacy task detail returns `workflow: null`, preserving owner, executor and gates |
| Legacy compatibility in list transport | `development-workflow-transport.test.ts`: legacy task list returns `workflow: null`, preserving numeric stage and gate count |
| Ordinary two-echelon route | New workflow moves Development -> Review -> Tests; Review is mandatory; Security is skipped with a reason |
| Small task | Architecture is skipped, while Review remains mandatory |
| Planned security | Head selects Security by risk at assignment; applicable Security cannot be removed by an executor |
| Newly discovered risk | Review adds Security with a reason and provenance, ahead of Tests |
| Reviewer fixes | Review and Security retain their own task/branch ownership for a normal finding; fix candidate moves forward and is checked again |
| Wrong objective | Work goes to the head for a decision, without an author return |
| Model constraints | Codex author requires Claude review; Claude author rejects Codex review; same model, weaker or unknown ranking waits with an explicit reason |
| Authority and concurrency | Wrong company, department, owner, path scope or stale revision cannot mutate the workflow; duplicate transitions cannot execute twice |
| Pipeline overlap | A on Review and independent B on Development proceed concurrently, while shared paths have one owner |
| Final candidate evidence | A receipt for an earlier commit, different branch, revision or influencing fingerprint cannot complete Tests |
| Findings | Review/Security metrics identify source events and reviewed commits; replay preserves counts; confirmations remain separate |
| Projection | HTTP task list/detail, MCP task/tasks and organization cards expose identical stage and current owner; hidden tasks remain hidden |
| New department defaults | A newly created Development department opts in; existing data, assignments, history and permissions remain unchanged |

The executable RED tests call the real MCP task tools and reuse the existing
review fixture. They must fail because the additive field is absent, not because
an unimplemented module is imported or the test environment is unavailable.
There are no skipped tests or placeholder production implementations.

## Baseline and constraints

Baseline run `1416`, on the exact base above, executed:

```sh
node -e "if(process.platform!=='linux')process.exit(1)" && npm exec -w apps/server -- vitest run test/tasks-engine.test.ts test/tasks-routes.test.ts test/tasks-tools.test.ts test/map-state.test.ts --testTimeout=60000
```

Full log: task #720 attachment `tests-1416-1.log`. Result: 4 files and 107 tests
passed. Linux runtime was checked by the command even though the host is named
`0xs-MacBook-Pro.local`. The harness matched the base with no reported problem.

The author selector on SHA equal to base printed an empty change plan and
explicitly said nothing was checked. This is selection evidence only; baseline
execution is run 1416. RED selection and execution must be recorded on the
preparation commit. Engine GREEN belongs to #719 after approval of #718.

`CLAUDE.md` is absent on the base. CONTRIBUTING's sign-off, local check and Docker
instructions conflict with this task: the task requires no trailers, remote
checks only and no Docker. No engine code, live structure, main, release,
publication, node update, Matrix or Performance changes belong to preparation.
Independent Security review on the exact candidate is required before sensitive
implementation reaches the shared branch. RED-only preparation stays on its own
branch; `task-717` remains at the base.
