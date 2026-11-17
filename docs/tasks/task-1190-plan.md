# Future stage owners after an employee leaves, task 1190

Base: origin/turn-31 at 11aa5777c4a5f74a550c0e53570ec35ebae39f53. The head explicitly removed the release prerequisite. Work belongs to task-1190 only; the head integrates it after 0.31.0 for 0.31.1. Never push or merge it into turn-31.

## Cause and scope

leaveWork in tasks/engine.ts currently clears every unfinished assignment of the employee, including future pending stages, without choosing a replacement. prepareRouteChange in echelons-update.ts can change only the current stage. The two public removal paths already converge on removeAgent and leaveWork. Keep that shared path and preserve current-stage handoff, immutable candidates and closed/completed/skipped stages.

## Selection

Keep checkerFor in echelons-assign.ts as the common checking policy. Reuse its department, product, team, ability, active employee, subscription and model checks. Add a role filter for automatic replacements so the replacement has the leaving employee's role; explicit head choices continue through the same named checker validation. Prefer a different provider as the existing policy does. No subscription, model or skill is changed by selection.

A small future-stage helper resolves the relevant producer: the immutable current candidate when present, otherwise the assigned Development producer's known identity. For producer stages with no checking ability, use the same available staff pool and scope rules without inventing a model strength requirement for the producer. Future Development reassignment also updates the planned executor before a candidate exists; it must not rewrite a submitted producer identity. Unknown checking capability leaves the future check unassigned rather than assuming it is safe.

## Removal and notification

Only unfinished future stages owned by the leaving employee are replaced. Their status remains pending. Their replacement does not become the current assignee, receive a turn, or gain any right to approve a result. Handoff revalidates its owner and the actual producer as it already does.

Collect all stages for which no replacement exists and send one ordinary Hornhoof notification to the live department head for the employee's removal, naming task numbers and stage names. Use the existing conversation/inbox path so it is an actual letter, not only a task event. Keep the current owner and task status intact for future-only changes. Repeated handling of a route with no remaining assignment to the employee produces no extra letter. Existing current-stage wakes stay separate. A missing department head uses the existing internal fallback route to the orchestrator.

## Explicit future assignment

Add optional stage to update_task alongside ownerAgentId. A named pending stage strictly after the current stage changes only that step's owner. Reject a missing owner, completed/skipped/current/previous/absent stage, an incompatible executor edit, another department's actor, an unavailable/out-of-scope/team owner, a checker without the ability, the producer itself or a weaker model. Keep current-owner updates without stage as they are. Do not reopen a completed stage, restart the author, create a candidate or wake a future owner. Validate again at real handoff.

## Proof and delivery

First reproduce removal through the real employee DELETE route and observe the missing replacement. Then implement and run named files in this workspace on recorded source versions. Tests cover role and department/product/team scope, provider preference, self and weaker rejection, future Development, one head letter covering multiple tasks, closed and completed stages, idempotence, manual assignment and real MCP update_task parsing. Use controlled Date only, with no real-time waits.

Named acceptance files: development-echelons-future-owners.test.ts and development-echelons-tools.test.ts. Callers: development-echelons-staff.test.ts, development-echelons-controls.test.ts, development-echelons-handoff.test.ts, development-echelons-wake.test.ts, agent-switch.test.ts and agents.test.ts. Run server source/test types, changed-file ESLint and server build locally. The author selector must not turn into a whole-suite run; any unavailable/broader selection is reported, with the full release owned elsewhere. No run_tests on this branch.

Each check record will contain its command, cwd, start HEAD, tracked dirty-file hashes, return code and full output. Commit and push the actual candidate, then submit it with the exact base and evidence to Review, independent Security and Tests. Report incomplete checks honestly.

## Planned additional paths

- docs/tasks/task-1190-plan.md
- apps/server/src/modules/tasks/echelons-assign.ts
- apps/server/src/modules/tasks/echelons-future.ts
- apps/server/src/modules/tasks/echelons-update.ts
- apps/server/src/modules/tasks/tools.ts
- apps/server/test/development-echelons-future-owners.test.ts
- apps/server/test/development-echelons-tools.test.ts

The assignment already names tasks/engine.ts and identifies the other initial reading locations. Confirm the final actual paths with the head before submission. No database migration, protocol shape or web screen is planned.
