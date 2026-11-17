# Review of iv-phone and iv-assistant-files, task 1205

Status: DONE_WITH_CONCERNS. The review is complete as a findings document; the branches are not approved for release. The file disclosure below blocks 0.31.0 and is being repaired in task 1214. This document does not replace the task's independent Review and Security stages.

## Versions and comparison

- iv-phone: `b859ecff716c791e09990d2c202e5ed4af89e810`.
- iv-assistant-files: `879d89d6cb45f9a9f2a81b91395148ebc6a19f80`.
- Integration snapshot inspected and executed: turn-31 `8d072390a22c5a8b57ec9976de691a4d20aa298c`.
- Local repair: `62ffcde48f72a970c04e9a81ac65b8aab2d35ad8` on task-1205.
- Added phone boundary tests and preserved reproduction: `71318e97f04da719641810a7184e9a7c93afd627` on task-1205.

After `git fetch origin`, both requested commands produced no commits:

```text
git log --oneline turn-31..origin/iv-phone
git log --oneline turn-31..origin/iv-assistant-files
```

Both branch tips were already ancestors of turn-31. Consequently, `git merge-base origin/turn-31 <tip>` equals that tip and the requested current comparison is empty. I reconstructed the substantive changes from the integration history instead of treating that empty comparison as proof of a clean change:

- Phone introduction: `e2e5d0114^1..e2e5d0114`, base `18e252503f8c5f28133bc70a7381f8e85a4d71f8`; subsequent phone commits through b859ecff7, including USB, were inspected against their parents.
- Assistant refusal wording: `96b505da8^1..96b505da8`, whose parents share base `41d37dd3d4f919e63ed39f4f0ce0d898e440f4c5`.
- File links and large files: `810bdff89^..810bdff89`; integration `16fe776e8` has merge base `6eb446d522c7ee52bddf46529e817c873aae59ef` between its parents. The later integration at `40f7f7de2` includes the final assistant-files tip.

The phone modules, phone tests and protocol, and the reviewed assistant/files/attachments/crypto/Telegram modules have identical contents in their reviewed tips and the integration snapshot. Runtime tests below ran on that integration tree plus the isolated hh-fetch repair and explicitly listed new audit tests. They are not complete test runs of either historical branch's unrelated code.

The final fetch and both requested log commands were repeated before submission. turn-31 was then `a27bc368b1e027af70883d06d1da9ba2b07985ab`; both reviewed branch tips were unchanged and both missing-commit lists were still empty. The newer turn-31 commit is not claimed as a fully tested candidate here.

## Findings

### F1. P1, security: a delivery helper returns a private file capability to its caller

Location: `apps/server/src/modules/telegram/tools.ts:139`, especially lines 141 to 143. Introduced by 810bdff89 and present at the reviewed assistant-files tip and integration snapshot.

The helper checks whether the recipient can view the sender and the attachment. For a disk file it then returns an anonymous download link to the calling agent. It does not check whether that caller can read the attachment. A recipient's authority therefore becomes the caller's file capability.

Executed reproduction: a normal employee's file read returned 404 for a private file in the CEO's personal assistant chat. Calling `send_telegram_file` with the CEO as recipient and that known attachment id returned a signed URL. An anonymous GET downloaded the exact private bytes with status 200. No Telegram bot or outbound Telegram request was needed. The prerequisite is knowledge of the attachment id; this is not a claim that ids are enumerable.

Evidence: `reports/task-1205/server-audit.test.ts.txt`, first case; `reports/task-1205/server-checks.log` contains `AUDIT private file: employee download 404, delivery tool returned bearer link, anonymous download 200 with exact bytes.` The sample uses generated fixture data only.

The audit source is archived outside the default suite because its assertions record defects rather than the desired safe behavior. To replay it, restore it as `apps/server/test/review-1205-audit.test.ts` and run that named file from apps/server. A repair regression should invert the capability assertion and prove refusal, rather than keep disclosure as accepted behavior.

