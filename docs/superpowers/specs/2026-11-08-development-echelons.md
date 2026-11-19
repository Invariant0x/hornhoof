# Development echelons

Status: approved by the Head of Development for task #718, implementing #717.
Decision: the head's recorded answer on #718, 2026-11-08 10:48:14 UTC.
Base: `e0d362be11294e0df9a7ef5036389283bffa030b`.
This note changes no running department, task, employee, model or subscription.

## Intent and compatibility boundary

New Development departments use Architecture, Development, Review, optional
Security, then Tests. Review is mandatory. Review and Security own their fixes;
ordinary findings never return work to Development. A small task skips
Architecture. Only the head decides a mismatch with the requested goal.

Add a nullable `tasks.echelons` route pointer and a persisted
`departments.echelonsEnabled` flag, default false. Existing rows keep false and
null. Never infer activation from `templateKey` when reading an existing row.
Only insertion of a new Development department sets the flag true. Snapshot
the selected route on task creation; changing a department default does not
reinterpret open tasks. The current department, #717 and its subtasks stay legacy.
Other departments, Matrix and Performance are outside this route.

Apply the code route to executor-bearing repository implementation tasks.
Head coordination tasks and architecture-only
or other non-code deliverables keep their existing completion rules. They must
not need a fictional code SHA to finish. A route's Architecture stage still
records the plan for its implementation task.

Dispatch on `task.echelons` before legacy submit/verdict/ownership logic. With
null, preserve `stage`, `gates`, `panel`, `executorAgentId`, bounce, merge,
review-confirmation and permission behavior. With a route, do not call legacy
`panelFor`, `closeGate` or `passedGates`: these select panels, return failures
to the executor or reset stage to zero. Retain the original executor as history;
the route's current owner authorizes work. A role does not confer access to
another task, repository, company or path.

## Facts checked on the base

| Existing boundary | Source and consequence |
| --- | --- |
| Task lifecycle and CAS | `apps/server/src/db/schema.ts`, `modules/tasks/engine.ts::move`: task version, assignment epoch, events and pending wakes already exist. Use one transaction for pointer, event and handoff. |
| Existing gate semantics | `engine.ts::panelFor`, `closeGate`, `passedGates`: vendor panels and author returns cannot implement the new route by relabeling gates. |
| Immutable review input | `modules/tasks/review-context.ts`: submitted events pin revision, SHA, branch and source range, but capture currently assumes the original executor. Add route-specific candidate capture. |
| Finding provenance | `modules/tasks/review-findings.ts`: server-issued finding IDs, pinned SHA, confirmation events and deduplication exist. Extend them additively. |
| Map and task reads | `modules/org/routes.ts`, `modules/org/map-state.ts`, `modules/tasks/views.ts`: owner activity currently depends on numeric stage and panel. Add a route-aware branch. |
| Creation paths | `modules/setup/routes.ts`, `modules/departments/routes.ts`: both insert template departments. Use one default helper in both. |
| Template model | `modules/templates/load.ts`, `templates/roles/development/`: roles and standalone skills exist; there is no department YAML file. |
| Test selection and reuse | `scripts/author-check/select.mjs`, `apps/node/src/test-fingerprint.ts`, `scripts/mutation/run.mjs`: retain existing selection, fingerprints and verified receipts. Mutation currently selects files, so changed-function bounds need an explicit additional contract. |
| Model identities | `packages/protocol/src/index.ts`: model IDs, aliases and effort exist; no authoritative cross-provider strength order exists. Effort and role tier do not prove strength. |

Root AGENTS.md, CONTRIBUTING.md and README.md were read at the pinned base.
CLAUDE.md is absent. The task's explicit no-trailers and remote-check rules take
precedence over CONTRIBUTING's sign-off and local-check instructions.

## Shared route contract

