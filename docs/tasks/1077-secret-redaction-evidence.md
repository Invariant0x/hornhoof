# Task 1077: candidate and evidence

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

## Commands and complete receipts

All five server files ran separately, one worker, verbose reporter. Prefix: `npx --no-install vitest run test/FILE --maxWorkers=1 --reporter=verbose` in apps/server. Complete passing receipts:

- `stored-secrets.test.ts`: 8 passed, exit 0, 03:18:36–03:19:02 UTC; first case 5.263 s.
- `secret-redaction-merge.test.ts`: 4 passed, exit 0, 03:19:36–03:20:28 UTC; cases 11.204, 4.958, 5.549 and 3.588 s.
- `secret-redaction-migration.test.ts`: 1 passed, exit 0, 03:20:54–03:21:10 UTC; case 4.381 s.
- `secret-redaction-rights.test.ts`: 1 passed, exit 0, 02:31:38–02:34:33 UTC.
- `outbound-grants.test.ts`: 60 passed, exit 0, 02:34:48–02:37:06 UTC.

Browser command prefix in apps/web: `npx --no-install playwright test e2e/hide-secret.spec.ts --config e2e/hide-secret.config.ts --workers=1`. Complete final receipts add:

- `--project=firefox --shard=1/2`: 8 passed, 03:11:23–03:12:07 UTC, exit 0.
- `--project=firefox --shard=2/2`: 8 passed, 03:12:23–03:13:07 UTC, exit 0.
- `--project=webkit`: 16 passed, 03:13:15–03:14:07 UTC, exit 0.
- `--project=chromium --shard=1/2`: 8 passed, 03:16:23–03:17:16 UTC, exit 0.
- `--project=chromium --shard=2/2`: 8 passed, 03:17:32–03:17:49 UTC, exit 0.

The browser config serves a separately checked production build. Run `npm run build -w @hornhoof/web` before these commands, without editing web/protocol source between build and checks. The final build passed at 02:59:52 UTC. Browser geometry now reads both directions in one page evaluation; independent post-action expectations run together. Assertions, server ownership and runner limits are preserved. Browser timeouts remain 30 s, server startup 60 s, Vitest test/hook limits 20/10 s.

Web JS asset: `index-P9LtH8l8.js`, SHA-256 `752cc84e8a47d5f665d3a9dd52c2545f66683e1f20765300324d8131f2456a99`.
CSS asset: `index-DPx40ky8.css`, SHA-256 `dc46fcb1b4d8a84ffeda8bd9fc9648e382241cb55e1d2ba6030a81a19e609835`.

`npx --no-install vitest run test/TaskPanel.test.tsx --maxWorkers=1` in apps/web: 45 passed, exit 0 at 02:40:18 UTC. JSDOM printed its existing canvas getContext diagnostic. Shared protocol file passed 5; three named node caller files passed 9. No collection-only or interrupted result is counted as PASS.

## Static checks

- `npx --no-install tsc -p apps/node/tsconfig.json --noEmit`: exit 0.
- `npx --no-install tsc -p packages/protocol/tsconfig.json --noEmit`: exit 0 at 02:07:53 UTC.
- `npx --no-install tsc -p apps/web/tsconfig.json --noEmit`: exit 0 at 02:08:51 UTC; repeated after the final browser edits: exit 0 at 03:22:34 UTC.
- `npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit`: exit 0 at 02:20:07 UTC, including tests. Six unknown raw SQL result types in stored-secrets.test.ts were fixed with explicit row shapes; assertions are unchanged.
- `npm run build -w @hornhoof/node`, protocol, web, server: each exit 0 (02:07:53, 02:08:33, 02:09:09, 02:11:00 UTC). Latest separate web build also passed at 02:59:52 UTC. Vite warns about chunks over 500 kB; no threshold changed.
- ESLint: 13 changed server TypeScript files, eight changed web files, node redact.ts, protocol redaction source/test all exit 0. Stored-secrets lint repeated after its type fix: exit 0 at 02:23:05 UTC. Final browser config/spec lint: exit 0 at 03:23:34 UTC.
- `git diff --check`: clean before final report commit; final check is recorded in submission.

