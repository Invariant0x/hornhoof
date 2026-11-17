# Task 1282: three regressions before the 0.32.0 run

Task kind: bug. Risk: secret redaction. Base: `f311bea6312771faabc3d9fece0a6faf97f7ad3e` on `turn-32`.

## Acceptance and approach

Reproduce the three named server files, trace each failure to its introducing change, preserve the intended access and redaction contracts, and check the repaired files and the redaction callers locally. Keep `tasks-tools.test.ts` and `tools.test.ts` untouched. Integrate into `turn-32` by a normal fast-forward; leave the release's whole run to its owner.

## Causes and decisions

* `agent-view-table.test.ts`: `e9bcdedd0636b6597ec1ad1f585fb6bc46b4352a` added `DELETE /api/people/:id`; `77416a9771300f6630a4056c3f4511b3fd724e0c` added `POST /api/tasks/:id/hide-secret` for task 1077. Both routes were missing from the inventory. Add entries pointing to the existing executable access checks. Deletion is the CEO's alone, directly or through the orchestrator, with no deletion across companies; hiding a secret is for the CEO, delegate or a person running the task department, never ordinary readers. The route implementations are unchanged.
* `watch-tools.test.ts`: `77416a9771300f6630a4056c3f4511b3fd724e0c` masks task input and task notes at write time. Task 1077 explicitly requires known token formats to be hidden before storage, and task 1227 preserves that behavior across integration. Two older expectations incorrectly wanted a token back from a newly created task or blocked report. Expect its exact mask while retaining same-department private paths, cross-department restrictions and the cleaned `next` section. Also check that reading the permitted task returns the masked title and no token.
* `assistant-agent.test.ts`: the maximum-length `freshText` test times out, rather than rejecting a value or returning a wrong body. Task 1077 added normal prose redaction in `77416a9771300f6630a4056c3f4511b3fd724e0c`; `8f0b7cf2717173f0414f0076c6990aad6bc28bf1` put the URL-password pattern into its narrowed prose list. That expression retries a possible scheme at every letter of a long word, causing quadratic work. Profiling the patterns separately isolates it: 25,000 letters took about 310 ms and 50,000 about 1,289 ms, while the other patterns stayed below 1 ms. The accepted 50,000 / 200,000 limits originate in `afc45bb00c3ad38370d3ba3039c80901d1371dec` and remain documented in `docs/assistant-api.md`. Fix the expression, keeping the limits and the original integration test unchanged.

The URL search now starts once per run of scheme characters. Leading digits and signs are preserved with the prefix so an adjacent credential still gets masked. Two direct protocol tests cover maximum-size plain text followed by a credential, and prefixes beside custom URL schemes. They assert text and masking, without a real-time measurement or deadline. The existing failing assistant integration test supplies the RED regression; the prefix cases characterize behavior that already worked.

## Evidence and own review

`docs/evidence/task-1282/baseline.log` records 124 passed and four failed cases across the three requested files, exit 1: two missing routes, two stale token expectations and the assistant timeout (the missing routes form one failing case). The timeout was 20,000 ms, unchanged.

The first GREEN run of the three requested files plus `stored-secrets.test.ts` and `people-delete.test.ts` passed all 146 tests, exit 0. Protocol `redaction.test.ts` passed 10 tests and node `redact.test.ts` passed 2 tests, both exit 0. Final exact-commit checks and integration readback are recorded separately with their candidate SHA.

Own review and security check: all access checks stay intact; the inventory points to executed authority tests. Only synthetic credentials occur in fixtures. The replacement still removes the user/password and preserves the public URL and any prefix. A bounded comparison of 64,420 generated inputs found no output difference between the old and new URL expressions; it is supporting evidence, not an exhaustive proof. The profile is a manual diagnostic, never an assertion about machine speed in a test. No permissions, schema, API contract, dependencies or secret storage are changed. No external checker is called on this turnkey task.

The whole release suite is outside this task. No formatter is configured in this repository. Any unavailable stage is reported as unavailable, not passed.
