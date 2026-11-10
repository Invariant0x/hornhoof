# Plan 1 Task 11 report: the fake relay keeps the contract

Status: DONE_WITH_CONCERNS (the mutator gate could not run, see below). Nothing staged or committed.

## Files changed (repo /home/altera/hornhoof-network/hornhoof, branch network, HEAD 73d086ba)

- Modified: `apps/server/test/fake-relay.ts`
- New: `apps/server/test/fake-relay.test.ts` (18 tests)

## Log

1. Read the brief, CLAUDE.md, AGENTS.md, engineering rules, relay.py (route_body, set_sync, key_answer, health_answer, DELETE, names/bindings), `link/relay.ts`.
2. Wrote `fake-relay.test.ts` first: the 12 named rows plus six extra tests (see below).
3. Ran it: 18 of 18 failed. Reasons: `relay.register is not a function` (R1.1, R1.3, R1.4, R2.1, R2.2, R2.3 bad answers, R2.4, R3.1, R6.1, R1.5); 404 where 401/400/200 were expected for route, sync, key, visitor-key and health; `relay.visitorKeys` undefined; no 503 from names and bindings; `since` undefined for a bound name. The new routes answered 404 as the plan expected.
4. Implemented the fake's state and routes, then green: 18 of 18.
5. Gates found CRAP 12 (`fakeRelay`) and 10 (`routeBody`). Split `fakeRelay` into `newRelay` and `nameRules`, and made `routeBody` spread a default `NO_ROUTE`. Re-ran: all under 10.

## Design notes

- Route state: `routes`, `syncs`, `visitorKeys` as in the plan. `register`, `drop`, `restartFrps` are on `FakeRelay`; the logic is in module functions (`register`, `drop`, `acceptSync`, `routeBody`, `spoiled`, `nameRules`).
- `authorize` is a Fastify `preHandler` (404 unknown name first, then 401 wrong or missing key). `DELETE /bindings/:name` now uses it too, so the old duplicate check is gone; its answers are unchanged.
- A new binding through the API seeds an empty route at generation 0 with `since` = bind time (relay.py's `route_body` uses the binding's `created_at`). A binding set directly in `relay.bindings` (as link.test.ts does) has no route, and reads as empty, generation 0, `since: null`.
- Sync body is validated with zod (strict fields, integers >= 1, copy only when state is on); 400 `{error: 'invalid'}`. Conflicts are 409 `{error: 'not_holder'}` or `{error: 'stale_epoch'}`, as relay.py's `set_sync` names them. Order as relay.py: auth, body validation, 503, holder, epoch.
- Route answer order: auth (404, 401), then 503 when `frpsDown`, then `routeAnswer` mode. `hang` uses `reply.hijack()`; the app is created with `forceCloseConnections: true` so a hung socket cannot block `app.close()`.
- R1.5: a name with a binding, reserved or invalid is answered without asking frps. Any other requested name answers 503 while `frpsDown`; otherwise `taken` when a route is held. A random name (POST /bindings without name) never waits. `DELETE /bindings` leaves the route alone, so the freed name stays `taken` until `drop`.
- Key change replaces the binding's key at once (route, sync, key, visitor-key and DELETE use the new one). Deleting a binding also deletes its visitor key.
- `register` order: held name (`router config conflict`) before a busy client id (`already online`).

## Tests (named by row)

The 12 from the plan: R1.1, R1.3, R1.4, R2.1, R2.2, R2.3, R2.4, R3.1, R4.1, R6.1, R6.2, R1.5. Extra ones I added: R2.1 empty at generation 0; R2.1 bound-at time through the API; R2.3 the four spoiled route answers (`garbage`, `extra`, `badstate`, `hang`) and back to `contract`; R2.4 malformed record, no holder, frps down; R6.2 visitor key leaves with the binding; R1.5 503 for a requested name and a random name never waiting. Keys are compared with booleans and lengths, never printed.

## Commands and results

- `light.sh npx vitest run test/fake-relay.test.ts` before the code: 18 failed. After: 18 passed.
- Done when, `light.sh npx vitest run test/fake-relay.test.ts test/link.test.ts test/setup.test.ts test/orchestrator-control.test.ts --maxWorkers=2`: 4 files, 106 tests passed.
- `npx tsc -p apps/server/tsconfig.json --noEmit` from the repo root: no output, exit 0.
- `npm run typecheck:tests` (includes `tsconfig.eslint.json` for server tests): exit 0, no errors.
- `gates-hornhoof.sh 73d086ba server '<the four files>'`: tests 106 passed; crapper, highest scores: `POST /api/v1/bindings` 9.0, `nameRules` 9.0, `acceptSync` 7.0, `register` 6.0, all others 4.0 or less; none at 10 or above. `drop` is 75% covered, CRAP 3.1. dryer at 0.8: "No duplicate candidates found."
- `mutate.sh ... apps/server/test/fake-relay.ts ...`: printed "Skipping test file .../fake-relay.ts" and "No source files to mutate." I did not work around it. The lead rules on it. Mutation was therefore not measured; no survivors to list.

