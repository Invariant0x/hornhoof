# Task 1190 Tests evidence

Technical conclusion: DONE_WITH_CONCERNS on `5e2fc7f28fc39655bd66c9f353c7724d236fafa8`, based on completed exact-version local check receipts. Formal Tests handoff is pending candidate registration repair, not completed. The head accepted the timing concerns for separate repair on 2026-11-17. No program source, test, candidate branch or shared branch changed in this verification.

Candidate base: `d2994cb1d08bdd58277a5fa37e6d15e09d49912d`.
Previous pinned candidate: `1534c90396cfdb8843c201ef92698b1b12902e60`, base `11aa5777c4a5f74a550c0e53570ec35ebae39f53`. Never integrate that old history.

`git range-diff 11aa5777c4a5f74a550c0e53570ec35ebae39f53..1534c90396cfdb8843c201ef92698b1b12902e60 d2994cb1d08bdd58277a5fa37e6d15e09d49912d..5e2fc7f28fc39655bd66c9f353c7724d236fafa8` shows all four commits `=`. All seven changed executable file SHA-256 values match the author archive and rebased candidate. `git diff --check` passed. Commit identities are Ivan Korol, with Signed-off-by and no Co-Authored-By.

## Requirement evidence

- Removed future Review owner is replaced without moving the current stage or waking the replacement: `development-echelons-future-owners.test.ts`, first case. Author RED exit 1 shows null owner / eligible_owner_required despite an eligible replacement; final candidate GREEN 7 / 7.
- Same role and department, model strength and provider preference: second future-owners case. Closed tasks, completed stages and immutable candidates remain covered by fifth case. Development replacement and subsequent Architecture handoff: fourth case.
- No eligible replacement: third future-owners case verifies exactly one letter for two tasks, both task numbers and stage, no duplicate on repeated leaveWork.
- Head preassigns only future pending stage; current owner and wakes unchanged: sixth future-owners case. Seventh rejects self-review, weaker and unavailable owner, invalid stages, missing owner and unauthorized actor. The title mentions out-of-scope owners, but its final assertions do not explicitly exercise a foreign department or company; this is not claimed as direct test coverage. Security inspected scope validation in source.
- Public MCP update_task preserves stage and rejects self-review: first `development-echelons-tools.test.ts` case. Its independent RED exit 1 shows unintended current assignee change before the schema fix; final candidate completed runs pass.
- Existing switch, staff, handoff, wake, engine, map, wait and tool behavior: the named files below.

The seven new future-owner tests control Date using Vitest fake timers and contain no real-clock wait. Timings below are runner observations, not test assertions. No test, timeout or threshold was weakened. No live external agent program or operating system behavior was tested here.

## Exact-candidate checks

Security ran in its clean checkout, cwd `apps/server`, separately for each literal file below:

`npx --no-install vitest run test/<named-file>.test.ts --maxWorkers=1 --no-file-parallelism`

See `security/series.sh`, `security/summary.txt`, the full logs, before/after full HEAD and empty dirty records. Tools and controls had initial exit 1, followed by two completed candidate runs each with exit 0. The union is **219 unique passing tests in 12 files**; repeated and base runs do not increase that number. Both initial failures remain NOT_PASS. Full output was read; no existing proved check was repeated by Tests.

| File under apps/server/test | Tests | Initial outcome | Runner seconds | Tests seconds |
| --- | ---: | --- | ---: | ---: |
| agent-switch.test.ts | 21 | PASS | 176.00 | 76.476 |
| agents.test.ts | 29 | PASS | 229.09 | 118.546 |
| development-echelons-controls.test.ts | 4 | NOT_PASS | 73.29 | 45.255 |
| development-echelons-future-owners.test.ts | 7 | PASS | 39.52 | 9.391 |
| development-echelons-handoff.test.ts | 8 | PASS | 98.54 | 35.417 |
| development-echelons-staff.test.ts | 3 | PASS | 127.85 | 20.405 |
| development-echelons-tools.test.ts | 6 | NOT_PASS | 194.45 | 49.596 |
| development-echelons-wake.test.ts | 1 | PASS | 127.82 | 19.510 |
| map-state.test.ts | 43 | PASS | 297.46 | 266.342 |
| tasks-engine.test.ts | 27 | PASS | 105.10 | 25.168 |
| tasks-tools.test.ts | 30 | PASS | 63.10 | 34.383 |
| wait-producers.test.ts | 40 | PASS | 55.79 | 25.864 |

All 12 initial runner durations exceed the 30 second T5 file budget. The test execution phase also exceeds 30 seconds for tools, controls, handoff, agent-switch, agents, map-state and tasks-tools. `slow-cases.csv` names every displayed case at or above 1000 ms across all 20 runs, including base and unsuccessful runs. Runner log Duration and external wrapper seconds are separate measures; wrapper values remain in summary.txt / ab.txt.

