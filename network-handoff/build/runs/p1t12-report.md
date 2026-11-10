# Plan 1 Task 12 report (writer)

Status: DONE_WITH_CONCERNS (whole suite, crapper, dryer and mutator not run: `remote.sh` does not exist yet).

## Read before writing
Skills test-driven-development, systematic-debugging, verification-before-completion (plugins/superpowers/skills/<name>/SKILL.md);
CLAUDE.md, hornhoof/AGENTS.md, hornhoof/templates/skills/dev-engineering-rules.md, the Task 12 brief.

## Files changed (lane /home/altera/hornhoof-network/wt/p1t12)
- apps/server/src/modules/link/relay.ts: `route`, `setSync`, `health`, `changeKey`, `visitorKey`, types `SyncRecord`, `Route`, `SyncPost`, `SyncResult`, `Health`; `call` now sits on a never-throwing `attempt`. `check`, `bind`, `unbind` unchanged.
- apps/server/test/relay-client.test.ts (new, 12 tests).

## TDD
Red: first run, all 12 tests failed with "relay.route/setSync/health/changeKey is not a function" (feature missing). Green after the code.
Two test faults of mine found afterwards: an unhandled rejection (two promises built before the first was awaited; fixed with thunks) and a tsc error in the test (narrowing); both fixed.

## Runs
- `light.sh ... vitest run test/relay-client.test.ts test/link.test.ts`: 2 files, 33 tests pass, no errors.
- `npx tsc -p apps/server/tsconfig.json --noEmit`: no output, rc 0. `tsc -p apps/server/tsconfig.eslint.json --noEmit` (tests): rc 0.
- NOT run: whole suite, crapper, dryer, mutator (need `remote.sh`, absent). Lead must run them.

## Extra tests beyond the plan
Stored record differing from the post reads `unknown`; slow/unreachable relay on sync post; health with no `passthrough` field (local one-answer server, since the Task 11 fake always sends the field); malformed/slow health reads as down; a non-string key answer is refused.

## Choices (Ruling lines for the ledger)
- Ruling: `route` on a 429 reads `refused` - why: any non-200 is `refused` per the plan - cost if wrong: caller cannot tell busy from refused.
- Ruling: `health` demands `ok: true` and `frps: true` literally and a non-negative integer `relayStarted`; a wrong-typed `passthrough` reads as down, a missing one as false - why: fail closed - cost if wrong: a relay with an odd health body reads down.
- Ruling: `changeKey`/`visitorKey` require a key of 16 to 1000 characters (same as `Bound.key`); 429 throws `busy`, any other failure throws `relay_unreachable` - why: "as bind does" - cost if wrong: a 401 shows as unreachable.
- Ruling: a timeout during the body read reads `malformed` for route, not `slow` - why: only the connect/headers phase is classified; fake `hang` hijacks before headers - cost if wrong: wrong label only.
- A 409 with any word other than not_holder/stale_epoch reads `unknown`.

## Notes for lead
- Facts the plan rests on held: fake relay shape matched the plan. The fake needs nothing more for this task.
- The key goes only into the `authorization` header; test checks results and errors with a boolean.
- Possible survivor candidates for mutator: the `READ_MS` default value (2000), untested directly.

## Second round (whole suite and gates through remote.sh)
- Suite: first run (`npm test`) was lost to a timeout of mine and then to the machine overload; rerun with `hh-suite.sh` (label p1t12-suite2): exit 0; groups 127/127, 1206/1206, 1835/1835 and 767/767 tests pass. No hook-client failure.
- Gates (label p1t12-gates, then p1t12-gates2 after new tests):
  - crapper: every function I added or changed is under 10 (highest: setSync 6.0, attempt 6.0). Over 10 are `reasonOf` 13.1 and `bind` 12.5, both unchanged old code.
  - dryer 0.8: no duplicate candidates.
  - mutator on relay.ts: first run 26 killed, 6 survived (conflictOf `?.`, three `&&` in `echoes`, `&&` and `false` in setSync's final line). Added 3 tests (stored record differing in one field; 200 that is not a sync record; 409 with an unknown word or no body). They passed at once because the code already did the right thing, so the proof they bite is the mutator: second run 32 killed, 0 survived, 0 uncovered, 100%.
- Test file now 15 tests; tests pass, `tsc` (src and tests) rc 0.

## Final note
Per Ivan's ruling relayed by the lead, no further mutator runs. The mutator results above (32 killed, 0 survived) were obtained before the ruling arrived; no run of mine is still active. Hand-in basis: whole suite through hh-suite.sh (pass), crapper and dryer (clean for changed code).

## Fix report, review round 1 (six Important)
All tests in test/relay-client.test.ts (now 23). Red proof: finding 4 failed as a real test (`expected {known:false, why:'malformed'} to deeply equal {..., why:'slow'}`). The others already held in the code, so I showed each test bites by a temporary change to relay.ts, run, then restored (diff checked): finding 2 with the sync timeout replaced by 5000 (test failed), finding 5 with `since` made nullable (failed), finding 6 with the 429 line removed (failed). Finding 1 and 3 are test hygiene.
1. Keys: link, fresh and visitor keys now compared as booleans with fixed messages; also `route` with the fresh key reads `known: true`. The no-key test also covers a hung read, a closed port (route, setSync, changeKey) and a changeKey success.
2. Test `fails closed inside its time budget when the relay is slow`: answer delayed 1 s, timeoutMs 100, `{stored:false, why:'unknown'}` in under 250 ms.
3. Removed the misnamed `does not take a stored record that differs`; the oneAnswer tests already cover the mismatch.
4. Fix: `attempt` reads the body on a clone inside its try, so a stall is `slow` and a cut is `unreachable`. Tests use a server that stops or cuts mid-body.
5. Tests pin every route field (`toEqual` of the full answer), and 11 bad values (since -1, 'x', null; generation 1.5; relayStarted -3; evictionBound string; client 7; sync missing, bad state, negative epoch, copy 5) read `malformed`; a never-registered binding reads `known:true, state:'empty', generation:0`. Seam: in relay.py `route_body`, `since` is None only when the name has no binding row; the route call needs a binding, so null cannot reach the client in practice (only in a delete race, which then reads malformed, fail closed). Type not widened.
6. Tests: 429 gives 429 `too_many` for both calls; 401, 404, 500 give `relay_unreachable`; visitor key answers `{}`, short, number, wrong field and a short link key are refused.
Runs: tsc (src and tests) rc 0; link/relay-client tests 44 pass; remote `p1t12-r1c` (gates-hornhoof then hh-suite.sh) exit 0, all four groups pass: 127, 1206, 1846, 767 tests; crapper: my functions at most 6.0 (reasonOf 13.1 and bind 12.5 are old); dryer: no duplicate candidates. No mutator.
