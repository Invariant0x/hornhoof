# Task 1077: candidate and evidence

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/tasks/1077-secret-redaction-evidence.md). These are historical results, not checks of the current release.

The checks below are the author's, on the first design. Review replaced the trigger design afterwards; see the Review redesign section of [the task document](1077-secret-redaction.md) and the Review submission for the checks of the current candidate.

Base: `73d4a6e9521059384503aa8f2d9a4942635d1568` (`turn-31`). Branch: `task-1077`.
Executable sources checked: `e7121dd648e366376b47b5cb9457c92f3a832bde`. A later report-only commit is named in the submission. No integration or deployment has occurred.

## Result and requirement checks

- Shared credential detection masks task fields, comments, nested conversation data, letters and queued prompts before storing prose or its archive. Rules and `[hidden]` live in protocol; node imports them. [Protocol tests](../../packages/protocol/test/redaction.test.ts) passed 5 false-positive and credential checks; node `redact.test.ts`, `program-state-redaction.test.ts`, `exit-redaction.test.ts` passed 9. Relevant source/test bytes are unchanged by the later migration and browser-only commits.
- [Stored prose](../../apps/server/test/stored-secrets.test.ts) passed 8 tests: every ingress, complete unique-marker scans of public/net and API responses, archived UTF-8 text, current person rights, stable masks, preserved service state and two-company isolation. The same marker remains in the other company's task, brief, history and cached tool answer.
- [Merging copies](../../apps/server/test/secret-redaction-merge.test.ts) passed all 4 tests: both directions suppress stale prose and both directions keep the other company unchanged. Full table scans remain in the tests.
- [Migration upgrade](../../apps/server/test/secret-redaction-migration.test.ts) passed 1 test: populated pre-0137 database, repeated migration, preserved prose and working suppression. It starts after 0136_outbound_contact_log.
- [SQL rights](../../apps/server/test/secret-redaction-rights.test.ts) passed 1 test: agents cannot read/delete suppression records or call privileged helpers. [Outbound grants](../../apps/server/test/outbound-grants.test.ts) passed all 60 checks, including no privileged functions in public.
- [Task panel](../../apps/web/test/TaskPanel.test.tsx) passed 45 checks after the final bidi markup edit, including success, empty/failure clearing, cancellation, permission and English/Russian vault links.
- [Browser interaction](../../apps/web/e2e/hide-secret.spec.ts) passed 48 cases: Chromium 8 + 8, Firefox 8 + 8, WebKit 16, each command exit 0. Four shipped skins, English/Russian, 375/1440 px; each form is checked in LTR and RTL. Controls stay at least 44 px, text does not overflow, selection is sent exactly, marker/input disappear, mask and vault link appear, page errors stay absent. Narrow English and Russian RTL screenshots were inspected. Hint punctuation is isolated as a whole.

The initial two-company API and merge tests reproduced cross-company scrubbing. The head confirmed company-only scope. Fingerprints now filter by company, with ownership resolved for copied/partial rows, deleted-row history and job-owned cached messages. Unknown ownership never falls back to another company's fingerprints. Tests first failed on the vault offer, then passed with the link.

Complete commands, failed attempts, timings, asset hashes and original output are in the archived full report. Earlier author results above describe the first design and do not establish a pass on the later repair.

## Security repair, 17 November 2026

Input candidate: `be983c08bfe10d5f4885f7c703ee4afe1a364520`; task base: `73d4a6e9521059384503aa8f2d9a4942635d1568`. Repair: `8beef61d08464df2ebbee0be4e2aac0ed807a9a2`.

Confirmed regression: replacing the conversation join-code guard with the narrow prose mask restored machine join codes in stored and returned events. The existing `events.test.ts` regression failed on the input candidate. The repair restores this guard for incoming events, job events and outgoing conversation copies. Its pattern lives in protocol; ordinary stored prose still keeps command examples as before.

A new stored-secrets case records both outer and transaction SQL calls, requires that the actual row-replacement query was captured, and asserts that neither SQL text/parameters nor the API response contains the synthetic selected value. This is not a measurement of a live PostgreSQL logging configuration.

Changed files: `packages/protocol/src/redaction.ts`, `apps/server/src/modules/events/store.ts`, `apps/server/test/stored-secrets.test.ts`. The change is authored by Security; it is not an independent Security PASS on this repair. Tests must verify the submitted final candidate before any authorized integration. No live data, shared branch or deployment was touched.

Final affected evidence: 46 distinct tests (events 10, left-input 18, stored-secrets 10, protocol redaction 8), exit 0. The earlier 37-test receipt includes the nine existing stored-secrets cases; the final ten-case receipt supersedes that file. No whole suite or run_tests was used. Builds/types/lint below also exited 0, with no diagnostics.

Reused evidence: the Review archive `t1077-redesign-checks.tar.gz` has SHA-256 `54de6ec91ca7d9d5ed0e9e672e3354ba2ad98326e656ebadd799cafffd1815f8`. Its e7be0034 executable inputs match be983c08 (the latter changes only this task documentation); secret-redaction scan 13, merge 4, migration 2 and rights 1 passed. Their code is unchanged by this repair. Repeated author checks were not run for appearances. Historical author/browser evidence and its limits remain above.

Limits: native `codex review --base review-1077-base` failed before reading code because bwrap could not create a namespace; shell exit 0 is not a native review PASS. Manual Security inspection was performed. The historical merge checks exceeded the file budget and one initial merge-task attempt timed out; its later successful run does not erase that failure. The 100000-row benchmark produced measurements but failed its cleanup hook, so it is not a passing test. The probe for deleted attachment bytes did not reproduce a leak: the journal keeps content hashes rather than those old bytes. It is not a reported finding. Real PostgreSQL, live replication and ArSpatially were not accessed.

Current full logs for the Review claim of TaskPanel 45 and node redaction 9 on 82b84774 were requested from the reviewer; old author receipts are not relabelled as a current UI run. Resource measurements remain PGlite observations, not release guarantees.
