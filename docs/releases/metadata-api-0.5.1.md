# Metadata API release preparation

This change prepares version metadata for 0.5.1. It does not contain the metadata API, an installed preflight helper, or approval to publish or apply a build.

## Source and artifact roles

- Accepted base: `bd696b0724385b6b11da53a24ada2f188b031217`.
- Last fetched functional candidate: `4123333b784a27ac998cc97df0e2e4670b790fdf`, task 44. Its test gate requested additional timestamp regressions. The reported replacement `9dc8d57d8d2fc4aaf4cd93b1d1d8ed306e1d9090` is still subject to its own root result, handoff and independent gates. Neither is an accepted release base here.
- Packaging commit P: this branch, with the product, node and corresponding lockfile versions set to 0.5.1. No dependency versions or functional task 44 files change.
- Final application source M: a future explicit merge of the accepted functional commit F into P. Record both parents and SHA-256 of all six task 44 files. M must pass its own required checks and exact CEO approval. The API candidate SHA F is not the packaged image SHA M.
- Recovery source R: not created. A metadata-only child of M for 0.5.2 is one possible separately reviewed build, provided its six functional hashes remain equal to F and its recovery operation is independently tested. Such a build cannot repair an unchanged functional or installer defect. A different recovery fix requires another exact source, checks and approval.

Anonymous GHCR reads on 2026-11-01 at 07:45:12-07:45:15 UTC found no 0.5.1 or 0.5.2 tag for app, node or updater; manifest HEAD returned 404 for all six checks. The three tag inventories completed in one page each. This observation does not reserve a tag. Recheck immediately before publication and never overwrite an existing release semver.

After approval, advance main to the exact approved source without creating an unapproved merge commit. Existing Images CI tests that source and builds app, node and updater for both supported architectures. It publishes the package semver, full source SHA and latest, with matching revision/version labels. Do not dispatch Images on this branch. Digest identifies the produced artifact; source SHA identifies its code. Record the index digest, architecture manifest digests and labels for all three images.

If R is selected, it requires separate exact approval and its own normal main CI run before the first application. A recovery image's existence does not select it for automatic rollback. No application or recovery artifact was built by this preparation.

## Bootstrap finding and missing operation

The isolated probe runs the exact bd696b0 updater and exact bd696b0 rollback installer. Its target installer rejects preflight before changing configuration. The old parent nevertheless extracts and runs the previous installer. That installer replaces fixture compose/env and starts Compose, changing the fixture's selected database. Status is `rolled_back`, not `done`. Docker and database behavior are synthetic; this is not evidence that production data changed.

A second fixture rejects before invoking the old parent: no Docker calls, no configuration or selected-database change and no done status. This proves the placement needed for a guard; it does not install such a guard or establish an available production executor. An existing watcher must not already have a waiting request, and the head must exclude other update dispatches during this controlled operation.

The missing operation is narrowly defined: in the existing trusted deployment service context, run an approved fixed read-only reader inside the current app using its actual configuration and pg.Pool, obtain identity/data fingerprints from the actual Compose db used by pg_dump, compare receipts, and refuse to write an update request on any failure or mismatch. Credentials stay inside those services. Unknown/external targets are a stop. Do not replace this with a successful pg_dump or health response.

Proposed reader files were reported to the head: `scripts/release-preflight.mjs`, standalone fixture tests and one Dockerfile COPY. They are not implemented by this commit. The reader would use fixed config/openPool imports, no migrations, a fixed READ ONLY query and only allowlisted opaque fingerprints/build fields. It would expose no HTTP endpoint, SQL input or new permissions. A new image containing a reader would not make that reader available in the old production app before bootstrap. The handoff of critical task 44 has priority over this implementation.

No existing provider tool executes this operation in the app/Compose-db context. An approved service administrator or existing trusted service operation is required; no Mac shell, Docker socket, SQL access or manual CEO command is assumed. Preserve all evidence and stop this scope until that capability is supplied. The production pre/post-install fingerprints and backup target comparison remain unperformed.

## Controlled application after all prerequisites

1. Obtain accepted F, checked M, verified application and recovery artifacts, a tested recovery operation, the read-only preflight receipts above, a backup protecting the actual app DB, and exact CEO approval. The head schedules a quiet window and stops new assignments/update dispatches without interrupting existing work. Preserve current update status, job/event evidence, volumes and worktrees.
2. Through the authorized orchestrator, call `check_updates`, then `view /api/updates`. Require updater present, no running/waiting update, and the chosen immutable semver resolving to M with matching labels/digests. The API has no atomic expected-SHA guard. Latest and a raw SHA in the version field are not substitutes for this discipline.
3. Only after preflight succeeds, call `update_hornhoof({version:"0.5.1",whenIdle:true})`. The server resolves the selected Build to a full-SHA tag before writing the updater request. `whenIdle` does not prevent new work after dispatch. Installation can restart app, built-in node, updater and personal nodes on the host; MCP/WS connections and provider process continuity can be interrupted.
4. Require completed update status and health/version with exact M, 0.5.1 and the expected migration count. Compare safe DB identity/data fingerprints before resuming work. On unexplained differences, stop acceptance. The old updater's automatic fallback selects previous, initially bd696b0 without the API. Only if that old app and update route are healthy can the separately approved recovery semver be selected by a second controlled update. Otherwise the existing service administrator recovery operation is required. No such operation or recovery build is attested here.
5. Use authorized `view` for `/api/agents/7f038470-9455-432f-a113-0d7f72bd87cd/job-metadata?from=2026-11-01T00:17:00Z&to=2026-11-01T00:30:03Z`. Require HTTP 200, `{jobs:[...],complete:true}`, the 17-key schema and six-digit UTC fractions. Overflow 409 is a stop: narrow the window. No raw prompt, result, tail, token, environment, reasoning or credentials belongs in evidence.
6. Check node connectivity and queued work, and obtain fresh valid current-job contexts for resumed MCP work. An ended job's token and browser reconnection prove no continuity. Retain only sanitized receipts with source/digests, UTC, counts and validation results. Keep the metadata endpoint as the permanent service capability. Apply independent final package QA; old QA of F does not approve M.

## Evidence boundary

Executed: source/canonical-runbook verification, anonymous registry inventory, the supplied orchestrator updates snapshot, unchanged baseline version tests, packaged version tests and isolated old-parent bootstrap probes. Exact commands, UTC/PIDs, outputs, hashes and missing capabilities are in the task 69 evidence package.

Not executed: production config/DB reads, backup/restore verification, pre/post-install fingerprints, Docker builds, publish/tag/Images, main changes, update/restart/application, full root checks or independent release gates. These are prerequisites, never completed-proof booleans. Application and recovery are not ready to apply.