## Concerns and review boundary

Independent Review, Security and Tests still own their gates. Security must review company ownership resolution (especially deleted-row history), private SECURITY DEFINER helpers, transaction/table locking and the frozen-evidence exception. Fingerprints hold no reversible plaintext, but are sensitive and remain hidden from agents.

The action scans stored prose and copies; production latency on a large database is not measured. Tests use isolated PGlite databases and browser API fixtures, not live physical replication. Encrypted historical backups, exports and copies outside live logical databases are not rewritten.

The initial caller run passed 136 and failed two: the then-combined merge test hit its runner limit; route-access rejected the base POST /api/attachments declaration. The former is now covered by four passing independent directions. The unchanged route-access file's declaration issue belongs to Ghost in #1196; #1173 was cancelled. The head said not to wait for #1196.

Several earlier checks returned 143 without a final summary, including server types and browser runs. Operations receives that investigation through the head; no interrupted result is counted as PASS. A preview process survived one interruption; only its recorded PID 462861 and verified shell 462098 were stopped. Browser checks were split into short named-file commands, and final server checks ran individually in PTY without other author checks running. These facts do not establish the source of SIGTERM. Full raw receipts and checked source fingerprints accompany the task as hh-1077-current-checks.zip (SHA-256 d08208a39f19069ee728b730e1beaaa935a1cb2d3046c633ad45d74c14af75b4).

Interrupted command records (UTC; a detection bound is not a measured signal time):

- `npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit` as the first command of the old combined package check: started 01:38:24; 143 observed around 01:40, no compiler output. All four packages subsequently passed separately.
- `npm run build -w @hornhoof/web`, 01:53:33–01:54:09: child printed exit 0, outer tool returned 143. That discrepant receipt is superseded by later complete exit-0 builds.
- `npx --no-install playwright test e2e/hide-secret.spec.ts --config e2e/hide-secret.config.ts --workers=2`: start 02:40:34, 143 detected by 02:46:54, no final summary (`task-1077-browser-build-final.log`).
- Same browser command with `--workers=1`: start 02:47:37, 143 detected around 02:52:50, no final summary (`task-1077-browser-serial-final.log`).
- Same one-worker command adding `--project=firefox`: start 03:00:41, 143 detected before 03:05:40, exact signal time not captured (`task-1077-browser-firefox-preview.log`).
- Same one-worker command adding `--project=chromium` on the batched test: start 03:14:15, 143 detected before 03:16:23, before a case result (`task-1077-browser-chromium-batched.log`). The two final short Chromium commands subsequently passed.
- The earlier five-file server run (`stored-secrets`, `secret-redaction-merge`, `secret-redaction-migration`, `secret-redaction-rights`, `outbound-grants`, one worker) returned 143 after printing some file passes; UTC was not recorded (`task-1077-company-green.log`). Its partial results are superseded by all five complete individual receipts above.

No whole suite, run_tests, live ArSpatially access, shared-branch integration or deployment was performed. The automatic author wrapper's broad shared-package selection would violate this task's explicit ban on a whole run, so named local checks were used. No coverage, CRAP, duplication or mutation score is claimed. Release-wide proof belongs to the release owner on the combined candidate.

Migration 0137's when is greater than 0136's and its snapshot points to 0136's snapshot. Before authorized integration the integrator must set when at that moment, strictly after the last applied journal entry, and preserve matching number/snapshot order. If tracker 0139 integrates first, ask the head to renumber before merging. This author does not integrate.

## Person's steps after the authorized ArSpatially rollout

1. Sign in as CEO, delegate, or a person running the task's department.
2. Open task 267, select only the password in its details or log (at least 8 characters), and choose **Hide secret**.
3. Check the private field, choose **Hide everywhere**, then check the mask and the log's actor/time entry.