Disposition: confirmed and accepted as a release blocker by the head. Developer owns the repair in task 1214. No fix SHA was available when this report was written, and this report does not claim that repair passed. A returned bearer link must be limited to a caller who can itself read the file, or delivered to the authorized recipient without exposing it to that caller.

### F2. P1, resource exhaustion: upload limits are checked after the entire stream is written

Location: `apps/server/src/modules/tasks/attachments.ts:151`, especially lines 156 to 169 and the calls at lines 461 to 465; `apps/server/src/modules/assistants/routes.ts:126`.

`received()` counts bytes but has no upper bound while reading. With FILES_DIR enabled it keeps writing to disk until EOF. The task/company check uses Content-Length before reading and actual size only after EOF. A chunked request can consume arbitrary disk space before that final rejection. The picture-only attachment path also applies its 3 MB limit after receipt, and its pre-read space check has no task or chat to limit. Existing requests can continue consuming disk after their turn was checked at entry.

Executed sample: a controlled unfinished stream put 52,428,801 bytes on disk before EOF, then emitted a recorded interruption. This was a bounded reproduction, not an attempt to fill the machine. The exception removed its partial disk file. Source inspection establishes that neither a task quota nor the picture limit is consulted inside the read loop; the sample alone does not measure a real disk-full event.

Disposition: reported to the head, not repaired. The receiving boundary needs an incremental byte ceiling derived from its upload kind and available quota, with a reservation strategy for simultaneous uploads. Preserve abort/error cleanup. Actual ENOSPC handling and machine-wide disk capacity were not exercised.

### F3. P1, data loss: interrupted hh-fetch replaced a complete local file with incomplete data

Location in the reviewed assistant-files tip: `apps/node/hh-fetch.cjs:33`, the direct pipeline to `createWriteStream(path)`.

A successful HTTP response whose body fails later opens and truncates the destination before the download completes. A pre-existing complete file is lost even though the CLI reports failure. A new destination can also be left as an incomplete file.

Fixed in `62ffcde48f72a970c04e9a81ac65b8aab2d35ad8`: stream to a temporary directory beside the destination, rename after completion, and remove temporary data on either outcome. Existing destination mode is used when creating its replacement. No partial download is presented as success.

RED: `apps/node/test/fetch-partial.test.ts` failed with `expected '' to be 'previous complete file'`. GREEN: the same regression and `test/attach.test.ts` passed, 11 tests total. The latter includes a complete 60 MB upload/download through the bridge. Logs are attached with this report. The original branch SHA still contains this defect; the fix is only on task-1205, awaiting Review, Security and integration by the head.

## Phone and USB conclusions

For iv-phone b859ecff7, the executed checks found no cross-company phone or recording disclosure. Registration requires an active person and a live node of the same company. A registered physical phone cannot be reassigned by another person: `phoneOwner()` and the unique hardware key are checked. Stop and live screen access belong to the recorded phone owner or the authorized orchestrator path. Session and action checks bind the agent, live job, node, generation and lease.

The new `phone-access.test.ts` confirms that another company is refused, an unauthenticated caller is refused, and a viewer of the company task who cannot open the recorded agent gets an empty recording list. The authorized viewer sees the actual session. Company tasks themselves are shared under the existing `seesTask` policy; a blanket cross-department 403 would have tested a different policy.

The new `phone-identity.test.ts` confirms that replacing the hardware identity behind the same USB serial prevents an action, an absent device prevents opening a session, and node disconnect closes a previously active session. These use recorded driver replies and a controlled clock. They do not establish that a hostile rooted device cannot forge Android properties or that a machine administrator is untrusted.

USB ownership and disable limitation, importance: resolve before claiming a stronger guarantee. At `phones/store.ts:38` and 73 registration checks company ownership of the machine, not whether the registering person owns that machine. Any active company person who knows an unregistered serial can register the reachable device as their own. This follows the existing general registration behavior; whether USB should require machine-owner confirmation is an owner decision, not silently changed here.

