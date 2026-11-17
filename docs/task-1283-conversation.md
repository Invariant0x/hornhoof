# Task 1283: skill transport through one prepared test app

The original case awaited a run after its job had failed with `node_too_old`.
Merge `fea65b723309b840932d5a8be76b2b0fed0266b3` imported 284 more units of
`hh-questions`, taking that old-node fixture from 19,868 to 20,152 UTF-16
units. The unchanged single case passes on first parent `81a7aeb785` and
fails at 20 seconds on the merge. Initial phase measurements show rejection
at 1.142 seconds, followed by a wait for a message that cannot be sent.

The case now uses complete sample skill bodies in its private template copy.
It checks core and procedure bodies inline, then reconnects the same node with
skill files enabled and checks the procedure list and complete file body.
Both modes use one app and database. `prepareApp` prepares the shared harness
during collection. A run-or-failure wait reports the stored failure reason
and checks the exact job id. The separate oversized-input case verifies
`failed / node_too_old`, the upgrade reason and no dispatched run. Date is
controlled; state waits have no deadlines. Product limits, shipped prose,
assertions and the runner timeout are preserved.

The two-environment candidate passed twice then failed under load; those
receipts are retained as failed development evidence. The one-environment
candidate `1eef032e39cd7c9f5f9be67af9298857261f66a5` passed the whole file
three consecutive times, 65 / 65 each, with load recorded. The target took
653, 348 and 632 ms. Whole-file timing budgets are not claimed passed.

Cleaning the unintegrated branch removes raw evidence and its old history,
without changing the tested implementation: the test blob remains
`ab9be79864eece02fdaf082c60c2c41861720c31`. The latest shared iv-queue state is
checked separately. Exact candidate SHAs, commands, exits, the default-role
audit and raw output belong to the report and attachment on Hornhoof #1283.