The person performs this action after rollout; no live record was accessed here.

## Timeout inventory requested by the head

Compared with merge base `73d4a6e9521059384503aa8f2d9a4942635d1568`, every listed file was added by #1077. These are not classified as untouched base failures. All required current cases subsequently have complete GREEN receipts above. Each entry preserves the earlier run, test, reported duration and limit. Where UTC was not captured, it is explicitly unknown; a file's modification time is not substituted for an execution time. The first two merge cases also exceeded the existing 10 s teardown hook in the failed run.

- `task-1077-browser-build-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, ru, matrix, 375px; 34.7 s (limit 30 s); changed since base: yes; start 2026-11-17T02:40:34.633645+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end no end timestamp.
- `task-1077-browser-build-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, ru, matrix, 1440px; 34.5 s (limit 30 s); changed since base: yes; start 2026-11-17T02:40:34.633645+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end no end timestamp.
- `task-1077-browser-build-final.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, cyberpunk, 1440px; 36.9 s (limit 30 s); changed since base: yes; start 2026-11-17T02:40:34.633645+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end no end timestamp.
- `task-1077-browser-build-final.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, cyberpunk, 375px; 36.8 s (limit 30 s); changed since base: yes; start 2026-11-17T02:40:34.633645+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end no end timestamp.
- `task-1077-browser-build-final.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, light, 1440px; 35 s (limit 30 s); changed since base: yes; start 2026-11-17T02:40:34.633645+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end no end timestamp.
- `task-1077-browser-build-final.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, light, 375px; 45.9 s (limit 30 s); changed since base: yes; start 2026-11-17T02:40:34.633645+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end no end timestamp.
- `task-1077-browser-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, cyberpunk, 1440px; 33.5 s (limit 30 s); changed since base: yes; start 2026-11-17T02:10:00.937646+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end 2026-11-17T02:14:13.733766+00:00 EXIT -2.
- `task-1077-browser-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, cyberpunk, 375px; 34.2 s (limit 30 s); changed since base: yes; start 2026-11-17T02:10:00.937646+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end 2026-11-17T02:14:13.733766+00:00 EXIT -2.
- `task-1077-browser-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, light, 1440px; 44.5 s (limit 30 s); changed since base: yes; start 2026-11-17T02:10:00.937646+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end 2026-11-17T02:14:13.733766+00:00 EXIT -2.
- `task-1077-browser-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, light, 375px; 49.2 s (limit 30 s); changed since base: yes; start 2026-11-17T02:10:00.937646+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end 2026-11-17T02:14:13.733766+00:00 EXIT -2.
- `task-1077-browser-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, matrix, 375px; 39.9 s (limit 30 s); changed since base: yes; start 2026-11-17T02:10:00.937646+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end 2026-11-17T02:14:13.733766+00:00 EXIT -2.
- `task-1077-browser-final.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, matrix, 1440px; 40.7 s (limit 30 s); changed since base: yes; start 2026-11-17T02:10:00.937646+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=2']; end 2026-11-17T02:14:13.733766+00:00 EXIT -2.
- `task-1077-browser-firefox-final.log`; `apps/web/e2e/hide-secret.config.ts`; web server startup; 60 s (limit 60 s); changed since base: yes; start 2026-11-17T02:57:14.235788+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--project=firefox', '--workers=1']; end 2026-11-17T02:58:28.393519+00:00 EXIT 1.
- `task-1077-browser-firefox-part1.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, cyberpunk, 375px; 32.6 s (limit 30 s); changed since base: yes; start 2026-11-17T03:05:40.371974+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--project=firefox', '--workers=1', '--shard=1/2']; end 2026-11-17T03:09:38.970519+00:00 EXIT 1.
- `task-1077-browser-firefox-part1.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, light, 375px; 34.1 s (limit 30 s); changed since base: yes; start 2026-11-17T03:05:40.371974+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--project=firefox', '--workers=1', '--shard=1/2']; end 2026-11-17T03:09:38.970519+00:00 EXIT 1.
- `task-1077-browser-serial-final.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, cyberpunk, 375px; 33.3 s (limit 30 s); changed since base: yes; start 2026-11-17T02:47:37.236920+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=1']; end no end timestamp.
- `task-1077-browser-serial-final.log`; `apps/web/e2e/hide-secret.spec.ts`; firefox: hides a selected secret, en, cyberpunk, 1440px; 33 s (limit 30 s); changed since base: yes; start 2026-11-17T02:47:37.236920+00:00 ['npx', '--no-install', 'playwright', 'test', 'e2e/hide-secret.spec.ts', '--config', 'e2e/hide-secret.config.ts', '--workers=1']; end no end timestamp.
- `task-1077-merge-final.log`; `apps/server/test/secret-redaction-merge.test.ts`; keeps a secret suppressed when the leader receives a merge; 42.752 s (limit 20 s); changed since base: yes; start 2026-11-17T02:21:24.019395+00:00 ['npx', '--no-install', 'vitest', 'run', 'test/secret-redaction-merge.test.ts', '--maxWorkers=1', '--reporter=verbose']; end 2026-11-17T02:26:57.164181+00:00 EXIT 1.
- `task-1077-merge-final.log`; `apps/server/test/secret-redaction-merge.test.ts`; keeps a secret suppressed when the offline receives a merge; 36.512 s (limit 20 s); changed since base: yes; start 2026-11-17T02:21:24.019395+00:00 ['npx', '--no-install', 'vitest', 'run', 'test/secret-redaction-merge.test.ts', '--maxWorkers=1', '--reporter=verbose']; end 2026-11-17T02:26:57.164181+00:00 EXIT 1.
- `task-1077-merge-final.log`; `apps/server/test/secret-redaction-merge.test.ts`; keeps another company unchanged when the leader receives a suppression; 25.759 s (limit 20 s); changed since base: yes; start 2026-11-17T02:21:24.019395+00:00 ['npx', '--no-install', 'vitest', 'run', 'test/secret-redaction-merge.test.ts', '--maxWorkers=1', '--reporter=verbose']; end 2026-11-17T02:26:57.164181+00:00 EXIT 1.
- `task-1077-merge-final.log`; `apps/server/test/secret-redaction-merge.test.ts`; keeps another company unchanged when the offline receives a suppression; 27.424 s (limit 20 s); changed since base: yes; start 2026-11-17T02:21:24.019395+00:00 ['npx', '--no-install', 'vitest', 'run', 'test/secret-redaction-merge.test.ts', '--maxWorkers=1', '--reporter=verbose']; end 2026-11-17T02:26:57.164181+00:00 EXIT 1.
- `task-1077-migration-final.log`; `apps/server/test/secret-redaction-migration.test.ts`; upgrades an existing database without discarding prose and applies suppression after repeat migration; 35.405 s (limit 20 s); changed since base: yes; start 2026-11-17T02:27:15.178061+00:00 ['npx', '--no-install', 'vitest', 'run', 'test/secret-redaction-migration.test.ts', '--maxWorkers=1', '--reporter=verbose']; end 2026-11-17T02:31:22.440628+00:00 EXIT 1.
- `task-1077-rtl-preview-clock-red.log`; `apps/web/e2e/hide-secret.config.ts`; web server startup; 60 s (limit 60 s); changed since base: yes; start not recorded; end no end timestamp.
- `task-1077-rtl-preview-red.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, matrix, 375px; 37.3 s (limit 30 s); changed since base: yes; start not recorded; end no end timestamp.
- `task-1077-rtl-red.log`; `apps/web/e2e/hide-secret.spec.ts`; chromium: hides a selected secret, en, matrix, 375px; 33.3 s (limit 30 s); changed since base: yes; start not recorded; end no end timestamp.
- `task-1077-stored-final.log`; `apps/server/test/stored-secrets.test.ts`; secrets in stored prose > masks tasks and comments before storing their copies; 29.485 s (limit 20 s); changed since base: yes; start 2026-11-17T02:11:44.355932+00:00 ['npx', '--no-install', 'vitest', 'run', 'test/stored-secrets.test.ts', '--maxWorkers=1', '--reporter=verbose']; end 2026-11-17T02:20:58.858385+00:00 EXIT 1.

