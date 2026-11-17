# Task 1253 verification records

This evidence branch stores the full local outputs separately from the checked code candidate. No whole suite or run_tests was invoked.

## Passed candidate before the last turn-32 advance

Base: 76a7c5dada5dd4e47ecf039371f995244e46ad0c.
Code: ca0ea0169065b0e537d09ada579919e3e064ff1f.

`NODE_OPTIONS=--max-old-space-size=2048 npm run -s check:author -- --sha ca0ea0169065b0e537d09ada579919e3e064ff1f --base 76a7c5dada5dd4e47ecf039371f995244e46ad0c` exited 0: 27 tests in four named server files passed, ESLint and TypeScript passed, changed-line coverage 62/62, CRAP worst 8.7407, no new duplicates. No formatter is configured; that stage is unavailable, not passed. `npm run build -w @hornhoof/server` exited 0.

## Neighbour failure and baseline comparison

`npx --no-install vitest run test/test-runs.test.ts test/test-runs-work.test.ts test/test-runs-wait.test.ts test/test-runs-hosts.test.ts --maxWorkers=1` on ca0ea016 exited 1: 119 passed and 1 timed out. The failing case is test-runs-wait.test.ts:58 under run_tests: ends the wait and wakes the agent once with the result and where to read it, when it passes. Its duration was 20,377 ms against the unchanged 20,000 ms test limit.

A diagnostic whole-file run of that named file with HH_TEST_PART=1 on the same code exited 1: 43 passed and 6 timed out. The timing reporter attributes 296,417 ms to setup, 99,379 ms to test bodies and 938 ms to teardown. This is diagnostic evidence, not a passing retry.

The same first scenario was then selected on the clean base 76a7c5dada5dd4e47ecf039371f995244e46ad0c, without the task changes. After the lockfile dependencies and local packages were prepared, it also timed out (45,860 ms). The baseline command is recorded in baseline-wait-prepared.log: 1 failed and 48 filtered tests, exit 1. Timing totals: setup 156,587 ms, test body 4,405 ms, teardown 24 ms. Both source trees used the same unchanged timeout and same test and helper source. The base reproduction establishes that this failure is present without task 1253; it does not establish the precise cause of the slow setup. The failed scenario does not invoke test_run or work_run, the read entry points changed here.

An earlier baseline attempt ran before dependency preparation finished and failed importing vitest/config. baseline-wait.log proves no test execution. It is neither a product failure nor passing evidence.

## Red/green and review records

The initial API RED fixture had a subscription field typo; initial-red.log retains that preparation failure. api-red.log is the corrected missing-field RED. Other RED logs cover the missing queue snapshot, startup state, authenticated job versus part-label identity, and an unknown live queue position.

The author-complexity-failure.log is a real failing quality gate on febc7a0af7046e88cf15567bed3bbf9ca2c50eb0. The implementation was split into small functions; limits were unchanged. author-32ec.log shows the repaired gates and 27 passing tests on 32ec0cf2cae23641d51927d901448b87c34fa5b7, whose neighbour run also passed all 120 cases. Those results apply only to that earlier candidate.

The codex review helper could not start because bubblewrap could not create a namespace. Its exit summary does not prove code review. The task owner performed the required self-review and security check, with executable regressions for metadata visibility, actual node binding, single-line labels, and authenticated job identity.

The author run on 7858add02d11c003c15b5fa4ec1a964cdf13f2de was stopped with SIGTERM (exit 143) after self-review found one more own-claim label collision. It is not passing evidence. The new regression and final checked result follow in the final record.

## Integration route

Only the three task commits were rebased from the old cf8b05fe base; old turn-31 history was not merged. The head authorized origin/turn-32 and normal fast-forward integration, with Ivan Korol as author and Signed-off-by and no Co-Authored-By trailers. At 2026-11-17 12:06 UTC the remote v0.31.0 tag was observed at d2994cb1d08bdd58277a5fa37e6d15e09d49912d, so the original tag prerequisite was satisfied.

## Own part-label regression

The final self-review regression changed an authenticated local command label to the waiting part's own UUID and read before that part acquired any slot. On 7858add02d11c003c15b5fa4ec1a964cdf13f2de plus the regression, own-claim-red.log exited 1 (1 failed, 7 passed): state running and position 0 were incorrectly attributed to the part. Excluding authenticated job claims from the part's own-claim match gave own-claim-green.log exit 0, all 8 API cases passed, without changing scheduler behaviour. This repair was committed as a975ae63a before rebasing only the four task commits onto turn-32 caad7ea6a00c34adb914952e80d549a9cf8076e7. The resulting code candidate is 5c16adcd3e9e59b1155c6d1212e411cd93f8defa.

## Final candidate checks

Base: caad7ea6a00c34adb914952e80d549a9cf8076e7. Code: 5c16adcd3e9e59b1155c6d1212e411cd93f8defa.

The exact candidate author command in verification.json exited 0. All 27 selected tests in builtin-nodes-apart.test.ts, check-queue-watchdog.test.ts, check-queue.test.ts and test-runs-slots.test.ts passed. TypeScript, ESLint, CRAP (worst 8.7407, changed lines covered 62/62) and dryer passed. No formatter exists. The separately executed server build exited 0. Raw outputs, per-case JSON, changed-file hashes and quality records accompany this file. Requirements map to named cases in verification.json.

Self-review and security review: snapshot reads copy data, do not allocate a coordinator or call scheduling, and preserve lease cleanup visibility. runState authorizes the reader before enrichment. Actor details are scoped to the company, actual node and existing owner/task read authority; inaccessible details are redacted. Authenticated jobs take precedence over labels and cannot impersonate the waiting part's own claim. No new permission, secret, schema or wire-protocol surface was added by this task.

The four named neighbouring files on 5c16adcd3e9e59b1155c6d1212e411cd93f8defa completed with exit 0: 120 passed, zero failures. The previous failures remain recorded above; no timeout or assertion was weakened.

Turn-32 then advanced only by the independent events.test.ts clock repair. Rebasing the same four task commits gives a58f10b7fe6e345600a8694095b8ccd150d68eb0, based on 4aef2458406a0706567a921b7083195686c70e65. neighbour-input-fingerprint.json proves every repository file except that unrelated test has identical git tree input, including production code, lockfiles, all four selected tests and their helpers/configuration. Its 120-case result is reused for these matching inputs. The author checks (including TypeScript with all test source) and server build are re-executed on a58f10b7.

## Integrated result

Final code a58f10b7fe6e345600a8694095b8ccd150d68eb0 passed the author checks (27 tests, TypeScript, ESLint, CRAP and dryer) and server build, both exit 0. The final raw logs and per-case JSON are included. Format remains unavailable because the repository has no formatter. The matching-input neighbouring run supplies another 120 passed cases, as specified above.

Normal fast-forward from 4aef2458406a0706567a921b7083195686c70e65 to the exact final code succeeded on turn-32 with no force. integration.txt contains the command, result and remote readback. No main push or turn-31 integration was made. All required self-review and security checks are complete; no external checker was called.

Status: DONE_WITH_CONCERNS. The delivered read API behaviour is proved and integrated. The earlier neighbouring timeout and its clean-base reproduction remain an existing reliability concern, with the exact cause of slow preparation not established. The task neither repairs that separate behaviour nor claims that a later passing result erased the failures. Whole release validation remains with the release owner.
