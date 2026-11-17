# Task 1077: development evidence

The sections below describe the original candidate. A continuation record is appended at the end for the current branch; earlier checks prove only their original source version.

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

These checks use isolated PGlite databases and browser API fixtures. They do not prove live physical replication or production latency. Historical encrypted backups, exported files and copies outside the live logical databases are not rewritten. The adjacent company password vault was absent from the original checked base. The continued candidate below offers its available Passwords page beside masked text.

## Steps after the authorized ArSpatially deployment

1. Sign in as the CEO, the CEO delegate, or a person running the task's department.
2. Open task 267 and select only the password in its details or log.
3. Choose **Hide secret**, verify the selected value in the private field, then choose **Hide everywhere**.
4. Check that the task now shows `[hidden]` and its log records who hid the secret and when.

The person performs these steps. This task accesses no live ArSpatially server and changes no production record.

## Check limits observed during authoring

An earlier expanded caller run passed 263 tests and failed two: the public-schema definer invariant and a 20 s runner timeout in the first long-comment test. The schema invariant was fixed by moving the privileged helpers into `net`, preserving the original protection test. The updated outbound-grants file subsequently passed all 60 tests.

Concurrent local checks also produced runner timeouts in first-time database setup. No application assertion or test timeout was relaxed. The broad server test-type project did not produce a passed receipt (one attempt exited 134 and a later memory-heavy attempt was stopped); application source types passed. These incomplete checks are not reported as passes. Final local receipts are attached to the task and identify the checked candidate.


## Continued candidate, 17 November

The branch now takes turn-31 at 73d4a6e9521059384503aa8f2d9a4942635d1568. The unpublished table migration was generated again as 0137_secret_redactions, after 0136_outbound_contact_log. The incoming queue changes are preserved; this task adds only credential scrub calls there.

The API and merge isolation tests first reproduced that the old suppression functions replaced the same marker in another company's text. The head confirmed the boundary: suppression and the sweep belong only to the company in the suppression row. The new functions filter fingerprints by that company, resolve company ownership for partial journal rows, cached tool answers and parked job messages, and never apply another company's fingerprints where ownership is unknown. The migration keeps these helpers private in net. Security must review this boundary and its lookup of deleted-row history.

The merge checks now cover each direction independently, preserving the complete table scans. The added two-company cases keep a matching marker in the other company's task while the receiving company's text is masked.

The current web offers the company vault beside masked task text or history. New English and Russian tests first failed because the link was absent, then all 45 tests of TaskPanel.test.tsx passed. The browser file passed all 48 cases across Chromium, Firefox and WebKit, four shipped skins, English and Russian, phone and desktop widths, and LTR/RTL form geometry. No page errors or proxy failures were printed in that run. Those receipts precede the final RTL punctuation repair. A later screenshot showed the final period displaced at the start of the hint in RTL; the hint now has one bidi isolate, and the browser scenario measures the final punctuation order. Final browser evidence is recorded below.

Local logs are kept with the task hand-in. The first ten-file server run passed 136 checks and failed two: the base's missing declaration on POST /api/attachments (Ghost's task 1196; 1173 was cancelled as a duplicate) and the previous combined two-direction merge test's 20 s runner limit. No timeout or assertion was weakened. The split merge checks then passed. A later five-file run printed passes for stored-secrets, the four merge checks and outbound-grants, but ended with code 143 before its final summary; the incomplete run is not a passed receipt. The current exact candidate is checked again after renumbering.

Protocol redaction.test.ts passed 5 checks; node redact.test.ts, program-state-redaction.test.ts and exit-redaction.test.ts passed 9. Their relevant source files are unchanged by the later merge. Source and test types, lint and builds are recorded separately on the final candidate. The automatic author wrapper would select the whole shared-package suite, so it does not override this task's ban on a whole run; only explicitly named local files are run. No run_tests, shared-branch integration or live ArSpatially access is part of this work.

## Final local checks

The five database test files are run separately with the verbose reporter, as requested by the head after the interrupted combined run. Codes 143 and stopped or uncollected runs do not count as PASS. The base route-access failure on POST /api/attachments is assigned to Ghost in task 1196; task 1173 is cancelled.

Migration 0137 has a `when` greater than the preceding 0136 and its snapshot points to the 0136 snapshot. The integrator must set `when` at integration time, strictly after the last applied journal entry, and keep the snapshot chain and migration numbering in the same order. If tracker 0139 integrates first, the head must renumber before integration. This branch is not integrated by this author.

Completed static checks on the final executable sources:

- `npx --no-install tsc -p apps/node/tsconfig.json --noEmit`: exit 0 (empty output).
- `npx --no-install tsc -p packages/protocol/tsconfig.json --noEmit`: exit 0, 02:07:53 UTC.
- `npx --no-install tsc -p apps/web/tsconfig.json --noEmit`: exit 0, 02:08:51 UTC.
- `npm run build -w @hornhoof/node`: exit 0, 02:07:53 UTC.
- `npm run build -w @hornhoof/protocol`: exit 0, 02:08:33 UTC.
- `npm run build -w @hornhoof/web`: exit 0, 02:09:09 UTC; Vite reports 399 transformed modules and warns about chunks larger than 500 kB. No threshold changed.
- `npm run build -w @hornhoof/server`: exit 0, 02:11:00 UTC.
- ESLint on the 13 changed server TypeScript files, eight changed web files, node redaction file and protocol redaction source/test: exit 0. After the final hint and geometry assertion edits, web ESLint was repeated on `src/ui/HideSecret.tsx e2e/hide-secret.spec.ts`: exit 0, 02:09:00 UTC.

The final browser repeat started at 02:10:00 UTC. Four Chromium cases timed out before the panel or page finished opening; the author interrupted the two active cases at 02:14:00 UTC. Result: 6 failed (including two interrupted cases), 42 did not run, command exit 130. The run never reached the secret action or new punctuation assertion. The prior 48-case passed receipt does not prove the final bidi edit. The temporary preview-server and clock experiments were reverted; no timeout or selection assertion changed.

The earlier combined server test-type command started at 01:38:24 UTC and returned 143 without compiler output, observed around 01:40 UTC. That is not PASS. The head relayed the interruption to Operations. The separate package commands above preserve completed results; the server command is recorded separately below.