## Changed paths

- `apps/node/src/redact.ts`
- `apps/server/drizzle/0137_secret_redactions.sql`
- `apps/server/drizzle/meta/0137_snapshot.json`
- `apps/server/drizzle/meta/_journal.json`
- `apps/server/src/db/agent-sql.ts`
- `apps/server/src/db/schema.ts`
- `apps/server/src/modules/conversation/inbox.ts`
- `apps/server/src/modules/conversation/queue.ts`
- `apps/server/src/modules/events/store.ts`
- `apps/server/src/modules/merge/rules.ts`
- `apps/server/src/modules/tasks/engine.ts`
- `apps/server/src/modules/tasks/hide-secret.ts`
- `apps/server/src/modules/tasks/routes.ts`
- `apps/server/test/secret-redaction-merge.test.ts`
- `apps/server/test/secret-redaction-migration.test.ts`
- `apps/server/test/secret-redaction-rights.test.ts`
- `apps/server/test/stored-secrets.test.ts`
- `apps/web/e2e/hide-secret.config.ts`
- `apps/web/e2e/hide-secret.spec.ts`
- `apps/web/src/i18n/en.ts`
- `apps/web/src/i18n/ru.ts`
- `apps/web/src/types.ts`
- `apps/web/src/ui/HideSecret.tsx`
- `apps/web/src/ui/TaskPanel.tsx`
- `apps/web/src/ui/hide-secret.css`
- `apps/web/test/TaskPanel.test.tsx`
- `docs/tasks/1077-en-cyberpunk.png`
- `docs/tasks/1077-en-light.png`
- `docs/tasks/1077-en-matrix.png`
- `docs/tasks/1077-en-pixel.png`
- `docs/tasks/1077-ru-cyberpunk.png`
- `docs/tasks/1077-ru-light.png`
- `docs/tasks/1077-ru-matrix.png`
- `docs/tasks/1077-ru-pixel.png`
- `docs/tasks/1077-secret-redaction-evidence.md`
- `docs/tasks/1077-secret-redaction.md`
- `packages/protocol/src/redaction.ts`
- `packages/protocol/test/redaction.test.ts`

