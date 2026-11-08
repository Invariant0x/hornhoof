# Development workflow preparation for turn 17

Base: `e0d362be11294e0df9a7ef5036389283bffa030b`.
Shared branch: `task-717`, initially pinned to this base.
Preparation branch: `task-720`. Continuing implementation owner: task #719.
Approved design: `docs/superpowers/specs/2026-11-08-development-echelons.md`,
task #718 source `f28e32b2c4104ab617ce130040b30a1baf24eed6`.
This document records preparation and test inventory; the design note is authoritative.

## Existing seams and ownership

The current task engine uses numeric `stage`, ordered `gates`, `executorAgentId`,
`assigneeAgentId` and optimistic task versions. A rejected verdict returns work to
the executor. These semantics must remain available for legacy tasks.

| Owner | Paths and contracts |
| --- | --- |
| #719, including preparation #720 | `apps/server/src/modules/tasks/**`, task schema and new migrations, server organization task projection, shared protocol types and creation helper, both server department INSERT paths, corresponding server tests |
| #721 | `apps/web/**`, including map and task presentation |
| #722 | `templates/**`, `apps/server/src/modules/templates/**`, department template text and tests; consumes the shared creation helper without editing INSERT paths |
| #723 | Impact, fingerprint and reuse selection; author check and pure mutation selection; agreed test run reuse paths |
| #724 | Test environment and manifest |

The organization map currently exposes a task inside each agent card at
`departments[].agents[].task` in `GET /api/org`. Task list and detail transport use
`TaskLine` and `TaskDetail` in `modules/tasks/views.ts`, read by HTTP and MCP.
The protocol has no existing `StateTask` or `StateBundle` type on this base.
Shared echelon types belong to #719; web-local types belong to #721.

## Agreed additive transport

Use the same `echelons` value on task list, task detail and organization task
projection. A legacy task explicitly reports `echelons: null`; numeric stage,
gates, owner, history and access retain their meaning. Do not derive new workflow
stages from a legacy gate index or rewrite existing departments on upgrade.

The future `@hornhoof/protocol/echelons` export `EchelonsSnapshot` contains
`version: 1`, `revision`, `stage`, `phase`, `ownerAgentId`, `candidateId`,
`stages` and `security`. Stage keys are `architecture`, `development`, `review`,
`security`, `tests`; their labels are Architecture, Development, Review,
Security, Tests in every locale. Phase is `active`, `waiting`, `escalated`,
`ready`, `done` or `cancelled`. Each ordered stage contains `stage`, `roleKey`,
`ownerAgentId`, `inputCandidateId`, `status` and nullable `reason`; status is
`pending`, `active`, `complete` or `skipped`. Security contains `included`,
`reason`, `addedByAgentId`. The persisted pointer additionally pins `modelPolicy`.
Canvas owners come from visible agent task snapshots and actual owner IDs,
not role gate numbers. An idle card has no invented current owner.

Immutable candidate events identify `id`, `parentId`, `baseCommit`, `commit`,
`branch`, `paths` and `producedBy: {stage, agentId, vendor, model}`. Tests consumes
the final candidate ID, revision, full SHAs and branch. A Review or Security fix
changes the candidate; an earlier author receipt cannot prove the new candidate.
#723 owns fingerprint and reuse policy, while #719 owns accepting that proof.

Findings distinguish Review from Security, with separate reported and confirmed
counts. Counts need persisted event/finding identifiers and reviewed commit
provenance, and reprocessing must not count a finding twice. Existing
`gateCounts` and unconfirmed legacy counts are not substitutes for this source.
No automatic threshold disables Security.

The shared `EchelonFindingsView` is either `{status: 'unavailable', reason}`
or `{status: 'available', counts, sources}`. Counts contain `review` and
`security`, each with `reported` and `confirmed`. Sources contain `findingId`,
`sourceEventId`, `stage`, input `candidateId`, `reviewedCommit`, `authorId`,
`reviewerId`, `reviewerVendor`, `reviewerModel`, nullable `fixCandidateId` and
`fixCommit`, and `confirmationEventIds`. Legacy data remains unavailable,
not a fabricated zero. Existing task visibility applies to all these fields.

The one creation helper is `defaultDepartmentEchelonsEnabled(templateKey):
boolean` in the shared protocol module, owned by #719. Only INSERT of a new
Development department gets true. Both setup and later department INSERT paths
are owned by #719. Database default and existing rows stay false. The department
view exposes persisted `echelonsEnabled`; template reading never activates it.
#722 owns template loading, skills, short roles and its tests. The earlier
proposed `newDepartmentDefaults` helper was not implemented and is superseded.

The head selected different canonical models without a universal vendor barrier.
The builtin stronger edges are exactly Luna -> Sonnet, Luna -> Opus,
Sol -> Opus, Sonnet -> Opus, using the full catalogue IDs in the approved note.
There are no inferred or transitive edges. Required Security after an unsupported
producer waits for the head. No live model or subscription is changed.

## Requirement to test inventory

Only the first two cases below are executable RED tests in this preparation.
The remaining cases specify the approved behavior for #719. They are not test
execution evidence. Core implementation begins after #718 closes.

| Requirement | Case and observation |
| --- | --- |
| Legacy compatibility in detail transport | `development-workflow-transport.test.ts`: legacy task detail returns `echelons: null`, preserving owner, executor and gates |
| Legacy compatibility in list transport | `development-workflow-transport.test.ts`: legacy task list returns `echelons: null`, preserving numeric stage and gate count |
| Ordinary two-echelon route | New workflow moves Development -> Review -> Tests; Review is mandatory; Security is skipped with a reason |
| Small task | Architecture is skipped, while Review remains mandatory |
| Planned security | Head selects Security by risk at assignment; applicable Security cannot be removed by an executor |
| Newly discovered risk | Review adds Security with a reason and provenance, ahead of Tests |
| Reviewer fixes | Review and Security retain their own task/branch ownership for a normal finding; fix candidate moves forward and is checked again |
| Wrong objective | Work goes to the head for a decision, without an author return |
| Model constraints | All four explicit edges accepted; same, default, unknown and unlisted models rejected; Codex requires Claude review; Claude rejects Codex review; required Security after Opus waits |
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
preparation commit. The original RED dispatch returned no ID during the node
outage. David explicitly authorized repeating such requests after recovery.
Engine GREEN belongs to #719, not to this RED-only preparation.

`CLAUDE.md` is absent on the base. CONTRIBUTING's sign-off, local check and Docker
instructions conflict with this task: the task requires no trailers, remote
checks only and no Docker. No engine code, live structure, main, release,
publication, node update, Matrix or Performance changes belong to preparation.
Independent Security review on the exact candidate is required before sensitive
implementation reaches the shared branch. This preparation contains no engine
implementation. Stewardship integrated the verified #723 source
`60f60d43dae4891c99bfd954b2580b27dc239db3` and the approved #718 source into
`task-717` at `0b2c7f972e391643513450ebe5a6bce971c93cd5`, preserving both in
ancestry. Source checks were read, not repeated: #723 runs 1457/1458 and
docs-only #718 run 1466. Producer quality and the full-suite comparator remain
unavailable; docs-only selection is not a product-test PASS.
