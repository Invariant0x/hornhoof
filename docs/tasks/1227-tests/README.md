# Tests for task 1227

Status: DONE_WITH_CONCERNS. PASS for the assigned merge and secret protection checks on `ee4a49d54a882b1c8e9070689fd6ace447e9ab2a`, base `150c19a62d2ab39ad2b0a451ff6cbae43ffe91d3`. Review and Security already passed this exact candidate. No product code changed at Tests.

Read the complete output of all ten author receipts in `review-1227-evidence.tar.gz`. Each names the candidate, clean working tree, command, working directory, start/end and actual exit code. All eight named test files passed, with no skipped tests in GREEN, 51 tests total:

- `apps/server/test/events.test.ts`: 11, including the English and Russian password-label regression, returned event and stored rows.
- `apps/server/test/stored-secrets.test.ts`: 10, including permissions, company isolation, SQL boundaries and stored copies.
- `apps/server/test/orchestrator-sql-secrets.test.ts`: 2. Direct fingerprint/characters/window_hash reads, whole-row and JSON reads, and predicates using the protected columns are refused. The readable-column inventory contains only company_id, created_at, id and person_id.
- `apps/server/test/secret-redaction-scan.test.ts`: 13.
- `apps/server/test/secret-redaction-merge.test.ts`: 4, both merge directions and company boundaries.
- `apps/server/test/secret-redaction-migration.test.ts`: 2, upgrade from 0136, repeat migration and frozen-evidence guards. Fresh databases are also prepared by the test fixtures. No down migration is supplied.
- `apps/server/test/secret-redaction-rights.test.ts`: 1.
- `packages/protocol/test/redaction.test.ts`: 8.

The commands are `npx vitest run test/<named-file>.test.ts --maxWorkers=1`, one file per invocation, with NODE_OPTIONS set to `--max-old-space-size=4096`. The archived commands also include an outer timeout. `npx tsc -p apps/server/tsconfig.eslint.json --noEmit` and `npx eslint` on the two changed source files and two changed test files exited 0. The exact commands and SHA256 hashes are in `review-audit.json`. `deps.log` records lockfile preparation and workspace builds before the checks. These are reused local author executions, not new Tests executions and not registered run_tests receipts. The Head explicitly accepted this reuse in `head-scope.json`.

Read both final RED logs on plain merge `226fb7272566965115e443277f00af4623ca9450` with the final tests added. SQL resolves a forbidden fingerprint read instead of rejecting it; the event retains the test join code after masking its password label. Both exit 1 with the intended assertion failure. GREEN covers the entire two files. Earlier draft RED files are preserved in the archive but are not the accepted final evidence.

Inspected the four-file fix and merge resolution. Only `apps/server/src/db/agent-sql.ts` and `apps/server/src/modules/events/store.ts` conflicted. Both parents are retained: privateToolEvent, privateTurn and state.values.hide precede hideEventSecrets; all three event writes use hideEventSecrets; join-code masking precedes prose masking. Migration 0137 is unchanged from the previously accepted feature and free after turn-31's 0136. The two commits use the required author and sign-off and have no Co-Authored-By trailer.

Executed `python3 docs/tasks/1227-tests/verify.py` after saving these evidence files. Output: `PASS: 20 archive hashes, 126 Git objects, 10 exact-version receipts, 51 passed tests, merge parents and conflicts, two behavioral REDs`. Exit 0. The verifier was inspected and reused from Security commit `626091d5356a7bb6f63fd36d84aed87ef972fb52`; it verifies records, not product behavior. The 42 paths are bound to Git objects at the prior feature, turn-31 and current candidate. Full raw logs remain in the archive. `timings.json` lists every reported test over 1 second and all file/runner times from those logs.

Concerns and limits:

- T5 is NOT_PASS. Accepted DB exception from the Head, recorded in `head-t5.json`: the new SQL case is 2718 ms; runner durations exceed 30 seconds for events (49.80 s), stored-secrets (38.23 s), orchestrator-sql-secrets (37.89 s), migration (30.43 s) and rights (36.35 s). Other reported test overruns are retained by name in `timings.json`. No assertion or threshold was weakened.
- The existing events case at line 101 configures STREAM_PING_MS = 50 and the stream uses a real setInterval. There is no controlled clock for that case. This does not prove a deterministic next-ping path; immediate access-change notification can also end the stream. It is outside the new regression. The Head accepted it as an existing limitation and owns the separate task, in `head-scope.json`.
- Current merged browser, web/node checks, real PostgreSQL, physical replication and the full release suite are not proved here. Older feature checks are historical only. Direct event inserts outside the common store remain the previously reported feature limitation; no new direct-insert path was introduced by this merge. The excluded join syntax variants remain turn-32 work.
- Native codex review in earlier stages could not read the diff because of bwrap; its outer exit 0 is not proof. The recorded independent manual Review and Security verdicts are PASS.

Next: the Head owns integration into 0.31.1 and release checks. No run_tests, shared-branch push, main integration or release was performed at Tests. Evidence is committed separately on task-1227-tests-logs; the reviewed task-1227 candidate stays unchanged.
