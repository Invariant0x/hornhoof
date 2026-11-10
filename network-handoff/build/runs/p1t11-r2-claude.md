# Plan 1 Task 11, review round 2 (Claude fable, read only)

Package `runs/p1t11-r2.diff` equals the working tree of `hornhoof` at 73d086ba (changed lines of `fake-relay.ts` and the
whole `fake-relay.test.ts` compared byte for byte). Round 1's files were rebuilt from `runs/p1t11-r1.diff` in
`network-build/tmp/claude-r2/r1`, so the fix round is the diff r1 to r2: in `fake-relay.ts` three edits (the order of the two
refusals in `register`, `passthrough: true`, the 404 and 401 bodies in `authorize`); in the test file the body asserts, the
new R1.3 and R2.4 restart tests, the `===` comparisons in R6.2, and `frpsDown = true` on the no-body bind.

Checks ran on copies in `network-build/tmp/claude-r2/lab` (its `node_modules` a symlink to the clone's), through `light.sh`,
one at a time; nothing in either repository was changed. Round 2 tests on the round 1 fake: 7 failed, 15 passed, exactly the
seven the fix report names (R1.3 busy client, R2.3, both R2.4 holder tests, R4.1, R6.1, R6.2). On the round 2 fake: 22 of 22.
Then one mutant per finding.

## Findings of round 1

1. 404 says `unknown`: ADDRESSED. `fake-relay.ts:180-181` sends `{error: 'not_found', message: 'There is no binding <name>.'}`
   and the 401 `{error: 'unauthorized', message: 'Send the binding key as Authorization: Bearer <key>.'}`, the words of
   relay.py `authorize_link` (1224) and `wrong_key` (1198). Asserted on route, sync, key and visitor-key. Mutants: 404 back to
   `{error: 'unknown'}` fails 4 tests; 401 without its message fails 4. DELETE shares `authorize`, so it answers the same;
   no test asserts DELETE's 404 body (minor, `Relay.unbind` reads the status only, relay.ts:77).
2. Sync `off` with a copy: stands ruled (ledger line 161), not reopened. relay.py:503 `sync_copy` confirms the fake's rule.
3. `passthrough` default: ADDRESSED. `fake-relay.ts:140` is `true`; R4.1 asserts `true` in the full 200 body, then `false`
   after the test sets it. Mutant (default false) fails R4.1. Plan 1b's tests at its lines 958-971 set `passthrough` themselves.
4. Refusal order: ADDRESSED. `fake-relay.ts:77-78` checks the busy client before the held name, with a comment that says why.
   New test `R1.3 meets a busy client id at login` (same client, same name twice) expects `already online`; it fails on the
   round 1 fake and on a mutant that puts the name check first.
5. Visitor keys printed: ADDRESSED. R6.2 compares with `===` inside `toBe(true)` and checks a string of 16 or more
   characters; R6.1 does the same for `key`. Two mutants (visitor key stored wrong; key route answering a short key): the
   failure output is `expected false to be true`, no 32-character value in it other than a vitest warning's env var name.
   Not red first, as the report says; the pass/fail behaviour is unchanged, so that is right.
6. Syncs across restart: ADDRESSED. New test `R2.4 keeps the sync record across an frps restart`: after `restartFrps()` the
   route says `empty` with the sync, the next holder at generation 2 gets 409 `stale_epoch` at epoch 5 and 200 at 6. It
   passes on the round 1 fake (it pins behaviour the fake already had); mutant `restartFrps` clearing `syncs` fails it.
7. Statuses and bodies: ADDRESSED for every place Antigravity 6 named but two. Every not_holder and stale_epoch asserts 409
   with its body (mutant 409 to 200 fails 3 tests); every 401, 404 and the route and sync 503 assert the exact body (mutant
   `UNKNOWN` without its message fails 2). Still status only: the R1.5 503s of `GET /names/globex` and `POST /bindings`
   with a name while frps is down (`fake-relay.test.ts:265-266`); a mutant answering `{}` there survives. Minor: the fake
   sends the one `UNKNOWN` constant on all four routes, and relay.py answers the same body for names (its `handle_one_request`
   catches `FrpsUnknown`, relay.py:1144). The fix report's "every 503" overstates by these two lines.
8. No-body random bind while frps down: ADDRESSED. `fake-relay.test.ts:257` sets `frpsDown = true`; mutant "503 for every bind
   while frps is down" fails that test and the R1.5 503 test.

## New breakage in what the fix changed

None found. `register`'s order has no caller outside the fake's own tests (`grep` of `apps/server`). The shared `authorize`
also serves DELETE; `Relay.unbind` and `reasonOf` (relay.ts:30-32, 77) never read a 404's error word, and the lead's full
suite is green. `passthrough: true` has no consumer before plan 1b. No em dash in either file. The fix-gates log shows dryer
"No duplicate candidates found" and no function at CRAP 10 or above; the three code edits change no branching. Typecheck not
rerun here (the lead's suite ran `typecheck:tests`; the edits touch literals and line order only).

Severity summary: 0 Critical, 0 Important, 2 Minor (DELETE 404 body and the two R1.5 503 bodies not asserted).