New future-owners cases took 3646 ms (replacement) and 1083 ms (same-role selection), over the 1 second case budget; the file took 39.52 seconds runner, 9.391 seconds test execution. Initial tools failed at 20573 ms and controls at 20492 ms against the unchanged 20000 ms runner test limit.

| Completed candidate comparison run | Runner seconds | Tests seconds | New tools case ms | Result |
| --- | ---: | ---: | ---: | --- |
| Controls round 1 | 54.46 | 13.382 | n/a | 4 / 4, exit 0 |
| Controls round 2 | 45.87 | 10.136 | n/a | 4 / 4, exit 0 |
| Tools round 1 | 55.57 | 15.638 | 8181 | 6 / 6, exit 0 |
| Tools round 2 | 46.40 | 13.628 | 7489 | 6 / 6, exit 0 |

Tools runner duration is approximately 46 to 56 seconds. Map-state took 297.46 seconds runner and 266.342 seconds test execution.

The base d2994cb1d also passed both comparison rounds: controls 4 / 4, tools 5 / 5, all exit 0. Measured load_at_start for the comparison series was 14.21 to 17.59. The earlier statement of load 32 during failed tests is **not a contemporaneous measurement**: uptime was 15.16 before the series and 32.47 after both failed files finished, several minutes later. Cypher inferred the load explanation; the records support load sensitivity as a concern, not a proven sole cause. Two passing rounds do not guarantee stability. These failures and T5 were accepted by the head for separate repair; no green label is substituted for them.

Static checks on exact candidate, root cwd, full command transcript and exits in `security/static-and-load-record.redacted.txt`:

- `NODE_OPTIONS=--max-old-space-size=2048 npx --no-install tsc -p apps/server/tsconfig.eslint.json --noEmit`: exit 0, empty log, includes server tests.
- `npx --no-install eslint apps/server/src/modules/tasks/echelons-assign.ts apps/server/src/modules/tasks/echelons-future.ts apps/server/src/modules/tasks/echelons-update.ts apps/server/src/modules/tasks/engine.ts apps/server/src/modules/tasks/tools.ts apps/server/test/development-echelons-future-owners.test.ts apps/server/test/development-echelons-tools.test.ts`: exit 0, empty log.

The raw author, review and security folders named in this report are preserved byte for byte in `raw-receipts.tar.gz`. Packaging preserves original logs, including their blank lines and hashes. Derived CSV files use LF line endings.

## Record verification and limits

`verification.json` records archive SHA-256 values, matched source hashes and the hashes recomputed for Security files. All 38 author manifest entries and 11 Review manifest entries matched. All full Review logs were read, including the aborted tools attempt; that attempt has no result and is not PASS. Review covers old candidate 1534c9039; the exact new candidate relies on Security receipts above.

Author's final server build exit 0 is recorded for old code commit 47d80c905; it is not claimed as a new-base build. No build, browser, complete suite, coverage quality metric or mutation was run by Tests. The task requires named server checks, server types with tests and changed-file eslint, all supported by exact candidate receipts. Whole-suite validation belongs to the release. run_tests was not called. Clean HEAD records and dependency setup for Security are documented in the static supplement. Review/Security nonblocking notes remain in the task, including later handoff rejection if a preassigned owner becomes ineligible.

The static supplement is Cypher's cleaned attachment eb215705, SHA-256 3ba7afd91e71f00ee616f7ddfe203f4013c5a16fe2f4eeb9e1bb8a436dc179ba. The unrelated ps listing was removed by its owner. Check commands and output are unchanged. Only this cleaned attachment is referenced for the supplement.

## Registration and next owner

Tests submit of branch task-1190 with base d2994cb1d and head 5e2fc7f28 was refused:

> d2994cb1d08bdd58277a5fa37e6d15e09d49912d does not hold 11aa5777c4a5f74a550c0e53570ec35ebae39f53, or the change between them could not be read.

The candidate record still names the old history. The head initially forwarded record repair to the orchestrator and forbade retry. After turn 32 opened, the head explicitly requested a second submit attempt; that attempt returned the same refusal. The exact error was sent to the head. The head proposed returning the task to its author to register a fresh candidate based on d2994cb1d if the retry failed; Tests does not perform that route change itself. No fictional merge or direct database repair was attempted. Formal Tests completion must wait for correct registration and the head's word. The technical result above is attached evidence, not a report accepting the old SHA.

The head corrected the release scope: task 1190 remains in turn 32 and the 0.32.0 list, after the owner cancelled the earlier cut. No new rebase was requested or performed by Tests. Any later changed candidate requires its applicable exact-version checks. No integration or release permission is asserted here.
