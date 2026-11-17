# Task 1257 transfer checkpoint

Status: BLOCKED before shared-branch integration. The assignment requires stopping when conflicts change either side's meaning. Nothing from this task has been pushed to turn-32. No main or old turn-31 history was merged.

## Checked transfer of task 1227

Source `ee4a49d54a882b1c8e9070689fd6ace447e9ab2a`, old tree base `150c19a62d2ab39ad2b0a451ff6cbae43ffe91d3`, new release base `82d62a6bebb3ffde6c21ae89274d85ece89b5685`. Initial replay `30d6cf1387212f9525e74eb60f229b956792f16d`: full binary patches relative to those bases were identical, SHA-256 `5b34cae56e668d587820c1b08fd5dbf2b34af4781b7d74e99843dc012dfd90bb`.

During checks turn-32 gained 1241 and 1251 at `9ca84d697b66c116335eafd979c1b7f141304200`. Both were retained by merge in checked candidate `4fa7aebb7870b0c8a892c56d73f355d17bd48b96`. Since 1241 occupied migration 0137, secret redaction moved to 0138 / idx 137, after 0137_message_sender_window / idx 136. Its SQL is unchanged. Snapshot 0138 retains every incoming table and adds the accepted secret_redactions table; prevId points to 0137. Indices 135, 136, 137 are consecutive and timestamps increase. The historical gap at idx 48 predates this task and was preserved.

39 of the source's 42 feature blobs are byte-identical, allowing the SQL rename. The other three are schema.ts, the appended journal and the rebased snapshot. schema.ts retains both the sender-window index and the secret table.

Checks: 47 server tests in eight explicitly named files, 46 TaskPanel, eight protocol redaction and two node redaction: 103 passed in 11 files. Server test types, web types, lint on 28 changed TypeScript files and all workspace builds exited 0. Exact commands, SHA, output hashes and raw logs are in checks.json and 1227/. Fresh migration, upgrade from 0136 and repeated migration are covered. No run_tests or full test suite was run. No live PostgreSQL or final release proof is claimed. T5 is not PASS. Previously accepted real-ping / polling limitations remain with separately assigned repairs. No time limit or assertion was weakened.

The first server run on 30d6cf138 was interrupted after time limit failures (exit 143); its web run had 44 passed and two failed (exit 1). They remain NOT_PASS. The later complete passing runs are on 4fa7aebb7. Build retains the existing large web chunk warning, and TaskPanel retains the jsdom canvas warning.

## Replay conflict resolutions

Combined imports and local test setup. Retained existing private event guards, hideJoinCodes, vault links and release queue behavior. Left shipped migration 0129 intact and moved only the unpublished secret migration. Verified the journal prefix and snapshot against the new main. Restored dropped merge-resolution edits in six feature files from the accepted source; the binary patch comparison proves the resulting tree.

An initial local conflict-edit attempt failed its content assertion. That rebase was aborted and restarted before any bad commit was pushed. The accepted replay and target merge do not contain it.

## New semantic conflict requiring the head

Target advanced to `caad7ea6a00c34adb914952e80d549a9cf8076e7`, merging iv-no-confirm. Read-only three-tree comparison for accepted 1112 against that target is in 1112-conflicts.txt; no 1112 changes were applied.

- Target deletes `apps/server/src/modules/outbound/tools-head.ts`; source 1112 changes lines 15-25 and 90-113 to give heads standing outbound authority. The outbound-department test is also deleted.
- Source 1112 `packages/protocol/src/approval-policy.ts` lines 26-27 makes the universal default new_kinds. Target lines 27-46 instead define per-channel defaults: none for message/price/publication, every for commit, new_kinds for the rest, and a different ruleOf signature.
- Related conflicts: `apps/server/src/modules/tools/approval-policy.ts` lines 65-69 and tool descriptions, department approval rules, protocol/server/web approval tests, head/questions/marketing/sales/support skill texts. Some named outbound Tests files no longer exist in the target.

The head must decide which obsolete outbound/default-rule parts of 1112 are excluded and authorize the matching test-scope update. Recommendation: retain iv-no-confirm behavior and deletion, transfer only still-applicable standing head authority, then check the adjusted named scope. This changes the scope beyond a mechanical replay. Tasks 1119 and 1220 have not been replayed or integrated. Checked 1227 predates caad7ea6a and does not prove its new combined tree.
