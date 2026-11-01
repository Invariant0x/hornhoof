# Metadata API release and application

Status: DRAFT, NOT READY FOR APPROVAL, NOT READY TO APPLY. This branch contains the reviewed metadata API and version packaging. The pre-dispatch service operation below is proposed, not implemented or available to provider agents.

## Source and artifacts

| Role | Exact source or state |
| --- | --- |
| Current installation, last observed 2026-11-01 07:34:31 UTC | `bd696b0724385b6b11da53a24ada2f188b031217`, version 0.5.0, 21 migrations |
| Functional source F, task 44 | `67e31f5da9fb4c728d8aea9e7d6f578b92fc83fe`; both review, test and security gates passed |
| Independent API QA, task 50 | F passed 36 cells and 305 API steps using isolated PostgreSQL; no production application |
| Version source P | `e7609f8031625ecbf356115d11e226ba36d4bc21`, parent current installation; product and node version 0.5.1, lock metadata only |
| Ordinary draft integration I | `c252d188f33c1876aa19b3ae9d21a359fae460a7`, parents P and F, no conflicts |
| Final candidate M | Descendant of I containing this contract and runbook. After committing, record `git rev-parse t29-export-release`, parents, tree, diff and file hashes in the submission receipt. No image SHA is assigned in advance. |
| Application artifacts | Not built. Require app, node and updater manifests, architecture digests and labels from exact approved M. |
| Recovery R | No source, semver or artifact selected or built. Previous initially means bd696b0, without the metadata API. |

All eight functional files from F must remain byte-identical in M. Server source tree is `82d6b14aa23e37beb77eab6dd861a5ebd4631e36`, node source tree `c803f28e1b653292d7abeb9c789add43bbe37bfc`, protocol tree `ef2e30df26a7c3f5a7c7c7921d83828044733a8b`. Release lock SHA-256 is `7bedd476c4bc2397da88b1948c688d9a4d8e94f07cb5fb01e24fd76c342585e7`. QA of F and equality of these sources do not replace qualification of M.

Version 0.5.1 is a draft. Anonymous registry checks at 07:45:12-07:45:15 UTC found no 0.5.1 or 0.5.2 tag for the three images. This historical observation reserves nothing. Immediately before publication, verify the chosen semver is unused everywhere. If occupied, change version metadata, requalify and obtain approval for the new exact commit. Never reuse mutable 0.5.0.

## One missing service operation

The minimal runtime blocker is an unavailable bounded executor for `installation.metadata_release_preflight`, specified in [metadata-preflight-operation.json](metadata-preflight-operation.json). The department proposes one approved, hash-pinned reader bundle, executed by the current installation's trusted deployment maintainer in its existing updater service context. Compose defines Docker socket and server directory mounts there; provider agents receive neither. There is no named command entry in the current watcher, no corresponding authorized service tool, and no verified maintainer executor in the available access. This proposal does not grant one.

The operation resolves only this installation's current app, Compose db and control volume from trusted service configuration. Before dispatch, it compares a privately derived anchor of the running app's effective settings with a diagnostic reader using deployed `loadConfig` and `openPool`. A separate diagnostic Pool is allowed. Merely running `loadConfig` again proves nothing about the running app.

The proposed anchor binds the current app container/image/process identity, its actual startup environment kept inside that container, and verified deployed startup/config/client modules. Require the standard direct Node entry, no alternative startup or injected preload, unchanged process identity before/after the reads, and proof from exact deployed source that startup configuration supplies the Pool without subsequent rebinding. Compare effective settings privately, then fixed read-only DB identity and incident-window metadata fingerprints with the actual Compose db used by old `pg_dump`. Unknown identity, unavailable startup evidence, custom/external routing, denied reads or drift must refuse. This anchor method needs fixtures, independent review and an actual deployment receipt; none has been executed here.

Preserve Compose/env privately in the service context, plus safe update/job evidence and opaque configuration/data fingerprints. Private material must not enter task logs or agent folders. A private receipt records observations; it does not authorize dispatch. The controlled workflow must enforce refusal before calling the existing update tool. No pending request may exist or be created on refusal. Current `/api/updates` has no receipt requirement, so another caller can bypass this proposal. Head must exclude concurrent configuration changes and update dispatches through the entire quiet window. This is not a global or atomic fence.

Current source proof: `main.ts` constructs config and DB once; health/version expose build fields; updates view exposes registry/status; `UpdaterControl.request()` writes `request.json`; CLI `owner-link` calls `createDb`, which migrates. None supplies this anchor or executes the operation. Adding a helper only to M, its installer or its new updater cannot provide it before the first update. Do not use owner-link, migration startup, generic shell/SQL access or a fabricated receipt as a substitute.

## Old updater and recovery boundary

The existing isolated fixture used the exact bd696b0 updater and rollback installer. Target installer refused before changing state, yet old parent ran previous installer, replaced fixture Compose/env and changed selected fixture DB. It ended `rolled_back`. Docker and PG effects were mocked; this does not describe production data. That negative proof is retained, not rerun unchanged.

