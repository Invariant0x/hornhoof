# Task 1282: completed verification and integration

Status: DONE. Code candidate `d5c8f8295859ed1996997cc3c3f79d3abef0ddab` is on both `task-1282` and `turn-32`. A normal push advanced the turn from `877f559aa6f05c7eaf286dc96d98daf42cc060bb`, without force. `integration.log` and `remote-readback.txt` are the executed receipt and readback.

## Causes and repairs

* `agent-view-table.test.ts`: `e9bcdedd0636b6597ec1ad1f585fb6bc46b4352a` added CEO-only deletion of a person, and `77416a9771300f6630a4056c3f4511b3fd724e0c` added the task's hide-secret route for task 1077. Both were absent from the inventory. The added rows point to the executed `people-delete.test.ts` and `stored-secrets.test.ts` authority checks; no route or access check changed.
* `watch-tools.test.ts`: `77416a9771300f6630a4056c3f4511b3fd724e0c` masks newly written task input and notes, as task 1077 requires and task 1227 preserves. Two old expectations wanted a known-format token back. They now require its exact mask, retain the same-department private path and cross-department restrictions, and explicitly verify the masked permitted task response.
* `assistant-agent.test.ts`: the accepted 50,000 / 200,000-character contract from `afc45bb00c3ad38370d3ba3039c80901d1371dec` was right. The URL expression in stored prose repeatedly searched suffixes of long plain words. The per-write mask was enabled by `77416a9771300f6630a4056c3f4511b3fd724e0c`; `8f0b7cf2717173f0414f0076c6990aad6bc28bf1` shared the URL expression with the narrowed prose list. The old quadratic site is `packages/protocol/src/redaction.ts:19` at `f311bea6312771faabc3d9fece0a6faf97f7ad3e`. Only that URL behavior and its replacement-protocol type were changed. All other masks and the assistant test's limits remain intact.

The original three-file run had 124 passed and four failed cases, exit 1, in `baseline.log`. The missing routes are one failing case, the stale token expectations two, and the assistant timeout one.

## Clock-free scanner proof

The scanner searches for the fixed `://` delimiter, checks its preceding scheme backwards, and runs the unchanged user/password subexpression only at that position with a sticky matcher. Searches advance; scheme runs of different delimiters do not overlap.

The operation-count test is RED on the original production file restored from `f311bea6`: zero bounded-search calls instead of one, exit 1 (`scan-counter-red.log`). The counter observes explicit search calls, searched spans and scheme character reads; it does not pretend to observe native RegExp backtracks. The old performance defect is independently reproduced by the original assistant timeout and the diagnostic pattern profile.

The new scanner is GREEN. For words of 2,048 / 4,096 characters it makes one search and accounts for 2,048 / 4,096 characters; with URL credentials it makes two searches and accounts for 4,111 / 8,207 units. Tests never consult a clock. `url-scan-steps.json` holds the counts.

`url-scanner-equivalence.json` repeats the same 64,420 generated inputs on the final scanner and the original expression with its original `$1[hidden]@` replacement: zero output differences. The source SHA-256 is `e70bc8967ebffe362004148df7c41ce6fc1316865e6bd2b9daefb48f0ba41701`, also checked on the final candidate. Credentials stay hidden and URL prefixes and public addresses stay as before. This corpus is bounded, not an exhaustive proof.

## Checked versions and final refresh

The full local author check on `0ee128ed0dd086b5fefe2541b5a5e8ffa0e9ea00`, against base `968b890b56da994c3c82c6088e611b56bf93694a`, exited 0: 105 tests, ESLint, TypeScript including server tests and the other affected projects, CRAP and dryer. New functions have CRAP 4 and 100 percent coverage; changed lines are 19 / 19 and new duplicates zero. The unchanged `hideCredentialsIn` is reported separately at CRAP 30 under this direct protocol coverage. The server build exited 0. Additional named checks passed 45 assistant/storage, 8 people-deletion and 19 node-log/redact cases.

The turn moved again before the push. Following the head's explicit refresh instruction, the final base `877f559aa6f05c7eaf286dc96d98daf42cc060bb` was merged without conflicts. `base-refresh-scope-stat.txt` is the empty output of `git diff --stat` between the checked and final bases over redaction source/tests, agent-view-table, assistant-agent and watch-tools. The only changed inputs were node/main tests, Subscriptions tests and the task 1218 report. `base-refresh-fingerprint.json` proves every other Git tree entry identical, including all runtime code, configuration, lockfile, helpers and tests whose results are reused.

On the final candidate itself, server TypeScript with tests and ESLint of all four changed TypeScript files passed, exit 0. Four named target files ran again: agent-view-table and watch-tools, 93 passed; assistant-agent, 35 passed; protocol redaction, 12 passed. Each command exited 0. The other 37 named cases and the build are reused only for the identical inputs recorded above. There are 177 unique passing cases in total, 140 executed again on the final candidate.

Complete commands, exit codes, versions, requirements and limits are in `verification.json` and the raw logs. Earlier bounded-regex candidates and their outputs are retained as history and are not presented as checks of the final scanner.

Own review and security check are complete: access boundaries stay intact, fixture credentials are synthetic, URL masking keeps its output, and the shared sticky matcher is used synchronously and reset for each candidate position. No external checker was called on this turnkey task. The two tool-list files assigned to Ghost have no task-1282 delta against the final base.

No formatter is configured, so that stage is unavailable rather than passed. No whole suite or `run_tests` was invoked; release validation remains with the release owner.