## Security repair, 17 November 2026

Input candidate: `be983c08bfe10d5f4885f7c703ee4afe1a364520`; task base: `73d4a6e9521059384503aa8f2d9a4942635d1568`. Repair: `8beef61d08464df2ebbee0be4e2aac0ed807a9a2`.

Confirmed regression: replacing the conversation join-code guard with the narrow prose mask restored machine join codes in stored and returned events. The existing `events.test.ts` regression failed on the input candidate. The repair restores this guard for incoming events, job events and outgoing conversation copies. Its pattern lives in protocol; ordinary stored prose still keeps command examples as before.

A new stored-secrets case records both outer and transaction SQL calls, requires that the actual row-replacement query was captured, and asserts that neither SQL text/parameters nor the API response contains the synthetic selected value. This is not a measurement of a live PostgreSQL logging configuration.

Changed files: `packages/protocol/src/redaction.ts`, `apps/server/src/modules/events/store.ts`, `apps/server/test/stored-secrets.test.ts`. The change is authored by Security; it is not an independent Security PASS on this repair. Tests must verify the submitted final candidate before any authorized integration. No live data, shared branch or deployment was touched.

Final affected evidence: 46 distinct tests (events 10, left-input 18, stored-secrets 10, protocol redaction 8), exit 0. The earlier 37-test receipt includes the nine existing stored-secrets cases; the final ten-case receipt supersedes that file. No whole suite or run_tests was used. Builds/types/lint below also exited 0, with no diagnostics.