The server owner (#719) owns the protocol schema, validation, persistence,
transport and errors. The head approved this contract and its ownership split.
The agreed shared module is `@hornhoof/protocol/echelons`, exporting
`EchelonsSnapshot` and `EchelonFindingsView` for server and web consumers.

`echelons` is null or the following versioned pointer:

| Field | Meaning |
| --- | --- |
| `version: 1`, `revision` | Schema version and monotonic route revision; independent of `tasks.version`. |
| `stage` | `architecture`, `development`, `review`, `security` or `tests`. |
| `phase` | `active`, `waiting`, `escalated`, `ready`, `done` or `cancelled`. |
| `ownerAgentId` | Sole current owner, or null while no eligible agent exists. |
| `stages` | Ordered entries `{stage, roleKey, ownerAgentId, inputCandidateId, status, reason}`; status is `pending`, `active`, `complete` or `skipped`. Include explicit Architecture/Security skips and their reasons. |
| `candidateId` | Immutable current candidate identity, null before Development first submits. |
| `security` | `{included, reason, addedByAgentId}` with a source event for the head's selection or Review's discovered risk. |
| `modelPolicy` | Immutable policy identity and revision used to validate this route. |

Candidate events contain `{id, parentId, baseCommit, commit, branch, paths,
producedBy:{stage, agentId, vendor, model}}`. All SHAs are full 40-character
values, paths use the existing validated repository path type. The first
candidate has null parentId. A Review or Security fix appends a new candidate
with the previous candidate as parent; its producer is the actual fixer. The
base remains the task's agreed base, so final selection includes all fixes.
Verify branch head, ancestry and allowed source range through repository ports;
a caller-supplied SHA is a claim until those checks succeed. No force push.

Candidates and findings live in immutable task events, not growing JSON
histories or task counters. Extend the finding source with `stage`, `candidateId`
and immutable actor/model provenance. Preserve existing finding identity,
revision, reviewedCommit, authorId and reviewerId semantics. A finding's input
candidate and its fix candidate are different references; fixing does not erase
the finding or mean it was independently confirmed.

All route mutations take `{expectedVersion, expectedRouteRevision,
expectedCandidateId, idempotencyKey}` plus operation-specific input. Scope the
key to company, task, actor and operation; identical retries return the stored
result, a reused key with different input conflicts. In the same transaction,
check current ownership/CAS, append the event/candidate, replace the pointer,
advance assignment epoch when ownership changes and persist the wake. Duplicate or stale completion
cannot grant two owners or add a second finding. Resumption after restart reads
events and pointer, never reconstructs an assignment from role names.

## Commands and forward transitions

Keep existing tool names where their meanings still fit. The server owner
provides one route-aware command path shared by agent tools and HTTP handlers,
with strict schemas; do not create a second permissive HTTP transition path.
Route submit hands the current owner's verified output forward. Route verdict
records a finding or completion, never invokes the legacy author-return path.
An explicit goal-mismatch disposition distinguishes it from an ordinary finding.
Completion must have a single shared handler; submit and verdict adapters cannot
advance the same candidate independently.

| Input at current stage | Result |
| --- | --- |
| Create small task | Architecture skipped; Development active after dependency checks. |
| Complete Architecture | Store plan reference; transfer sole ownership to Development. |
| Complete Development | Pin candidate; transfer to eligible Review. Review cannot be omitted. |
| Review/Security finds ordinary defect | Record source finding, keep stage and owner active. The owner fixes only assigned paths, appends candidate and checks its exact SHA. |
| Review discovers risk | Insert Security before Tests with reason/source event. Review still completes its own work first. |
| Complete Review | Transfer candidate to Security if included, otherwise Tests. |
| Complete Security | Transfer actual fixed candidate to Tests. |
| Wrong goal at any stage | Phase escalated, owner is department head, preserve stage/candidate and evidence; no Development wake. |
| Infrastructure failure in Tests | Stay in Tests, retry the same candidate or wait for the external run. |
| Content failure in Tests | Escalate to head with exact failing run evidence. Tests does not silently edit candidate or send it to the author. |
| Candidate's own change passed, only the main line is missing | Stay in Tests. Its owner merges the main line into the candidate branch and submits the merge with the main commit as its new base; the server takes it only when the base moved along the main line and the merge changes nothing that line did not bring. Tests checks the new candidate. |
| Tests passes | Phase ready; atomically assign the department head, or its explicitly designated integration owner, and notify it under existing rights. No author merge return. |
| Authorized integration completes | Phase done only after exact-candidate inclusion evidence; merge/release approvals retain their existing meaning. |

The stage cursor never decreases. Head resolution of a goal mismatch either
continues the same stage with an explicit decision, cancels it, or creates a
new task for a revised goal linked to the prior task. It cannot erase a completed
stage, claim a new SHA was already tested, or silently route work back to its
original author. A late changed security risk is escalated for an explicit safe
route decision, never cleared automatically.

Project route state onto the existing lifecycle: active Architecture/Development
uses `working`; active Review/Security/Tests uses `review`; waiting uses
`waiting`; escalated uses `blocked` with the head as assignee; ready uses `open`
with the integration owner as assignee; done uses `done` with `closedAt`;
cancellation uses `cancelled` with `closedAt` and a cancelled route phase. Keep
`assigneeAgentId` equal to the route owner and legacy panel empty for route tasks.
An unmet dependency leaves the route waiting without an execution wake. Existing
dependency release continues to use task `done`, never just Tests complete or
route ready. The ready owner's submit uses the existing verified staging
inclusion receipt for the exact task branch/head; it cannot close the task by
asserting that a merge happened.

`after`, independent parts and path ownership remain task-scoped. A at Review
does not prevent B at Development if B is independent and owns different files.
The current owner's branch lease changes with the handoff; a stale owner may
neither submit nor replace the candidate. Existing repository credentials are
not widened by route ownership. Git alone cannot prevent an old credential
holder pushing; every consumer must reject an unpinned or unexpected branch head.

## Approved model policy

Normalize API/CLI vendors with the existing `reviewVendor` mapping. Pin actual
canonical model identity and policy revision at assignment and candidate
production; null/default/unresolved aliases are unknown, not a proof. Revalidate
when assigning, replacing an owner, adding Security, recording a verdict or
accepting a completion. Runtime fallback may not silently change the model.

Ship a builtin versioned policy; a department may store an authorized override
alongside its route default. The policy shape is
`{id, revision, edges:[{from:{vendor,model},to:{vendor,model}}],
source, setByAgentId}`. The generic shipped source is `{kind:'builtin',version:1}`
with no company, employee or task IDs and no setting actor. A runtime override
uses `{kind:'department',taskId,eventId}` and the authorized actor of that
department's own event. Only the department head or a person
already authorized to change that department's rules can change it; use existing
company/access checks. Each explicit edge means an approved stronger reviewer
for that producing model, not a benchmark claim or an inferred numeric rank.
Source model IDs from the repository catalogue/reported subscription models;
the builtin edges below implement the head's product decision. Runtime changes
use the authorized department event as their source. No client or node
report may grant itself stronger status. A policy change affects future route
snapshots; changing an active one needs a recorded head decision and revalidation.

Require different canonical models and an explicit stronger edge, without a
universal requirement for different vendors. Claude-to-Claude is allowed only
by a listed stronger edge. Effort, tier and role names do not establish strength.
The following vendor constraints override every policy edge: Codex-produced
code requires a Claude reviewer; Claude-produced code cannot receive a Codex
reviewer. Compare a stage's assignment with its immutable input candidate's
actual producer and the previous checking stage, not only the original executor.
A stage may fix its own input: completion revalidates against that pinned input,
not against its own resulting output as if that were an independent review.
The next stage checks the actual fix producer. Preserve the whole parent chain
and completed-stage attestations; an unchanged contribution already reviewed
does not invent a new producer, and a Claude contribution can never be hidden
to permit a later Codex reviewer. Unknown/unsupported pairs, unavailable
subscriptions and insufficient eligible agents stop that task with a stable
reason and a head notification. They do not stop independent department work.
An alias is accepted only after confirmed canonical resolution and pinning;
never infer the current version of `sonnet`, `opus` or a default model.

The initial supported builtin policy v1 contains exactly these directed edges,
with vendors normalized through `reviewVendor`:

| Producing vendor/model | Stronger checking vendor/model |
| --- | --- |
| `codex/gpt-6-luna` | `claude/claude-sonnet-5-5` |
| `codex/gpt-6-luna` | `claude/claude-opus-5-5` |
| `codex/gpt-6.1-sol` | `claude/claude-opus-5-5` |
| `claude/claude-sonnet-5-5` | `claude/claude-opus-5-5` |

These exact model IDs were checked in `packages/protocol/src/index.ts` at the
pinned base. The edges are an explicit product authorization, not a universal
ranking. Other pairs are unsupported; never infer transitive edges. No ordering
for Kimi, GLM, Gemini or unknown models is implied.

The supported risky path is Luna Development -> Sonnet Review -> Opus Security,
including Sonnet fixes and an unchanged Review input. The ordinary Sol -> Opus
path is supported. After an Opus Review fix, or whenever no next allowed edge
exists, required Security waits for the head; never remove it to make progress.
A new department ships the policy and route; missing eligible subscriptions or
canonical identities produce a visible task-local configuration blocker.

The independent proposals and the head's resolution remain recorded:

* Codex originally proposed a nullable workflow snapshot with embedded candidate
  and counts. It accepts Kimi's event-backed candidate pointer and derived counts
  to avoid divergent provenance. Codex proposed different models, permitting
  Claude-to-Claude only for an explicitly approved stronger edge. The order asks
  for different models, not universally different vendors.
* Kimi independently proposed the pointer/event split, fail-closed assignments,
  an explicit creation default and Tests-failure escalation. Kimi additionally
  proposed different vendors between producing/checking stages. After a Claude
  Review fix this may leave Security without an eligible third vendor; waiting
  was preferable to weakening that rule under Kimi's proposal.

The head selected the Codex model rule, the four explicit builtin edges and the
shared pointer/event design. Kimi's universal different-vendor restriction was
not selected. No further model or scope decision is pending. Tests exercise the
explicit edges and prohibited directions, not inferred model strength claims.

## Read models, metrics and templates

`TaskLine`/task detail and the visible `/api/org` task carry `echelons: null |
{version,revision,stage,phase,ownerAgentId,candidateId,stages,security}`. Preserve
legacy numeric stage/gateCount fields. The department view exposes
`echelonsEnabled`; detailed task reads provide candidate/event evidence. List
and org reads project the same persisted pointer under existing visibility
filters. Hidden tasks must not disclose owners, candidate IDs, findings or paths.
An additive `echelonFindings` read projection may carry per-stage reported and
confirmed counts plus source finding/event IDs; compute it from events rather
than persisting counters in `tasks.echelons`.

The web names stage keys in the language of the screen, from each locale's own
stage names (in English Architecture, Development, Review, Cleanup, Security
and Tests); the stages of a document read Plan, Work, Check and Risk check in
English and their own words in other locales. It shows actual skipped/added
entries and current owner from the route; it does not derive them from role
gate numbers. With no active task it shows no invented owner. Preserve legacy
rendering for null. Ordinary status/reason/help text remains localized.

Derive reported counts from unique server-bound finding IDs grouped by task and
Review/Security source stage. Derive confirmed counts from independent valid
confirmation events, not a fixer's self-confirmation or a verdict's legacy
integer. The same finding carried across candidates keeps one identity; retries
and repeated reads do not increase counts. Expose source event IDs, actor, stage,
model, input SHA and fix SHA for audit. Legacy unavailable data remains unknown.
There is no automatic Security disable threshold; the head uses the evidence and
must retain Security for risky work.

New template departments receive the route through both setup and later
department creation. Review and Security retain short existing roles with
standalone check and fix skills; no new special echelon role or references
between skill documents. Templates describe behavior generically, not this
company or live employees. A template refresh must not mutate existing staffing,
model assignments, permissions or active route snapshots.

The single creation-default helper is
`defaultDepartmentEchelonsEnabled(templateKey): boolean` in the shared protocol
module, owned by #719. It returns true only for Development and is called only
by the two department INSERT paths owned by #719, never when reading existing
departments. The database default remains false. #722 owns template text,
loading and tests, and imports this contract without editing those creation
paths or the schema. No file is co-owned.

## Tests contract

Tests consumes the exact final `{candidateId,revision,baseCommit,commit,branch}`.
Compare base to final head, including Review/Security fixes and changed tests.
Selection and execution are separate evidence: a selected command is not PASS.
Reuse existing repository/suite/file/fingerprint results with verified run parts;
do not add a cache keyed only by commit. A reused result needs the same code,
tests, transitive dependency closure, configuration, lockfile, runtime and
environment inputs. A new SHA requires an exact-candidate receipt proving reuse;
an old author's run alone cannot advance it. Missing graph/evidence widens safely
within the task or reports unavailable, never a zero-test PASS.

Mutation selection intersects changed function ranges, the manifest allowlist,
proven pure closures and nonempty fast tests. Exclude database, process, network,
filesystem effects and unknown purity, including transitive imports. Feed only
eligible ranges to a mutator that supports them; do not mutate a whole mixed
file to approximate function scope. Fingerprints include function/range selector,
fast tests, tool/configuration and their dependencies. Unsupported range support,
no fast test or unknown purity has an explicit NOT_RUN reason, never fabricated
PASS. Keep existing thresholds and survivor reporting semantics.

Distinguish an evidenced scope exclusion from missing execution. A proved
DB/process/effectful function is outside mutation scope and its NOT_RUN exclusion
does not block applicable checks. Unknown purity, an unavailable selector, an
eligible function without fast tests, unsupported range execution, absent
required receipts or a failed applicable check keeps Tests incomplete and goes
to the head. A docs-only change may have no applicable runtime tests if selection
proves that scope; that outcome is recorded as such, never as tests having run.

## Ownership and acceptance checks

| Owner | Exclusive boundary |
| --- | --- |
| #718 Architect | This note only. No implementation code. |
| #719/#720 server owner | DB migration/schema, task engine/tool authorization, candidate/finding events, model policy, shared protocol schemas, server map/task projections and server creation plumbing. |
| #721 web owner | Web map/task consumers, English stage labels, localization and visual/behavior checks. Requests server DTO changes through #719. |
| #722 template owner | `templates/**`, template loading/text and template tests; agrees the single creation-default helper with #719, never edits server owner's creation paths concurrently. |
| #723 selection owner | Impact/fingerprint/mutation logic and affected tests; consumes final candidate contract, does not own workflow schema. |
| #724 test owner | Test environment/manifest and shared final checks on the integrated exact candidate. |

Each implementation owner supplies RED/GREEN and affected checks run in their
own workspace, naming test files; only whole suites and declared profiles go
through `run_tests`. This note's checks are source/contract inspection and documentation
selection. Planned acceptance is not evidence of implemented behavior.

| Requirement from #717 | Required implementation evidence |
| --- | --- |
| Ordinary two-echelon path and small-task skip | Engine route tests: Development -> Review -> Tests; Architecture skipped; missing Review rejected. |
| Security chosen by head or added by Review | Engine/tool authorization tests, risk reason/source preserved; removing mandatory Security rejected. |
| Checkers fix and hand forward | Engine/candidate tests: fix changes final SHA, parentId/producer recorded, same owner until handoff, no author wake. |
| Wrong goal and failed Tests | Head escalation tests; no stage decrease, author return or candidate edit by Tests. |
| No duplicate work or foreign access | Concurrent/retried move, stale owner/wake, cross-company/path and idempotency conflict tests. |
| Stronger/different models | Policy tests: all four builtin edges accepted, same/unknown/default models and unlisted/transitive edges rejected, confirmed canonical alias required, Codex -> Claude required, Claude -> Codex rejected, actual fix producer and subscription changes revalidated; Luna -> Sonnet -> Opus with fixes/unchanged input, Sol -> Opus and required Security after Opus waiting for the head. |
| Compatibility | Existing gate/merge/turn tests; null route and existing department remain unchanged, #717 never auto-opted-in. |
| Concurrent A/B | Integration test with A at Review and independent B at Development; shared-file/dependency conflicts still wait. |
| Exact final candidate and reuse | Selector/receipt tests invalidate changed source, tests, imported input and environment; selection alone and stale author receipts rejected. |
| Pure changed-function mutations | Range/closure tests exclude DB/process/network/unknown effects and unchanged functions; nonempty fast tests required. |
| Auditable per-echelon counts | Event reducer tests distinguish Review/Security and reported/confirmed; duplicate ingestion/read does not double count. |
| Real map state and new-department defaults | Server projection/web tests for skips/additions/owners and both languages; setup/later creation tests plus standalone skills/short roles and no live migration. |

Integration of permission/access changes waits for the independent DEV-SEC result
on the exact SHA arranged by the head. The current turn's review/test route and
The release owner's eventual release rights are unchanged. This task does not run live,
publish, deploy, change main or create an implementation-plan task.
