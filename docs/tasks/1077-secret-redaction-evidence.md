# Task 1077: development evidence

Base: `d44ecb8c7d3d0b6d7ce690e01c25046f0404b212` on `origin/turn-31`.
Branch: `task-1077`. No integration or deployment is part of this submission.

## Behavior and checks

- Task title, brief, body and comments are cleaned before storage or archival. `apps/server/test/stored-secrets.test.ts` checks task fields, comments and the replication journal.
- Conversation events, inbox letters and queued prompts use the same credential patterns. The stored-secrets test checks nested event data, letters and prompts. Existing `events.test.ts` and `inbox.test.ts` passed 44 tests together.
- The person-only endpoint validates the task selection, checks current authority again inside the transaction, records only a suppression fingerprint and length, scrubs prose and its copies, then records the actor and time without the selection. The stored-secrets test scans every table in `public` and `net` for a unique marker and checks the HTTP response, UTF-8 archives, short selections and stable masks.
- `secret-redaction-merge.test.ts` merges an old value and a new copy from a disconnected database into the leader, then merges the suppression back into that disconnected database. Both databases are scanned for the marker, including merge conflicts and history.
- `secret-redaction-migration.test.ts` upgrades a populated pre-change database, repeats the migration and checks suppression. Fresh database migration is also part of the test setup. Down migrations are not supported. The additive schema remains after an application rollback; an old application does not offer the new action.
- `secret-redaction-rights.test.ts` checks that agent SQL cannot read or delete suppression records or execute the privileged functions. The unchanged outbound-grants tests keep privileged functions out of `public`; internal suppression functions live in `net` and have no PUBLIC execute right.
- `packages/protocol/test/redaction.test.ts`: 5 passed, including ordinary prose, commit hashes, UUIDs and task numbers. Node `redact.test.ts`, `program-state-redaction.test.ts`, `exit-redaction.test.ts`: 9 passed.
- `apps/web/test/TaskPanel.test.tsx`: 43 passed, including success, empty input, failure clearing and cancellation, and absence of the action without server permission.
- Browser command: `PLAYWRIGHT_BROWSERS_PATH=/data/browsers npx --no-install playwright test --config e2e/hide-secret.config.ts --workers=2`, in `apps/web`. 48 passed. Chromium, Firefox and WebKit; all 4 shipped skins; dynamically shortest and longest registered locales, currently English and Russian; 375 and 1440 px. Each form is measured in both LTR and RTL, with controls at least 44 px and no horizontal overflow. RTL is a direction check, not a claim that another language is shipped. The eight screenshots beside this report show the narrow forms in RTL.

## Design decisions and review findings fixed by the author

Credential detection and the mask live in `packages/protocol/src/redaction.ts`; the node imports the mask. Diagnostic-only path hiding is not applied to stored prose.

A literal replacement over every string column was rejected after a regression demonstrated that selecting `active` could corrupt people's service status. Suppression operates on prose fields and their copied structures, preserving identities, statuses, keys and schema field names. Journal and merge records are cleaned according to their source table. The unchanged marker scan still verifies all stored prose copies in the fixture.

The fingerprint has no reversible selected value. Database triggers prevent a stale write or merge from restoring a suppressed selection. The existing write gate and database table locks serialize the sweep with writers. This rare administrative operation scans stored prose; its large-database latency is not measured by this task.

## Scope and limitations

No whole suite and no `run_tests` were run, as the assignment requires. Shared protocol, schema, route and translation changes have wider impact than the named local checks; the release owner retains the combined release checks. The automatic author wrapper is not used to start its broad shared-package selection. No coverage, CRAP, duplication or mutation score is claimed.

These checks use isolated PGlite databases and browser API fixtures. They do not prove live physical replication or production latency. Historical encrypted backups, exported files and copies outside the live logical databases are not rewritten. The adjacent company password vault is absent from the checked base, so no unavailable vault link is offered.

## Steps after the authorized ArSpatially deployment

1. Sign in as the CEO, the CEO delegate, or a person running the task's department.
2. Open task 267 and select only the password in its details or log.
3. Choose **Hide secret**, verify the selected value in the private field, then choose **Hide everywhere**.
4. Check that the task now shows `[hidden]` and its log records who hid the secret and when.

The person performs these steps. This task accesses no live ArSpatially server and changes no production record.

## Check limits observed during authoring

An earlier expanded caller run passed 263 tests and failed two: the public-schema definer invariant and a 20 s runner timeout in the first long-comment test. The schema invariant was fixed by moving the privileged helpers into `net`, preserving the original protection test. The updated outbound-grants file subsequently passed all 60 tests.

Concurrent local checks also produced runner timeouts in first-time database setup. No application assertion or test timeout was relaxed. The broad server test-type project did not produce a passed receipt (one attempt exited 134 and a later memory-heavy attempt was stopped); application source types passed. These incomplete checks are not reported as passes. Final local receipts are attached to the task and identify the checked candidate.
