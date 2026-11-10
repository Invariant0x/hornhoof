# Plan 1 Task 11, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p1t11-r1-claude.md: 0 Critical, 2 Important, 9 Minor), Antigravity Argon high (runs/p1t11-r1-agy.md: 0 Critical, 7 Important). Read both for detail. Every later plan's tests trust this fake: a fake kinder than the real relay lets a real bug through.

## Important: one fix round, each from a test that fails first

1. **404 says `unknown`.** (Claude I1) `fake-relay.ts:159` answers 404 `{error:'unknown'}` on the link routes and DELETE; relay.py answers `{error:'not_found', message}` (`authorize_link`, relay.py:1187). In relay.py `unknown` is the 503 word only. Send not_found with a message, assert the body.
2. **Sync records with `state: off` and a copy are taken.** (Antigravity 1) `fake-relay.ts:54`'s refinement lets `{state:'off', copy:'x'}` through. Use `(state === 'on') === (copy !== null)`, as the contract says, and check relay.py's own rule for the body it refuses. Test: 400 for both wrong shapes.
3. **`passthrough` defaults to false.** (Antigravity 2) The fake stands for the finished plan 1 relay, whose health says true. Default it true; Task 12's test reads "up: true with relayStarted and passthrough: true", then false when the fake says false. Assert both in R4.1. Run plan 1b's mentions past it (`grep passthrough` in its plan): a test that wants the http mode sets it false itself.
4. **`register`'s refusals come in the wrong order.** (Antigravity 3, Claude M4) At frps a live client id meets `already online` at Login, before any NewProxy meets `router config conflict`. Check the busy client first. R1.3 registers the same client and name twice and expects `already online`.
5. **Visitor keys printed on failure.** (Claude I2, Antigravity 4) R6.2's `toBe` on generated keys prints them. Booleans and a fixed message only, as R6.1 does; also that the key is a non-trivial string.
6. **Syncs surviving a frps restart are unpinned.** (Antigravity 5) Post a sync, `restartFrps()`: the route answers `empty` with that sync; the old epoch still answers 409 `stale_epoch` after the next registration.
7. **Statuses and bodies are not all asserted.** (Antigravity 6) Step 1 asks for the table's exact bodies through `fetch`: 409 on each not_holder, bodies on each 401, 404 and 503.
8. **A no-body random bind while frps is down.** (Antigravity 7) That test passes on the base, and the rule it should pin is a random bind that never waits. Set `frpsDown = true` for it.

## Deferred minors (ledger)

Error bodies lack `message` beyond finding 1's route (M1); Fastify parses JSON before authorize, so a malformed body answers 400 before 404/401, and no 415 (M2); names in paths not lowercased (M3); register takes unbound names (M5); `since: 0` for a binding set directly in `relay.bindings` (M6); stricter Bearer parsing (M7); non-string `name` in POST /bindings gives 500, and `--` names are not tested (Antigravity minor 1). Readability points (M9) only where you are already editing.