## Deviations and facts that differed from the plan

- No worktree or `relay-contract` branch: build ruling 1 (worked on `network` in the clone). No commit (Step 5 skipped by order).
- Plan contract table vs relay.py: `GET /health` in relay.py (as of this clone of hornhoof-edge) answers `{ok, frps, relayStarted}` without `passthrough`; the table (R4.1) adds `passthrough`, which Task 9 brings. I followed the table.
- The plan's interface says `since: number` on `FakeRoute`; the route answer can carry `since: null` for a name with no route and no known bind time, as relay.py does for a missing binding row. The type of the stored route is unchanged.
- `DELETE /bindings/:name` was refactored onto the shared `authorize` hook (same 404 and 401 bodies).
- relay.py applies rate limits (429) and requires Content-Type `application/json` on sync (415); the fake does neither, since the table does not list them.
- Not covered by a test: `drop` on a name with no route or an already empty one (no-op branches, 75% of `drop`).
- Docker, the droplet, GitHub: not touched. No dependency added; `zod` was already used by the server.

## Second round: mutator gate (after the lead's ruling), skills and rule files read

Read: CLAUDE.md, the task brief, `hornhoof/AGENTS.md`, `templates/skills/dev-engineering-rules.md`, skill `test-driven-development` (first part); relay.py read-only for the bodies. I did not open `systematic-debugging` or `verification-before-completion` in full; no failure needed debugging, and I ran every gate and read its output before claiming anything.

Mutator via `mutate-helper.sh`, run on the test machine with `remote.sh`. First run: 46 killed, 9 survived, 0 uncovered (60 sites). Second run, after the new tests: **50 killed, 5 survived, 0 uncovered** (60 sites, 90.9%). The helper exits 3 because of the survivors.

Killed by new tests (each shown failing against the hand-applied mutant, then restored):
- line 45 `/ -> *` in `nowSeconds`: upper bound on `since` (R2.1 tests).
- line 69 `&& -> ||` in `drop`: new test "R3.1 leaves an empty or unknown name as it was when it is dropped again".
- line 167 `?. -> .` in POST /bindings: new test "R1.5 binds a random name when the post has no body at all".
- line 173 `0 -> 1` seeded generation: the bound-through-API test registers and expects generation 1.
Also, the `drop` no-op branches are now covered by the R3.1 test above.

Survivors left, all equivalent (`??` to `||` where the left side is `undefined` or a truthy value, so both pick the same operand):
- line 62 `routes.get(name)?.generation ?? 0`: the only falsy left value is generation 0, and `0 || 0` is 0.
- line 76 `relay.syncs.get(name) ?? NO_SYNC`: a Map returns undefined or an object, never a falsy non-undefined value.
- line 87 `relay.routes.get(name) ?? NO_ROUTE`: same.
- line 90 `relay.syncs.get(name) ?? NO_SYNC`: same.
- line 144 `knownReason(name) ?? ...`: returns undefined or a non-empty string.

Change from round one: `since` no longer null. The table gives no null for R2.1 and relay.py's `None` is reachable only if the binding vanishes mid-request, so I followed the plan's type: a binding with no route reads `since: 0` (comment on `NO_ROUTE` says why). The earlier deviation note about `since: null` is withdrawn.

Gates after the change (gates-hornhoof.sh in remote.sh, log `network-build/runs/p1t11-gates2.log`): dryer "No duplicate candidates found"; crapper highest 9.0 (`POST /api/v1/bindings`), none at 10 or above; `fake-relay.test.ts` 20 tests pass locally with `light.sh`. I did not run the whole suite; the lead's `hh-suite.sh` is theirs.

## Third round: the three skills read in full, and the whole suite

Read in full now: `test-driven-development/SKILL.md` and its `writing-good-tests.md`, `systematic-debugging/SKILL.md`, `verification-before-completion/SKILL.md`. (Earlier I had read only the start of the first one; that was the gap.)

Check of my work against them:
- Found, TDD: in round two I changed `since` from null to 0 in the test and in the code in the same step, without watching the test fail. Fixed now: with the code put back to `since: null` the test "R2.1 says empty at generation 0..." fails (`Received "since": null`); with 0 it passes (20 of 20). The two survivor-killing tests of round two were checked against hand-applied mutants (fail with the mutant, pass without), which is red-before-green for tests that pin existing code.
- Found, verification: I had not run the whole suite after my last changes. Run now (below).
- Holds: all first-round tests were run red before the fake existed (18 of 18 failed for the reasons logged above); expectations are literals, not computed by the fake; no mocks, the real Fastify fake is called over `fetch`; no test-only methods in production code (the fake is itself test code); output has no warnings; no failure came up, so systematic-debugging had nothing to apply, and no fix was tried twice.
- Mutation check of writing-good-tests: done with the mutator, 50 of 55 killed, the 5 left are below.

