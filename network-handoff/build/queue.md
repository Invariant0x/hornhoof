# Order of work

The ledger (`progress.md`) says what is done: every `Task N: complete` line. This file says what comes next. Addenda sit outside
each plan's numbers, so they are listed where they run.

- Plan 1 (relay contract, repo hornhoof-edge): Task 7 (gates, then review), 8, 9, 10; beside them, in repo hornhoof: Task 11 (review), 12.
  Skipped: Task 13 (deploy, QUESTIONS item 3). Plan 1's review and ledger line. Task A1 waits for plan 9 Task 3.
- Plan 1b: Tasks 1 to 10. Pebble (Task 6 and `test:real`) needs Docker: see QUESTIONS item 4.
- Plan 2: Tasks 1 to 11 (Task 11's rehearsal and push skipped).
- Plan 3: Tasks 1 to 6; addendum needs no task.
- Plan 4: Tasks 1 to 8.
- After 4 T6: split runNode in apps/node/src/main.ts, characterization tests first, structural commits apart (ledger).
- Plan 5: Tasks 1 to 6, then A1, then 7.
- Plan 5b: Tasks 1 to 10.
- Plan 6: Tasks 1 to 7.
- Plan 7: Tasks 1 to 11, with A1 (needs plan 1 Task 9, which is done by then); rule on p7 ruling 15 first.
- Plan 8: Tasks 1 to 11.
- Plan 9: Tasks 1 to 13, plan 1's A1 with Task 3, and this plan's A1 after Task 12.
- Plan 9b: Tasks 1 to 9.
- Plan 9c: Tasks 1 to 13, plan 1's A2 with Task 12.
- Plan 10: Tasks 1 to 12; addendum needs no task.
- Plan 11: Tasks 1 to 5, then A1, then 6 to 10.
- Plan 11b: Tasks 1 to 9.
- Plan 13: Tasks 1 to 8 run here, 9 to 12 are written and type-checked here, 13 to 17 are David AI's and Ivan's.

At the start of each plan: a planner scans it against the code as it now stands (the plans were read at main 04bec1d; the clone is 73d086ba plus this
branch) and writes the skill's conflict table to the ledger. At its end: one review of the whole plan's change, one fix pass, `Plan P: complete`.

Inserted: after Plan 1 Task 7 lands, before Task 9: the relay write-contention fix (ledger, test-infra's finding on test_restart_burst).

At the very end of phase 1, after plan 13's Tasks 1 to 8: one mutator run, on the riskiest pure logic with its fast tests only (ledger, Ivan's rulings): decision functions of relay.py, relay.ts, sessions, fences and leader logic, takeover and split decisions, merge. Code that only slow tests reach is left out.
