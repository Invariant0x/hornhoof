# Development route release data preparation

This is a release handoff, not a data conversion program. Before 1.0, an authorized releaser prepares existing records manually. The author does not read or modify the live database. The final submission must pin the schema commit and revise this checklist against its final columns before release.

## Order

1. Stop issuing new work through the old server using the authorized release procedure. Wait for or explicitly settle running assignments. Record the exact old and candidate server commits and keep a recoverable database backup using the releaser's normal procedure.
2. Inventory all existing `tasks` rows, including closed rows that task lists and history can display. Preserve their original `assignee_agent_id`, `executor_agent_id`, `status`, `version`, `assignment_epoch`, old gate/panel/stage/bounce/merge values, department/product/turn identifiers and the relevant `task_events`. Capture replaced fields before applying schema that drops them. Do not infer a completed check from a numeric gate index or a green run on another candidate.
3. Apply the normally generated schema DDL on the release copy first. `0087_required_task_routes.sql` creates an empty `task_routes` table and its constraints; it does not populate or translate tasks. `0088_remove_task_gates.sql` drops `tasks.gates`, `panel`, `stage`, `merging`, `bounces` and their obsolete constraints, retaining the nonnegative silent counter. Capture the removed fields in step 2 before this DDL. Neither file converts existing task data.
4. For each existing task, have its responsible head decide its actual state and current owner under the new route. Set one `task_routes` row as described below. An undecided open task stays held for that decision. Do not let a missing route execute an older implementation.
5. Check assignment, scope, candidate and evidence consistency before permitting new work. Verify the actual task/list/detail/map output for the prepared records on the release copy. Never manufacture successful check events or candidate receipts to make a record fit.
6. Only the authorized releaser may apply the accepted manual changes and release the candidate to the live installation. Release and main approval remain separate from author checks.

## Existing records and required outcomes

| Records selected | Fields to prepare | Expected outcome |
| --- | --- | --- |
| Every existing `tasks` row without a matching route | `task_routes.task_id`, `company_id`, `revision`, `state`, `paths` | Exactly one route, matching the task's company; revision is positive. The state uses the final protocol version and real ordered stages. Paths are the head-approved repository scope. |
| Open tasks (`status` outside `done`, `cancelled`, `planned`) | `tasks.assignee_agent_id`, `status`, `version`, `assignment_epoch`; route stage, phase and stage owner | At most one current owner. The head chooses the actual next stage from the work and evidence, not the old gate number. A missing eligible checker is shown as waiting, with no author-return shortcut. Any changed assignment invalidates outstanding old assignment authority. |
| Planned tasks | Route phase/stages/paths and planned owner metadata | Prepared but not dispatched until the turn and dependencies allow it. No code candidate or passed check is fabricated. |
| Closed tasks displayed in history | Required route with truthful terminal phase and available provenance | The task remains closed and has no current owner. Historical checks with no corresponding evidence remain unknown; a route record must not invent completed Review, Security or Tests. Preserve original events. |
| A task with an existing branch or completed code | Route candidate pointer and candidate-producing event in the final event schema | Pin only a real full commit, base and branch verified by the authorized head. If historical producer/model/fix provenance is unavailable, do not invent it. Keep the work held for a current, attributable handoff. |
| A task already being checked or fixed | Current stage/owner, input candidate, path scope and assignment identity | The active checker owns the same task branch and its own fixes. Reconcile outstanding old jobs explicitly before dispatching a new assignment. Do not wake the original author merely because a checker found a defect. |
| Open `task_waits` with an old numeric review source | End/rebind the obsolete review source under the responsible head's actual plan | New review keys name task, stage, candidate and owner: `review:<task UUID>:<review\|security\|cleanup>:<candidate UUID>:<owner UUID>`. Preserve genuine dates and history; never invent dates or a completed verdict. |
| Queued or interrupted task jobs with numeric gate/merge wake snapshots | Settle obsolete `jobs` and `pending_wakes`; issue a fresh wake only for the actual assignment | New task wakes retain the real route stage, candidate ID and task version. A former author or checker must not regain authority from an old turn. Preserve human messages and unrelated jobs. |
| Pending author-check submissions and `tasks.external_wait` pointing at their runs | Settle old check jobs and waits before allowing a fresh submission | The automatic submit check adapter is removed. Settle its outstanding jobs and external waits through authorized task controls. Preserve old events as history; do not manufacture an outcome or transfer a receipt to a different producer. The current producer checks explicitly and submits through the normal API with its real evidence. |
| Existing `test_file_results` and completed product-run caches | `test_runs.file_cache.verifiedFingerprints`, `reusedUnits`, original source run/commit and `test_parts.environment_receipt` | Only actual stored node evidence can back a reused unit. If original verified fingerprints or receipts are missing, invalidate the affected cache entries and run current checks. Do not reconstruct successful fingerprints or receipts from a status label. Preserve authentic completed run/history records. |
| Sensitive work | Route security requirement, reason and authority | The head records why Security is required. Existing unchecked sensitive work cannot be marked as having passed Security. |
| Review findings and confirmations | Existing `task_events` and final finding/candidate identities | Keep immutable original facts. Count only attributable finding and confirmation records; do not turn old numeric counters into measured findings. |
| Existing agents that should check/fix | `agents.skills`, `model`, `subscription_id`, relevant overrides; referenced `subscriptions` | Authorized staff configuration supplies the required independent check/fix ability and a model not weaker than the producer. Prefer an eligible different provider; one provider/subscription/tariff is allowed. Unknown capability remains an explicit assignment problem. No automatic employee/model/subscription rewrite is part of the schema. |
| Existing departments, including Development | No enable/disable flag | The new implementation is the sole route. Do not add or populate `echelonsEnabled`. |

## Integrity checks for the releaser

- Every visible task has one same-company route. Required state and repository paths satisfy the final protocol and database constraints.
- The task's assignee is the sole current stage owner. The stage history, route revision and candidate pointer agree with its immutable events and actual branch.
- All candidate bases/heads are full SHAs. Tests and any verified reuse refer to the final candidate after checker fixes, with the task/branch/revision and influencing fingerprint checked. An old author result does not certify a new fix.
- No old pending notification or job can commit using stale ownership. Do not clear or change unrelated jobs, requests, permissions or people to bypass this check.
- Missing Review, Security, Tests, quality or browser evidence stays missing. Manual preparation is not a successful verdict.
- Inspect the generated DDL for accidental data updates. There is no bulk converter, route backfill or live-data command in this change.

## Rollback limit

Once replaced schema fields are dropped and work has moved through the new engine, the old server is not a supported reader/writer of that schema. The releaser must use the backed-up database with its matching old server, or a separately reviewed recovery procedure. Do not run the old workflow against newly prepared route records.
