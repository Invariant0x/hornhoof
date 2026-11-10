# Notes for this review from the build lead

- This is review round 2 of plan task 12, written in the lane `/home/altera/hornhoof-network/wt/p1t12`. The change under review is the package
  `/home/altera/hornhoof-network/network-build/runs/p1t12-r2.diff`: the lane's own work against its start, the tag `lanebase`. What it stacks on is reviewed separately.
- The writer's report, claims to verify and not to trust: `/home/altera/hornhoof-network/network-build/runs/p1t12-report.md`. It says what ran and how each test failed first.
- Where this task meets others: `/home/altera/hornhoof-network/network-build/parallel-map.md` sections 1, 3 and 4 for this task, and section 5's rulings, all taken. Build ruling 5: migration numbers are the plan's plus 11.
- The lead runs the full suite and the three gates itself, on the test machine. You run at most focused tests, in the lane, through
  `/home/altera/hornhoof-network/network-build/light.sh <command>`.

# This is a scoped re-review, round 2

Say for each finding below ADDRESSED or NOT ADDRESSED, with how you checked it, and whether its test really fails without the fix. Report new Critical or Important breakage only in what the fix changed. Do not reopen what was accepted or deferred, and do not review the rest of the task again.

# Plan 1 Task 12, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p1t12-r1-claude.md: 0 Critical, 1 Important, 5 Minor), Antigravity Argon high (runs/p1t12-r1-agy.md: 0 Critical, 6 Important). Read both for detail.

## Important: one fix round, each from a test that fails first

1. **Generated keys printed on failure.** (both) `relay-client.test.ts` compares link and visitor keys with `toBe`. Booleans and fixed messages. Also assert that `route` with the fresh key answers `known: true`.
2. **`setSync`'s timeout is untested.** (Antigravity 2) A leader's `sync off` under a short budget must fail closed inside it. A delayed server, `timeoutMs` 100, `{stored: false, why: 'unknown'}` in under about 250 ms.
3. **A test that does not test what it says.** (Antigravity 3) `does not take a stored record that differs` posts `epoch: 0`, refused with 400 before `echoes`. Drop the dead setup and name it for what it does; the `oneAnswer` test already covers the mismatch.
4. **A stalled or broken body reads as `malformed`.** (Antigravity 4) The plan: a timeout `slow`, a failed fetch `unreachable`. Read the text inside `attempt`'s try, then parse. Test: a 200 whose body stalls is `slow`, a reset mid-body is `unreachable`. Safe already, but plan 10 and the logs read `why`.
5. **The route's fields are unpinned, and a seam with Task 11.** (Antigravity 5) Assert `since`, `relayStarted`, `evictionBound` and `sync` on `route()`, and malformed values of each. `since` stays a number: Task 11's fix makes the fake answer 0 for a name never registered, as the contract's type says; read `route_body` in relay.py to say whether `null` can reach the real client, and if it can, say so in your report instead of widening the type. A never-registered binding reads as `known: true, state: 'empty', generation: 0`.
6. **Key calls' failure paths are not covered.** (Antigravity 6) `oneAnswer` tests: 429 is `too_many`, 401 and 404 keep the plan's `relay_unreachable`, invalid and short `visitorKey` answers; the no-key-in-errors test also takes a closed port, a timeout and a `changeKey` success.

Your lane stacks on Task 11, which is getting its own fixes (404 is `not_found`, `passthrough` defaults true, `since: 0`). Write yours now; `lane.sh refresh` follows when Task 11 lands, and conflicts are yours to settle.

## Deferred minors (ledger)

changeKey and visitorKey on 401 or 404 throw relay_unreachable, which tells a person the relay is down when a key was refused (within the plan's "as bind does"; plan 9's change-key flow should read it); route reads the relay's 503 unknown, 503 busy and 429 as `refused`, so plan 10 must know `refused` covers "cannot tell"; three post-mutator tests were not seen red first, recorded.