Another existing fixture refused before invoking old parent: zero Docker calls and unchanged Compose/env/selected DB. It proves required placement, not an installed guard. With no request delivered, old watcher has no new update or rollback to execute. After allowed dispatch, old rollback remains unchanged and may overwrite configuration. Successful preflight therefore also requires verified compatibility of target and previous installers with preserved configuration and backup target. If incompatible or unknown, refuse before dispatch.

The old backup protects Compose db only after identity equality is established. Automatic rollback selects current app revision or env version, not an independent recovery image, and restores no saved Compose/env archive or DB dump. Health or `rolled_back` is not configuration/data recovery.

Before application, head must name separately qualified recovery R, immutable semver, artifacts and tested operation retaining F or an accepted replacement. A metadata-only child of M may qualify as a reproducible fallback artifact; it cannot repair an unchanged functional or installer defect. Test the actual selected failure scenario and schema compatibility. If fallback bd696b0 and its update route are healthy, orchestrator can perform a second controlled update to approved R. If that route is unavailable, a separately approved bounded maintainer restore operation must restore private configuration, protect volumes/data, select exact approved artifacts and verify health, DB fingerprints and permanent metadata capability. No such recovery executor/test is attested here. CEO approves the prepared choice, not a request to find the server or execute technical commands.

## Controlled application after qualification and approval

1. Finish M qualification: dependency/install preflight, root suite in a head-assigned window, affected types/builds, script checks and applicable scoped quality/mutation checks. Then independent review, test and both security cross-checks. Record executed checks separately from required ones. Obtain CEO approval for exact M and the concrete preflight/recovery operation. Approval readiness and application readiness are separate decisions.
2. Advance main to exact approved commit without creating an unapproved merge. Normal Images CI tests first, then publishes app/node/updater for both architectures under package semver, full SHA and latest. Do not dispatch Images on this branch. Verify revision/version/migration labels and index/platform digests for application/recovery artifacts; smoke-test built artifacts. Nothing has been built or published here.
3. Head schedules a quiet window, stops new assignments and competing updates/config changes, lets existing jobs finish, and preserves job/event evidence, volumes, worktrees and private recovery configuration. Revalidate the installation; 07:34 snapshot is not current proof.
4. Authorized orchestrator calls `check_updates`, then `view /api/updates`. Require updater present, no running/waiting update, immutable semver 0.5.1 resolving to M and matching verified labels. Confirm current/previous and approved R roles. There is no caller expected-SHA guard between observation and selection. Recheck if selected build changes.
5. Execute approved fixed preflight before any update request. Require every comparison and tested recovery prerequisites; save safe receipt. Any refusal/missing evidence stops without `update_hornhoof`. Only the caller's control job may still be running; no other working job is allowed. Revalidate process/config/build immediately before the update call in the quiet window. This proposal patches neither old route nor watcher.
6. Only now call `update_hornhoof({version:"0.5.1",whenIdle:true})`. Server resolves selected Build.commit into a full-SHA tag before writing request. The running orchestrator control job counts toward `workingCount`; finish that turn naturally after the accepted call so `whenIdle` can reach zero. Keep the quiet window until acceptance. Existing `sendWhenIdle` performs no later preflight/config revalidation, and does not prevent new assignments. This delayed-dispatch gap remains explicit. Old updater performs backup/install/rollback. Installation may restart app, built-in node, updater and personal nodes on that host; MCP/WS and provider processes may be interrupted.
7. Require finished update status and health/version reporting exact M, 0.5.1 and 21 migrations. Compare fixed post-read DB/config/data fingerprints, allowing only approved version changes and excluding new runtime activity in the agreed quiet window. Unexpected differences stop acceptance. Perform tested recovery if required; automatic previous alone does not restore the metadata channel.
8. Through authorized `view`, read `/api/agents/7f038470-9455-432f-a113-0d7f72bd87cd/job-metadata?from=2026-11-01T00:17:00Z&to=2026-11-01T00:30:03Z`. Require HTTP 200, `{jobs:[...],complete:true}`, the 17-key schema, independent timestamp selection and six-digit UTC fractions. Overflow 409 is not success; narrow window. Publish safe counts/schema/digest evidence, no raw prompt, result, tail, credentials or full production records.
9. Confirm node connectivity/queued work and obtain valid fresh current-job contexts for resumed MCP work. Reconnection or an ended job's token does not prove session continuity. Resume assignments after acceptance. Retain metadata endpoint as permanent diagnostic channel; removal requires an accepted replacement.

## Evidence and next action

Executed locally: ordinary merge/parents, exact functional/source/lock comparisons, version test 3/3 after integration; earlier version RED/restored GREEN, types/builds and isolated bootstrap probes. Task 44 root/gates and task 50 API QA qualify named F only. Task 69 receipts retain command, UTC, own PID, natural end, exit and complete check output.

Required, unperformed: new M root/independent gates, current immutable tags/artifacts and exact approvals; trusted current app anchor, actual DB/config/backup/fingerprint evidence; implemented pre-dispatch refusal and tested recovery; production application/post-checks. No production SQL, Docker build, update, restart or main change was performed.

Next bounded action: head reviews this service operation and names the trusted maintainer executor/capability for its implementation and qualification. No generic host access, new account, credential export or backup coordinator is requested. Separately, head must release one final check window before push/submission; root proof of F cannot stand in for M.
