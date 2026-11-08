# Author-check evidence port

Task 325 owns executing the author's checks. Task 460 supplies the server port and review consumer; neither parses numbers from prose or launches a check.

The executable contract is `AuthorCheckInput` in `apps/server/src/modules/tasks/review-quality.ts`, written through `recordAuthorCheck(db, taskId, input)`. There is no HTTP or MCP setter for this record. Since 0.8.3 nothing calls it: the author check runs in the author's own workspace, a submit starts no test run, and the server has no run of the check to read a record from.

The input carries:

- `version: 1`, an existing `runId`, and exact 40-character `submissionCommit` and `checkCommit`. Both must match the run's pinned commit.
- `scope: { kind: 'changed' | 'package', paths: string[] }`, with repository-relative paths.
- `stages`, one entry per stage actually observed: `name` is `format`, `lint`, `types`, `tests`, `crapper` or `dryer`; each entry has `status`, nullable `exitCode` and nullable `partId`. Duplicate stage names are rejected.
- `numbers`, with nullable `tests: { passed, failed, skipped, total }`, `changedLines: { covered, total }`, `worstCrap`, and `dryerFlags`. Null means unknown, never zero.

The port derives the company, task author and originating job from protected database records. It checks company/task/repository ownership, author authority and stage part references. It snapshots actual run/part receipts. The append-only system task event contains `authorCheck` and a content digest; retries with identical facts return the same event ID. It does not move the task or grant PASS.

`authorQuality(db, taskId, commit)` validates the saved record against the protected run, job, task and receipt snapshot. The task MCP response includes it as `review.quality`; source task assignments carry their own `quality`. The result has `status`, `reason`, `record` and `sourceEventId`.

Task reads and verdicts revalidate receipts and authority. They retain the immutable captured value separately as `review.qualityAtSubmission` (also on source task assignments); historical task events are never rewritten. `review.qualityTaskId` identifies the source task for a turn review's quality record. Changed receipts or ownership produce current `unavailable`, even when the submission snapshot recorded `passed`.

Only all six real passed stages, zero exit codes, complete matching receipts and present numbers can produce `passed`. A failed/stopped run, failed phase or CRAP at least 10 cannot pass. Dryer flags remain informational when its phase exited successfully. Missing stages, scope or numbers remain partial. Unknown coverage remains null. A record whose receipts or ownership changed is not accepted as current evidence.

Three families stay separate:

- `review.runs`: actual run IDs, commits, part counts and exit receipts.
- `review.quality`: structured author-check results from producer 325, or explicit `unavailable` with a reason.
- `review.gateCounts`, labeled `source: 'review-lifecycle'`: passed/returned review verdict counts, not quality-check numbers.

Without a record, `review.quality` is `unavailable`, which is what every submission gets now. This port does not certify the release's author-check stages.