At `apps/node/src/phones/adb.ts:66` to 68, presence of host.sock selects the host ADB server; absence selects the private server. There is no explicit disabled-USB rejection in the executor or a separate USB capability. Thus disabling the host path prevents selecting that host socket, but the stronger statement that every USB action is impossible also depends on the node's own ADB server having no USB access. That deployment/physical-device guarantee was NOT_PROVEN here. Add a specific opt-in gate if disabling must be enforced by application code independently of device visibility. No installer changes were made. These limits prevent an unconditional PASS on the full expanded USB requirement.

## Clean checks and limits

- HMAC binds the signed file id and expiry to a separate purpose and compares MAC bytes with timingSafeEqual. Virtual-time tests verify the seven-day boundary, changed file id/signature, another signing purpose, and deletion of the attachment row.
- Authenticated assistant downloads recheck current owner visibility and hide other companies, private assistant work, automatic screenshots and unavailable ids.
- Large-file samples cover storage outside database bytes, exact download bytes, loss of the serving disk, cleanup after thirty days, and cleanup of an interrupted incoming stream. They do not prove an upload resource ceiling; see F2.
- `git diff 77fdb8e68 origin/turn-31 -- apps/server/src/modules/outbound/contacts.ts` changes only the signing helper implementation/import. contactsOf, permissionPlace, revokePermission and setup-log attribution remain intact. Outbound and crypto checks are listed in the evidence.
- Task 1195's task panel check passes in the web selection. The additional request fix was not duplicated.
- Task 1196's attachment authorization declaration is still absent in the executed integration snapshot: route-access fails on POST /api/attachments. The actual attachment-token tests pass, 9 of 9. Ghost owns 1196 and was asked for its final integration SHA and receipt. This report does not claim the unfinished final declaration check passed.
- Full suite, run_tests, real physical phone operations, browser-engine layout checks, performance guarantees, disk-full simulation and independent Security were not run by this author.

## Later: revoking previously issued links

The head explicitly decided that, for 0.31.0, deletion of the file is link revocation, matching docs/assistant-api.md. Revoking the assistant key does not invalidate an already issued bearer link. This is a later improvement, not a blocker, once task 1214 restricts link issuance to someone entitled to read the file.

One option is explicit revocation, with a file/link generation or persisted link id and a revoke action. This is a medium feature: schema, authorization of revocation, UI/API and tests; it can preserve anonymous downloads and invalidate a chosen link or all links for a file. Another is including the issuing owner in the signed claim and rechecking that owner's active status and current file rights on download. This is also a medium feature with more authorization reads per download; it revokes automatically when rights disappear, but changes the documented bearer-link behavior. No delivery date or time estimate is promised. The head will create the follow-up after release.

## Evidence inventory

The machine-readable record and complete captured outputs are in `reports/task-1205/`. The final record names every command, version, exit status and selected file. No full-suite PASS is claimed from these local selections. Source code and regression tests are on task-1205; nothing was pushed to turn-31 or main.

All four application/package checks passed with `NODE_OPTIONS=--max-old-space-size=2048`: `tsc -p packages/protocol/tsconfig.json --noEmit`, `tsc -p apps/node/tsconfig.json --noEmit`, `tsc -p apps/server/tsconfig.json --noEmit`, and `tsc -p apps/web/tsconfig.json --noEmit`. ESLint passed on hh-fetch.cjs and the three added regression files. Separate test-project type checks and release-wide checks remain with the release scope.

The two server failures remain failures: `message-pictures.test.ts:111` exceeded its 20,000 ms runner limit, and route-access reported the missing attachment declaration owned by 1196. No timeout was raised and no check was weakened. The outbound-grants file also exceeded the 30-second file budget despite passing; retain that timing concern for the test owner.