The five `?? -> ||` survivors. `||` differs from `??` only when the left side is 0, '' or false (null/undefined behave the same). Which values can reach each:
- line 62 `routes.get(name)?.generation ?? 0`: left is `number | undefined`; 0 can reach it (an empty route at generation 0). `0 || 0` is 0, the same result. Equivalent.
- line 76 and lines 87, 90 (`syncs.get(name) ?? NO_SYNC`, `routes.get(name) ?? NO_ROUTE`, `syncs.get(name) ?? NO_SYNC`): left is `FakeSync | undefined` or `FakeRoute | undefined`, from a `Map<string, object>`. An object is always truthy, so 0, '' and false cannot reach them. Equivalent.
- line 144 `knownReason(name) ?? (...)`: left is `'invalid' | 'reserved' | 'taken' | undefined`, all non-empty strings, so '' cannot reach it. Equivalent.
None of them can be killed by any test, since no input makes the two operators differ.

Whole suite, `cd /home/altera/hornhoof-network/hornhoof && network-build/hh-suite.sh` through `remote.sh run p1t11-suite2` (real tree, no REMOTE_HORNHOOF_TREE), exit 0 after 3277 s, log `network-build/runs/p1t11-suite2.log`: check-release and `test:release` ran, `typecheck:tests` ran with no error; protocol 5 files, 127 tests; node 87 files, 1206 tests; server 110 files, 1825 tests (including `fake-relay.test.ts`, 20 tests); web 49 files, 767 tests. No failure anywhere. (A first try, `p1t11-suite`, failed in 26 s because the command ran outside the repo root and `scripts/check-release.mjs` was not found; I re-ran it with a `cd` inside the command.)

## Fix report, review round 1 (eight Important)

Each test was changed or added first and run red (7 failed, 15 passed of 22), then the fake was fixed (22 of 22). All in `apps/server/test/fake-relay.test.ts` and `fake-relay.ts`.

1. 404 said `unknown`. Test: R2.3, R2.4, R6.1, R6.2 assert `{status: 404, body: {error: 'not_found', message: 'There is no binding <name>.'}}`, and 401 `{error: 'unauthorized', message: 'Send the binding key as Authorization: Bearer <key>.'}` (relay.py `authorize_link` and `wrong_key`). Failed first with the old body (`{error: 'unknown'}`, no message). Fix: the shared `authorize` hook sends those bodies (DELETE shares it).
2. Sync `off` with a copy: NOT changed, with evidence. relay.py `sync_copy` (line 491) is `sync_text(copy) or (state == 'off' and copy is None)`, so the real relay takes `{state: 'off', copy: 'x'}` with 200 and refuses only `on` with no copy, which the fake already refuses and the R2.4 test pins (400). Making the fake stricter than the relay would be the opposite of the rule "never kinder than the real relay", so I followed relay.py. If the lead wants the stricter rule, relay.py must change first; say so and I will change both sides of the fake test.
3. `passthrough` default is now true. R4.1 asserts true by default, then false after `relay.passthrough = false`. Failed first (old default false). Plan 1b (lines 50-56, 112-119, 918) reads `up` and `passthrough` as https mode and `up` without it as http, so a test that wants http sets false itself.
4. Refusal order. New test "R1.3 meets a busy client id at login, before the name is looked at": same client and same name twice gives `already online`. Failed first (`router config conflict`). Fix: busy client checked before the held name.
5. Visitor keys printed. R6.2 now compares with `===` inside `expect(...).toBe(true)` and checks the key is a string of 16 or more characters; no key reaches a failure message. Not red-first (it is an output-safety change with the same pass/fail behavior); I checked the test file for any other `toBe` on a generated key: none.
6. Sync across restart. New test: post sync, `restartFrps()`, the route says `empty` with that sync, the next registration at generation 2 gets 409 `stale_epoch` at epoch 5 and 200 at epoch 6. It passed on the old code (it pins existing behavior); I proved it can fail with a mutant (`restartFrps` clearing `syncs`): it failed, then restored.
7. Statuses and bodies. Every not_holder asserts 409, every 401, 404, 503 and the 400 `{error: 'invalid'}` assert the exact body, on route, sync, key and visitor-key.
8. No-body random bind while frps is down. The test sets `frpsDown = true`. It passed on the old code; mutant (503 for every bind while frps is down) made it and the R1.5 503 test fail, then restored.

Commands (through remote.sh from the real tree, no REMOTE_HORNHOOF_TREE, each with `cd /home/altera/hornhoof-network/hornhoof &&` inside):
- `gates-hornhoof.sh 73d086ba server '<the four files>'` (`p1t11-fix-gates`, exit 0): dryer "No duplicate candidates found"; crapper highest 9.0 (`POST /api/v1/bindings`), none at 10 or above.
- `hh-suite.sh` (`p1t11-fix-suite`, exit 0 after 3948 s): protocol 127 tests, node 1206, server 1827 (110 files, `fake-relay.test.ts` 22 tests), web 767; `typecheck:tests` no error. No mutator run, per Ivan.
- Deferred minors (M1 to M7, M9, Antigravity minor 1) left alone as the lead listed.