Reused evidence: the Review archive `t1077-redesign-checks.tar.gz` has SHA-256 `54de6ec91ca7d9d5ed0e9e672e3354ba2ad98326e656ebadd799cafffd1815f8`. Its e7be0034 executable inputs match be983c08 (the latter changes only this task documentation); secret-redaction scan 13, merge 4, migration 2 and rights 1 passed. Their code is unchanged by this repair. Repeated author checks were not run for appearances. Historical author/browser evidence and its limits remain above.

Limits: native `codex review --base review-1077-base` failed before reading code because bwrap could not create a namespace; shell exit 0 is not a native review PASS. Manual Security inspection was performed. The historical merge checks exceeded the file budget and one initial merge-task attempt timed out; its later successful run does not erase that failure. The 100000-row benchmark produced measurements but failed its cleanup hook, so it is not a passing test. The probe for deleted attachment bytes did not reproduce a leak: the journal keeps content hashes rather than those old bytes. It is not a reported finding. Real PostgreSQL, live replication and ArSpatially were not accessed.

Current full logs for the Review claim of TaskPanel 45 and node redaction 9 on 82b84774 were requested from the reviewer; old author receipts are not relabelled as a current UI run. Resource measurements remain PGlite observations, not release guarantees.


### events-red.log

Command: `apps/server: npx --no-install vitest run test/events.test.ts --maxWorkers=1 --no-file-parallelism -t 'keeps no machine command'`. Exit: `1`. SHA-256: `dd399ec336b21c8b192fa8ff6a3418d7a7fb03fa059ee354c2a4b3a494134713`.

```text

 RUN  v5.0.5 /data/work/agents/36a65f87-bacf-484b-b619-f7ab7189393e/hornhoof-task-1077-security/apps/server

 ❯ test/events.test.ts (10 tests | 1 failed | 9 skipped) 853ms
   ❯ GET /api/stream (10)
     ↓ refuses a signed-out request
     ↓ sends the orchestrator's conversation to people who see the whole company
     × keeps no machine command in a conversation, only the command with its code hidden 852ms
     ↓ keeps an assistant's whole conversation out of a message with no envelope, in the window and in the stream
     ↓ keeps the conversation from a department head but tells them the org changed
     ↓ ends open streams first when the server shuts down, so it does not wait for them
     ↓ ends the stream of a person who was disabled, at the next ping
     ↓ ends the stream of a person who was disabled at once, without waiting for the ping
     ↓ stops sending a department's news to a person at once when they no longer reach it
     ↓ counts an agent with a running conversation as working, on the map and in the stream

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/events.test.ts > GET /api/stream > keeps no machine command in a conversation, only the command with its code hidden
AssertionError: expected { …(2) } to deeply equal { …(2) }

- Expected
+ Received

  {
    "nested": [
      {
-       "line": "curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join [hidden]",
+       "line": "curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join Ab3_x-9Zq",
      },
    ],
-   "text": "Run: curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join [hidden]",
+   "text": "Run: curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join Ab3_x-9Zq",
  }

 ❯ test/events.test.ts:47:24
     45|     const event = await appendEvent(app.ctx, { companyId, agentId: orc…
     46|     const hidden = 'curl -fsSL https://hq.acme.com/install.sh | bash -…
     47|     expect(event.data).toEqual({ text: `Run: ${hidden}`, nested: [{ li…
       |                        ^
     48|     expect(JSON.stringify((await db.select(only(agentEvents, 'data')).…
     49|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 9 skipped (10)
   Start at  07:13:13
   Duration  8.42s (transform 58%, tests 24%, import 18%)
```


### events-green.log

Command: `apps/server: npx --no-install vitest run test/events.test.ts test/left-input.test.ts test/stored-secrets.test.ts --maxWorkers=1 --no-file-parallelism`. Exit: `0`. SHA-256: `55de3367a0095434e8b09697ad4e733b78a98bda2b01e7bfe033ea69c4302ef9`.

```text

 RUN  v5.0.5 /data/work/agents/36a65f87-bacf-484b-b619-f7ab7189393e/hornhoof-task-1077-security/apps/server

 ✓ test/stored-secrets.test.ts (9 tests) 9777ms
   ✓ secrets in stored prose (9)
     ✓ masks tasks and comments before storing their copies 6628ms
     ✓ hides an existing selection from tasks, nested copies, journals and API responses 399ms
     ✓ checks department authority on the server and rejects ordinary readers 1406ms
 ✓ test/left-input.test.ts (18 tests) 10416ms
   ✓ words left unsent in a program's input (16)
     ✓ are kept, and only then the node hears that it may clear them 7543ms
     ✓ are kept once however many times the node asks, and it hears each time 723ms
     ✓ name who typed in the terminal last, not the author of the new assignment 449ms
 ✓ test/events.test.ts (10 tests) 13526ms
   ✓ GET /api/stream (10)
     ✓ refuses a signed-out request 6666ms
     ✓ sends the orchestrator's conversation to people who see the whole company 1256ms
     ✓ keeps an assistant's whole conversation out of a message with no envelope, in the window and in the stream 1194ms
     ✓ keeps the conversation from a department head but tells them the org changed 1384ms
     ✓ stops sending a department's news to a person at once when they no longer reach it 1087ms
     ✓ counts an agent with a running conversation as working, on the map and in the stream 1148ms

 Test Files  3 passed (3)
      Tests  37 passed (37)
   Start at  07:17:38
   Duration  17.37s (tests 91%, import 6%, transform 3%)
```


### stored-final.log

Command: `apps/server: npx --no-install vitest run test/stored-secrets.test.ts --maxWorkers=1 --no-file-parallelism`. Exit: `0`. SHA-256: `ef2357380e8d0d757cec053be742ba02d5f8b91cae2e6c6a7c4db8b66a658af4`.

```text

 RUN  v5.0.5 /data/work/agents/36a65f87-bacf-484b-b619-f7ab7189393e/hornhoof-task-1077-security/apps/server

 ✓ test/stored-secrets.test.ts (10 tests) 2922ms
   ✓ secrets in stored prose (10)
     ✓ masks tasks and comments before storing their copies 1605ms
     ✓ checks department authority on the server and rejects ordinary readers 391ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  07:22:41
   Duration  16.89s (tests 65%, transform 20%, import 15%)
```


### protocol-green.log

Command: `packages/protocol: npx --no-install vitest run test/redaction.test.ts --maxWorkers=1`. Exit: `0`. SHA-256: `b696138ad55a7bf2334cc96290c47ef4d95db8b1b64d7085d2f8c00f2496b4b0`.

```text

 RUN  v5.0.5 /data/work/agents/36a65f87-bacf-484b-b619-f7ab7189393e/hornhoof-task-1077-security/packages/protocol

 ✓ test/redaction.test.ts (8 tests) 12ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  07:19:27
   Duration  197ms (transform 68%, tests 16%, import 14%, worker 3%)
```


### protocol-build.log

Command: `root: npx --no-install tsc -p packages/protocol/tsconfig.json`. Exit: `0`. SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

```text

```


### server-build.log

Command: `root: NODE_OPTIONS=--max-old-space-size=2048 npm run -s build -w @hornhoof/server`. Exit: `0`. SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

```text

```


### server-test-types-final.log

Command: `root: NODE_OPTIONS=--max-old-space-size=2048 npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit`. Exit: `0`. SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

```text

```


### lint.log

Command: `root: NODE_OPTIONS=--max-old-space-size=2048 npx --no-install eslint apps/server/src/modules/events/store.ts apps/server/test/stored-secrets.test.ts packages/protocol/src/redaction.ts`. Exit: `0`. SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

```text

```


### lint-final.log

Command: `root: NODE_OPTIONS=--max-old-space-size=2048 npx --no-install eslint apps/server/test/stored-secrets.test.ts`. Exit: `0`. SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

```text

```
